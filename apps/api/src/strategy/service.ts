import type { DatabaseSync } from 'node:sqlite';

import type {
  ApplyInsightResponse,
  BacktestDetail,
  BacktestRun,
  ConsoleLog,
  EquitySeries,
  Insight,
  SignalBreakdown,
  Strategy,
  StrategyParam,
  Timeframe,
  ValidateResult,
} from '@kinetix/shared';

import { getDb, newId, parseJson } from '../db/db.ts';
import { MANUAL_STRATEGY_ID } from '../db/schema.ts';
import { type MarketSimulator } from '../sim/market.ts';
import { BACKTEST_INITIAL_EQUITY, computeBands, computeRsi, robustnessScore, runBacktest, type StrategyRuntimeConfig } from './backtest.ts';
import { answerQuestion } from './copilot.ts';
import { parseStrategy, type ParseResult } from './grammar.ts';
import { generateInsights } from './insights.ts';

/* ============================================================================
 * Strategy service.
 *
 * Owns strategy records, source validation, backtest runs, insights and the
 * copilot. Runs and insights are persisted so a reload restores the analysis
 * rather than recomputing a different one.
 * ==========================================================================*/

export interface RunBacktestOptions {
  range?: '1D' | '1W' | '1M' | 'YTD' | 'ALL';
  params?: Record<string, number>;
  feeMultiplier?: number;
}

export interface BacktestResult {
  run: BacktestRun;
  series: EquitySeries;
  insights: Insight[];
  logs: ConsoleLog[];
}

interface StrategyRow {
  id: string;
  name: string;
  version: string;
  status: Strategy['status'];
  instrument: string;
  timeframe: Timeframe;
  venue: 'sim' | 'kotakneo';
  source: string;
  params: string;
  confidencePct: number;
  updatedAt: number;
  lastValidatedAt: number | null;
  deployedBotId: string | null;
}

/** Bars per range, and the timeframe each range is analysed at. */
const RANGE_PLAN: Record<string, { timeframe: Timeframe; bars: number; label: string }> = {
  '1D': { timeframe: '1m', bars: 1_440, label: '1 Day' },
  '1W': { timeframe: '15m', bars: 672, label: '1 Week' },
  '1M': { timeframe: '1h', bars: 720, label: '1 Month' },
  YTD: { timeframe: '1d', bars: 250, label: 'Year to date' },
  ALL: { timeframe: '1d', bars: 1_095, label: 'ALL (3Y)' },
};

export interface StrategyService {
  list(): Strategy[];
  create(name: string): Strategy;
  delete(id: string): boolean;
  get(id: string): Strategy | null;
  updateSource(id: string, source: string, actor: string): { strategy: Strategy; validation: ValidateResult } | null;
  updateParams(id: string, params: Record<string, number>, actor: string): Strategy | null;
  validate(id: string): ValidateResult | null;
  signalBreakdown(id: string): SignalBreakdown | null;
  logs(id: string): ConsoleLog[];
  appendLog(strategyId: string, log: Omit<ConsoleLog, 'ts'>): ConsoleLog;
  runBacktestFor(id: string, options?: RunBacktestOptions): BacktestResult | null;
  latestRun(strategyId: string): BacktestDetail | null;
  getRun(runId: string): BacktestDetail | null;
  applyInsight(runId: string, insightId: string): ApplyInsightResponse | null;
  ask(strategyId: string, question: string, runId?: string): ReturnType<typeof answerQuestion> | null;
  parsedFor(strategyId: string): ParseResult | null;
}

