import { describe, expect, it } from 'vitest';

import { parseStrategy } from '../src/strategy/grammar.ts';

const SOURCE = `import kinetix.algo as kx
from kinetix.signals import BollingerBands, RSI

@kx.strategy(symbol="BTC-USDT", interval="15m")
class MomentumTrendStrategy(kx.BaseStrategy):
    def on_init(self):
        self.bands = BollingerBands(period=50, sigma=2.4)
        self.rsi = RSI(period=14)

    def on_candle(self, candle: kx.Candle):
        # Evaluate breakout conditions against the upper band
        if candle.close > self.bands.upper and self.rsi > 62.0:
            self.order_target_percent(
                target=0.10,
                stop_loss_pct=0.015,
                tag="Breakout_Long"
            )
        elif candle.close < self.bands.basis:
            self.close_position()
`;

describe('strategy grammar', () => {
  it('extracts interpretable rules from a valid strategy', () => {
    const parsed = parseStrategy(SOURCE);
    expect(parsed.ok).toBe(true);
    expect(parsed.astSynced).toBe(true);
    expect(parsed.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);

    expect(parsed.rules.className).toBe('MomentumTrendStrategy');
    expect(parsed.rules.declaredSymbol).toBe('BTC-USDT');
    expect(parsed.rules.declaredInterval).toBe('15m');
    expect(parsed.rules.indicators.bands).toEqual({ period: 50, sigma: 2.4 });
    expect(parsed.rules.indicators.rsi).toEqual({ period: 14 });
    expect(parsed.rules.entry).toEqual({ operator: '>', comparator: 'upper', rsiGate: { operator: '>', value: 62 } });
    expect(parsed.rules.exit).toEqual({ operator: '<', comparator: 'basis' });
    expect(parsed.rules.order).toEqual({ target: 0.1, stopLossPct: 0.015, tag: 'Breakout_Long' });
  });

  it('reports the features it did and did not consume', () => {
    const parsed = parseStrategy(SOURCE);
    expect(parsed.supportedFeatures).toContain('BollingerBands(period, sigma)');
    expect(parsed.supportedFeatures).toContain('RSI(period)');
    expect(parsed.supportedFeatures).toContain('order_target_percent(target, stop_loss_pct, tag)');
    expect(parsed.unsupportedFeatures).toEqual([]);
  });

  it('is reproducible and measured', () => {
    expect(parseStrategy(SOURCE).rules).toEqual(parseStrategy(SOURCE).rules);
    expect(parseStrategy(SOURCE).compiledInMs).toBeGreaterThanOrEqual(0);
  });

  it('refuses an empty file', () => {
    const parsed = parseStrategy('   \n');
    expect(parsed.ok).toBe(false);
    expect(parsed.astSynced).toBe(false);
    expect(parsed.diagnostics[0]?.message).toMatch(/empty/i);
  });

  it('catches unbalanced brackets before anything else', () => {
    const broken = parseStrategy(`${SOURCE}\nself.extra = (1 + 2\n`);
    expect(broken.ok).toBe(false);
    expect(broken.diagnostics.some((diagnostic) => /Unbalanced '\('/.test(diagnostic.message))).toBe(true);
  });

  it('requires the runtime import and the base class', () => {
    const noImport = parseStrategy(SOURCE.replace('import kinetix.algo as kx\n', ''));
    expect(noImport.ok).toBe(false);
    expect(noImport.diagnostics.some((diagnostic) => /import kinetix\.algo as kx/.test(diagnostic.message))).toBe(true);

    const noClass = parseStrategy(SOURCE.replace('(kx.BaseStrategy)', ''));
    expect(noClass.ok).toBe(false);
    expect(noClass.diagnostics.some((diagnostic) => /No strategy class found/.test(diagnostic.message))).toBe(true);
  });

  it('rejects constructs the sandbox will not run, with a line number', () => {
    const parsed = parseStrategy(`${SOURCE}\n    def on_tick(self):\n        import subprocess\n`);
    expect(parsed.ok).toBe(false);
    const offending = parsed.diagnostics.find((diagnostic) => /subprocess/.test(diagnostic.message));
    expect(offending).toBeDefined();
    expect(offending?.severity).toBe('error');
    expect(offending?.line).toBeGreaterThan(1);
    expect(parsed.unsupportedFeatures).toContain('subprocess');
  });

  it('surfaces an unknown indicator instead of silently ignoring it', () => {
    const parsed = parseStrategy(`${SOURCE}\n        self.macd = Macd(period=12)\n`);
    expect(parsed.unsupportedFeatures).toContain('Macd');
    expect(parsed.diagnostics.some((diagnostic) => /Macd/.test(diagnostic.message))).toBe(true);
  });

  it('flags a band reference with no band indicator configured', () => {
    const parsed = parseStrategy(SOURCE.replace('        self.bands = BollingerBands(period=50, sigma=2.4)\n', ''));
    expect(parsed.ok).toBe(false);
    expect(parsed.diagnostics.some((diagnostic) => /self\.bands.*no BollingerBands/.test(diagnostic.message))).toBe(true);
  });

  it('warns rather than fails when the exit is expressed as close_position()', () => {
    const parsed = parseStrategy(SOURCE.replace('elif candle.close < self.bands.basis:', 'else:'));
    expect(parsed.ok).toBe(true);
    expect(parsed.supportedFeatures).toContain('close_position()');
  });

  it('parses EMA crossover strategy with RSI filter and 100 EMA trend filter', () => {
    const emaSource = `import kinetix.algo as kx

@kx.strategy(symbol="RELIANCE", interval="15m")
class EmaCrossRsiFilterStrategy(kx.BaseStrategy):
    def on_init(self):
        self.ema_fast = kx.EMA(period=9)
        self.ema_slow = kx.EMA(period=21)
        self.ema_trend = kx.EMA(period=100)
        self.rsi = kx.RSI(period=14)

    def on_candle(self, candle: kx.Candle):
        if self.ema_fast > self.ema_slow and self.rsi > 60 and candle.close > self.ema_trend:
            self.order_target_percent(target=0.10, stop_loss_pct=1.5, tag="EMA_Cross_Long")
        elif self.ema_fast < self.ema_slow and self.rsi < 40 and candle.close < self.ema_trend:
            self.order_target_percent(target=-0.10, stop_loss_pct=1.5, tag="EMA_Cross_Short")
`;
    const parsed = parseStrategy(emaSource);
    expect(parsed.ok).toBe(true);
    expect(parsed.astSynced).toBe(true);
    expect(parsed.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(parsed.rules.indicators.emas).toEqual([
      { name: 'ema_fast', period: 9 },
      { name: 'ema_slow', period: 21 },
      { name: 'ema_trend', period: 100 },
    ]);
    expect(parsed.rules.indicators.rsi).toEqual({ period: 14 });
    expect(parsed.rules.emaRule?.entry).toEqual({
      fastEma: 'ema_fast',
      slowEma: 'ema_slow',
      operator: '>',
      trendEma: 'ema_trend',
      trendOperator: '>',
      rsiGate: { operator: '>', value: 60 },
    });
    expect(parsed.rules.emaRule?.exit).toEqual({
      fastEma: 'ema_fast',
      slowEma: 'ema_slow',
      operator: '<',
      trendEma: 'ema_trend',
      trendOperator: '<',
      rsiGate: { operator: '<', value: 40 },
      closePosition: false,
    });
    expect(parsed.rules.order).toEqual({ target: 0.1, stopLossPct: 1.5, tag: 'EMA_Cross_Long' });
    expect(parsed.rules.sellOrder).toEqual({ target: -0.1, stopLossPct: 1.5, tag: 'EMA_Cross_Short' });
  });
});
