import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';

import { formatMs, formatNumber, formatPct, formatUsd, toneFor } from '@kinetix/shared';
import type { BacktestRun, EquitySeries, Insight } from '@kinetix/shared';

import { EquityChart } from '../components/charts.tsx';
import {
  Button,
  Card,
  CardHeader,
  Chip,
  ErrorState,
  Icon,
  Metric,
  MicroLabel,
  SegmentedControl,
  Skeleton,
} from '../components/ui.tsx';
import { ApiError, api } from '../lib/api.ts';

const RANGES = ['1M', '1W', '1D', 'YTD', 'ALL'] as const;

const SUGGESTED_QUERIES = [
  'How did the strategy behave through the 2022 deleveraging crash?',
  'What happens if taker fees triple?',
  'What is the expectancy per trade?',
];

interface CopilotTurn {
  id: string;
  question: string;
  answer: string;
  computeMs: number;
  groundedOn: string[];
  intent: string;
}

export function BacktestPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [strategyId, setStrategyId] = useState<string | null>(null);
  const [range, setRange] = useState<(typeof RANGES)[number]>('ALL');
  const [run, setRun] = useState<BacktestRun | null>(null);
  const [series, setSeries] = useState<EquitySeries | null>(null);
  const [insights, setInsights] = useState<Insight[]>([]);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [question, setQuestion] = useState('');
  const [turns, setTurns] = useState<CopilotTurn[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const autoRunFor = useRef<string | null>(null);

  const strategiesQuery = useQuery({ queryKey: ['strategies'], queryFn: api.strategies });
  const strategies = strategiesQuery.data?.strategies ?? [];

  useEffect(() => {
    if (!strategyId && strategies.length > 0) setStrategyId(strategies[0]?.id ?? null);
  }, [strategies, strategyId]);

  const runBacktest = useMutation({
    mutationFn: (input: { id: string; range: string }) =>
      api.runBacktest(input.id, { range: input.range }),
    onSuccess: (result) => {
      setRun(result.run);
      setSeries(result.series);
      setInsights(result.insights);
      setNotice(null);
      void queryClient.invalidateQueries({ queryKey: ['strategy', result.run.strategyId] });
    },
    onError: (error) => {
      setNotice(error instanceof ApiError ? `${error.message}${error.detail ? ` — ${error.detail}` : ''}` : 'Backtest failed');
    },
  });

  // Run once per strategy/range pair on first view, so the screen is populated
  // without the operator having to press anything.
  useEffect(() => {
    if (!strategyId) return;
    setHoverIndex(null);
    const key = `${strategyId}:${range}`;
    if (autoRunFor.current === key) return;
    autoRunFor.current = key;
    runBacktest.mutate({ id: strategyId, range });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strategyId, range]);

  const applyInsight = useMutation({
    mutationFn: (input: { runId: string; insightId: string }) => api.applyInsight(input.runId, input.insightId),
    onSuccess: (result) => {
      setRun(result.run);
      setInsights((current) => {
        const others = current.filter((candidate) => candidate.id !== result.insight.id);
        return [...others, result.insight];
      });
      setNotice(
        `Applied "${result.insight.title}": return ${result.insight.appliedResult?.before ?? '—'} to ${
          result.insight.appliedResult?.after ?? '—'
        }`,
      );
      // Applying an insight re-runs the backtest, so the chart must be refreshed.
      void api
        .backtest(result.run.id)
        .then((detail) => setSeries(detail.series))
        .catch(() => undefined);
    },
  });

  const ask = useMutation({
    mutationFn: (text: string) => api.ask(strategyId as string, text, run?.id),
    onSuccess: (answer) => {
      setTurns((current) => [
        ...current,
        {
          id: answer.id,
          question: answer.question,
          answer: answer.answer,
          computeMs: answer.computeMs,
          groundedOn: answer.groundedOn,
          intent: answer.intent,
        },
      ]);
      setQuestion('');
    },
    onError: (error) => setNotice(error instanceof ApiError ? error.message : 'Copilot query failed'),
  });

  const metrics = run?.metrics ?? null;

  return (
    <div className="px-gutter-desktop py-space-xl max-w-[1720px] mx-auto w-full space-y-space-lg">
      {/* ------------------------------- run header ------------------------ */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-space-md">
        <div className="flex items-center gap-space-md flex-wrap">
          <div className="relative inline-flex items-center">
            <label htmlFor="backtest-strategy" className="sr-only">
              Strategy
            </label>
            <select
              id="backtest-strategy"
              value={strategyId ?? ''}
              onChange={(event) => setStrategyId(event.target.value)}
              className="appearance-none bg-surface-container px-space-md py-2 pr-8 rounded-xl font-headline-sm text-headline-sm text-on-surface focus:outline-none focus:ring-1 focus:ring-primary-container cursor-pointer"
            >
              {strategies.map((candidate) => (
                <option key={candidate.id} value={candidate.id} className="bg-surface-container">
                  {candidate.name}
                </option>
              ))}
            </select>
            <Icon name="expand_more" size={18} className="absolute right-2 text-on-surface-variant pointer-events-none" />
          </div>

          <div className="flex items-center gap-space-sm bg-surface-container px-space-md py-2 rounded-xl">
            <span className="w-2.5 h-2.5 rounded-full bg-secondary animate-pulse" />
            <span className="font-headline-sm text-headline-sm text-on-surface">
              {run ? `${run.instrumentLabel} • ${run.rangeLabel}` : 'Loading…'}
            </span>
          </div>

          {run ? (
            <>
              <span className="px-2.5 py-1 rounded-xl bg-surface-variant font-label-numeric-sm text-label-numeric-sm text-on-surface-variant">
                {formatNumber(run.candleCount, 0)} Candles
              </span>
              <span className="px-2.5 py-1 rounded-xl bg-surface-variant font-label-numeric-sm text-label-numeric-sm text-on-surface-variant">
                Tick Quality {run.tickQualityPct.toFixed(1)}%
              </span>
            </>
          ) : null}
        </div>

        <div className="flex items-center gap-space-sm flex-wrap">
          <SegmentedControl options={RANGES} value={range} onChange={setRange} ariaLabel="Backtest range" />
          <Button
            variant="ghost"
            size="micro"
            icon="tune"
            onClick={() => strategyId && navigate(`/strategy-ide?strategy=${strategyId}`)}
          >
            Parameters
          </Button>
          <Button
            variant="ghost"
            size="micro"
            icon="file_download"
            onClick={() => {
              if (!run) return;
              const rows = [
                ['Metric', 'Value'],
                ['Cumulative Return', `${run.metrics.cumulativeReturnPct}%`],
                ['Sharpe', `${run.metrics.sharpe}`],
                ['Sortino', `${run.metrics.sortino}`],
                ['Calmar', `${run.metrics.calmar}`],
                ['Max Drawdown', `${run.metrics.maxDrawdownPct}%`],
                ['Profit Factor', `${run.metrics.profitFactor}`],
                ['Win Rate', `${run.metrics.winRatePct}%`],
                ['Total Trades', `${run.metrics.totalTrades}`],
                ['Total Fees', `$${run.metrics.totalFeesUsd}`],
              ];
              const csv = rows.map((r) => r.join(',')).join('\n');
              const blob = new Blob([csv], { type: 'text/csv' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = `audit-${run.id}.csv`;
              a.click();
              URL.revokeObjectURL(url);
            }}
          >
            Audit Sheet
          </Button>
          <Button
            variant="primary"
            size="micro"
            icon="play_arrow"
            onClick={() => strategyId && runBacktest.mutate({ id: strategyId, range })}
            disabled={runBacktest.isPending || !strategyId}
          >
            {runBacktest.isPending ? 'Simulating…' : 'Re-Run Sim'}
          </Button>
        </div>
      </div>

      {strategies.length === 0 ? (
        <Card>
          <div className="flex flex-col items-center justify-center gap-space-md py-space-xl text-center">
            <Icon name="auto_awesome" size={32} className="text-on-surface-variant/60" />
            <p className="font-headline-sm text-headline-sm text-on-surface">No strategies yet</p>
            <p className="font-body-sm text-body-sm text-on-surface-variant max-w-sm">
              Create a strategy in the Strategy IDE to start backtesting. Strategies are validated against the grammar
              and can be deployed to the fleet.
            </p>
            <Button
              variant="primary"
              icon="add"
              onClick={() => {
                navigate('/strategy-ide');
              }}
            >
              Open Strategy IDE
            </Button>
          </div>
        </Card>
      ) : null}

      {notice ? (
        <p className="font-body-sm text-body-sm text-on-surface-variant p-space-sm rounded-xl bg-surface-container flex items-center gap-2">
          <Icon name="info" size={16} className="text-primary" />
          {notice}
        </p>
      ) : null}

      {runBacktest.isError ? (
        <ErrorState
          message="The backtest engine rejected this configuration"
          detail="Check the strategy source in the Strategy IDE — unsupported constructs cannot be interpreted."
          onRetry={() => strategyId && runBacktest.mutate({ id: strategyId, range })}
        />
      ) : null}

      {/* ------------------------------ metric cards ----------------------- */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-space-md">
        {!metrics ? (
          Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="h-[150px]" />)
        ) : (
          <>
            <Metric
              label="Total Cumulative Return"
              value={formatPct(metrics.cumulativeReturnPct, { signed: false })}
              tone={toneFor(metrics.cumulativeReturnPct)}
              icon="trending_up"
              footer={
                <>
                  <Chip tone={metrics.alphaVsBenchmarkPct >= 0 ? 'positive' : 'negative'}>
                    {formatPct(metrics.alphaVsBenchmarkPct)} Alpha
                  </Chip>
                  <MicroLabel className="ml-auto">
                    vs {metrics.benchmarkLabel}: {formatPct(metrics.benchmarkReturnPct, { signed: false })}
                  </MicroLabel>
                </>
              }
            />
            <Metric
              label="Sharpe Ratio"
              value={metrics.sharpe.toFixed(2)}
              icon="balance"
              footer={
                <>
                  <Chip tone="primary">{metrics.sharpeTier}</Chip>
                  <MicroLabel className="ml-auto">
                    Sortino {metrics.sortino.toFixed(2)} • Calmar {metrics.calmar.toFixed(1)}
                  </MicroLabel>
                </>
              }
            />
            <Metric
              label="Max Drawdown"
              value={formatPct(metrics.maxDrawdownPct, { signed: false })}
              tone="negative"
              icon="vertical_align_bottom"
              footer={
                <>
                  <Chip tone="neutral">Peak {metrics.maxDrawdownPeakLabel}</Chip>
                  <MicroLabel className="ml-auto">{metrics.maxDrawdownRecoveryDays}d to recover</MicroLabel>
                </>
              }
            />
            <Metric
              label="Profit Factor"
              value={metrics.profitFactor.toFixed(2)}
              icon="verified"
              footer={
                <>
                  <Chip tone="positive">{metrics.winRatePct.toFixed(1)}% Win Rate</Chip>
                  <MicroLabel className="ml-auto">
                    {formatUsd(metrics.grossGainsUsd, { compact: true })} /{' '}
                    {formatUsd(metrics.grossLossesUsd, { compact: true })}
                  </MicroLabel>
                </>
              }
            />
          </>
        )}
      </div>

      {/* -------------------------------- insights ------------------------- */}
      <Card>
        <CardHeader
          title="Quant AI Insights"
          icon="auto_awesome"
          subtitle="Each suggestion is measured by re-running the same engine with the proposed parameters."
          trailing={
            <Chip tone={insights.some((insight) => insight.status === 'applied') ? 'positive' : 'primary'}>
              {insights.filter((insight) => insight.status === 'available').length} Enhancements Available
            </Chip>
          }
        />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-space-md">
          {insights.length === 0 ? (
            Array.from({ length: 3 }, (_, index) => <Skeleton key={index} className="h-40" />)
          ) : (
            insights.map((insight) => (
              <div
                key={insight.id}
                className={clsx(
                  'p-space-md rounded-xl bg-surface-container flex flex-col justify-between gap-space-md border',
                  insight.status === 'applied' ? 'border-secondary/40' : 'border-transparent',
                )}
              >
                <div>
                  <div className="flex items-start justify-between gap-space-sm">
                    <span className="font-label-caption text-label-caption text-on-surface-variant uppercase tracking-wider">
                      {insight.category}
                    </span>
                    <Chip tone={insight.impactTone === 'positive' ? 'positive' : insight.impactTone === 'warning' ? 'negative' : 'neutral'}>
                      {insight.impactLabel}
                    </Chip>
                  </div>
                  <h3 className="font-headline-sm text-headline-sm text-on-surface font-medium mt-1">{insight.title}</h3>
                  <p className="font-body-sm text-body-sm text-on-surface-variant mt-1">{insight.description}</p>
                </div>

                <div className="space-y-space-sm">
                  <div className="flex items-baseline justify-between">
                    <MicroLabel>{insight.headlineMetricLabel}</MicroLabel>
                    <span className="font-label-numeric-md text-label-numeric-md text-primary">
                      {insight.headlineMetricValue}
                    </span>
                  </div>
                  {insight.appliedResult ? (
                    <div className="flex items-center justify-between p-space-sm rounded-lg bg-surface-container-lowest">
                      <MicroLabel>{insight.appliedResult.metric}</MicroLabel>
                      <span className="font-label-numeric-sm text-label-numeric-sm text-on-surface-variant">
                        {insight.appliedResult.before}{' '}
                        <Icon name="arrow_forward" size={12} className="align-middle text-on-surface-variant" />{' '}
                        <span className="text-secondary">{insight.appliedResult.after}</span>
                      </span>
                    </div>
                  ) : null}

                  <Button
                    variant={insight.status === 'applied' ? 'ghost' : 'neutral'}
                    size="micro"
                    icon={insight.status === 'applied' ? 'check' : 'bolt'}
                    className="w-full"
                    disabled={insight.status === 'applied' || applyInsight.isPending || !run}
                    onClick={() => run && applyInsight.mutate({ runId: run.id, insightId: insight.id })}
                  >
                    {insight.status === 'applied' ? 'Applied' : applyInsight.isPending ? 'Applying…' : 'Apply'}
                  </Button>
                </div>
              </div>
            ))
          )}
        </div>
      </Card>

      {/* ------------------------------ equity chart ---------------------- */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-space-lg items-start">
        <Card className="xl:col-span-8">
          <CardHeader
            title="Cumulative Portfolio Equity"
            icon="show_chart"
            trailing={<span className="font-label-caption text-label-caption text-on-surface-variant">{run?.rangeLabel ?? ''}</span>}
          />
          {series ? (
            <EquityChart
              strategy={series.strategy}
              benchmark={series.benchmark}
              drawdown={series.drawdown}
              highlightedIndex={hoverIndex}
              onHover={setHoverIndex}
            />
          ) : (
            <Skeleton className="h-[300px]" />
          )}
        </Card>

        <div className="xl:col-span-4 grid grid-cols-2 gap-space-md">
          <Card>
            <MicroLabel>Total Trades</MicroLabel>
            <p className="font-headline-lg text-headline-lg text-on-surface font-semibold mt-1">
              {metrics?.totalTrades ?? '—'}
            </p>
            <p className="font-body-sm text-body-sm text-on-surface-variant">
              Avg {metrics?.tradesPerWeek.toFixed(1) ?? '—'}/wk
            </p>
          </Card>
          <Card>
            <MicroLabel>Avg Trade Return</MicroLabel>
            <p
              className={clsx(
                'font-headline-lg text-headline-lg font-semibold mt-1',
                (metrics?.avgTradeReturnPct ?? 0) >= 0 ? 'text-secondary' : 'text-tertiary-container',
              )}
            >
              {metrics ? formatPct(metrics.avgTradeReturnPct) : '—'}
            </p>
            <p className="font-body-sm text-body-sm text-on-surface-variant">per completed trade</p>
          </Card>
          <Card>
            <MicroLabel>Payoff Ratio</MicroLabel>
            <p className="font-headline-lg text-headline-lg text-on-surface font-semibold mt-1">
              {metrics ? `${metrics.payoffRatio.toFixed(2)}:1` : '—'}
            </p>
            <p className="font-body-sm text-body-sm text-on-surface-variant">average win / average loss</p>
          </Card>
          <Card>
            <MicroLabel>Slippage Impact</MicroLabel>
            <p className="font-headline-lg text-headline-lg text-tertiary-container font-semibold mt-1">
              {metrics ? `${metrics.slippageImpactPct.toFixed(2)}%` : '—'}
            </p>
            <p className="font-body-sm text-body-sm text-on-surface-variant">
              fees {metrics ? formatUsd(metrics.totalFeesUsd, { compact: true }) : '—'} aggregate
            </p>
          </Card>
        </div>
      </div>

      {/* -------------------------------- copilot ------------------------- */}
      <Card>
        <CardHeader
          title="Conversational Deep-Dive"
          icon="forum"
          trailing={
            run ? (
              <span className="font-label-caption text-label-caption text-on-surface-variant">
                Grounded on run {run.id.slice(0, 14)}
              </span>
            ) : null
          }
        />

        <div className="flex flex-col gap-space-sm">
          <div className="flex flex-wrap gap-space-sm">
            {SUGGESTED_QUERIES.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                onClick={() => setQuestion(suggestion)}
                className="px-space-md py-1.5 rounded-xl bg-surface-container hover:bg-surface-variant font-body-sm text-body-sm text-on-surface-variant hover:text-on-surface transition-colors text-left"
              >
                {suggestion}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-space-sm">
            <Icon name="auto_awesome" className="text-primary" />
            <input
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && question.trim().length > 0 && strategyId && !ask.isPending) {
                  ask.mutate(question.trim());
                }
              }}
              aria-label="Ask the quant copilot"
              placeholder="Query the model on drawdowns, fee sensitivity, regime behaviour..."
              className="flex-1 px-space-md py-2 rounded-xl bg-surface-container-lowest border-hairline text-body-sm font-body-sm text-on-surface placeholder:text-on-surface-variant/50 focus:outline-none focus:ring-1 focus:ring-primary-container"
            />
            <Button
              variant="primary"
              icon="arrow_forward"
              onClick={() => question.trim().length > 0 && strategyId && ask.mutate(question.trim())}
              disabled={ask.isPending || question.trim().length === 0}
            >
              {ask.isPending ? 'Computing…' : 'Query'}
            </Button>
          </div>

          {turns.length === 0 && !ask.isPending ? (
            <p className="font-body-sm text-body-sm text-on-surface-variant">
              Answers are computed from the stored run: the fee-sensitivity question performs a genuine re-simulation
              rather than rescaling an existing figure.
            </p>
          ) : null}

          <div className="space-y-space-sm" data-testid="copilot-log">
            {turns.map((turn) => (
              <div key={turn.id} className="p-space-md rounded-xl bg-surface-container-lowest border-hairline">
                <div className="flex items-center justify-between gap-space-sm mb-space-sm">
                  <div className="flex items-center gap-space-sm">
                    <Icon name="psychology" size={16} className="text-primary" />
                    <span className="font-headline-sm text-headline-sm text-on-surface">Quant Copilot Analysis</span>
                  </div>
                  <div className="flex items-center gap-space-sm">
                    <Chip>{turn.intent.replace('_', ' ')}</Chip>
                    <span className="font-label-caption text-label-caption text-on-surface-variant">
                      Computed in {formatMs(turn.computeMs)}
                    </span>
                  </div>
                </div>
                <p className="font-body-sm text-body-sm text-on-surface-variant mb-space-sm">“{turn.question}”</p>
                <p className="font-body-md text-body-md text-on-surface leading-relaxed">{turn.answer}</p>
                <div className="flex flex-wrap items-center gap-space-sm mt-space-sm pt-space-sm border-t border-hairline">
                  <MicroLabel>Grounded on</MicroLabel>
                  {turn.groundedOn.map((source) => (
                    <Chip key={source}>{source}</Chip>
                  ))}
                </div>
              </div>
            ))}
            {ask.isPending ? (
              <div className="flex items-center gap-space-sm p-space-md rounded-xl bg-surface-container-lowest">
                <Icon name="progress_activity" className="text-primary animate-spin" />
                <span className="font-body-sm text-body-sm text-on-surface-variant">
                  Decompiling model weight tensors and cross-referencing order flow telemetry…
                </span>
              </div>
            ) : null}
          </div>
        </div>
      </Card>
    </div>
  );
}