export function defaultParamsForSource(source: string, overrides?: Record<string, number>): StrategyParam[] {
  const parsed = parseStrategy(source);
  if (parsed.rules.emaRule) {
    const emaMap = new Map((parsed.rules.indicators.emas ?? []).map((e) => [e.name, e.period]));
    const trendEmaName = parsed.rules.emaRule.entry.trendEma;
    const trendPeriod = trendEmaName ? (emaMap.get(trendEmaName) ?? 100) : 100;
    const rawStop = parsed.rules.order ? parsed.rules.order.stopLossPct : 1.5;
    const stopLossPct = rawStop <= 0.1 ? Number((rawStop * 100).toFixed(1)) : rawStop;
    const rawTarget = parsed.rules.order ? Math.abs(parsed.rules.order.target) : 0.10;
    const positionSizePct = rawTarget <= 1 ? Math.round(rawTarget * 100) : rawTarget;
    const rsiVal = parsed.rules.emaRule.entry.rsiGate?.value ?? 60;

    return [
      {
        key: 'lookback',
        label: 'Trend EMA Lookback',
        min: 20,
        max: 200,
        step: 5,
        value: overrides?.lookback ?? trendPeriod,
        defaultValue: trendPeriod,
        unit: 'bars',
      },
      {
        key: 'rsiThreshold',
        label: 'RSI Threshold',
        min: 45,
        max: 85,
        step: 1,
        value: overrides?.rsiThreshold ?? rsiVal,
        defaultValue: rsiVal,
        unit: 'index',
      },
      {
        key: 'stopLossPct',
        label: 'Stop Loss',
        min: 0.2,
        max: 10.0,
        step: 0.1,
        value: overrides?.stopLossPct ?? stopLossPct,
        defaultValue: stopLossPct,
        unit: '%',
      },
      {
        key: 'positionSizePct',
        label: 'Position Size',
        min: 1,
        max: 50,
        step: 1,
        value: overrides?.positionSizePct ?? positionSizePct,
        defaultValue: positionSizePct,
        unit: '%',
      },
    ];
  }

  const period = parsed.rules.indicators.bands?.period ?? 50;
  const sigma = parsed.rules.indicators.bands?.sigma ?? 2.4;
  const rawStop = parsed.rules.order ? parsed.rules.order.stopLossPct : 1.5;
  const stopLossPct = rawStop <= 0.1 ? Number((rawStop * 100).toFixed(1)) : rawStop;
  const rawTarget = parsed.rules.order ? Math.abs(parsed.rules.order.target) : 0.10;
  const positionSizePct = rawTarget <= 1 ? Math.round(rawTarget * 100) : rawTarget;
  const rsiVal = parsed.rules.entry?.rsiGate?.value ?? (parsed.rules.indicators.rsi ? 50 : null);

  const params: StrategyParam[] = [
    {
      key: 'lookback',
      label: 'Lookback Window',
      min: 5,
      max: 200,
      step: 1,
      value: overrides?.lookback ?? period,
      defaultValue: period,
      unit: 'bars',
    },
    {
      key: 'entrySigma',
      label: 'Entry Threshold',
      min: 0.5,
      max: 4.0,
      step: 0.1,
      value: overrides?.entrySigma ?? sigma,
      defaultValue: sigma,
      unit: 'σ',
    },
    {
      key: 'stopLossPct',
      label: 'Stop Loss',
      min: 0.2,
      max: 10.0,
      step: 0.1,
      value: overrides?.stopLossPct ?? stopLossPct,
      defaultValue: stopLossPct,
      unit: '%',
    },
    {
      key: 'positionSizePct',
      label: 'Position Size',
      min: 1,
      max: 50,
      step: 1,
      value: overrides?.positionSizePct ?? positionSizePct,
      defaultValue: positionSizePct,
      unit: '%',
    },
  ];

  if (rsiVal !== null) {
    params.push({
      key: 'rsiThreshold',
      label: 'RSI Threshold',
      min: 10,
      max: 90,
      step: 1,
      value: overrides?.rsiThreshold ?? rsiVal,
      defaultValue: rsiVal,
      unit: '',
    });
  }

  return params;
}

