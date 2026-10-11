import { z } from 'zod';

/* ============================================================================
 * Kinetix Algo — shared contracts.
 *
 * Every REST payload and WebSocket frame in the platform is defined here once
 * and inferred into TypeScript types, so the API and the web terminal can never
 * drift apart.
 * ==========================================================================*/

/* --------------------------------- enums --------------------------------- */

export const TIMEFRAMES = ['1m', '15m', '1h', '1d'] as const;
export const TimeframeSchema = z.enum(TIMEFRAMES);
export type Timeframe = z.infer<typeof TimeframeSchema>;

export const CHART_RANGES = ['1D', '1W', '1M', 'YTD', 'ALL'] as const;
export const ChartRangeSchema = z.enum(CHART_RANGES);
export type ChartRange = z.infer<typeof ChartRangeSchema>;

export const OrderSideSchema = z.enum(['buy', 'sell']);
export type OrderSide = z.infer<typeof OrderSideSchema>;

export const OrderTypeSchema = z.enum(['market', 'limit']);
export type OrderType = z.infer<typeof OrderTypeSchema>;

/**
 * Where a live (NSE) ticket is sent. `paper` fills at the live quote in the
 * local live book; `live` forwards the order to Kotak. Live is never implied —
 * it has to be asked for, on the request or by arming the routing mode.
 */
export const LiveRoutingSchema = z.enum(['paper', 'live']);
export type LiveRouting = z.infer<typeof LiveRoutingSchema>;

export const OrderStatusSchema = z.enum([
  'working',
  'filled',
  'partially_filled',
  'cancelled',
  'rejected',
]);
export type OrderStatus = z.infer<typeof OrderStatusSchema>;

export const PositionSideSchema = z.enum(['long', 'short']);
export type PositionSide = z.infer<typeof PositionSideSchema>;

export const BotStateSchema = z.enum(['running', 'standby', 'paused']);
export type BotState = z.infer<typeof BotStateSchema>;

export const VenueIdSchema = z.enum(['sim', 'kotakneo']);
export type VenueId = z.infer<typeof VenueIdSchema>;

export const ProviderSchema = z.enum(['simulated', 'kotakneo']);
export type Provider = z.infer<typeof ProviderSchema>;

export const InstrumentKindSchema = z.enum(['perpetual', 'spot', 'index', 'equity']);
export type InstrumentKind = z.infer<typeof InstrumentKindSchema>;

/* ------------------------------- instruments ------------------------------ */

export const InstrumentSchema = z.object({
  symbol: z.string(),
  displayName: z.string(),
  venue: VenueIdSchema,
  venueLabel: z.string(),
  kind: InstrumentKindSchema,
  base: z.string(),
  quote: z.string(),
  tickSize: z.number().positive(),
  priceDecimals: z.number().int().min(0).max(8),
  /** Kotak Neo instrument token, present only for broker-backed instruments. */
  instrumentToken: z.string().optional(),
  /** Kotak exchange segment code, e.g. `nse_cm`. */
  exchangeSegment: z.string().optional(),
  tradingSymbol: z.string().optional(),
});
export type Instrument = z.infer<typeof InstrumentSchema>;

/* --------------------------------- market --------------------------------- */

export const CandleSchema = z.object({
  /** Bar open time, epoch milliseconds. */
  t: z.number(),
  o: z.number(),
  h: z.number(),
  l: z.number(),
  c: z.number(),
  v: z.number(),
});
export type Candle = z.infer<typeof CandleSchema>;

export const TickSchema = z.object({
  symbol: z.string(),
  price: z.number(),
  /** Bar open time this tick belongs to, epoch ms. */
  t: z.number(),
  v: z.number(),
  ts: z.number(),
});
export type Tick = z.infer<typeof TickSchema>;

export const BookLevelSchema = z.object({
  price: z.number(),
  size: z.number(),
  total: z.number(),
});
export type BookLevel = z.infer<typeof BookLevelSchema>;

