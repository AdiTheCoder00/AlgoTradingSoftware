import { createRng, hashSeed } from './rng.ts';

/* ============================================================================
 * L2 order book construction.
 *
 * Levels are spaced by the instrument's tick size and sized from a deterministic
 * RNG, so a book snapshot is reproducible for a given (symbol, mid, step) while
 * still looking like a real book: decaying size away from the touch.
 * ==========================================================================*/

export interface RawLevel {
  price: number;
  size: number;
  total: number;
}

export interface RawBook {
  bids: RawLevel[];
  asks: RawLevel[];
  spread: number;
  spreadPct: number;
  mid: number;
}

export interface BuildBookOptions {
  mid: number;
  tickSize: number;
  depth: number;
  /** Number of price levels to synthesise per side. */
  levels?: number;
  seed: number;
  /** Advances every tick so consecutive snapshots differ. */
  step: number;
  /** Instrument liquidity scale — the mock's BTC book holds sub-1 BTC levels. */
  sizeScale: number;
}

export function quantize(price: number, tickSize: number): number {
  const ticks = Math.round(price / tickSize);
  // Guard against float drift on very small tick sizes (e.g. 0.0001).
  const precision = Math.max(0, Math.ceil(-Math.log10(tickSize)) + 2);
  return Number((ticks * tickSize).toFixed(precision));
}

export function buildBook(options: BuildBookOptions): RawBook {
  const { mid, tickSize, depth, levels = 5, sizeScale } = options;
  const rng = createRng(`${options.seed}:${options.step}:${depth}`);

  // Half-spread of one to two ticks keeps the touch realistic relative to tick
  // size instead of inventing a spread the instrument could not quote.
  const halfSpreadTicks = rng.chance(0.72) ? 1 : 2;
  const halfSpread = halfSpreadTicks * tickSize;

  const bestBid = quantize(mid - halfSpread, tickSize);
  const bestAsk = quantize(bestBid + tickSize * halfSpreadTicks * 2, tickSize);

  const bids: RawLevel[] = [];
  const asks: RawLevel[] = [];
  let bidSize = 0;

  for (let i = 0; i < levels; i += 1) {
    // Larger resting size further from the touch, as a real ladder shows.
    const growth = 1 + i * rng.range(0.12, 0.38);
    const jitter = rng.range(0.65, 1.45);
    const size = Number((sizeScale * growth * jitter).toFixed(6));
    const price = quantize(bestBid - i * tickSize, tickSize);
    bids.push({ price, size, total: Number((price * size).toFixed(2)) });
    bidSize += size;
  }

  for (let i = 0; i < levels; i += 1) {
    const growth = 1 + i * rng.range(0.12, 0.38);
    const jitter = rng.range(0.65, 1.45);
    const size = Number((sizeScale * growth * jitter).toFixed(6));
    const price = quantize(bestAsk + i * tickSize, tickSize);
    asks.push({ price, size, total: Number((price * size).toFixed(2)) });
  }

  const spread = Number((bestAsk - bestBid).toFixed(Math.max(2, Math.ceil(-Math.log10(tickSize)) + 2)));
  return {
    bids,
    asks,
    spread,
    spreadPct: Number(((spread / mid) * 100).toFixed(4)),
    mid: quantize(mid, tickSize),
  };
}

/** Depth-bar fill ratio (0-1) for a level, normalised against the deepest level. */
export function depthRatio(levels: readonly RawLevel[], size: number): number {
  const max = levels.reduce((acc, level) => Math.max(acc, level.size), 0);
  if (max <= 0) return 0;
  return Number((size / max).toFixed(4));
}

export const bookSeedFor = (symbol: string, base: number): number => hashSeed(`${symbol}:book:${base}`);
