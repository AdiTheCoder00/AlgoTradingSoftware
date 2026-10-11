import { describe, expect, it } from 'vitest';

import { INSTRUMENTS, createMarketSimulator, generateCandles, instrumentSpec, toInstrument } from '../src/sim/market.ts';
import { quantize } from '../src/sim/orderBook.ts';
import { createRng, hashSeed } from '../src/sim/rng.ts';

const FIXED_NOW = 1_760_000_000_000;
const fixedClock = (): number => FIXED_NOW;

const BARS_PER_YEAR = { '1m': 525_600, '15m': 35_040, '1h': 8_760, '1d': 365 } as const;
/** The simulator's most volatile regime multiplies per-bar volatility by this. */
const MAX_REGIME_VOL = 2.15;

describe('deterministic RNG', () => {
  it('reproduces the same stream for the same label', () => {
    const left = createRng('BTC-USD');
    const right = createRng('BTC-USD');
    const a = Array.from({ length: 64 }, () => left.next());
    const b = Array.from({ length: 64 }, () => right.next());
    expect(a).toEqual(b);
    // A stream that returned anything near-constant would make every price
    // series look identical for a different reason.
    expect(new Set(a).size).toBeGreaterThan(60);
  });

  it('separates different labels', () => {
    expect(hashSeed('BTC-USD')).not.toBe(hashSeed('ETH-USD'));
  });

  it('clips normal samples to three sigma', () => {
    const rng = createRng(42);
    for (let i = 0; i < 5_000; i += 1) {
      expect(Math.abs(rng.boundedNormal(0.02))).toBeLessThanOrEqual(0.06 + 1e-12);
    }
  });

  it('keeps int() inside its inclusive bounds', () => {
    const rng = createRng('bounds');
    for (let i = 0; i < 2_000; i += 1) {
      const value = rng.int(3, 7);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(3);
      expect(value).toBeLessThanOrEqual(7);
    }
  });
});

describe('candle generation', () => {
  const request = { symbol: 'BTC-USD', timeframe: '1h' as const, count: 400, endTs: FIXED_NOW, seed: 1337 };

  it('is a pure function of the seed', () => {
    expect(generateCandles(request)).toEqual(generateCandles(request));
    expect(generateCandles({ ...request, seed: 99 })).not.toEqual(generateCandles(request));
  });

  it('produces internally consistent OHLC and volume', () => {
    for (const candle of generateCandles(request)) {
      expect(candle.h).toBeGreaterThanOrEqual(Math.max(candle.o, candle.c));
      expect(candle.l).toBeLessThanOrEqual(Math.min(candle.o, candle.c));
      expect(candle.l).toBeGreaterThan(0);
      expect(candle.v).toBeGreaterThan(0);
    }
  });

  it('spaces bars by the timeframe and ends on the requested bar', () => {
    const candles = generateCandles(request);
    for (let i = 1; i < candles.length; i += 1) {
      expect((candles[i]?.t ?? 0) - (candles[i - 1]?.t ?? 0)).toBe(3_600_000);
    }
    expect(candles[candles.length - 1]?.t).toBe(FIXED_NOW);
  });
});

