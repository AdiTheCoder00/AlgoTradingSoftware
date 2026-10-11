import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, resetDatabase } from '../src/db/db.ts';
import { createPortfolioService, isRejected, type PortfolioService } from '../src/engine/portfolio.ts';
import { createMarketSimulator, type MarketSimulator } from '../src/sim/market.ts';
import { seedPortfolioRow, TEST_BALANCE_USD } from './fixtures.ts';

/* ============================================================================
 * Execution and portfolio accounting.
 *
 * The demo book was removed from the seed, so every case here builds its own:
 * the fixture funds a known balance and opens positions through the real order
 * path, then asserts on arithmetic derived from that book rather than on
 * remembered mockup figures. Cases run against a fresh seeded database per
 * test.
 * ==========================================================================*/

const FIXED_NOW = 1_760_000_000_000;

let market: MarketSimulator;
let portfolio: PortfolioService;

beforeEach(() => {
  resetDatabase();
  // The fixture owns the record these tests assert on: a 60/40 win-loss
  // history, 42 settlements and $45,980 realised today — all written by this
  // test, none inherited from a removed demo book.
  seedPortfolioRow({
    balanceUsd: TEST_BALANCE_USD,
    wins30d: 60,
    losses30d: 40,
    grossGains30d: 310_000,
    grossLosses30d: -142_000,
    settlementsToday: 42,
    realizedTodayUsd: 45_980,
  });
  market = createMarketSimulator(1337, () => FIXED_NOW);
  portfolio = createPortfolioService(market);
});

afterAll(() => {
  closeDatabase();
});

const context = { actor: 'tester', strategyId: 'manual', venue: 'sim' } as const;

/** Open a fixture position through the real order path. */
function openPosition(symbol: string, side: 'buy' | 'sell', quantity: number): void {
  const order = portfolio.placeOrder({ symbol, side, type: 'market', quantity }, context);
  if (isRejected(order)) throw new Error(`fixture order rejected: ${order.reason}`);
}

describe('fixture book', () => {
  it('starts from the funded balance with cash, equity and identity intact', () => {
    expect(portfolio.cashBalanceUsd()).toBeCloseTo(TEST_BALANCE_USD, 6);
    expect(portfolio.equityUsd()).toBeCloseTo(TEST_BALANCE_USD, 6);
    expect(portfolio.positions()).toHaveLength(0);
    expect(portfolio.equityUsd()).toBeCloseTo(portfolio.cashBalanceUsd() + portfolio.unrealizedUsd(), 6);
  });

  it('keeps equity equal to cash plus unrealised after opening positions', () => {
    openPosition('BTC-USD', 'buy', 0.5);
    openPosition('SOL-USD', 'sell', 100);

    expect(portfolio.positions()).toHaveLength(2);
    // Entries book exposure but do not move cash; only exits realise P&L.
    expect(portfolio.cashBalanceUsd()).toBeCloseTo(TEST_BALANCE_USD, 6);
    expect(portfolio.equityUsd()).toBeCloseTo(portfolio.cashBalanceUsd() + portfolio.unrealizedUsd(), 6);
  });

  it('posts margin as notional over leverage on every open position', () => {
    openPosition('BTC-USD', 'buy', 1); // ~$91k notional at 1x

    const margin = portfolio.marginUsedUsd();
    const expected = portfolio
      .positions()
      .reduce((acc, position) => acc + (market.price(position.symbol) * position.size) / Math.max(1, position.leverage), 0);

    expect(margin).toBeGreaterThan(0);
    expect(margin).toBeCloseTo(expected, 6);
    expect((margin / portfolio.equityUsd()) * 100).toBeLessThan(100);
  });

  it('reports the fixture record instead of an empty book', () => {
    openPosition('ETH-USD', 'buy', 5);

    const summary = portfolio.summary({ deployedAlgos: 3, maxAlgos: 20, winRateDeltaVsBenchPct: -0.8 });
    expect(summary.openPositions).toBe(1);
    expect(summary.deployedAlgos).toBe(3);
    expect(summary.maxAlgos).toBe(20);
    // Seeded record is 60 wins / 40 losses → 60%, well above a coin flip.
    expect(summary.winRate30dPct).toBeCloseTo(60, 1);
    expect(summary.settlementsToday).toBe(42);
    expect(summary.realizedPnlTodayUsd).toBe(45_980);
    expect(summary.totalBalanceUsd).toBeCloseTo(portfolio.equityUsd(), 2);
  });
});

