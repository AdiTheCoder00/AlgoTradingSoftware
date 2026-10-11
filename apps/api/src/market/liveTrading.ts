import type { Fill, Order, PlaceOrderRequest, Position } from '@kinetix/shared';

import type { BrokerAdapter, BrokerOrderState, BrokerPosition } from '../brokers/types.ts';
import {
  getDb,
  kvGet,
  kvSet,
  newId,
  nullable,
  numericOrNull,
  recordAuditEvent,
  recordRiskEvent,
} from '../db/db.ts';
import { MANUAL_STRATEGY_ID } from '../db/schema.ts';
import type { LiveFeed } from './liveFeed.ts';

/* ============================================================================
 * Live (NSE) order routing.
 *
 * The ticket on a live symbol has exactly two honest destinations, and this
 * module is the fork between them:
 *
 *  - `paper` (the default): fill at the live quote and keep the position in the
 *    live book. This is what makes the ticket usable without risking money —
 *    and it fills at a *real* price rather than a simulated one.
 *  - `live`: forward the order to Kotak Neo through the broker adapter. This is
 *    never implicit: the mode is stored opt-in state, threads through the
 *    request, and needs a connected session before anything is sent.
 *
 * The live book is deliberately isolated from the simulated one:
 *
 *  - Its positions live in the same `positions` table under the `kotakneo`
 *    venue, and the simulated portfolio filters that venue out. A rupee P&L
 *    must never mix with the USD book's equity, drawdown or 30-day record.
 *  - Its fills are recorded for audit but never written to `closed_trades`, so
 *    live practice cannot move the simulator's win rate.
 * ==========================================================================*/

export type LiveRouting = 'paper' | 'live';

/** kv key holding the routing opt-in, so a restart does not silently re-arm it. */
const ROUTING_KEY = 'live:routing';

const LIVE_VENUE = 'kotakneo' as const;

/**
 * Pseudo-strategy for positions mirrored from the venue itself.
 *
 * They share the `positions` table with the paper desk's own rows, so the two
 * are told apart by origin: this id means "the broker holds this, and these are
 * the last figures it reported", not "this terminal filled it".
 */
const BROKER_STRATEGY_ID = 'broker';

/** What one reconciliation pass changed. */
export interface ReconcileResult {
  ok: boolean;
  error: string | null;
  /** Live orders the venue also knew about. */
  checkedOrders: number;
  /** Orders whose status, fill or price moved. */
  updatedOrders: number;
  /** Genuine venue fills booked into the local ledger. */
  bookedFills: number;
  createdPositions: number;
  updatedPositions: number;
  closedPositions: number;
  at: number;
}

export interface LiveOrderSuccess {
  kind: 'order';
  order: Order;
  /** Present for a paper fill; a live-routed order has no local fill yet. */
  fill: Fill | null;
  position: Position | null;
  message: string;
}

export interface LiveOrderRejection {
  kind: 'rejected';
  code: string;
  reason: string;
  /** Suggested HTTP status for the route that surfaced this. */
  httpStatus: 400 | 404 | 409 | 502;
}

export type LiveOrderOutcome = LiveOrderSuccess | LiveOrderRejection;

export interface LiveTradingStatus {
  mode: LiveRouting;
  connected: boolean;
  brokerConfigured: boolean;
  paperPositions: number;
  workingOrders: number;
}

export interface LiveTradingService {
  /** Whether the live feed knows this symbol at all. */
  knows(symbol: string): boolean;
  mode(): LiveRouting;
  setMode(mode: LiveRouting, actor: string): LiveRouting;
  status(): LiveTradingStatus;
  /** This terminal's own paper fills. */
  positions(): Position[];
  /** Positions mirrored from the venue, marked from the live feed. */
  brokerPositions(): Position[];
  workingOrders(): Order[];
  /**
   * Compare local live orders against the venue's own order book and position
   * book, booking fills the venue reports. Never invents a state: a status the
   * adapter does not recognise leaves the local order untouched.
   */
  reconcile(actor?: string): Promise<ReconcileResult>;
  placeOrder(request: PlaceOrderRequest, routing: LiveRouting | undefined, actor: string): Promise<LiveOrderOutcome>;
  cancelOrder(orderId: string, actor: string): Promise<{ order: Order } | { error: string } | null>;
  /** Close a paper live position at the current quote. */
  closePaperPosition(positionId: string, actor: string): Promise<LiveOrderOutcome | null>;
  /** Close a position held at Kotak itself, with an opposing live order. */
  closeBrokerPosition(symbol: string, actor: string): Promise<LiveOrderOutcome>;
}

interface LivePositionRow {
  id: string;
  symbol: string;
  side: 'long' | 'short';
  size: number;
  entryPrice: number;
  leverage: number;
  realizedPnlUsd: number;
  openedAt: number;
  /** `manual` for a paper fill, `broker` for a mirrored venue position. */
  strategyId: string;
}

