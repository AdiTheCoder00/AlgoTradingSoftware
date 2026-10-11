/* ============================================================================
 * SQLite schema. Applied idempotently on every boot, then seeded if empty.
 *
 * Uses `node:sqlite` (bundled with Node) rather than a native module — nothing
 * to compile on Windows and no ABI coupling to the Node version.
 * ==========================================================================*/

export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS portfolio (
  id                     INTEGER PRIMARY KEY CHECK (id = 1),
  balance_usd            REAL    NOT NULL,
  realized_pnl_today_usd REAL    NOT NULL DEFAULT 0,
  settlements_today      INTEGER NOT NULL DEFAULT 0,
  day_start_balance_usd  REAL    NOT NULL,
  wins_30d               INTEGER NOT NULL DEFAULT 0,
  losses_30d             INTEGER NOT NULL DEFAULT 0,
  closed_trades_30d      INTEGER NOT NULL DEFAULT 0,
  gross_gains_30d        REAL    NOT NULL DEFAULT 0,
  gross_losses_30d       REAL    NOT NULL DEFAULT 0,
  updated_at             INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS strategies (
  id                TEXT PRIMARY KEY,
  name              TEXT    NOT NULL,
  version           TEXT    NOT NULL,
  status            TEXT    NOT NULL,
  instrument        TEXT    NOT NULL,
  timeframe         TEXT    NOT NULL,
  venue             TEXT    NOT NULL,
  source            TEXT    NOT NULL,
  params            TEXT    NOT NULL,
  confidence_pct    REAL    NOT NULL,
  updated_at        INTEGER NOT NULL,
  last_validated_at INTEGER,
  deployed_bot_id   TEXT
);

CREATE TABLE IF NOT EXISTS bots (
  id                   TEXT PRIMARY KEY,
  name                 TEXT    NOT NULL,
  strategy_id          TEXT    NOT NULL,
  strategy_ids         TEXT    NOT NULL DEFAULT '[]',
  instrument_override  TEXT,
  venue                TEXT    NOT NULL,
  venue_label          TEXT    NOT NULL,
  allocated_margin_usd REAL    NOT NULL,
  deploy_ratio         REAL    NOT NULL,
  leverage             REAL    NOT NULL,
  net_pnl_24h_usd      REAL    NOT NULL DEFAULT 0,
  state                TEXT    NOT NULL,
  status_label         TEXT    NOT NULL,
  tags                 TEXT    NOT NULL,
  note                 TEXT    NOT NULL,
  last_action_ts       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS positions (
  id               TEXT PRIMARY KEY,
  symbol           TEXT    NOT NULL,
  side             TEXT    NOT NULL,
  strategy_id      TEXT    NOT NULL,
  size             REAL    NOT NULL,
  entry_price      REAL    NOT NULL,
  leverage         REAL    NOT NULL,
  realized_pnl_usd REAL    NOT NULL DEFAULT 0,
  opened_at        INTEGER NOT NULL,
  venue            TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id                 TEXT PRIMARY KEY,
  symbol             TEXT    NOT NULL,
  side               TEXT    NOT NULL,
  type               TEXT    NOT NULL,
  quantity           REAL    NOT NULL,
  price              REAL,
  filled_quantity    REAL    NOT NULL DEFAULT 0,
  average_fill_price REAL,
  status             TEXT    NOT NULL,
  strategy_id        TEXT    NOT NULL,
  venue              TEXT    NOT NULL,
  leverage           REAL    NOT NULL DEFAULT 1,
  venue_order_id     TEXT,
  reject_reason      TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS fills (
  id               TEXT PRIMARY KEY,
  order_id         TEXT    NOT NULL,
  symbol           TEXT    NOT NULL,
  side             TEXT    NOT NULL,
  quantity         REAL    NOT NULL,
  price            REAL    NOT NULL,
  slippage_bps     REAL    NOT NULL,
  effect           TEXT    NOT NULL,
  realized_pnl_usd REAL    NOT NULL DEFAULT 0,
  strategy_id      TEXT    NOT NULL,
  ts               INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS guardrails (
  id              TEXT PRIMARY KEY,
  name            TEXT    NOT NULL,
  description     TEXT    NOT NULL,
  icon            TEXT    NOT NULL,
  enabled         INTEGER NOT NULL,
  threshold       REAL    NOT NULL,
  threshold_unit  TEXT    NOT NULL,
  threshold_label TEXT    NOT NULL,
  metric_label    TEXT    NOT NULL,
  metric_value    TEXT    NOT NULL,
  enforce_note    TEXT,
  rejections      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS venues (
  id         TEXT PRIMARY KEY,
  name       TEXT    NOT NULL,
  location   TEXT    NOT NULL,
  latency_ms REAL    NOT NULL,
  status     TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS risk_events (
  id       TEXT PRIMARY KEY,
  ts       INTEGER NOT NULL,
  kind     TEXT    NOT NULL,
  severity TEXT    NOT NULL,
  message  TEXT    NOT NULL,
  detail   TEXT,
  bot_id   TEXT,
  value    REAL
);

CREATE TABLE IF NOT EXISTS audit_events (
  id     TEXT PRIMARY KEY,
  ts     INTEGER NOT NULL,
  actor  TEXT    NOT NULL,
  action TEXT    NOT NULL,
  target TEXT    NOT NULL,
  result TEXT    NOT NULL,
  detail TEXT
);

CREATE TABLE IF NOT EXISTS backtest_runs (
  id          TEXT PRIMARY KEY,
  strategy_id TEXT    NOT NULL,
  payload     TEXT    NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS insights (
  id         TEXT PRIMARY KEY,
  run_id     TEXT    NOT NULL,
  payload    TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS closed_trades (
  id            TEXT PRIMARY KEY,
  strategy_id   TEXT    NOT NULL,
  symbol        TEXT    NOT NULL,
  side          TEXT    NOT NULL,
  size          REAL    NOT NULL,
  entry_price   REAL    NOT NULL,
  exit_price    REAL    NOT NULL,
  realized_usd  REAL    NOT NULL,
  realized_pct  REAL    NOT NULL,
  opened_at     INTEGER NOT NULL,
  closed_at     INTEGER NOT NULL,
  r_multiple    REAL    NOT NULL DEFAULT 0,
  tag           TEXT    NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_orders_status      ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_symbol      ON orders(symbol);
CREATE INDEX IF NOT EXISTS idx_fills_ts           ON fills(ts DESC);
CREATE INDEX IF NOT EXISTS idx_risk_events_ts     ON risk_events(ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_ts    ON audit_events(ts DESC);
CREATE INDEX IF NOT EXISTS idx_backtest_runs_strat ON backtest_runs(strategy_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_closed_trades_ts   ON closed_trades(closed_at DESC);
`;

/**
 * The pseudo-strategy that desk (manual) tickets are booked against.
 *
 * It exists so every fill has a strategy id for margin, P&L and attribution, not
 * because it is something an operator can author or deploy — which is why the
 * strategy list hides it and the IDE never opens it.
 */
export const MANUAL_STRATEGY_ID = 'manual';
