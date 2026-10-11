import type { DatabaseSync } from 'node:sqlite';

import type { Fill, Order, OrderBook, PlaceOrderRequest, PortfolioSummary, Position } from '@kinetix/shared';

import { MANUAL_STRATEGY_ID } from '../db/schema.ts';
import { getDb, newId, nullable, numericOrNull } from '../db/db.ts';
import { instrumentSpec, type MarketSimulator } from '../sim/market.ts';

/* ============================================================================
 * Portfolio and execution.
 *
 * Orders fill against the simulated L2 book with size-dependent slippage and
 * net into positions per (symbol, strategy). Mark-to-market runs on every tick,
 * so unrealised P&L in the UI moves with the tape rather than on a timer.
 *
 * Equity is modelled as cash + unrealised, which is why the seeded cash balance
 * is not the headline figure: the design's $4,821,940 portfolio value is the
 * *equity* the engine derives, including open P&L. That keeps the margin gauge,
 * the balance card and the position table all reading from one consistent book.
 * ==========================================================================*/

export { MANUAL_STRATEGY_ID };

export interface RejectedOrder {
  rejected: true;
  code: string;
  reason: string;
  guardrailId?: string;
  notionalUsd: number;
}

export interface PlaceOrderContext {
  actor: string;
  strategyId: string;
  venue: 'sim' | 'kotakneo';
  /** Notional leverage applied when the fill opens a new position. */
  leverage?: number;
  botId?: string;
  externalOrderId?: string;
}

export interface SummaryInput {
  deployedAlgos: number;
  maxAlgos: number;
  winRateDeltaVsBenchPct: number;
}

export interface PortfolioService {
  positions(): Position[];
  positionById(id: string): Position | null;
  orders(limit?: number): Order[];
  openOrders(): Order[];
  fills(limit?: number): Fill[];
  markers(symbol: string, limit?: number): Fill[];
  placeOrder(request: PlaceOrderRequest, context?: PlaceOrderContext): Order | RejectedOrder;
  cancelOrder(orderId: string): Order | null;
  closePosition(positionId: string, actor?: string): Order | null;
  onTick(books: Map<string, OrderBook>): void;
  equityUsd(): number;
  cashBalanceUsd(): number;
  unrealizedUsd(): number;
  marginUsedUsd(): number;
  marginByBot(): Map<string, number>;
  drawdownPct(): number;
  averageSlippageBps(windowSize?: number): number;
  summary(input: SummaryInput): PortfolioSummary;
  realizedTodayUsd(): number;
  settlementsToday(): number;
  realizedStats(): { wins: number; losses: number; grossGainsUsd: number; grossLossesUsd: number; trades: number };
  equitySeries(range: '1D' | '1W' | '1M' | 'YTD' | 'ALL'): Array<{ t: number; v: number }>;
  reload(): void;
}

interface PositionRow {
  id: string;
  symbol: string;
  side: 'long' | 'short';
  strategyId: string;
  size: number;
  entryPrice: number;
  leverage: number;
  realizedPnlUsd: number;
  openedAt: number;
  venue: 'sim' | 'kotakneo';
  strategyName: string;
}

interface OrderRow {
  id: string;
  symbol: string;
  side: 'buy' | 'sell';
  type: 'market' | 'limit';
  quantity: number;
  price: number | null;
  filledQuantity: number;
  averageFillPrice: number | null;
  status: Order['status'];
  strategyId: string;
  venue: 'sim' | 'kotakneo';
  leverage: number;
  venueOrderId: string | null;
  rejectReason: string | null;
  createdAt: number;
  updatedAt: number;
  strategyName: string;
}

interface FillRow {
  id: string;
  orderId: string;
  symbol: string;
  side: 'buy' | 'sell';
  quantity: number;
  price: number;
  slippageBps: number;
  effect: 'entry' | 'exit';
  realizedPnlUsd: number;
  strategyId: string;
  ts: number;
}

export function isRejected(value: Order | RejectedOrder): value is RejectedOrder {
  return (value as RejectedOrder).rejected === true;
}

