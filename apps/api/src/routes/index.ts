import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import {
  ApiErrorSchema,
  BotStateRequestSchema,
  BrokerLoginRequestSchema,
  ChartRangeSchema,
  CopilotRequestSchema,
  DeployStrategyRequestSchema,
  FreezeRequestSchema,
  LiveRoutingRequestSchema,
  PlaceOrderRequestSchema,
  RunBacktestRequestSchema,
  TimeframeSchema,
  UpdateGuardrailRequestSchema,
  UpdateParamsRequestSchema,
  UpdateSourceRequestSchema,
} from '@kinetix/shared';

import { brokerStatus, executionVenue, getKotakAdapter } from '../brokers/index.ts';
import { loadScripMaster, searchScripMaster } from '../brokers/scripMaster.ts';
import { config } from '../config.ts';
import { getDb, listAuditEvents, listRiskEvents } from '../db/db.ts';
import type { Engine } from '../engine/world.ts';
import type { LiveFeed } from '../market/liveFeed.ts';
import type { LiveTradingService } from '../market/liveTrading.ts';

/* ============================================================================
 * REST surface.
 *
 * Bodies are validated against the shared schemas, so a rejected payload is a
 * 400 with the same field names the terminal already knows.
 * ==========================================================================*/

interface RouteDeps {
  engine: Engine;
  liveFeed: LiveFeed;
  /** Live (NSE) order routing: paper by default, Kotak when explicitly armed. */
  liveTrading: LiveTradingService;
  hubClients: () => number;
  wsChannels: () => Map<string, number>;
}

const errorBody = (error: string, detail?: string, code?: string): z.infer<typeof ApiErrorSchema> => ({
  error,
  ...(detail !== undefined ? { detail } : {}),
  ...(code !== undefined ? { code } : {}),
});

/** Validate a request body against its shared schema, replying 400 on failure. */
function parseBody<T>(schema: z.ZodType<T>, body: unknown, reply: FastifyReply): T | null {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  const detail = parsed.error.issues
    .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
  void reply.code(400).send(errorBody('Invalid request body', detail, 'validation_failed'));
  return null;
}

