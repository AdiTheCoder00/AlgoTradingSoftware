import type {
  Candle,
  Instrument,
  LiveFeedStatus,
  LiveQuote,
  OrderBook,
  Tick,
  Timeframe,
} from '@kinetix/shared';

import { loadScripMaster, searchScripMaster } from '../brokers/scripMaster.ts';
import type { BrokerAdapter, BrokerQuote } from '../brokers/types.ts';

/* ============================================================================
 * Live NSE market data.
 *
 * Kotak's Trade API is not a market-data feed: quotes are pulled over REST, and
 * the response carries the day's move rather than a tick stream. So this service
 * polls a resolved watchlist, turns each response into a tick on the *same*
 * channel shape the simulator uses, and accumulates those ticks into 1-minute
 * bars. The terminal can then treat a live instrument exactly like a simulated
 * one for charting and the tape, with no special cases in the socket layer.
 *
 * Three deliberate limits, because guessing would be worse than admitting them:
 *
 *  - Only equities are watchable. Kotak rejects index tokens (`nse_cm|26000`) on
 *    the quote endpoint, so NIFTY/BANKNIFTY are not resolved here.
 *  - Depth is whatever the quote payload carries. The `all` quote is documented
 *    to return five levels a side; when a row arrives without them no book is
 *    published, because a synthesised ladder would be an invention.
 *  - Bars are built from the moment this process starts polling, because Kotak's
 *    REST surface here exposes no historical candles. They are persisted through
 *    a `LiveBarStore` so a restart continues the tape instead of erasing it.
 * ==========================================================================*/

import type { LiveBarStore } from './barStore.ts';

/**
 * Default watchlist: liquid NSE names. Each is resolved to its instrument token
 * through the scrip master at startup, and anything that does not resolve is
 * dropped rather than guessed at.
 */
export const DEFAULT_LIVE_WATCHLIST: readonly string[] = [
  'RELIANCE',
  'TCS',
  'INFY',
  'HDFCBANK',
  'ICICIBANK',
  'SBIN',
  'ITC',
  'LT',
  'AXISBANK',
  'KOTAKBANK',
];

/** Bar duration per chart timeframe, in milliseconds. */
const BAR_MS: Record<Timeframe, number> = {
  '1m': 60_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '1d': 86_400_000,
};

/** 1-minute bars retained per instrument (~8 hours of continuous polling). */
const HISTORY_BARS = 480;

export interface LiveFeed {
  /** Resolved instruments, in the same shape the simulator publishes. */
  instruments(): Instrument[];
  quotes(): LiveQuote[];
  quote(symbol: string): LiveQuote | null;
  /** Bars for a chart timeframe, aggregated from the collected 1-minute bars. */
  candles(symbol: string, timeframe: Timeframe, limit: number): Candle[];
  /** Latest book built from a quote's own depth, or null when it carried none. */
  book(symbol: string): OrderBook | null;
  status(): LiveFeedStatus;
  /** One poll cycle. Never throws: failures land in `status().lastError`. */
  poll(): Promise<Tick[]>;
  start(): void;
  stop(): void;
  onTicks(listener: (ticks: Tick[]) => void): () => void;
  /** Fires only for books rebuilt from fresh depth, so nothing is re-published idly. */
  onBooks(listener: (books: OrderBook[]) => void): () => void;
}

export interface LiveFeedOptions {
  adapter: BrokerAdapter;
  symbols?: readonly string[];
  pollMs?: number;
  /** Exchange segment to resolve against, e.g. `nse_cm`. */
  segment?: string;
  /** Clock override, so bar bucketing is replayable in a test. */
  now?: () => number;
  /** Persists accumulated bars so they survive a restart. */
  store?: LiveBarStore;
  /** How often a forming bar is written, in milliseconds. */
  saveIntervalMs?: number;
  log?: (message: string) => void;
}

/**
 * Kotak's `dTickSize` is scaled rather than decimal (RELIANCE reports 10). A
 * value that large cannot be a price increment in rupees, so it is read as
 * paise; anything small is taken at face value.
 */