describe('market orders', () => {
  it('fills against the book and opens a position', () => {
    const before = portfolio.positions().length;
    const order = portfolio.placeOrder(
      { symbol: 'BTC-USD', side: 'buy', type: 'market', quantity: 0.5 },
      { actor: 'tester', strategyId: 'manual', venue: 'sim' },
    );
    if (isRejected(order)) throw new Error(`unexpected rejection: ${order.reason}`);

    expect(order.status).toBe('filled');
    expect(order.filledQuantity).toBeCloseTo(0.5, 9);
    expect(portfolio.positions()).toHaveLength(before + 1);

    const fill = portfolio.fills(1)[0];
    expect(fill).toBeDefined();
    expect(fill?.symbol).toBe('BTC-USD');
    expect(fill?.effect).toBe('entry');
    // Buying into the ask costs something; a zero-slippage fill would mean the
    // book is not being charged for.
    expect(fill?.slippageBps).toBeGreaterThan(0);
    expect(fill?.price).toBeGreaterThan(market.price('BTC-USD') * 0.999);
  });

  it('charges progressively more slippage as the ticket takes the book', () => {
    const small = portfolio.placeOrder(
      { symbol: 'BTC-USD', side: 'buy', type: 'market', quantity: 0.05 },
      { actor: 'tester', strategyId: 'manual', venue: 'sim' },
    );
    const large = portfolio.placeOrder(
      { symbol: 'BTC-USD', side: 'buy', type: 'market', quantity: 40 },
      { actor: 'tester', strategyId: 'manual', venue: 'sim' },
    );
    if (isRejected(small) || isRejected(large)) throw new Error('order rejected unexpectedly');

    expect(large.filledQuantity).toBeCloseTo(40, 9);
    const fills = portfolio.fills(5);
    const big = fills[0];
    const tiny = fills[1];
    expect(big?.slippageBps ?? 0).toBeGreaterThan(tiny?.slippageBps ?? 0);
  });

  it('rejects a ticket with neither a quantity nor a notional', () => {
    const outcome = portfolio.placeOrder(
      { symbol: 'BTC-USD', side: 'buy', type: 'market' },
      { actor: 'tester', strategyId: 'manual', venue: 'sim' },
    );
    expect(isRejected(outcome)).toBe(true);
  });

  it('moves equity with the tape rather than only on fills', () => {
    openPosition('BTC-USD', 'buy', 1);

    const opened = portfolio.equityUsd();
    for (let i = 0; i < 30; i += 1) market.advance();
    expect(portfolio.equityUsd()).not.toBe(opened);
    expect(portfolio.equityUsd()).toBeCloseTo(portfolio.cashBalanceUsd() + portfolio.unrealizedUsd(), 6);
  });
});

describe('limit orders', () => {
  it('rests until the book crosses it, then fills', () => {
    const book = market.book('BTC-USD', 1);
    const resting = book.asks[0];
    expect(resting).toBeDefined();
    if (!resting) return;

    const order = portfolio.placeOrder(
      { symbol: 'BTC-USD', side: 'buy', type: 'limit', quantity: 0.25, price: Number((resting.price * 1.5).toFixed(2)) },
      { actor: 'tester', strategyId: 'manual', venue: 'sim' },
    );
    if (isRejected(order)) throw new Error(order.reason);

    // A limit order is not matched on entry — it waits for the tick loop.
    expect(order.status).toBe('working');
    expect(order.filledQuantity).toBe(0);
    expect(portfolio.openOrders().map((candidate) => candidate.id)).toContain(order.id);

    portfolio.onTick(new Map([['BTC-USD', market.book('BTC-USD', 1)]]));

    const after = portfolio.orders(10).find((candidate) => candidate.id === order.id);
    expect(after?.status).toBe('filled');
    expect(after?.filledQuantity).toBeCloseTo(0.25, 9);
    expect(portfolio.openOrders()).toHaveLength(0);
  });

  it('cancels a working order on request', () => {
    const book = market.book('BTC-USD', 1);
    const bid = book.bids[0];
    expect(bid).toBeDefined();
    if (!bid) return;

    const order = portfolio.placeOrder(
      { symbol: 'BTC-USD', side: 'buy', type: 'limit', quantity: 0.1, price: Number((bid.price * 0.7).toFixed(2)) },
      { actor: 'tester', strategyId: 'manual', venue: 'sim' },
    );
    if (isRejected(order)) throw new Error(order.reason);

    expect(portfolio.cancelOrder(order.id)?.status).toBe('cancelled');
    expect(portfolio.openOrders()).toHaveLength(0);
  });
});

