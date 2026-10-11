import type { Order, OrderBook, PlaceOrderRequest, Tick } from '@kinetix/shared';

import { getKotakAdapter } from '../brokers/index.ts';
import { config } from '../config.ts';
import { openDatabase, recordAuditEvent } from '../db/db.ts';
import { createMarketSimulator, type MarketSimulator } from '../sim/market.ts';
import { computeBands, computeEma, computeRsi } from '../strategy/backtest.ts';
import { createStrategyService, type StrategyService } from '../strategy/service.ts';
import { createFleetService, type FleetService } from './fleet.ts';
import { createPortfolioService, isRejected, type PortfolioService, type RejectedOrder } from './portfolio.ts';
import { createRiskService, type RiskService } from './risk.ts';

/** Either a booked order or the guardrail verdict that blocked it. */
export type OrderOutcome = Order | RejectedOrder;

/* ============================================================================
 * The engine.
 *
 * Every order in the platform — operator tickets, strategy deployments and bot
 * loops — goes through `placeOrder` here, which is what makes the risk
 * guardrails universally enforced rather than advisory.
 * ==========================================================================*/

export interface EngineFrame {
  at: number;
  ticks: Tick[];
  books: OrderBook[];
}

export type EngineListener = (frame: EngineFrame) => void;

export interface Engine {
  market: MarketSimulator;
  portfolio: PortfolioService;
  risk: RiskService;
  fleet: FleetService;
  strategies: StrategyService;
  placeOrder(request: PlaceOrderRequest, context: OrderContext): OrderOutcome;
  start(): void;
  stop(): void;
  /** Advance the world by exactly one tick — the loop `start()` runs on a timer. */
  step(): void;
  onFrame(listener: EngineListener): () => void;
  tickCount(): number;
}

export interface EngineOptions {
  /**
   * Clock override. The simulator derives bar buckets and tick timestamps from
   * it, so a fixed and movable clock makes the bot loop replayable in a test
   * instead of only observable in real time.
   */
  now?: () => number;
}

export interface OrderContext {
  actor: string;
  strategyId: string;
  venue: 'sim' | 'kotakneo';
  leverage?: number;
  botId?: string;
}

/** How often a running bot evaluates its strategy, in ticks. */
const BOT_EVALUATION_TICKS = 30;

/**
 * The price at which a position is stopped out.
 *
 * The stop sits *below* entry for a long and *above* it for a short. Using one
 * below-entry level for both directions would place a short's stop inside its own
 * opening spread, so the position would be stopped out on the first evaluation
 * after it was opened.
 */
export function stopLevel(side: 'long' | 'short', entryPrice: number, stopLossPct: number): number {
  const distance = entryPrice * (stopLossPct / 100);
  return side === 'long' ? entryPrice - distance : entryPrice + distance;
}

/**
 * Whether a position has reached its stop. Kept next to `stopLevel` so the level
 * and the comparison can never drift apart: comparing both directions against a
 * below-entry level would stop a short out on a *profit* of up to the stop size.
 */
export function isStoppedOut(
  side: 'long' | 'short',
  entryPrice: number,
  stopLossPct: number,
  price: number,
): boolean {
  const level = stopLevel(side, entryPrice, stopLossPct);
  return side === 'long' ? price <= level : price >= level;
}