export const OrderBookSchema = z.object({
  symbol: z.string(),
  bids: z.array(BookLevelSchema),
  asks: z.array(BookLevelSchema),
  spread: z.number(),
  spreadPct: z.number(),
  mid: z.number(),
  ts: z.number(),
});
export type OrderBook = z.infer<typeof OrderBookSchema>;

/* -------------------------------- portfolio ------------------------------- */

export const PositionSchema = z.object({
  id: z.string(),
  symbol: z.string(),
  side: PositionSideSchema,
  strategyId: z.string(),
  strategyName: z.string(),
  size: z.number(),
  entryPrice: z.number(),
  markPrice: z.number(),
  leverage: z.number(),
  notionalUsd: z.number(),
  unrealizedPnlUsd: z.number(),
  unrealizedPnlPct: z.number(),
  realizedPnlUsd: z.number(),
  liquidationPrice: z.number().nullable(),
  openedAt: z.number(),
  venue: VenueIdSchema,
});
export type Position = z.infer<typeof PositionSchema>;

export const PortfolioSummarySchema = z.object({
  totalBalanceUsd: z.number(),
  balanceDelta24hUsd: z.number(),
  balanceDelta24hPct: z.number(),
  realizedPnlTodayUsd: z.number(),
  settlementsToday: z.number().int(),
  deployedAlgos: z.number().int(),
  maxAlgos: z.number().int(),
  winRate30dPct: z.number(),
  winRateDeltaVsBenchPct: z.number(),
  openPositions: z.number().int(),
  riskCeilingLabel: z.string(),
  realizedPnl30dUsd: z.number(),
  updatedAt: z.number(),
});
export type PortfolioSummary = z.infer<typeof PortfolioSummarySchema>;

export const EquityPointSchema = z.object({ t: z.number(), v: z.number() });
export type EquityPoint = z.infer<typeof EquityPointSchema>;

/* ---------------------------------- orders -------------------------------- */

export const PlaceOrderRequestSchema = z.object({
  symbol: z.string().min(1),
  side: OrderSideSchema,
  type: OrderTypeSchema,
  /** Absolute quantity in base units. Provide this or notionalUsd. */
  quantity: z.number().positive().optional(),
  notionalUsd: z.number().positive().optional(),
  price: z.number().positive().optional(),
  leverage: z.number().positive().max(100).optional(),
  strategyId: z.string().optional(),
  /** Live symbols only; ignored by the simulated venue. Defaults to paper routing. */
  routing: LiveRoutingSchema.optional(),
});
export type PlaceOrderRequest = z.infer<typeof PlaceOrderRequestSchema>;

export const OrderSchema = z.object({
  id: z.string(),
  symbol: z.string(),
  side: OrderSideSchema,
  type: OrderTypeSchema,
  quantity: z.number(),
  price: z.number().nullable(),
  filledQuantity: z.number(),
  averageFillPrice: z.number().nullable(),
  status: OrderStatusSchema,
  strategyId: z.string(),
  strategyName: z.string(),
  venue: VenueIdSchema,
  venueOrderId: z.string().nullable(),
  rejectReason: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Order = z.infer<typeof OrderSchema>;

export const FillSchema = z.object({
  id: z.string(),
  orderId: z.string(),
  symbol: z.string(),
  side: OrderSideSchema,
  quantity: z.number(),
  price: z.number(),
  slippageBps: z.number(),
  /** `entry` opens/adds exposure, `exit` closes it. */
  effect: z.enum(['entry', 'exit']),
  realizedPnlUsd: z.number(),
  strategyId: z.string(),
  ts: z.number(),
});
export type Fill = z.infer<typeof FillSchema>;

/* -------------------------------- strategies ------------------------------ */

export const StrategyParamSchema = z.object({
  key: z.string(),
  label: z.string(),
  min: z.number(),
  max: z.number(),
  step: z.number(),
  value: z.number(),
  defaultValue: z.number(),
  unit: z.string(),
  hint: z.string().optional(),
});
export type StrategyParam = z.infer<typeof StrategyParamSchema>;

export const DiagnosticSchema = z.object({
  line: z.number().int().min(1),
  column: z.number().int().min(1),
  severity: z.enum(['error', 'warning', 'info']),
  message: z.string(),
});
export type Diagnostic = z.infer<typeof DiagnosticSchema>;

export const StrategySchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  status: z.enum(['draft', 'validated', 'deployed', 'archived']),
  instrument: z.string(),
  timeframe: TimeframeSchema,
  venue: VenueIdSchema,
  language: z.literal('python'),
  source: z.string(),
  params: z.array(StrategyParamSchema),
  confidencePct: z.number(),
  updatedAt: z.number(),
  lastValidatedAt: z.number().nullable(),
  deployedBotId: z.string().nullable(),
});
export type Strategy = z.infer<typeof StrategySchema>;

