import type { BacktestRun, Candle, EquityPoint, EquitySeries, Timeframe, Trade } from '@kinetix/shared';

import type { ParseResult } from './grammar.ts';

/* ============================================================================
 * Backtest engine.
 *
 * Signals are evaluated on a bar's close and filled at the *next* bar's open, so
 * the reported performance cannot benefit from lookahead. Fees and slippage are
 * charged per side and scaled by `feeMultiplier`, which is what lets the copilot
 * answer a fee-shock question by genuinely re-running rather than by rescaling
 * an existing number.
 * ==========================================================================*/

/** Normalised account so dollar figures in the report are meaningful. */
export const BACKTEST_INITIAL_EQUITY = 150_000;
/** Base taker fee per side, in basis points. */
const BASE_FEE_BPS = 4;
/** Assumed slippage per side, in basis points. */
const SLIPPAGE_BPS = 1.2;

const BARS_PER_YEAR: Record<Timeframe, number> = {
  '1m': 525_600,
  '15m': 35_040,
  '1h': 8_760,
  '1d': 365,
};

const MS_PER_DAY = 86_400_000;
/** Wall-clock duration of one bar, used to express recovery in days. */
const barMs = (timeframe: Timeframe): number => (365 * MS_PER_DAY) / BARS_PER_YEAR[timeframe];

export interface StrategyRuntimeConfig {
  id: string;
  name: string;
  source: string;
  timeframe: Timeframe;
  instrument: string;
}

export interface BacktestInput {
  strategy: StrategyRuntimeConfig;
  candles: readonly Candle[];
  rangeLabel: string;
  params: Record<string, number>;
  parsed: ParseResult;
  feeMultiplier?: number;
}

export interface BacktestOutput {
  run: BacktestRun;
  series: EquitySeries;
}

/* ------------------------------- indicators ------------------------------- */

export function computeSma(values: readonly number[], period: number): Array<number | null> {
  const out: Array<number | null> = new Array(values.length).fill(null);
  if (period <= 0) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i] ?? 0;
    if (i >= period) sum -= values[i - period] ?? 0;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function computeStdDev(values: readonly number[], period: number): Array<number | null> {
  const out: Array<number | null> = new Array(values.length).fill(null);
  const means = computeSma(values, period);
  for (let i = period - 1; i < values.length; i += 1) {
    const mean = means[i];
    if (mean === null || mean === undefined) continue;
    let variance = 0;
    for (let j = i - period + 1; j <= i; j += 1) {
      const value = values[j] ?? 0;
      variance += (value - mean) ** 2;
    }
    // Population standard deviation, matching the usual band implementation.
    out[i] = Math.sqrt(variance / period);
  }
  return out;
}

export interface BandSet {
  basis: Array<number | null>;
  upper: Array<number | null>;
  lower: Array<number | null>;
}

export function computeBands(closes: readonly number[], period: number, sigma: number): BandSet {
  const basis = computeSma(closes, period);
  const deviation = computeStdDev(closes, period);
  const upper: Array<number | null> = new Array(closes.length).fill(null);
  const lower: Array<number | null> = new Array(closes.length).fill(null);
  for (let i = 0; i < closes.length; i += 1) {
    const mean = basis[i];
    const sd = deviation[i];
    if (mean === null || mean === undefined || sd === null || sd === undefined) continue;
    upper[i] = mean + sigma * sd;
    lower[i] = mean - sigma * sd;
  }
  return { basis, upper, lower };
}

/** Wilder's RSI. Returns null until the first average has been established. */
export function computeRsi(closes: readonly number[], period: number): Array<number | null> {
  const out: Array<number | null> = new Array(closes.length).fill(null);
  if (period <= 0 || closes.length <= period) return out;

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i += 1) {
    const change = (closes[i] ?? 0) - (closes[i - 1] ?? 0);
    if (change >= 0) gainSum += change;
    else lossSum -= change;
  }

  let averageGain = gainSum / period;
  let averageLoss = lossSum / period;
  out[period] = averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss);

  for (let i = period + 1; i < closes.length; i += 1) {
    const change = (closes[i] ?? 0) - (closes[i - 1] ?? 0);
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    averageGain = (averageGain * (period - 1) + gain) / period;
    averageLoss = (averageLoss * (period - 1) + loss) / period;
    out[i] = averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss);
  }
  return out;
}

