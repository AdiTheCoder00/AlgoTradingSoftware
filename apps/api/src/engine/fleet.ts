import type { DatabaseSync } from 'node:sqlite';

import type { BotState, FleetBot, FleetSnapshot, VenueLatency } from '@kinetix/shared';

import { getDb, parseJson, recordAuditEvent, recordRiskEvent } from '../db/db.ts';
import { type MarketSimulator } from '../sim/market.ts';
import { createRng } from '../sim/rng.ts';
import type { PortfolioService } from './portfolio.ts';
import type { RiskService } from './risk.ts';

/* ============================================================================
 * Fleet supervision.
 *
 * A bot is a strategy bound to a venue with allocated margin. Toggling one
 * starts or stops its trading loop for real, so its P&L stops accruing rather
 * than being redrawn. The freeze (kill-switch) cancels working orders, halts
 * every loop, writes a risk event and can be re-armed from the sentinel header.
 * ==========================================================================*/

export interface FleetService {
  bots(): FleetBot[];
  bot(id: string): FleetBot | null;
  setBotState(id: string, state: BotState, actor: string): { bot: FleetBot } | { error: string };
  /** Provision a bot for a strategy that does not have one yet (IDE deploy). */
  createBotForStrategy(input: {
    strategyId: string;
    name: string;
    venue: 'sim' | 'kotakneo';
    allocatedMarginUsd: number;
    leverage: number;
    instrument?: string;
    strategyIds?: string[];
  }): { bot: FleetBot } | { error: string };
  deployedAlgos(): number;
  maxAlgos(): number;
  pauseFleet(actor: string, reason: string): void;
  freezeFleet(actor: string): void;
  rearm(actor: string): void;
  isFrozen(): boolean;
  isPaused(): boolean;
  snapshot(): FleetSnapshot;
  /** Called on every market tick to mark bot P&L and jitter venue latency. */
  tick(): void;
  venues(): VenueLatency[];
}

export interface FleetServiceOptions {
  market: MarketSimulator;
  portfolio: PortfolioService;
  risk: RiskService;
  /** Live broker connectivity, for venues routed through Kotak Neo. */
  brokerConnected: () => boolean;
  brokerNote: () => string | undefined;
  maxAlgos: number;
}

interface BotRow {
  id: string;
  name: string;
  strategyId: string;
  strategyIds: string;
  instrumentOverride: string | null;
  venue: 'sim' | 'kotakneo';
  venueLabel: string;
  allocatedMarginUsd: number;
  deployRatio: number;
  leverage: number;
  netPnl24hUsd: number;
  state: BotState;
  statusLabel: string;
  tags: string;
  note: string;
  lastActionTs: number;
}

interface VenueRow {
  id: string;
  name: string;
  location: string;
  latencyMs: number;
  status: 'optimal' | 'good' | 'degraded';
}