describe('live market simulator', () => {
  it('advances two identically seeded simulators in lockstep', () => {
    const left = createMarketSimulator(1337, fixedClock);
    const right = createMarketSimulator(1337, fixedClock);
    for (let i = 0; i < 40; i += 1) {
      const a = left.advance();
      const b = right.advance();
      expect(a.ticks).toEqual(b.ticks);
    }
    expect(left.snapshot('BTC-USD')).toEqual(right.snapshot('BTC-USD'));
    expect(left.book('BTC-USD', 1)).toEqual(right.book('BTC-USD', 1));
  });

  it('moves the tape rather than quoting a frozen price', () => {
    const sim = createMarketSimulator(1337, fixedClock);
    const seen = new Set<number>();
    for (let i = 0; i < 60; i += 1) {
      sim.advance();
      seen.add(sim.price('BTC-USD'));
    }
    expect(seen.size).toBeGreaterThan(30);
  });

  it('keeps its order book well formed', () => {
    const sim = createMarketSimulator(7, fixedClock);
    for (let i = 0; i < 25; i += 1) sim.advance();

    for (const spec of INSTRUMENTS) {
      const book = sim.book(spec.symbol, 1);
      const bestBid = book.bids[0];
      const bestAsk = book.asks[0];
      expect(bestBid).toBeDefined();
      expect(bestAsk).toBeDefined();
      if (!bestBid || !bestAsk) continue;

      expect(bestBid.price).toBeLessThan(bestAsk.price);
      // Prices must sit on the instrument's tick grid, otherwise a real venue
      // would reject them.
      expect(book.spread).toBeCloseTo(bestAsk.price - bestBid.price, 8);
      for (const level of [...book.bids, ...book.asks]) {
        expect(level.size).toBeGreaterThan(0);
        expect(level.price).toBeCloseTo(quantize(level.price, spec.tickSize), 8);
      }
      for (let level = 1; level < book.bids.length; level += 1) {
        expect(book.bids[level]?.price ?? 0).toBeLessThan(book.bids[level - 1]?.price ?? 0);
        expect(book.asks[level]?.price ?? 0).toBeGreaterThan(book.asks[level - 1]?.price ?? 0);
      }
      expect(book.spreadPct).toBeGreaterThan(0);
    }
  });

  it('closes every timeframe on the live price', () => {
    const sim = createMarketSimulator(1337, fixedClock);
    for (let i = 0; i < 12; i += 1) sim.advance();

    for (const spec of INSTRUMENTS) {
      const live = sim.price(spec.symbol);
      for (const timeframe of ['1m', '15m', '1h', '1d'] as const) {
        const series = sim.candles(spec.symbol, timeframe, 1_200);
        const last = series[series.length - 1];
        expect(last).toBeDefined();
        // The newest historical bar and the live tape must be the same price, or
        // the last candle would visibly detach from the price line beside it.
        expect(last?.c).toBeCloseTo(live, 6);
      }
    }
  });

  it('keeps every bar inside a plausible range at every timeframe', () => {
    const sim = createMarketSimulator(1337, fixedClock);
    for (let i = 0; i < 12; i += 1) sim.advance();

    for (const spec of INSTRUMENTS) {
      for (const timeframe of ['1m', '15m', '1h', '1d'] as const) {
        const series = sim.candles(spec.symbol, timeframe, 1_200);
        const closes = series.map((candle) => candle.c);
        // No single bar may gap beyond what a volatility-expansion regime could
        // produce. This is the assertion that pins the old failure mode: the
        // final candle opened ~300% above its own close because the history and
        // the live tape were generated independently.
        const stepVol = spec.annualVol / Math.sqrt(BARS_PER_YEAR[timeframe]);
        const gapLimit = Math.exp(4.5 * stepVol * MAX_REGIME_VOL) - 1;
        for (const candle of series) {
          expect(Math.abs(candle.c / candle.o - 1)).toBeLessThan(gapLimit);
        }
        // And the window must stay inside what this instrument's own volatility
        // and drift budget can explain: drift over the window, plus a 6-sigma
        // random-walk envelope (the range of a walk is about twice its largest
        // displacement). A high-vol instrument over three years legitimately
        // spans double digits; a runaway drift model does not.
        const years = series.length / BARS_PER_YEAR[timeframe];
        const envelope = Math.exp(Math.abs(spec.driftBias) * years + 6 * spec.annualVol * Math.sqrt(years));
        expect(Math.max(...closes) / Math.min(...closes)).toBeLessThan(envelope);
      }
    }
  });

  it('reports a plausible 24h window for every instrument', () => {
    const sim = createMarketSimulator(1337, fixedClock);
    for (const spec of INSTRUMENTS) {
      const snapshot = sim.snapshot(spec.symbol);
      expect(snapshot.high24h).toBeGreaterThanOrEqual(snapshot.low24h);
      expect(snapshot.price).toBeGreaterThan(0);
      expect(snapshot.tickQualityPct).toBeGreaterThan(0);
      expect(snapshot.tickQualityPct).toBeLessThanOrEqual(100);
    }
  });
});

describe('instrument catalogue', () => {
  it('exposes the simulated venues plus the two Kotak Neo instruments', () => {
    expect(INSTRUMENTS).toHaveLength(7);
    expect(INSTRUMENTS.filter((spec) => spec.venue === 'kotakneo').map((spec) => spec.symbol)).toEqual([
      'KOTAK:NIFTY50',
      'KOTAK:RELIANCE',
    ]);
  });

  it('labels Kotak instruments for routing but never hardcodes a token', () => {
    const nifty = toInstrument(instrumentSpec('KOTAK:NIFTY50'));
    expect(nifty.venue).toBe('kotakneo');
    expect(nifty.exchangeSegment).toBe('nse_cm');
    expect(nifty.tradingSymbol).toBe('Nifty 50');
    // Kotak instrument tokens come from the scrip master at runtime; pinning one
    // here could silently point at the wrong contract after an expiry roll.
    expect(nifty.instrumentToken).toBeUndefined();
  });

  it('refuses an unknown symbol instead of guessing', () => {
    expect(() => instrumentSpec('DOGE-USD')).toThrow(/Unknown instrument/);
  });
});
