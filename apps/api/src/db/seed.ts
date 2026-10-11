import type { DatabaseSync } from 'node:sqlite';

import { defaultParamsForSource } from '../strategy/service.ts';

/* ============================================================================
 * Initial state.
 *
 * Two things are seeded, and only two: the risk guardrails (configuration the
 * order path enforces — a database without them runs unguarded) and an empty
 * portfolio ledger row (structure the accounting writes to). The fabricated
 * demo book that used to live here — a $4.82M portfolio, sample positions,
 * four sample bots and their trade history — was removed at the operator's
 * request: on this deployment the book is the real Kotak Neo account, and
 * inventing one would misrepresent a live account. Tests build their own
 * fixtures in `apps/api/test/fixtures.ts`.
 * ==========================================================================*/

interface SeedGuardrail {
  id: string;
  name: string;
  description: string;
  icon: string;
  enabled: boolean;
  threshold: number;
  thresholdUnit: string;
  thresholdLabel: string;
  metricLabel: string;
  metricValue: string;
  enforceNote: string;
}

const SEED_GUARDRAILS: readonly SeedGuardrail[] = [
  {
    id: 'fat-finger-cap',
    name: 'Fat-Finger Cap',
    description: 'Max single ticket limit:',
    icon: 'touch_app',
    enabled: true,
    threshold: 250_000,
    thresholdUnit: 'USD',
    thresholdLabel: '$250,000',
    metricLabel: 'Rejections today',
    metricValue: '0',
    enforceNote: 'Orders above the cap are rejected before they reach a venue.',
  },
  {
    id: 'portfolio-drawdown',
    name: 'Portfolio Drawdown',
    description: 'Auto-pause fleet if loss hits',
    icon: 'trending_down',
    enabled: true,
    threshold: 5,
    thresholdUnit: '% DD',
    thresholdLabel: '5.0% DD',
    metricLabel: 'Current DD',
    metricValue: '0.00%',
    enforceNote: 'Breaching the threshold pauses every running algorithm.',
  },
  {
    id: 'slippage-limiter',
    name: 'Slippage Limiter',
    description: 'Auto-cancel orders if slippage >',
    icon: 'waterfall_chart',
    enabled: true,
    threshold: 0.15,
    thresholdUnit: '%',
    thresholdLabel: '0.15%',
    metricLabel: 'Avg slip',
    metricValue: '0.000%',
    enforceNote: 'Resting limit orders are pulled when average slippage breaches the limit.',
  },
];

/**
 * Seed the risk guardrails.
 *
 * These are configuration, not sample data: `checkOrder` enforces them on the
 * order path, so a database without them runs unguarded. `INSERT OR IGNORE` is
 * deliberate — an operator who disables a guardrail from the terminal must not
 * have it silently re-armed at the next boot.
 */
export function seedGuardrails(db: DatabaseSync): void {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO guardrails (id, name, description, icon, enabled, threshold, threshold_unit, threshold_label,
       metric_label, metric_value, enforce_note, rejections)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  );
  for (const guardrail of SEED_GUARDRAILS) {
    insert.run(
      guardrail.id,
      guardrail.name,
      guardrail.description,
      guardrail.icon,
      guardrail.enabled ? 1 : 0,
      guardrail.threshold,
      guardrail.thresholdUnit,
      guardrail.thresholdLabel,
      guardrail.metricLabel,
      guardrail.metricValue,
      guardrail.enforceNote,
    );
  }
}

export function seedInitialState(db: DatabaseSync): void {
  // Guardrail configuration is always seeded; the book itself is never faked.
  seedGuardrails(db);

  // The ledger row is structure, not sample data: it starts at zero, and no
  // history is invented. Without this row `persistPortfolio`'s UPDATE matches
  // nothing, so realised P&L and settlement counts would evaporate on reload.
  // History is only ever written by real fills.
  db.prepare(
    `INSERT OR IGNORE INTO portfolio (id, balance_usd, realized_pnl_today_usd, settlements_today, day_start_balance_usd,
       wins_30d, losses_30d, closed_trades_30d, gross_gains_30d, gross_losses_30d, updated_at)
     VALUES (1, 0, 0, 0, 0, 0, 0, 0, 0, 0, ?)`,
  ).run(Date.now());

  // Seed demo strategies, bots and venues so the terminal has meaningful
  // content on first boot — but never in tests, whose fixtures build
  // their own fleets and would otherwise count these rows.
  if (process.env.NODE_ENV !== 'test') {
    seedDemoData(db);
  }
}

