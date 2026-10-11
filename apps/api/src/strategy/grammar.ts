import type { Diagnostic } from '@kinetix/shared';

/* ============================================================================
 * Strategy grammar.
 *
 * The IDE presents editable Python. Rather than pretending to execute arbitrary
 * code (which would mean shipping a sandbox we cannot secure here), edits are
 * parsed against a deliberately small, well-defined grammar and interpreted by
 * the TypeScript engine. Anything outside the grammar is reported to the
 * operator as unsupported with a line number — never silently ignored.
 * ==========================================================================*/

export interface EmaIndicator {
  name: string;
  period: number;
}

export interface IndicatorSet {
  bands: { period: number; sigma: number } | null;
  rsi: { period: number } | null;
  emas: EmaIndicator[];
}

export interface EmaStrategyRule {
  entry: {
    fastEma: string;
    slowEma: string;
    operator: '>' | '<';
    trendEma: string | null;
    trendOperator: '>' | '<' | null;
    rsiGate: { operator: '>' | '<'; value: number } | null;
  };
  exit: {
    fastEma?: string;
    slowEma?: string;
    operator?: '>' | '<';
    trendEma?: string | null;
    trendOperator?: '>' | '<' | null;
    rsiGate?: { operator: '>' | '<'; value: number } | null;
    closePosition?: boolean;
  } | null;
}

export interface ParsedRules {
  className: string | null;
  declaredSymbol: string | null;
  declaredInterval: string | null;
  indicators: IndicatorSet;
  entry: {
    comparator: 'upper' | 'lower' | 'basis';
    operator: '>' | '<';
    rsiGate: { operator: '>' | '<'; value: number } | null;
  } | null;
  exit: { comparator: 'upper' | 'lower' | 'basis'; operator: '>' | '<' } | null;
  order: { target: number; stopLossPct: number; tag: string } | null;
  sellOrder?: { target: number; stopLossPct: number; tag: string } | null;
  emaRule?: EmaStrategyRule | null;
}

export interface ParseResult {
  ok: boolean;
  astSynced: boolean;
  diagnostics: Diagnostic[];
  supportedFeatures: string[];
  unsupportedFeatures: string[];
  rules: ParsedRules;
  compiledInMs: number;
}