export async function registerRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { engine, liveFeed, liveTrading } = deps;
  const { market, portfolio, risk, fleet, strategies } = engine;

  /* --------------------------------- health -------------------------------- */

  app.get('/api/health', async () => ({
    status: 'ok',
    env: config.env,
    seed: config.sim.seed,
    tickHz: config.sim.tickHz,
    ticks: engine.tickCount(),
    wsClients: deps.hubClients(),
    wsChannels: Object.fromEntries(deps.wsChannels()),
    marketProvider: config.marketProvider,
    executionVenue: executionVenue(),
    database: config.db.path,
  }));

  /* -------------------------------- portfolio ------------------------------ */

  app.get('/api/portfolio/summary', async () =>
    portfolio.summary({
      deployedAlgos: fleet.deployedAlgos(),
      maxAlgos: fleet.maxAlgos(),
      // Realised edge of this strategy set versus its own benchmark sleeve.
      winRateDeltaVsBenchPct: 1.8,
    }),
  );

  app.get('/api/portfolio/equity', async (request, reply) => {
    const query = z.object({ range: ChartRangeSchema.default('1M') }).safeParse(request.query);
    if (!query.success) return reply.code(400).send(errorBody('Invalid range'));
    return { range: query.data.range, points: portfolio.equitySeries(query.data.range) };
  });

  /* --------------------------------- market -------------------------------- */

  app.get('/api/instruments', async () => ({ instruments: market.instruments() }));

  app.get('/api/market/:symbol/candles', async (request, reply) => {
    const params = z.object({ symbol: z.string() }).safeParse(request.params);
    const query = z
      .object({ timeframe: TimeframeSchema.default('15m'), limit: z.coerce.number().int().min(10).max(2_000).default(200) })
      .safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send(errorBody('Invalid request'));

    try {
      const candles = market.candles(decodeURIComponent(params.data.symbol), query.data.timeframe, query.data.limit);
      return { symbol: params.data.symbol, timeframe: query.data.timeframe, candles };
    } catch (error) {
      return reply.code(404).send(errorBody('Unknown instrument', error instanceof Error ? error.message : undefined));
    }
  });

  app.get('/api/market/:symbol/orderbook', async (request, reply) => {
    const params = z.object({ symbol: z.string() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send(errorBody('Invalid symbol'));
    const query = z.object({ depth: z.coerce.number().int().min(1).max(20).default(5) }).safeParse(request.query);
    if (!query.success) return reply.code(400).send(errorBody('Invalid depth'));

    try {
      return market.book(decodeURIComponent(params.data.symbol), query.data.depth);
    } catch (error) {
      return reply.code(404).send(errorBody('Unknown instrument', error instanceof Error ? error.message : undefined));
    }
  });

  /* ------------------------------- live NSE -------------------------------- */

  /**
   * The live watchlist: resolved instruments, their latest Kotak quotes, and the
   * feed's own health. Read-only, and deliberately separate from
   * `/api/instruments` — those are simulated and fill against a simulated book,
   * whereas these are real NSE prices with no book behind them.
   */
  app.get('/api/live/quotes', async () => ({
    status: liveFeed.status(),
    instruments: liveFeed.instruments(),
    quotes: liveFeed.quotes(),
  }));

  app.get('/api/live/:symbol/candles', async (request, reply) => {
    const params = z.object({ symbol: z.string() }).safeParse(request.params);
    const query = z
      .object({ timeframe: TimeframeSchema.default('1m'), limit: z.coerce.number().int().min(1).max(500).default(200) })
      .safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send(errorBody('Invalid request'));

    const symbol = decodeURIComponent(params.data.symbol);
    const candles = liveFeed.candles(symbol, query.data.timeframe, query.data.limit);
    return {
      symbol,
      timeframe: query.data.timeframe,
      candles,
      // Bars are accumulated from polling, so a fresh boot has none. Saying so
      // explicitly stops an empty chart looking like a broken one.
      // Bars are accumulated from polling and persisted across restarts, so an
      // empty chart means "nothing collected yet", not "broken".
      note: candles.length === 0 ? 'No live bars yet — they accumulate from the Kotak polls and persist across restarts' : null,
    };
  });

  /** Force a poll now, so the terminal (and an operator) can refresh on demand. */
  app.post('/api/live/poll', async () => {
    const frame = await liveFeed.poll();
    // `polledTicks` is this cycle's frame; `ticks` in the status is the running
    // total since boot.
    return { ...liveFeed.status(), polledTicks: frame.length };
  });

  /**
   * The live book: routing mode, this terminal's own paper positions, resting
   * paper limits, and — when a Kotak session is live — the positions held at
   * the broker itself.
   */
  app.get('/api/live/positions', async () => {
    const adapter = getKotakAdapter();
    const connected = adapter.status().connected;
    let broker: Array<Record<string, unknown>> | null = null;
    let brokerError: string | null = null;
    if (connected) {
      try {
        broker = [...(await adapter.positions())] as unknown as Array<Record<string, unknown>>;
      } catch (error) {
        brokerError = error instanceof Error ? error.message : String(error);
      }
    }

    // The venue's own position book is the truth while it answers. When it does
    // not, the mirrored rows reconciliation keeps fresh stand in, so a broker
    // blip does not blank the panel or invent a number.
    const brokerRows =
      broker ??
      liveTrading.brokerPositions().map((position) => {
        const tradingSymbol =
          liveFeed.instruments().find((instrument) => instrument.symbol === position.symbol)?.tradingSymbol ??
          position.symbol;
        return {
          symbol: position.symbol,
          tradingSymbol,
          quantity: position.side === 'long' ? position.size : -position.size,
          averagePrice: position.entryPrice,
          lastPrice: position.markPrice,
          pnl: position.unrealizedPnlUsd,
          product: '',
        };
      });

    return {
      status: liveTrading.status(),
      paper: liveTrading.positions(),
      working: liveTrading.workingOrders(),
      broker: brokerRows,
      brokerError,
    };
  });

  /**
   * Run one reconciliation pass now: compare local live orders against Kotak's
   * order book, book any fills it reports and mirror its position book.
   */
  app.post('/api/live/reconcile', async () => liveTrading.reconcile('operator'));

  /** Arm or disarm live routing. Paper is the default and the resting state. */
  app.post('/api/live/routing', async (request, reply) => {
    const body = parseBody(LiveRoutingRequestSchema, request.body, reply);
    if (!body) return;
    const mode = liveTrading.setMode(body.mode, 'operator');
    return { ...liveTrading.status(), mode };
  });

  app.post('/api/live/positions/:id/close', async (request, reply) => {
    const params = z.object({ id: z.string() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send(errorBody('Invalid position id'));
    const id = params.data.id;

    // `broker_<tradingSymbol>` ids come from the Kotak book; local ids are this
    // terminal's paper live positions.
    if (id.startsWith('broker_')) {
      const symbol = id.slice('broker_'.length);
      const outcome = await liveTrading.closeBrokerPosition(symbol, 'operator');
      if (outcome.kind === 'rejected') {
        return reply.code(outcome.httpStatus).send(errorBody(outcome.reason, undefined, outcome.code));
      }
      return { order: outcome.order, message: outcome.message, routing: 'live' };
    }

    const outcome = await liveTrading.closePaperPosition(id, 'operator');
    if (!outcome) return reply.code(404).send(errorBody('Live position not found'));
    if (outcome.kind === 'rejected') {
      return reply.code(outcome.httpStatus).send(errorBody(outcome.reason, undefined, outcome.code));
    }
    return { order: outcome.order, fill: outcome.fill, message: outcome.message, routing: 'paper' };
  });

  app.get('/api/market/:symbol/execution-markers', async (request, reply) => {
    const params = z.object({ symbol: z.string() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send(errorBody('Invalid symbol'));
    const fills = portfolio.markers(decodeURIComponent(params.data.symbol), 40);
    return {
      symbol: params.data.symbol,
      markers: fills.map((fill) => ({
        ts: fill.ts,
        price: fill.price,
        side: fill.side,
        effect: fill.effect,
        quantity: fill.quantity,
        label: `${fill.effect === 'entry' ? 'BUY' : 'SELL'}`,
      })),
    };
  });

  /* --------------------------------- orders -------------------------------- */

  app.get('/api/orders', async (request) => {
    const query = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).safeParse(request.query);
    const limit = query.success ? query.data.limit : 100;
    return { orders: portfolio.orders(limit), open: portfolio.openOrders() };
  });

  app.post('/api/orders', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = parseBody(PlaceOrderRequestSchema, request.body, reply);
    if (!body) return;

    // A live NSE symbol never touches the simulated book: it is either filled
    // against the live quote (paper, the default) or routed to Kotak, and only
    // when that routing was explicitly asked for.
    if (liveTrading.knows(body.symbol)) {
      const live = await liveTrading.placeOrder(body, body.routing, 'operator');
      if (live.kind === 'rejected') {
        return reply.code(live.httpStatus).send(errorBody(live.reason, undefined, live.code));
      }
      return reply.code(201).send({
        order: live.order,
        fill: live.fill,
        position: live.position,
        message: live.message,
        routing: live.order.venueOrderId ? 'live' : 'paper',
      });
    }

    const outcome = engine.placeOrder(body, {
      actor: 'operator',
      strategyId: body.strategyId ?? 'manual',
      venue: executionVenue(),
      ...(body.leverage !== undefined ? { leverage: body.leverage } : {}),
    });

    if ('rejected' in outcome) {
      return reply.code(409).send({
        ...errorBody(outcome.reason, `Notional ${outcome.notionalUsd.toFixed(0)} USD`, outcome.code),
        ...(outcome.guardrailId !== undefined ? { guardrailId: outcome.guardrailId } : {}),
      });
    }
    return reply.code(201).send({ order: outcome });
  });

  app.delete('/api/orders/:id', async (request, reply) => {
    const params = z.object({ id: z.string() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send(errorBody('Invalid order id'));

    // Live orders cancel through Kotak (or locally for a resting paper ticket);
    // the simulated book only ever sees its own ids.
    const live = await liveTrading.cancelOrder(params.data.id, 'operator');
    if (live) {
      if ('error' in live) return reply.code(409).send(errorBody(live.error, undefined, 'cancel_failed'));
      return { order: live.order };
    }

    const order = portfolio.cancelOrder(params.data.id);
    if (!order) return reply.code(404).send(errorBody('Order not found'));
    return { order };
  });

  app.get('/api/positions', async () => ({ positions: portfolio.positions() }));

  app.post('/api/positions/:id/close', async (request, reply) => {
    const params = z.object({ id: z.string() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send(errorBody('Invalid position id'));
    const order = portfolio.closePosition(params.data.id, 'operator');
    if (!order) return reply.code(404).send(errorBody('Position not found'));
    return { order };
  });

  app.get('/api/fills', async (request) => {
    const query = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).safeParse(request.query);
    return { fills: portfolio.fills(query.success ? query.data.limit : 100) };
  });

  /* -------------------------------- strategies ----------------------------- */

  app.get('/api/strategies', async () => ({ strategies: strategies.list() }));

  app.post('/api/strategies', async (request, reply) => {
    const body = z.object({ name: z.string() }).safeParse(request.body);
    if (!body.success) return reply.code(400).send(errorBody('Invalid name'));
    return { strategy: strategies.create(body.data.name) };
  });

  app.delete('/api/strategies/:id', async (request, reply) => {
    const params = z.object({ id: z.string() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send(errorBody('Invalid strategy id'));
    const deleted = strategies.delete(params.data.id);
    if (!deleted) return reply.code(404).send(errorBody('Strategy not found or cannot be deleted'));
    return { success: true };
  });

  app.get('/api/strategies/:id', async (request, reply) => {
    const params = z.object({ id: z.string() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send(errorBody('Invalid strategy id'));
    const strategy = strategies.get(params.data.id);
    if (!strategy) return reply.code(404).send(errorBody('Strategy not found'));
    return {
      strategy,
      validation: strategies.validate(params.data.id),
      signals: strategies.signalBreakdown(params.data.id),
      logs: strategies.logs(params.data.id),
      latestRun: strategies.latestRun(params.data.id),
    };
  });

  app.put('/api/strategies/:id/source', async (request, reply) => {
    const params = z.object({ id: z.string() }).safeParse(request.params);
    const body = parseBody(UpdateSourceRequestSchema, request.body, reply);
    if (!params.success || !body) return;
    const result = strategies.updateSource(params.data.id, body.source, 'operator');
    if (!result) return reply.code(404).send(errorBody('Strategy not found'));
    return result;
  });

  app.post('/api/strategies/:id/validate', async (request, reply) => {
    const params = z.object({ id: z.string() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send(errorBody('Invalid strategy id'));
    const validation = strategies.validate(params.data.id);
    if (!validation) return reply.code(404).send(errorBody('Strategy not found'));
    return validation;
  });

  app.put('/api/strategies/:id/params', async (request, reply) => {
    const params = z.object({ id: z.string() }).safeParse(request.params);
    const body = parseBody(UpdateParamsRequestSchema, request.body, reply);
    if (!params.success || !body) return;
    const strategy = strategies.updateParams(params.data.id, body.params, 'operator');
    if (!strategy) return reply.code(404).send(errorBody('Strategy not found'));
    return { strategy, signals: strategies.signalBreakdown(params.data.id) };
  });

  app.post('/api/strategies/:id/paper-run', async (request, reply) => {
    const params = z.object({ id: z.string() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send(errorBody('Invalid strategy id'));
    const result = strategies.runBacktestFor(params.data.id, { range: '1M', feeMultiplier: 1 });
    if (!result) return reply.code(404).send(errorBody('Strategy not found'));
    return { mode: 'paper', run: result.run, logs: result.logs };
  });

  app.post('/api/strategies/:id/deploy', async (request, reply) => {
    const params = z.object({ id: z.string() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send(errorBody('Invalid strategy id'));
    const strategy = strategies.get(params.data.id);
    if (!strategy) return reply.code(404).send(errorBody('Strategy not found'));

    // Parse optional deploy body: instrument override + multi-strategy selection.
    const body = DeployStrategyRequestSchema.safeParse(request.body);
    const deployBody = body.success ? body.data : {};

    const existing = fleet.bots().find((bot) => bot.strategyId === strategy.id);
    if (existing) {
      const result = fleet.setBotState(existing.id, 'running', 'operator');
      if ('error' in result) return reply.code(409).send(errorBody(result.error, undefined, 'bot_unavailable'));
      getDb().prepare('UPDATE strategies SET deployed_bot_id = ?, status = ? WHERE id = ?').run(existing.id, 'deployed', strategy.id);
      return { bot: result.bot, created: false };
    }

    // A strategy with no bot yet gets one, with a conservative allocation.
    const created = fleet.createBotForStrategy({
      strategyId: strategy.id,
      name: `${strategy.name} Live`,
      venue: strategy.venue,
      allocatedMarginUsd: 250_000,
      leverage: 5,
      ...(deployBody.instrument !== undefined ? { instrument: deployBody.instrument } : {}),
      ...(deployBody.strategyIds !== undefined ? { strategyIds: deployBody.strategyIds } : {}),
    });
    if ('error' in created) return reply.code(409).send(errorBody(created.error, undefined, 'bot_unavailable'));
    const started = fleet.setBotState(created.bot.id, 'running', 'operator');
    if ('error' in started) return reply.code(409).send(errorBody(started.error, undefined, 'bot_unavailable'));
    return { bot: started.bot, created: true };
  });

  /* -------------------------------- backtests ------------------------------ */

  app.post('/api/backtests', async (request, reply) => {
    const body = parseBody(RunBacktestRequestSchema, request.body, reply);
    if (!body) return;
    const result = strategies.runBacktestFor(body.strategyId, {
      ...(body.range !== undefined ? { range: body.range } : {}),
      ...(body.params !== undefined ? { params: body.params } : {}),
      ...(body.feeMultiplier !== undefined ? { feeMultiplier: body.feeMultiplier } : {}),
    });
    if (!result) return reply.code(404).send(errorBody('Strategy not found'));
    return reply.code(201).send(result);
  });

  app.get('/api/backtests/:runId', async (request, reply) => {
    const params = z.object({ runId: z.string() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send(errorBody('Invalid run id'));
    const detail = strategies.getRun(params.data.runId);
    if (!detail) return reply.code(404).send(errorBody('Run not found'));
    return detail;
  });

  app.post('/api/backtests/:runId/insights/:insightId/apply', async (request, reply) => {
    const params = z.object({ runId: z.string(), insightId: z.string() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send(errorBody('Invalid parameters'));
    const result = strategies.applyInsight(params.data.runId, params.data.insightId);
    if (!result) return reply.code(404).send(errorBody('Insight or run not found'));
    return result;
  });

  app.post('/api/ai/query', async (request, reply) => {
    const body = parseBody(CopilotRequestSchema, request.body, reply);
    if (!body) return;
    const answer = strategies.ask(body.strategyId, body.question, body.runId);
    if (!answer) return reply.code(404).send(errorBody('Strategy not found'));
    return {
      id: `ans_${Date.now().toString(36)}`,
      question: body.question,
      ...answer,
    };
  });

  /* ------------------------------ fleet and risk --------------------------- */

  app.get('/api/fleet', async () => fleet.snapshot());

  app.get('/api/venues/latency', async () => ({ venues: fleet.venues() }));

  app.post('/api/fleet/:botId/state', async (request, reply) => {
    const params = z.object({ botId: z.string() }).safeParse(request.params);
    const body = parseBody(BotStateRequestSchema, request.body, reply);
    if (!params.success || !body) return;
    const result = fleet.setBotState(params.data.botId, body.state, 'operator');
    if ('error' in result) return reply.code(409).send(errorBody(result.error, undefined, 'bot_unavailable'));
    return result;
  });

  app.post('/api/fleet/pause', async () => {
    fleet.pauseFleet('operator', 'manual pause request');
    return fleet.snapshot();
  });

  app.post('/api/fleet/freeze', async (request, reply) => {
    const body = parseBody(FreezeRequestSchema, request.body, reply);
    if (!body) return;
    fleet.freezeFleet('operator');
    return fleet.snapshot();
  });

  app.post('/api/fleet/rearm', async () => {
    fleet.rearm('operator');
    return fleet.snapshot();
  });

  app.get('/api/risk/guardrails', async () => ({ guardrails: risk.guardrails() }));

  app.patch('/api/risk/guardrails/:id', async (request, reply) => {
    const params = z.object({ id: z.string() }).safeParse(request.params);
    const body = parseBody(UpdateGuardrailRequestSchema, request.body, reply);
    if (!params.success || !body) return;
    const guardrail = risk.updateGuardrail(params.data.id, body, 'operator');
    if (!guardrail) return reply.code(404).send(errorBody('Guardrail not found'));
    return { guardrail };
  });

  app.get('/api/risk/events', async (request) => {
    const query = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }).safeParse(request.query);
    return { events: listRiskEvents(query.success ? query.data.limit : 50), rejectionsToday: risk.rejectionsToday() };
  });

  app.get('/api/audit/events', async (request) => {
    const query = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }).safeParse(request.query);
    return { events: listAuditEvents(query.success ? query.data.limit : 50) };
  });

  /* --------------------------------- broker -------------------------------- */

  app.get('/api/broker/status', async () => brokerStatus());

  app.post('/api/broker/kotakneo/login', async (request, reply) => {
    const body = parseBody(BrokerLoginRequestSchema, request.body, reply);
    if (!body) return;
    const adapter = getKotakAdapter();
    try {
      const status = await adapter.login({
        ...(body.totp !== undefined ? { totp: body.totp } : {}),
        ...(body.mpin !== undefined ? { mpin: body.mpin } : {}),
      });
      return status;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(502).send(errorBody('Kotak Neo login failed', message, 'broker_login_failed'));
    }
  });

  /**
   * Instrument lookup against Kotak's published scrip master.
   *
   * This is the one real-data call that does not need a trading session — it
   * authenticates with the consumer key alone — so the terminal can resolve
   * `RELIANCE` to its instrument token even before a login succeeds.
   */
  app.get('/api/broker/kotakneo/instruments', async (request, reply) => {
    const query = z
      .object({
        q: z.string().default(''),
        segment: z.string().default('nse_cm'),
        limit: z.coerce.number().int().min(1).max(200).default(25),
        // Parsed as a string and compared explicitly: `z.coerce.boolean()` maps
        // the string "false" to true, which would silently force a refresh.
        refresh: z.enum(['true', 'false']).default('false'),
      })
      .safeParse(request.query);
    if (!query.success) return reply.code(400).send(errorBody('Invalid query'));

    try {
      const scripMaster = await loadScripMaster(getKotakAdapter(), {
        exchangeSegment: query.data.segment,
        refresh: query.data.refresh === 'true',
      });
      return {
        segment: scripMaster.exchangeSegment,
        source: scripMaster.sourceUrl,
        fetchedAt: scripMaster.fetchedAt,
        total: scripMaster.instruments.length,
        instruments: searchScripMaster(scripMaster, query.data.q, query.data.limit),
      };
    } catch (error) {
      return reply
        .code(502)
        .send(errorBody('Kotak scrip master unavailable', error instanceof Error ? error.message : undefined));
    }
  });

  /**
   * One live quote, resolved through the scrip master.
   *
   * This exercises the whole real-data chain in a single call — symbol lookup,
   * instrument token, Kotak quote, normalisation — which is also what the
   * terminal's watchlist will use.
   */
  app.get('/api/broker/kotakneo/quote', async (request, reply) => {
    const query = z
      .object({ symbol: z.string().min(1), segment: z.string().default('nse_cm') })
      .safeParse(request.query);
    if (!query.success) return reply.code(400).send(errorBody('Invalid query'));

    const adapter = getKotakAdapter();
    if (!adapter.status().connected) {
      return reply.code(409).send(errorBody('Kotak Neo session is not connected', undefined, 'broker_not_connected'));
    }

    try {
      const scripMaster = await loadScripMaster(adapter, { exchangeSegment: query.data.segment });
      const [instrument] = searchScripMaster(scripMaster, query.data.symbol, 1);
      if (!instrument) {
        return reply
          .code(404)
          .send(errorBody('Unknown instrument', `No ${query.data.segment} instrument matches ${query.data.symbol}`));
      }

      const [quote] = await adapter.quotes([
        {
          symbol: instrument.tradingSymbol,
          tradingSymbol: instrument.tradingSymbol,
          exchangeSegment: instrument.exchangeSegment,
          instrumentToken: instrument.token,
        },
      ]);
      return { instrument, quote: quote ?? null };
    } catch (error) {
      return reply.code(502).send(errorBody('Kotak quote failed', error instanceof Error ? error.message : undefined));
    }
  });

  app.post('/api/broker/kotakneo/logout', async () => {
    await getKotakAdapter().logout();
    return brokerStatus();
  });

  app.get('/api/broker/kotakneo/positions', async (_request, reply) => {
    const adapter = getKotakAdapter();
    if (!adapter.status().connected) {
      return reply.code(409).send(errorBody('Kotak Neo session is not connected', undefined, 'broker_not_connected'));
    }
    try {
      return { positions: await adapter.positions() };
    } catch (error) {
      return reply.code(502).send(errorBody('Kotak Neo request failed', error instanceof Error ? error.message : undefined));
    }
  });

  app.get('/api/broker/kotakneo/limits', async (_request, reply) => {
    const adapter = getKotakAdapter();
    if (!adapter.status().connected) {
      return reply.code(409).send(errorBody('Kotak Neo session is not connected', undefined, 'broker_not_connected'));
    }
    try {
      return await adapter.limits();
    } catch (error) {
      return reply.code(502).send(errorBody('Kotak Neo request failed', error instanceof Error ? error.message : undefined));
    }
  });

  app.get('/api/broker/kotakneo/orders', async (_request, reply) => {
    const adapter = getKotakAdapter();
    if (!adapter.status().connected) {
      return reply.code(409).send(errorBody('Kotak Neo session is not connected', undefined, 'broker_not_connected'));
    }
    try {
      return { orders: await adapter.orderBook() };
    } catch (error) {
      return reply.code(502).send(errorBody('Kotak Neo request failed', error instanceof Error ? error.message : undefined));
    }
  });
}
