import type { BacktestRun, Candle, Insight } from '@kinetix/shared';

import { robustnessScore, runBacktest, type StrategyRuntimeConfig } from './backtest.ts';
import type { ParseResult } from './grammar.ts';

/* ============================================================================
 * Quant AI insights.
 *
 * Every suggestion is a measured claim: the proposed parameter patch is applied
 * to a real re-run of the same engine over the same candles, and the headline
 * deltas are the difference between the two results. Nothing here is a canned
 * string, which is why an insight's projected impact changes when the strategy
 * or the parameters change.
 * ==========================================================================*/

export interface InsightContext {
  strategy: StrategyRuntimeConfig;
  candles: Candle[];
  params: Record<string, number>;
  parsed: ParseResult;
  baseline: BacktestRun;
}

interface InsightDraft {
  id: string;
  title: string;
  description: string;
  category: string;
  headlineMetricLabel: string;
  headlineMetricValue: string;
  impactLabel: string;
  impactTone: 'positive' | 'warning' | 'neutral';
  paramPatch: Record<string, number>;
}

const signed = (value: number, decimals = 1, suffix = ''): string =>
  `${value >= 0 ? '+' : '\u2212'}${Math.abs(value).toFixed(decimals)}${suffix}`;

function reRun(context: InsightContext, patch: Record<string, number>, feeMultiplier = 1): BacktestRun {
  return runBacktest({
    strategy: context.strategy,
    candles: context.candles,
    rangeLabel: context.baseline.rangeLabel,
    params: { ...context.params, ...patch },
    parsed: context.parsed,
    feeMultiplier,
  }).run;
}

export function generateInsights(context: InsightContext): Insight[] {
  const baseline = context.baseline;
  const drafts: InsightDraft[] = [];

  /* --- 1. Widen the stop: fewer stop-outs, deeper excursions per trade ------ */
  const widenedStop = Number(Math.min(5, (context.params.stopLossPct ?? 1.5) * 1.8).toFixed(1));
  if (Math.abs(widenedStop - (context.params.stopLossPct ?? 1.5)) > 0.05) {
    const variant = reRun(context, { stopLossPct: widenedStop });
    const drawdownReduction =
      Math.abs(baseline.metrics.maxDrawdownPct) - Math.abs(variant.metrics.maxDrawdownPct);
    const winRateDelta = variant.metrics.winRatePct - baseline.metrics.winRatePct;
    drafts.push({
      id: 'widen-stop',
      title: `Widen stop to ${widenedStop.toFixed(1)}%`,
      description: `Giving each trade ${(widenedStop / (context.params.stopLossPct ?? 1.5)).toFixed(1)}x more room cuts premature stop-outs at the cost of a larger excursion when the level finally breaks.`,
      category: 'Risk',
      headlineMetricLabel: 'Projected Drawdown',
      headlineMetricValue: `${drawdownReduction >= 0 ? '\u2212' : '+'}${Math.abs(drawdownReduction).toFixed(1)}% delta`,
      impactLabel: `${signed(winRateDelta)}% Win Rate`,
      impactTone: winRateDelta >= 0 ? 'positive' : 'warning',
      paramPatch: { stopLossPct: widenedStop },
    });
  }

  /* --- 2. Loosen the entry threshold to reduce curve-fitting -------------- */
  const looserSigma = Number(Math.max(1, (context.params.entrySigma ?? 2.4) * 0.92).toFixed(2));
  if (Math.abs(looserSigma - (context.params.entrySigma ?? 2.4)) > 0.01) {
    const before = robustnessScore({
      candles: context.candles,
      strategy: context.strategy,
      params: context.params,
      parsed: context.parsed,
    });
    const after = robustnessScore({
      candles: context.candles,
      strategy: context.strategy,
      params: { ...context.params, entrySigma: looserSigma },
      parsed: context.parsed,
    });
    const variant = reRun(context, { entrySigma: looserSigma });
    const sharpeDelta = variant.metrics.sharpe - baseline.metrics.sharpe;
    drafts.push({
      id: 'reduce-overfitting',
      title: `Loosen entry to ${looserSigma.toFixed(2)}\u03c3`,
      description:
        'A threshold tuned tightly to one regime decays when the regime changes. Trading a slightly less selective band buys out-of-sample stability.',
      category: 'Robustness',
      headlineMetricLabel: 'Robustness Score',
      headlineMetricValue: `${before.toFixed(0)} \u2192 ${after.toFixed(0)}/100`,
      impactLabel: `${signed(sharpeDelta, 2)} Sharpe`,
      impactTone: after >= before ? 'positive' : 'warning',
      paramPatch: { entrySigma: looserSigma },
    });
  }

  /* --- 3. Volatility sizing so a crash cannot take the book out ----------- */
  const sizedDown = Number(Math.max(1, Math.round((context.params.positionSizePct ?? 10) * 0.6)));
  if (sizedDown !== (context.params.positionSizePct ?? 10)) {
    const variant = reRun(context, { positionSizePct: sizedDown });
    const tailReduction =
      Math.abs(baseline.metrics.maxDrawdownPct) > 0
        ? (1 - Math.abs(variant.metrics.maxDrawdownPct) / Math.abs(baseline.metrics.maxDrawdownPct)) * 100
        : 0;
    const returnDelta = variant.metrics.cumulativeReturnPct - baseline.metrics.cumulativeReturnPct;
    drafts.push({
      id: 'volatility-sizing',
      title: `Scale size to ${sizedDown}% of portfolio`,
      description: `Sizing every ticket to ${sizedDown}% instead of ${context.params.positionSizePct ?? 10}% caps how much of the book a single gap can remove.`,
      category: 'Crash protection',
      headlineMetricLabel: 'Tail Risk',
      headlineMetricValue: `${tailReduction >= 0 ? '\u2212' : '+'}${Math.abs(tailReduction).toFixed(0)}% Tail Risk`,
      impactLabel: `${signed(returnDelta)}% Return`,
      impactTone: tailReduction >= 0 ? 'positive' : 'warning',
      paramPatch: { positionSizePct: sizedDown },
    });
  }

  return drafts.map((draft) => ({
    ...draft,
    runId: baseline.id,
    status: 'available',
    appliedResult: null,
  }));
}
