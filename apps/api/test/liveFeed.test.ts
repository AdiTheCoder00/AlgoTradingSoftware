import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BrokerStatus, Candle } from '@kinetix/shared';

import { aggregateBars, createLiveFeed } from '../src/market/liveFeed.ts';
import { parseDepth } from '../src/brokers/kotakNeo.ts';
import type { BrokerAdapter, BrokerQuote } from '../src/brokers/types.ts';

/* ============================================================================
 * Live NSE feed.
 *
 * Nothing here touches the network: the scrip-master download is stubbed, and so
 * is the broker adapter. Each case uses its own exchange segment, because the
 * scrip master is cached per segment inside the loader — sharing one would leak
 * fixtures between tests.
 * ==========================================================================*/

const HEADER = 'pSymbol,pGroup,pExchSeg,pInstType,pSymbolName,pTrdSymbol,pISIN,dTickSize ,lLotSize,dStrikePrice;';

function csvFor(segment: string): string {
  return [
    HEADER,
    `2885,EQ,${segment},,RELIANCE,RELIANCE-EQ,INE002A01018,10,1,-1`,
    `11536,EQ,${segment},,TCS,TCS-EQ,INE467B01029,10,1,-1`,
    // An index has no series and must not be quoted: Kotak's quote endpoint
    // rejects index tokens, so the feed drops it rather than erroring later.
    `26000,,${segment},,NIFTY,NIFTY,,−1,1,-1`,
  ].join('\n');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

interface StubOptions {
  segment: string;
  connected?: boolean;
  /** Change the quote between polls. */
  quote?: () => { lastPrice: number; previousClose: number; changePct: number; volume: number };
  /** Depth the venue reports with the quote, if any. */
  depth?: () => BrokerQuote['depth'];
}

function stubAdapter(options: StubOptions): { adapter: BrokerAdapter; quoteCalls: () => number } {
  let calls = 0;
  const current = options.quote ?? (() => ({ lastPrice: 100, previousClose: 95, changePct: 5.26, volume: 0 }));

  const status = (): BrokerStatus => ({
    provider: 'kotakneo',
    configured: true,
    connected: options.connected ?? true,
    mode: (options.connected ?? true) ? 'live' : 'simulated',
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
    quotes: async (requests) => {
      calls += 1;
      const quote = current();
      const depth = options.depth?.();
      return requests.map(
        (request): BrokerQuote => ({
          symbol: request.symbol,
          lastPrice: quote.lastPrice,
          previousClose: quote.previousClose,
          changePct: quote.changePct,
          volume: quote.volume,
          ts: 0,
          ...(depth ? { depth } : {}),
        }),
      );
    },
    positions: async () => [],
    limits: async () => ({ netMarginAvailable: 0, collateral: 0, utilisedMargin: 0 }),
    holdings: async () => [],
    scripMasterFilePaths: async () => [`https://lapi.test/prod/2026-10-11/transformed/${options.segment}-v1.csv`],
    placeOrder: async () => ({ ok: false, orderId: null, message: 'stub' }),
    cancelOrder: async () => ({ ok: false, orderId: null, message: 'stub' }),
    orderBook: async () => [],
    orders: async () => [],
    lastLatencyMs: () => null,
  };
  return { adapter, quoteCalls: () => calls };
}

/** Stub the scrip-master download for whichever segment is requested. */
function stubScripMasterDownload(): void {
  vi.stubGlobal('fetch', async (url: string | URL) => {
    const segment = String(url).split('/').pop()?.replace('-v1.csv', '') ?? 'nse_cm';
    return new Response(csvFor(segment), { status: 200 });
  });
}

describe('bar aggregation', () => {
  it('returns 1-minute bars untouched', () => {
    const bars = [
      { t: 0, o: 1, h: 2, l: 0.5, c: 1.5, v: 10 },
      { t: 60_000, o: 1.5, h: 3, l: 1.5, c: 2.5, v: 5 },
    ];
    expect(aggregateBars(bars, '1m', 10)).toHaveLength(2);
  });

  it('folds several 1-minute bars into one 15-minute bar', () => {
    // 0..14 minutes inside the same 15-minute bucket.
    const bars = Array.from({ length: 5 }, (_, index) => ({
      t: index * 60_000,
      o: 100 + index,
      h: 110 + index,
      l: 90 - index,
      c: 105 + index,
      v: 10,
    }));

    const [folded] = aggregateBars(bars, '15m', 10);
    expect(folded?.t).toBe(0);
    expect(folded?.o).toBe(100); // first bar's open
    expect(folded?.c).toBe(109); // last bar's close
    expect(folded?.h).toBe(114); // highest high
    expect(folded?.l).toBe(86); // lowest low
    expect(folded?.v).toBe(50); // summed volume
  });

  it('starts a new bucket when the timeframe rolls over', () => {
    const bars = [
      { t: 0, o: 1, h: 1, l: 1, c: 1, v: 1 },
      { t: 15 * 60_000, o: 2, h: 2, l: 2, c: 2, v: 2 },
    ];
    expect(aggregateBars(bars, '15m', 10)).toHaveLength(2);
  });

  it('has nothing to aggregate from an empty tape', () => {
    expect(aggregateBars([], '1h', 10)).toEqual([]);
  });
});

describe('live watchlist resolution', () => {
  it('resolves equities to Kotak tokens and skips the index', async () => {
    stubScripMasterDownload();
    const { adapter } = stubAdapter({ segment: 'nse_watch' });
    const feed = createLiveFeed({ adapter, segment: 'nse_watch', symbols: ['RELIANCE', 'TCS', 'NIFTY'], pollMs: 0 });

    await feed.poll();

    const instruments = feed.instruments();
    expect(instruments.map((instrument) => instrument.symbol)).toEqual(['KOTAK:RELIANCE', 'KOTAK:TCS']);
    const reliance = instruments[0];
    expect(reliance?.instrumentToken).toBe('2885');
    expect(reliance?.tradingSymbol).toBe('RELIANCE-EQ');
    expect(reliance?.venue).toBe('kotakneo');
    expect(reliance?.kind).toBe('equity');
    // Kotak reports the tick size scaled (10), which cannot be a rupee
    // increment, so it is read as paise.
    expect(reliance?.tickSize).toBeCloseTo(0.1, 6);
  });

  it('reports a resolution failure in the status instead of throwing', async () => {
    vi.stubGlobal('fetch', async () => new Response('not a csv', { status: 500 }));
    const { adapter } = stubAdapter({ segment: 'nse_fail' });
    const feed = createLiveFeed({ adapter, segment: 'nse_fail', symbols: ['RELIANCE'], pollMs: 0 });

    await expect(feed.poll()).resolves.toEqual([]);
    expect(feed.status().lastError).toMatch(/scrip master|resolve/i);
  });
});

describe('polling', () => {
  it('publishes a tick and a quote for each resolved instrument', async () => {
    stubScripMasterDownload();
    const { adapter } = stubAdapter({ segment: 'nse_poll' });
    const feed = createLiveFeed({ adapter, segment: 'nse_poll', symbols: ['RELIANCE'], pollMs: 0, now: () => 1_760_000_000_000 });

    const frames: string[] = [];
    const off = feed.onTicks((ticks) => frames.push(...ticks.map((tick) => tick.symbol)));

    const ticks = await feed.poll();

    expect(ticks).toHaveLength(1);
    expect(ticks[0]?.symbol).toBe('KOTAK:RELIANCE');
    expect(frames).toEqual(['KOTAK:RELIANCE']);
    expect(feed.quote('KOTAK:RELIANCE')?.lastPrice).toBe(100);
    expect(feed.quote('KOTAK:RELIANCE')?.tickCount).toBe(1);
    expect(feed.status().ticks).toBe(1);

    off();
    await feed.poll();
    expect(frames).toHaveLength(1);
  });

  it('updates the forming bar within a minute and starts a new bar after it', async () => {
    stubScripMasterDownload();
    let price = 100;
    let clock = 1_760_000_000_000;
    const { adapter } = stubAdapter({
      segment: 'nse_bars',
      quote: () => ({ lastPrice: price, previousClose: 95, changePct: 5, volume: price }),
    });
    const feed = createLiveFeed({ adapter, segment: 'nse_bars', symbols: ['RELIANCE'], pollMs: 0, now: () => clock });

    await feed.poll();
    price = 130;
    clock += 20_000; // still inside the same minute
    await feed.poll();

    const forming = feed.candles('KOTAK:RELIANCE', '1m', 10);
    expect(forming).toHaveLength(1);
    expect(forming[0]).toMatchObject({ o: 100, h: 130, l: 100, c: 130 });

    price = 90;
    clock += 60_000; // next minute
    await feed.poll();

    const bars = feed.candles('KOTAK:RELIANCE', '1m', 10);
    expect(bars).toHaveLength(2);
    expect(bars[1]).toMatchObject({ o: 90, h: 90, l: 90, c: 90 });
  });

  it('turns a cumulative day volume into a per-bar delta', async () => {
    stubScripMasterDownload();
    let volume = 100;
    let clock = 1_760_000_000_000;
    const { adapter } = stubAdapter({
      segment: 'nse_vol',
      quote: () => ({ lastPrice: 100, previousClose: 95, changePct: 5, volume }),
    });
    const feed = createLiveFeed({ adapter, segment: 'nse_vol', symbols: ['RELIANCE'], pollMs: 0, now: () => clock });

    await feed.poll(); // first observation: the whole figure is this bar's volume
    volume = 250;
    clock += 20_000;
    await feed.poll();

    // 100 + (250 - 100), not the cumulative 250 added twice.
    expect(feed.candles('KOTAK:RELIANCE', '1m', 10)[0]?.v).toBe(250);

    volume = 5; // a new session resets the cumulative figure
    clock += 60_000;
    await feed.poll();
    expect(feed.candles('KOTAK:RELIANCE', '1m', 10)[1]?.v).toBe(5);
  });

  it('agrees with the broker when the session is gone, and does not pretend to have data', async () => {
    stubScripMasterDownload();
    const { adapter, quoteCalls } = stubAdapter({ segment: 'nse_off', connected: false });
    const feed = createLiveFeed({ adapter, segment: 'nse_off', symbols: ['RELIANCE'], pollMs: 0 });

    await expect(feed.poll()).resolves.toEqual([]);
    expect(feed.status().lastError).toMatch(/session is not connected/i);
    expect(feed.quotes()).toHaveLength(0);
    // Resolving the watchlist needs no session, so it should still have happened.
    expect(feed.instruments()).toHaveLength(1);
    expect(quoteCalls()).toBe(0);
  });

  it('surfaces a quote failure through the status rather than rejecting', async () => {
    stubScripMasterDownload();
    const { adapter } = stubAdapter({ segment: 'nse_boom' });
    adapter.quotes = async () => {
      throw new Error('Kotak Neo quote failed (500)');
    };
    const feed = createLiveFeed({ adapter, segment: 'nse_boom', symbols: ['RELIANCE'], pollMs: 0 });

    await expect(feed.poll()).resolves.toEqual([]);
    expect(feed.status().lastError).toContain('quote failed');
  });
});

describe('depth', () => {
  it('reads the documented buy/sell rows and the bids/asks aliases', () => {
    const documented = parseDepth({
      depth: {
        buy: [
          { price: 100.5, quantity: 400 },
          { price: 100.45, quantity: 300 },
        ],
        sell: [
          { price: 100.55, quantity: 250 },
          { price: 100.6, quantity: 150 },
        ],
      },
    });
    expect(documented?.bids.map((level) => level.price)).toEqual([100.5, 100.45]);
    expect(documented?.asks.map((level) => level.price)).toEqual([100.55, 100.6]);

    const aliased = parseDepth({ bids: [{ p: 10, q: 5 }], asks: [{ p: 11, q: 6 }] });
    expect(aliased?.bids[0]).toEqual({ price: 10, size: 5 });
    expect(aliased?.asks[0]).toEqual({ price: 11, size: 6 });
  });

  it('yields nothing when the venue sent no usable levels', () => {
    expect(parseDepth({})).toBeUndefined();
    expect(parseDepth({ depth: { buy: [], sell: [] } })).toBeUndefined();
    // A level without a price is not a price level.
    expect(parseDepth({ depth: { buy: [{ quantity: 10 }], sell: [] } })).toBeUndefined();
  });

  it('publishes a book only when the quote carried depth', async () => {
    stubScripMasterDownload();
    const withDepth = stubAdapter({
      segment: 'nse_depth',
      depth: () => ({
        bids: [
          { price: 99.5, size: 400 },
          { price: 99.4, size: 200 },
        ],
        asks: [
          { price: 100.5, size: 300 },
          { price: 100.6, size: 100 },
        ],
      }),
    });
    const feed = createLiveFeed({ adapter: withDepth.adapter, segment: 'nse_depth', symbols: ['RELIANCE'], pollMs: 0 });
    const published: string[] = [];
    feed.onBooks((books) => published.push(...books.map((book) => book.symbol)));

    await feed.poll();

    const book = feed.book('KOTAK:RELIANCE');
    expect(published).toEqual(['KOTAK:RELIANCE']);
    expect(book?.bids[0]).toMatchObject({ price: 99.5, size: 400, total: 39_800 });
    expect(book?.spread).toBeCloseTo(1, 6);

    // A quote without depth leaves the book absent rather than inventing one.
    const noDepth = stubAdapter({ segment: 'nse_nodepth' });
    const bare = createLiveFeed({ adapter: noDepth.adapter, segment: 'nse_nodepth', symbols: ['RELIANCE'], pollMs: 0 });
    await bare.poll();
    expect(bare.book('KOTAK:RELIANCE')).toBeNull();
  });
});

describe('bar persistence', () => {
  /** A store the test owns, so a "restart" is just a second feed over it. */
  function memoryStore(): {
    load: (symbol: string) => { bars: Candle[]; volume: number } | null;
    save: (symbol: string, snapshot: { bars: Candle[]; volume: number }) => void;
    has: (symbol: string) => boolean;
  } {
    const saved = new Map<string, { bars: Candle[]; volume: number }>();
    return {
      load: (symbol) => {
        const snapshot = saved.get(symbol);
        // Round-tripped like a real store, so the feed cannot depend on object
        // identity it would not have after a restart.
        return snapshot ? (JSON.parse(JSON.stringify(snapshot)) as { bars: Candle[]; volume: number }) : null;
      },
      save: (symbol, snapshot) => {
        saved.set(symbol, JSON.parse(JSON.stringify(snapshot)) as { bars: Candle[]; volume: number });
      },
      has: (symbol) => saved.has(symbol),
    };
  }

  it('writes accumulated bars through the store', async () => {
    stubScripMasterDownload();
    const store = memoryStore();
    const clock = 1_760_000_000_000;
    const { adapter } = stubAdapter({ segment: 'nse_store' });
    const feed = createLiveFeed({
      adapter,
      segment: 'nse_store',
      symbols: ['RELIANCE'],
      pollMs: 0,
      now: () => clock,
      store,
    });

    await feed.poll();
    expect(store.has('KOTAK:RELIANCE')).toBe(true);

    feed.stop();
    const snapshot = store.load('KOTAK:RELIANCE');
    expect(snapshot?.bars[0]?.c).toBe(100);
    // The cumulative-volume cursor is stored with the bars, not just the bars.
    expect(snapshot?.volume).toBe(0);
  });

  it('resumes the tape after a restart instead of clearing it', async () => {
    stubScripMasterDownload();
    const store = memoryStore();
    let clock = 1_760_000_000_000;
    let volume = 100;
    const { adapter } = stubAdapter({
      segment: 'nse_restart',
      quote: () => ({ lastPrice: 100, previousClose: 95, changePct: 5, volume }),
    });

    const first = createLiveFeed({
      adapter,
      segment: 'nse_restart',
      symbols: ['RELIANCE'],
      pollMs: 0,
      now: () => clock,
      store,
    });
    await first.poll();
    first.stop();
    const storedBars = store.load('KOTAK:RELIANCE')?.bars.length ?? 0;
    expect(storedBars).toBe(1);

    // A new process — new feed, empty in-memory state, same store.
    clock += 60_000;
    volume = 160;
    const second = createLiveFeed({
      adapter,
      segment: 'nse_restart',
      symbols: ['RELIANCE'],
      pollMs: 0,
      now: () => clock,
      store,
    });
    await second.poll();

    const bars = second.candles('KOTAK:RELIANCE', '1m', 10);
    expect(bars).toHaveLength(2);
    // Volume is a delta against the restored cumulative figure (160 − 100),
    // not the whole day re-booked into the new bar.
    expect(bars[1]?.v).toBe(60);
  });
});
