import type { Candle } from '@kinetix/shared';

import { kvGet, kvSet, parseJson } from '../db/db.ts';

/* ============================================================================
 * Live 1-minute bar store.
 *
 * Kotak's REST surface carries no historical candles, so the only bars that can
 * exist are the ones this process accumulates — and without persistence they die
 * with the process. Persisting them means a restart continues the tape instead
 * of starting a fresh chart, which is the difference between a chart that is
 * merely live and one that is usable.
 *
 * Snapshots live in the existing `kv` table, one row per symbol: the payload is
 * a few hundred bars of OHLCV, small enough that a row per instrument beats a
 * new table and its migration.
 * ==========================================================================*/

export interface LiveBarSnapshot {
  /** Ascending 1-minute bars. */
  bars: Candle[];
  /**
   * Last cumulative day volume observed. Kotak reports the day total rather
   * than per-tick volume, so the first poll after a restart would otherwise
   * book the whole day as one bar's volume.
   */
  volume: number;
}

export interface LiveBarStore {
  load(symbol: string): LiveBarSnapshot | null;
  save(symbol: string, snapshot: LiveBarSnapshot): void;
}

/** A stored snapshot, guaranteed to be well-formed before it can reach a chart. */
function isSnapshot(value: unknown): value is LiveBarSnapshot {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { bars?: unknown; volume?: unknown };
  if (!Array.isArray(candidate.bars)) return false;
  return candidate.bars.every(
    (bar): boolean =>
      Boolean(bar) &&
      typeof bar === 'object' &&
      ['t', 'o', 'h', 'l', 'c', 'v'].every((field) => Number.isFinite(Number((bar as Record<string, unknown>)[field]))),
  );
}

export function createDbBarStore(prefix = 'live:bars:'): LiveBarStore {
  return {
    load: (symbol) => {
      const raw = kvGet(`${prefix}${symbol}`);
      if (raw === null) return null;
      const parsed = parseJson<unknown>(raw, null);
      if (!isSnapshot(parsed)) return null;
      return { bars: parsed.bars, volume: Number(parsed.volume) || 0 };
    },

    save: (symbol, snapshot) => {
      // Bars are trimmed upstream (HISTORY_BARS), so the payload stays bounded.
      kvSet(`${prefix}${symbol}`, JSON.stringify(snapshot));
    },
  };
}
