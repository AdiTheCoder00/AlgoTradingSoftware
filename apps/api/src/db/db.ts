import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import type { AuditEvent, RiskEvent } from '@kinetix/shared';

import { config } from '../config.ts';
import { SCHEMA_SQL } from './schema.ts';
import { seedInitialState } from './seed.ts';

/* ============================================================================
 * Database access.
 *
 * `node:sqlite` is synchronous, which suits this engine: the matching loop and
 * the risk checks need to observe consistent state within a single tick, and a
 * synchronous store removes a whole class of interleaving bugs.
 * ==========================================================================*/

let database: DatabaseSync | null = null;

export function openDatabase(): DatabaseSync {
  if (database) return database;

  fs.mkdirSync(config.db.dir, { recursive: true });
  const db = new DatabaseSync(config.db.path);
  db.exec(SCHEMA_SQL);
  migrate(db);
  seedInitialState(db);
  database = db;
  return db;
}

/**
 * Idempotent column migrations for databases created by older versions.
 * `CREATE TABLE IF NOT EXISTS` never alters an existing table, so new
 * columns are added here with `ALTER TABLE`, guarded by a `PRAGMA
 * table_info` check so a boot on an up-to-date file is a no-op.
 */
function migrate(db: DatabaseSync): void {
  const columns = new Set(
    (db.prepare('PRAGMA table_info(bots)').all() as Array<{ name: string }>).map((row) => row.name),
  );

  if (!columns.has('strategy_ids')) {
    db.exec(`ALTER TABLE bots ADD COLUMN strategy_ids TEXT NOT NULL DEFAULT '[]'`);
  }
  if (!columns.has('instrument_override')) {
    db.exec('ALTER TABLE bots ADD COLUMN instrument_override TEXT');
  }
}

export function getDb(): DatabaseSync {
  if (!database) throw new Error('Database not open — call openDatabase() during boot');
  return database;
}

export function closeDatabase(): void {
  database?.close();
  database = null;
}

/** Delete the database file and start over — used by `npm run seed`. */
export function resetDatabase(): DatabaseSync {
  closeDatabase();
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const target = `${config.db.path}${suffix}`;
    if (fs.existsSync(target)) fs.rmSync(target);
  }
  return openDatabase();
}

/* ------------------------------- conversions ------------------------------ */

/** SQLite has no boolean type; every flag is stored as 0/1. */
export const bool = (value: boolean): number => (value ? 1 : 0);

/** Optional strings must become NULL rather than `undefined` for node:sqlite. */
export const nullable = (value: string | undefined | null): string | null => value ?? null;

export const numericOrNull = (value: number | undefined | null): number | null =>
  value === undefined || value === null || Number.isNaN(value) ? null : value;

export function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || raw.length === 0) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export const newId = (prefix: string): string => `${prefix}_${randomUUID().slice(0, 12)}`;

/* ----------------------------------- kv ----------------------------------- */

export function kvGet(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function kvSet(key: string, value: string): void {
  getDb().prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(key, value);
}

/* -------------------------------- event logs ------------------------------ */

export interface RiskEventInput {
  kind: RiskEvent['kind'];
  severity: RiskEvent['severity'];
  message: string;
  detail?: string;
  botId?: string;
  value?: number;
}

export function recordRiskEvent(input: RiskEventInput): RiskEvent {
  const event: RiskEvent = {
    id: newId('risk'),
    ts: Date.now(),
    kind: input.kind,
    severity: input.severity,
    message: input.message,
    ...(input.detail !== undefined ? { detail: input.detail } : {}),
    ...(input.botId !== undefined ? { botId: input.botId } : {}),
    ...(input.value !== undefined ? { value: input.value } : {}),
  };

  getDb()
    .prepare(
      'INSERT INTO risk_events (id, ts, kind, severity, message, detail, bot_id, value) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      event.id,
      event.ts,
      event.kind,
      event.severity,
      event.message,
      nullable(input.detail),
      nullable(input.botId),
      numericOrNull(input.value),
    );

  return event;
}

export function listRiskEvents(limit = 50): RiskEvent[] {
  const rows = getDb()
    .prepare(
      'SELECT id, ts, kind, severity, message, detail, bot_id AS botId, value FROM risk_events ORDER BY ts DESC LIMIT ?',
    )
    .all(limit) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    id: String(row.id),
    ts: Number(row.ts),
    kind: String(row.kind) as RiskEvent['kind'],
    severity: String(row.severity) as RiskEvent['severity'],
    message: String(row.message),
    ...(row.detail ? { detail: String(row.detail) } : {}),
    ...(row.botId ? { botId: String(row.botId) } : {}),
    ...(row.value !== null && row.value !== undefined ? { value: Number(row.value) } : {}),
  }));
}

export interface AuditEventInput {
  actor: string;
  action: string;
  target: string;
  result: AuditEvent['result'];
  detail?: string;
}

export function recordAuditEvent(input: AuditEventInput): AuditEvent {
  const event: AuditEvent = {
    id: newId('audit'),
    ts: Date.now(),
    actor: input.actor,
    action: input.action,
    target: input.target,
    result: input.result,
    ...(input.detail !== undefined ? { detail: input.detail } : {}),
  };

  getDb()
    .prepare('INSERT INTO audit_events (id, ts, actor, action, target, result, detail) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(event.id, event.ts, event.actor, event.action, event.target, event.result, nullable(input.detail));

  return event;
}

export function listAuditEvents(limit = 50): AuditEvent[] {
  const rows = getDb()
    .prepare('SELECT id, ts, actor, action, target, result, detail FROM audit_events ORDER BY ts DESC LIMIT ?')
    .all(limit) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    id: String(row.id),
    ts: Number(row.ts),
    actor: String(row.actor),
    action: String(row.action),
    target: String(row.target),
    result: String(row.result) as AuditEvent['result'],
    ...(row.detail ? { detail: String(row.detail) } : {}),
  }));
}
