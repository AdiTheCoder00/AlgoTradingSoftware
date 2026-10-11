import clsx from 'clsx';
import { useId, useMemo } from 'react';

import type { EquityPoint } from '@kinetix/shared';
import { formatPct } from '@kinetix/shared';

/* ============================================================================
 * Hand-drawn SVG charts.
 *
 * The mockups' equity curve, drawdown fill and gauges are deliberate geometry:
 * no gridlines, three or four faint horizontal rules, one accent line. Building
 * them directly keeps that restraint instead of inheriting a charting library's
 * chrome.
 * ==========================================================================*/

function pathFrom(points: readonly EquityPoint[], width: number, height: number, min: number, max: number): string {
  if (points.length === 0) return '';
  const span = max - min || 1;
  return points
    .map((point, index) => {
      const x = (index / Math.max(1, points.length - 1)) * width;
      const y = height - ((point.v - min) / span) * height;
      return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(' ');
}

export interface EquityChartProps {
  strategy: EquityPoint[];
  benchmark: EquityPoint[];
  drawdown: EquityPoint[];
  height?: number;
  onHover?: (index: number | null) => void;
  highlightedIndex?: number | null;
}

/** Cumulative return (%) area chart with a benchmark line and drawdown fill. */
export function EquityChart({
  strategy,
  benchmark,
  drawdown,
  height = 300,
  onHover,
  highlightedIndex = null,
}: EquityChartProps) {
  const gradientId = useId().replace(/:/g, '');
  const width = 1000;

  const { min, max, hover } = useMemo(() => {
    const values = [...strategy.map((point) => point.v), ...benchmark.map((point) => point.v), 0];
    const lowest = Math.min(...values);
    const highest = Math.max(...values);
    const padding = (highest - lowest) * 0.08 || 1;
    return {
      min: lowest - padding,
      max: highest + padding,
      hover: highlightedIndex !== null && highlightedIndex >= 0 ? strategy[highlightedIndex] ?? null : null,
    };
  }, [strategy, benchmark, highlightedIndex]);

  const strategyPath = pathFrom(strategy, width, height, min, max);
  const benchmarkPath = pathFrom(benchmark, width, height, min, max);
  const filled = `${strategyPath} L ${width} ${height} L 0 ${height} Z`;

  // Drawdown is drawn from the top of the plot downward, as a filled excursion.
  const drawdownPath =
    drawdown.length > 0
      ? `${drawdown
          .map((point, index) => {
            const x = (index / Math.max(1, drawdown.length - 1)) * width;
            const depth = Math.min(1, Math.abs(point.v) / 25);
            return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${(depth * height).toFixed(2)}`;
          })
          .join(' ')} L ${width} ${0} L 0 0 Z`
      : '';

  const gridValues = [0.25, 0.5, 0.75];
  const tickIndices = useMemo(() => {
    if (strategy.length === 0) return [];
    const count = Math.min(6, strategy.length);
    return Array.from({ length: count }, (_, index) =>
      Math.round((index / Math.max(1, count - 1)) * (strategy.length - 1)),
    );
  }, [strategy]);

  return (
    <div className="relative w-full" style={{ height }}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="w-full h-full overflow-visible"
        role="img"
        aria-label="Cumulative portfolio equity against benchmark"
        onMouseLeave={() => onHover?.(null)}
        onMouseMove={(event) => {
          if (!onHover || strategy.length === 0) return;
          const rect = event.currentTarget.getBoundingClientRect();
          const ratio = (event.clientX - rect.left) / Math.max(1, rect.width);
          const index = Math.max(0, Math.min(strategy.length - 1, Math.round(ratio * (strategy.length - 1))));
          onHover(index);
        }}
      >
        <defs>
          <linearGradient id={`equity-${gradientId}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-primary)" stopOpacity="0.28" />
            <stop offset="100%" stopColor="var(--color-primary)" stopOpacity="0" />
          </linearGradient>
          <linearGradient id={`dd-${gradientId}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-tertiary-container)" stopOpacity="0.22" />
            <stop offset="100%" stopColor="var(--color-tertiary-container)" stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {gridValues.map((value) => (
          <line
            key={value}
            x1="0"
            x2={width}
            y1={height * value}
            y2={height * value}
            stroke="var(--color-surface-variant)"
            strokeOpacity="0.25"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        ))}

        {drawdownPath ? <path d={drawdownPath} fill={`url(#dd-${gradientId})`} /> : null}

        <path d={filled} fill={`url(#equity-${gradientId})`} />
        <path
          d={benchmarkPath}
          fill="none"
          stroke="var(--color-on-surface-variant)"
          strokeOpacity="0.5"
          strokeWidth="1.5"
          strokeDasharray="5 4"
          vectorEffect="non-scaling-stroke"
        />
        <path
          d={strategyPath}
          fill="none"
          stroke="var(--color-primary)"
          strokeWidth="2.5"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />

        {hover ? (
          <g>
            <line
              x1={(highlightedIndex! / Math.max(1, strategy.length - 1)) * width}
              x2={(highlightedIndex! / Math.max(1, strategy.length - 1)) * width}
              y1="0"
              y2={height}
              stroke="var(--color-primary)"
              strokeOpacity="0.4"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
            <circle
              cx={(highlightedIndex! / Math.max(1, strategy.length - 1)) * width}
              cy={height - ((hover.v - min) / (max - min || 1)) * height}
              r="4"
              fill="var(--color-primary-container)"
            />
          </g>
        ) : null}
      </svg>

      <div className="flex items-center justify-between mt-space-md">
        {tickIndices.map((index) => {
          const point = strategy[index];
          if (!point) return null;
          return (
            <span key={index} className="font-label-numeric-sm text-label-numeric-sm text-on-surface-variant">
              {new Date(point.t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })}
            </span>
          );
        })}
      </div>

      <div className="flex items-center gap-space-lg mt-space-sm">
        <span className="flex items-center gap-1.5 font-label-caption text-label-caption text-on-surface-variant">
          <span className="w-4 h-0.5 rounded bg-primary" /> Strategy
        </span>
        <span className="flex items-center gap-1.5 font-label-caption text-label-caption text-on-surface-variant">
          <span className="w-4 h-0.5 rounded bg-on-surface-variant/50" /> Benchmark
        </span>
        <span className="flex items-center gap-1.5 font-label-caption text-label-caption text-on-surface-variant">
          <span className="w-4 h-2 rounded-sm bg-tertiary-container/20" /> Drawdown area
        </span>
      </div>

      {hover ? (
        <div
          className="absolute top-2 right-2 px-space-md py-2 rounded-xl bg-surface-container-lowest border border-primary/25 shadow-flyout pointer-events-none"
          role="status"
        >
          <p className="font-label-caption text-label-caption text-on-surface-variant uppercase tracking-wider mb-1">
            {new Date(hover.t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
          </p>
          <p className="font-label-numeric-sm text-label-numeric-sm text-on-surface">
            Strategy: <span className="text-primary">{formatPct(hover.v)}</span>
          </p>
          {benchmark[highlightedIndex ?? 0] ? (
            <p className="font-label-numeric-sm text-label-numeric-sm text-on-surface-variant">
              Benchmark: {formatPct(benchmark[highlightedIndex ?? 0]?.v ?? 0)}
            </p>
          ) : null}
          {drawdown[highlightedIndex ?? 0] ? (
            <p className="font-label-numeric-sm text-label-numeric-sm text-on-surface-variant">
              DD: {formatPct(drawdown[highlightedIndex ?? 0]?.v ?? 0)}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function Sparkline({
  points,
  tone = 'positive',
  width = 120,
  height = 32,
}: {
  points: number[];
  tone?: 'positive' | 'negative';
  width?: number;
  height?: number;
}) {
  if (points.length < 2) return null;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const normalized: EquityPoint[] = points.map((value, index) => ({ t: index, v: value }));
  const path = pathFrom(normalized, width, height, min, max || min + 1);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-8" preserveAspectRatio="none" aria-hidden="true">
      <path
        d={path}
        fill="none"
        stroke={tone === 'positive' ? 'var(--color-secondary)' : 'var(--color-tertiary-container)'}
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/** Margin-utilisation donut with the threshold cap marked on the ring. */
export function MarginDonut({
  usedPct,
  capPct,
}: {
  usedPct: number;
  capPct: number;
}) {
  const radius = 62;
  const circumference = 2 * Math.PI * radius;
  const safeRatio = Math.max(0, Math.min(1, usedPct / 100));
  const capRatio = Math.max(0, Math.min(1, capPct / 100));
  // A breach is the only state that earns the crimson accent.
  const breaching = usedPct >= capPct;

  return (
    <svg viewBox="0 0 160 160" className="w-full max-w-[180px]" role="img" aria-label={`Margin utilisation ${usedPct.toFixed(1)} percent of a ${capPct} percent cap`}>
      <circle cx="80" cy="80" r={radius} fill="none" stroke="var(--color-surface-variant)" strokeOpacity="0.45" strokeWidth="12" />
      <circle
        cx="80"
        cy="80"
        r={radius}
        fill="none"
        stroke={breaching ? 'var(--color-tertiary-container)' : 'var(--color-primary-container)'}
        strokeWidth="12"
        strokeLinecap="round"
        strokeDasharray={`${(safeRatio * circumference).toFixed(2)} ${circumference.toFixed(2)}`}
        transform="rotate(-90 80 80)"
      />
      <circle
        cx="80"
        cy="80"
        r={radius}
        fill="none"
        stroke="var(--color-outline)"
        strokeWidth="2"
        strokeDasharray={`2 ${circumference.toFixed(2)}`}
        transform={`rotate(${-90 + capRatio * 360} 80 80)`}
      />
      <text
        x="80"
        y="74"
        textAnchor="middle"
        fill="var(--color-on-surface)"
        style={{ font: '600 26px "JetBrains Mono Variable", monospace' }}
      >
        {usedPct.toFixed(1)}%
      </text>
      <text
        x="80"
        y="94"
        textAnchor="middle"
        fill="var(--color-on-surface-variant)"
        style={{ font: '500 10px "Inter Variable", sans-serif', letterSpacing: '0.06em' }}
      >
        MARGIN UTILIZED
      </text>
      <text
        x="80"
        y="112"
        textAnchor="middle"
        fill={breaching ? 'var(--color-tertiary-container)' : 'var(--color-secondary)'}
        style={{ font: '400 11px "JetBrains Mono Variable", monospace' }}
      >
        cap {capPct.toFixed(1)}%
      </text>
    </svg>
  );
}

/** Signal-confidence histogram, with the active entry threshold emphasised. */
export function ConfidenceHistogram({
  bins,
  entryLabel,
}: {
  bins: Array<{ binLabel: string; count: number }>;
  entryLabel: string;
}) {
  const max = bins.reduce((acc, bin) => Math.max(acc, bin.count), 0) || 1;

  return (
    <div className="flex items-end justify-between gap-1 h-24" role="img" aria-label="Signal distribution by sigma">
      {bins.map((bin) => {
        const isEntry = bin.binLabel === entryLabel;
        const height = Math.max(4, (bin.count / max) * 100);
        return (
          <div key={bin.binLabel} className="flex-1 flex flex-col items-center gap-1.5 justify-end h-full">
            <div
              className={clsx('w-full rounded-sm transition-all', isEntry ? 'bg-primary' : 'bg-surface-variant/70')}
              style={{ height: `${height}%` }}
              title={`${bin.binLabel}: ${bin.count} bars`}
            />
            <span
              className={clsx(
                'font-label-numeric-sm text-label-numeric-sm whitespace-nowrap',
                isEntry ? 'text-primary' : 'text-on-surface-variant/70',
              )}
            >
              {bin.binLabel}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function LatencyBars({ venues }: { venues: Array<{ id: string; latencyMs: number; status: string }> }) {
  const max = Math.max(...venues.map((venue) => venue.latencyMs), 1);

  return (
    <div className="space-y-space-md">
      {venues.map((venue) => (
        <div key={venue.id} className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="font-body-sm text-body-sm text-on-surface-variant">{venue.id}</span>
            <span
              className={clsx(
                'font-label-numeric-sm text-label-numeric-sm',
                venue.status === 'optimal'
                  ? 'text-secondary'
                  : venue.status === 'good'
                    ? 'text-on-surface-variant'
                    : 'text-tertiary-container',
              )}
            >
              {venue.latencyMs.toFixed(1)}ms
            </span>
          </div>
          <div className="h-1 rounded-full bg-surface-variant/50 overflow-hidden">
            <div
              className={clsx(
                'h-full rounded-full',
                venue.latencyMs <= 6 ? 'bg-secondary' : venue.latencyMs <= 20 ? 'bg-primary' : 'bg-tertiary-container',
              )}
              style={{ width: `${Math.max(4, (venue.latencyMs / max) * 100)}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Circular risk gauge used for drawdown against its threshold. */
export function RiskRing({ value, threshold, label }: { value: number; threshold: number; label: string }) {
  const ratio = Math.max(0, Math.min(1, value / Math.max(0.0001, threshold)));
  const radius = 26;
  const circumference = 2 * Math.PI * radius;

  return (
    <div className="flex items-center gap-space-md">
      <svg viewBox="0 0 64 64" className="w-16 h-16 shrink-0" role="img" aria-label={`${label}: ${value.toFixed(2)} percent`}>
        <circle cx="32" cy="32" r={radius} fill="none" stroke="var(--color-surface-variant)" strokeOpacity="0.5" strokeWidth="6" />
        <circle
          cx="32"
          cy="32"
          r={radius}
          fill="none"
          stroke={ratio > 0.8 ? 'var(--color-tertiary-container)' : 'var(--color-secondary)'}
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={`${(ratio * circumference).toFixed(2)} ${circumference.toFixed(2)}`}
          transform="rotate(-90 32 32)"
        />
      </svg>
      <div>
        <p className="font-label-numeric-md text-label-numeric-md text-on-surface">{value.toFixed(2)}%</p>
        <p className="font-label-caption text-label-caption text-on-surface-variant uppercase tracking-wider">{label}</p>
      </div>
    </div>
  );
}