function normaliseTickSize(reported: number): number {
  if (!Number.isFinite(reported) || reported <= 0) return 0.05;
  return reported > 5 ? Number((reported / 100).toFixed(4)) : reported;
}

/** Aggregate ascending 1-minute bars into a coarser timeframe. */
export function aggregateBars(bars: Candle[], timeframe: Timeframe, limit: number): Candle[] {
  const size = BAR_MS[timeframe];
  if (bars.length === 0) return [];
  if (size === BAR_MS['1m']) return bars.slice(-limit);

  const out: Candle[] = [];
  for (const bar of bars) {
    const bucket = Math.floor(bar.t / size) * size;
    const last = out[out.length - 1];
    if (last && last.t === bucket) {
      last.h = Math.max(last.h, bar.h);
      last.l = Math.min(last.l, bar.l);
      last.c = bar.c;
      last.v += bar.v;
    } else {
      out.push({ t: bucket, o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: bar.v });
    }
  }
  return out.slice(-limit);
}

export function createLiveFeed(options: LiveFeedOptions): LiveFeed {
  const { adapter } = options;
  const now = options.now ?? Date.now;
  const pollMs = options.pollMs ?? 3_000;
  const segment = options.segment ?? 'nse_cm';
  const store = options.store ?? null;
  const saveIntervalMs = options.saveIntervalMs ?? 10_000;
  const log = options.log ?? (() => {});

  const resolved: Instrument[] = [];
  /** Resolved instrument by internal symbol, for enriching each quote. */
  const bySymbol = new Map<string, Instrument>();
  const quotes = new Map<string, LiveQuote>();
  /** Ascending 1-minute bars per internal symbol. */
  const bars = new Map<string, Candle[]>();
  /** Latest depth-derived book per symbol. */
  const books = new Map<string, OrderBook>();
  /** Last cumulative day volume seen, so a bar's volume is a true delta. */
  const cumulativeVolume = new Map<string, number>();
  /** Last time each symbol was flushed to the store, for write throttling. */
  const lastSavedAt = new Map<string, number>();
  const listeners = new Set<(ticks: Tick[]) => void>();
  const bookListeners = new Set<(books: OrderBook[]) => void>();

  /**
   * Turn a quote's depth into the same book shape the simulator publishes, so
   * the terminal's ladder needs no second renderer and no venue-specific math.
   */
  const bookFromDepth = (
    instrument: Instrument,
    depth: NonNullable<BrokerQuote['depth']>,
    at: number,
  ): OrderBook | null => {
    const { bids, asks } = depth;
    if (bids.length === 0 || asks.length === 0) return null;

    const decimals = instrument.priceDecimals;
    const round = (value: number): number => Number(value.toFixed(decimals));
    const bestBid = bids[0]?.price ?? 0;
    const bestAsk = asks[0]?.price ?? 0;
    if (bestBid <= 0 || bestAsk <= 0) return null;

    const spread = round(bestAsk - bestBid);
    const mid = round((bestAsk + bestBid) / 2);
    return {
      symbol: instrument.symbol,
      bids: bids.map((level) => ({
        price: round(level.price),
        size: level.size,
        total: Number((level.price * level.size).toFixed(2)),
      })),
      asks: asks.map((level) => ({
        price: round(level.price),
        size: level.size,
        total: Number((level.price * level.size).toFixed(2)),
      })),
      spread,
      spreadPct: mid > 0 ? Number(((spread / mid) * 100).toFixed(4)) : 0,
      mid,
      ts: at,
    };
  };

  const persistBars = (symbol: string, at: number): void => {
    if (!store) return;
    store.save(symbol, { bars: bars.get(symbol) ?? [], volume: cumulativeVolume.get(symbol) ?? 0 });
    lastSavedAt.set(symbol, at);
  };

  let timer: NodeJS.Timeout | null = null;
  let lastPollAt: number | null = null;
  let lastError: string | null = null;
  let polls = 0;
  let ticks = 0;
  let resolveAttempted = false;
  let resolving: Promise<void> | null = null;

  const appendBar = (symbol: string, price: number, volume: number, at: number): void => {
    const bucket = Math.floor(at / BAR_MS['1m']) * BAR_MS['1m'];
    const series = bars.get(symbol) ?? [];

    // A bar's volume is the increase in the day's cumulative volume, not the
    // cumulative figure itself — but Kotak reports 0 while the market is closed
    // and resets at the open, so a decrease is treated as a reset.
    const previous = cumulativeVolume.get(symbol);
    const delta =
      previous === undefined || volume < previous ? volume : Math.max(0, volume - previous);
    cumulativeVolume.set(symbol, volume);

    const last = series[series.length - 1];
    const rolled = !last || last.t !== bucket;
    if (last && last.t === bucket) {
      last.h = Math.max(last.h, price);
      last.l = Math.min(last.l, price);
      last.c = price;
      last.v += delta;
    } else {
      series.push({ t: bucket, o: price, h: price, l: price, c: price, v: delta });
      if (series.length > HISTORY_BARS) series.splice(0, series.length - HISTORY_BARS);
    }
    bars.set(symbol, series);

    // A completed bar is written immediately — that is the durable unit. The
    // forming bar is only flushed every `saveIntervalMs`, because every poll
    // rewrites it and a write per poll would be pure disk churn.
    const savedAt = lastSavedAt.get(symbol) ?? 0;
    if (rolled || at - savedAt >= saveIntervalMs) persistBars(symbol, at);
  };

  const resolveInstruments = async (): Promise<void> => {
    if (resolving) return resolving;
    resolving = (async () => {
      const scripMaster = await loadScripMaster(adapter, { exchangeSegment: segment });
      const wanted = options.symbols ?? DEFAULT_LIVE_WATCHLIST;
      const seen = new Set<string>();

      for (const requested of wanted) {
        const [match] = searchScripMaster(scripMaster, requested, 1);
        // Only a genuine equity is watchable: Kotak's quote endpoint rejects
        // index tokens, and quoting the wrong series would be worse than
        // omitting the instrument.
        if (!match || seen.has(match.token) || match.group !== 'EQ') continue;
        seen.add(match.token);

        const instrument: Instrument = {
          // Namespaced by exchange. A live symbol can never be confused with a
          // simulator symbol, and a lookup failure stays visible rather than
          // silently resolving to the wrong venue.
          symbol: `KOTAK:${match.name}`,
          displayName: `${match.name} · NSE`,
          venue: 'kotakneo',
          venueLabel: 'Kotak Neo (NSE)',
          kind: 'equity',
          base: match.name,
          quote: 'INR',
          tickSize: normaliseTickSize(match.tickSize),
          priceDecimals: 2,
          instrumentToken: match.token,
          exchangeSegment: match.exchangeSegment,
          tradingSymbol: match.tradingSymbol,
        };
        // Resume the stored tape before any poll appends to it: without this a
        // restart would silently drop the history the terminal already showed.
        const restored = store?.load(instrument.symbol) ?? null;
        if (restored && restored.bars.length > 0) {
          bars.set(instrument.symbol, restored.bars.slice(-HISTORY_BARS));
          if (restored.volume > 0) cumulativeVolume.set(instrument.symbol, restored.volume);
        }

        resolved.push(instrument);
        bySymbol.set(instrument.symbol, instrument);
      }
      resolveAttempted = true;
      const restoredCount = [...bars.values()].reduce((acc, series) => acc + series.length, 0);
      log(
        `[live] resolved ${resolved.length}/${wanted.length} NSE instruments from the scrip master` +
          (restoredCount > 0 ? `, restored ${restoredCount} persisted bars` : ''),
      );
    })()
      .catch((error: unknown) => {
        // Keep `resolveAttempted` false so a later poll retries: the scrip master
        // download can fail transiently without the feed being permanently dead.
        lastError = `Could not resolve the NSE watchlist: ${error instanceof Error ? error.message : String(error)}`;
        log(`[live] ${lastError}`);
      })
      .finally(() => {
        resolving = null;
      });

    return resolving;
  };

  const poll = async (): Promise<Tick[]> => {
    if (resolved.length === 0 && !resolveAttempted) await resolveInstruments();
    if (resolved.length === 0) return [];

    if (!adapter.status().connected) {
      lastError = 'Kotak Neo session is not connected — log in to resume the live feed';
      return [];
    }

    try {
      const at = now();
      const responses = await adapter.quotes(
        resolved.map((instrument) => ({
          symbol: instrument.symbol,
          tradingSymbol: instrument.tradingSymbol ?? instrument.symbol,
          exchangeSegment: instrument.exchangeSegment ?? segment,
          ...(instrument.instrumentToken ? { instrumentToken: instrument.instrumentToken } : {}),
        })),
      );

      const frame: Tick[] = [];
      const freshBooks: OrderBook[] = [];
      const bucket = Math.floor(at / BAR_MS['1m']) * BAR_MS['1m'];

      for (const response of responses) {
        if (!(response.lastPrice > 0)) continue;
        const instrument = bySymbol.get(response.symbol);
        if (!instrument) continue;
        if (response.depth) {
          const book = bookFromDepth(instrument, response.depth, at);
          if (book) {
            books.set(instrument.symbol, book);
            freshBooks.push(book);
          }
        }
        const previous = quotes.get(response.symbol);
        quotes.set(response.symbol, {
          symbol: response.symbol,
          // Order routing needs Kotak's own trading symbol (`RELIANCE-EQ`), which
          // is not the internal symbol the terminal uses.
          tradingSymbol: instrument.tradingSymbol ?? response.symbol,
          instrumentToken: instrument.instrumentToken ?? '',
          exchangeSegment: instrument.exchangeSegment ?? segment,
          lastPrice: response.lastPrice,
          previousClose: response.previousClose,
          changePct: response.changePct,
          volume: response.volume,
          ts: at,
          tickCount: (previous?.tickCount ?? 0) + 1,
        });
        appendBar(response.symbol, response.lastPrice, response.volume, at);
        frame.push({ symbol: response.symbol, price: response.lastPrice, t: bucket, v: response.volume, ts: at });
      }

      lastPollAt = at;
      polls += 1;
      ticks += frame.length;
      lastError = null;

      for (const listener of listeners) listener(frame);
      if (freshBooks.length > 0) {
        for (const listener of bookListeners) listener(freshBooks);
      }
      return frame;
    } catch (error) {
      // A repeating poll must never reject into an unhandled rejection: the
      // failure is surfaced through the status payload instead.
      lastError = error instanceof Error ? error.message : String(error);
      return [];
    }
  };

  return {
    instruments: () => [...resolved],

    quotes: () => [...quotes.values()],

    quote: (symbol) => quotes.get(symbol) ?? null,

    candles: (symbol, timeframe, limit) => aggregateBars(bars.get(symbol) ?? [], timeframe, limit),

    book: (symbol) => books.get(symbol) ?? null,

    status: () => ({
      enabled: pollMs > 0,
      connected: adapter.status().connected,
      pollMs,
      lastPollAt,
      lastError,
      instruments: resolved.length,
      polls,
      ticks,
    }),

    poll,

    start: () => {
      if (timer) return;
      if (pollMs <= 0) return;
      timer = setInterval(() => void poll(), pollMs);
      // Do not hold the process open purely for the quote clock.
      timer.unref?.();
      void poll();
      log(`[live] polling ${pollMs}ms for ${(options.symbols ?? DEFAULT_LIVE_WATCHLIST).length} NSE symbols`);
    },

    stop: () => {
      if (timer) clearInterval(timer);
      timer = null;
      // Final flush: the forming bar at shutdown is otherwise lost, and with it
      // up to a minute of the operator's most recent tape.
      if (store) {
        for (const symbol of bars.keys()) persistBars(symbol, now());
      }
    },

    onTicks: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    onBooks: (listener) => {
      bookListeners.add(listener);
      return () => bookListeners.delete(listener);
    },
  };
}
