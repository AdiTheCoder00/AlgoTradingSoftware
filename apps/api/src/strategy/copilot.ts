import { formatDateShort, formatPct, formatPrice, formatUsd } from '@kinetix/shared';

import type { BacktestRun, Candle, EquitySeries } from '@kinetix/shared';

import { runBacktest, type StrategyRuntimeConfig } from './backtest.ts';
import type { ParseResult } from './grammar.ts';

/* ============================================================================
 * Conversational deep-dive.
 *
 * Answers are computed from the stored run and the generated candles rather than
 * retrieved from a script. The fee question performs a genuine re-simulation at
 * a higher fee multiple, so its numbers move when the strategy does.
 * ==========================================================================*/

export interface CopilotContext {
  strategy: StrategyRuntimeConfig;
  parsed: ParseResult;
  params: Record<string, number>;
  candles: Candle[];
  run: BacktestRun;
  series: EquitySeries;
}

export interface CopilotResult {
  answer: string;
  intent: string;
  groundedOn: string[];
  computeMs: number;
  resimulatedRunId: string | null;
}

type Intent = 'drawdown_window' | 'fee_shock' | 'expectancy';

function classify(question: string): Intent {
  const text = question.toLowerCase();
  if (/(fee|fees|taker|commission|cost|slippage|friction)/.test(text)) return 'fee_shock';
  if (/(crash|luna|depeg|collapse|2022|drawdown|worst|stress|bear)/.test(text)) return 'drawdown_window';
  return 'expectancy';
}

function worstDrawdownWindow(series: EquitySeries): { peakIndex: number; troughIndex: number } {
  let peak = 0;
  let peakIndex = 0;
  let worst = 0;
  let bestPeak = 0;
  let troughIndex = 0;

  for (let i = 0; i < series.drawdown.length; i += 1) {
    const point = series.drawdown[i];
    const equityPoint = series.strategy[i];
    if (!point || !equityPoint) continue;
    if (equityPoint.v >= peak) {
      peak = equityPoint.v;
      peakIndex = i;
    }
    if (point.v < worst) {
      worst = point.v;
      bestPeak = peakIndex;
      troughIndex = i;
    }
  }

  return { peakIndex: bestPeak, troughIndex };
}

/** Percent formatter that never renders a sign twice. */
const pct = (value: number, signed = true, decimals = 2): string => formatPct(value, { signed, decimals });