describe('closing positions', () => {
  it('realises P&L, books a closed trade and clears the position', () => {
    openPosition('SOL-USD', 'sell', 100);
    const target = portfolio.positions().find((position) => position.symbol === 'SOL-USD');
    expect(target).toBeDefined();
    if (!target) return;
    const direction = target.side === 'long' ? 1 : -1;
    // The exit pays the far side of the book plus slippage, so the realised
    // figure should sit near — but not exactly on — the mid-mark estimate.
    const markEstimate = (market.price(target.symbol) - target.entryPrice) * target.size * direction;
    const cashBefore = portfolio.cashBalanceUsd();
    const realizedBefore = portfolio.realizedTodayUsd();
    const settlementsBefore = portfolio.settlementsToday();

    const order = portfolio.closePosition(target.id, 'tester');
    expect(order?.status).toBe('filled');
    expect(portfolio.positions()).toHaveLength(0);
    expect(portfolio.settlementsToday()).toBe(settlementsBefore + 1);

    const fill = portfolio.fills(1)[0];
    const realized = fill?.realizedPnlUsd ?? 0;
    expect(fill?.effect).toBe('exit');
    // Round-tripping through the book always pays the spread twice.
    expect(realized).toBeLessThan(0);
    // Cash and the realised-P&L counter must both move by the booked amount.
    // The reported fill is rounded to cents, hence the 5-cent tolerance rather
    // than an exact match; anything larger means ledger and fill disagree.
    expect(portfolio.cashBalanceUsd() - cashBefore).toBeCloseTo(realized, 1);
    expect(portfolio.realizedTodayUsd() - realizedBefore).toBeCloseTo(realized, 1);
    expect(Math.abs(portfolio.cashBalanceUsd() - cashBefore - realized)).toBeLessThan(0.005);
    expect(Math.abs(realized - markEstimate)).toBeLessThan(target.size * market.price(target.symbol) * 0.002);
  });

  it('nets an opposing order against an existing position', () => {
    openPosition('BTC-USD', 'buy', 1);
    const existing = portfolio.positions().find((position) => position.symbol === 'BTC-USD');
    expect(existing).toBeDefined();
    if (!existing) return;

    const order = portfolio.placeOrder(
      { symbol: 'BTC-USD', side: 'sell', type: 'market', quantity: existing.size / 2 },
      { actor: 'tester', strategyId: existing.strategyId, venue: 'sim' },
    );
    if (isRejected(order)) throw new Error(order.reason);

    const reduced = portfolio.positionById(existing.id);
    expect(reduced?.size).toBeCloseTo(existing.size / 2, 4);
    expect(portfolio.fills(1)[0]?.effect).toBe('exit');
  });

  it('survives a reload from SQLite with the book intact', () => {
    openPosition('BTC-USD', 'buy', 0.25);
    openPosition('ETH-USD', 'sell', 3);

    const before = portfolio.equityUsd();
    const positions = portfolio.positions().length;
    expect(positions).toBe(2);

    portfolio.reload();
    expect(portfolio.positions()).toHaveLength(positions);
    expect(portfolio.equityUsd()).toBeCloseTo(before, 4);
  });
});