/**
 * Slippage rises with how much of the visible book the ticket consumes. A retail
 * clip pays roughly the touch, a size ticket walks the ladder — and because the
 * number is recorded per fill, the slippage limiter guardrail watches a real
 * measurement rather than a hardcoded figure.
 */
function computeSlippageBps(quantity: number, levels: readonly { size: number }[]): number {
  const depth = levels.reduce((acc, level) => acc + level.size, 0) || 1;
  const participation = quantity / depth;
  return Number((1.2 + Math.min(24, participation * 6)).toFixed(3));
}

export function createPortfolioService(market: MarketSimulator): PortfolioService {
  const db: DatabaseSync = getDb();

  let positionCache: PositionRow[] = [];
  let orderCache: OrderRow[] = [];
  let fillCache: FillRow[] = [];
  let strategyNames = new Map<string, string>();
  let portfolio = { balanceUsd: 0, realizedTodayUsd: 0, settlementsToday: 0, dayStartBalanceUsd: 0 };

  const loadStrategies = (): void => {
    const rows = db.prepare('SELECT id, name FROM strategies').all() as Array<{ id: string; name: string }>;
    strategyNames = new Map(rows.map((row) => [row.id, row.name]));
    if (!strategyNames.has(MANUAL_STRATEGY_ID)) {
      db.prepare(
        `INSERT OR IGNORE INTO strategies (id, name, version, status, instrument, timeframe, venue, source, params, confidence_pct, updated_at)
         VALUES (?, ?, 'v1.0.0', 'validated', 'BTC-USD', '1m', 'sim', '', '[]', 100, ?)`,
      ).run(MANUAL_STRATEGY_ID, 'Manual Desk Ticket', Date.now());
      strategyNames.set(MANUAL_STRATEGY_ID, 'Manual Desk Ticket');
    }
  };

  const loadPortfolio = (): void => {
    const row = db
      .prepare(
        `SELECT balance_usd AS balanceUsd, realized_pnl_today_usd AS realizedTodayUsd,
                settlements_today AS settlementsToday, day_start_balance_usd AS dayStartBalanceUsd
         FROM portfolio WHERE id = 1`,
      )
      .get() as
      | { balanceUsd: number; realizedTodayUsd: number; settlementsToday: number; dayStartBalanceUsd: number }
      | undefined;
    if (row) portfolio = row;
  };

  const loadPositions = (): void => {
    // `kotakneo` rows are the live desk's own book (see market/liveTrading.ts).
    // They are priced in rupees and marked from Kotak quotes this service has
    // no access to, so they are excluded here rather than marked wrongly: the
    // simulated equity, drawdown and margin gauges must stay USD-only.
    positionCache = db
      .prepare(
        `SELECT id, symbol, side, strategy_id AS strategyId, size, entry_price AS entryPrice,
                leverage, realized_pnl_usd AS realizedPnlUsd, opened_at AS openedAt, venue
         FROM positions WHERE venue != 'kotakneo'`,
      )
      .all() as unknown as PositionRow[];
  };

  const loadOrders = (limit = 200): void => {
    // `kotakneo` rows are the live desk's own book (see market/liveTrading.ts).
    // They are excluded here so the simulated order history, fills and P&L
    // never mix with live paper orders — the two books are separate by design.
    orderCache = db
      .prepare(
        `SELECT id, symbol, side, type, quantity, price, filled_quantity AS filledQuantity,
                average_fill_price AS averageFillPrice, status, strategy_id AS strategyId, venue, leverage,
                venue_order_id AS venueOrderId, reject_reason AS rejectReason,
                created_at AS createdAt, updated_at AS updatedAt
         FROM orders WHERE venue != 'kotakneo' ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit) as unknown as OrderRow[];
  };

  const loadFills = (limit = 500): void => {
    // Same venue filter as loadOrders: live paper fills stay in the live book.
    // The fills table has no venue column, so filter by the parent order's venue.
    fillCache = db
      .prepare(
        `SELECT f.id, f.order_id AS orderId, f.symbol, f.side, f.quantity, f.price, f.slippage_bps AS slippageBps,
                f.effect, f.realized_pnl_usd AS realizedPnlUsd, f.strategy_id AS strategyId, f.ts
         FROM fills f
         JOIN orders o ON o.id = f.order_id
         WHERE o.venue != 'kotakneo'
         ORDER BY f.ts DESC LIMIT ?`,
      )
      .all(limit) as unknown as FillRow[];
  };

  const reload = (): void => {
    loadStrategies();
    loadPortfolio();
    loadPositions();
    loadOrders();
    loadFills();
  };
  reload();

  const strategyName = (strategyId: string): string => strategyNames.get(strategyId) ?? strategyId;

  const toPosition = (row: PositionRow): Position => {
    const spec = instrumentSpec(row.symbol);
    const mark = market.price(row.symbol);
    const direction = row.side === 'long' ? 1 : -1;
    const unrealized = (mark - row.entryPrice) * row.size * direction;
    return {
      id: row.id,
      symbol: row.symbol,
      side: row.side,
      strategyId: row.strategyId,
      strategyName: strategyName(row.strategyId),
      size: Number(row.size.toFixed(6)),
      entryPrice: Number(row.entryPrice.toFixed(spec.priceDecimals)),
      markPrice: Number(mark.toFixed(spec.priceDecimals)),
      leverage: row.leverage,
      notionalUsd: Number((mark * row.size).toFixed(2)),
      unrealizedPnlUsd: Number(unrealized.toFixed(2)),
      unrealizedPnlPct: Number((((mark - row.entryPrice) / row.entryPrice) * 100 * direction).toFixed(2)),
      realizedPnlUsd: Number(row.realizedPnlUsd.toFixed(2)),
      liquidationPrice:
        row.side === 'long'
          ? Number((row.entryPrice * (1 - 1 / row.leverage)).toFixed(spec.priceDecimals))
          : Number((row.entryPrice * (1 + 1 / row.leverage)).toFixed(spec.priceDecimals)),
      openedAt: row.openedAt,
      venue: row.venue,
    };
  };

  const toOrder = (row: OrderRow): Order => ({
    id: row.id,
    symbol: row.symbol,
    side: row.side,
    type: row.type,
    quantity: Number(row.quantity.toFixed(6)),
    price: row.price,
    filledQuantity: Number(row.filledQuantity.toFixed(6)),
    averageFillPrice: row.averageFillPrice,
    status: row.status,
    strategyId: row.strategyId,
    strategyName: strategyName(row.strategyId),
    venue: row.venue,
    venueOrderId: row.venueOrderId,
    rejectReason: row.rejectReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

  const toFill = (row: FillRow): Fill => ({
    id: row.id,
    orderId: row.orderId,
    symbol: row.symbol,
    side: row.side,
    quantity: Number(row.quantity.toFixed(6)),
    price: Number(row.price.toFixed(6)),
    slippageBps: row.slippageBps,
    effect: row.effect,
    realizedPnlUsd: Number(row.realizedPnlUsd.toFixed(2)),
    strategyId: row.strategyId,
    ts: row.ts,
  });

  const persistPortfolio = (): void => {
    db.prepare(
      'UPDATE portfolio SET balance_usd = ?, realized_pnl_today_usd = ?, settlements_today = ?, updated_at = ? WHERE id = 1',
    ).run(portfolio.balanceUsd, portfolio.realizedTodayUsd, portfolio.settlementsToday, Date.now());
  };

  const persistPosition = (row: PositionRow): void => {
    db.prepare(
      `INSERT INTO positions (id, symbol, side, strategy_id, size, entry_price, leverage, realized_pnl_usd, opened_at, venue)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET size = excluded.size, entry_price = excluded.entry_price,
         leverage = excluded.leverage, realized_pnl_usd = excluded.realized_pnl_usd`,
    ).run(row.id, row.symbol, row.side, row.strategyId, row.size, row.entryPrice, row.leverage, row.realizedPnlUsd, row.openedAt, row.venue);
  };

  const persistOrder = (row: OrderRow): void => {
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
      row.venue,
      row.leverage,
      nullable(row.venueOrderId),
      nullable(row.rejectReason),
      row.createdAt,
      row.updatedAt,
    );
  };

  const persistFill = (row: FillRow): void => {
    db.prepare(
      `INSERT OR REPLACE INTO fills (id, order_id, symbol, side, quantity, price, slippage_bps, effect,
         realized_pnl_usd, strategy_id, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(row.id, row.orderId, row.symbol, row.side, row.quantity, row.price, row.slippageBps, row.effect, row.realizedPnlUsd, row.strategyId, row.ts);
  };

  const createOrderRow = (input: {
    symbol: string;
    side: 'buy' | 'sell';
    type: 'market' | 'limit';
    quantity: number;
    price: number | null;
    strategyId: string;
    venue: 'sim' | 'kotakneo';
    leverage: number;
    externalOrderId?: string;
  }): OrderRow => {
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
      strategyId: input.strategyId,
      venue: input.venue,
      leverage: input.leverage,
      venueOrderId: input.externalOrderId ?? null,
      rejectReason: null,
      createdAt: now,
      updatedAt: now,
      strategyName: strategyName(input.strategyId),
    };
  };

  const applyFill = (input: {
    order: OrderRow;
    price: number;
    quantity: number;
    slippageBps: number;
    side: 'buy' | 'sell';
    actor: string;
  }): FillRow => {
    const { order, price, quantity, slippageBps, side } = input;
    const spec = instrumentSpec(order.symbol);
    const existing = positionCache.find((row) => row.symbol === order.symbol && row.strategyId === order.strategyId);
    const wantsLong = side === 'buy';
    let realized = 0;
    let effect: 'entry' | 'exit' = 'entry';

    if (!existing) {
      const created: PositionRow = {
        id: newId('pos'),
        symbol: order.symbol,
        side: wantsLong ? 'long' : 'short',
        strategyId: order.strategyId,
        size: quantity,
        entryPrice: price,
        leverage: Math.max(1, order.leverage),
        realizedPnlUsd: 0,
        openedAt: Date.now(),
        venue: order.venue,
        strategyName: strategyName(order.strategyId),
      };
      positionCache.push(created);
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

        portfolio.balanceUsd += realized;
        portfolio.realizedTodayUsd += realized;
        portfolio.settlementsToday += 1;

        db.prepare(
          `INSERT INTO closed_trades (id, strategy_id, symbol, side, size, entry_price, exit_price, realized_usd,
             realized_pct, opened_at, closed_at, r_multiple, tag)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
        ).run(
          newId('trade'),
          existing.strategyId,
          existing.symbol,
          existing.side,
          closing,
          existing.entryPrice,
          price,
          realized,
          ((price - existing.entryPrice) / existing.entryPrice) * 100 * direction,
          existing.openedAt,
          Date.now(),
          order.type === 'market' ? 'Market' : 'Limit',
        );

        if (existing.size <= 1e-9) {
          db.prepare('DELETE FROM positions WHERE id = ?').run(existing.id);
          positionCache = positionCache.filter((row) => row.id !== existing.id);
        } else {
          persistPosition(existing);
        }

        const remainder = quantity - closing;
        if (remainder > 1e-9) {
          const flipped: PositionRow = {
            id: newId('pos'),
            symbol: order.symbol,
            side: wantsLong ? 'long' : 'short',
            strategyId: order.strategyId,
            size: remainder,
            entryPrice: price,
            leverage: Math.max(1, existing.leverage),
            realizedPnlUsd: 0,
            openedAt: Date.now(),
            venue: order.venue,
            strategyName: strategyName(order.strategyId),
          };
          positionCache.push(flipped);
          persistPosition(flipped);
        }
      }
    }

    const fill: FillRow = {
      id: newId('fill'),
      orderId: order.id,
      symbol: order.symbol,
      side,
      quantity,
      price: Number(price.toFixed(spec.priceDecimals)),
      slippageBps,
      effect,
      realizedPnlUsd: realized,
      strategyId: order.strategyId,
      ts: Date.now(),
    };
    fillCache.unshift(fill);
    if (fillCache.length > 500) fillCache.length = 500;
    persistFill(fill);
    persistPortfolio();

    order.filledQuantity += quantity;
    order.averageFillPrice = fill.price;
    order.status = 'filled';
    order.updatedAt = fill.ts;
    persistOrder(order);

    return fill;
  };

  const bookFor = (symbol: string): OrderBook => market.book(symbol, 1);
  const unrealizedUsd = (): number =>
    positionCache.reduce((acc, row) => {
      const direction = row.side === 'long' ? 1 : -1;
      return acc + (market.price(row.symbol) - row.entryPrice) * row.size * direction;
    }, 0);

  const cashBalanceUsd = (): number => portfolio.balanceUsd;
  const equityUsd = (): number => cashBalanceUsd() + unrealizedUsd();

  const marginUsedUsd = (): number =>
    positionCache.reduce((acc, row) => acc + (market.price(row.symbol) * row.size) / Math.max(1, row.leverage), 0);

  const marginByBot = (): Map<string, number> => {
    const result = new Map<string, number>();
    const rows = db
      .prepare(
        `SELECT b.id AS botId, p.symbol AS symbol, p.size AS size, p.leverage AS leverage
         FROM positions p JOIN bots b ON b.strategy_id = p.strategy_id
         WHERE p.venue != 'kotakneo'`,
      )
      .all() as Array<{ botId: string; symbol: string; size: number; leverage: number }>;
    for (const row of rows) {
      const notional = market.price(row.symbol) * row.size;
      result.set(row.botId, (result.get(row.botId) ?? 0) + notional / Math.max(1, row.leverage));
    }
    return result;
  };

  /** Peak-to-trough decline of equity against its running maximum, in percent. */
  const drawdownPct = (): number => {
    const trades = db
      .prepare('SELECT realized_usd AS realized FROM closed_trades ORDER BY closed_at ASC')
      .all() as Array<{ realized: number }>;

    let equity = portfolio.dayStartBalanceUsd;
    let peak = equity;
    let worst = 0;
    for (const trade of trades) {
      equity += trade.realized;
      peak = Math.max(peak, equity);
      // Guard the ratio: with no opening balance there is no peak to draw down
      // from, and dividing would produce NaN that the terminal renders verbatim.
      if (peak > 0) worst = Math.max(worst, ((peak - equity) / peak) * 100);
    }
    const current = equityUsd();
    peak = Math.max(peak, current);
    if (peak <= 0) return 0;
    worst = Math.max(worst, ((peak - current) / peak) * 100);
    return Number(worst.toFixed(4));
  };

  const averageSlippageBps = (windowSize = 50): number => {
    const recent = fillCache.slice(0, windowSize);
    if (recent.length === 0) return 0;
    return Number((recent.reduce((acc, fill) => acc + fill.slippageBps, 0) / recent.length).toFixed(4));
  };

  const realizedStats = () => {
    const live = db
      .prepare(
        `SELECT
           SUM(CASE WHEN realized_usd > 0 THEN 1 ELSE 0 END) AS wins,
           SUM(CASE WHEN realized_usd <= 0 THEN 1 ELSE 0 END) AS losses,
           SUM(CASE WHEN realized_usd > 0 THEN realized_usd ELSE 0 END) AS grossGains,
           SUM(CASE WHEN realized_usd < 0 THEN realized_usd ELSE 0 END) AS grossLosses,
           COUNT(*) AS trades
         FROM closed_trades`,
      )
      .get() as {
      wins: number | null;
      losses: number | null;
      grossGains: number | null;
      grossLosses: number | null;
      trades: number | null;
    };

    // Blend the seeded 30-day record in so a freshly created database reports a
    // meaningful win rate instead of 0/0.
    const seeded = db
      .prepare('SELECT wins_30d AS w, losses_30d AS l, gross_gains_30d AS gg, gross_losses_30d AS gl FROM portfolio WHERE id = 1')
      .get() as { w: number; l: number; gg: number; gl: number } | undefined;

    return {
      wins: (live?.wins ?? 0) + (seeded?.w ?? 0),
      losses: (live?.losses ?? 0) + (seeded?.l ?? 0),
      grossGainsUsd: (live?.grossGains ?? 0) + (seeded?.gg ?? 0),
      grossLossesUsd: (live?.grossLosses ?? 0) + (seeded?.gl ?? 0),
      trades: (live?.trades ?? 0) + (seeded?.w ?? 0) + (seeded?.l ?? 0),
    };
  };

  const equitySeries = (range: '1D' | '1W' | '1M' | 'YTD' | 'ALL'): Array<{ t: number; v: number }> => {
    const now = Date.now();
    const windowMs =
      range === '1D'
        ? 86_400_000
        : range === '1W'
          ? 7 * 86_400_000
          : range === '1M'
            ? 30 * 86_400_000
            : range === 'YTD'
              ? Math.max(86_400_000, now - new Date(new Date(now).getFullYear(), 0, 1).getTime())
              : 365 * 86_400_000;
    const since = now - windowMs;

    const trades = db
      .prepare('SELECT realized_usd AS realized, closed_at AS ts FROM closed_trades WHERE closed_at >= ? ORDER BY closed_at ASC')
      .all(since) as Array<{ realized: number; ts: number }>;

    // Walk backwards from live equity so the final point always equals the
    // current book value.
    const points: Array<{ t: number; v: number }> = [{ t: now, v: Number(equityUsd().toFixed(2)) }];
    let running = equityUsd();
    for (let i = trades.length - 1; i >= 0; i -= 1) {
      const trade = trades[i];
      if (!trade) continue;
      running -= trade.realized;
      points.push({ t: trade.ts, v: Number(running.toFixed(2)) });
    }
    points.push({ t: since, v: Number(running.toFixed(2)) });
    return points.reverse();
  };

  return {
    positions: () => positionCache.map(toPosition),
    positionById: (id) => {
      const row = positionCache.find((candidate) => candidate.id === id);
      return row ? toPosition(row) : null;
    },
    orders: (limit = 100) => orderCache.slice(0, limit).map(toOrder),
    openOrders: () => orderCache.filter((row) => row.status === 'working' || row.status === 'partially_filled').map(toOrder),
    fills: (limit = 100) => fillCache.slice(0, limit).map(toFill),
    markers: (symbol, limit = 40) => fillCache.filter((fill) => fill.symbol === symbol).slice(0, limit).map(toFill),
    equityUsd,
    cashBalanceUsd,
    unrealizedUsd,
    marginUsedUsd,
    marginByBot,
    drawdownPct,
    averageSlippageBps,
    realizedStats,
    equitySeries,
    realizedTodayUsd: () => portfolio.realizedTodayUsd,
    settlementsToday: () => portfolio.settlementsToday,
    reload,

    summary: (input) => {
      const stats = realizedStats();
      const equity = equityUsd();
      const delta = portfolio.balanceUsd - portfolio.dayStartBalanceUsd;
      const winRate = stats.trades > 0 ? (stats.wins / stats.trades) * 100 : 0;
      return {
        totalBalanceUsd: Number(equity.toFixed(2)),
        balanceDelta24hUsd: Number(delta.toFixed(2)),
        balanceDelta24hPct: Number(((delta / Math.max(1, equity)) * 100).toFixed(2)),
        realizedPnlTodayUsd: Number(portfolio.realizedTodayUsd.toFixed(2)),
        settlementsToday: portfolio.settlementsToday,
        deployedAlgos: input.deployedAlgos,
        maxAlgos: input.maxAlgos,
        winRate30dPct: Number(winRate.toFixed(1)),
        winRateDeltaVsBenchPct: input.winRateDeltaVsBenchPct,
        openPositions: positionCache.length,
        riskCeilingLabel: 'Risk Ceiling Safe',
        realizedPnl30dUsd: Number((stats.grossGainsUsd + stats.grossLossesUsd).toFixed(2)),
        updatedAt: Date.now(),
      };
    },

    placeOrder: (request, context) => {
      const spec = instrumentSpec(request.symbol);
      const book = bookFor(request.symbol);
      const mark = market.price(request.symbol);
      const strategyId = context?.strategyId ?? request.strategyId ?? MANUAL_STRATEGY_ID;
      const venue = context?.venue ?? spec.venue;
      const leverage = Math.max(1, context?.leverage ?? request.leverage ?? 1);

      const referencePrice = request.type === 'limit' && request.price ? request.price : mark;
      const notionalUsd = request.notionalUsd ?? (request.quantity ? request.quantity * referencePrice : 0);
      if (!(notionalUsd > 0)) {
        return { rejected: true, code: 'invalid_size', reason: 'Provide a quantity or a notional value', notionalUsd: 0 };
      }

      const quantity = request.quantity ?? Number((notionalUsd / referencePrice).toFixed(6));
      const order = createOrderRow({
        symbol: request.symbol,
        side: request.side,
        type: request.type,
        quantity,
        price: request.type === 'limit' ? (request.price ?? mark) : null,
        strategyId: strategyNames.has(strategyId) ? strategyId : MANUAL_STRATEGY_ID,
        venue,
        leverage,
        ...(context?.externalOrderId !== undefined ? { externalOrderId: context.externalOrderId } : {}),
      });

      persistOrder(order);
      orderCache.unshift(order);

      if (request.type === 'market') {
        const levels = request.side === 'buy' ? book.asks : book.bids;
        const slippageBps = computeSlippageBps(quantity, levels);
        const touch = levels[0]?.price ?? mark;
        const direction = request.side === 'buy' ? 1 : -1;
        applyFill({
          order,
          price: touch * (1 + (direction * slippageBps) / 10_000),
          quantity,
          slippageBps,
          side: request.side,
          actor: context?.actor ?? 'operator',
        });
      }

      return toOrder(order);
    },

    cancelOrder: (orderId) => {
      const order = orderCache.find((candidate) => candidate.id === orderId);
      if (!order) return null;
      if (order.status !== 'working' && order.status !== 'partially_filled') return toOrder(order);
      order.status = 'cancelled';
      order.updatedAt = Date.now();
      persistOrder(order);
      return toOrder(order);
    },

    closePosition: (positionId, actor = 'operator') => {
      const row = positionCache.find((candidate) => candidate.id === positionId);
      if (!row) return null;

      const book = bookFor(row.symbol);
      const side: 'buy' | 'sell' = row.side === 'long' ? 'sell' : 'buy';
      const order = createOrderRow({
        symbol: row.symbol,
        side,
        type: 'market',
        quantity: row.size,
        price: null,
        strategyId: row.strategyId,
        venue: row.venue,
        leverage: row.leverage,
      });
      persistOrder(order);
      orderCache.unshift(order);

      const levels = side === 'buy' ? book.asks : book.bids;
      const slippageBps = computeSlippageBps(row.size, levels);
      const touch = levels[0]?.price ?? market.price(row.symbol);
      const direction = side === 'buy' ? 1 : -1;
      applyFill({
        order,
        price: touch * (1 + (direction * slippageBps) / 10_000),
        quantity: row.size,
        slippageBps,
        side,
        actor,
      });
      return toOrder(order);
    },

    onTick: (books) => {
      for (const order of orderCache) {
        if (order.status !== 'working') continue;
        if (order.type !== 'limit' || order.price === null) continue;

        const book = books.get(order.symbol) ?? bookFor(order.symbol);
        const levels = order.side === 'buy' ? book.asks : book.bids;
        const touch = levels[0]?.price;
        if (touch === undefined) continue;

        const crosses = order.side === 'buy' ? touch <= order.price : touch >= order.price;
        if (!crosses) continue;

        applyFill({
          order,
          price: order.price,
          quantity: order.quantity,
          slippageBps: computeSlippageBps(order.quantity, levels),
          side: order.side,
          actor: 'engine',
        });
      }
    },
  };
}
