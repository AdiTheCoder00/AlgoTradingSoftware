/* ============================================================================
 * Deterministic pseudo-random number generation.
 *
 * Every generated price series is a pure function of a seed, which is what makes
 * backtests reproducible: the same seed produces byte-identical candles, so a
 * reported Sharpe ratio is reproducible rather than anecdotal.
 * ==========================================================================*/

export interface Rng {
  readonly seed: number;
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform in [min, max). */
  range(min: number, max: number): number;
  /** Uniform integer in [min, max]. */
  int(min: number, max: number): number;
  /** Standard normal via Box-Muller, cached second sample. */
  normal(): number;
  /** Standard normal clipped to +/- 3 sigma (keeps simulated tape plausible). */
  boundedNormal(sigma: number): number;
  pick<T>(items: readonly T[]): T;
  /** True with probability `p`. */
  chance(p: number): boolean;
}

/** xmur3 string hash — turns a symbol/seed label into a 32-bit integer seed. */
export function hashSeed(input: string | number): number {
  const text = String(input);
  let h = 1_779_033_703 ^ text.length;
  for (let i = 0; i < text.length; i += 1) {
    h = Math.imul(h ^ text.charCodeAt(i), 3_432_918_353);
    h ^= h >>> 13;
  }
  h = Math.imul(h ^ (h >>> 16), 2_246_822_507);
  h = Math.imul(h ^ (h >>> 13), 3_266_489_909);
  return (h ^ (h >>> 16)) >>> 0;
}

/** mulberry32 — small, fast, and stable across Node versions. */
export function createRng(seedInput: string | number): Rng {
  const seed = typeof seedInput === 'number' ? seedInput >>> 0 : hashSeed(seedInput);
  let state = seed;
  let spare: number | null = null;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };

  const rng: Rng = {
    seed,
    next,
    range: (min, max) => min + next() * (max - min),
    int: (min, max) => Math.floor(min + next() * (max - min + 1)),
    normal: () => {
      if (spare !== null) {
        const value = spare;
        spare = null;
        return value;
      }
      let u = 0;
      let v = 0;
      let s = 0;
      do {
        u = next() * 2 - 1;
        v = next() * 2 - 1;
        s = u * u + v * v;
      } while (s === 0 || s >= 1);
      const factor = Math.sqrt((-2 * Math.log(s)) / s);
      spare = v * factor;
      return u * factor;
    },
    boundedNormal: (sigma) => {
      const raw = rng.normal() * sigma;
      return Math.max(-3 * sigma, Math.min(3 * sigma, raw));
    },
    pick: (items) => {
      if (items.length === 0) throw new Error('rng.pick called with an empty array');
      return items[Math.floor(next() * items.length)] as (typeof items)[number];
    },
    chance: (p) => next() < p,
  };

  return rng;
}