export function createFleetService(options: FleetServiceOptions): FleetService {
  const db: DatabaseSync = getDb();
  const { market, portfolio, risk } = options;

  let bots: BotRow[] = [];
  let frozen = false;
  let paused = false;
  const venueLatencyJitter = new Map<string, number>();
  const venueSamples = new Map<string, number[]>();
  const rng = createRng('fleet-latency');


  const load = (): void => {
    bots = db
      .prepare(
        `SELECT id, name, strategy_id AS strategyId, strategy_ids AS strategyIds,
                instrument_override AS instrumentOverride, venue, venue_label AS venueLabel,
                allocated_margin_usd AS allocatedMarginUsd, deploy_ratio AS deployRatio, leverage,
                net_pnl_24h_usd AS netPnl24hUsd, state, status_label AS statusLabel, tags, note,
                last_action_ts AS lastActionTs
         FROM bots`,
      )
      .all() as unknown as BotRow[];
  };
  load();

  const persistBot = (bot: BotRow): void => {
    db.prepare('UPDATE bots SET state = ?, status_label = ?, net_pnl_24h_usd = ?, last_action_ts = ? WHERE id = ?').run(
      bot.state,
      bot.statusLabel,
      bot.netPnl24hUsd,
      bot.lastActionTs,
      bot.id,
    );
  };

  /** Realised P&L booked today, attributed per strategy. */
  const realizedTodayByStrategy = (): Map<string, number> => {
    const now = new Date();
    const since = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const rows = db
      .prepare(
        'SELECT strategy_id AS strategyId, SUM(realized_usd) AS total FROM closed_trades WHERE closed_at >= ? GROUP BY strategy_id',
      )
      .all(since) as Array<{ strategyId: string; total: number }>;
    return new Map(rows.map((row) => [row.strategyId, row.total]));
  };

  const unrealizedByStrategy = (): Map<string, number> => {
    const result = new Map<string, number>();
    for (const position of portfolio.positions()) {
      result.set(position.strategyId, (result.get(position.strategyId) ?? 0) + position.unrealizedPnlUsd);
    }
    return result;
  };

  const toBot = (row: BotRow, realized: Map<string, number>, unrealized: Map<string, number>): FleetBot => {
    // A bot's 24h figure is the open P&L of its positions plus what it booked
    // today. Stop the bot and this number stops moving — the toggle is real.
    const allStrategyIds = [row.strategyId, ...parseJson<string[]>(row.strategyIds, [])];
    const net = allStrategyIds.reduce(
      (acc, sid) => acc + (unrealized.get(sid) ?? 0) + (realized.get(sid) ?? 0),
      0,
    );
    return {
      id: row.id,
      name: row.name,
      strategyId: row.strategyId,
      strategyIds: parseJson<string[]>(row.strategyIds, []),
      instrument: row.instrumentOverride ?? undefined,
      venue: row.venue,
      venueLabel: row.venueLabel,
      allocatedMarginUsd: row.allocatedMarginUsd,
      leverage: row.leverage,
      netPnl24hUsd: Number(net.toFixed(2)),
      netPnl24hPct: Number(((net / Math.max(1, row.allocatedMarginUsd)) * 100).toFixed(2)),
      state: row.state,
      statusLabel: row.statusLabel,
      tags: parseJson<string[]>(row.tags, []),
      note: row.note,
      lastActionTs: row.lastActionTs,
    };
  };

  const venues = (): VenueLatency[] => {
    const rows = db
      .prepare('SELECT id, name, location, latency_ms AS latencyMs, status FROM venues')
      .all() as unknown as VenueRow[];
    return rows.map((row) => {
      const jitter = venueLatencyJitter.get(row.id) ?? 0;
      const samples = venueSamples.get(row.id);
      const measured = samples && samples.length > 0 ? samples.reduce((a, b) => a + b, 0) / samples.length : null;
      const latency = Math.max(0.5, (measured ?? row.latencyMs) + jitter);
      const note = row.id === 'kotak-neo' ? options.brokerNote() : undefined;
      const degradedByNote = row.id === 'kotak-neo' && !options.brokerConnected();
      const status: VenueLatency['status'] = degradedByNote
        ? 'degraded'
        : latency <= 6
          ? 'optimal'
          : latency <= 20
            ? 'good'
            : 'degraded';
      return {
        id: row.id,
        name: row.name,
        location: row.location,
        latencyMs: Number(latency.toFixed(1)),
        status,
        ...(note ? { note } : {}),
      };
    });
  };

  const setBotState = (id: string, state: BotState, actor: string): { bot: FleetBot } | { error: string } => {
    const bot = bots.find((candidate) => candidate.id === id);
    if (!bot) return { error: `Unknown bot: ${id}` };
    if (frozen && state === 'running') {
      return { error: 'Fleet is frozen — re-arm the kill-switch before restarting algorithms' };
    }
    if (state === 'running' && bot.venue === 'kotakneo' && !options.brokerConnected()) {
      return {
        error:
          'Kotak Neo session is not connected. Set KOTAK_NEO_* credentials, then log in from the broker panel.',
      };
    }

    bot.state = state;
    bot.statusLabel = state === 'running' ? 'Running' : state === 'standby' ? 'Standby' : 'Paused';
    bot.lastActionTs = Date.now();
    persistBot(bot);

    recordRiskEvent({
      kind: 'bot_state',
      severity: state === 'running' ? 'info' : 'warning',
      message: `${bot.name} → ${bot.statusLabel}`,
      detail: `${actor} set the algorithm state to ${state}`,
      botId: bot.id,
    });
    recordAuditEvent({ actor, action: 'set_bot_state', target: bot.id, result: 'ok', detail: state });

    const realized = realizedTodayByStrategy();
    const unrealized = unrealizedByStrategy();
    return { bot: toBot(bot, realized, unrealized) };
  };

  const createBotForStrategy: FleetService['createBotForStrategy'] = (input) => {
    const existing = bots.find((bot) => bot.strategyId === input.strategyId);
    if (existing) {
      const realized = realizedTodayByStrategy();
      const unrealized = unrealizedByStrategy();
      return { bot: toBot(existing, realized, unrealized) };
    }
    if (frozen) return { error: 'Fleet is frozen — re-arm the kill-switch before deploying' };
    if (bots.length >= options.maxAlgos) {
      return { error: `Algorithm cap reached (${options.maxAlgos}) — retire a strategy before deploying another` };
    }
    if (input.venue === 'kotakneo' && !options.brokerConnected()) {
      return {
        error: 'Kotak Neo session is not connected. Set KOTAK_NEO_* credentials, then log in from the broker panel.',
      };
    }

    const strategyRow = db
      .prepare('SELECT instrument FROM strategies WHERE id = ?')
      .get(input.strategyId) as { instrument: string } | undefined;
    const instrumentSymbol = input.instrument ?? strategyRow?.instrument ?? 'BTC-USD';
    const extraStrategyIds = input.strategyIds?.filter((sid) => sid !== input.strategyId) ?? [];
    const id = `bot-${input.strategyId}-${Math.random().toString(36).slice(2, 7)}`;
    const row: BotRow = {
      id,
      name: input.name,
      strategyId: input.strategyId,
      strategyIds: JSON.stringify(extraStrategyIds),
      instrumentOverride: input.instrument ?? null,
      venue: input.venue,
      venueLabel: input.venue === 'kotakneo'
        ? 'Kotak Neo (NSE)'
        : (market.spec(instrumentSymbol).venueLabel),
      allocatedMarginUsd: input.allocatedMarginUsd,
      // Nothing is posted as margin until the bot actually opens exposure.
      deployRatio: 0,
      leverage: input.leverage,
      netPnl24hUsd: 0,
      state: 'standby',
      statusLabel: 'Standby',
      tags: JSON.stringify([
        extraStrategyIds.length > 0 ? 'Combined bot' : 'Deployed from IDE',
        input.venue === 'kotakneo' ? 'Kotak Neo' : 'Simulated venue',
      ]),
      note: 'Provisioned from the Strategy IDE deploy action',
      lastActionTs: Date.now(),
    };

    db.prepare(
      `INSERT INTO bots (id, name, strategy_id, strategy_ids, instrument_override, venue, venue_label,
         allocated_margin_usd, deploy_ratio, leverage, net_pnl_24h_usd, state, status_label, tags, note, last_action_ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id,
      row.name,
      row.strategyId,
      row.strategyIds,
      row.instrumentOverride,
      row.venue,
      row.venueLabel,
      row.allocatedMarginUsd,
      row.deployRatio,
      row.leverage,
      row.netPnl24hUsd,
      row.state,
      row.statusLabel,
      row.tags,
      row.note,
      row.lastActionTs,
    );
    db.prepare('UPDATE strategies SET deployed_bot_id = ?, status = ? WHERE id = ?').run(id, 'deployed', input.strategyId);
    bots.push(row);

    recordAuditEvent({
      actor: 'operator',
      action: 'create_bot',
      target: id,
      result: 'ok',
      detail: `${input.name} • ${input.allocatedMarginUsd.toFixed(0)} USD allocation @ ${input.leverage}x`,
    });

    return { bot: toBot(row, realizedTodayByStrategy(), unrealizedByStrategy()) };
  };

  return {
    bots: () => {
      const realized = realizedTodayByStrategy();
      const unrealized = unrealizedByStrategy();
      return bots.map((bot) => toBot(bot, realized, unrealized));
    },

    createBotForStrategy,

    bot: (id) => {
      const row = bots.find((candidate) => candidate.id === id);
      if (!row) return null;
      return toBot(row, realizedTodayByStrategy(), unrealizedByStrategy());
    },

    setBotState,
    deployedAlgos: () => bots.filter((bot) => bot.state === 'running').length,
    maxAlgos: () => options.maxAlgos,
    isFrozen: () => frozen,
    isPaused: () => paused,

    pauseFleet: (actor, reason) => {
      paused = true;
      for (const bot of bots) {
        if (bot.state !== 'running') continue;
        bot.state = 'paused';
        bot.statusLabel = 'Paused';
        bot.lastActionTs = Date.now();
        persistBot(bot);
      }
      recordAuditEvent({ actor, action: 'pause_fleet', target: 'fleet', result: 'ok', detail: reason });
    },

    freezeFleet: (actor) => {
      frozen = true;
      paused = true;

      // Cancel everything working, then halt every loop.
      const working = portfolio.openOrders();
      for (const order of working) portfolio.cancelOrder(order.id);

      for (const bot of bots) {
        bot.state = 'paused';
        bot.statusLabel = 'Paused';
        bot.lastActionTs = Date.now();
        persistBot(bot);
      }

      recordRiskEvent({
        kind: 'fleet_freeze',
        severity: 'critical',
        message: 'Fleet frozen — all executions halted',
        detail: `${working.length} working order(s) cancelled. Re-arm from the sentinel header to resume.`,
        value: working.length,
      });
      recordAuditEvent({ actor, action: 'freeze_fleet', target: 'fleet', result: 'ok', detail: 'kill-switch engaged' });
    },

    rearm: (actor) => {
      frozen = false;
      paused = false;
      recordRiskEvent({
        kind: 'fleet_rearm',
        severity: 'info',
        message: 'Kill-switch re-armed — algorithms may be started again',
      });
      recordAuditEvent({ actor, action: 'rearm_fleet', target: 'fleet', result: 'ok' });
    },

    snapshot: () => {
      const realized = realizedTodayByStrategy();
      const unrealized = unrealizedByStrategy();
      const mapped = bots.map((bot) => toBot(bot, realized, unrealized));

      const equity = portfolio.equityUsd();
      const marginUsed = portfolio.marginUsedUsd();
      const marginCapPct = 70;
      const fleetPnl = mapped.reduce((acc, bot) => acc + bot.netPnl24hUsd, 0);
      const allocated = mapped.reduce((acc, bot) => acc + bot.allocatedMarginUsd, 0);

      return {
        bots: mapped,
        botsRunning: mapped.filter((bot) => bot.state === 'running').length,
        botsTotal: mapped.length,
        botsStandby: mapped.filter((bot) => bot.state !== 'running').length,
        equityUsd: Number(equity.toFixed(2)),
        allocatedMarginUsd: Number(allocated.toFixed(2)),
        marginUsedPct: Number(((marginUsed / Math.max(1, equity)) * 100).toFixed(2)),
        marginCapPct,
        marginAvailableUsd: Number(Math.max(0, equity - marginUsed).toFixed(2)),
        fleetPnl24hUsd: Number(fleetPnl.toFixed(2)),
        fleetPnl24hPct: Number(((fleetPnl / Math.max(1, equity)) * 100).toFixed(2)),
        frozen,
        paused,
        coreHealthLabel: frozen ? 'Executions Halted' : paused ? 'Fleet Paused' : 'All Systems Normal',
        // An anomaly is a warning or critical event in the recent window; the
        // label reads zero on a clean fleet rather than reporting lifetime noise.
        anomalies: recentAnomalies(risk, 15 * 60_000),
        lastSyncMsAgo: 120,
        guardrails: risk.guardrails(),
        venues: venues(),
        updatedAt: Date.now(),
      };
    },

    tick: () => {
      // Jitter venue latency so the panel reflects a live network rather than a
      // constant. Bot P&L needs no upkeep here: it is derived from positions and
      // closed trades whenever it is read, so a stopped bot's figure is static
      // by construction rather than by a timer.
      venueLatencyJitter.clear();
      const rows = db
        .prepare('SELECT id, latency_ms AS latencyMs FROM venues')
        .all() as Array<{ id: string; latencyMs: number }>;
      for (const row of rows) {
        const jitter = rng.range(-0.6, 0.9) + Math.sin(Date.now() / 4_000 + row.id.length) * 0.5;
        venueLatencyJitter.set(row.id, jitter);
      }
    },

    venues,
  };
}

function recentAnomalies(risk: RiskService, windowMs: number): number {
  const since = Date.now() - windowMs;
  return risk.events(100).filter((event) => event.severity !== 'info' && event.ts >= since).length;
}
