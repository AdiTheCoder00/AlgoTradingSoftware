import { afterAll, describe, expect, it } from 'vitest';

import { closeDatabase, resetDatabase } from '../src/db/db.ts';
import { createEngine, isRejected, isStoppedOut, stopLevel, type Engine } from '../src/engine/world.ts';
import { seedBot, seedPortfolioRow, seedStrategy, TEST_BALANCE_USD } from './fixtures.ts';

/* ============================================================================
 * Bot trading loop.
 *
 * The engine takes a clock override so a session can be replayed in milliseconds
 * of test time instead of real minutes: the simulator derives its bar buckets
 * from the clock, and the loop's evaluation cadence is counted in ticks.
 *
 * The demo fleet was removed from the seed, so each case provisions its own
 * strategy and running bot through the fixture before the engine boots — the
 * fleet service reads its table once at construction.
 * ==========================================================================*/

const STEP_MS = 5_000;
const START_MS = Date.UTC(2025, 5, 2, 9, 30, 0);
const STEP_BUDGET = 360; // 30 simulated minutes
const FIRST_EVALUATION_TICK = 30;

const STRATEGY_ID = 'fixture-band-cross';
const BOT_ID = 'fixture-bot-alpha';

/**
 * Boot an engine over a fixture book: funded ledger, one strategy whose entry
 * crosses the Bollinger basis (so fresh crosses genuinely occur during a
 * replay), and one running bot bound to it.
 */
function bootEngine(now: () => number): Engine {
  resetDatabase();
  seedPortfolioRow({ balanceUsd: TEST_BALANCE_USD });
  seedStrategy({
    id: STRATEGY_ID,
    instrument: 'SOL-USD',
    timeframe: '1m',
    params: { lookback: 10, entrySigma: 1.5, positionSizePct: 5, stopLossPct: 1.5 },
  });
  seedBot({ id: BOT_ID, strategyId: STRATEGY_ID, state: 'running', allocatedMarginUsd: 100_000, leverage: 3 });
  return createEngine({ now });
}

afterAll(() => {
  closeDatabase();
});

describe('stop level', () => {
  it('sits below entry for a long and above it for a short', () => {
    expect(stopLevel('long', 100, 1.5)).toBeCloseTo(98.5, 10);
    expect(stopLevel('short', 100, 1.5)).toBeCloseTo(101.5, 10);
    // A short must never be stopped at a price it is already better than, or it
    // would be closed the instant it was opened.
    expect(stopLevel('short', 100, 1.5)).toBeGreaterThan(100);
    expect(stopLevel('long', 100, 1.5)).toBeLessThan(100);
  });

  it('stops a long on a loss and a short on a loss only', () => {
    // Longs: stopped below entry, live at or above it.
    expect(isStoppedOut('long', 100, 1.5, 98.4)).toBe(true);
    expect(isStoppedOut('long', 100, 1.5, 98.6)).toBe(false);
    expect(isStoppedOut('long', 100, 1.5, 100)).toBe(false);

    // Shorts: stopped above entry, live at or below it. 98.5 is a *profit* for a
    // short entered at 100, and must not trigger a stop.
    expect(isStoppedOut('short', 100, 1.5, 101.6)).toBe(true);
    expect(isStoppedOut('short', 100, 1.5, 101.4)).toBe(false);
    expect(isStoppedOut('short', 100, 1.5, 98.5)).toBe(false);
  });
});

describe('bot loop', () => {
  it('does not trade a cross that completed before the engine started', () => {
    let clock = START_MS;
    const engine = bootEngine(() => clock);

    // The fixture bot is live before the first tick — the guard under test is
    // the witnessed-bar rule, not an absent fleet.
    expect(engine.fleet.deployedAlgos()).toBe(1);

    // Open a fixture position so the test also proves the loop leaves an
    // existing book untouched, not just that it adds no new tickets.
    const opened = engine.portfolio.placeOrder(
      { symbol: 'ETH-USD', side: 'buy', type: 'market', quantity: 2 },
      { actor: 'tester', strategyId: 'manual', venue: 'sim' },
    );
    if (isRejected(opened)) throw new Error(opened.reason);

    // Capture the fixture book, then prove the first evaluation records the
    // pre-existing bar without acting on it.
    const seededPositions = engine.portfolio.positions().length;
    const seededOrders = engine.portfolio.orders(200).length;
    expect(seededPositions).toBe(1);
    expect(seededOrders).toBe(1);

    for (let i = 0; i < FIRST_EVALUATION_TICK + 5; i += 1) {
      clock += STEP_MS;
      engine.step();
    }
    expect(engine.tickCount()).toBe(FIRST_EVALUATION_TICK + 5);
    expect(engine.portfolio.positions()).toHaveLength(seededPositions);
    expect(engine.portfolio.orders(200)).toHaveLength(seededOrders);
    engine.stop();
  });

  it('does act once it has watched bars close', () => {
    let clock = START_MS;
    const engine = bootEngine(() => clock);

    for (let i = 0; i < STEP_BUDGET; i += 1) {
      clock += STEP_MS;
      engine.step();
    }

    const botOrders = engine.portfolio.orders(200).filter((order) => order.strategyId === STRATEGY_ID);
    expect(botOrders.length).toBeGreaterThan(0);
    // Every ticket is attributed to the bot's own strategy.
    expect(botOrders.every((order) => order.strategyId === STRATEGY_ID)).toBe(true);
    expect(engine.fleet.bots().some((bot) => bot.state === 'running')).toBe(true);
    engine.stop();
  });

  it('keeps the risk guardrails live throughout a session', () => {
    let clock = START_MS;
    const engine = bootEngine(() => clock);

    for (let i = 0; i < STEP_BUDGET; i += 1) {
      clock += STEP_MS;
      engine.step();
    }

    // Equity must stay accountable as bots trade: no NaN, and the identity still
    // holds after hundreds of ticks of mark-to-market.
    const equity = engine.portfolio.equityUsd();
    expect(Number.isFinite(equity)).toBe(true);
    expect(equity).toBeCloseTo(engine.portfolio.cashBalanceUsd() + engine.portfolio.unrealizedUsd(), 6);
    expect(engine.portfolio.marginUsedUsd()).toBeGreaterThanOrEqual(0);
    expect(equity).toBeGreaterThan(0);

    // A rejection anywhere in the session must land in the risk feed.
    const oversized = engine.placeOrder(
      { symbol: 'BTC-USD', side: 'buy', type: 'market', notionalUsd: 400_000 },
      { actor: 'tester', strategyId: 'manual', venue: 'sim' },
    );
    expect(isRejected(oversized)).toBe(true);
    expect(engine.risk.events(10).some((event) => event.kind === 'order_rejected')).toBe(true);

    // The market itself must have rolled bars rather than frozen.
    const series = engine.market.candles('SOL-USD', '1m', 120);
    expect(series.length).toBeGreaterThan(0);
    if (series.length > 1) {
      expect((series[series.length - 1]?.t ?? 0) - (series[0]?.t ?? 0)).toBeGreaterThan(0);
    }
    engine.stop();
  });
});
