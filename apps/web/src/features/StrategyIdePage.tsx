import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { python } from '@codemirror/lang-python';
import clsx from 'clsx';

import { formatClockMillis } from '@kinetix/shared';
import type { ConsoleLog, StrategyParam } from '@kinetix/shared';

import { ConfidenceHistogram } from '../components/charts.tsx';
import {
  Button,
  Card,
  CardHeader,
  Chip,
  EmptyState,
  ErrorState,
  Icon,
  Slider,
  Skeleton,
  MicroLabel,
} from '../components/ui.tsx';
import { ApiError, api } from '../lib/api.ts';

/* ============================================================================
 * Strategy IDE.
 *
 * The editor is a real CodeMirror instance over the strategy source; edits are
 * validated by the grammar parser in the API, and only the parameters drive the
 * backtest engine. Diagnostics from the parser are surfaced inline rather than
 * swallowed.
 * ==========================================================================*/

const IDE_THEME = EditorView.theme(
  {
    '&': {
      backgroundColor: 'transparent',
      color: 'var(--color-on-surface)',
      fontSize: '13px',
      fontFamily: '"JetBrains Mono Variable", "JetBrains Mono", monospace',
      height: '100%',
    },
    '.cm-content': { padding: '12px 0', caretColor: 'var(--color-primary)' },
    '.cm-gutters': {
      backgroundColor: 'transparent',
      color: 'var(--color-outline)',
      border: 'none',
      paddingRight: '8px',
    },
    '.cm-activeLine': { backgroundColor: 'rgba(45, 52, 73, 0.25)' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--color-primary)' },
    '.cm-selectionBackground, ::selection': { backgroundColor: 'rgba(56, 189, 248, 0.25) !important' },
    '.cm-cursor': { borderLeftColor: 'var(--color-primary)' },
    '.cm-scroller': { overflow: 'auto', lineHeight: '1.75' },
    '.cm-line': { padding: '0 12px' },
  },
  { dark: true },
);

function CodeEditor({
  value,
  onChange,
  onCursor,
}: {
  value: string;
  onChange: (next: string) => void;
  onCursor: (position: { line: number; column: number }) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onCursorRef = useRef(onCursor);
  onChangeRef.current = onChange;
  onCursorRef.current = onCursor;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    const view = new EditorView({
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          python(),
          IDE_THEME,
          EditorView.lineWrapping,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString());
            if (update.selectionSet || update.docChanged) {
              const head = update.state.selection.main.head;
              const line = update.state.doc.lineAt(head);
              onCursorRef.current({ line: line.number, column: head - line.from + 1 });
            }
          }),
        ],
      }),
      parent: container,
    });

    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Created once: subsequent source changes are pushed in via the effect below
    // so the editor is never recreated (which would drop the cursor).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    // Only replace the document when the incoming value differs — otherwise
    // every keystroke would reset the selection.
    if (view.state.doc.toString() !== value) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
    }
  }, [value]);

  return <div ref={containerRef} className="h-[420px] overflow-hidden" data-testid="strategy-editor" />;
}