export const UpdateSourceRequestSchema = z.object({ source: z.string().min(1) });
export type UpdateSourceRequest = z.infer<typeof UpdateSourceRequestSchema>;

export const UpdateParamsRequestSchema = z.object({
  params: z.record(z.string(), z.number()),
});
export type UpdateParamsRequest = z.infer<typeof UpdateParamsRequestSchema>;

export const ValidateResultSchema = z.object({
  ok: z.boolean(),
  astSynced: z.boolean(),
  diagnostics: z.array(DiagnosticSchema),
  supportedFeatures: z.array(z.string()),
  unsupportedFeatures: z.array(z.string()),
  compiledInMs: z.number(),
});
export type ValidateResult = z.infer<typeof ValidateResultSchema>;

export const SignalSampleSchema = z.object({
  label: z.string(),
  /** Signed sigma distance from the mean. */
  sigma: z.number(),
  isEntry: z.boolean(),
});
export type SignalSample = z.infer<typeof SignalSampleSchema>;

export const ConsoleLogSchema = z.object({
  ts: z.number(),
  level: z.enum(['info', 'warn', 'error', 'success']),
  scope: z.string(),
  message: z.string(),
  detail: z.string().optional(),
});
export type ConsoleLog = z.infer<typeof ConsoleLogSchema>;

export const SignalBreakdownSchema = z.object({
  confidencePct: z.number(),
  postCalibrationDeltaPct: z.number(),
  expectedPayoffR: z.number(),
  samples: z.array(SignalSampleSchema),
  entrySigma: z.number(),
  histogram: z.array(z.object({ binLabel: z.string(), count: z.number() })),
});
export type SignalBreakdown = z.infer<typeof SignalBreakdownSchema>;

/* --------------------------------- backtest ------------------------------- */

export const BacktestMetricsSchema = z.object({
  cumulativeReturnPct: z.number(),
  alphaVsBenchmarkPct: z.number(),
  benchmarkReturnPct: z.number(),
  benchmarkLabel: z.string(),
  sharpe: z.number(),
  sharpeTier: z.string(),
  sortino: z.number(),
  calmar: z.number(),
  maxDrawdownPct: z.number(),
  maxDrawdownPeakLabel: z.string(),
  maxDrawdownRecoveryDays: z.number(),
  profitFactor: z.number(),
  winRatePct: z.number(),
  grossGainsUsd: z.number(),
  grossLossesUsd: z.number(),
  totalTrades: z.number().int(),
  tradesPerWeek: z.number(),
  avgTradeReturnPct: z.number(),
  payoffRatio: z.number(),
  slippageImpactPct: z.number(),
  /** Total transaction fees charged over the run, scaled by the fee multiplier. */
  totalFeesUsd: z.number(),
});
export type BacktestMetrics = z.infer<typeof BacktestMetricsSchema>;

export const TradeSchema = z.object({
  id: z.string(),
  side: z.enum(['long', 'short']),
  entryTs: z.number(),
  exitTs: z.number(),
  entryPrice: z.number(),
  exitPrice: z.number(),
  quantity: z.number(),
  pnlUsd: z.number(),
  pnlPct: z.number(),
  rMultiple: z.number(),
  tag: z.string(),
});
export type Trade = z.infer<typeof TradeSchema>;