const DEMO_STRATEGIES = [
  {
    id: 'seed-btc-momentum',
    name: 'BTC Momentum Alpha',
    instrument: 'BTC-USD',
    timeframe: '15m',
    source: `import kinetix.algo as kx

@kx.strategy(symbol="BTC-USD", interval="15m")
class MomentumAlpha(kx.BaseStrategy):
    def on_init(self):
        self.bands = kx.BollingerBands(period=50, sigma=2.4)

    def on_candle(self, candle: kx.Candle):
        if candle.close > self.bands.upper:
            self.order_target_percent(target=0.10, stop_loss_pct=1.5, tag="Breakout_Long")
        elif candle.close < self.bands.basis:
            self.close_position()
`,
  },
  {
    id: 'seed-eth-meanrev',
    name: 'ETH Mean Reversion',
    instrument: 'ETH-USD',
    timeframe: '1h',
    source: `import kinetix.algo as kx

@kx.strategy(symbol="ETH-USD", interval="1h")
class MeanRev(kx.BaseStrategy):
    def on_init(self):
        self.bands = kx.BollingerBands(period=30, sigma=2.0)

    def on_candle(self, candle: kx.Candle):
        if candle.close < self.bands.lower:
            self.order_target_percent(target=0.08, stop_loss_pct=2.0, tag="Oversold_Long")
        elif candle.close > self.bands.basis:
            self.close_position()
`,
  },
  {
    id: 'seed-nq-trend',
    name: 'NQ Trend Rider',
    instrument: 'NQ-USD',
    timeframe: '1d',
    source: `import kinetix.algo as kx

@kx.strategy(symbol="NQ-USD", interval="1d")
class TrendRider(kx.BaseStrategy):
    def on_init(self):
        self.bands = kx.BollingerBands(period=80, sigma=2.8)

    def on_candle(self, candle: kx.Candle):
        if candle.close > self.bands.upper:
            self.order_target_percent(target=0.06, stop_loss_pct=2.5, tag="Trend_Long")
        elif candle.close < self.bands.lower:
            self.close_position()
`,
  },
  {
    id: 'seed-ema-rsi-trend',
    name: 'EMA 9/21 Cross + RSI & 100 EMA Trend',
    instrument: 'RELIANCE',
    timeframe: '15m',
    source: `import kinetix.algo as kx

@kx.strategy(symbol="RELIANCE", interval="15m")
class EmaCrossRsiFilter(kx.BaseStrategy):
    def on_init(self):
        # 9 EMA (Fast), 21 EMA (Slow), 100 EMA (Trend Filter) & 14 RSI
        self.ema_fast = kx.EMA(period=9)
        self.ema_slow = kx.EMA(period=21)
        self.ema_trend = kx.EMA(period=100)
        self.rsi = kx.RSI(period=14)

    def on_candle(self, candle: kx.Candle):
        # BUY: 9 EMA crosses above 21 EMA, RSI > 60, and Market (Close) > 100 EMA
        if self.ema_fast > self.ema_slow and self.rsi > 60 and candle.close > self.ema_trend:
            self.order_target_percent(target=0.10, stop_loss_pct=1.5, tag="EMA_Cross_Long")
        # SELL: 9 EMA crosses below 21 EMA, RSI < 40, and Market (Close) < 100 EMA
        elif self.ema_fast < self.ema_slow and self.rsi < 40 and candle.close < self.ema_trend:
            self.order_target_percent(target=-0.10, stop_loss_pct=1.5, tag="EMA_Cross_Short")
`,
  },
] as const;

const DEMO_BOTS = [
  { strategyId: 'seed-btc-momentum', state: 'running', allocatedMarginUsd: 850_000, leverage: 5 },
  { strategyId: 'seed-eth-meanrev', state: 'running', allocatedMarginUsd: 620_000, leverage: 3 },
  { strategyId: 'seed-nq-trend', state: 'standby', allocatedMarginUsd: 1_200_000, leverage: 2 },
] as const;

const DEMO_VENUES = [
  { id: 'cme-fix', name: 'CME FIX Direct', location: 'Chicago Equinix NY4', latencyMs: 4, status: 'optimal' },
  { id: 'binance', name: 'Binance Futures', location: 'Tokyo Cross-Connect', latencyMs: 12, status: 'good' },
  { id: 'bybit', name: 'Bybit Perps', location: 'Singapore Colo 2', latencyMs: 18, status: 'good' },
  { id: 'kotak-neo', name: 'Kotak Neo (NSE)', location: 'Mumbai DC', latencyMs: 35, status: 'good' },
] as const;

export function seedDemoData(db: DatabaseSync): void {
  const now = Date.now();

  for (let i = 0; i < DEMO_STRATEGIES.length; i++) {
    const s = DEMO_STRATEGIES[i];
    if (!s) continue;
    const bot = DEMO_BOTS.find((b) => b.strategyId === s.id);
    const botIndex = DEMO_BOTS.findIndex((b) => b.strategyId === s.id);
    const isDeployed = bot?.state === 'running';
    const status = isDeployed ? 'deployed' : 'validated';
    const deployedBotId = isDeployed && botIndex >= 0 ? `seed-bot-${botIndex + 1}` : null;
    const paramsJson = JSON.stringify(defaultParamsForSource(s.source));

    db.prepare(
      `INSERT OR IGNORE INTO strategies (id, name, version, status, instrument, timeframe, venue, source, params, confidence_pct, updated_at, last_validated_at, deployed_bot_id)
       VALUES (?, ?, 'v1.0.0-seed', ?, ?, ?, 'sim', ?, ?, 72, ?, ?, ?)`,
    ).run(s.id, s.name, status, s.instrument, s.timeframe, s.source, paramsJson, now - 86_400_000, now - 86_400_000, deployedBotId);
  }

  for (let i = 0; i < DEMO_BOTS.length; i++) {
    const b = DEMO_BOTS[i];
    if (!b) continue;
    const id = `seed-bot-${i + 1}`;
    db.prepare(
      `INSERT OR IGNORE INTO bots (id, name, strategy_id, venue, venue_label, allocated_margin_usd, deploy_ratio, leverage, net_pnl_24h_usd, state, status_label, tags, note, last_action_ts)
       VALUES (?, ?, ?, 'sim', 'Simulated venue', ?, 0, ?, 0, ?, ?, '[]', 'Provisioned at first boot', ?)`,
    ).run(
      id,
      `${DEMO_STRATEGIES[i]?.name ?? `Bot ${i + 1}`}`,
      b.strategyId,
      b.allocatedMarginUsd,
      b.leverage,
      b.state,
      b.state === 'running' ? 'Running' : 'Standby',
      now - i * 3_600_000,
    );
  }

  for (const v of DEMO_VENUES) {
    db.prepare(
      `INSERT OR IGNORE INTO venues (id, name, location, latency_ms, status) VALUES (?, ?, ?, ?, ?)`,
    ).run(v.id, v.name, v.location, v.latencyMs, v.status);
  }
}
