import fs from 'node:fs';
import path from 'node:path';

import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import Fastify, { LogController } from 'fastify';

import { wsBookChannel, wsMarketChannel } from '@kinetix/shared';

import { getKotakAdapter } from './brokers/index.ts';
import { config } from './config.ts';
import { closeDatabase } from './db/db.ts';
import { createEngine } from './engine/world.ts';
import { createLiveFeed } from './market/liveFeed.ts';
import { createDbBarStore } from './market/barStore.ts';
import { createLiveTradingService } from './market/liveTrading.ts';
import { registerRoutes } from './routes/index.ts';
import { createHub } from './ws/hub.ts';

/* ============================================================================
 * HTTP + WebSocket entry point.
 * ==========================================================================*/

const engine = createEngine();

const app = Fastify({
  logger: { level: config.logLevel },
  ...(config.isProduction
    ? { logController: new LogController({ disableRequestLogging: true }) }
    : {}),
});

await app.register(cors, {
  // Vite proxies /api and /ws in development, so this only widens the surface
  // for tools that talk to the API directly.
  origin: true,
  credentials: true,
});

const hub = await createHub(app, {
  log: (message) => app.log.info(message),
});

const liveFeed = createLiveFeed({
  adapter: getKotakAdapter(),
  // Bars outlive the process: a restart resumes the tape instead of clearing it.
  store: createDbBarStore(),
  log: (message) => app.log.info(message),
});

// Live order routing: paper fills at the quote by default, Kotak only when the
// operator arms it. Created after the engine so the database is open.
const liveTrading = createLiveTradingService({ feed: liveFeed, adapter: getKotakAdapter() });

await registerRoutes(app, {
  engine,
  liveFeed,
  liveTrading,
  hubClients: () => hub.clientCount(),
  wsChannels: () => hub.channelStats(),
});

// Serve the built terminal when it exists, so a production boot is one process.
const webDist = path.resolve(config.appRoot, '../web/dist');
if (fs.existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist, wildcard: false });
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api') || request.url.startsWith('/ws')) {
      return reply.code(404).send({ error: 'Not found', detail: request.url });
    }
    return reply.sendFile('index.html');
  });
  app.log.info(`[static] serving terminal from ${webDist}`);
}

/* ----------------------------- stream publishers --------------------------- */

// Market frames go out at the simulator rate; book snapshots are larger, so they
// are throttled to roughly 2Hz to keep the socket useful without flooding it.
let booksDue = false;
const unsubscribe = engine.onFrame((frame) => {
  const markets = frame.ticks.map((tick) => ({
    symbol: tick.symbol,
    price: tick.price,
    t: tick.t,
    v: tick.v,
    ts: tick.ts,
  }));
  for (const tick of markets) {
    hub.broadcast(wsMarketChannel(tick.symbol), tick);
  }
  booksDue = true;
});

const bookTimer = setInterval(() => {
  if (!booksDue) return;
  booksDue = false;
  for (const instrument of engine.market.instruments()) {
    hub.broadcast(wsBookChannel(instrument.symbol), engine.market.book(instrument.symbol, 5));
  }
}, 500);
bookTimer.unref?.();

// Live NSE ticks ride the same `market:<symbol>` channel as the simulator, so the
// terminal's tape and chart need no second code path.
const unsubscribeLive = liveFeed.onTicks((frame) => {
  for (const tick of frame) hub.broadcast(wsMarketChannel(tick.symbol), tick);
});

// Depth rides the same `book:` channel, but only when Kotak's quote payload
// actually carried levels — an absent book stays absent.
const unsubscribeLiveBooks = liveFeed.onBooks((books) => {
  for (const book of books) hub.broadcast(wsBookChannel(book.symbol), book);
});

// Kotak accepts orders asynchronously, so the local record of a live order is
// only a claim about it until the venue's own book is polled. Reconciliation is
// slow by design — every pass costs two broker round trips.
const reconcileTimer = setInterval(() => {
  if (!liveTrading.status().connected) return;
  void liveTrading.reconcile('scheduler').then((result) => {
    const moved =
      result.updatedOrders > 0 ||
      result.bookedFills > 0 ||
      result.createdPositions > 0 ||
      result.updatedPositions > 0 ||
      result.closedPositions > 0;
    const summary =
      `${result.checkedOrders} orders checked, ${result.updatedOrders} updated, ` +
      `${result.bookedFills} fills booked, ` +
      `${result.createdPositions + result.updatedPositions + result.closedPositions} positions moved`;
    // A pass that changed nothing is routine, so it stays at debug — but it is
    // logged, because otherwise a loop that silently stopped looks identical.
    if (moved) app.log.info(`[live] reconciled: ${summary}`);
    else app.log.debug(`[live] reconcile pass: ${result.ok ? summary : (result.error ?? 'failed')}`);
  });
}, 20_000);
reconcileTimer.unref?.();

// Portfolio, order and fleet snapshots at 1Hz: they are aggregate views rather
// than per-tick data, and the terminal animates the delta already in hand.
const snapshotTimer = setInterval(() => {
  if (hub.clientCount() === 0) return;
  hub.broadcast('positions', { positions: engine.portfolio.positions() });
  hub.broadcast('orders', { orders: engine.portfolio.orders(50), open: engine.portfolio.openOrders() });
  hub.broadcast('fleet', engine.fleet.snapshot());
}, 1_000);
snapshotTimer.unref?.();

/* --------------------------------- lifecycle ------------------------------- */

engine.start();
liveFeed.start();

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    `[kinetix] simulator seed ${config.sim.seed} • market ${config.marketProvider} • execution ${config.executionVenue} • db ${config.db.path}`,
  );
  if (config.marketProvider === 'kotakneo' || config.executionVenue === 'kotakneo') {
    app.log.warn(
      config.kotakCredentialsPresent
        ? '[kinetix] Kotak Neo selected — POST /api/broker/kotakneo/login to open a session'
        : `[kinetix] Kotak Neo selected but missing env: ${config.kotakMissingEnv.join(', ')}`,
    );
  }
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

const shutdown = async (signal: string): Promise<void> => {
  app.log.info(`[kinetix] ${signal} received — shutting down`);
  clearInterval(bookTimer);
  clearInterval(snapshotTimer);
  clearInterval(reconcileTimer);
  unsubscribe();
  unsubscribeLive();
  unsubscribeLiveBooks();
  liveFeed.stop();
  engine.stop();
  await hub.close();
  await app.close();
  closeDatabase();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
