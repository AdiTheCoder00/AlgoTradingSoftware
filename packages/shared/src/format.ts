/* ============================================================================
 * Numeric formatting shared by the API (copilot prose, log lines) and the web
 * terminal (metric cards, tables, chart labels). Keeping this in one place is
 * what makes a P&L figure render identically in a card and in a sentence.
 * ==========================================================================*/

export interface FormatOptions {
  /** Force a leading + on positive values (P&L, deltas). */
  signed?: boolean;
  /** Decimal places. */
  decimals?: number;
  /** Render sub-thousand values with full precision instead of compacting. */
  compact?: boolean;
}

const MINUS = '\u2212'; // typographic minus, matches the design's numeric styling

function group(value: string): string {
  const [whole, fraction] = value.split('.');
  const sign = whole?.startsWith('-') ? '-' : '';
  const digits = (whole ?? '').replace('-', '');
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction === undefined ? `${sign}${grouped}` : `${sign}${grouped}.${fraction}`;
}

/** `4821940.5` -> `$4,821,940` (or `$4.82M` when compact). */
export function formatUsd(value: number, options: FormatOptions = {}): string {
  const { signed = false, decimals = 0, compact = false } = options;
  if (!Number.isFinite(value)) return '—';

  const abs = Math.abs(value);
  const sign = value < 0 ? MINUS : signed ? '+' : '';

  if (compact) {
    // Lowercase `k` matches the design mockups' own abbreviated figures ("$284.1k").
    if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(2)}B`;
    if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
    if (abs >= 10_000) return `${sign}$${(abs / 1_000).toFixed(1)}k`;
  }

  return `${sign}$${group(abs.toFixed(decimals))}`;
}

/** `4.18` -> `+4.18%`, `-1.68` -> `−1.68%` */
export function formatPct(value: number, options: FormatOptions = {}): string {
  const { signed = true, decimals = 2 } = options;
  if (!Number.isFinite(value)) return '—';
  const sign = value < 0 ? MINUS : signed ? '+' : '';
  return `${sign}${Math.abs(value).toFixed(decimals)}%`;
}

/** Plain grouped number with fixed decimals. */
export function formatNumber(value: number, decimals = 2): string {
  if (!Number.isFinite(value)) return '—';
  const sign = value < 0 ? MINUS : '';
  return `${sign}${group(Math.abs(value).toFixed(decimals))}`;
}

/** Price with tick-appropriate precision: `91420.5` -> `91,420.50`. */
export function formatPrice(value: number, decimals = 2): string {
  if (!Number.isFinite(value)) return '—';
  return group(value.toFixed(decimals));
}

/** `2373` -> `2,373` — order book sizes and quantities. */
export function formatQty(value: number, decimals = 3): string {
  if (!Number.isFinite(value)) return '—';
  const trimmed = Number(value.toFixed(decimals));
  return group(trimmed.toString());
}

/** Sub-second durations: `0.184` -> `184ms`, `3.2` -> `3.2s`. */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Latency readouts in the header and footer: `42000` -> `42µs`. */
export function formatMicros(micros: number): string {
  if (!Number.isFinite(micros)) return '—';
  if (micros < 1000) return `${micros.toFixed(micros < 10 ? 1 : 0)}µs`;
  return formatMs(micros / 1000);
}

/** `2023-10-14` for chart annotations. */
export function formatDateShort(epochMs: number): string {
  const d = new Date(epochMs);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** `08:44:12` for console log prefixes and order book timestamps. */
export function formatClock(epochMs: number): string {
  const d = new Date(epochMs);
  return d.toLocaleTimeString('en-GB', { hour12: false });
}

/** `08:44:12.102` for the execution console. */
export function formatClockMillis(epochMs: number): string {
  const d = new Date(epochMs);
  const base = d.toLocaleTimeString('en-GB', { hour12: false });
  return `${base}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

/** Sign of a P&L value, for choosing the emerald / crimson tone. */
export function toneFor(value: number): 'positive' | 'negative' | 'neutral' {
  if (value > 0) return 'positive';
  if (value < 0) return 'negative';
  return 'neutral';
}

/** `+$142,890` for the header fleet P&L pill. */
export function formatSignedUsd(value: number): string {
  return formatUsd(value, { signed: true, decimals: 0 });
}
