import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BrokerStatus } from '@kinetix/shared';

import type { BrokerAdapter, BrokerOrderRequest, BrokerOrderState, BrokerPosition, BrokerQuote } from '../src/brokers/types.ts';
import { closeDatabase, getDb, resetDatabase } from '../src/db/db.ts';
import { createPortfolioService } from '../src/engine/portfolio.ts';
import { createLiveFeed } from '../src/market/liveFeed.ts';
import { createLiveTradingService } from '../src/market/liveTrading.ts';
import { createMarketSimulator } from '../src/sim/market.ts';

/* ============================================================================
 * Live NSE order routing.
 *
 * The feed is real — its scrip-master download is stubbed, as in liveFeed.test —
 * so routing runs against genuine symbol resolution. Only the broker adapter is
 * a stub, and it records exactly what it was asked to do.
 * ==========================================================================*/

const HEADER = 'pSymbol,pGroup,pExchSeg,pInstType,pSymbolName,pTrdSymbol,pISIN,dTickSize ,lLotSize,dStrikePrice;';

/** Stub the scrip-master download for whichever segment is requested. */
function stubScripMasterDownload(): void {
  vi.stubGlobal('fetch', async (url: string | URL) => {
    const segment = String(url).split('/').pop()?.replace('-v1.csv', '') ?? 'nse_cm';
    const csv = [
      HEADER,
      `2885,EQ,${segment},,RELIANCE,RELIANCE-EQ,INE002A01018,10,1,-1`,
      `11536,EQ,${segment},,TCS,TCS-EQ,INE467B01029,10,1,-1`,
    ].join('\n');
    return new Response(csv, { status: 200 });
  });
}

interface BrokerStub {
  adapter: BrokerAdapter;
  placed: BrokerOrderRequest[];
  cancelled: string[];
  setConnected: (connected: boolean) => void;
  /** Make the next placeOrder fail, the way a live venue would. */
  failNextPlace: (message: string) => void;
  /** The venue's own order book, as reconciliation would read it. */
  brokerOrders: BrokerOrderState[];
  /** The venue's own position book. */
  brokerPositions: BrokerPosition[];
}

function brokerStub(segment: string, price: () => number): BrokerStub {
  let connected = true;
  let placeFailure: string | null = null;
  const placed: BrokerOrderRequest[] = [];
  const cancelled: string[] = [];
  const brokerOrders: BrokerOrderState[] = [];
  const brokerPositions: BrokerPosition[] = [
    {
      symbol: 'RELIANCE-EQ',
      tradingSymbol: 'RELIANCE-EQ',
      quantity: 25,
      averagePrice: 90,
      lastPrice: 100,
      pnl: 250,
      product: 'MIS',
    },
  ];

  const status = (): BrokerStatus => ({
    provider: 'kotakneo',
    configured: true,
    connected,
    mode: connected ? 'live' : 'simulated',
    venueLabel: 'Kotak Neo (NSE/BSE)',
    accountLabel: null,
    sessionExpiresAt: null,
    connectedAt: null,
    lastError: null,
    missingEnv: [],
    endpoints: [],
  });

  const adapter: BrokerAdapter = {
    id: 'kotakneo',
    label: 'stub',
    isConfigured: () => true,
    missingEnv: () => [],
    status,
    login: async () => status(),
    logout: async () => {},
    quotes: async (requests) =>
      requests.map(
        (request): BrokerQuote => ({
          symbol: request.symbol,
          lastPrice: price(),
          previousClose: 99,
          changePct: 1.01,
          volume: 1_000,
          ts: 0,
        }),
      ),
    positions: async () => brokerPositions.map((position) => ({ ...position })),
    limits: async () => ({ netMarginAvailable: 0, collateral: 0, utilisedMargin: 0 }),
    holdings: async () => [],
    scripMasterFilePaths: async () => [`https://lapi.test/prod/2026-10-11/transformed/${segment}-v1.csv`],
    placeOrder: async (request) => {
      placed.push(request);
      if (placeFailure) {
        const message = placeFailure;
        placeFailure = null;
        return { ok: false, orderId: null, message };
      }
      return { ok: true, orderId: `K${placed.length}`, message: 'Order accepted by Kotak Neo' };
    },
    cancelOrder: async (orderId) => {
      cancelled.push(orderId);
      return { ok: true, orderId, message: 'Cancel request submitted' };
    },
    orderBook: async () => [],
    orders: async () => brokerOrders.map((order) => ({ ...order })),
    lastLatencyMs: () => null,
  };

  return {
    adapter,
    placed,
    cancelled,
    setConnected: (next) => {
      connected = next;
    },
    failNextPlace: (message) => {
      placeFailure = message;
    },
    brokerOrders,
    brokerPositions,
  };
}