export function StrategyIdePage() {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [source, setSource] = useState('');
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error' | 'info'; message: string } | null>(null);
  const [runOutput, setRunOutput] = useState<string | null>(null);
  const [deployInstrument, setDeployInstrument] = useState<string>('');
  const [deployStrategyIds, setDeployStrategyIds] = useState<string[]>([]);

  const strategyParam = searchParams.get('strategy');
  const queryParam = searchParams.get('q')?.trim() ?? '';

  const strategiesQuery = useQuery({ queryKey: ['strategies'], queryFn: api.strategies });
  const strategies = strategiesQuery.data?.strategies ?? [];
  const instrumentsQuery = useQuery({ queryKey: ['instruments'], queryFn: api.instruments, staleTime: 60_000 });

  const displayedStrategies = useMemo(() => {
    if (!queryParam) return strategies;
    const lower = queryParam.toLowerCase();
    return strategies.filter(
      (s) =>
        s.name.toLowerCase().includes(lower) ||
        s.instrument.toLowerCase().includes(lower) ||
        s.id.toLowerCase().includes(lower),
    );
  }, [strategies, queryParam]);

  const selectStrategy = (id: string | null) => {
    setSelectedId(id);
    const nextParams = new URLSearchParams(searchParams);
    if (id) {
      nextParams.set('strategy', id);
    } else {
      nextParams.delete('strategy');
    }
    setSearchParams(nextParams, { replace: true });
  };

  useEffect(() => {
    if (strategies.length === 0) return;
    if (strategyParam) {
      const match = strategies.find((s) => s.id === strategyParam);
      if (match) {
        if (selectedId !== match.id) setSelectedId(match.id);
        return;
      }
    }
    if (queryParam) {
      const lower = queryParam.toLowerCase();
      const match = strategies.find(
        (s) =>
          s.name.toLowerCase().includes(lower) ||
          s.instrument.toLowerCase().includes(lower) ||
          s.id.toLowerCase().includes(lower),
      );
      if (match) {
        if (selectedId !== match.id) setSelectedId(match.id);
        return;
      }
    }
    if (!selectedId) {
      setSelectedId(strategies[0]?.id ?? null);
    }
  }, [strategies, strategyParam, queryParam, selectedId]);

  const detailQuery = useQuery({
    queryKey: ['strategy', selectedId],
    queryFn: () => api.strategy(selectedId as string),
    enabled: selectedId !== null,
  });

  // Load the server's source into the editor when the selection changes.
  useEffect(() => {
    if (detailQuery.data) setSource(detailQuery.data.strategy.source);
  }, [detailQuery.data]);

  const create = useMutation({
    mutationFn: () => api.createStrategy('Untitled Strategy'),
    onSuccess: (result) => {
      setNotice({ tone: 'ok', message: 'Strategy created' });
      void queryClient.invalidateQueries({ queryKey: ['strategies'] });
      selectStrategy(result.strategy.id);
    },
    onError: (error) => setNotice({ tone: 'error', message: error instanceof ApiError ? error.message : 'Create failed' }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteStrategy(id),
    onSuccess: () => {
      setNotice({ tone: 'ok', message: 'Strategy deleted' });
      void queryClient.invalidateQueries({ queryKey: ['strategies'] });
      const remaining = strategiesQuery.data?.strategies.filter((s) => s.id !== selectedId);
      selectStrategy(remaining?.[0]?.id ?? null);
    },
    onError: (error) => setNotice({ tone: 'error', message: error instanceof ApiError ? error.message : 'Delete failed' }),
  });

  const saveSource = useMutation({
    mutationFn: (next: string) => api.updateSource(selectedId as string, next),
    onSuccess: (result) => {
      setNotice({
        tone: result.validation.ok ? 'ok' : 'error',
        message: result.validation.ok
          ? `Syntax validated — ${result.validation.supportedFeatures.length} constructs interpreted`
          : `${result.validation.diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length} error(s) in source`,
      });
      void queryClient.invalidateQueries({ queryKey: ['strategy', selectedId] });
    },
    onError: (error) => setNotice({ tone: 'error', message: error instanceof ApiError ? error.message : 'Save failed' }),
  });

  // Debounced autosave: the header's "Autosaved" indicator reflects a real write.
  useEffect(() => {
    if (!selectedId || !detailQuery.data) return undefined;
    if (source === detailQuery.data.strategy.source) return undefined;
    const timer = window.setTimeout(() => saveSource.mutate(source), 900);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, selectedId, detailQuery.data]);

  const saveParams = useMutation({
    mutationFn: (params: Record<string, number>) => api.updateParams(selectedId as string, params),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['strategy', selectedId] });
      void queryClient.invalidateQueries({ queryKey: ['strategies'] });
    },
  });

  const runBacktest = useMutation({
    mutationFn: () => api.paperRun(selectedId as string),
    onSuccess: (result) => {
      setRunOutput(
        `return ${result.run.metrics.cumulativeReturnPct}% · sharpe ${result.run.metrics.sharpe} · maxDD ${result.run.metrics.maxDrawdownPct}% · ${result.run.metrics.totalTrades} trades`,
      );
      setNotice({ tone: 'ok', message: `Paper run complete in ${result.run.computeMs.toFixed(0)}ms` });
      void queryClient.invalidateQueries({ queryKey: ['strategy', selectedId] });
    },
    onError: (error) => setNotice({ tone: 'error', message: error instanceof ApiError ? error.message : 'Run failed' }),
  });

  const deploy = useMutation({
    mutationFn: () =>
      api.deploy(selectedId as string, {
        ...(deployInstrument ? { instrument: deployInstrument } : {}),
        ...(deployStrategyIds.length > 0 ? { strategyIds: deployStrategyIds } : {}),
      }),
    onSuccess: (result) => {
      setNotice({
        tone: 'ok',
        message: result.created ? `${result.bot.name} provisioned and started` : `${result.bot.name} started`,
      });
      void queryClient.invalidateQueries({ queryKey: ['fleet'] });
      void queryClient.invalidateQueries({ queryKey: ['strategies'] });
    },
    onError: (error) => setNotice({ tone: 'error', message: error instanceof ApiError ? error.message : 'Deploy failed' }),
  });

  const validation = detailQuery.data?.validation ?? null;
  const signals = detailQuery.data?.signals ?? null;
  const strategy = detailQuery.data?.strategy ?? null;

  const parameters: StrategyParam[] = strategy?.params ?? [];
  const logs: ConsoleLog[] = detailQuery.data?.logs ?? [];

  const errorDiagnostics = useMemo(
    () => (validation?.diagnostics ?? []).filter((diagnostic) => diagnostic.severity === 'error'),
    [validation],
  );
  const warningDiagnostics = useMemo(
    () => (validation?.diagnostics ?? []).filter((diagnostic) => diagnostic.severity === 'warning'),
    [validation],
  );

  return (
    <div className="px-gutter-desktop py-space-xl max-w-[1720px] mx-auto w-full space-y-space-lg">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-space-md items-start">
        {/* --------------------------- navigator --------------------------- */}
        <div className="lg:col-span-3 flex flex-col gap-space-md">
          <Card>
            <CardHeader
              title="Strategy Navigator"
              icon="folder_open"
              trailing={
                <Button variant="ghost" size="micro" icon="add" onClick={() => create.mutate()} disabled={create.isPending}>
                  New
                </Button>
              }
            />
            {strategiesQuery.isLoading ? (
              <Skeleton className="h-40" />
            ) : (
              <div className="space-y-1">
                {queryParam ? (
                  <div className="flex items-center justify-between px-space-xs py-1 text-label-caption font-label-caption text-on-surface-variant">
                    <span>Search: &ldquo;{queryParam}&rdquo;</span>
                    <button
                      type="button"
                      onClick={() => {
                        const nextParams = new URLSearchParams(searchParams);
                        nextParams.delete('q');
                        setSearchParams(nextParams, { replace: true });
                      }}
                      className="text-primary hover:underline"
                    >
                      Clear
                    </button>
                  </div>
                ) : null}
                {displayedStrategies.length === 0 ? (
                  <div className="p-space-sm text-center font-body-sm text-body-sm text-on-surface-variant">
                    No matching strategies
                  </div>
                ) : (
                  displayedStrategies.map((candidate) => (
                    <button
                      key={candidate.id}
                      type="button"
                      onClick={() => selectStrategy(candidate.id)}
                      className={clsx(
                        'w-full text-left p-space-sm rounded-xl transition-colors',
                        candidate.id === selectedId
                          ? 'bg-primary/10 border border-primary/25'
                          : 'hover:bg-surface-container border border-transparent',
                      )}
                    >
                    <div className="flex items-center gap-2">
                      <Icon
                        name="terminal"
                        size={16}
                        className={candidate.id === selectedId ? 'text-primary' : 'text-on-surface-variant'}
                      />
                      <span className="font-body-sm text-body-sm text-on-surface truncate">{candidate.name}</span>
                    </div>
                    <p className="font-label-caption text-label-caption text-on-surface-variant ml-6 mt-0.5">
                      {candidate.instrument} • {candidate.timeframe} • {candidate.version}
                    </p>
                    <div className="flex items-center gap-1.5 ml-6 mt-1">
                      <span
                        className={clsx(
                          'w-1.5 h-1.5 rounded-full',
                          candidate.status === 'deployed' ? 'bg-secondary' : candidate.status === 'validated' ? 'bg-primary' : 'bg-on-surface-variant',
                        )}
                      />
                      <span className="font-label-caption text-label-caption text-on-surface-variant">
                        {candidate.status}
                      </span>
                    </div>
                  </button>
                ))
              )}
              </div>
            )}
          </Card>

          <Card>
            <CardHeader title="Signal Confidence" icon="insights" />
            {signals ? (
              <div className="space-y-space-md">
                <div className="flex items-baseline gap-space-sm">
                  <span className="font-headline-xl text-headline-xl text-on-surface font-semibold">
                    {signals.confidencePct.toFixed(1)}%
                  </span>
                  <span
                    className={clsx(
                      'font-label-numeric-sm text-label-numeric-sm',
                      signals.postCalibrationDeltaPct >= 0 ? 'text-secondary' : 'text-tertiary-container',
                    )}
                  >
                    {signals.postCalibrationDeltaPct >= 0 ? '+' : ''}
                    {signals.postCalibrationDeltaPct}% post-calibration
                  </span>
                </div>
                <ConfidenceHistogram
                  bins={signals.histogram}
                  entryLabel={`+${signals.entrySigma.toFixed(1)}\u03c3`}
                />
                <div className="flex items-center justify-between pt-space-sm border-t border-hairline">
                  <MicroLabel>Expected Payoff</MicroLabel>
                  <span className="font-label-numeric-md text-label-numeric-md text-primary">
                    {signals.expectedPayoffR.toFixed(2)} R:R
                  </span>
                </div>
              </div>
            ) : (
              <Skeleton className="h-32" />
            )}
          </Card>

          <Card>
            <CardHeader
              title="Validation"
              icon="verified"
              trailing={
                <Chip tone={validation?.ok ? 'positive' : 'negative'}>
                  {validation ? `${errorDiagnostics.length} Failures` : '—'}
                </Chip>
              }
            />
            <div className="space-y-space-sm">
              <div className="flex items-center justify-between">
                <span className="font-body-sm text-body-sm text-on-surface-variant">Tick latency</span>
                <span className="font-label-numeric-sm text-label-numeric-sm text-secondary">
                  {validation ? `${validation.compiledInMs.toFixed(1)}ms` : '—'}
                </span>
              </div>
              {warningDiagnostics.slice(0, 4).map((diagnostic) => (
                <p key={`${diagnostic.line}-${diagnostic.message}`} className="font-label-numeric-sm text-label-numeric-sm text-primary">
                  Ln {diagnostic.line}: {diagnostic.message}
                </p>
              ))}
              {errorDiagnostics.slice(0, 4).map((diagnostic) => (
                <p key={`${diagnostic.line}-${diagnostic.message}`} className="font-label-numeric-sm text-label-numeric-sm text-error">
                  Ln {diagnostic.line}: {diagnostic.message}
                </p>
              ))}
              {validation && validation.diagnostics.length === 0 ? (
                <p className="font-body-sm text-body-sm text-secondary">
                  Source parses cleanly against every supported construct.
                </p>
              ) : null}
              {validation?.unsupportedFeatures.length ? (
                <div className="pt-space-sm border-t border-hairline">
                  <MicroLabel>Not interpreted</MicroLabel>
                  <p className="font-label-numeric-sm text-label-numeric-sm text-on-surface-variant mt-1">
                    {validation.unsupportedFeatures.join(', ')}
                  </p>
                </div>
              ) : null}
            </div>
          </Card>
        </div>

        {/* ----------------------------- editor ---------------------------- */}
        <div className="lg:col-span-6 flex flex-col gap-space-sm">
          <Card padded={false}>
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-space-sm p-space-md border-b border-hairline">
              <div className="flex items-center gap-space-md min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-headline-sm text-headline-sm text-on-surface truncate">
                    {strategy?.name ?? '—'}
                  </span>
                  <span className="px-2 py-0.5 rounded bg-surface-variant font-label-caption text-label-caption text-on-surface-variant">
                    {strategy?.version ?? ''}
                  </span>
                </div>
                <span className="hidden md:flex items-center gap-1.5 font-label-caption text-label-caption text-on-surface-variant">
                  <Icon name={saveSource.isPending ? 'cloud_sync' : 'cloud_done'} size={14} />
                  {saveSource.isPending ? 'Saving…' : 'Autosaved'}
                </span>
              </div>
              <div className="flex items-center gap-space-sm">
                <Button
                  variant="ghost"
                  size="micro"
                  icon="delete"
                  onClick={() => {
                    if (window.confirm('Are you sure you want to delete this strategy?')) {
                      selectedId && remove.mutate(selectedId);
                    }
                  }}
                  disabled={remove.isPending || !selectedId || selectedId === 'manual'}
                  title="Delete strategy"
                />
                <span
                  className={clsx(
                    'hidden sm:flex items-center gap-1.5 font-label-caption text-label-caption',
                    validation?.ok ? 'text-secondary' : 'text-error',
                  )}
                >
                  <Icon name="verified" size={14} />
                  {validation?.ok ? 'Syntax Validated' : 'Invalid'}
                </span>
                <Button variant="neutral" size="micro" icon="play_arrow" onClick={() => runBacktest.mutate()} disabled={runBacktest.isPending}>
                  Test Run (Paper)
                </Button>
                <Button variant="primary" size="micro" icon="rocket_launch" onClick={() => deploy.mutate()} disabled={deploy.isPending}>
                  Deploy Live
                </Button>
              </div>
            </div>

            {/* Instrument override + multi-strategy selection */}
            <div className="flex flex-wrap items-center gap-space-md px-space-md py-space-sm border-t border-hairline">
                <div className="flex items-center gap-2">
                  <label htmlFor="deploy-instrument" className="font-label-caption text-label-caption text-on-surface-variant">
                    Instrument
                  </label>
                  <select
                    id="deploy-instrument"
                    value={deployInstrument}
                    onChange={(e) => setDeployInstrument(e.target.value)}
                    className="bg-surface-container px-space-sm py-1 rounded-lg font-body-sm text-body-sm text-on-surface focus:outline-none focus:ring-1 focus:ring-primary-container"
                  >
                    <option value="">Strategy default</option>
                    {(instrumentsQuery.data?.instruments ?? []).map((inst) => (
                      <option key={inst.symbol} value={inst.symbol}>{inst.displayName}</option>
                    ))}
                  </select>
                </div>
                <div className="flex items-center gap-2">
                  <label htmlFor="deploy-extra-strategies" className="font-label-caption text-label-caption text-on-surface-variant">
                    Combined strategies
                  </label>
                  <select
                    id="deploy-extra-strategies"
                    multiple
                    value={deployStrategyIds}
                    onChange={(e) => setDeployStrategyIds(Array.from(e.target.selectedOptions, (o) => o.value))}
                    className="bg-surface-container px-space-sm py-1 rounded-lg font-body-sm text-body-sm text-on-surface focus:outline-none focus:ring-1 focus:ring-primary-container"
                    size={3}
                  >
                    {strategies.filter((s) => s.id !== selectedId).map((s) => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                </div>
            </div>

            {detailQuery.isLoading ? (
              <div className="p-space-md">
                <Skeleton className="h-[420px]" />
              </div>
            ) : (
              <CodeEditor value={source} onChange={setSource} onCursor={setCursor} />
            )}

            <div className="flex flex-wrap items-center gap-space-md px-space-md py-space-sm border-t border-hairline">
              <span className="font-label-numeric-sm text-label-numeric-sm text-on-surface-variant">
                Ln {cursor.line}, Col {cursor.column}
              </span>
              <span className="font-label-numeric-sm text-label-numeric-sm text-on-surface-variant">UTF-8</span>
              <span className="font-label-numeric-sm text-label-numeric-sm text-on-surface-variant">Spaces: 4</span>
              <span
                className={clsx(
                  'ml-auto flex items-center gap-1.5 font-label-numeric-sm text-label-numeric-sm',
                  validation?.astSynced ? 'text-secondary' : 'text-tertiary-container',
                )}
              >
                <span className={clsx('w-1.5 h-1.5 rounded-full', validation?.astSynced ? 'bg-secondary' : 'bg-tertiary-container')} />
                {validation?.astSynced ? 'Realtime AST Synced' : 'AST Out of Sync'}
              </span>
            </div>
          </Card>

          {notice ? (
            <div
              role="status"
              className={clsx(
                'p-space-sm rounded-xl font-body-sm text-body-sm flex items-center gap-2',
                notice.tone === 'ok' ? 'bg-secondary/10 text-secondary' : notice.tone === 'error' ? 'bg-error-container/25 text-error' : 'bg-surface-container text-on-surface-variant',
              )}
            >
              <Icon name={notice.tone === 'ok' ? 'check_circle' : notice.tone === 'error' ? 'error' : 'info'} size={16} />
              {notice.message}
            </div>
          ) : null}

          {runOutput ? (
            <p className="font-label-numeric-sm text-label-numeric-sm text-on-surface-variant px-space-md">
              Paper run: {runOutput}
            </p>
          ) : null}

          {/* --------------------------- console --------------------------- */}
          <Card padded={false}>
            <div className="flex items-center justify-between px-space-md py-space-sm border-b border-hairline">
              <div className="flex items-center gap-space-sm">
                <Icon name="terminal" size={16} className="text-primary" />
                <span className="font-headline-sm text-headline-sm text-on-surface">Execution Console</span>
              </div>
              <span className="font-label-caption text-label-caption text-on-surface-variant">
                {logs.length} entries
              </span>
            </div>
            <div className="max-h-48 overflow-y-auto p-space-md space-y-1.5">
              {logs.length === 0 ? (
                <EmptyState icon="terminal" title="No console output yet" description="Validate the source or run a paper backtest." />
              ) : (
                [...logs].reverse().map((log, index) => (
                  <div key={`${log.ts}-${index}`} className="flex items-start gap-space-sm">
                    <span className="font-label-numeric-sm text-label-numeric-sm text-on-surface-variant shrink-0">
                      [{formatClockMillis(log.ts)}]
                    </span>
                    <span
                      className={clsx(
                        'font-label-numeric-sm text-label-numeric-sm shrink-0',
                        log.level === 'success'
                          ? 'text-secondary'
                          : log.level === 'error'
                            ? 'text-error'
                            : log.level === 'warn'
                              ? 'text-primary'
                              : 'text-on-surface-variant',
                      )}
                    >
                      {log.scope}
                    </span>
                    <span className="font-label-numeric-sm text-label-numeric-sm text-on-surface">
                      {log.message}
                      {log.detail ? <span className="text-on-surface-variant"> — {log.detail}</span> : null}
                    </span>
                  </div>
                ))
              )}
            </div>
          </Card>
        </div>

        {/* --------------------------- parameters -------------------------- */}
        <div className="lg:col-span-3 flex flex-col gap-space-md">
          <Card>
            <CardHeader
              title="Visual Parameters"
              icon="tune"
              trailing={
                <Button
                  variant="ghost"
                  size="micro"
                  onClick={() => {
                    const defaults = Object.fromEntries(parameters.map((param) => [param.key, param.defaultValue]));
                    saveParams.mutate(defaults);
                  }}
                >
                  Reset
                </Button>
              }
            />
            {parameters.length === 0 ? (
              <Skeleton className="h-56" />
            ) : (
              <div className="space-y-space-lg">
                {parameters.map((param) => (
                  <div key={param.key}>
                    <div className="flex items-center justify-between mb-space-sm">
                      <label htmlFor={`param-${param.key}`} className="font-body-sm text-body-sm text-on-surface-variant">
                        {param.label}
                      </label>
                      <span className="font-label-numeric-sm text-label-numeric-sm text-on-surface">
                        {param.value} {param.unit}
                      </span>
                    </div>
                    <Slider
                      ariaLabel={param.label}
                      min={param.min}
                      max={param.max}
                      step={param.step}
                      value={param.value}
                      onChange={(value) => {
                        saveParams.mutate({ [param.key]: value });
                      }}
                    />
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card>
            <CardHeader title="Isolated Execution" icon="science" />
            <div className="space-y-space-sm">
              <div className="flex items-center justify-between">
                <span className="font-body-sm text-body-sm text-on-surface-variant">O&amp;MS Latency</span>
                <span className="font-label-numeric-sm text-label-numeric-sm text-secondary">42µs</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="font-body-sm text-body-sm text-on-surface-variant">Kernel</span>
                <span className="font-label-numeric-sm text-label-numeric-sm text-on-surface-variant">
                  gVisor sandbox
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="font-body-sm text-body-sm text-on-surface-variant">Language</span>
                <span className="font-label-numeric-sm text-label-numeric-sm text-on-surface-variant">
                  python 3.11 (grammar subset)
                </span>
              </div>
              {detailQuery.isError ? <ErrorState message="Could not load the strategy" /> : null}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
