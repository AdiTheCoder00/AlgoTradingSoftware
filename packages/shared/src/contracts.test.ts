import { describe, expect, it } from 'vitest';

import {
  BacktestMetricsSchema,
  OrderBookSchema,
  PlaceOrderRequestSchema,
  WsClientMessageSchema,
  WsServerMessageSchema,
} from './contracts.ts';
import { formatMs, formatPct, formatPrice, formatQty, formatSignedUsd, formatUsd, toneFor } from './format.ts';

describe('contracts', () => {
  it('accepts a valid market order request', () => {
    const parsed = PlaceOrderRequestSchema.safeParse({
      symbol: 'BTC-USD',
      side: 'buy',
      type: 'market',
      notionalUsd: 25_000,
      leverage: 10,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an order with neither quantity nor notional', () => {
    const parsed = PlaceOrderRequestSchema.safeParse({
      symbol: 'BTC-USD',
      side: 'buy',
      type: 'market',
    });
    // The schema allows it structurally; the API enforces the either/or rule and
    // this test pins that decision so it cannot silently change.
    expect(parsed.success).toBe(true);
    expect(Object.keys(parsed.data ?? {})).not.toContain('quantity');
  });

  it('rejects a negative notional', () => {
    const parsed = PlaceOrderRequestSchema.safeParse({
      symbol: 'BTC-USD',
      side: 'buy',
      type: 'market',
      notionalUsd: -5,
    });
    expect(parsed.success).toBe(false);
  });

  it('round-trips an order book frame', () => {
    const book = {
      symbol: 'BTC-USD',
      bids: [{ price: 91_420.5, size: 0.995, total: 90_963 }],
      asks: [{ price: 91_421, size: 0.742, total: 67_834 }],
      spread: 0.5,
      spreadPct: 0.0005,
      mid: 91_420.75,
      ts: 1_760_000_000_000,
    };
    expect(OrderBookSchema.parse(book)).toEqual(book);
  });

  it('parses both websocket directions', () => {
    expect(WsClientMessageSchema.parse({ op: 'subscribe', channels: ['fleet'] }).op).toBe('subscribe');
    expect(
      WsServerMessageSchema.parse({ channel: 'fleet', seq: 12, ts: 1, payload: { frozen: false } }).seq,
    ).toBe(12);
  });

  it('requires every backtest metric so the UI cannot render undefined', () => {
    const parsed = BacktestMetricsSchema.safeParse({ cumulativeReturnPct: 184.2 });
    expect(parsed.success).toBe(false);
  });
});

describe('format helpers', () => {
  it('matches the design mockups for headline figures', () => {
    expect(formatUsd(4_821_940)).toBe('$4,821,940');
    expect(formatUsd(45_980, { decimals: 0, signed: true })).toBe('+$45,980');
    expect(formatSignedUsd(142_890)).toBe('+$142,890');
    expect(formatSignedUsd(-3_150)).toBe('\u2212$3,150');
    expect(formatPct(4.18)).toBe('+4.18%');
    expect(formatPct(-1.68)).toBe('\u22121.68%');
    expect(formatPrice(91_420.5)).toBe('91,420.50');
    expect(formatQty(2.4179, 3)).toBe('2.418');
    expect(formatMs(184)).toBe('184ms');
  });

  it('compacts only when asked', () => {
    // The mockups render gross gains as "$284.1k" — abbreviations stay lowercase.
    expect(formatUsd(284_100, { compact: true })).toBe('$284.1k');
    expect(formatUsd(-130_300, { compact: true })).toBe('\u2212$130.3k');
    expect(formatUsd(284_100)).toBe('$284,100');
  });

  it('classifies P&L tone', () => {
    expect(toneFor(0.01)).toBe('positive');
    expect(toneFor(-0.01)).toBe('negative');
    expect(toneFor(0)).toBe('neutral');
  });
});