export function createEngine(options: EngineOptions = {}): Engine {
  openDatabase();
  const market = createMarketSimulator(config.sim.seed, options.now ?? Date.now, { tickHz: config.sim.tickHz });
  const portfolio = createPortfolioService(market);

  // Assigned once the fleet/risk services exist; the engine's order path and
  // the health endpoint always read the live value through these closures.
  let fleetRef: FleetService | null = null;

  const risk = createRiskService({
    portfolio,
    onAutoPause: (reason) => {
      fleetRef?.pauseFleet('risk-engine', reason);
    },
    onSlippageBreach: () => {
      // Cancellations are performed by the risk service itself; nothing else to
      // do here beyond leaving the hook for future escalation.
    },
  });

  const fleet = createFleetService({
    market,
    portfolio,
    risk,
    brokerConnected: () => getKotakAdapter().status().connected,
    brokerNote: () => 'Simulated venue',
    maxAlgos: 20,
  });
  fleetRef = fleet;

  const strategies = createStrategyService(market);

  let timer: NodeJS.Timeout | null = null;
  let ticks = 0;
  const listeners = new Set<EngineListener>();
  const botCooldown = new Map<string, number>();
  /** Bar timestamp last evaluated per bot, so a strategy acts at most once per bar. */
  const botLastBar = new Map<string, number>();

  const placeOrder = (request: PlaceOrderRequest, context: OrderContext): OrderOutcome => {
    const mark = market.price(request.symbol);
    const reference = request.type === 'limit' && request.price ? request.price : mark;
    const notionalUsd = request.notionalUsd ?? (request.quantity ? request.quantity * reference : 0);

    // Pre-trade enforcement. Nothing reaches the book without passing this.
    const check = risk.checkOrder({ notionalUsd, symbol: request.symbol, side: request.side });
    if (!check.allowed) {
      risk.recordRejection(check.guardrailId ?? 'fat-finger-cap', check.reason);
      recordAuditEvent({
        actor: context.actor,
        action: 'place_order',
        target: request.symbol,
        result: 'rejected',
        detail: check.reason,
      });
      return {
        rejected: true,
        code: check.code,
        reason: check.reason,
        ...(check.guardrailId !== undefined ? { guardrailId: check.guardrailId } : {}),
        notionalUsd,
      };
    }

    const result = portfolio.placeOrder(request, {
      actor: context.actor,
      strategyId: context.strategyId,
      venue: context.venue,
      ...(context.leverage !== undefined ? { leverage: context.leverage } : {}),
      ...(context.botId !== undefined ? { botId: context.botId } : {}),
    });

    recordAuditEvent({
      actor: context.actor,
      action: 'place_order',
      target: request.symbol,
      result: isRejected(result) ? 'rejected' : 'ok',
      detail: `${request.side} ${request.type} ${notionalUsd.toFixed(0)} USD${context.botId ? ` via ${context.botId}` : ''}`,
    });

    return result;
  };

  /**
   * Bot trading loop. A running bot evaluates its own strategy on its own
   * instrument and trades its own allocation — so "Running" produces observable
   * order flow instead of a static label, and "Paused" genuinely halts it.
   */
  const evaluateBots = (): void => {
    if (fleet.isFrozen() || fleet.isPaused()) return;

    for (const bot of fleet.bots()) {
      if (bot.state !== 'running') continue;

      const cooldownUntil = botCooldown.get(bot.id) ?? 0;
      if (Date.now() < cooldownUntil) continue;

      // Support both single-strategy and combined multi-strategy bots.
      const strategyIds = bot.strategyIds.length > 0
        ? [bot.strategyId, ...bot.strategyIds]
        : [bot.strategyId];

      for (const strategyId of strategyIds) {
        const strategy = strategies.get(strategyId);
        if (!strategy) continue;
        const parsed = strategies.parsedFor(strategyId);
        if (!parsed?.ok) continue;

        const params = Object.fromEntries(strategy.params.map((param) => [param.key, param.value]));
        // Instrument override: bot trades a different stock than the strategy default.
        const instrument = bot.instrument ?? strategy.instrument;
        const candles = market.candles(instrument, strategy.timeframe, 160);
        const closes = candles.map((candle) => candle.c);
        const isEma = Boolean(parsed.rules.emaRule);
        const lookback = Math.max(2, Math.round(params.lookback ?? 50));
        if (closes.length < (isEma ? 30 : lookback + 3)) continue;

        const bands = !isEma ? computeBands(closes, lookback, params.entrySigma ?? 2.4) : { basis: [], upper: [], lower: [] };
        const rsi = parsed.rules.indicators.rsi ? computeRsi(closes, parsed.rules.indicators.rsi.period) : null;

        const emaMap = new Map((parsed.rules.indicators.emas ?? []).map((e) => [e.name, e.period]));
        const fastEmaName = parsed.rules.emaRule?.entry.fastEma ?? '';
        const slowEmaName = parsed.rules.emaRule?.entry.slowEma ?? '';
        const trendEmaName = parsed.rules.emaRule?.entry.trendEma ?? null;

        const fastPeriod = emaMap.get(fastEmaName) ?? 9;
        const slowPeriod = emaMap.get(slowEmaName) ?? 21;
        const trendPeriod = trendEmaName ? (emaMap.get(trendEmaName) ?? 100) : null;

        const emaFast = isEma ? computeEma(closes, fastPeriod) : [];
        const emaSlow = isEma ? computeEma(closes, slowPeriod) : [];
        const emaTrend = isEma && trendPeriod ? computeEma(closes, trendPeriod) : null;

        const index = closes.length - 2; // last fully closed candle
        const previous = index - 1;
        const bar = candles[index];
        if (!bar) continue;
        const witnessedBar = botLastBar.get(`${bot.id}:${strategyId}`);
        if (witnessedBar === bar.t) continue;
        botLastBar.set(`${bot.id}:${strategyId}`, bar.t);
        // A bot only trades a cross it watched complete. Without this, its first
        // evaluation after boot would act on a cross that already happened before
        // the engine started, instantly unwinding positions it never saw opened.
        if (witnessedBar === undefined) continue;

        const close = closes[index] ?? 0;
        const previousClose = closes[previous] ?? close;
        const position = portfolio
          .positions()
          .find((candidate) => candidate.strategyId === strategyId && candidate.symbol === instrument);

        let entrySignal = false;
        let entrySide: 'buy' | 'sell' = 'buy';

        if (isEma) {
          const prevFast = emaFast[previous];
          const prevSlow = emaSlow[previous];
          const currFast = emaFast[index];
          const currSlow = emaSlow[index];
          const trendVal = emaTrend ? emaTrend[index] : null;
          const rsiValue = rsi ? rsi[index] : null;

          const crossOver =
            typeof currFast === 'number' &&
            typeof currSlow === 'number' &&
            typeof prevFast === 'number' &&
            typeof prevSlow === 'number' &&
            currFast > currSlow &&
            prevFast <= prevSlow;
          const buyRsi = typeof rsiValue === 'number' && rsiValue > (params.rsiThreshold ?? parsed.rules.emaRule?.entry.rsiGate?.value ?? 60);
          const buyTrend = typeof trendVal === 'number' && close > trendVal;

          if (crossOver && buyRsi && buyTrend) {
            entrySignal = true;
            entrySide = 'buy';
          }
        } else {
          const entryComparator = parsed.rules.entry?.comparator ?? 'upper';
          const entryLevel = bands[entryComparator][index];
          const previousEntryLevel = bands[entryComparator][previous];
          const gate = parsed.rules.entry?.rsiGate;
          const rsiValue = rsi ? rsi[index] : null;
          const gatePasses =
            !gate || rsiValue === null || rsiValue === undefined
              ? true
              : gate.operator === '>'
                ? rsiValue > (params.rsiThreshold ?? gate.value)
                : rsiValue < (params.rsiThreshold ?? gate.value);
          const entryOperator = parsed.rules.entry?.operator ?? '>';

          const crossesEntry =
            entryLevel !== null &&
            entryLevel !== undefined &&
            previousEntryLevel !== null &&
            previousEntryLevel !== undefined &&
            (entryOperator === '>'
              ? close > entryLevel && previousClose <= previousEntryLevel
              : close < entryLevel && previousClose >= previousEntryLevel);
          entrySignal = gatePasses && crossesEntry;
          entrySide = entryOperator === '>' ? 'buy' : 'sell';
        }

        if (!position && entrySignal) {
          const notionalUsd = bot.allocatedMarginUsd * ((params.positionSizePct ?? 10) / 100);
          const outcome = placeOrder(
            { symbol: instrument, side: entrySide, type: 'market', notionalUsd },
            { actor: `bot:${bot.id}`, strategyId, venue: bot.venue, leverage: bot.leverage, botId: bot.id },
          );
          botCooldown.set(`${bot.id}:${strategyId}`, Date.now() + 30_000);
          strategies.appendLog(strategyId, {
            level: isRejected(outcome) ? 'warn' : 'success',
            scope: 'live',
            message: isRejected(outcome)
              ? `Order blocked: ${outcome.reason}`
              : `${entrySide === 'buy' ? 'LONG' : 'SHORT'} entry filled on ${instrument}`,
            detail: `${bot.name} • ${notionalUsd.toFixed(0)} USD notional`,
          });
          continue;
        }

        if (position) {
          const stopped = isStoppedOut(position.side, position.entryPrice, params.stopLossPct ?? 1.5, close);
          let crossesExit = false;

          if (isEma) {
            const prevFast = emaFast[previous];
            const prevSlow = emaSlow[previous];
            const currFast = emaFast[index];
            const currSlow = emaSlow[index];
            crossesExit =
              typeof currFast === 'number' &&
              typeof currSlow === 'number' &&
              typeof prevFast === 'number' &&
              typeof prevSlow === 'number' &&
              currFast < currSlow &&
              prevFast >= prevSlow;
          } else {
            const exitComparator = parsed.rules.exit?.comparator ?? 'basis';
            const exitLevel = bands[exitComparator][index];
            const previousExitLevel = bands[exitComparator][previous];
            const exitOperator = parsed.rules.exit?.operator ?? '<';
            crossesExit =
              exitLevel !== null &&
              exitLevel !== undefined &&
              previousExitLevel !== null &&
              previousExitLevel !== undefined &&
              (exitOperator === '>'
                ? close > exitLevel && previousClose <= previousExitLevel
                : close < exitLevel && previousClose >= previousExitLevel);
          }

          if (crossesExit || stopped) {
            portfolio.closePosition(position.id, `bot:${bot.id}`);
            botCooldown.set(`${bot.id}:${strategyId}`, Date.now() + 30_000);
            strategies.appendLog(strategyId, {
              level: 'info',
              scope: 'live',
              message: `${stopped ? 'Stop loss' : 'Exit signal'} closed ${instrument}`,
              detail: `${bot.name} • entry ${position.entryPrice} → mark ${position.markPrice}`,
            });
          }
        }
      }
    }
  };

  const tick = (): void => {
    ticks += 1;
    const frame = market.advance();
    const bookMap = new Map(frame.books.map((book) => [book.symbol, book]));

    portfolio.onTick(bookMap);
    fleet.tick();
    risk.monitor();

    if (ticks % BOT_EVALUATION_TICKS === 0) evaluateBots();

    for (const listener of listeners) listener(frame);
  };

  return {
    market,
    portfolio,
    risk,
    fleet,
    strategies,
    placeOrder,
    start: () => {
      if (timer) return;
      timer = setInterval(tick, config.sim.tickMs);
      // Do not hold the process open purely for the market clock.
      timer.unref?.();
      console.log(`[engine] tick loop started at ${config.sim.tickHz}Hz (seed ${config.sim.seed})`);
    },
    stop: () => {
      if (timer) clearInterval(timer);
      timer = null;
    },
    step: tick,
    onFrame: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    tickCount: () => ticks,
  };
}

export { isRejected };
export type { PortfolioService, RiskService, FleetService, StrategyService };