interface LiveOrderRow {
  id: string;
  symbol: string;
  side: 'buy' | 'sell';
  type: 'market' | 'limit';
  quantity: number;
  price: number | null;
  filledQuantity: number;
  averageFillPrice: number | null;
  status: Order['status'];
  leverage: number;
  venueOrderId: string | null;
  rejectReason: string | null;
  strategyId: string;
  createdAt: number;
  updatedAt: number;
}

export interface LiveTradingOptions {
  feed: LiveFeed;
  adapter: BrokerAdapter;
}

export function createLiveTradingService(options: LiveTradingOptions): LiveTradingService {
  const { feed, adapter } = options;
  const db = getDb();

  let positions: LivePositionRow[] = [];
  let workingPaperOrders: LiveOrderRow[] = [];
  /**
   * Consecutive reconciliation passes in which the venue reported no position
   * for a mirrored row. Service scope, not pass scope: the whole point is that
   * one absence is tolerated and two are not.
   */
  const missingMirrorStreak = new Map<string, number>();
  /** Symbols the feed has resolved, kept as a set for O(1) routing checks. */
  const knownSymbols = new Set<string>();

  const mode = (): LiveRouting => (kvGet(ROUTING_KEY) === 'live' ? 'live' : 'paper');

  const quotePrice = (symbol: string): number => Number(feed.quote(symbol)?.lastPrice ?? 0);

  const specDecimals = (symbol: string): number =>
    feed.instruments().find((instrument) => instrument.symbol === symbol)?.priceDecimals ?? 2;

  /* ------------------------------ persistence ------------------------------ */

  const loadPositions = (): void => {
    positions = db
      .prepare(
        `SELECT id, symbol, side, size, entry_price AS entryPrice, leverage,
                realized_pnl_usd AS realizedPnlUsd, opened_at AS openedAt, strategy_id AS strategyId
         FROM positions WHERE venue = ?`,
      )
      .all(LIVE_VENUE) as unknown as LivePositionRow[];
  };

  const loadWorkingOrders = (): void => {
    workingPaperOrders = (
      db
        .prepare(
          `SELECT id, symbol, side, type, quantity, price, filled_quantity AS filledQuantity,
                  average_fill_price AS averageFillPrice, status, leverage, venue_order_id AS venueOrderId,
                  reject_reason AS rejectReason, strategy_id AS strategyId,
                  created_at AS createdAt, updated_at AS updatedAt
           FROM orders WHERE venue = ? AND status = 'working'`,
        )
        .all(LIVE_VENUE) as unknown as LiveOrderRow[]
    ).filter((row) => !row.venueOrderId);
  };

  loadPositions();
  loadWorkingOrders();

  const persistPosition = (row: LivePositionRow): void => {
    db.prepare(
      `INSERT INTO positions (id, symbol, side, strategy_id, size, entry_price, leverage, realized_pnl_usd, opened_at, venue)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET size = excluded.size, entry_price = excluded.entry_price,
         leverage = excluded.leverage, realized_pnl_usd = excluded.realized_pnl_usd`,
    ).run(
      row.id,
      row.symbol,
      row.side,
      row.strategyId,
      row.size,
      row.entryPrice,
      row.leverage,
      row.realizedPnlUsd,
      row.openedAt,
      LIVE_VENUE,
    );
  };

  const persistOrder = (row: LiveOrderRow): void => {
    db.prepare(
      `INSERT INTO orders (id, symbol, side, type, quantity, price, filled_quantity, average_fill_price, status,
         strategy_id, venue, leverage, venue_order_id, reject_reason, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET filled_quantity = excluded.filled_quantity,
         average_fill_price = excluded.average_fill_price, status = excluded.status,
         venue_order_id = excluded.venue_order_id, reject_reason = excluded.reject_reason,
         updated_at = excluded.updated_at`,
    ).run(
      row.id,
      row.symbol,
      row.side,
      row.type,
      row.quantity,
      numericOrNull(row.price),
      row.filledQuantity,
      numericOrNull(row.averageFillPrice),
      row.status,
      row.strategyId,
      LIVE_VENUE,
      row.leverage,
      nullable(row.venueOrderId),
      nullable(row.rejectReason),
      row.createdAt,
      row.updatedAt,
    );
  };

  /** Append a fill row. Never touches `closed_trades` or the portfolio ledger. */
  const persistFill = (fill: Fill): void => {
    db.prepare(
      `INSERT INTO fills (id, order_id, symbol, side, quantity, price, slippage_bps, effect,
         realized_pnl_usd, strategy_id, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      fill.id,
      fill.orderId,
      fill.symbol,
      fill.side,
      fill.quantity,
      fill.price,
      fill.slippageBps,
      fill.effect,
      fill.realizedPnlUsd,
      fill.strategyId,
      fill.ts,
    );
  };

  /* -------------------------------- mapping -------------------------------- */

  const toOrder = (row: LiveOrderRow): Order => ({
    id: row.id,
    symbol: row.symbol,
    side: row.side,
    type: row.type,
    quantity: row.quantity,
    price: row.price,
    filledQuantity: row.filledQuantity,
    averageFillPrice: row.averageFillPrice,
    status: row.status,
    strategyId: row.strategyId,
    strategyName: 'Live Desk Ticket',
    venue: LIVE_VENUE,
    venueOrderId: row.venueOrderId,
    rejectReason: row.rejectReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

  const toPosition = (row: LivePositionRow): Position => {
    const decimals = specDecimals(row.symbol);
    const mark = quotePrice(row.symbol) || row.entryPrice;
    const direction = row.side === 'long' ? 1 : -1;
    const round = (value: number): number => Number(value.toFixed(decimals));
    return {
      id: row.id,
      symbol: row.symbol,
      side: row.side,
      strategyId: row.strategyId,
      strategyName: row.strategyId === BROKER_STRATEGY_ID ? 'Kotak Broker' : 'Live Paper',
      size: Number(row.size.toFixed(6)),
      entryPrice: round(row.entryPrice),
      markPrice: round(mark),
      leverage: row.leverage,
      notionalUsd: Number((mark * row.size).toFixed(2)),
      unrealizedPnlUsd: Number(((mark - row.entryPrice) * row.size * direction).toFixed(2)),
      unrealizedPnlPct: Number((((mark - row.entryPrice) / row.entryPrice) * 100 * direction).toFixed(2)),
      realizedPnlUsd: Number(row.realizedPnlUsd.toFixed(2)),
      liquidationPrice: null,
      openedAt: row.openedAt,
      venue: LIVE_VENUE,
    };
  };

  /* ------------------------------- paper book ------------------------------ */

  const createOrderRow = (input: {
    symbol: string;
    side: 'buy' | 'sell';
    type: 'market' | 'limit';
    quantity: number;
    price: number | null;
    leverage: number;
    venueOrderId: string | null;
  }): LiveOrderRow => {
    const now = Date.now();
    return {
      id: newId('ord'),
      symbol: input.symbol,
      side: input.side,
      type: input.type,
      quantity: input.quantity,
      price: input.price,
      filledQuantity: 0,
      averageFillPrice: null,
      status: 'working',
      leverage: input.leverage,
      venueOrderId: input.venueOrderId,
      rejectReason: null,
      strategyId: MANUAL_STRATEGY_ID,
      createdAt: now,
      updatedAt: now,
    };
  };

  const tradingSymbolFor = (symbol: string): string =>
    feed.instruments().find((instrument) => instrument.symbol === symbol)?.tradingSymbol ?? symbol;

  const internalSymbolFor = (tradingSymbol: string): string =>
    feed.instruments().find((instrument) => instrument.tradingSymbol === tradingSymbol)?.symbol ?? tradingSymbol;

  /**
   * Book a fill into one of the two live books and net it into its positions.
   *
   * Deliberately mirrors the simulated book's entry/exit/reversal arithmetic but
   * stays out of its ledger: rupee P&L is recorded on the live rows only. The
   * origin decides which book — a paper fill this terminal made, or a genuine
   * venue fill being materialised — and mirrored rows are keyed by the venue's
   * own trading symbol so reconciliation always updates the same row.
   */
  const applyLiveFill = (
    order: LiveOrderRow,
    price: number,
    quantity: number,
    ts: number,
    origin: 'paper' | 'broker',
  ): { fill: Fill; position: Position | null } => {
    const strategyId = origin === 'broker' ? BROKER_STRATEGY_ID : MANUAL_STRATEGY_ID;
    const freshId = (): string =>
      origin === 'broker' ? `broker_${tradingSymbolFor(order.symbol)}` : newId('lpos');
    const existing = positions.find((row) => row.symbol === order.symbol && row.strategyId === strategyId);
    const wantsLong = order.side === 'buy';
    let realized = 0;
    let effect: 'entry' | 'exit' = 'entry';

    if (!existing) {
      const created: LivePositionRow = {
        id: freshId(),
        symbol: order.symbol,
        side: wantsLong ? 'long' : 'short',
        size: quantity,
        entryPrice: price,
        leverage: Math.max(1, order.leverage),
        realizedPnlUsd: 0,
        openedAt: ts,
        strategyId,
      };
      positions.push(created);
      persistPosition(created);
    } else {
      const sameDirection = (existing.side === 'long') === wantsLong;
      if (sameDirection) {
        const newSize = existing.size + quantity;
        existing.entryPrice = (existing.entryPrice * existing.size + price * quantity) / newSize;
        existing.size = newSize;
        persistPosition(existing);
      } else {
        const closing = Math.min(existing.size, quantity);
        const direction = existing.side === 'long' ? 1 : -1;
        realized = (price - existing.entryPrice) * closing * direction;
        effect = 'exit';
        existing.size -= closing;
        existing.realizedPnlUsd += realized;
        if (existing.size <= 1e-9) {
          db.prepare('DELETE FROM positions WHERE id = ?').run(existing.id);
          positions = positions.filter((row) => row.id !== existing.id);
        } else {
          persistPosition(existing);
        }

        const remainder = quantity - closing;
        if (remainder > 1e-9) {
          const flipped: LivePositionRow = {
            id: freshId(),
            symbol: order.symbol,
            side: wantsLong ? 'long' : 'short',
            size: remainder,
            entryPrice: price,
            leverage: Math.max(1, order.leverage),
            realizedPnlUsd: 0,
            openedAt: ts,
            strategyId,
          };
          positions.push(flipped);
          persistPosition(flipped);
        }
      }
    }

    const fill: Fill = {
      id: newId('fill'),
      orderId: order.id,
      symbol: order.symbol,
      side: order.side,
      quantity,
      price: Number(price.toFixed(specDecimals(order.symbol))),
      // A paper fill pays the quoted touch plus a small model spread — the
      // queue-free fill is still not a perfect touch.
      slippageBps: 1.5,
      effect,
      realizedPnlUsd: Number(realized.toFixed(2)),
      strategyId: order.strategyId,
      ts,
    };
    persistFill(fill);

    order.filledQuantity += quantity;
    order.averageFillPrice = fill.price;
    // A fill that does not cover the ticket leaves the order partially filled;
    // reconciliation then corrects it from the venue's own book.
    order.status = order.filledQuantity + 1e-9 >= order.quantity ? 'filled' : 'partially_filled';
    order.updatedAt = ts;
    order.price = order.price ?? null;
    persistOrder(order);

    const position = positions.find((row) => row.symbol === order.symbol && row.strategyId === strategyId) ?? null;
    return { fill, position: position ? toPosition(position) : null };
  };

  const activeSymbol = (symbol: string): boolean => {
    if (knownSymbols.has(symbol)) return true;
    // The feed resolves its watchlist lazily, so re-check the live instrument
    // list rather than caching a set that may have been populated before the
    // first poll completed.
    for (const instrument of feed.instruments()) knownSymbols.add(instrument.symbol);
    return knownSymbols.has(symbol);
  };

  const reject = (
    code: string,
    reason: string,
    httpStatus: LiveOrderRejection['httpStatus'] = 409,
  ): LiveOrderRejection => ({ kind: 'rejected', code, reason, httpStatus });

  const resolveQuantity = (request: PlaceOrderRequest, price: number): number => {
    if (request.quantity !== undefined && request.quantity > 0) return request.quantity;
    if (request.notionalUsd !== undefined && request.notionalUsd > 0 && price > 0) {
      return Number((request.notionalUsd / price).toFixed(6));
    }
    return 0;
  };

  const invalidQuantity = (): LiveOrderRejection =>
    reject(
      'invalid_quantity',
      'Give the order a share quantity (NSE trades in shares). The USD notional slider does not apply to rupee instruments.',
      400,
    );

  /* --------------------------------- routing -------------------------------- */

  const placeLive = async (
    request: PlaceOrderRequest,
    actor: string,
    quantity: number,
  ): Promise<LiveOrderOutcome> => {
    const instrument = feed.instruments().find((candidate) => candidate.symbol === request.symbol);
    if (!instrument) {
      return reject('unknown_instrument', `${request.symbol} is not a resolved live instrument`, 404);
    }
    if (!adapter.status().connected) {
      return reject(
        'broker_not_connected',
        'Kotak Neo session is not connected — log in from Risk & Fleet before routing a live order',
      );
    }
    if (!instrument.instrumentToken || !instrument.tradingSymbol || !instrument.exchangeSegment) {
      return reject('instrument_unresolved', `${request.symbol} has no Kotak token — refresh the scrip master`);
    }

    const row = createOrderRow({
      symbol: request.symbol,
      side: request.side,
      type: request.type,
      quantity,
      price: request.type === 'limit' ? (request.price ?? null) : null,
      leverage: request.leverage ?? 1,
      venueOrderId: null,
    });

    const result = await adapter.placeOrder({
      symbol: request.symbol,
      tradingSymbol: instrument.tradingSymbol,
      exchangeSegment: instrument.exchangeSegment,
      side: request.side,
      quantity,
      orderType: request.type,
      ...(request.type === 'limit' && request.price !== undefined ? { price: request.price } : {}),
      // Intraday by default: a live desk ticket is a trade, not a delivery
      // instruction, and the operator can override the product later.
      product: 'MIS',
      validity: 'DAY',
      tag: 'KINETIX',
      ...(instrument.instrumentToken ? { instrumentToken: instrument.instrumentToken } : {}),
    });

    if (!result.ok || !result.orderId) {
      recordRiskEvent({
        kind: 'order_rejected',
        severity: 'warning',
        message: `Kotak rejected a live ${request.side} order for ${request.symbol}`,
        detail: result.message,
      });
      recordAuditEvent({
        actor,
        action: 'live_order',
        target: `${request.symbol} ${request.side} ${quantity}`,
        result: 'rejected',
        detail: result.message,
      });
      return reject('broker_rejected', result.message, 502);
    }

    row.venueOrderId = result.orderId;
    // Kotak accepts asynchronously; the order is working until its book says
    // otherwise, and claiming it filled would be a lie the operator could act on.
    row.status = 'working';
    persistOrder(row);

    recordRiskEvent({
      kind: 'broker',
      severity: 'info',
      message: `Live order routed to Kotak Neo: ${request.side.toUpperCase()} ${quantity} ${instrument.tradingSymbol}`,
      detail: `Order ${result.orderId}`,
    });
    recordAuditEvent({
      actor,
      action: 'live_order',
      target: `${request.symbol} ${request.side} ${quantity}`,
      result: 'ok',
      detail: `Kotak order ${result.orderId}`,
    });

    return {
      kind: 'order',
      order: toOrder(row),
      fill: null,
      position: null,
      message: `Sent to Kotak Neo as ${result.orderId}`,
    };
  };

  const placePaper = (
    request: PlaceOrderRequest,
    actor: string,
    quantity: number,
    price: number,
  ): LiveOrderOutcome => {
    const limitPrice = request.type === 'limit' ? (request.price ?? null) : null;
    const marketable =
      request.type === 'market' ||
      (limitPrice !== null && (request.side === 'buy' ? limitPrice >= price : limitPrice <= price));

    const row = createOrderRow({
      symbol: request.symbol,
      side: request.side,
      type: request.type,
      quantity,
      price: limitPrice,
      leverage: request.leverage ?? 1,
      venueOrderId: null,
    });

    if (!marketable) {
      persistOrder(row);
      workingPaperOrders.push(row);
      recordAuditEvent({
        actor,
        action: 'paper_live_order',
        target: `${request.symbol} ${request.side} ${quantity}`,
        result: 'ok',
        detail: `Resting limit at ${limitPrice}, live quote ${price}`,
      });
      return {
        kind: 'order',
        order: toOrder(row),
        fill: null,
        position: null,
        message: `Paper limit resting at ${limitPrice} — fills when the tape crosses`,
      };
    }

    // A marketable order fills at the quote (or at the limit when it is the
    // better price, as a real one would).
    const fillPrice = limitPrice !== null && (request.side === 'buy' ? limitPrice < price : limitPrice > price) ? limitPrice : price;
    const { fill, position } = applyLiveFill(row, fillPrice, quantity, Date.now(), 'paper');
    recordAuditEvent({
      actor,
      action: 'paper_live_order',
      target: `${request.symbol} ${request.side} ${quantity}`,
      result: 'ok',
      detail: `Paper fill at ${fill.price}`,
    });
    return {
      kind: 'order',
      order: toOrder(row),
      fill,
      position,
      message: `Paper fill at the live quote`,
    };
  };

  /* ---------------------------- working-order tick --------------------------- */

  const checkWorkingOrders = (): void => {
    for (const order of [...workingPaperOrders]) {
      const price = quotePrice(order.symbol);
      if (!(price > 0) || order.price === null) continue;
      const crossed = order.side === 'buy' ? price <= order.price : price >= order.price;
      if (!crossed) continue;

      workingPaperOrders = workingPaperOrders.filter((candidate) => candidate.id !== order.id);
      applyLiveFill(order, order.price, order.quantity, Date.now(), 'paper');
      recordAuditEvent({
        actor: 'live-feed',
        action: 'paper_live_order',
        target: `${order.symbol} ${order.side} ${order.quantity}`,
        result: 'ok',
        detail: `Resting limit filled at ${order.price}`,
      });
    }
  };

  /* ------------------------------ reconciliation ----------------------------- */

  const runReconcile = async (actor: string): Promise<ReconcileResult> => {
    const result: ReconcileResult = {
      ok: true,
      error: null,
      checkedOrders: 0,
      updatedOrders: 0,
      bookedFills: 0,
      createdPositions: 0,
      updatedPositions: 0,
      closedPositions: 0,
      at: Date.now(),
    };

    if (!adapter.status().connected) {
      result.ok = false;
      result.error = 'Kotak Neo session is not connected — reconciliation needs a live session';
      return result;
    }

    let states: BrokerOrderState[];
    try {
      states = await adapter.orders();
    } catch (error) {
      result.ok = false;
      result.error = error instanceof Error ? error.message : String(error);
      return result;
    }

    // ---- orders: the venue's word replaces our guess about it ----
    const stateById = new Map(states.map((state) => [state.orderId, state]));
    /** Mirrors a fill created moments ago, which the venue's book may not list yet. */
    const touchedThisPass = new Set<string>();
    const liveRows = db
      .prepare(
        `SELECT id, symbol, side, type, quantity, price, filled_quantity AS filledQuantity,
                average_fill_price AS averageFillPrice, status, leverage, venue_order_id AS venueOrderId,
                reject_reason AS rejectReason, strategy_id AS strategyId,
                created_at AS createdAt, updated_at AS updatedAt
         FROM orders
         WHERE venue = ? AND venue_order_id IS NOT NULL AND status IN ('working', 'partially_filled')`,
      )
      .all(LIVE_VENUE) as unknown as LiveOrderRow[];

    for (const row of liveRows) {
      const state = row.venueOrderId ? stateById.get(row.venueOrderId) : undefined;
      // An order the venue no longer lists is left exactly as it is; only the
      // venue can say what happened to it, and guessing would be worse than stale.
      if (!state) continue;
      result.checkedOrders += 1;

      // Booked fills advance the row in place, so the "did anything change?"
      // comparison has to run against a snapshot taken before the fill.
      const beforeStatus = row.status;
      const beforeFilled = row.filledQuantity;
      const beforeAverage = row.averageFillPrice;
      const beforeReason = row.rejectReason;

      const price = state.averagePrice ?? beforeAverage ?? row.price ?? 0;
      const delta = Math.max(0, state.filledQuantity - beforeFilled);
      if (delta > 0 && price > 0) {
        const booked = applyLiveFill(row, price, delta, state.ts ?? Date.now(), 'broker');
        if (booked.position) touchedThisPass.add(booked.position.id);
        result.bookedFills += 1;
      }

      const nextStatus = state.status ?? beforeStatus;
      const nextFilled = Math.max(beforeFilled, state.filledQuantity);
      const nextAverage = price > 0 ? price : beforeAverage;
      const nextReason = state.rejectReason ?? beforeReason;
      if (
        nextStatus !== beforeStatus ||
        nextFilled !== beforeFilled ||
        nextAverage !== beforeAverage ||
        nextReason !== beforeReason
      ) {
        row.status = nextStatus;
        row.filledQuantity = nextFilled;
        row.averageFillPrice = nextAverage;
        row.rejectReason = nextReason;
        row.updatedAt = Date.now();
        persistOrder(row);
        result.updatedOrders += 1;

        recordAuditEvent({
          actor,
          action: 'live_reconcile',
          target: row.venueOrderId ?? row.id,
          result: 'ok',
          detail: `${row.symbol} ${row.side} is ${nextStatus} at the venue${nextFilled > 0 ? `, ${nextFilled} filled` : ''}`,
        });
        if (nextStatus === 'filled') {
          recordRiskEvent({
            kind: 'broker',
            severity: 'info',
            message: `Kotak filled ${row.side} ${nextFilled} ${row.symbol}`,
            detail: `Order ${row.venueOrderId}`,
            ...(nextAverage !== null && nextAverage > 0 ? { value: nextAverage } : {}),
          });
        }
        if (nextStatus === 'rejected') {
          recordRiskEvent({
            kind: 'order_rejected',
            severity: 'warning',
            message: `Kotak rejected the ${row.side} order for ${row.symbol}`,
            detail: nextReason ?? 'The venue gave no reason',
          });
        }
      }
    }

    // ---- positions: mirror the venue's book so it is marked and closable ----
    let reported: BrokerPosition[];
    try {
      reported = await adapter.positions();
    } catch {
      // A position-book failure must not undo the order reconciliation above.
      return result;
    }

    for (const row of positions.filter((candidate) => candidate.strategyId === BROKER_STRATEGY_ID)) {
      // A fill booked in this same pass may not appear in the venue's position
      // book yet; dropping it here would erase a real fill and then re-create it.
      if (touchedThisPass.has(row.id)) {
        missingMirrorStreak.delete(row.id);
        continue;
      }
      const match = reported.find(
        (candidate) =>
          candidate.tradingSymbol === tradingSymbolFor(row.symbol) ||
          candidate.tradingSymbol === row.symbol ||
          candidate.symbol === row.symbol,
      );
      if (!match || match.quantity === 0) {
        const streak = (missingMirrorStreak.get(row.id) ?? 0) + 1;
        missingMirrorStreak.set(row.id, streak);
        // One absence is often a position book that has not settled yet; two in
        // a row means the venue really does not hold it any more.
        if (streak < 2) continue;
        missingMirrorStreak.delete(row.id);
        db.prepare('DELETE FROM positions WHERE id = ?').run(row.id);
        positions = positions.filter((candidate) => candidate.id !== row.id);
        result.closedPositions += 1;
        recordAuditEvent({
          actor,
          action: 'live_reconcile',
          target: row.id,
          result: 'ok',
          detail: `The venue no longer reports a position in ${row.symbol}; the mirror was removed`,
        });
        continue;
      }
      missingMirrorStreak.delete(row.id);
      const size = Math.abs(match.quantity);
      const side: 'long' | 'short' = match.quantity > 0 ? 'long' : 'short';
      if (size !== row.size || match.averagePrice !== row.entryPrice || side !== row.side) {
        row.size = size;
        row.entryPrice = match.averagePrice;
        row.side = side;
        persistPosition(row);
        result.updatedPositions += 1;
      }
    }

    for (const candidate of reported) {
      if (candidate.quantity === 0) continue;
      const internal = internalSymbolFor(candidate.tradingSymbol);
      const known = positions.some(
        (row) =>
          row.strategyId === BROKER_STRATEGY_ID &&
          (row.symbol === internal || row.symbol === candidate.tradingSymbol),
      );
      if (known) continue;

      const created: LivePositionRow = {
        id: `broker_${candidate.tradingSymbol}`,
        symbol: internal,
        side: candidate.quantity > 0 ? 'long' : 'short',
        size: Math.abs(candidate.quantity),
        entryPrice: candidate.averagePrice,
        leverage: 1,
        realizedPnlUsd: 0,
        openedAt: Date.now(),
        strategyId: BROKER_STRATEGY_ID,
      };
      positions.push(created);
      persistPosition(created);
      result.createdPositions += 1;
      recordAuditEvent({
        actor,
        action: 'live_reconcile',
        target: created.id,
        result: 'ok',
        detail: `Mirrored ${created.side} ${created.size} ${candidate.tradingSymbol} from the venue's position book`,
      });
    }

    return result;
  };

  /**
   * One pass at a time: the scheduler and an operator-triggered run must not
   * both book the same venue fill.
   */
  let reconciling: Promise<ReconcileResult> | null = null;
  const reconcile = (actor = 'reconciler'): Promise<ReconcileResult> => {
    if (reconciling) return reconciling;
    reconciling = runReconcile(actor).finally(() => {
      reconciling = null;
    });
    return reconciling;
  };

  // The subscription lives for the process: the service is constructed once and
  // a resting paper limit has to be checked against every incoming tick.
  feed.onTicks(() => checkWorkingOrders());

  return {
    knows: (symbol) => activeSymbol(symbol),

    mode,

    setMode: (next, actor) => {
      kvSet(ROUTING_KEY, next);
      recordAuditEvent({
        actor,
        action: 'live_routing',
        target: next,
        result: 'ok',
        detail: next === 'live' ? 'Live routing armed — orders can reach Kotak Neo' : 'Routing returned to paper',
      });
      if (next === 'live') {
        recordRiskEvent({
          kind: 'broker',
          severity: 'warning',
          message: 'Live order routing armed for NSE instruments',
          detail: 'Orders placed from the terminal will be sent to Kotak Neo until routing is returned to paper',
        });
      }
      return next;
    },

    status: () => ({
      mode: mode(),
      connected: adapter.status().connected,
      brokerConfigured: adapter.isConfigured(),
      paperPositions: positions.length,
      workingOrders: workingPaperOrders.length,
    }),

    positions: () => positions.filter((row) => row.strategyId === MANUAL_STRATEGY_ID).map(toPosition),

    brokerPositions: () => positions.filter((row) => row.strategyId === BROKER_STRATEGY_ID).map(toPosition),

    workingOrders: () => workingPaperOrders.map(toOrder),

    reconcile,

    placeOrder: async (request, routing, actor) => {
      if (!activeSymbol(request.symbol)) {
        return reject('unknown_instrument', `${request.symbol} is not a live NSE instrument`, 404);
      }

      const price = quotePrice(request.symbol);
      const quantity = resolveQuantity(request, price);
      if (!(quantity > 0)) return invalidQuantity();

      const effective: LiveRouting = routing ?? mode();
      if (effective === 'live') return placeLive(request, actor, quantity);
      if (!(price > 0)) {
        return reject('no_live_quote', `No live quote for ${request.symbol} yet — poll the feed first`);
      }
      return placePaper(request, actor, quantity, price);
    },

    cancelOrder: async (orderId, actor) => {
      const row = db
        .prepare(
          `SELECT id, symbol, side, type, quantity, price, filled_quantity AS filledQuantity,
                  average_fill_price AS averageFillPrice, status, leverage, venue_order_id AS venueOrderId,
                  strategy_id AS strategyId, created_at AS createdAt, updated_at AS updatedAt
           FROM orders WHERE id = ? AND venue = ?`,
        )
        .get(orderId, LIVE_VENUE) as unknown as LiveOrderRow | undefined;
      // Not a live order: the simulated book owns it.
      if (!row) return null;

      if (row.status !== 'working') return { error: `Order is ${row.status} — nothing to cancel` };

      if (row.venueOrderId) {
        const result = await adapter.cancelOrder(row.venueOrderId);
        if (!result.ok) {
          recordAuditEvent({
            actor,
            action: 'live_cancel',
            target: orderId,
            result: 'error',
            detail: result.message,
          });
          return { error: result.message };
        }
        row.status = 'cancelled';
        row.updatedAt = Date.now();
        persistOrder(row);
        recordAuditEvent({
          actor,
          action: 'live_cancel',
          target: orderId,
          result: 'ok',
          detail: `Kotak order ${row.venueOrderId}`,
        });
        return { order: toOrder(row) };
      }

      row.status = 'cancelled';
      row.updatedAt = Date.now();
      persistOrder(row);
      workingPaperOrders = workingPaperOrders.filter((candidate) => candidate.id !== row.id);
      recordAuditEvent({ actor, action: 'paper_live_cancel', target: orderId, result: 'ok' });
      return { order: toOrder(row) };
    },

    closePaperPosition: async (positionId, actor) => {
      const existing = positions.find((row) => row.id === positionId && row.strategyId === MANUAL_STRATEGY_ID);
      if (!existing) return null;

      const price = quotePrice(existing.symbol);
      if (!(price > 0)) {
        return reject('no_live_quote', `No live quote for ${existing.symbol} yet — poll the feed first`);
      }

      const row = createOrderRow({
        symbol: existing.symbol,
        side: existing.side === 'long' ? 'sell' : 'buy',
        type: 'market',
        quantity: existing.size,
        price: null,
        leverage: existing.leverage,
        venueOrderId: null,
      });
      const { fill, position } = applyLiveFill(row, price, existing.size, Date.now(), 'paper');
      recordAuditEvent({
        actor,
        action: 'paper_live_close',
        target: `${existing.symbol} ${positionId}`,
        result: 'ok',
        detail: `Closed at ${fill.price} for ${fill.realizedPnlUsd}`,
      });
      return { kind: 'order', order: toOrder(row), fill, position, message: 'Paper position closed at the live quote' };
    },

    closeBrokerPosition: async (symbol, actor) => {
      if (!adapter.status().connected) {
        return reject(
          'broker_not_connected',
          'Kotak Neo session is not connected — log in from Risk & Fleet to manage the broker book',
        );
      }

      let brokerPositions;
      try {
        brokerPositions = await adapter.positions();
      } catch (error) {
        return reject(
          'broker_unreachable',
          error instanceof Error ? error.message : String(error),
          502,
        );
      }

      const target = brokerPositions.find(
        (candidate) => candidate.symbol === symbol || candidate.tradingSymbol === symbol,
      );
      if (!target || target.quantity === 0) {
        return reject('broker_position_not_found', `No open Kotak position for ${symbol}`, 404);
      }

      const instrument = feed.instruments().find((candidate) => candidate.symbol === symbol);
      const exchangeSegment = instrument?.exchangeSegment ?? 'nse_cm';
      const tradingSymbol = instrument?.tradingSymbol ?? target.tradingSymbol;
      const quantity = Math.abs(target.quantity);

      const row = createOrderRow({
        symbol,
        side: target.quantity > 0 ? 'sell' : 'buy',
        type: 'market',
        quantity,
        price: null,
        leverage: 1,
        venueOrderId: null,
      });

      const result = await adapter.placeOrder({
        symbol,
        tradingSymbol,
        exchangeSegment,
        side: row.side,
        quantity,
        orderType: 'market',
        product: target.product || 'MIS',
        validity: 'DAY',
        tag: 'KINETIX',
        ...(instrument?.instrumentToken ? { instrumentToken: instrument.instrumentToken } : {}),
      });

      if (!result.ok || !result.orderId) {
        recordAuditEvent({
          actor,
          action: 'live_close',
          target: `${symbol} ${quantity}`,
          result: 'rejected',
          detail: result.message,
        });
        return reject('broker_rejected', result.message, 502);
      }

      row.venueOrderId = result.orderId;
      persistOrder(row);
      recordAuditEvent({
        actor,
        action: 'live_close',
        target: `${symbol} ${quantity}`,
        result: 'ok',
        detail: `Kotak order ${result.orderId}`,
      });
      return {
        kind: 'order',
        order: toOrder(row),
        fill: null,
        position: null,
        message: `Close order sent to Kotak Neo as ${result.orderId}`,
      };
    },
  };
}
