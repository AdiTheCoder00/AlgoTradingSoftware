import type { BrokerOrderResult, BrokerStatus } from '@kinetix/shared';

import { config, kotakMissingEnv } from '../config.ts';
import { generateTotp } from './totp.ts';
import type {
  BrokerAdapter,
  BrokerLimits,
  BrokerOrderRequest,
  BrokerOrderState,
  BrokerPosition,
  BrokerQuote,
  BrokerSessionState,
} from './types.ts';

/* ============================================================================
 * Kotak Neo Trade API adapter.
 *
 * Paths, headers and body shapes are taken from Kotak's currently maintained
 * SDK (`kotak-neo-python`, `main`): `neo_api_client/settings.py` for the route
 * table and `neo_api_client/services/*.py` for the per-call header sets.
 *
 * Three details are easy to get wrong and are called out where they matter:
 *
 *  1. Login lives on the *session* host (`mis.kotaksecurities.com`). Every call
 *     after MPIN validation must use the account-specific `baseUrl` that
 *     validate returns — it is per-account, so it cannot be configured ahead of
 *     time.
 *  2. Login and validate take JSON bodies. The order-family calls take a
 *     form-encoded body whose single field `jData` carries the JSON.
 *  3. Quotes are addressed by `exchange_segment|instrument_token`, not by
 *     trading symbol, so the scrip master has to resolve tokens first.
 * ==========================================================================*/

/** Route table, production generation. */
const PATHS = {
  login: 'login/1.0/tradeApiLogin',
  validate: 'login/1.0/tradeApiValidate',
  quote: 'script-details/1.0/quotes/neosymbol/{instruments}/{quoteType}',
  scripMaster: 'script-details/1.0/masterscrip/file-paths',
  positions: 'portfolio/v2/positions',
  limits: 'quick/user/limits',
  orderBook: 'quick/user/orders',
  placeOrder: 'quick/order/rule/ms/place',
  cancelOrder: 'quick/order/cancel',
  holdings: 'portfolio/v1/holdings',
  logout: 'apim/login/2.0/logout',
} as const;

type PathKey = keyof typeof PATHS;

/** Header Kotak requires on the login handshake specifically. */
const FIN_KEY = 'neotradeapi';

/** Order source Kotak expects for Trade API traffic. */
const ORDER_SOURCE = 'NEOTRADEAPI';

const SESSION_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Per-request timeout. Kotak's edge can accept a connection and then never
 * answer, so without a deadline a login attempt hangs until the OS gives up —
 * minutes of an apparently frozen UI.
 */
const REQUEST_TIMEOUT_MS = 15_000;

const PRODUCT_CODES: Record<string, string> = {
  Normal: 'NRML',
  NRML: 'NRML',
  CNC: 'CNC',
  MIS: 'MIS',
  INTRADAY: 'MIS',
  CO: 'CO',
  BO: 'BO',
  MTF: 'MTF',
};

const ORDER_TYPE_CODES: Record<string, string> = {
  market: 'MKT',
  limit: 'L',
};

interface KotakEnvelope {
  data?: unknown;
  error?: Array<{ code?: string; message?: string }> | string;
  stCode?: number;
  errMsg?: string;
  [key: string]: unknown;
}

/**
 * Strip credential-shaped values out of broker text.
 *
 * Kotak's envelopes carry view tokens, session tokens and server ids, and an
 * error path that echoed the envelope would put a live trading credential into
 * the log, the UI and the operator's terminal. Redaction is applied at the one
 * place broker text becomes a message, so no call site can forget it.
 */
