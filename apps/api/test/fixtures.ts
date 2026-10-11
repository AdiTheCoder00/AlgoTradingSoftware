import type { StrategyParam, Timeframe } from '@kinetix/shared';

import { getDb } from '../src/db/db.ts';

/* ============================================================================
 * Test fixtures.
 *
 * Production seeding writes only configuration (guardrails) plus an empty
 * ledger row — the fabricated demo book was removed deliberately. Tests that
 * need a book, a fleet or a strategy therefore provision their own here,
 * through the same tables the engine reads, so every assertion runs against
 * data the test itself chose rather than against remembered mockup figures.
 * ==========================================================================*/

/** Starting cash a fixture book is funded with unless a test overrides it. */
export const TEST_BALANCE_USD = 1_000_000;

export interface PortfolioFixture {
  balanceUsd?: number;
  dayStartBalanceUsd?: number;
  realizedTodayUsd?: number;
  settlementsToday?: number;
  wins30d?: number;
  losses30d?: number;
  grossGains30d?: number;
  grossLosses30d?: number;
}

/**
 * Fund the singleton ledger row with this test's own history.
 *
 * Must run after `resetDatabase()` (the row is created empty at boot) and
 * before any service is constructed — portfolio services read the row once.
 */
export function seedPortfolioRow(patch: PortfolioFixture = {}): void {
  const balance = patch.balanceUsd ?? TEST_BALANCE_USD;
  const wins = patch.wins30d ?? 0;
  const losses = patch.losses30d ?? 0;

  getDb()
    .prepare(
      `INSERT INTO portfolio (id, balance_usd, realized_pnl_today_usd, settlements_today, day_start_balance_usd,
         wins_30d, losses_30d, closed_trades_30d, gross_gains_30d, gross_losses_30d, updated_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         balance_usd = excluded.balance_usd,
         realized_pnl_today_usd = excluded.realized_pnl_today_usd,
         settlements_today = excluded.settlements_today,
         day_start_balance_usd = excluded.day_start_balance_usd,
         wins_30d = excluded.wins_30d,
         losses_30d = excluded.losses_30d,
         closed_trades_30d = excluded.closed_trades_30d,
         gross_gains_30d = excluded.gross_gains_30d,
         gross_losses_30d = excluded.gross_losses_30d,
         updated_at = excluded.updated_at`,
    )
    .run(
      balance,
      patch.realizedTodayUsd ?? 0,
      patch.settlementsToday ?? 0,
      patch.dayStartBalanceUsd ?? balance,
      wins,
      losses,
      wins + losses,
      patch.grossGains30d ?? 0,
      patch.grossLosses30d ?? 0,
      Date.now(),
    );
}

/**
 * A strategy source the real grammar accepts.
 *
 * Entry and exit cross the Bollinger basis, so a fresh cross happens often
 * enough for a bot-loop test to observe order flow within a short replay.
 * The row's instrument/timeframe come from `seedStrategy`, not the decorator.
 */
export const FIXTURE_STRATEGY_SOURCE = `import kinetix.algo as kx
from kinetix.signals import BollingerBands

@kx.strategy(symbol="SOL-USD", interval="1m")
class FixtureBandCross(kx.BaseStrategy):
    def on_init(self):
        self.bands = BollingerBands(period=10, sigma=1.5)

    def on_candle(self, candle: kx.Candle):
        if candle.close > self.bands.basis:
            self.order_target_percent(target=0.05, stop_loss_pct=1.5, tag="Fixture_Entry")
        elif candle.close < self.bands.basis:
            self.close_position()
`;

/** Bounds only satisfy the schema; the bot loop reads key/value alone. */
function toParam(key: string, value: number): StrategyParam {
  return { key, label: key, min: 0, max: 10_000, step: 1, value, defaultValue: value, unit: '' };
}

export function seedStrategy(input: {
  id: string;
  instrument: string;
  timeframe: Timeframe;
  source?: string;
  /** Runtime parameters the bot loop reads, e.g. `{ lookback: 10 }`. */
  params?: Record<string, number>;
}): void {
  getDb()
    .prepare(
      `INSERT INTO strategies (id, name, version, status, instrument, timeframe, venue, source, params,
         confidence_pct, updated_at, last_validated_at, deployed_bot_id)
       VALUES (?, ?, 'v1.0.0-fixture', 'deployed', ?, ?, 'sim', ?, ?, 80, ?, NULL, NULL)`,
    )
    .run(
      input.id,
      `Fixture ${input.id}`,
      input.instrument,
      input.timeframe,
      input.source ?? FIXTURE_STRATEGY_SOURCE,
      JSON.stringify(Object.entries(input.params ?? {}).map(([key, value]) => toParam(key, value))),
      Date.now(),
    );
}

/**
 * Insert a fleet row directly.
 *
 * `createBotForStrategy` starts bots in standby and refuses a Kotak Neo venue
 * without a broker session, so a test that needs a *running* bot or a
 * pre-provisioned Kotak bot provisions the row itself — before `createEngine`,
 * whose fleet service reads the table once at construction.
 */
export function seedBot(input: {
  id: string;
  strategyId: string;
  venue?: 'sim' | 'kotakneo';
  state?: 'running' | 'standby' | 'paused';
  allocatedMarginUsd?: number;
  leverage?: number;
}): void {
  const state = input.state ?? 'standby';
  const stateLabel = state === 'running' ? 'Running' : state === 'paused' ? 'Paused' : 'Standby';

  getDb()
    .prepare(
      `INSERT INTO bots (id, name, strategy_id, venue, venue_label, allocated_margin_usd, deploy_ratio, leverage,
         net_pnl_24h_usd, state, status_label, tags, note, last_action_ts)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, 0, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      `Fixture ${input.strategyId}`,
      input.strategyId,
      input.venue ?? 'sim',
      input.venue === 'kotakneo' ? 'Kotak Neo (NSE)' : 'Simulated venue',
      input.allocatedMarginUsd ?? 250_000,
      input.leverage ?? 5,
      state,
      stateLabel,
      JSON.stringify(['fixture']),
      'Provisioned by the test fixture',
      Date.now(),
    );
}
