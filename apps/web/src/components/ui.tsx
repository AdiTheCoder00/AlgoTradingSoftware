import clsx from 'clsx';
import type { ReactNode } from 'react';

/* ============================================================================
 * UI kit.
 *
 * Small composable pieces carrying the design system's rules: hairline
 * perimeters instead of heavy borders, generous card padding, tabular numerals
 * for anything dynamic, and semantic colour that never shouts.
 * ==========================================================================*/

export function Card({
  children,
  className,
  padded = true,
}: {
  children: ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <div
      className={clsx(
        'bg-surface-container-low rounded-xl shadow-card border-hairline',
        padded && 'p-space-lg',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  icon,
  trailing,
  subtitle,
}: {
  title: string;
  icon?: string;
  trailing?: ReactNode;
  subtitle?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-space-md mb-space-md">
      <div className="flex items-center gap-space-sm min-w-0">
        {icon ? <Icon name={icon} className="text-primary" /> : null}
        <div className="min-w-0">
          <h2 className="font-headline-sm text-headline-sm font-semibold text-on-surface truncate">{title}</h2>
          {subtitle ? (
            <p className="font-label-caption text-label-caption text-on-surface-variant mt-0.5">{subtitle}</p>
          ) : null}
        </div>
      </div>
      {trailing ? <div className="flex items-center gap-space-sm shrink-0">{trailing}</div> : null}
    </div>
  );
}

export function Icon({
  name,
  size = 18,
  className,
  filled = false,
}: {
  name: string;
  size?: number;
  className?: string;
  filled?: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      className={clsx('material-symbols-outlined shrink-0', className)}
      style={{ fontSize: `${size}px`, ...(filled ? { fontVariationSettings: "'FILL' 1" } : {}) }}
    >
      {name}
    </span>
  );
}

/** Uppercase micro-label used above every metric. */
export function MicroLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={clsx(
        'font-label-caption text-label-caption text-on-surface-variant uppercase tracking-wider',
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Chip({
  children,
  tone = 'neutral',
  className,
  icon,
}: {
  children: ReactNode;
  tone?: 'positive' | 'negative' | 'neutral' | 'primary';
  className?: string;
  icon?: string;
}) {
  const tones = {
    positive: 'bg-secondary/10 text-secondary',
    negative: 'bg-tertiary-container/10 text-tertiary-container',
    neutral: 'bg-surface-variant/40 text-on-surface-variant',
    primary: 'bg-primary/10 text-primary',
  } as const;

  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 px-2 py-0.5 rounded font-label-numeric-sm text-label-numeric-sm',
        tones[tone],
        className,
      )}
    >
      {icon ? <Icon name={icon} size={14} /> : null}
      {children}
    </span>
  );
}

export function Button({
  children,
  onClick,
  variant = 'neutral',
  icon,
  size = 'default',
  disabled,
  type = 'button',
  className,
  title,
}: {
  children?: ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'secondary' | 'neutral' | 'danger' | 'ghost';
  icon?: string;
  size?: 'default' | 'micro' | 'lg';
  disabled?: boolean;
  type?: 'button' | 'submit';
  className?: string;
  title?: string;
}) {
  const variants = {
    primary: 'bg-primary text-on-primary hover:brightness-105',
    secondary: 'bg-secondary text-on-secondary hover:brightness-105 font-semibold',
    neutral: 'bg-surface-container hover:bg-surface-variant text-on-surface',
    danger: 'bg-error-container/40 hover:bg-error-container text-error',
    ghost: 'text-on-surface-variant hover:text-on-surface hover:bg-surface-container',
  } as const;

  const sizes = {
    micro: 'h-7 px-space-sm text-label-caption font-label-caption',
    default: 'h-9 px-space-md text-body-sm font-body-sm',
    lg: 'h-10 px-space-lg text-body-md font-body-md',
  } as const;

  return (
    <button
      type={type}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={clsx(
        'inline-flex items-center justify-center gap-1.5 rounded-xl transition-all duration-100 whitespace-nowrap',
        variants[variant],
        sizes[size],
        disabled && 'opacity-45 cursor-not-allowed hover:brightness-100',
        className,
      )}
    >
      {icon ? <Icon name={icon} size={size === 'micro' ? 14 : 16} /> : null}
      {children}
    </button>
  );
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: readonly T[];
  value: T;
  onChange: (next: T) => void;
  ariaLabel: string;
}) {
  return (
    <div role="tablist" aria-label={ariaLabel} className="inline-flex p-1 bg-surface-container rounded-xl">
      {options.map((option) => (
        <button
          key={option}
          type="button"
          role="tab"
          aria-selected={option === value}
          onClick={() => onChange(option)}
          className={clsx(
            'px-3 py-1 rounded-lg font-body-sm text-body-sm transition-colors',
            option === value
              ? 'bg-surface-variant text-on-surface font-medium'
              : 'text-on-surface-variant hover:text-on-surface',
          )}
        >
          {option}
        </button>
      ))}
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx(
        'relative w-9 h-5 rounded-full transition-colors shrink-0',
        checked ? 'bg-secondary-container' : 'bg-surface-variant',
        disabled && 'opacity-45 cursor-not-allowed',
      )}
    >
      <span
        className={clsx(
          'absolute top-0.5 w-4 h-4 rounded-full transition-transform',
          checked ? 'translate-x-[18px] bg-on-secondary' : 'translate-x-0.5 bg-on-surface-variant',
        )}
      />
    </button>
  );
}