export function redactBrokerText(input: string): string {
  return String(input)
    // Named fields inside a JSON echo.
    .replace(/("(?:token|viewToken|sessionToken|sid|serverId|mpin|totp)"\s*:\s*")[^"]*(")/gi, '$1***$2')
    // JWT-shaped values (Kotak's consumer key and tokens are JWTs).
    .replace(/eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, 'eyJ***.***.***')
    // Any other long opaque blob, which is what a token looks like bare.
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '***');
}

/**
 * Deep-sanitize a Kotak envelope for the API response: redact every string
 * value recursively so a session token never reaches the browser.
 */
export function sanitizeEnvelope(envelope: unknown): unknown {
  if (typeof envelope === 'string') return redactBrokerText(envelope);
  if (Array.isArray(envelope)) return envelope.map(sanitizeEnvelope);
  if (envelope && typeof envelope === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(envelope as Record<string, unknown>)) {
      out[key] = sanitizeEnvelope(value);
    }
    return out;
  }
  return envelope;
}

/** Human-readable text for Kotak's `error` field, which is an array of objects. */
function errorText(envelope: KotakEnvelope, fallback: string): string {
  const { error } = envelope;
  if (Array.isArray(error)) {
    const messages = error.map((entry) => entry.message ?? entry.code ?? '').filter(Boolean);
    if (messages.length > 0) return messages.join('; ');
  }
  if (typeof error === 'string' && error.trim() !== '') return error;
  return envelope.errMsg ?? fallback;
}

/** Rows from a payload that may be a bare array or wrap one under a key. */
function asRows(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value as Array<Record<string, unknown>>;
  if (value && typeof value === 'object') {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      if (Array.isArray(nested)) return nested as Array<Record<string, unknown>>;
    }
    return [value as Record<string, unknown>];
  }
  return [];
}

const num = (...values: unknown[]): number => {
  for (const value of values) {
    const parsed = Number(value);
    if (value !== undefined && value !== null && value !== '' && Number.isFinite(parsed)) return parsed;
  }
  return 0;
};

