import { describe, expect, it } from 'vitest';

import { formatUsd } from '@kinetix/shared';

import { generateCandles } from '../src/sim/market.ts';
import { runBacktest, type BacktestInput, type StrategyRuntimeConfig } from '../src/strategy/backtest.ts';
import { answerQuestion } from '../src/strategy/copilot.ts';
import { parseStrategy } from '../src/strategy/grammar.ts';
import { generateInsights } from '../src/strategy/insights.ts';

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
const params = { lookback: 50, entrySigma: 2.4, stopLossPct: 1.5, positionSizePct: 10, rsiThreshold: 62 };
const input: BacktestInput = { strategy, candles, rangeLabel: '1Y', params, parsed };
const baseline = runBacktest(input);

describe('quant AI insights', () => {
  it('proposes the three measured parameter studies', () => {
    const insights = generateInsights({ strategy, candles, params, parsed, baseline: baseline.run });
    expect(insights.map((insight) => insight.id)).toEqual(['widen-stop', 'reduce-overfitting', 'volatility-sizing']);
    for (const insight of insights) {
      expect(insight.status).toBe('available');
      expect(insight.appliedResult).toBeNull();
      expect(insight.runId).toBe(baseline.run.id);
      expect(insight.impactLabel.length).toBeGreaterThan(0);
      expect(insight.headlineMetricValue.length).toBeGreaterThan(0);
      expect(Object.keys(insight.paramPatch).length).toBeGreaterThan(0);
    }
  });

  it('grounds the widen-stop projection in an actual re-simulation', () => {
    const insights = generateInsights({ strategy, candles, params, parsed, baseline: baseline.run });
    const widen = insights.find((insight) => insight.id === 'widen-stop');
    expect(widen).toBeDefined();
    if (!widen) return;

    const patched = runBacktest({ ...input, params: { ...params, ...widen.paramPatch } }).run;
    const drawdownDelta =
      Math.abs(baseline.run.metrics.maxDrawdownPct) - Math.abs(patched.metrics.maxDrawdownPct);

    expect(widen.paramPatch.stopLossPct).toBeGreaterThan(params.stopLossPct);
    expect(widen.headlineMetricValue).toContain(Math.abs(drawdownDelta).toFixed(1));
  });

  it('reports the robustness score for the overfitting study as a measured pair', () => {
    const insights = generateInsights({ strategy, candles, params, parsed, baseline: baseline.run });
    const overfit = insights.find((insight) => insight.id === 'reduce-overfitting');
    expect(overfit?.headlineMetricValue).toMatch(/^\d+ → \d+\/100$/);
    expect(overfit?.paramPatch.entrySigma).toBeLessThan(params.entrySigma);
  });

  it('scales the proposed size down from the current sizing', () => {
    const insights = generateInsights({ strategy, candles, params, parsed, baseline: baseline.run });
    const sizing = insights.find((insight) => insight.id === 'volatility-sizing');
    expect(sizing?.paramPatch.positionSizePct).toBeLessThan(params.positionSizePct);
    expect(sizing?.paramPatch.positionSizePct).toBeGreaterThanOrEqual(1);
  });

  it('is deterministic for a given baseline', () => {
    const first = generateInsights({ strategy, candles, params, parsed, baseline: baseline.run });
    const second = generateInsights({ strategy, candles, params, parsed, baseline: baseline.run });
    expect(second).toEqual(first);
  });
});

describe('copilot', () => {
  const context = { strategy, parsed, params, candles, run: baseline.run, series: baseline.series };

  it('answers a fee question by re-simulating at three times the fees', () => {
    const result = answerQuestion('How would a 3x taker fee increase affect this strategy?', context);
    expect(result.intent).toBe('fee_shock');
    expect(result.resimulatedRunId).not.toBeNull();

    const stressed = runBacktest({ ...input, feeMultiplier: 3 }).run;
    expect(result.answer).toContain('3x fee shock');
    expect(result.answer).toContain(formatUsd(stressed.metrics.totalFeesUsd));
    expect(result.answer).toContain(formatUsd(baseline.run.metrics.totalFeesUsd));
    // The re-simulation the copilot cites is its own run, so grounding is
    // asserted on the claim it makes rather than on an id the test invented.
    expect(result.groundedOn.some((line) => /re-simulation .* 3x fees/.test(line))).toBe(true);
    expect(result.groundedOn.some((line) => line.includes('baseline run'))).toBe(true);
  });

  it('quantifies the deepest stress window from the equity series', () => {
    const result = answerQuestion('How did the strategy behave in the worst drawdown window?', context);
    expect(result.intent).toBe('drawdown_window');
    expect(result.resimulatedRunId).toBeNull();
    expect(result.answer).toContain(baseline.run.metrics.benchmarkLabel);
    expect(result.answer).toContain(`${baseline.run.metrics.maxDrawdownRecoveryDays} day(s)`);
  });

  it('reports expectancy from the simulated trade list', () => {
    const result = answerQuestion('What is the expectancy per trade?', context);
    expect(result.intent).toBe('expectancy');
    expect(result.answer).toContain(`${baseline.run.trades.length} trades`);
    const expectancy =
      baseline.run.trades.reduce((total, trade) => total + trade.pnlUsd, 0) / baseline.run.trades.length;
    expect(result.answer).toContain(formatUsd(expectancy, { signed: true, decimals: 2 }));
  });
});