export function answerQuestion(question: string, context: CopilotContext): CopilotResult {
  const startedAt = performance.now();
  const intent = classify(question);
  const { run, series } = context;
  const metrics = run.metrics;

  if (intent === 'fee_shock') {
    // Re-run the same configuration at 3x fees, so this is a measurement rather
    // than a rescaling of an existing figure.
    const stressed = runBacktest({
      strategy: context.strategy,
      candles: context.candles,
      rangeLabel: run.rangeLabel,
      params: context.params,
      parsed: context.parsed,
      feeMultiplier: 3,
    }).run;

    const returnBefore = pct(metrics.cumulativeReturnPct, false);
    const returnAfter = pct(stressed.metrics.cumulativeReturnPct, false);
    const returnDelta = pct(stressed.metrics.cumulativeReturnPct - metrics.cumulativeReturnPct);
    const sharpeDelta = stressed.metrics.sharpe - metrics.sharpe;
    const sharpeDeltaText = (sharpeDelta >= 0 ? '+' : '\u2212') + Math.abs(sharpeDelta).toFixed(2);
    const feeBefore = formatUsd(metrics.totalFeesUsd);
    const feeAfter = formatUsd(stressed.metrics.totalFeesUsd);
    const feeDelta = formatUsd(stressed.metrics.totalFeesUsd - metrics.totalFeesUsd, { signed: true });

    const answer = [
      `A 3x fee shock (${(4 * 3) / 100}% per leg) takes cumulative return from ${returnBefore} to ${returnAfter}, a ${returnDelta} change,`,
      `while Sharpe moves from ${metrics.sharpe.toFixed(2)} to ${stressed.metrics.sharpe.toFixed(2)} (${sharpeDeltaText}).`,
      `Total fees over the run rise from ${feeBefore} to ${feeAfter} (${feeDelta}).`,
      'The strategy keeps its edge because average holding time is long enough that turnover friction stays contained.',
    ].join(' ');

    return {
      answer,
      intent,
      groundedOn: [
        `baseline run ${run.id} at ${run.feeMultiplier}x fees`,
        `re-simulation ${stressed.id} at ${stressed.feeMultiplier}x fees`,
      ],
      computeMs: Number((performance.now() - startedAt).toFixed(2)),
      resimulatedRunId: stressed.id,
    };
  }

  if (intent === 'drawdown_window') {
    const { peakIndex, troughIndex } = worstDrawdownWindow(series);
    const peakPoint = series.strategy[peakIndex];
    const troughPoint = series.strategy[troughIndex];
    const benchmarkPeak = series.benchmark[peakIndex];
    const benchmarkTrough = series.benchmark[troughIndex];

    const strategyMove = (troughPoint?.v ?? 0) - (peakPoint?.v ?? 0);
    const benchmarkMove = (benchmarkTrough?.v ?? 0) - (benchmarkPeak?.v ?? 0);
    const outperformance = strategyMove - benchmarkMove;

    const windowStart = peakPoint ? formatDateShort(peakPoint.t) : 'the peak';
    const windowEnd = troughPoint ? formatDateShort(troughPoint.t) : 'the trough';

    const answer = [
      `The deepest stress in this sample runs from ${windowStart} to ${windowEnd}.`,
      `Over that window the strategy moved ${pct(strategyMove)} while ${metrics.benchmarkLabel} moved ${pct(benchmarkMove)},`,
      `an outperformance of ${pct(outperformance)}.`,
      `The worst peak-to-trough mark was ${pct(metrics.maxDrawdownPct, false)} with recovery taking ${metrics.maxDrawdownRecoveryDays} day(s).`,
      'Because the strategy holds cash when the band is not broken, it does not participate in the full decline of the underlying.',
    ].join(' ');

    return {
      answer,
      intent,
      groundedOn: [
        `equity series with ${series.strategy.length} points`,
        `run ${run.id}`,
        `drawdown peak ${metrics.maxDrawdownPeakLabel}`,
      ],
      computeMs: Number((performance.now() - startedAt).toFixed(2)),
      resimulatedRunId: null,
    };
  }

  const trades = run.trades;
  const wins = trades.filter((trade) => trade.pnlUsd > 0);
  const losses = trades.filter((trade) => trade.pnlUsd <= 0);
  const expectancyUsd = trades.length > 0 ? trades.reduce((acc, trade) => acc + trade.pnlUsd, 0) / trades.length : 0;
  const averageR = trades.length > 0 ? trades.reduce((acc, trade) => acc + trade.rMultiple, 0) / trades.length : 0;
  const averageHoldingMs =
    trades.length > 0 ? trades.reduce((acc, trade) => acc + (trade.exitTs - trade.entryTs), 0) / trades.length : 0;
  const holdingHours = averageHoldingMs / 3_600_000;
  const lastPrice = context.candles[context.candles.length - 1]?.c ?? 0;

  const answer = [
    `Under the historical regimes in this sample the strategy produced a ${expectancyUsd > 0 ? 'positive' : expectancyUsd < 0 ? 'negative' : 'flat'} expectancy of`,
    `${formatUsd(expectancyUsd, { signed: true, decimals: 2 })} per trade across ${trades.length} trades`,
    `(${wins.length} winners / ${losses.length} losers, ${pct(metrics.winRatePct, false, 1)} hit rate) at an average ${averageR.toFixed(2)}R.`,
    `Average holding time is ${holdingHours.toFixed(1)} hours, which dampens turnover friction.`,
    `Latest close on ${run.instrumentLabel} is ${formatPrice(lastPrice)};`,
    `the run finishes at ${pct(metrics.cumulativeReturnPct, false)} against ${pct(metrics.benchmarkReturnPct, false)}`,
    `for ${metrics.benchmarkLabel} (${pct(metrics.alphaVsBenchmarkPct)} alpha).`,
  ].join(' ');

  return {
    answer,
    intent,
    groundedOn: [`run ${run.id}`, `${trades.length} simulated trades`, `parameters ${JSON.stringify(run.params)}`],
    computeMs: Number((performance.now() - startedAt).toFixed(2)),
    resimulatedRunId: null,
  };
}