/** Numeric field, or null when it is absent — "missing" and 0 differ here. */
const maybeNum = (...values: unknown[]): number | null => {
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const str = (...values: unknown[]): string => {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return '';
};

/**
 * Aggregated depth from a quote row, when Kotak includes it.
 *
 * The `all` quote is documented to return five buy and five sell price levels.
 * Field naming varies between the generations of the API (`buy`/`sell` in the
 * maintained SDK's examples, `bids`/`asks` in community wrappers), so both are
 * read, and a row with no usable levels yields nothing rather than an empty
 * book that would render as a blank ladder.
 */
export function parseDepth(row: Record<string, unknown>): BrokerQuote['depth'] {
  const container = (row.depth && typeof row.depth === 'object' ? row.depth : {}) as Record<string, unknown>;
  const side = (name: string, ...aliases: string[]): Array<Record<string, unknown>> => {
    for (const key of [name, ...aliases]) {
      const value = container[key] ?? row[key];
      if (Array.isArray(value)) return value as Array<Record<string, unknown>>;
    }
    return [];
  };
  const levels = (rows: Array<Record<string, unknown>>): Array<{ price: number; size: number }> =>
    rows
      .map((level) => ({
        price: num(level.price, level.p, level.rate),
        size: num(level.quantity, level.qty, level.q, level.size, level.volume),
      }))
      .filter((level) => level.price > 0 && level.size > 0);

  const bids = levels(side('buy', 'bids'));
  const asks = levels(side('sell', 'asks'));
  if (bids.length === 0 && asks.length === 0) return undefined;
  // Best-first, so the ladder does not depend on the venue's ordering.
  bids.sort((a, b) => b.price - a.price);
  asks.sort((a, b) => a.price - b.price);
  return { bids, asks };
}

/**
 * Kotak's order status vocabulary → the four states the terminal understands.
 *
 * Returns null for anything unrecognised rather than guessing: a status this
 * adapter does not know must leave the local order untouched, because inventing
 * a fill — or a cancellation — from an unclear string would be worse than
 * admitting ignorance. `open`/`pending`-family strings are working orders; the
 * `* pending` variants are transient states of a request already accepted.
 */
export function mapOrderStatus(reported: string): BrokerOrderState['status'] {
  const text = reported.trim().toLowerCase().replace(/[_\s-]+/g, ' ');
  if (text === '') return null;
  if (/(partial|partially)/.test(text)) return 'partially_filled';
  if (/(complete|completed|filled|executed|traded)/.test(text)) return 'filled';
  if (/(cancel)/.test(text)) return 'cancelled';
  if (/(reject)/.test(text)) return 'rejected';
  if (/(open|pending|trig|received|validation|modified|queued)/.test(text)) return 'working';
  return null;
}

/**
 * Normalise order-book rows across the field names Kotak has used.
 *
 * A row without an order number is not an order: an empty order book arrives as
 * a bare `{ stCode, errMsg, desc, stat }` envelope, which must be dropped rather
 * than materialised as a phantom order with no id.
 */
export function mapOrderState(rows: Array<Record<string, unknown>>): BrokerOrderState[] {
  const out: BrokerOrderState[] = [];
  for (const row of rows) {
    const orderId = str(row.nOrdNo, row.orderId, row.ordNo, row.on, row.nOrderNo);
    if (!orderId) continue;

    const sideText = str(row.trnsTp, row.tt, row.side, row.transactionType).toLowerCase();
    const filledQuantity = num(row.fqty, row.filledQty, row.fillQty, row.fldQty, row.tradedQty);
    const averagePrice = maybeNum(row.avgPrc, row.avgprc, row.avgPrice, row.ap);
    // `ts` is deliberately not a candidate here: Kotak uses it for the trading
    // symbol in several payloads, and a symbol is not a timestamp.
    const reportedTime = row.lstUpdTm ?? row.ordTm ?? row.lastUpdateTime ?? row.ordTmMs;

    out.push({
      orderId,
      status: mapOrderStatus(str(row.ordSt, row.status, row.orderStatus, row.ordStDesc)),
      quantity: num(row.qty, row.quantity, row.ordQty, row.orderQty),
      filledQuantity,
      // A zero average on an unfilled order is "no fill price", not a price.
      averagePrice: averagePrice !== null && averagePrice > 0 ? averagePrice : null,
      symbol: str(row.trdSym, row.tradingSymbol, row.ts, row.sym, row.symbol),
      side: sideText === 's' || sideText === 'sell' ? 'sell' : 'buy',
      rejectReason: str(row.rejRsn, row.rejectReason, row.rejReason, row.reason) || null,
      product: str(row.prd, row.prod, row.product),
      ts: parseReportedTime(reportedTime),
    });
  }
  return out;
}

/** Epoch millis, epoch seconds or a parseable date string; otherwise null. */
function parseReportedTime(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    // Kotak mixes seconds and milliseconds; anything below ~2001 in ms is seconds.
    return numeric < 1e11 ? Math.round(numeric * 1000) : Math.round(numeric);
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

export function createKotakNeoAdapter(): BrokerAdapter {
  let session: BrokerSessionState = {
    viewToken: null,
    sid: null,
    sessionToken: null,
    baseUrl: null,
    feedUrl: null,
    rtUrl: null,
    connectedAt: null,
    expiresAt: null,
  };
  let lastError: string | null = null;
  let lastLatencyMs: number | null = null;

  /** Session host, used for the login handshake only. */
  const sessionHost = (): string => config.kotak.baseUrl.replace(/\/+$/, '');

  /**
   * Host for authenticated calls. Kotak hands back a per-account `baseUrl`
   * during validate; until then there is nothing account-specific to use.
   */
  const apiHost = (): string => (session.baseUrl ?? sessionHost()).replace(/\/+$/, '');

  const isConfigured = (): boolean => kotakMissingEnv.length === 0;

  const connected = (): boolean =>
    session.sessionToken !== null &&
    session.sid !== null &&
    session.expiresAt !== null &&
    session.expiresAt > Date.now();

  const fail = (message: string): string => {
    lastError = redactBrokerText(message);
    return lastError;
  };

  const url = (key: PathKey, params?: Record<string, string>): string => {
    const host = key === 'login' || key === 'validate' ? sessionHost() : apiHost();
    let path: string = PATHS[key];
    for (const [name, value] of Object.entries(params ?? {})) {
      path = path.replace(`{${name}}`, value);
    }
    return `${host}/${path.replace(/^\/+/, '')}`;
  };

  /** Session credentials, which every post-login call needs as `Sid`/`Auth`. */
  const sessionHeaders = (): Record<string, string> => {
    if (!session.sessionToken || !session.sid) {
      throw new Error('Kotak Neo session is not connected — log in first');
    }
    return { Sid: session.sid, Auth: session.sessionToken };
  };

  const request = async (
    key: PathKey,
    init: {
      method: 'GET' | 'POST';
      headers: Record<string, string>;
      /** JSON payload; form-encoded calls wrap it in `jData`. */
      body?: unknown;
      contentType?: 'json' | 'form';
      params?: Record<string, string>;
    },
  ): Promise<KotakEnvelope> => {
    const target = url(key, init.params);
    const contentType =
      init.contentType ?? (init.body === undefined ? undefined : 'form');

    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...init.headers,
      ...(contentType === 'json' ? { 'Content-Type': 'application/json' } : {}),
      ...(contentType === 'form' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    };

    const body =
      init.body === undefined
        ? undefined
        : contentType === 'json'
          ? JSON.stringify(init.body)
          : // The SDK posts the JSON payload inside a single `jData` form field
            // rather than as separate fields.
            new URLSearchParams({ jData: JSON.stringify(init.body) }).toString();

    const startedAt = performance.now();
    let response: Response;
    try {
      response = await fetch(target, {
        method: init.method,
        headers,
        ...(body !== undefined ? { body } : {}),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      // A bare "fetch failed" hides whether this was DNS, a refused connection,
      // a timeout or an IP allowlist dropping the packet. undici keeps the real
      // socket error in `cause`, which is the only part an operator can act on.
      const cause = (error as { cause?: { code?: string; message?: string } }).cause;
      const detail = cause?.code ?? cause?.message ?? (error instanceof Error ? error.message : String(error));
      throw new Error(fail(`Kotak Neo ${key} unreachable: ${detail} (${target})`));
    }
    lastLatencyMs = Number((performance.now() - startedAt).toFixed(1));

    const text = await response.text();
    let parsed: KotakEnvelope;
    try {
      parsed = JSON.parse(text) as KotakEnvelope;
    } catch {
      parsed = { stCode: response.status, errMsg: text.slice(0, 400) };
    }

    // Kotak reports failures in the body, sometimes with HTTP 200, so the
    // envelope is checked rather than only the status code.
    const hasError = parsed.error !== undefined && parsed.error !== null;
    if (!response.ok || hasError) {
      throw new Error(fail(`Kotak Neo ${key} failed (${response.status}): ${errorText(parsed, 'no detail')}`));
    }

    return parsed;
  };

  const unwrap = (envelope: KotakEnvelope): unknown => envelope.data ?? envelope;

  const adapter: BrokerAdapter = {
    id: 'kotakneo',
    label: 'Kotak Neo Trade API',

    isConfigured,
    missingEnv: () => [...kotakMissingEnv],
    lastLatencyMs: () => lastLatencyMs,

    status: (): BrokerStatus => ({
      provider: 'kotakneo',
      configured: isConfigured(),
      connected: connected(),
      // `live` only when a session exists; otherwise the platform is simulated.
      mode: connected() ? 'live' : 'simulated',
      venueLabel: 'Kotak Neo (NSE/BSE)',
      accountLabel: connected() && config.kotak.ucc ? `UCC ${config.kotak.ucc}` : null,
      sessionExpiresAt: session.expiresAt,
      connectedAt: session.connectedAt,
      lastError,
      missingEnv: [...kotakMissingEnv],
      endpoints: [
        { label: 'session host', path: sessionHost() },
        { label: 'account host', path: session.baseUrl ?? '(set by validate)' },
        { label: 'market feed', path: session.feedUrl ?? '(set by validate)' },
        { label: 'login', path: PATHS.login },
        { label: 'validate', path: PATHS.validate },
        { label: 'quote', path: PATHS.quote },
        { label: 'scrip master', path: PATHS.scripMaster },
        { label: 'positions', path: PATHS.positions },
        { label: 'limits', path: PATHS.limits },
        { label: 'place order', path: PATHS.placeOrder },
        { label: 'order book', path: PATHS.orderBook },
      ],
    }),

    login: async (input) => {
      if (!isConfigured()) {
        throw new Error(fail(`Missing environment variables: ${kotakMissingEnv.join(', ')}`));
      }
      if (!config.kotak.consumerKey) {
        throw new Error(fail('KOTAK_NEO_CONSUMER_KEY is required'));
      }

      const totp =
        input.totp?.trim() ||
        config.kotak.totpCode ||
        (config.kotak.totpSecret ? generateTotp(config.kotak.totpSecret) : '');
      if (!totp) {
        throw new Error(
          fail(
            'No TOTP available: set KOTAK_NEO_TOTP_SECRET (recommended) or KOTAK_NEO_TOTP_CODE, or pass one in the request',
          ),
        );
      }

      // Step 1 — TOTP login issues the view token and the login server id.
      const loginEnvelope = await request('login', {
        method: 'POST',
        contentType: 'json',
        headers: { Authorization: config.kotak.consumerKey, 'neo-fin-key': FIN_KEY },
        body: {
          mobileNumber: config.kotak.mobile,
          ucc: config.kotak.ucc,
          totp,
        },
      });
      const loginData = unwrap(loginEnvelope) as Record<string, unknown>;
      const viewToken = str(loginData.token, loginData.viewToken);
      const loginSid = str(loginData.sid, loginData.serverId);
      if (!viewToken || !loginSid) {
        throw new Error(
          fail(`Login did not return a view token. Response: ${JSON.stringify(loginEnvelope).slice(0, 300)}`),
        );
      }

      // Step 2 — MPIN validation exchanges it for the trade session, and hands
      // back the account's own REST host.
      const validateEnvelope = await request('validate', {
        method: 'POST',
        contentType: 'json',
        headers: {
          Authorization: config.kotak.consumerKey,
          'neo-fin-key': FIN_KEY,
          sid: loginSid,
          Auth: viewToken,
        },
        body: { mpin: input.mpin?.trim() || config.kotak.mpin },
      });
      const validateData = unwrap(validateEnvelope) as Record<string, unknown>;
      const sessionToken = str(validateData.token, validateData.sessionToken);
      if (!sessionToken) {
        throw new Error(
          fail(`Validation did not return a session token. Response: ${JSON.stringify(validateEnvelope).slice(0, 300)}`),
        );
      }

      const now = Date.now();
      session = {
        viewToken,
        sid: str(validateData.sid) || loginSid,
        sessionToken,
        // Per-account REST host. Falling back to the session host keeps the
        // adapter usable if Kotak ever omits it.
        baseUrl: str(validateData.baseUrl).replace(/\/+$/, '') || sessionHost(),
        // Kotak returns the market-data and order-feed hosts with the session;
        // they are per-account too, so they cannot be configured up front.
        feedUrl: str(validateData.feedUrl) || null,
        rtUrl: str(validateData.rtUrl) || null,
        connectedAt: now,
        expiresAt: now + SESSION_TTL_MS,
      };
      lastError = null;
      return adapter.status();
    },

    logout: async () => {
      if (connected()) {
        try {
          await request('logout', { method: 'POST', headers: sessionHeaders() });
        } catch (error) {
          // A failed logout must not leave the local session marked connected.
          fail(error instanceof Error ? error.message : String(error));
        }
      }
      // The account base URL is a property of the session and is dropped with it.
      session = {
        viewToken: null,
        sid: null,
        sessionToken: null,
        baseUrl: null,
        feedUrl: null,
        rtUrl: null,
        connectedAt: null,
        expiresAt: null,
      };
    },

    quotes: async (requests) => {
      if (!connected()) throw new Error('Kotak Neo session is not connected');

      // Quotes are addressed by exchange segment plus instrument token, so
      // anything without a resolved token is reported rather than silently
      // dropped — a wrong token would quote an unrelated security.
      const resolved = requests.filter((entry) => entry.instrumentToken);
      const missing = requests.filter((entry) => !entry.instrumentToken).map((entry) => entry.symbol);
      if (resolved.length === 0) {
        throw new Error(
          `No instrument tokens resolved${missing.length > 0 ? ` for ${missing.join(', ')}` : ''} — load the Kotak scrip master first`,
        );
      }

      const instruments = resolved
        .map((entry) => `${entry.exchangeSegment}|${entry.instrumentToken}`)
        .join(',');
      const envelope = await request('quote', {
        method: 'GET',
        // Quotes authenticate with the consumer key, not the session headers.
        headers: { Authorization: config.kotak.consumerKey },
        params: { instruments, quoteType: 'all' },
      });

      const rows = asRows(unwrap(envelope));
      // Kotak keys each row by `exchange_token`, and the response order is not
      // guaranteed to match the request order. Matching by token rather than by
      // position matters: attributing one instrument's price to another would be
      // a silent error on a live chart.
      const byToken = new Map<string, Record<string, unknown>>();
      for (const row of rows) {
        const token = str(row.exchange_token, row.exchangeToken, row.token);
        if (token) byToken.set(token, row);
      }

      return resolved.map((entry, index) => {
        const row = (entry.instrumentToken ? byToken.get(entry.instrumentToken) : undefined) ?? rows[index] ?? {};
        const ohlc = (row.ohlc ?? {}) as Record<string, unknown>;
        const lastPrice = num(row.ltp, row.last_traded_price, row.lastPrice);

        // Kotak reports the day's move directly in `change` / `per_change`, and
        // its `ohlc.close` is the *latest* close — the same value as `ltp` — not
        // the previous one. Reading it as the previous close would make every
        // instrument report a 0.00% change.
        const change = maybeNum(row.change);
        const perChange = maybeNum(row.per_change, row.perChange);
        const previousClose =
          change !== null ? lastPrice - change : (maybeNum(ohlc.close, row.c, row.close) ?? lastPrice);
        const changePct =
          perChange !== null
            ? perChange
            : previousClose > 0
              ? ((lastPrice - previousClose) / previousClose) * 100
              : 0;

        const depth = parseDepth(row);
        return {
          symbol: entry.symbol,
          lastPrice,
          previousClose,
          changePct,
          volume: num(row.last_volume, row.last_traded_quantity, row.v, row.volume),
          ts: Date.now(),
          ...(depth ? { depth } : {}),
        } satisfies BrokerQuote;
      });
    },

    positions: async () => {
      const envelope = await request('positions', { method: 'GET', headers: sessionHeaders() });
      const rows = asRows(unwrap(envelope));

      return rows
        .map((row) => {
          const tradingSymbol = str(row.trdSym, row.tradingSymbol, row.ts);
          const quantity = num(row.netQty, row.quantity, row.qty);
          const averagePrice = num(row.avgPrc, row.averagePrice, row.ap);
          const lastPrice = num(row.ltp, row.lastPrice, averagePrice);
          return {
            symbol: tradingSymbol,
            tradingSymbol,
            quantity,
            averagePrice,
            lastPrice,
            pnl: (lastPrice - averagePrice) * quantity,
            product: str(row.prod, row.product),
          } satisfies BrokerPosition;
        })
        .filter((position) => position.quantity !== 0 || position.averagePrice !== 0);
    },

    limits: async () => {
      const envelope = await request('limits', {
        method: 'POST',
        headers: sessionHeaders(),
        contentType: 'form',
        body: { seg: 'ALL', exch: 'ALL', prod: 'ALL' },
      });
      const data = asRows(unwrap(envelope))[0] ?? {};
      return {
        netMarginAvailable: num(data.Net, data.net, data.netMarginAvailable),
        collateral: num(data.CollateralValue, data.Collateral, data.collateral),
        utilisedMargin: num(data.MarginUsed, data.utilised, data.utilisedMargin),
      } satisfies BrokerLimits;
    },

    holdings: async () => {
      const envelope = await request('holdings', { method: 'GET', headers: sessionHeaders() });
      return asRows(unwrap(envelope));
    },

    scripMasterFilePaths: async () => {
      const envelope = await request('scripMaster', {
        method: 'GET',
        headers: { Authorization: config.kotak.consumerKey },
      });
      const data = unwrap(envelope) as Record<string, unknown>;
      // `filesPaths` arrives as a flat list of strings, one CSV per segment.
      const files = data.filesPaths ?? data.files ?? data.paths;
      return (Array.isArray(files) ? files : []).filter(
        (entry): entry is string => typeof entry === 'string' && entry.trim() !== '',
      );
    },

    placeOrder: async (request_body: BrokerOrderRequest): Promise<BrokerOrderResult> => {
      if (!connected()) {
        return { ok: false, orderId: null, message: 'Kotak Neo session is not connected' };
      }

      const body: Record<string, unknown> = {
        // Abbreviated field codes are Kotak's, not ours.
        am: 'NO',
        dq: '0',
        es: request_body.exchangeSegment,
        mp: '0',
        pc: PRODUCT_CODES[request_body.product ?? 'MIS'] ?? 'MIS',
        pr: request_body.orderType === 'limit' ? request_body.price : 0,
        pt: ORDER_TYPE_CODES[request_body.orderType] ?? 'MKT',
        qt: Math.abs(request_body.quantity),
        rt: request_body.validity ?? 'DAY',
        ts: request_body.tradingSymbol,
        tt: request_body.side === 'buy' ? 'B' : 'S',
        os: ORDER_SOURCE,
        ...(request_body.instrumentToken ? { tk: request_body.instrumentToken } : {}),
        ...(request_body.tag ? { ig: request_body.tag } : {}),
      };

      try {
        const envelope = await request('placeOrder', {
          method: 'POST',
          headers: { Authorization: config.kotak.consumerKey, ...sessionHeaders() },
          contentType: 'form',
          body,
        });
        const data = asRows(unwrap(envelope))[0] ?? {};
        const orderId = str(data.nOrdNo, data.orderId, data.on);
        return {
          ok: Boolean(orderId),
          orderId: orderId || null,
          message: orderId ? 'Order accepted by Kotak Neo' : 'Kotak Neo accepted the request without an order number',
          raw: sanitizeEnvelope(envelope),
        };
      } catch (error) {
        return { ok: false, orderId: null, message: error instanceof Error ? error.message : String(error) };
      }
    },

    cancelOrder: async (orderId) => {
      if (!connected()) return { ok: false, orderId: null, message: 'Kotak Neo session is not connected' };
      try {
        const envelope = await request('cancelOrder', {
          method: 'POST',
          headers: { Authorization: config.kotak.consumerKey, ...sessionHeaders() },
          contentType: 'form',
          body: { on: orderId, am: 'NO' },
        });
        return { ok: true, orderId, message: 'Cancel request submitted', raw: envelope };
      } catch (error) {
        return { ok: false, orderId: null, message: error instanceof Error ? error.message : String(error) };
      }
    },

    orderBook: async () => {
      const envelope = await request('orderBook', { method: 'GET', headers: sessionHeaders() });
      return asRows(unwrap(envelope));
    },

    orders: async () => {
      const envelope = await request('orderBook', { method: 'GET', headers: sessionHeaders() });
      return mapOrderState(asRows(unwrap(envelope)));
    },
  };

  return adapter;
}