/** Boot a resolved feed over the stub, so `knows()` and quotes are real. */
async function bootFeed(segment: string, stub: BrokerStub) {
  stubScripMasterDownload();
  const feed = createLiveFeed({
    adapter: stub.adapter,
    segment,
    symbols: ['RELIANCE'],
    pollMs: 0,
    now: () => 1_760_000_000_000,
  });
  await feed.poll();
  return feed;
}

beforeEach(() => {
  resetDatabase();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(() => {
  closeDatabase();
});

describe('live paper routing (the default)', () => {
  it('fills a market ticket at the live quote and books it in the live book', async () => {
    const stub = brokerStub('nse_lt_paper', () => 118.5);
    const feed = await bootFeed('nse_lt_paper', stub);
    const trading = createLiveTradingService({ feed, adapter: stub.adapter });

    expect(trading.knows('KOTAK:RELIANCE')).toBe(true);
    expect(trading.mode()).toBe('paper');

    const outcome = await trading.placeOrder(
      { symbol: 'KOTAK:RELIANCE', side: 'buy', type: 'market', quantity: 10 },
      undefined,
      'tester',
    );

    expect(outcome.kind).toBe('order');
    if (outcome.kind !== 'order') return;
    expect(outcome.fill?.price).toBe(118.5);
    expect(outcome.fill?.effect).toBe('entry');
    expect(outcome.order.status).toBe('filled');
    expect(outcome.position?.side).toBe('long');
    expect(outcome.position?.size).toBe(10);
    // Nothing was sent to the broker in paper mode.
    expect(stub.placed).toHaveLength(0);

    const marked = trading.positions()[0];
    expect(marked?.venue).toBe('kotakneo');
    expect(marked?.markPrice).toBe(118.5);
  });

  it('rejects a ticket with no share quantity rather than guessing one from USD', async () => {
    const stub = brokerStub('nse_lt_qty', () => 100);
    const feed = await bootFeed('nse_lt_qty', stub);
    const trading = createLiveTradingService({ feed, adapter: stub.adapter });

    const outcome = await trading.placeOrder({ symbol: 'KOTAK:RELIANCE', side: 'buy', type: 'market' }, undefined, 'tester');
    expect(outcome.kind).toBe('rejected');
    if (outcome.kind !== 'rejected') return;
    expect(outcome.code).toBe('invalid_quantity');
    expect(outcome.httpStatus).toBe(400);
  });

  it('keeps the live book out of the simulated portfolio', async () => {
    const stub = brokerStub('nse_lt_isolation', () => 100);
    const feed = await bootFeed('nse_lt_isolation', stub);
    const trading = createLiveTradingService({ feed, adapter: stub.adapter });

    await trading.placeOrder({ symbol: 'KOTAK:RELIANCE', side: 'buy', type: 'market', quantity: 5 }, undefined, 'tester');

    // The rupee book exists…
    expect(trading.positions()).toHaveLength(1);
    // …and the USD book never sees it: a `kotakneo` position would otherwise be
    // marked with the simulator's prices and corrupt equity.
    const portfolio = createPortfolioService(createMarketSimulator(7, () => 1_760_000_000_000));
    expect(portfolio.positions()).toHaveLength(0);
    expect(portfolio.unrealizedUsd()).toBe(0);
  });

  it('rests a limit order that is not marketable and fills it when the tape crosses', async () => {
    let price = 100;
    const stub = brokerStub('nse_lt_limit', () => price);
    const feed = await bootFeed('nse_lt_limit', stub);
    const trading = createLiveTradingService({ feed, adapter: stub.adapter });

    const resting = await trading.placeOrder(
      { symbol: 'KOTAK:RELIANCE', side: 'buy', type: 'limit', quantity: 4, price: 90 },
      undefined,
      'tester',
    );
    expect(resting.kind).toBe('order');
    if (resting.kind !== 'order') return;
    expect(resting.order.status).toBe('working');
    expect(resting.fill).toBeNull();
    expect(trading.workingOrders()).toHaveLength(1);

    // The tape crosses the limit on a later poll.
    price = 88;
    await feed.poll();

    expect(trading.workingOrders()).toHaveLength(0);
    expect(trading.positions()[0]?.entryPrice).toBe(90);
  });

  it('cancels a resting paper limit instead of routing a cancel to Kotak', async () => {
    const stub = brokerStub('nse_lt_cancel', () => 100);
    const feed = await bootFeed('nse_lt_cancel', stub);
    const trading = createLiveTradingService({ feed, adapter: stub.adapter });

    const placed = await trading.placeOrder(
      { symbol: 'KOTAK:RELIANCE', side: 'buy', type: 'limit', quantity: 2, price: 80 },
      undefined,
      'tester',
    );
    if (placed.kind !== 'order') throw new Error('expected a working order');

    const cancelled = await trading.cancelOrder(placed.order.id, 'tester');
    expect(cancelled && 'order' in cancelled ? cancelled.order.status : null).toBe('cancelled');
    expect(stub.cancelled).toHaveLength(0);
  });

  it('closes a paper position with an opposing fill at the quote', async () => {
    let price = 100;
    const stub = brokerStub('nse_lt_close', () => price);
    const feed = await bootFeed('nse_lt_close', stub);
    const trading = createLiveTradingService({ feed, adapter: stub.adapter });

    await trading.placeOrder({ symbol: 'KOTAK:RELIANCE', side: 'buy', type: 'market', quantity: 10 }, undefined, 'tester');
    // The exit fills at the *latest* quote, so the tape has to move first.
    price = 104;
    await feed.poll();
    const positionId = trading.positions()[0]?.id ?? '';
    const closed = await trading.closePaperPosition(positionId, 'tester');

    expect(closed?.kind).toBe('order');
    if (closed?.kind !== 'order') return;
    expect(closed.fill?.effect).toBe('exit');
    // 10 shares × 4 rupees of movement.
    expect(closed.fill?.realizedPnlUsd).toBeCloseTo(40, 6);
    expect(trading.positions()).toHaveLength(0);
  });
});

describe('live routing (explicit opt-in)', () => {
  it('refuses to route while the Kotak session is closed', async () => {
    const stub = brokerStub('nse_lt_nosession', () => 100);
    stub.setConnected(false);
    const feed = await bootFeed('nse_lt_nosession', stub);
    const trading = createLiveTradingService({ feed, adapter: stub.adapter });

    const outcome = await trading.placeOrder(
      { symbol: 'KOTAK:RELIANCE', side: 'buy', type: 'market', quantity: 3 },
      'live',
      'tester',
    );
    expect(outcome.kind).toBe('rejected');
    if (outcome.kind !== 'rejected') return;
    expect(outcome.code).toBe('broker_not_connected');
    expect(stub.placed).toHaveLength(0);
  });

  it('forwards a live order with the resolved Kotak identifiers', async () => {
    const stub = brokerStub('nse_lt_live', () => 100);
    const feed = await bootFeed('nse_lt_live', stub);
    const trading = createLiveTradingService({ feed, adapter: stub.adapter });

    const outcome = await trading.placeOrder(
      { symbol: 'KOTAK:RELIANCE', side: 'sell', type: 'market', quantity: 7 },
      'live',
      'tester',
    );

    expect(outcome.kind).toBe('order');
    if (outcome.kind !== 'order') return;
    expect(stub.placed).toHaveLength(1);
    expect(stub.placed[0]).toMatchObject({
      tradingSymbol: 'RELIANCE-EQ',
      exchangeSegment: 'nse_lt_live',
      side: 'sell',
      quantity: 7,
      orderType: 'market',
      product: 'MIS',
    });
    expect(stub.placed[0]?.instrumentToken).toBe('2885');
    // No local fill: the venue owns the order now.
    expect(outcome.fill).toBeNull();
    expect(outcome.order.venueOrderId).toBe('K1');
    expect(outcome.order.status).toBe('working');
    // A live order is not a live position until the broker reports one.
    expect(trading.positions()).toHaveLength(0);
  });

  it('follows the armed mode when the request does not name one', async () => {
    const stub = brokerStub('nse_lt_armed', () => 100);
    const feed = await bootFeed('nse_lt_armed', stub);
    const trading = createLiveTradingService({ feed, adapter: stub.adapter });

    trading.setMode('live', 'tester');
    await trading.placeOrder({ symbol: 'KOTAK:RELIANCE', side: 'buy', type: 'market', quantity: 1 }, undefined, 'tester');
    expect(stub.placed).toHaveLength(1);

    trading.setMode('paper', 'tester');
    await trading.placeOrder({ symbol: 'KOTAK:RELIANCE', side: 'buy', type: 'market', quantity: 1 }, undefined, 'tester');
    expect(stub.placed).toHaveLength(1);
    expect(trading.positions()[0]?.size).toBe(1);
  });

  it('reports a broker rejection without pretending an order exists', async () => {
    const stub = brokerStub('nse_lt_reject', () => 100);
    stub.failNextPlace('Insufficient margin for this order');
    const feed = await bootFeed('nse_lt_reject', stub);
    const trading = createLiveTradingService({ feed, adapter: stub.adapter });

    const outcome = await trading.placeOrder(
      { symbol: 'KOTAK:RELIANCE', side: 'buy', type: 'market', quantity: 1 },
      'live',
      'tester',
    );
    expect(outcome.kind).toBe('rejected');
    if (outcome.kind !== 'rejected') return;
    expect(outcome.code).toBe('broker_rejected');
    expect(outcome.reason).toContain('Insufficient margin');
  });

  it('cancels a live order through Kotak using the broker order id', async () => {
    const stub = brokerStub('nse_lt_cancel_live', () => 100);
    const feed = await bootFeed('nse_lt_cancel_live', stub);
    const trading = createLiveTradingService({ feed, adapter: stub.adapter });

    const placed = await trading.placeOrder(
      { symbol: 'KOTAK:RELIANCE', side: 'buy', type: 'limit', quantity: 1, price: 90 },
      'live',
      'tester',
    );
    if (placed.kind !== 'order') throw new Error('expected a live order');

    const cancelled = await trading.cancelOrder(placed.order.id, 'tester');
    expect(stub.cancelled).toEqual(['K1']);
    expect(cancelled && 'order' in cancelled ? cancelled.order.status : null).toBe('cancelled');
  });

  it('closes a broker-held position with an opposing live order', async () => {
    const stub = brokerStub('nse_lt_broker_close', () => 100);
    const feed = await bootFeed('nse_lt_broker_close', stub);
    const trading = createLiveTradingService({ feed, adapter: stub.adapter });

    const outcome = await trading.closeBrokerPosition('RELIANCE-EQ', 'tester');
    expect(outcome.kind).toBe('order');
    expect(stub.placed[0]).toMatchObject({ side: 'sell', quantity: 25, tradingSymbol: 'RELIANCE-EQ' });
  });
});

describe('reconciliation against the venue', () => {
  it('replaces the local claim with the venue state and books a genuine fill', async () => {
    const stub = brokerStub('nse_rec_fill', () => 100);
    const feed = await bootFeed('nse_rec_fill', stub);
    const trading = createLiveTradingService({ feed, adapter: stub.adapter });

    const placed = await trading.placeOrder(
      { symbol: 'KOTAK:RELIANCE', side: 'buy', type: 'limit', quantity: 1, price: 90 },
      'live',
      'tester',
    );
    if (placed.kind !== 'order') throw new Error('expected a live order');
    expect(placed.order.status).toBe('working');

    stub.brokerOrders.push({
      orderId: 'K1',
      status: 'filled',
      quantity: 1,
      filledQuantity: 1,
      averagePrice: 100.5,
      symbol: 'RELIANCE-EQ',
      side: 'buy',
      rejectReason: null,
      product: 'MIS',
      ts: null,
    });
    // The venue has not settled its position book yet — the fill it reported
    // must still be materialised rather than erased a moment later.
    stub.brokerPositions.length = 0;

    const result = await trading.reconcile('tester');
    expect(result.ok).toBe(true);
    expect(result.checkedOrders).toBe(1);
    expect(result.updatedOrders).toBe(1);
    expect(result.bookedFills).toBe(1);

    const row = getDb().prepare('SELECT status, filled_quantity AS filled FROM orders WHERE id = ?').get(placed.order.id) as
      | { status: string; filled: number }
      | undefined;
    expect(row?.status).toBe('filled');
    expect(row?.filled).toBe(1);

    const mirrored = trading.brokerPositions();
    expect(mirrored).toHaveLength(1);
    expect(mirrored[0]?.strategyName).toBe('Kotak Broker');
    expect(mirrored[0]?.entryPrice).toBe(100.5);
    expect(mirrored[0]?.size).toBe(1);
    // A venue fill is not a paper fill, and must not leak into that book.
    expect(trading.positions()).toHaveLength(0);
  });

  it('never books the same venue fill twice', async () => {
    const stub = brokerStub('nse_rec_idem', () => 100);
    const feed = await bootFeed('nse_rec_idem', stub);
    const trading = createLiveTradingService({ feed, adapter: stub.adapter });

    const placed = await trading.placeOrder(
      { symbol: 'KOTAK:RELIANCE', side: 'buy', type: 'market', quantity: 2 },
      'live',
      'tester',
    );
    if (placed.kind !== 'order') throw new Error('expected a live order');

    stub.brokerOrders.push({
      orderId: 'K1',
      status: 'partially_filled',
      quantity: 2,
      filledQuantity: 2,
      averagePrice: 101,
      symbol: 'RELIANCE-EQ',
      side: 'buy',
      rejectReason: null,
      product: 'MIS',
      ts: null,
    });
    // Only the fill-derived position exists, so the assertion is about what the
    // booked fill built rather than about the venue's own book.
    stub.brokerPositions.length = 0;

    expect((await trading.reconcile('tester')).bookedFills).toBe(1);
    expect((await trading.reconcile('tester')).bookedFills).toBe(0);

    const fills = getDb()
      .prepare('SELECT COUNT(*) AS count, SUM(quantity) AS quantity FROM fills WHERE order_id = ?')
      .get(placed.order.id) as { count: number; quantity: number };
    expect(fills.count).toBe(1);
    expect(fills.quantity).toBe(2);
    expect(trading.brokerPositions()[0]?.size).toBe(2);
  });

  it('keeps a partial venue fill partial, then completes it on a later pass', async () => {
    const stub = brokerStub('nse_rec_partial', () => 100);
    const feed = await bootFeed('nse_rec_partial', stub);
    const trading = createLiveTradingService({ feed, adapter: stub.adapter });

    const placed = await trading.placeOrder(
      { symbol: 'KOTAK:RELIANCE', side: 'buy', type: 'limit', quantity: 10, price: 90 },
      'live',
      'tester',
    );
    if (placed.kind !== 'order') throw new Error('expected a live order');
    stub.brokerPositions.length = 0;

    stub.brokerOrders.push({
      orderId: 'K1',
      status: 'partially_filled',
      quantity: 10,
      filledQuantity: 4,
      averagePrice: 95,
      symbol: 'RELIANCE-EQ',
      side: 'buy',
      rejectReason: null,
      product: 'MIS',
      ts: null,
    });

    expect((await trading.reconcile('tester')).bookedFills).toBe(1);
    const partial = getDb()
      .prepare('SELECT status, filled_quantity AS filled FROM orders WHERE id = ?')
      .get(placed.order.id) as { status: string; filled: number } | undefined;
    // 4 of 10 executed is not a filled order, and the row must stay eligible for
    // the next pass rather than being closed off as done.
    expect(partial?.status).toBe('partially_filled');
    expect(partial?.filled).toBe(4);

    const state = stub.brokerOrders[0];
    if (!state) throw new Error('expected the venue order');
    state.status = 'filled';
    state.filledQuantity = 10;
    expect((await trading.reconcile('tester')).bookedFills).toBe(1);

    const done = getDb()
      .prepare('SELECT status, filled_quantity AS filled, average_fill_price AS average FROM orders WHERE id = ?')
      .get(placed.order.id) as { status: string; filled: number; average: number } | undefined;
    expect(done?.status).toBe('filled');
    expect(done?.filled).toBe(10);
    expect(done?.average).toBe(95);
    // Both fills landed at the venue's price, so the position carries it too.
    expect(trading.brokerPositions()[0]?.size).toBe(10);
    expect(trading.brokerPositions()[0]?.entryPrice).toBe(95);
  });

  it('records the venue\u2019s rejection reason rather than a silent failure', async () => {
    const stub = brokerStub('nse_rec_reject', () => 100);
    const feed = await bootFeed('nse_rec_reject', stub);
    const trading = createLiveTradingService({ feed, adapter: stub.adapter });

    const placed = await trading.placeOrder(
      { symbol: 'KOTAK:RELIANCE', side: 'buy', type: 'market', quantity: 1 },
      'live',
      'tester',
    );
    if (placed.kind !== 'order') throw new Error('expected a live order');

    stub.brokerOrders.push({
      orderId: 'K1',
      status: 'rejected',
      quantity: 1,
      filledQuantity: 0,
      averagePrice: null,
      symbol: 'RELIANCE-EQ',
      side: 'buy',
      rejectReason: 'RMS: insufficient margin',
      product: 'MIS',
      ts: null,
    });

    const result = await trading.reconcile('tester');
    expect(result.updatedOrders).toBe(1);
    const row = getDb().prepare('SELECT status, reject_reason AS reason FROM orders WHERE id = ?').get(placed.order.id) as
      | { status: string; reason: string | null }
      | undefined;
    expect(row?.status).toBe('rejected');
    expect(row?.reason).toContain('insufficient margin');
  });

  it('mirrors a position the venue holds that this terminal never opened, then removes it when the venue stops reporting it', async () => {
    const stub = brokerStub('nse_rec_mirror', () => 100);
    const feed = await bootFeed('nse_rec_mirror', stub);
    const trading = createLiveTradingService({ feed, adapter: stub.adapter });

    const first = await trading.reconcile('tester');
    expect(first.createdPositions).toBe(1);

    const mirrored = trading.brokerPositions();
    expect(mirrored).toHaveLength(1);
    expect(mirrored[0]?.id).toBe('broker_RELIANCE-EQ');
    expect(mirrored[0]?.size).toBe(25);
    // Marked from the live feed, not from the venue's stale last price.
    expect(mirrored[0]?.markPrice).toBe(100);

    // A single absence is a position book that has not settled yet, so the
    // mirror only goes once the venue has said so twice.
    stub.brokerPositions.length = 0;
    expect((await trading.reconcile('tester')).closedPositions).toBe(0);
    expect(trading.brokerPositions()).toHaveLength(1);

    const third = await trading.reconcile('tester');
    expect(third.closedPositions).toBe(1);
    expect(trading.brokerPositions()).toHaveLength(0);
  });

  it('refuses to reconcile without a session and says why', async () => {
    const stub = brokerStub('nse_rec_off', () => 100);
    stub.setConnected(false);
    const feed = await bootFeed('nse_rec_off', stub);
    const trading = createLiveTradingService({ feed, adapter: stub.adapter });

    const result = await trading.reconcile('tester');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not connected/i);
    expect(result.checkedOrders).toBe(0);
  });
});