export const EquitySeriesSchema = z.object({
  strategy: z.array(EquityPointSchema),
  benchmark: z.array(EquityPointSchema),
  drawdown: z.array(EquityPointSchema),
});
export type EquitySeries = z.infer<typeof EquitySeriesSchema>;

export const RunBacktestRequestSchema = z.object({
  strategyId: z.string(),
  range: ChartRangeSchema.optional(),
  /** Parameter overrides, used by the one-click insight application. */
  params: z.record(z.string(), z.number()).optional(),
  /** Fee multiplier, used by the copilot's fee-shock re-simulation. */
  feeMultiplier: z.number().positive().max(20).optional(),
});
export type RunBacktestRequest = z.infer<typeof RunBacktestRequestSchema>;

export const BacktestRunSchema = z.object({
  id: z.string(),
  strategyId: z.string(),
  strategyName: z.string(),
  instrumentLabel: z.string(),
  rangeLabel: z.string(),
  candleCount: z.number().int(),
  tickQualityPct: z.number(),
  feeMultiplier: z.number(),
  params: z.record(z.string(), z.number()),
  metrics: BacktestMetricsSchema,
  trades: z.array(TradeSchema),
  computeMs: z.number(),
  createdAt: z.number(),
  status: z.enum(['queued', 'running', 'complete', 'failed']),
  error: z.string().nullable(),
});
export type BacktestRun = z.infer<typeof BacktestRunSchema>;

export const InsightSchema = z.object({
  id: z.string(),
  runId: z.string(),
  title: z.string(),
  description: z.string(),
  category: z.string(),
  headlineMetricLabel: z.string(),
  headlineMetricValue: z.string(),
  impactLabel: z.string(),
  impactTone: z.enum(['positive', 'warning', 'neutral']),
  status: z.enum(['available', 'applying', 'applied']),
  paramPatch: z.record(z.string(), z.number()),
  appliedResult: z
    .object({
      metric: z.string(),
      before: z.string(),
      after: z.string(),
      valueBefore: z.number(),
      valueAfter: z.number(),
    })
    .nullable(),
});
export type Insight = z.infer<typeof InsightSchema>;

export const ApplyInsightResponseSchema = z.object({
  insight: InsightSchema,
  run: BacktestRunSchema,
});
export type ApplyInsightResponse = z.infer<typeof ApplyInsightResponseSchema>;

export const BacktestDetailSchema = z.object({
  run: BacktestRunSchema,
  series: EquitySeriesSchema,
  insights: z.array(InsightSchema),
});
export type BacktestDetail = z.infer<typeof BacktestDetailSchema>;

export const CopilotRequestSchema = z.object({
  strategyId: z.string(),
  runId: z.string().optional(),
  question: z.string().min(1).max(600),
});
export type CopilotRequest = z.infer<typeof CopilotRequestSchema>;

export const CopilotAnswerSchema = z.object({
  id: z.string(),
  question: z.string(),
  answer: z.string(),
  intent: z.string(),
  groundedOn: z.array(z.string()),
  computeMs: z.number(),
  /** Set when the answer required a fresh simulation (e.g. a fee shock). */
  resimulatedRunId: z.string().nullable(),
});
export type CopilotAnswer = z.infer<typeof CopilotAnswerSchema>;

/* ------------------------------- fleet & risk ----------------------------- */

export const FleetBotSchema = z.object({
  id: z.string(),
  name: z.string(),
  strategyId: z.string(),
  /** Additional strategies in a combined bot (Phase 2). */
  strategyIds: z.array(z.string()).default([]),
  /** Instrument override — when set, the bot trades this instead of the strategy's default (Phase 1). */
  instrument: z.string().optional(),
  venue: VenueIdSchema,
  venueLabel: z.string(),
  allocatedMarginUsd: z.number(),
  leverage: z.number(),
  netPnl24hUsd: z.number(),
  netPnl24hPct: z.number(),
  state: BotStateSchema,
  statusLabel: z.string(),
  tags: z.array(z.string()),
  note: z.string(),
  lastActionTs: z.number(),
});
export type FleetBot = z.infer<typeof FleetBotSchema>;