export function Slider({
  value,
  min,
  max,
  step,
  onChange,
  ariaLabel,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (next: number) => void;
  ariaLabel: string;
}) {
  const percent = max > min ? ((value - min) / (max - min)) * 100 : 0;
  return (
    <div className="relative w-full">
      <div className="absolute top-1/2 left-0 right-0 h-1 -translate-y-1/2 rounded-full bg-surface-variant/60 overflow-hidden">
        <div className="h-full bg-primary rounded-full" style={{ width: `${percent}%` }} />
      </div>
      <input
        type="range"
        aria-label={ariaLabel}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="relative w-full h-4 appearance-none bg-transparent cursor-pointer
          [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5
          [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary [&::-webkit-slider-thumb]:border-2
          [&::-webkit-slider-thumb]:border-surface-container-low [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:h-3.5
          [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-primary [&::-moz-range-thumb]:border-0"
      />
    </div>
  );
}

export function Modal({
  open,
  onClose,
  children,
  labelledBy,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  labelledBy: string;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-space-md">
      <div
        className="absolute inset-0 bg-surface-container-lowest/80 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        className="relative bg-surface-container-high border-hairline-strong rounded-xl shadow-flyout max-w-md w-full p-space-lg"
      >
        {children}
      </div>
    </div>
  );
}

export function LiveDot({ tone = 'positive', animate = true }: { tone?: 'positive' | 'negative' | 'neutral'; animate?: boolean }) {
  const colors = {
    positive: 'bg-secondary',
    negative: 'bg-error',
    neutral: 'bg-on-surface-variant',
  } as const;

  return (
    <span className="relative flex h-2 w-2 shrink-0">
      {animate ? (
        <span className={clsx('animate-ping absolute inline-flex h-full w-full rounded-full opacity-75', colors[tone])} />
      ) : null}
      <span className={clsx('relative inline-flex rounded-full h-2 w-2', colors[tone])} />
    </span>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={clsx('animate-pulse rounded-lg bg-surface-variant/40', className)} />;
}

export function EmptyState({ icon, title, description }: { icon: string; title: string; description?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-space-sm py-space-xl text-center">
      <Icon name={icon} size={28} className="text-on-surface-variant/60" />
      <p className="font-body-md text-body-md text-on-surface">{title}</p>
      {description ? (
        <p className="font-body-sm text-body-sm text-on-surface-variant max-w-sm">{description}</p>
      ) : null}
    </div>
  );
}

export function ErrorState({ message, detail, onRetry }: { message: string; detail?: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-start gap-space-sm p-space-md rounded-xl bg-error-container/20 border border-error/25">
      <div className="flex items-center gap-space-sm">
        <Icon name="error" className="text-error" />
        <span className="font-body-sm text-body-sm text-error font-medium">{message}</span>
      </div>
      {detail ? <p className="font-body-sm text-body-sm text-on-surface-variant">{detail}</p> : null}
      {onRetry ? (
        <Button variant="neutral" size="micro" icon="refresh" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}

/**
 * Depth visualisation behind an order-book row. `ratio` is the level's size
 * relative to the deepest level on that side, so every ladder reads the same.
 */
export function DepthBar({ ratio, tone }: { ratio: number; tone: 'ask' | 'bid' }) {
  return (
    <div
      aria-hidden="true"
      className={clsx('absolute inset-y-0 right-0 rounded', tone === 'ask' ? 'bg-tertiary-container/10' : 'bg-secondary/10')}
      style={{ width: `${Math.max(2, Math.min(100, ratio * 100))}%` }}
    />
  );
}

export function Metric({
  label,
  value,
  unit,
  tone = 'neutral',
  icon,
  footer,
  valueClassName,
}: {
  label: string;
  value: string;
  unit?: string;
  tone?: 'positive' | 'negative' | 'neutral';
  icon?: string;
  footer?: ReactNode;
  valueClassName?: string;
}) {
  const valueTone = {
    positive: 'text-secondary',
    negative: 'text-tertiary-container',
    neutral: 'text-on-surface',
  } as const;

  return (
    <Card className="relative overflow-hidden group hover:bg-surface-container transition-all">
      <div className="flex items-center justify-between mb-space-md">
        <MicroLabel>{label}</MicroLabel>
        {icon ? (
          <div className="w-7 h-7 rounded-lg bg-surface-variant/50 flex items-center justify-center">
            <Icon name={icon} className="text-primary" />
          </div>
        ) : null}
      </div>
      <div className="flex items-baseline gap-space-sm mb-space-sm">
        <span
          className={clsx(
            'font-headline-xl text-headline-xl tracking-tight font-semibold',
            valueTone[tone],
            valueClassName,
          )}
        >
          {value}
        </span>
        {unit ? <span className="font-label-numeric-sm text-label-numeric-sm text-on-surface-variant">{unit}</span> : null}
      </div>
      {footer ? <div className="flex items-center gap-space-sm">{footer}</div> : null}
    </Card>
  );
}
