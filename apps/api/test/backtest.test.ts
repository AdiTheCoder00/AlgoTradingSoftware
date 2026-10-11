import { describe, expect, it } from 'vitest';

import {
  BACKTEST_INITIAL_EQUITY,
  computeBands,
  computeRsi,
  computeSma,
  computeStdDev,
  runBacktest,
  type BacktestInput,
  type StrategyRuntimeConfig,
} from '../src/strategy/backtest.ts';
import { parseStrategy } from '../src/strategy/grammar.ts';
import { generateCandles } from '../src/sim/market.ts';

/* A minimal strategy that stays inside the supported grammar: one breakout
 * entry gated by RSI, one basis exit, RSI exits confirming the fade. */
const SOURCE = `import kinetix.algo as kx
from kinetix.signals import BollingerBands, RSI

@kx.strategy(symbol="BTC-USDT", interval="15m")
class MomentumTrendStrategy(kx.BaseStrategy):
    def on_init(self):
        self.bands = BollingerBands(period=50, sigma=2.4)
        self.rsi = RSI(period=14)

    def on_candle(self, candle: kx.Candle):
        if candle.close > self.bands.upper and self.rsi > 62.0:
            self.order_target_percent(target=0.10, stop_loss_pct=0.015, tag="Breakout_Long")
        elif candle.close < self.bands.basis:
            self.close_position()
`;

const strategy: StrategyRuntimeConfig = {
  id: 'momentum-trend-v2',
  name: 'Momentum Trend v2',
  source: SOURCE,
  timeframe: '15m',
  instrument: 'BTC-USD',
};

const parsed = parseStrategy(SOURCE);

const candles = generateCandles({
  symbol: 'BTC-USD',
  timeframe: '15m',
  count: 1_200,
  endTs: Date.UTC(2025, 0, 1),
  seed: 1337,
});

const input: BacktestInput = {
  strategy,
  candles,
  rangeLabel: '1Y',
  params: { lookback: 50, entrySigma: 2.4, stopLossPct: 1.5, positionSizePct: 10, rsiThreshold: 62 },
  parsed,
};

describe('indicator math', () => {
  it('computes a trailing simple moving average', () => {
    expect(computeSma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
  });

  it('computes the population standard deviation the bands use', () => {
    const deviation = computeStdDev([2, 4, 4, 4, 5, 5, 7, 9], 8);
    expect(deviation[7]).toBeCloseTo(2, 10);
  });

  it('orders the bands around the basis', () => {
    const closes = candles.map((candle) => candle.c);
    const bands = computeBands(closes, 50, 2.4);
    let checked = 0;
    for (let i = 0; i < closes.length; i += 1) {
      const upper = bands.upper[i];
      const basis = bands.basis[i];
      const lower = bands.lower[i];
      if (upper === null || upper === undefined || basis === null || basis === undefined || lower === null || lower === undefined) {
        continue;
      }
      expect(upper).toBeGreaterThan(basis);
      expect(lower).toBeLessThan(basis);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(500);
  });

  it('pins Wilder RSI at its extremes', () => {
    const rising = Array.from({ length: 40 }, (_, index) => 100 + index);
    const falling = Array.from({ length: 40 }, (_, index) => 200 - index);
    expect(computeRsi(rising, 14)[39]).toBe(100);
    expect(computeRsi(falling, 14)[39]).toBe(0);
  });
});

describe('backtest engine', () => {
  it('parses the strategy it is about to simulate', () => {
    expect(parsed.ok).toBe(true);
    expect(parsed.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
  });

  it('is reproducible for identical inputs', () => {
    const first = runBacktest(input);
    const second = runBacktest(input);
    expect(second.run.metrics).toEqual(first.run.metrics);
    expect(second.run.trades).toEqual(first.run.trades);
    expect(second.series).toEqual(first.series);
  });

  it('trades the strategy rather than reporting a flat line', () => {
    const { run } = runBacktest(input);
    expect(run.trades.length).toBeGreaterThan(0);
    expect(run.metrics.totalTrades).toBe(run.trades.length);
    for (const trade of run.trades) {
      expect(trade.exitTs).toBeGreaterThanOrEqual(trade.entryTs);
      expect(trade.quantity).toBeGreaterThan(0);
    }
  });

  it('never lets a later bar rewrite an earlier trade', () => {
    // Signals are evaluated on a close and filled on the next open, so truncating
    // the sample must not change any trade that already happened. Lookahead would
    // break this.
    const prefixLength = candles.length - 40;
    const short = runBacktest({ ...input, candles: candles.slice(0, prefixLength) }).run;
    const long = runBacktest(input).run;

    const settled = short.trades.filter((trade) => trade.tag !== 'Mark_To_Market_Close');
    expect(settled.length).toBeGreaterThan(0);
    expect(long.trades.slice(0, settled.length)).toEqual(settled);
  });

  it('charges more in fees and earns less when fees triple', () => {
    const baseline = runBacktest(input).run;
    const stressed = runBacktest({ ...input, feeMultiplier: 3 }).run;
    expect(stressed.feeMultiplier).toBe(3);
    expect(stressed.metrics.totalFeesUsd).toBeGreaterThan(baseline.metrics.totalFeesUsd);
    expect(baseline.metrics.totalFeesUsd).toBeGreaterThan(0);
  });

  it('reports metrics that agree with the trade list', () => {
    const { run, series } = runBacktest(input);
    const metrics = run.metrics;

    expect(metrics.maxDrawdownPct).toBeLessThanOrEqual(0);
    expect(metrics.winRatePct).toBeGreaterThanOrEqual(0);
    expect(metrics.winRatePct).toBeLessThanOrEqual(100);
    expect(metrics.profitFactor).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(metrics.sharpe)).toBe(true);
    expect(Number.isFinite(metrics.sortino)).toBe(true);

    const winners = run.trades.filter((trade) => trade.pnlUsd > 0);
    expect(metrics.winRatePct).toBeCloseTo((winners.length / run.trades.length) * 100, 1);
    expect(metrics.grossGainsUsd).toBeCloseTo(
      winners.reduce((total, trade) => total + trade.pnlUsd, 0),
      1,
    );

    // The reported trough must be the trough actually drawn on the chart.
    const drawdownTrough = Math.min(...series.drawdown.map((point) => point.v));
    expect(drawdownTrough).toBeCloseTo(metrics.maxDrawdownPct, 1);
    expect(series.strategy.length).toBeLessThanOrEqual(360);
  });

  it('measures the benchmark as buy and hold over the same window', () => {
    const { run } = runBacktest(input);
    const first = candles[0];
    const last = candles[candles.length - 1];
    expect(first).toBeDefined();
    expect(last).toBeDefined();
    if (!first || !last) return;
    const expected = ((last.c - first.o) / first.o) * 100;
    expect(run.metrics.benchmarkReturnPct).toBeCloseTo(expected, 2);
    expect(run.metrics.alphaVsBenchmarkPct).toBeCloseTo(
      run.metrics.cumulativeReturnPct - run.metrics.benchmarkReturnPct,
      1,
    );
  });

  it('sizes the run from the declared equity base', () => {
    const { run } = runBacktest(input);
    expect(BACKTEST_INITIAL_EQUITY).toBe(150_000);
    // Position size is 10% of equity, so no single trade can dwarf the account.
    for (const trade of run.trades) {
      expect(trade.quantity * trade.entryPrice).toBeLessThan(BACKTEST_INITIAL_EQUITY);
    }
  });
});