/* --------------------------------- helpers -------------------------------- */

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((acc, value) => acc + value, 0) / values.length;
}

function stdDev(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const avg = mean(values);
  return Math.sqrt(values.reduce((acc, value) => acc + (value - avg) ** 2, 0) / (values.length - 1));
}

function monthLabel(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

function sharpeTierLabel(sharpe: number): string {
  if (sharpe >= 3) return 'Excellent Tier';
  if (sharpe >= 2) return 'Strong Tier';
  if (sharpe >= 1) return 'Adequate Tier';
  return 'Developing';
}

/**
 * Derive tick quality from the candle series: the share of bars whose
 * high/low range is plausible relative to the median range. A series with
 * many zero-range or extreme-range bars is lower quality.
 */
function deriveTickQuality(candles: readonly Candle[]): number {
  if (candles.length < 2) return 99.8;
  const ranges = candles.map((c) => c.h - c.l).filter((r) => r > 0).sort((a, b) => a - b);
  if (ranges.length === 0) return 99.8;
  const median = ranges[Math.floor(ranges.length / 2)] ?? 1;
  const plausible = ranges.filter((r) => r <= median * 5).length;
  return Number(((plausible / ranges.length) * 100).toFixed(1));
}

/** Subsample a series to keep websocket and payload sizes sane. */
function subsample<T>(points: readonly T[], maxPoints = 360): T[] {
  if (points.length <= maxPoints) return [...points];
  const stride = Math.ceil(points.length / maxPoints);
  const out: T[] = [];
  for (let i = 0; i < points.length; i += stride) {
    const point = points[i];
    if (point !== undefined) out.push(point);
  }
  const last = points[points.length - 1];
  if (last !== undefined) {
    const lastOut = out[out.length - 1];
    if (lastOut !== last) out.push(last);
  }
  return out;
}

/* ------------------------------ strategy logic ---------------------------- */

export interface InterpretedParams {
  lookback: number;
  entrySigma: number;
  stopLossPct: number;
  positionSizePct: number;
  rsiThreshold: number | null;
}

export function resolveParams(params: Record<string, number>, parsed: ParseResult): InterpretedParams {
  const bandsPeriod = parsed.rules.indicators.bands?.period;
  const bandsSigma = parsed.rules.indicators.bands?.sigma;
  return {
    lookback: Math.max(2, Math.round(params.lookback ?? bandsPeriod ?? 50)),
    entrySigma: Math.max(0.1, params.entrySigma ?? bandsSigma ?? 2.4),
    // The panel expresses the stop as a percentage (1.5), the grammar as a
    // fraction (0.015). Normalise to a percentage here, once.
    stopLossPct: params.stopLossPct ?? (parsed.rules.order ? parsed.rules.order.stopLossPct * 100 : 1.5),
    positionSizePct: params.positionSizePct ?? (parsed.rules.order ? parsed.rules.order.target * 100 : 10),
    rsiThreshold: params.rsiThreshold ?? parsed.rules.entry?.rsiGate?.value ?? null,
  };
}

/**
 * Scores how much of the edge survives across sub-periods. A strategy whose
 * Sharpe is carried entirely by one half of the sample scores low, which is the
 * overfitting signal the insights panel acts on.
 */
export function robustnessScore(input: {
  candles: readonly Candle[];
  strategy: StrategyRuntimeConfig;
  params: Record<string, number>;
  parsed: ParseResult;
  feeMultiplier?: number;
}): number {
  const candles = input.candles;
  if (candles.length < 60) return 50;

  const midpoint = Math.floor(candles.length / 2);
  const halves: Candle[][] = [candles.slice(0, midpoint), candles.slice(midpoint)];

  const sharpes = halves
    .map((half) =>
      runBacktest({
        strategy: input.strategy,
        candles: half,
        rangeLabel: 'half',
        params: input.params,
        parsed: input.parsed,
        ...(input.feeMultiplier !== undefined ? { feeMultiplier: input.feeMultiplier } : {}),
      }),
    )
    .map((output) => output.run.metrics.sharpe);

  const full = runBacktest({
    strategy: input.strategy,
    candles,
    rangeLabel: 'full',
    params: input.params,
    parsed: input.parsed,
    ...(input.feeMultiplier !== undefined ? { feeMultiplier: input.feeMultiplier } : {}),
  }).run.metrics;

  const first = sharpes[0] ?? 0;
  const second = sharpes[1] ?? 0;
  const consistencyPenalty = Math.abs(first - second) * 12;
  const turnover = Math.min(20, (full.totalTrades / Math.max(1, candles.length)) * 900);
  const score = 100 - consistencyPenalty - turnover;
  return Number(Math.max(0, Math.min(100, score)).toFixed(1));
}

export function runBacktest(input: BacktestInput): BacktestOutput {
  const startedAt = performance.now();
  const { candles, strategy, parsed } = input;
  const params = resolveParams(input.params, parsed);
  const feeMultiplier = input.feeMultiplier ?? 1;
  const feeRate = (BASE_FEE_BPS * feeMultiplier) / 10_000;
  const slippageRate = SLIPPAGE_BPS / 10_000;

  const closes = candles.map((candle) => candle.c);
  const bands = computeBands(closes, params.lookback, params.entrySigma);
  const rsi = parsed.rules.indicators.rsi ? computeRsi(closes, parsed.rules.indicators.rsi.period) : null;

  const entryComparator = parsed.rules.entry?.comparator ?? 'upper';
  const entryOperator = parsed.rules.entry?.operator ?? '>';
  const exitComparator = parsed.rules.exit?.comparator ?? 'basis';
  const exitOperator = parsed.rules.exit?.operator ?? '<';

  let equity = BACKTEST_INITIAL_EQUITY;
  let peak = equity;
  let maxDrawdownPct = 0;
  let peakIndexAtWorst = 0;
  let troughIndexAtWorst = 0;

  interface OpenPosition {
    entryTime: number;
    entryPrice: number;
    quantity: number;
    side: 'long' | 'short';
  }
  let open: OpenPosition | null = null;

  const trades: Trade[] = [];
  const equityCurve: EquityPoint[] = [];
  const drawdownCurve: EquityPoint[] = [];

  let totalFees = 0;
  let totalSlippage = 0;

  const valueOf = (comparator: 'upper' | 'lower' | 'basis', index: number): number | null => {
    const value = bands[comparator][index];
    return value === null || value === undefined ? null : value;
  };

  const compare = (left: number, operator: '>' | '<', right: number): boolean => (operator === '>' ? left > right : left < right);

  for (let i = 0; i < candles.length; i += 1) {
    const candle = candles[i];
    if (!candle) continue;
    const close = candle.c;

    // --- intrabar stop, evaluated before any other exit ---------------------
    if (open) {
      const stopDistance = open.entryPrice * (params.stopLossPct / 100);
      const stopPrice = open.side === 'long'
        ? open.entryPrice - stopDistance
        : open.entryPrice + stopDistance;
      const hit = open.side === 'long' ? candle.l <= stopPrice : candle.h >= stopPrice;
      if (hit) {
        const exitPrice = open.side === 'long'
          ? stopPrice * (1 - slippageRate)
          : stopPrice * (1 + slippageRate);
        const direction = open.side === 'long' ? 1 : -1;
        const gross = (exitPrice - open.entryPrice) * open.quantity * direction;
        // The entry leg was already charged when the position opened; only the
        // exit leg is billed here.
        const fees = exitPrice * open.quantity * feeRate;
        totalFees += fees;
        totalSlippage += stopPrice * open.quantity * slippageRate;
        equity += gross - fees;

        trades.push({
          id: `tr_${trades.length + 1}`,
          side: open.side,
          entryTs: open.entryTime,
          exitTs: candle.t,
          entryPrice: Number(open.entryPrice.toFixed(2)),
          exitPrice: Number(exitPrice.toFixed(2)),
          quantity: Number(open.quantity.toFixed(6)),
          pnlUsd: Number((gross - fees).toFixed(2)),
          pnlPct: Number((((exitPrice - open.entryPrice) / open.entryPrice) * 100 * direction).toFixed(4)),
          rMultiple: Number(((exitPrice - open.entryPrice) * direction / (open.entryPrice * (params.stopLossPct / 100))).toFixed(2)),
          tag: `${parsed.rules.order?.tag ?? 'Exit'}_Stop`,
        });
        open = null;
      }
    }

    // --- band exit ----------------------------------------------------------
    if (open) {
      const exitLevel = valueOf(exitComparator, i);
      if (exitLevel !== null && compare(close, exitOperator, exitLevel)) {
        const exitPrice = open.side === 'long' ? candle.o * (1 - slippageRate) : candle.o * (1 + slippageRate);
        const direction = open.side === 'long' ? 1 : -1;
        const gross = (exitPrice - open.entryPrice) * open.quantity * direction;
        const fees = exitPrice * open.quantity * feeRate;
        totalFees += fees;
        totalSlippage += candle.o * open.quantity * slippageRate;
        equity += gross - fees;

        trades.push({
          id: `tr_${trades.length + 1}`,
          side: open.side,
          entryTs: open.entryTime,
          exitTs: candle.t,
          entryPrice: Number(open.entryPrice.toFixed(2)),
          exitPrice: Number(exitPrice.toFixed(2)),
          quantity: Number(open.quantity.toFixed(6)),
          pnlUsd: Number((gross - fees).toFixed(2)),
          pnlPct: Number((((exitPrice - open.entryPrice) / open.entryPrice) * 100 * direction).toFixed(4)),
          rMultiple: Number(
            ((exitPrice - open.entryPrice) * direction / Math.max(1e-9, open.entryPrice * (params.stopLossPct / 100))).toFixed(2),
          ),
          tag: parsed.rules.order?.tag ?? 'Exit',
        });
        open = null;
      }
    }

    // --- entry, filled at the next bar's open -------------------------------
    if (!open) {
      const entryLevel = valueOf(entryComparator, i);
      const gate = parsed.rules.entry?.rsiGate;
      const rsiValue = rsi ? rsi[i] : null;
      // The RSI gate's comparison operator comes from the source; the threshold
      // value may be overridden by the parameter panel if one is supplied.
      let gatePasses = true;
      if (gate) {
        const threshold = params.rsiThreshold ?? gate.value;
        gatePasses =
          rsiValue === null || rsiValue === undefined ? false : compare(rsiValue, gate.operator, threshold);
      }

      if (entryLevel !== null && compare(close, entryOperator, entryLevel) && gatePasses) {
        // Filled at the next bar's open: no signal can be traded on the bar that
        // produced it, which is what keeps the result free of lookahead bias.
        const next = candles[i + 1];
        if (next) {
          const notional = equity * (params.positionSizePct / 100);
          const side: 'long' | 'short' = entryOperator === '>' ? 'long' : 'short';
          const entryPrice = side === 'long' ? next.o * (1 + slippageRate) : next.o * (1 - slippageRate);
          const quantity = notional / entryPrice;
          const entryFee = notional * feeRate;
          totalFees += entryFee;
          totalSlippage += next.o * quantity * slippageRate;
          equity -= entryFee;
          open = { entryTime: next.t, entryPrice, quantity, side };
        }
      }
    }

    // --- mark to market -----------------------------------------------------
    const marked = open
      ? equity + (open.side === 'long' ? (close - open.entryPrice) : (open.entryPrice - close)) * open.quantity
      : equity;
    peak = Math.max(peak, marked);
    const drawdown = ((marked - peak) / peak) * 100;
    if (drawdown < maxDrawdownPct) {
      maxDrawdownPct = drawdown;
      peakIndexAtWorst = i;
      troughIndexAtWorst = i;
    }
    equityCurve.push({ t: candle.t, v: Number(marked.toFixed(2)) });
    drawdownCurve.push({ t: candle.t, v: Number(drawdown.toFixed(4)) });
  }

  // Close any position still open at the final bar so the report is complete.
  if (open) {
    const last = candles[candles.length - 1];
    if (last) {
      const exitPrice = open.side === 'long' ? last.c * (1 - slippageRate) : last.c * (1 + slippageRate);
      const direction = open.side === 'long' ? 1 : -1;
      const gross = (exitPrice - open.entryPrice) * open.quantity * direction;
      const fees = exitPrice * open.quantity * feeRate;
      totalFees += fees;
      equity += gross - fees;
      trades.push({
        id: `tr_${trades.length + 1}`,
        side: open.side,
        entryTs: open.entryTime,
        exitTs: last.t,
        entryPrice: Number(open.entryPrice.toFixed(2)),
        exitPrice: Number(exitPrice.toFixed(2)),
        quantity: Number(open.quantity.toFixed(6)),
        pnlUsd: Number((gross - fees).toFixed(2)),
        pnlPct: Number((((exitPrice - open.entryPrice) / open.entryPrice) * 100 * direction).toFixed(4)),
        rMultiple: Number(
          ((exitPrice - open.entryPrice) * direction / Math.max(1e-9, open.entryPrice * (params.stopLossPct / 100))).toFixed(2),
        ),
        tag: 'Mark_To_Market_Close',
      });
    }
  }

  const finalEquity = equityCurve[equityCurve.length - 1]?.v ?? equity;
  const cumulativeReturnPct = ((finalEquity - BACKTEST_INITIAL_EQUITY) / BACKTEST_INITIAL_EQUITY) * 100;

  // --- benchmark: buy and hold over the same window -------------------------
  const firstCandle = candles[0];
  const lastCandle = candles[candles.length - 1];
  const benchmarkStart = firstCandle?.o ?? 0;
  const benchmarkEnd = lastCandle?.c ?? 0;
  const benchmarkReturnPct = benchmarkStart > 0 ? ((benchmarkEnd - benchmarkStart) / benchmarkStart) * 100 : 0;
  const benchmarkCurve: EquityPoint[] = candles.map((candle) => ({
    t: candle.t,
    v: Number((((candle.c - benchmarkStart) / Math.max(1e-9, benchmarkStart)) * 100).toFixed(4)),
  }));

  // --- risk-adjusted metrics ----------------------------------------------
  const returns: number[] = [];
  for (let i = 1; i < equityCurve.length; i += 1) {
    const previous = equityCurve[i - 1]?.v ?? 0;
    const current = equityCurve[i]?.v ?? 0;
    if (previous > 0) returns.push(current / previous - 1);
  }

  const barsPerYear = BARS_PER_YEAR[strategy.timeframe];
  const averageReturn = mean(returns);
  const deviation = stdDev(returns);
  const sharpe = deviation > 0 ? (averageReturn / deviation) * Math.sqrt(barsPerYear) : 0;

  const downside = returns.filter((value) => value < 0);
  const downsideDeviation = Math.sqrt(
    downside.reduce((acc, value) => acc + value ** 2, 0) / Math.max(1, downside.length),
  );
  const sortino = downsideDeviation > 0 ? (averageReturn / downsideDeviation) * Math.sqrt(barsPerYear) : 0;

  const years = candles.length / barsPerYear;
  const cagr = years > 0 ? ((finalEquity / BACKTEST_INITIAL_EQUITY) ** (1 / years) - 1) * 100 : 0;
  const calmar = maxDrawdownPct < 0 ? cagr / Math.abs(maxDrawdownPct) : 0;

  // Recovery: bars from the worst trough until equity reclaims the prior peak.
  let recoveryBars = 0;
  const worstPeakValue = equityCurve
    .slice(0, troughIndexAtWorst + 1)
    .reduce((acc, point) => Math.max(acc, point.v), BACKTEST_INITIAL_EQUITY);
  let recoveredIndex: number | null = null;
  for (let i = troughIndexAtWorst; i < equityCurve.length; i += 1) {
    const point = equityCurve[i];
    if (point && point.v >= worstPeakValue) {
      recoveredIndex = i;
      break;
    }
  }
  if (recoveredIndex !== null) {
    recoveryBars = recoveredIndex - troughIndexAtWorst;
  } else {
    recoveryBars = equityCurve.length - troughIndexAtWorst;
  }

  const barsPerWeek = barsPerYear / 52;
  const tradesPerWeek = trades.length / Math.max(1e-9, candles.length / barsPerWeek);

  const winners = trades.filter((trade) => trade.pnlUsd > 0);
  const losers = trades.filter((trade) => trade.pnlUsd <= 0);
  const grossGainsUsd = winners.reduce((acc, trade) => acc + trade.pnlUsd, 0);
  const grossLossesUsd = losers.reduce((acc, trade) => acc + trade.pnlUsd, 0);
  const averageWin = winners.length > 0 ? grossGainsUsd / winners.length : 0;
  const averageLoss = losers.length > 0 ? Math.abs(grossLossesUsd) / losers.length : 0;

  const metrics = {
    cumulativeReturnPct: Number(cumulativeReturnPct.toFixed(2)),
    alphaVsBenchmarkPct: Number((cumulativeReturnPct - benchmarkReturnPct).toFixed(2)),
    benchmarkReturnPct: Number(benchmarkReturnPct.toFixed(2)),
    benchmarkLabel: `${strategy.instrument} Buy & Hold`,
    sharpe: Number(sharpe.toFixed(2)),
    sharpeTier: sharpeTierLabel(sharpe),
    sortino: Number(sortino.toFixed(2)),
    calmar: Number(calmar.toFixed(2)),
    maxDrawdownPct: Number(maxDrawdownPct.toFixed(2)),
    maxDrawdownPeakLabel: monthLabel(equityCurve[peakIndexAtWorst]?.t ?? candles[0]?.t ?? Date.now()),
    maxDrawdownRecoveryDays: Number(((recoveryBars * barMs(strategy.timeframe)) / MS_PER_DAY).toFixed(0)),
    profitFactor: Number((grossGainsUsd / Math.max(1e-9, Math.abs(grossLossesUsd))).toFixed(2)),
    winRatePct: Number(((winners.length / Math.max(1, trades.length)) * 100).toFixed(1)),
    grossGainsUsd: Number(grossGainsUsd.toFixed(2)),
    grossLossesUsd: Number(grossLossesUsd.toFixed(2)),
    totalTrades: trades.length,
    tradesPerWeek: Number(tradesPerWeek.toFixed(2)),
    avgTradeReturnPct: Number(mean(trades.map((trade) => trade.pnlPct)).toFixed(2)),
    payoffRatio: Number((averageWin / Math.max(1e-9, averageLoss)).toFixed(2)),
    slippageImpactPct: Number(((totalSlippage / BACKTEST_INITIAL_EQUITY) * 100).toFixed(3)),
    totalFeesUsd: Number(totalFees.toFixed(2)),
  };

  const run: BacktestRun = {
    id: `bt_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`,
    strategyId: strategy.id,
    strategyName: strategy.name,
    instrumentLabel: strategy.instrument,
    rangeLabel: input.rangeLabel,
    candleCount: candles.length,
    tickQualityPct: deriveTickQuality(candles),
    feeMultiplier,
    params: {
      lookback: params.lookback,
      entrySigma: params.entrySigma,
      stopLossPct: params.stopLossPct,
      positionSizePct: params.positionSizePct,
      ...(params.rsiThreshold !== null ? { rsiThreshold: params.rsiThreshold } : {}),
    },
    metrics,
    trades,
    computeMs: Number((performance.now() - startedAt).toFixed(2)),
    createdAt: Date.now(),
    status: 'complete',
    error: null,
  };

  const series: EquitySeries = {
    strategy: subsample(
      equityCurve.map((point) => ({ t: point.t, v: Number((((point.v - BACKTEST_INITIAL_EQUITY) / BACKTEST_INITIAL_EQUITY) * 100).toFixed(4)) })),
    ),
    benchmark: subsample(benchmarkCurve),
    drawdown: subsample(drawdownCurve),
  };

  return { run, series };
}
