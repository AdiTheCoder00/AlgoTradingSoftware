import type {
  ApplyInsightResponse,
  AuditEvent,
  BacktestDetail,
  BacktestRun,
  BrokerStatus,
  Candle,
  ConsoleLog,
  EquityPoint,
  Fill,
  FleetBot,
  FleetSnapshot,
  Guardrail,
  Insight,
  Instrument,
  LiveFeedPayload,
  LiveFeedStatus,
  Order,
  OrderBook,
  PlaceOrderRequest,
  PortfolioSummary,
  Position,
  RiskEvent,
  SignalBreakdown,
  Strategy,
  Timeframe,
  UpdateGuardrailRequest,
  ValidateResult,
} from '@kinetix/shared';

/* ============================================================================
 * REST client.
 *
 * Every payload is typed from the shared contracts, so a change to an API shape
 * fails the web typecheck rather than surfacing as `undefined` in the UI.
 * ==========================================================================*/

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly guardrailId: string | undefined;
  readonly detail: string | undefined;

  constructor(message: string, init: { status: number; code?: string; guardrailId?: string; detail?: string }) {
    super(message);
    this.name = 'ApiError';
    this.status = init.status;
    this.code = init.code;
    this.guardrailId = init.guardrailId;
    this.detail = init.detail;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  });

  const text = await response.text();
  const parsed: unknown = text.length > 0 ? safeParse(text) : null;

  if (!response.ok) {
    const body = (parsed ?? {}) as { error?: string; detail?: string; code?: string; guardrailId?: string };
    throw new ApiError(body.error ?? `Request failed with ${response.status}`, {
      status: response.status,
      ...(body.code !== undefined ? { code: body.code } : {}),
      ...(body.guardrailId !== undefined ? { guardrailId: body.guardrailId } : {}),
      ...(body.detail !== undefined ? { detail: body.detail } : {}),
    });
  }

  return parsed as T;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

export interface StrategyDetail {
  strategy: Strategy;
  validation: ValidateResult | null;
  signals: SignalBreakdown | null;
  logs: ConsoleLog[];
  latestRun: BacktestDetail | null;
}

export interface BacktestResultPayload {
  run: BacktestRun;
  series: BacktestDetail['series'];
  insights: Insight[];
  logs: ConsoleLog[];
}

/** A position as Kotak itself reports it (rupees, not the simulator's USD). */
export interface BrokerPositionPayload {
  symbol: string;
  tradingSymbol: string;
  quantity: number;
  averagePrice: number;
  lastPrice: number;
  pnl: number;
  product: string;
}

export interface LiveTradingPayload {
  status: {
    mode: 'paper' | 'live';
    connected: boolean;
    brokerConfigured: boolean;
    paperPositions: number;
    workingOrders: number;
  };
  paper: Position[];
  working: Order[];
  broker: BrokerPositionPayload[] | null;
  brokerError: string | null;
}

export interface ExecutionMarker {
  ts: number;
  price: number;
  side: 'buy' | 'sell';
  effect: 'entry' | 'exit';
  quantity: number;
  label: string;
}