/** Deploy a strategy to a new or existing bot, with optional instrument override. */
export const DeployStrategyRequestSchema = z.object({
  instrument: z.string().optional(),
  strategyIds: z.array(z.string()).min(1).max(5).optional(),
});
export type DeployStrategyRequest = z.infer<typeof DeployStrategyRequestSchema>;

export const GuardrailSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  icon: z.string(),
  enabled: z.boolean(),
  threshold: z.number(),
  thresholdUnit: z.string(),
  thresholdLabel: z.string(),
  metricLabel: z.string(),
  metricValue: z.string(),
  enforceNote: z.string().optional(),
});
export type Guardrail = z.infer<typeof GuardrailSchema>;

export const VenueLatencySchema = z.object({
  id: z.string(),
  name: z.string(),
  location: z.string(),
  latencyMs: z.number(),
  status: z.enum(['optimal', 'good', 'degraded']),
  /** Connection state for broker-backed venues, e.g. "Session required". */
  note: z.string().optional(),
});
export type VenueLatency = z.infer<typeof VenueLatencySchema>;

export const FleetSnapshotSchema = z.object({
  bots: z.array(FleetBotSchema),
  botsRunning: z.number().int(),
  botsTotal: z.number().int(),
  botsStandby: z.number().int(),
  equityUsd: z.number(),
  allocatedMarginUsd: z.number(),
  marginUsedPct: z.number(),
  marginCapPct: z.number(),
  marginAvailableUsd: z.number(),
  fleetPnl24hUsd: z.number(),
  fleetPnl24hPct: z.number(),
  frozen: z.boolean(),
  paused: z.boolean(),
  coreHealthLabel: z.string(),
  anomalies: z.number().int(),
  lastSyncMsAgo: z.number(),
  guardrails: z.array(GuardrailSchema),
  venues: z.array(VenueLatencySchema),
  updatedAt: z.number(),
});
export type FleetSnapshot = z.infer<typeof FleetSnapshotSchema>;

export const BotStateRequestSchema = z.object({ state: BotStateSchema });
export type BotStateRequest = z.infer<typeof BotStateRequestSchema>;

export const FreezeRequestSchema = z.object({ confirm: z.literal(true) });
export type FreezeRequest = z.infer<typeof FreezeRequestSchema>;

export const UpdateGuardrailRequestSchema = z.object({
  enabled: z.boolean().optional(),
  threshold: z.number().optional(),
});
export type UpdateGuardrailRequest = z.infer<typeof UpdateGuardrailRequestSchema>;

export const RiskEventSchema = z.object({
  id: z.string(),
  ts: z.number(),
  kind: z.enum([
    'order_rejected',
    'drawdown_pause',
    'slippage_cancel',
    'fleet_freeze',
    'fleet_rearm',
    'bot_state',
    'broker',
  ]),
  severity: z.enum(['info', 'warning', 'critical']),
  message: z.string(),
  detail: z.string().optional(),
  botId: z.string().optional(),
  value: z.number().optional(),
});
export type RiskEvent = z.infer<typeof RiskEventSchema>;