export function createStrategyService(market: MarketSimulator): StrategyService {
  const db: DatabaseSync = getDb();
  const logBuffers = new Map<string, ConsoleLog[]>();

  const rowFor = (id: string): StrategyRow | null =>
    (db
      .prepare(
        `SELECT id, name, version, status, instrument, timeframe, venue, source, params,
                confidence_pct AS confidencePct, updated_at AS updatedAt, last_validated_at AS lastValidatedAt,
                deployed_bot_id AS deployedBotId
         FROM strategies WHERE id = ?`,
      )
      .get(id) as StrategyRow | undefined) ?? null;

  const ensureParams = (row: StrategyRow): StrategyParam[] => {
    const existing = parseJson<StrategyParam[]>(row.params, []);
    if (existing.length > 0) return existing;
    return defaultParamsForSource(row.source);
  };

  const toStrategy = (row: StrategyRow): Strategy => ({
    id: row.id,
    name: row.name,
    version: row.version,
    status: row.status,
    instrument: row.instrument,
    timeframe: row.timeframe,
    venue: row.venue,
    language: 'python',
    source: row.source,
    params: ensureParams(row),
    confidencePct: row.confidencePct,
    updatedAt: row.updatedAt,
    lastValidatedAt: row.lastValidatedAt,
    deployedBotId: row.deployedBotId,
  });

  const paramsRecord = (row: StrategyRow): Record<string, number> => {
    const params = ensureParams(row);
    return Object.fromEntries(params.map((param) => [param.key, param.value]));
  };

  const runtimeFor = (row: StrategyRow): StrategyRuntimeConfig => ({
    id: row.id,
    name: row.name,
    source: row.source,
    timeframe: row.timeframe,
    instrument: row.instrument,
  });

  const logs = (strategyId: string): ConsoleLog[] => logBuffers.get(strategyId) ?? [];

  const appendLog = (strategyId: string, log: Omit<ConsoleLog, 'ts'>): ConsoleLog => {
    const entry: ConsoleLog = { ...log, ts: Date.now() };
    const buffer = logBuffers.get(strategyId) ?? [];
    buffer.push(entry);
    // Keep a bounded window; the console shows recent activity, not a transcript.
    if (buffer.length > 120) buffer.splice(0, buffer.length - 120);
    logBuffers.set(strategyId, buffer);
    return entry;
  };

  const candlesFor = (row: StrategyRow, options?: RunBacktestOptions): { candles: ReturnType<MarketSimulator['candles']>; label: string } => {
    const plan = RANGE_PLAN[options?.range ?? 'ALL'] ?? RANGE_PLAN.ALL;
    if (!plan) throw new Error('Unreachable range plan');
    return { candles: market.candles(row.instrument, plan.timeframe, plan.bars), label: plan.label };
  };

  const persistRun = (run: BacktestRun, series: EquitySeries): void => {
    db.prepare('INSERT OR REPLACE INTO backtest_runs (id, strategy_id, payload, created_at) VALUES (?, ?, ?, ?)').run(
      run.id,
      run.strategyId,
      JSON.stringify({ run, series }),
      run.createdAt,
    );
  };

  const persistInsights = (runId: string, insights: Insight[]): void => {
    const statement = db.prepare('INSERT OR REPLACE INTO insights (id, run_id, payload, created_at) VALUES (?, ?, ?, ?)');
    for (const insight of insights) {
      statement.run(`${runId}:${insight.id}`, runId, JSON.stringify(insight), Date.now());
    }
  };

  const insightsFor = (runId: string): Insight[] => {
    const rows = db.prepare('SELECT payload FROM insights WHERE run_id = ?').all(runId) as Array<{ payload: string }>;
    // Preserve the generation order (widen-stop, reduce-overfitting, vol-sizing).
    const order = ['widen-stop', 'reduce-overfitting', 'volatility-sizing'];
    return rows
      .map((row) => parseJson<Insight | null>(row.payload, null))
      .filter((insight): insight is Insight => insight !== null)
      .sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  };

  const detailFor = (runId: string): BacktestDetail | null => {
    const row = db.prepare('SELECT payload FROM backtest_runs WHERE id = ?').get(runId) as { payload: string } | undefined;
    if (!row) return null;
    const parsed = parseJson<{ run: BacktestRun; series: EquitySeries } | null>(row.payload, null);
    if (!parsed) return null;
    return { run: parsed.run, series: parsed.series, insights: insightsFor(runId) };
  };

  const service: StrategyService = {
    list: () => {
      const rows = db
        .prepare(
          `SELECT id, name, version, status, instrument, timeframe, venue, source, params,
                  confidence_pct AS confidencePct, updated_at AS updatedAt,
                  last_validated_at AS lastValidatedAt, deployed_bot_id AS deployedBotId
           FROM strategies WHERE id != ? ORDER BY name ASC`,
        )
        .all(MANUAL_STRATEGY_ID) as unknown as StrategyRow[];
      return rows.map(toStrategy);
    },

    create: (name) => {
      const id = newId('strat');
      const now = Date.now();
      const source = `import kinetix.algo as kx

@kx.strategy(symbol="BTC-USD", interval="15m")
class NewStrategy(kx.BaseStrategy):
    def on_init(self):
        self.bands = kx.BollingerBands(period=50, sigma=2.4)

    def on_candle(self, candle: kx.Candle):
        if candle.close > self.bands.upper:
            self.order_target_percent(target=0.1, stop_loss_pct=1.5, tag="Short")
        elif candle.close < self.bands.lower:
            self.order_target_percent(target=0.1, stop_loss_pct=1.5, tag="Long")
`;
      const initialParams = defaultParamsForSource(source);
      db.prepare(
        `INSERT INTO strategies (id, name, version, status, instrument, timeframe, venue, source, params, confidence_pct, updated_at, last_validated_at, deployed_bot_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(id, name, 'v1.0.0-draft', 'draft', 'BTC-USD', '15m', 'sim', source, JSON.stringify(initialParams), 50.0, now, null, null);
      
      const row = rowFor(id);
      return toStrategy(row!);
    },

    delete: (id) => {
      if (id === MANUAL_STRATEGY_ID) return false;
      db.prepare('DELETE FROM bots WHERE strategy_id = ?').run(id);
      const result = db.prepare('DELETE FROM strategies WHERE id = ?').run(id);
      return result.changes > 0;
    },

    get: (id) => {
      const row = rowFor(id);
      return row ? toStrategy(row) : null;
    },

    parsedFor: (id) => {
      const row = rowFor(id);
      return row ? parseStrategy(row.source) : null;
    },

    updateSource: (id, source, actor) => {
      const row = rowFor(id);
      if (!row) return null;
      const validation = parseStrategy(source);
      appendLog(id, {
        level: validation.ok ? 'success' : 'error',
        scope: 'compiler',
        message: validation.ok
          ? `${actor} compiled ${validation.rules.className ?? 'strategy'} in ${validation.compiledInMs.toFixed(0)}ms`
          : `Validation failed with ${validation.diagnostics.filter((d) => d.severity === 'error').length} error(s)`,
        detail: validation.ok
          ? `AST synced: ${validation.supportedFeatures.length} supported construct(s)`
          : validation.diagnostics
              .filter((diagnostic) => diagnostic.severity === 'error')
              .map((diagnostic) => `Ln ${diagnostic.line}: ${diagnostic.message}`)
              .join(' | '),
      });

      const currentRecord = paramsRecord(row);
      const nextParams = defaultParamsForSource(source, currentRecord);

      db.prepare('UPDATE strategies SET source = ?, params = ?, updated_at = ?, last_validated_at = ? WHERE id = ?').run(
        source,
        JSON.stringify(nextParams),
        Date.now(),
        Date.now(),
        id,
      );
      const updated = rowFor(id);
      return updated ? { strategy: toStrategy(updated), validation } : null;
    },

    updateParams: (id, params, actor) => {
      const row = rowFor(id);
      if (!row) return null;
      const existing = ensureParams(row);
      const next = existing.map((param) =>
        params[param.key] !== undefined
          ? { ...param, value: Math.min(param.max, Math.max(param.min, params[param.key] ?? param.value)) }
          : param,
      );
      db.prepare('UPDATE strategies SET params = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(next), Date.now(), id);
      appendLog(id, { level: 'info', scope: 'params', message: `Parameters updated by ${actor}` });
      const updated = rowFor(id);
      return updated ? toStrategy(updated) : null;
    },

    validate: (id) => {
      const row = rowFor(id);
      if (!row) return null;
      const parsed = parseStrategy(row.source);
      return {
        ok: parsed.ok,
        astSynced: parsed.astSynced,
        diagnostics: parsed.diagnostics,
        supportedFeatures: parsed.supportedFeatures,
        unsupportedFeatures: parsed.unsupportedFeatures,
        compiledInMs: parsed.compiledInMs,
      };
    },

    /**
     * Signal confidence is recomputed from the parsed rules and the live
     * parameter values, so moving a slider changes the number for a reason.
     */
    signalBreakdown: (id) => {
      const row = rowFor(id);
      if (!row) return null;
      const params = paramsRecord(row);
      const parsed = parseStrategy(row.source);
      const { candles } = candlesFor(row);
      const closes = candles.map((candle) => candle.c);
      const lookback = Math.max(2, Math.round(params.lookback ?? 50));
      const sigma = params.entrySigma ?? 2.4;
      const bands = computeBands(closes, lookback, sigma);
      const rsi = parsed.rules.indicators.rsi ? computeRsi(closes, parsed.rules.indicators.rsi.period) : null;

      let signals = 0;
      const histogramBins = [-4, -3, -2, -1, 0, 1, 2, 3, 4];
      const histogram = histogramBins.map((bin) => ({ binLabel: `${bin > 0 ? '+' : ''}${bin}\u03c3`, count: 0 }));

      const bandWidthPercents: number[] = [];
      for (let i = lookback; i < closes.length; i += 1) {
        const close = closes[i] ?? 0;
        const basis = bands.basis[i] ?? null;
        const upper = bands.upper[i] ?? null;
        if (basis === null || upper === null) continue;
        // Distance from the mean in units of one sigma, which is what the
        // signal-confidence histogram is expressed in.
        const sigmaWidth = (upper - basis) / Math.max(1e-9, sigma);
        const z = sigmaWidth > 0 ? (close - basis) / sigmaWidth : 0;
        bandWidthPercents.push((sigmaWidth / Math.max(1e-9, basis)) * 100);
        const bucket = Math.max(0, Math.min(histogram.length - 1, Math.round(z) + 4));
        const entry = histogram[bucket];
        if (entry) entry.count += 1;
      }

      for (let i = lookback + 1; i < closes.length; i += 1) {
        const bandsEntry = bands.upper[i - 1];
        const close = closes[i - 1] ?? 0;
        if (bandsEntry === null || bandsEntry === undefined) continue;
        const broke = close > bandsEntry;
        const gate = parsed.rules.entry?.rsiGate;
        const rsiValue = rsi ? rsi[i - 1] : null;
        const gatePasses =
          !gate || rsiValue === null || rsiValue === undefined
            ? true
            : gate.operator === '>'
              ? rsiValue > (params.rsiThreshold ?? gate.value)
              : rsiValue < (params.rsiThreshold ?? gate.value);
        if (broke && gatePasses) signals += 1;
      }

      // Confidence blends signal frequency with the strategy's own robustness, so
      // it responds to both the parameters and the code.
      const frequency = (signals / Math.max(1, closes.length)) * 100;
      const robust = robustnessScore({ candles, strategy: runtimeFor(row), params, parsed });
      const confidence = Math.max(5, Math.min(99, frequency * 8 + robust * 0.45));

      const samples = [-3, -1.5, 0, sigma, sigma + 0.6].map((value) => ({
        label: value === 0 ? '0\u03c3 (Mean)' : `${value > 0 ? '+' : ''}${value.toFixed(1)}\u03c3`,
        sigma: value,
        isEntry: Math.abs(value - sigma) < 1e-9,
      }));

      // Expected payoff in R: how far a typical band excursion runs relative to
      // the configured stop, so it responds to both sigma and the stop slider.
      const averageBandWidthPct =
        bandWidthPercents.length > 0
          ? bandWidthPercents.reduce((acc, value) => acc + value, 0) / bandWidthPercents.length
          : 0;
      const stopPct = params.stopLossPct ?? 1.5;
      const expectedPayoffR = Math.max(0.1, Math.min(10, (averageBandWidthPct * sigma) / Math.max(0.1, stopPct)));

      return {
        confidencePct: Number(confidence.toFixed(1)),
        postCalibrationDeltaPct: Number(((confidence - row.confidencePct) / 10).toFixed(1)),
        expectedPayoffR: Number(expectedPayoffR.toFixed(2)),
        samples,
        entrySigma: sigma,
        histogram,
      };
    },

    logs,
    appendLog,

    runBacktestFor: (id, options) => {
      const row = rowFor(id);
      if (!row) return null;
      const parsed = parseStrategy(row.source);
      const params = { ...paramsRecord(row), ...(options?.params ?? {}) };
      const { candles, label } = candlesFor(row, options);

      appendLog(id, {
        level: 'info',
        scope: 'engine',
        message: `Simulating ${candles.length} ${row.timeframe} candles over ${label}`,
        detail: `params ${JSON.stringify(params)}`,
      });

      if (!parsed.ok) {
        appendLog(id, {
          level: 'error',
          scope: 'engine',
          message: 'Backtest aborted — source does not parse against the supported grammar',
        });
      }

      const result = runBacktest({
        strategy: runtimeFor(row),
        candles,
        rangeLabel: label,
        params,
        parsed,
        ...(options?.feeMultiplier !== undefined ? { feeMultiplier: options.feeMultiplier } : {}),
      });

      const insights = generateInsights({
        strategy: runtimeFor(row),
        candles,
        params,
        parsed,
        baseline: result.run,
      });

      // Persist the parameter values actually used, so a later Apply can diff
      // against what produced this run.
      db.prepare('UPDATE strategies SET params = ?, updated_at = ? WHERE id = ?').run(
        JSON.stringify(
          ensureParams(row).map((param) =>
            params[param.key] !== undefined ? { ...param, value: params[param.key] as number } : param,
          ),
        ),
        Date.now(),
        id,
      );

      persistRun(result.run, result.series);
      persistInsights(result.run.id, insights);

      appendLog(id, {
        level: 'success',
        scope: 'engine',
        message: `Run complete in ${result.run.computeMs.toFixed(0)}ms — ${result.run.metrics.totalTrades} trades, Sharpe ${result.run.metrics.sharpe}`,
        detail: `return ${result.run.metrics.cumulativeReturnPct}% vs benchmark ${result.run.metrics.benchmarkReturnPct}%`,
      });

      return { run: result.run, series: result.series, insights, logs: logs(id) };
    },

    latestRun: (strategyId) => {
      const row = db
        .prepare('SELECT id FROM backtest_runs WHERE strategy_id = ? ORDER BY created_at DESC LIMIT 1')
        .get(strategyId) as { id: string } | undefined;
      return row ? detailFor(row.id) : null;
    },

    getRun: (runId) => detailFor(runId),

    applyInsight: (runId, insightId) => {
      const detail = detailFor(runId);
      if (!detail) return null;
      const insight = detail.insights.find((candidate) => candidate.id === insightId);
      if (!insight) return null;

      const row = rowFor(detail.run.strategyId);
      if (!row) return null;

      const before = detail.run.metrics;
      const next = service.runBacktestFor(row.id, { params: insight.paramPatch, range: undefined });
      if (!next) return null;
      const after = next.run.metrics;

      const applied: Insight = {
        ...insight,
        runId: next.run.id,
        status: 'applied',
        appliedResult: {
          metric: 'Cumulative Return',
          before: `${before.cumulativeReturnPct.toFixed(1)}%`,
          after: `${after.cumulativeReturnPct.toFixed(1)}%`,
          valueBefore: before.cumulativeReturnPct,
          valueAfter: after.cumulativeReturnPct,
        },
      };
      persistInsights(next.run.id, [applied]);
      // Carry the untouched siblings across so the panel still shows all three.
      const siblings = detail.insights
        .filter((candidate) => candidate.id !== insight.id)
        .map((candidate) => ({ ...candidate, runId: next.run.id, status: 'available' as const }));
      persistInsights(next.run.id, siblings);

      appendLog(row.id, {
        level: 'success',
        scope: 'insight',
        message: `Applied "${insight.title}" — return ${before.cumulativeReturnPct.toFixed(1)}% to ${after.cumulativeReturnPct.toFixed(1)}%`,
      });

      return { insight: applied, run: next.run };
    },

    ask: (strategyId, question, runId) => {
      const row = rowFor(strategyId);
      if (!row) return null;
      const parsed = parseStrategy(row.source);
      const params = paramsRecord(row);
      const { candles, label } = candlesFor(row);

      const detail = runId ? detailFor(runId) : service.latestRun(strategyId);
      const baseline =
        detail ??
        (() => {
          const fresh = runBacktest({ strategy: runtimeFor(row), candles, rangeLabel: label, params, parsed });
          persistRun(fresh.run, fresh.series);
          return { run: fresh.run, series: fresh.series, insights: [] };
        })();

      const answer = answerQuestion(question, {
        strategy: runtimeFor(row),
        parsed,
        params,
        candles,
        run: baseline.run,
        series: baseline.series,
      });

      if (answer.resimulatedRunId) {
        appendLog(strategyId, {
          level: 'info',
          scope: 'copilot',
          message: `Fee-shock re-simulation ${answer.resimulatedRunId} computed in ${answer.computeMs.toFixed(0)}ms`,
        });
      }

      return answer;
    },
  };

  return service;
}

export { BACKTEST_INITIAL_EQUITY, newId };