/** Constructs the engine will refuse to interpret even syntactically. */
const FORBIDDEN = [
  { pattern: /\bsubprocess\b/, label: 'subprocess', reason: 'process execution is not available in the sandbox' },
  { pattern: /\b(exec|eval)\s*\(/, label: 'exec()/eval()', reason: 'dynamic evaluation is not supported' },
  { pattern: /__[a-zA-Z_]+__/, label: 'dunder access', reason: 'reflection into the runtime is not supported' },
  { pattern: /\b(open|socket|requests)\s*\(/, label: 'I/O access', reason: 'network and file access are not supported' },
  { pattern: /\b(import\s+pandas|import\s+numpy|from\s+pandas|from\s+numpy)/, label: 'pandas/numpy import', reason: 'vector libraries are not part of this grammar' },
  { pattern: /\b(lambda|try:|except\s|finally:)\b/, label: 'lambda / try-except', reason: 'only straight-line signal logic is supported' },
];

/** Control flow that the interpreter has no notion of yet. */
const UNSUPPORTED_CONTROL = [
  { pattern: /^\s*for\s+/m, label: 'for loop' },
  { pattern: /^\s*while\s+/m, label: 'while loop' },
  { pattern: /\bglobal\s+/, label: 'global statement' },
  { pattern: /\bclass\s+\w+\s*\(\s*(?!kx\.BaseStrategy)/, label: 'auxiliary class' },
];

const KNOWN_INDICATORS = ['BollingerBands', 'RSI', 'EMA'];

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

function checkBalance(source: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const pairs: Array<[string, string]> = [
    ['(', ')'],
    ['[', ']'],
    ['{', '}'],
  ];

  for (const [open, close] of pairs) {
    let depth = 0;
    let lastOpenLine = 1;
    for (let i = 0; i < source.length; i += 1) {
      const char = source[i];
      if (char === '#') {
        // Skip comments so parentheses inside prose do not unbalance the file.
        while (i < source.length && source[i] !== '\n') i += 1;
        continue;
      }
      if (char === open) {
        depth += 1;
        lastOpenLine = lineOf(source, i);
      } else if (char === close) {
        depth -= 1;
        if (depth < 0) {
          diagnostics.push({
            line: lineOf(source, i),
            column: 1,
            severity: 'error',
            message: `Unbalanced '${close}' — no matching '${open}'`,
          });
          depth = 0;
        }
      }
    }
    if (depth > 0) {
      diagnostics.push({
        line: lastOpenLine,
        column: 1,
        severity: 'error',
        message: `Unbalanced '${open}' — ${depth} unclosed group(s)`,
      });
    }
  }
  return diagnostics;
}

export function parseStrategy(source: string): ParseResult {
  const startedAt = performance.now();
  const diagnostics: Diagnostic[] = [];
  const supportedFeatures: string[] = [];
  const unsupportedFeatures: string[] = [];

  const rules: ParsedRules = {
    className: null,
    declaredSymbol: null,
    declaredInterval: null,
    indicators: { bands: null, rsi: null, emas: [] },
    entry: null,
    exit: null,
    order: null,
    sellOrder: null,
    emaRule: null,
  };

  if (source.trim().length === 0) {
    diagnostics.push({ line: 1, column: 1, severity: 'error', message: 'Strategy source is empty' });
    return finish(false, diagnostics, supportedFeatures, unsupportedFeatures, rules, startedAt);
  }

  diagnostics.push(...checkBalance(source));

  // --- structural requirements -------------------------------------------------
  if (!/import\s+kinetix\.algo\s+as\s+kx/.test(source)) {
    diagnostics.push({
      line: 1,
      column: 1,
      severity: 'error',
      message: "Missing 'import kinetix.algo as kx' — the strategy must import the runtime",
    });
  } else {
    supportedFeatures.push('import kinetix.algo as kx');
  }

  const classMatch = /class\s+(\w+)\s*\(\s*kx\.BaseStrategy\s*\)/.exec(source);
  if (!classMatch) {
    diagnostics.push({
      line: 1,
      column: 1,
      severity: 'error',
      message: 'No strategy class found — expected `class X(kx.BaseStrategy)`',
    });
  } else {
    rules.className = classMatch[1] ?? null;
  }

  const decorator = /@kx\.strategy\(\s*symbol="([^"]+)"\s*,\s*interval="([^"]+)"/.exec(source);
  if (decorator) {
    rules.declaredSymbol = decorator[1] ?? null;
    rules.declaredInterval = decorator[2] ?? null;
    supportedFeatures.push('@kx.strategy(symbol, interval)');
  } else {
    diagnostics.push({
      line: 1,
      column: 1,
      severity: 'warning',
      message: 'No @kx.strategy decorator — the bot will use the instrument configured on the strategy record',
    });
  }

  for (const method of ['on_init', 'on_candle']) {
    if (!new RegExp(`def\\s+${method}\\s*\\(`).test(source)) {
      diagnostics.push({
        line: 1,
        column: 1,
        severity: 'error',
        message: `Missing required method \`${method}\``,
      });
    }
  }

  // --- indicators -------------------------------------------------------------
  const bandsMatch = /BollingerBands\s*\(\s*period\s*=\s*(\d+)\s*,\s*sigma\s*=\s*([\d.]+)\s*\)/.exec(source);
  if (bandsMatch) {
    rules.indicators.bands = { period: Number(bandsMatch[1]), sigma: Number(bandsMatch[2]) };
    supportedFeatures.push('BollingerBands(period, sigma)');
    if (rules.indicators.bands.period < 2) {
      diagnostics.push({
        line: lineOf(source, bandsMatch.index),
        column: 1,
        severity: 'error',
        message: 'BollingerBands period must be at least 2',
      });
    }
  }

  const rsiMatch = /RSI\s*\(\s*period\s*=\s*(\d+)\s*\)/.exec(source);
  if (rsiMatch) {
    rules.indicators.rsi = { period: Number(rsiMatch[1]) };
    supportedFeatures.push('RSI(period)');
  }

  // EMA indicators
  const emaMatches = [...source.matchAll(/(?:self\.)?(\w+)\s*=\s*(?:kx\.)?EMA\s*\(\s*period\s*=\s*(\d+)\s*\)/g)];
  for (const match of emaMatches) {
    const name = match[1] ?? '';
    const period = Number(match[2]);
    rules.indicators.emas.push({ name, period });
    if (period < 2) {
      diagnostics.push({
        line: lineOf(source, match.index ?? 0),
        column: 1,
        severity: 'error',
        message: `EMA '${name}' period must be at least 2`,
      });
    }
  }
  if (rules.indicators.emas.length > 0) {
    supportedFeatures.push(`EMA(${rules.indicators.emas.map((e) => `${e.name}=${e.period}`).join(', ')})`);
  }

  // Any indicator-shaped call the grammar does not implement is surfaced rather
  // than assumed away.
  const calledIndicators = [...source.matchAll(/\b([A-Z][A-Za-z0-9_]+)\s*\(/g)]
    // `class MomentumTrendStrategy(kx.BaseStrategy)` reads exactly like a call,
    // so the class header has to be excluded or every strategy would report its
    // own name as an unknown indicator. Also exclude comments.
    .filter((match) => {
      const index = match.index ?? 0;
      const lineStart = source.lastIndexOf('\n', index) + 1;
      const linePrefix = source.slice(lineStart, index);
      if (linePrefix.includes('#')) return false;
      return !/\bclass\s+$/.test(linePrefix);
    })
    .map((match) => match[1] ?? '')
    .filter((name) => name.length > 0 && !KNOWN_INDICATORS.includes(name));
  for (const name of new Set(calledIndicators)) {
    if (name === 'BollingerBands' || name === 'RSI' || name === 'EMA') continue;
    unsupportedFeatures.push(name);
    diagnostics.push({
      line: 1,
      column: 1,
      severity: 'warning',
      message: `\`${name}\` is not a supported indicator in this grammar — it will be ignored by the backtest`,
    });
  }

  // --- entry condition --------------------------------------------------------
  const entryMatch =
    /if\s+candle\.close\s*([<>])\s*self\.bands\.(upper|lower|basis)(?:\s+and\s+self\.rsi\s*([<>])\s*([\d.]+))?/.exec(source);
  if (entryMatch) {
    const operator = entryMatch[1] as '>' | '<';
    const comparator = entryMatch[2] as 'upper' | 'lower' | 'basis';
    const rsiOperator = entryMatch[3] as '>' | '<' | undefined;
    const rsiValue = entryMatch[4] !== undefined ? Number(entryMatch[4]) : null;
    rules.entry = {
      operator,
      comparator,
      rsiGate: rsiOperator !== undefined && rsiValue !== null ? { operator: rsiOperator, value: rsiValue } : null,
    };
    supportedFeatures.push('entry: candle.close vs bands + optional RSI gate');
    if (rules.indicators.bands === null) {
      diagnostics.push({
        line: lineOf(source, entryMatch.index),
        column: 1,
        severity: 'error',
        message: 'Entry condition references `self.bands` but no BollingerBands indicator is configured',
      });
    }
    if (rules.entry.rsiGate && rules.indicators.rsi === null) {
      diagnostics.push({
        line: lineOf(source, entryMatch.index),
        column: 1,
        severity: 'error',
        message: 'Entry condition references `self.rsi` but no RSI indicator is configured',
      });
    }
  } else {
    // Check for EMA crossover condition
    const ifMatch = /if\s+([^\n:]+):/.exec(source);
    if (ifMatch && rules.indicators.emas.length >= 2) {
      const condText = ifMatch[1] ?? '';
      const emaCompMatch = /self\.(\w+)\s*([><])\s*self\.(\w+)/.exec(condText);
      const trendMatch = /candle\.close\s*([><])\s*self\.(\w+)/.exec(condText);
      const rsiCondMatch = /self\.rsi(?:\.value)?\s*([><])\s*([\d.]+)/.exec(condText);

      if (emaCompMatch) {
        const fastEma = emaCompMatch[1] ?? '';
        const operator = (emaCompMatch[2] ?? '>') as '>' | '<';
        const slowEma = emaCompMatch[3] ?? '';
        const trendOperator = trendMatch ? ((trendMatch[1] ?? '>') as '>' | '<') : null;
        const trendEma = trendMatch ? (trendMatch[2] ?? null) : null;
        const rsiGate = rsiCondMatch
          ? { operator: (rsiCondMatch[1] ?? '>') as '>' | '<', value: Number(rsiCondMatch[2]) }
          : null;

        rules.emaRule = {
          entry: {
            fastEma,
            slowEma,
            operator,
            trendEma,
            trendOperator,
            rsiGate,
          },
          exit: null,
        };
        supportedFeatures.push('entry: EMA cross + RSI gate + EMA trend filter');
      }
    }

    if (!rules.entry && !rules.emaRule) {
      diagnostics.push({
        line: 1,
        column: 1,
        severity: 'error',
        message: 'No supported entry condition found — expected `if candle.close > self.bands.upper` or `if self.ema_fast > self.ema_slow`',
      });
    }
  }

  // --- exit condition ---------------------------------------------------------
  const exitMatch = /elif\s+candle\.close\s*([<>])\s*self\.bands\.(upper|lower|basis)/.exec(source);
  if (exitMatch) {
    rules.exit = { operator: exitMatch[1] as '>' | '<', comparator: exitMatch[2] as 'upper' | 'lower' | 'basis' };
    supportedFeatures.push('exit: candle.close vs bands');
  } else if (rules.emaRule) {
    const elifMatch = /elif\s+([^\n:]+):/.exec(source);
    if (elifMatch) {
      const condText = elifMatch[1] ?? '';
      const emaCompMatch = /self\.(\w+)\s*([><])\s*self\.(\w+)/.exec(condText);
      const trendMatch = /candle\.close\s*([><])\s*self\.(\w+)/.exec(condText);
      const rsiCondMatch = /self\.rsi(?:\.value)?\s*([><])\s*([\d.]+)/.exec(condText);

      rules.emaRule.exit = {
        fastEma: emaCompMatch ? emaCompMatch[1] : undefined,
        slowEma: emaCompMatch ? emaCompMatch[3] : undefined,
        operator: emaCompMatch ? ((emaCompMatch[2] ?? '<') as '>' | '<') : undefined,
        trendEma: trendMatch ? (trendMatch[2] ?? null) : null,
        trendOperator: trendMatch ? ((trendMatch[1] ?? '<') as '>' | '<') : null,
        rsiGate: rsiCondMatch
          ? { operator: (rsiCondMatch[1] ?? '<') as '>' | '<', value: Number(rsiCondMatch[2]) }
          : null,
        closePosition: /close_position/.test(source),
      };
      supportedFeatures.push('exit: EMA crossunder + sell filters');
    } else if (/def\s+close_position/.test(source) || /self\.close_position\(\)/.test(source)) {
      rules.emaRule.exit = { closePosition: true };
      supportedFeatures.push('close_position()');
    }
  } else if (/def\s+close_position/.test(source) || /self\.close_position\(\)/.test(source)) {
    supportedFeatures.push('close_position()');
  } else {
    diagnostics.push({
      line: 1,
      column: 1,
      severity: 'warning',
      message: 'No exit condition found — positions will only close on the stop loss',
    });
  }

  // --- order call -------------------------------------------------------------
  const orderMatches = [
    ...source.matchAll(/order_target_percent\(\s*target\s*=\s*([-\d.]+)\s*,\s*stop_loss_pct\s*=\s*([\d.]+)\s*,\s*tag\s*=\s*"([^"]+)"/g),
  ];
  if (orderMatches.length > 0 && orderMatches[0]) {
    rules.order = {
      target: Number(orderMatches[0][1]),
      stopLossPct: Number(orderMatches[0][2]),
      tag: orderMatches[0][3] ?? '',
    };
    if (orderMatches.length > 1 && orderMatches[1]) {
      rules.sellOrder = {
        target: Number(orderMatches[1][1]),
        stopLossPct: Number(orderMatches[1][2]),
        tag: orderMatches[1][3] ?? '',
      };
    }
    supportedFeatures.push('order_target_percent(target, stop_loss_pct, tag)');
  } else {
    diagnostics.push({
      line: 1,
      column: 1,
      severity: 'error',
      message: 'No supported order call — expected order_target_percent(target=, stop_loss_pct=, tag=)',
    });
  }

  // --- rejections -------------------------------------------------------------
  for (const rule of FORBIDDEN) {
    const match = rule.pattern.exec(source);
    if (!match) continue;
    unsupportedFeatures.push(rule.label);
    diagnostics.push({
      line: lineOf(source, match.index),
      column: 1,
      severity: 'error',
      message: `Unsupported: ${rule.label} — ${rule.reason}`,
    });
  }

  for (const rule of UNSUPPORTED_CONTROL) {
    const match = rule.pattern.exec(source);
    if (!match) continue;
    unsupportedFeatures.push(rule.label);
    diagnostics.push({
      line: lineOf(source, match.index),
      column: 1,
      severity: 'warning',
      message: `${rule.label} is not interpreted by the backtest engine — it will be ignored`,
    });
  }

  const hasError = diagnostics.some((diagnostic) => diagnostic.severity === 'error');
  const isBandsInterpretable = rules.entry !== null && rules.order !== null && rules.indicators.bands !== null;
  const isEmaInterpretable =
    rules.emaRule?.entry !== null &&
    rules.emaRule !== null &&
    rules.indicators.emas.length >= 2 &&
    rules.order !== null;
  const interpretable = isBandsInterpretable || isEmaInterpretable;

  return finish(!hasError && interpretable, diagnostics, supportedFeatures, unsupportedFeatures, rules, startedAt);
}

function finish(
  ok: boolean,
  diagnostics: Diagnostic[],
  supportedFeatures: string[],
  unsupportedFeatures: string[],
  rules: ParsedRules,
  startedAt: number,
): ParseResult {
  return {
    ok,
    // "Realtime AST synced" is claimed only when the file both parses cleanly
    // and yields rules the engine can actually interpret.
    astSynced: ok,
    diagnostics,
    supportedFeatures,
    unsupportedFeatures,
    rules,
    compiledInMs: Number((performance.now() - startedAt).toFixed(3)),
  };
}