export const AuditEventSchema = z.object({
  id: z.string(),
  ts: z.number(),
  actor: z.string(),
  action: z.string(),
  target: z.string(),
  result: z.enum(['ok', 'rejected', 'error']),
  detail: z.string().optional(),
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;

/* ---------------------------------- broker -------------------------------- */

export const BrokerStatusSchema = z.object({
  provider: ProviderSchema,
  configured: z.boolean(),
  connected: z.boolean(),
  mode: z.enum(['simulated', 'live']),
  venueLabel: z.string(),
  accountLabel: z.string().nullable(),
  sessionExpiresAt: z.number().nullable(),
  connectedAt: z.number().nullable(),
  lastError: z.string().nullable(),
  /** Missing environment variables, so the UI can tell the operator exactly what to set. */
  missingEnv: z.array(z.string()),
  endpoints: z.array(z.object({ label: z.string(), path: z.string() })),
});
export type BrokerStatus = z.infer<typeof BrokerStatusSchema>;

export const BrokerLoginRequestSchema = z.object({
  totp: z.string().optional(),
  mpin: z.string().optional(),
});
export type BrokerLoginRequest = z.infer<typeof BrokerLoginRequestSchema>;

/* --------------------------------- live NSE ------------------------------- */

/**
 * A real NSE price pulled from the Kotak REST quote endpoint.
 *
 * Unlike the simulator's ticks these carry the day's move as Kotak reports it,
 * and no depth — the REST quote's `depth` array arrives empty.
 */
export const LiveQuoteSchema = z.object({
  symbol: z.string(),
  /** Kotak's trading symbol for orders, e.g. `RELIANCE-EQ`. */
  tradingSymbol: z.string(),
  instrumentToken: z.string(),
  exchangeSegment: z.string(),
  lastPrice: z.number(),
  previousClose: z.number(),
  changePct: z.number(),
  volume: z.number(),
  ts: z.number(),
  tickCount: z.number(),
});
export type LiveQuote = z.infer<typeof LiveQuoteSchema>;

/** Health of the polling feed, so the terminal can show stale or stopped data. */
export const LiveFeedStatusSchema = z.object({
  enabled: z.boolean(),
  connected: z.boolean(),
  pollMs: z.number(),
  lastPollAt: z.number().nullable(),
  lastError: z.string().nullable(),
  /** Number of resolved instruments. */
  instruments: z.number(),
  polls: z.number(),
  ticks: z.number(),
});
export type LiveFeedStatus = z.infer<typeof LiveFeedStatusSchema>;

export const LiveFeedPayloadSchema = z.object({
  status: LiveFeedStatusSchema,
  instruments: z.array(InstrumentSchema),
  quotes: z.array(LiveQuoteSchema),
});
export type LiveFeedPayload = z.infer<typeof LiveFeedPayloadSchema>;

export const LiveRoutingRequestSchema = z.object({ mode: LiveRoutingSchema });
export type LiveRoutingRequest = z.infer<typeof LiveRoutingRequestSchema>;

export const BrokerOrderResultSchema = z.object({
  ok: z.boolean(),
  orderId: z.string().nullable(),
  message: z.string(),
  raw: z.unknown().optional(),
});
export type BrokerOrderResult = z.infer<typeof BrokerOrderResultSchema>;

/* ------------------------------- websocket ------------------------------- */

export const WS_CHANNELS = [
  'market',
  'book',
  'positions',
  'orders',
  'fleet',
  'logs',
  'backtest',
  'broker',
] as const;

export const wsMarketChannel = (symbol: string): string => `market:${symbol}`;
export const wsBookChannel = (symbol: string): string => `book:${symbol}`;
export const wsLogsChannel = (strategyId: string): string => `logs:${strategyId}`;
export const wsBacktestChannel = (runId: string): string => `backtest:${runId}`;

export const WsClientMessageSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('subscribe'), channels: z.array(z.string()).min(1) }),
  z.object({ op: z.literal('unsubscribe'), channels: z.array(z.string()).min(1) }),
  z.object({ op: z.literal('ping'), sentAt: z.number() }),
]);
export type WsClientMessage = z.infer<typeof WsClientMessageSchema>;

export const WsServerMessageSchema = z.object({
  channel: z.string(),
  seq: z.number(),
  ts: z.number(),
  payload: z.unknown(),
});
export type WsServerMessage = z.infer<typeof WsServerMessageSchema>;

export const WsPongSchema = z.object({
  channel: z.literal('__pong'),
  seq: z.number(),
  ts: z.number(),
  payload: z.object({ sentAt: z.number(), serverMs: z.number() }),
});
export type WsPong = z.infer<typeof WsPongSchema>;

/* --------------------------------- errors --------------------------------- */

export const ApiErrorSchema = z.object({
  error: z.string(),
  detail: z.string().optional(),
  /** Machine-readable reason, e.g. the guardrail that rejected an order. */
  code: z.string().optional(),
  guardrailId: z.string().optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;
