import type { BrokerOrderResult, BrokerStatus, Position } from '@kinetix/shared';

/* ============================================================================
 * Broker adapter contract.
 *
 * The engine talks to venues through this interface, so the simulated venue and
 * a real brokerage are interchangeable. Order/position shapes are Kotak Neo's
 * own field set, normalised into a small internal type rather than leaking
 * broker-specific JSON into the trading engine.
 * ==========================================================================*/

export interface BrokerOrderRequest {
  /** Internal symbol, e.g. `KOTAK:RELIANCE`. */
  symbol: string;
  tradingSymbol: string;
  exchangeSegment: string;
  side: 'buy' | 'sell';
  quantity: number;
  orderType: 'market' | 'limit';
  price?: number;
  product?: string;
  validity?: string;
  tag?: string;
  /** Kotak instrument token, resolved from the scrip master. */
  instrumentToken?: string;
}

export interface BrokerQuote {
  symbol: string;
  lastPrice: number;
  previousClose: number;
  changePct: number;
  volume: number;
  ts: number;
  /**
   * Aggregated market depth, when the venue supplies it. Kotak's `all` quote
   * carries up to five price levels per side; a venue that returns none leaves
   * this absent rather than pretending to have a book.
   */
  depth?: {
    bids: Array<{ price: number; size: number }>;
    asks: Array<{ price: number; size: number }>;
  };
}

export interface BrokerPosition {
  symbol: string;
  tradingSymbol: string;
  quantity: number;
  averagePrice: number;
  lastPrice: number;
  pnl: number;
  product: string;
}

/**
 * One order as the venue itself reports it, normalised.
 *
 * Live orders are accepted asynchronously, so the terminal's own record of an
 * order is only a claim about it — this is the shape reconciliation compares
 * that claim against.
 */
export interface BrokerOrderState {
  /** Venue order number, the join key back to the local order row. */
  orderId: string;
  /** Null when the venue reports a status this adapter does not recognise. */
  status: 'working' | 'filled' | 'partially_filled' | 'cancelled' | 'rejected' | null;
  quantity: number;
  filledQuantity: number;
  averagePrice: number | null;
  /** Venue trading symbol, e.g. `RELIANCE-EQ`. */
  symbol: string;
  side: 'buy' | 'sell';
  rejectReason: string | null;
  product: string;
  /** Venue update time in epoch ms, when it can be parsed. */
  ts: number | null;
}

export interface BrokerLimits {
  netMarginAvailable: number;
  collateral: number;
  utilisedMargin: number;
}

export interface BrokerAdapter {
  readonly id: 'kotakneo';
  readonly label: string;
  isConfigured(): boolean;
  missingEnv(): string[];
  status(): BrokerStatus;
  /** Two-factor login: TOTP first, then MPIN. */
  login(input: { totp?: string; mpin?: string }): Promise<BrokerStatus>;
  logout(): Promise<void>;
  /**
   * Quotes by `exchange_segment|instrument_token`. Kotak does not accept a
   * trading symbol here, so `instrumentToken` is required in practice even
   * though the type keeps it optional for callers that have not resolved one.
   */
  quotes(requests: Array<QuoteRequest>): Promise<BrokerQuote[]>;
  positions(): Promise<BrokerPosition[]>;
  limits(): Promise<BrokerLimits>;
  holdings(): Promise<Array<Record<string, unknown>>>;
  /**
   * Kotak publishes date-stamped scrip-master CSVs; this returns the current
   * links rather than a hardcoded path, since the filenames change daily.
   */
  scripMasterFilePaths(): Promise<string[]>;
  placeOrder(request: BrokerOrderRequest): Promise<BrokerOrderResult>;
  cancelOrder(orderId: string): Promise<BrokerOrderResult>;
  orderBook(): Promise<Array<Record<string, unknown>>>;
  /** The same order book, normalised — the input to reconciliation. */
  orders(): Promise<BrokerOrderState[]>;
  /** Latency of the most recent successful round trip, in milliseconds. */
  lastLatencyMs(): number | null;
}

export interface QuoteRequest {
  /** Internal symbol, e.g. `RELIANCE`. */
  symbol: string;
  tradingSymbol: string;
  /** Kotak exchange segment, e.g. `nse_cm`. */
  exchangeSegment: string;
  /** Instrument token from the scrip master, e.g. `2885`. */
  instrumentToken?: string;
}

export interface BrokerSessionState {
  viewToken: string | null;
  sid: string | null;
  sessionToken: string | null;
  /** Per-account REST host returned by Kotak during MPIN validation. */
  baseUrl: string | null;
  /** Per-account market-data WebSocket host from the same response. */
  feedUrl: string | null;
  /** Per-account order/position feed host. */
  rtUrl: string | null;
  connectedAt: number | null;
  expiresAt: number | null;
}

export const toSharedPosition = (position: BrokerPosition): Position => ({
  id: `broker_${position.tradingSymbol}`,
  symbol: position.symbol,
  side: position.quantity >= 0 ? 'long' : 'short',
  strategyId: 'broker',
  strategyName: 'Broker Book',
  size: Math.abs(position.quantity),
  entryPrice: position.averagePrice,
  markPrice: position.lastPrice,
  leverage: 1,
  notionalUsd: Math.abs(position.quantity) * position.lastPrice,
  unrealizedPnlUsd: position.pnl,
  unrealizedPnlPct: position.averagePrice > 0 ? ((position.lastPrice / position.averagePrice - 1) * 100) : 0,
  realizedPnlUsd: 0,
  liquidationPrice: null,
  openedAt: Date.now(),
  venue: 'kotakneo',
});