export const api = {
  health: () => request<{ status: string; ticks: number; wsClients: number; seed: number }>('/api/health'),

  summary: () => request<PortfolioSummary>('/api/portfolio/summary'),
  equity: (range: string) => request<{ range: string; points: EquityPoint[] }>(`/api/portfolio/equity?range=${range}`),

  instruments: () => request<{ instruments: Instrument[] }>('/api/instruments'),

  /** Real NSE instruments and prices pulled from Kotak, plus feed health. */
  liveFeed: () => request<LiveFeedPayload>('/api/live/quotes'),
  liveCandles: (symbol: string, timeframe: Timeframe, limit = 200) =>
    request<{ symbol: string; timeframe: Timeframe; candles: Candle[]; note: string | null }>(
      `/api/live/${encodeURIComponent(symbol)}/candles?timeframe=${timeframe}&limit=${limit}`,
    ),
  pollLive: () => request<LiveFeedStatus & { polledTicks: number }>('/api/live/poll', { method: 'POST' }),
  candles: (symbol: string, timeframe: Timeframe, limit = 200) =>
    request<{ symbol: string; timeframe: Timeframe; candles: Candle[] }>(
      `/api/market/${encodeURIComponent(symbol)}/candles?timeframe=${timeframe}&limit=${limit}`,
    ),
  orderBook: (symbol: string, depth = 5) =>
    request<OrderBook>(`/api/market/${encodeURIComponent(symbol)}/orderbook?depth=${depth}`),
  markers: (symbol: string) =>
    request<{ symbol: string; markers: ExecutionMarker[] }>(
      `/api/market/${encodeURIComponent(symbol)}/execution-markers`,
    ),

  orders: () => request<{ orders: Order[]; open: Order[] }>('/api/orders'),
  placeOrder: (body: PlaceOrderRequest) =>
    request<{ order: Order; fill?: Fill | null; position?: Position | null; message?: string; routing?: 'paper' | 'live' }>(
      '/api/orders',
      { method: 'POST', body: JSON.stringify(body) },
    ),
  cancelOrder: (id: string) => request<{ order: Order }>(`/api/orders/${id}`, { method: 'DELETE' }),

  /** The live (NSE) book: routing mode, paper positions and the broker's own. */
  liveTrading: () => request<LiveTradingPayload>('/api/live/positions'),
  setLiveRouting: (mode: 'paper' | 'live') =>
    request<LiveTradingPayload['status']>('/api/live/routing', { method: 'POST', body: JSON.stringify({ mode }) }),
  closeLivePosition: (id: string) =>
    request<{ order: Order; message?: string; routing: 'paper' | 'live' }>(
      `/api/live/positions/${encodeURIComponent(id)}/close`,
      { method: 'POST' },
    ),

  positions: () => request<{ positions: Position[] }>('/api/positions'),
  closePosition: (id: string) => request<{ order: Order }>(`/api/positions/${id}/close`, { method: 'POST' }),
  fills: () => request<{ fills: Fill[] }>('/api/fills'),

  strategies: () => request<{ strategies: Strategy[] }>('/api/strategies'),
  createStrategy: (name: string) => request<{ strategy: Strategy }>('/api/strategies', { method: 'POST', body: JSON.stringify({ name }) }),
  deleteStrategy: (id: string) => request<{ success: boolean }>(`/api/strategies/${id}`, { method: 'DELETE' }),
  strategy: (id: string) => request<StrategyDetail>(`/api/strategies/${id}`),
  updateSource: (id: string, source: string) =>
    request<{ strategy: Strategy; validation: ValidateResult }>(`/api/strategies/${id}/source`, {
      method: 'PUT',
      body: JSON.stringify({ source }),
    }),
  validate: (id: string) => request<ValidateResult>(`/api/strategies/${id}/validate`, { method: 'POST' }),
  updateParams: (id: string, params: Record<string, number>) =>
    request<{ strategy: Strategy; signals: SignalBreakdown }>(`/api/strategies/${id}/params`, {
      method: 'PUT',
      body: JSON.stringify({ params }),
    }),
  paperRun: (id: string) =>
    request<{ mode: string; run: BacktestRun; logs: ConsoleLog[] }>(`/api/strategies/${id}/paper-run`, {
      method: 'POST',
    }),
  deploy: (id: string, options?: { instrument?: string; strategyIds?: string[] }) =>
    request<{ bot: FleetBot; created: boolean }>(`/api/strategies/${id}/deploy`, {
      method: 'POST',
      body: JSON.stringify(options ?? {}),
    }),

  runBacktest: (strategyId: string, options?: { range?: string; params?: Record<string, number>; feeMultiplier?: number }) =>
    request<BacktestResultPayload>('/api/backtests', {
      method: 'POST',
      body: JSON.stringify({ strategyId, ...options }),
    }),
  backtest: (runId: string) => request<BacktestDetail>(`/api/backtests/${runId}`),
  applyInsight: (runId: string, insightId: string) =>
    request<ApplyInsightResponse>(`/api/backtests/${runId}/insights/${insightId}/apply`, { method: 'POST' }),
  ask: (strategyId: string, question: string, runId?: string) =>
    request<{
      id: string;
      question: string;
      answer: string;
      intent: string;
      groundedOn: string[];
      computeMs: number;
      resimulatedRunId: string | null;
    }>('/api/ai/query', { method: 'POST', body: JSON.stringify({ strategyId, question, ...(runId ? { runId } : {}) }) }),

  fleet: () => request<FleetSnapshot>('/api/fleet'),
  venues: () => request<{ venues: FleetSnapshot['venues'] }>('/api/venues/latency'),
  setBotState: (botId: string, state: FleetBot['state']) =>
    request<{ bot: FleetBot }>(`/api/fleet/${botId}/state`, { method: 'POST', body: JSON.stringify({ state }) }),
  pauseFleet: () => request<FleetSnapshot>('/api/fleet/pause', { method: 'POST' }),
  freezeFleet: () => request<FleetSnapshot>('/api/fleet/freeze', { method: 'POST', body: JSON.stringify({ confirm: true }) }),
  rearmFleet: () => request<FleetSnapshot>('/api/fleet/rearm', { method: 'POST' }),

  guardrails: () => request<{ guardrails: Guardrail[] }>('/api/risk/guardrails'),
  updateGuardrail: (id: string, body: UpdateGuardrailRequest) =>
    request<{ guardrail: Guardrail }>(`/api/risk/guardrails/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  riskEvents: () =>
    request<{ events: RiskEvent[]; rejectionsToday: number }>('/api/risk/events?limit=25'),
  auditEvents: () => request<{ events: AuditEvent[] }>('/api/audit/events?limit=25'),

  brokerStatus: () => request<BrokerStatus>('/api/broker/status'),
  brokerLogin: (body: { totp?: string; mpin?: string }) =>
    request<BrokerStatus>('/api/broker/kotakneo/login', { method: 'POST', body: JSON.stringify(body) }),
  brokerLogout: () => request<BrokerStatus>('/api/broker/kotakneo/logout', { method: 'POST' }),
  brokerPositions: () => request<{ positions: unknown[] }>('/api/broker/kotakneo/positions'),
  brokerLimits: () =>
    request<{ netMarginAvailable: number; collateral: number; utilisedMargin: number }>('/api/broker/kotakneo/limits'),
};
