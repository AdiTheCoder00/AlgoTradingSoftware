import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';

import { formatNumber, formatPct, formatPrice, formatUsd, toneFor } from '@kinetix/shared';
import type { Candle, OrderBook, Position, Tick, Timeframe } from '@kinetix/shared';

import { PriceChart, type ExecutionMarkerInput } from '../components/PriceChart.tsx';
import {
  Button,
  Card,
  CardHeader,
  Chip,
  DepthBar,
  EmptyState,
  ErrorState,
  Icon,
  Metric,
  MicroLabel,
  SegmentedControl,
  Skeleton,
} from '../components/ui.tsx';
import { ApiError, api } from '../lib/api.ts';
import { useChannel } from '../lib/socket.ts';

const TIMEFRAMES: readonly Timeframe[] = ['1m', '15m', '1h', '1d'] as const;

export function LiveTradingPage() {
  const queryClient = useQueryClient();
  const [symbol, setSymbol] = useState('BTC-USD');
  const [timeframe, setTimeframe] = useState<Timeframe>('15m');
  const [notional, setNotional] = useState(25_000);
  const [ticketNotice, setTicketNotice] = useState<{ tone: 'ok' | 'error'; message: string; detail?: string } | null>(null);
  const [tick, setTick] = useState<Tick | null>(null);
  const [liveBook, setLiveBook] = useState<OrderBook | null>(null);
  /** NSE tickets trade in shares, not USD notional. */
  const [liveQty, setLiveQty] = useState(100);
  /** Where live tickets are sent: paper fill at the quote, or Kotak itself. */
  const [routing, setRouting] = useState<'paper' | 'live'>('paper');

  const instrumentsQuery = useQuery({ queryKey: ['instruments'], queryFn: api.instruments, staleTime: 60_000 });
  const summaryQuery = useQuery({ queryKey: ['summary'], queryFn: api.summary, refetchInterval: 3_000 });
  // Real NSE data, polled by the engine on its own cadence rather than pushed at
  // the simulator's tick rate.
  const liveQuery = useQuery({ queryKey: ['liveFeed'], queryFn: api.liveFeed, refetchInterval: 5_000 });
  // The live book: this terminal's paper NSE positions plus, when a Kotak
  // session is open, the positions held at the broker itself.
  const liveTradingQuery = useQuery({ queryKey: ['liveTrading'], queryFn: api.liveTrading, refetchInterval: 5_000 });
  const liveTrading = liveTradingQuery.data;
  const armedMode = liveTrading?.status.mode ?? 'paper';

  useEffect(() => {
    // The server owns the routing opt-in; the toggle mirrors it rather than
    // holding its own state, so a reload never silently disarms live routing.
    setRouting(armedMode);
  }, [armedMode]);
  const liveInstruments = liveQuery.data?.instruments ?? [];
  /**
   * A live symbol is namespaced by exchange (`NSE:RELIANCE`), so it can never be
   * mistaken for a simulator instrument — which matters because the two fill in
   * completely different ways.
   */
  const isLive = liveInstruments.some((candidate) => candidate.symbol === symbol);
  const liveQuote = liveQuery.data?.quotes.find((candidate) => candidate.symbol === symbol) ?? null;
  const candlesQuery = useQuery({
    queryKey: ['candles', symbol, timeframe, isLive],
    queryFn: () => (isLive ? api.liveCandles(symbol, timeframe, 200) : api.candles(symbol, timeframe, 200)),
    // Live bars are accumulated from polls, so they advance on the feed's cadence.
    refetchInterval: isLive ? 15_000 : 30_000,
  });
  const bookQuery = useQuery({
    queryKey: ['orderbook', symbol],
    queryFn: () => api.orderBook(symbol, 5),
    // Kotak's REST quote carries no depth, so there is no book to fetch.
    enabled: !isLive,
  });
  const markersQuery = useQuery({
    queryKey: ['markers', symbol],
    queryFn: () => api.markers(symbol),
    refetchInterval: 15_000,
    // Fill markers belong to the simulated book; nothing fills on a live symbol.
    enabled: !isLive,
  });
  const positionsQuery = useQuery({ queryKey: ['positions'], queryFn: api.positions, refetchInterval: 2_000 });
  const fleetQuery = useQuery({ queryKey: ['fleet'], queryFn: api.fleet, refetchInterval: 5_000 });

  const instrument =
    instrumentsQuery.data?.instruments.find((candidate) => candidate.symbol === symbol) ??
    liveInstruments.find((candidate) => candidate.symbol === symbol);

  // Live tape.
  useChannel<Tick>(`market:${symbol}`, (payload) => {
    setTick(payload);
    queryClient.setQueryData<Tick | null>(['tick', symbol], payload);
  });
  useChannel<OrderBook>(`book:${symbol}`, (payload) => setLiveBook(payload));
  useChannel<{ positions: Position[] }>('positions', (payload) => {
    queryClient.setQueryData(['positions'], payload);
  });

  useEffect(() => {
    // Switching instrument must not leave the previous symbol's book on screen.
    setLiveBook(null);
    setTick(null);
  }, [symbol]);

  // A live instrument shows only a book the venue actually sent — never a
  // simulated ladder standing in for one. When Kotak's quote carries no depth,
  // the panel says so instead.
  const book = isLive ? liveBook : (liveBook ?? bookQuery.data ?? null);
  const bookCurrency = isLive ? '₹' : '$';
  const snapshotPrice =
    tick?.price ?? (isLive ? liveQuote?.lastPrice : candlesQuery.data?.candles.at(-1)?.c) ?? 0;
  // The day's move comes from Kotak itself for live instruments; deriving it from
  // the last two bars would compare the forming bar against the previous poll.
  const previousClose = isLive
    ? (liveQuote?.previousClose ?? snapshotPrice)
    : (candlesQuery.data?.candles.at(-2)?.c ?? snapshotPrice);
  const changeUsd = isLive && liveQuote ? liveQuote.lastPrice - liveQuote.previousClose : snapshotPrice - previousClose;
  const changePct = isLive && liveQuote ? liveQuote.changePct : previousClose > 0 ? (changeUsd / previousClose) * 100 : 0;
  const decimals = instrument?.priceDecimals ?? 2;

  const markers: ExecutionMarkerInput[] = useMemo(
    () =>
      (markersQuery.data?.markers ?? []).map((marker) => ({
        ts: marker.ts,
        price: marker.price,
        side: marker.side,
        effect: marker.effect,
        label: marker.label,
      })),
    [markersQuery.data],
  );

  const pollLive = useMutation({
    mutationFn: () => api.pollLive(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['liveFeed'] });
      void queryClient.invalidateQueries({ queryKey: ['candles'] });
    },
  });

  const armRouting = useMutation({
    mutationFn: (mode: 'paper' | 'live') => api.setLiveRouting(mode),
    onSuccess: (status) => {
      setRouting(status.mode);
      setTicketNotice(
        status.mode === 'live'
          ? {
              tone: 'error',
              message: 'Live routing armed — NSE tickets are now sent to Kotak Neo',
              detail: 'Switch back to Paper to go back to local fills.',
            }
          : { tone: 'ok', message: 'Routing returned to paper — fills stay local' },
      );
      void queryClient.invalidateQueries({ queryKey: ['liveTrading'] });
    },
    onError: (error) => {
      setTicketNotice({ tone: 'error', message: error instanceof Error ? error.message : 'Could not change routing' });
    },
  });

  const placeOrder = useMutation({
    mutationFn: (side: 'buy' | 'sell') =>
      isLive
        ? api.placeOrder({ symbol, side, type: 'market', quantity: liveQty, routing })
        : api.placeOrder({ symbol, side, type: 'market', notionalUsd: notional, leverage: 10 }),
    onSuccess: (result) => {
      if (result.routing === 'live') {
        // Nothing filled locally: the broker owns the order from here.
        setTicketNotice({
          tone: 'ok',
          message: result.message ?? 'Order sent to Kotak Neo',
          detail: result.order.venueOrderId ? `Broker order ${result.order.venueOrderId}` : undefined,
        });
      } else if (result.fill) {
        setTicketNotice({
          tone: 'ok',
          message: `${result.fill.side === 'buy' ? 'Buy' : 'Sell'} ${formatNumber(result.fill.quantity, 0)} ${instrument?.base ?? symbol} · paper fill at the live quote`,
          detail: `@ ${formatPrice(result.fill.price, decimals)}${isLive ? ' INR' : ''}`,
        });
      } else if (result.order.status === 'working') {
        setTicketNotice({ tone: 'ok', message: result.message ?? 'Order resting', detail: `Limit ${result.order.price ?? ''}` });
      } else {
        setTicketNotice({
          tone: 'ok',
          message: `${result.order.side === 'buy' ? 'Buy' : 'Sell'} filled · ${formatUsd(notional)} ${symbol}`,
          detail: `${formatNumber(result.order.filledQuantity, 6)} @ ${formatPrice(result.order.averageFillPrice ?? 0, decimals)}`,
        });
      }
      for (const key of [['positions'], ['summary'], ['fleet'], ['markers', symbol], ['orders'], ['liveTrading']]) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
    },
    onError: (error) => {
      const apiError = error instanceof ApiError ? error : null;
      setTicketNotice({
        tone: 'error',
        message: apiError?.message ?? 'Order rejected',
        ...(apiError?.guardrailId ? { detail: `Blocked by guardrail: ${apiError.guardrailId}` } : {}),
      });
      void queryClient.invalidateQueries({ queryKey: ['fleet'] });
      void queryClient.invalidateQueries({ queryKey: ['riskEvents'] });
    },
  });

  const closePosition = useMutation({
    mutationFn: (id: string) => api.closePosition(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['positions'] });
      void queryClient.invalidateQueries({ queryKey: ['summary'] });
      void queryClient.invalidateQueries({ queryKey: ['fleet'] });
    },
  });

  const closeLive = useMutation({
    mutationFn: (id: string) => api.closeLivePosition(id),
    onSuccess: (result) => {
      setTicketNotice({ tone: 'ok', message: result.message ?? 'Live position closed' });
      void queryClient.invalidateQueries({ queryKey: ['liveTrading'] });
      void queryClient.invalidateQueries({ queryKey: ['orders'] });
    },
    onError: (error) => {
      setTicketNotice({ tone: 'error', message: error instanceof Error ? error.message : 'Close failed' });
    },
  });

  const summary = summaryQuery.data;
  const asks = book ? [...book.asks].reverse() : [];
  const maxAsk = asks.reduce((acc, level) => Math.max(acc, level.size), 0);
  const maxBid = (book?.bids ?? []).reduce((acc, level) => Math.max(acc, level.size), 0);

  return (
    <div className="px-gutter-desktop py-space-xl max-w-[1720px] mx-auto w-full space-y-space-xl">
      {/* ------------------------------ KPI row ------------------------------ */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-space-lg">
        {summaryQuery.isLoading ? (
          Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="h-[152px]" />)
        ) : (
          <>
            <Metric
              label="Total Portfolio Balance"
              value={summary ? formatUsd(summary.totalBalanceUsd) : '—'}
              unit="USD"
              icon="account_balance_wallet"
              footer={
                <>
                  <Chip tone={toneFor(summary?.balanceDelta24hUsd ?? 0) === 'negative' ? 'negative' : 'positive'} icon="trending_up">
                    {formatUsd(summary?.balanceDelta24hUsd ?? 0, { signed: true })}
                  </Chip>
                  <span
                    className={clsx(
                      'font-label-numeric-sm text-label-numeric-sm font-medium',
                      (summary?.balanceDelta24hPct ?? 0) >= 0 ? 'text-secondary' : 'text-tertiary-container',
                    )}
                  >
                    {formatPct(summary?.balanceDelta24hPct ?? 0)}
                  </span>
                  <MicroLabel className="ml-auto">24h delta</MicroLabel>
                </>
              }
            />
            <Metric
              label="Today's Realized P&L"
              value={summary ? formatUsd(summary.realizedPnlTodayUsd, { signed: true }) : '—'}
              unit="USD"
              tone={toneFor(summary?.realizedPnlTodayUsd ?? 0)}
              icon="attach_money"
              footer={
                <>
                  <Chip>{summary?.settlementsToday ?? 0} settlements</Chip>
                  <MicroLabel className="ml-auto">{summary?.riskCeilingLabel ?? '—'}</MicroLabel>
                </>
              }
            />
            <Metric
              label="Active Algos"
              value={String(fleetQuery.data?.botsRunning ?? '—')}
              unit={`/ ${fleetQuery.data?.botsTotal ?? 0} deployed`}
              icon="smart_toy"
              footer={
                <>
                  <span className="relative flex h-2 w-2">
                    <span
                      className={clsx(
                        'absolute inline-flex h-full w-full rounded-full opacity-75',
                        fleetQuery.data?.frozen ? 'bg-error' : 'bg-secondary animate-ping',
                      )}
                    />
                    <span className={clsx('relative inline-flex rounded-full h-2 w-2', fleetQuery.data?.frozen ? 'bg-error' : 'bg-secondary')} />
                  </span>
                  <span
                    className={clsx(
                      'font-body-sm text-body-sm font-medium',
                      fleetQuery.data?.frozen ? 'text-error' : 'text-secondary',
                    )}
                  >
                    {fleetQuery.data?.coreHealthLabel ?? '—'}
                  </span>
                  <MicroLabel className="ml-auto">{fleetQuery.data?.anomalies ?? 0} alerts</MicroLabel>
                </>
              }
            />
            <Metric
              label="30D Execution Win Rate"
              value={summary ? `${summary.winRate30dPct.toFixed(1)}%` : '—'}
              icon="insights"
              valueClassName="text-on-surface"
              footer={
                <>
                  <span className="font-label-numeric-sm text-label-numeric-sm text-secondary">
                    {formatPct(summary?.winRateDeltaVsBenchPct ?? 0)} vs bench
                  </span>
                  <div className="w-full bg-surface-variant/60 h-1.5 rounded-full overflow-hidden mt-space-sm">
                    <div className="bg-primary h-full rounded-full" style={{ width: `${summary?.winRate30dPct ?? 0}%` }} />
                  </div>
                </>
              }
            />
          </>
        )}
      </div>

      {summaryQuery.isError ? (
        <ErrorState message="Could not load the portfolio summary" onRetry={() => void summaryQuery.refetch()} />
      ) : null}

      {/* ------------------------------ live NSE ------------------------------ */}
      {liveQuery.data ? (
        <Card>
          <CardHeader
            title="Live NSE Watchlist"
            icon="public"
            trailing={
              <>
                <Chip tone={liveQuery.data.status.connected ? 'primary' : 'negative'}>
                  {liveQuery.data.status.connected ? 'Kotak session live' : 'Session not connected'}
                </Chip>
                <MicroLabel>
                  {liveQuery.data.status.instruments} instruments · every{' '}
                  {Math.max(1, Math.round(liveQuery.data.status.pollMs / 1000))}s · {liveQuery.data.status.ticks} ticks
                </MicroLabel>
                <Button
                  variant="ghost"
                  size="micro"
                  icon="refresh"
                  onClick={() => pollLive.mutate()}
                  disabled={pollLive.isPending}
                >
                  Poll now
                </Button>
              </>
            }
          />

          {liveQuery.data.status.lastError ? (
            <p className="mb-space-sm font-body-sm text-body-sm text-tertiary-container">
              {liveQuery.data.status.lastError}
            </p>
          ) : null}

          {liveQuery.data.quotes.length === 0 ? (
            <EmptyState
              icon="cloud_off"
              title="No live quotes yet"
              description="Open a Kotak session from the Risk & Fleet screen, then poll again."
            />
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2">
              {liveQuery.data.quotes.map((quote) => (
                <button
                  key={quote.symbol}
                  type="button"
                  onClick={() => setSymbol(quote.symbol)}
                  className={clsx(
                    'flex items-center justify-between gap-space-sm px-space-md py-space-sm rounded-xl text-left transition-colors',
                    quote.symbol === symbol
                      ? 'bg-primary/10 ring-1 ring-primary/40'
                      : 'bg-surface-container hover:bg-surface-variant',
                  )}
                >
                  <span>
                    <span className="block font-body-md text-body-md text-on-surface">{quote.tradingSymbol}</span>
                    <MicroLabel>
                      {quote.exchangeSegment} · {quote.instrumentToken}
                    </MicroLabel>
                  </span>
                  <span className="text-right">
                    <span className="block font-label-numeric-md text-label-numeric-md text-on-surface">
                      {formatPrice(quote.lastPrice, 2)}
                    </span>
                    <span
                      className={clsx(
                        'block font-label-numeric-sm text-label-numeric-sm',
                        quote.changePct >= 0 ? 'text-secondary' : 'text-tertiary-container',
                      )}
                    >
                      {formatPct(quote.changePct)}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </Card>
      ) : null}

      {/* --------------------- chart + order book ---------------------- */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-space-lg items-start">
        <Card className="lg:col-span-8">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-space-md mb-space-lg">
            <div className="flex items-center gap-space-md">
              <div className="w-10 h-10 rounded-xl bg-surface-container flex items-center justify-center">
                <span className="font-label-numeric-md text-label-numeric-md font-bold text-primary">
                  {instrument?.base.slice(0, 1).toUpperCase() ?? '₿'}
                </span>
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <label htmlFor="symbol-select" className="sr-only">
                    Instrument
                  </label>
                  <select
                    id="symbol-select"
                    value={symbol}
                    onChange={(event) => setSymbol(event.target.value)}
                    className="bg-transparent font-headline-sm text-headline-sm font-semibold text-on-surface focus:outline-none cursor-pointer"
                  >
                    {liveInstruments.length > 0 ? (
                      <optgroup label="Kotak Neo — live NSE">
                        {liveInstruments.map((candidate) => (
                          <option key={candidate.symbol} value={candidate.symbol} className="bg-surface-container">
                            {candidate.displayName}
                          </option>
                        ))}
                      </optgroup>
                    ) : null}
                    <optgroup label="Simulated venues">
                      {(instrumentsQuery.data?.instruments ?? []).map((candidate) => (
                        <option key={candidate.symbol} value={candidate.symbol} className="bg-surface-container">
                          {candidate.displayName}
                        </option>
                      ))}
                    </optgroup>
                  </select>
                  <span className="px-2 py-0.5 rounded bg-surface-variant font-label-caption text-label-caption text-on-surface-variant">
                    {instrument?.kind === 'perpetual' ? 'Perpetual' : (instrument?.kind ?? '—')}
                  </span>
                  <span className="px-2 py-0.5 rounded bg-surface-variant font-label-caption text-label-caption text-on-surface-variant">
                    {instrument?.venueLabel ?? '—'}
                  </span>
                </div>
                <div className="flex items-baseline gap-space-sm mt-0.5">
                  <span className="font-label-numeric-lg text-label-numeric-lg text-on-surface font-semibold">
                    {/* Live prices are rupees; the simulator's are dollars. */}
                    {snapshotPrice > 0 ? `${isLive ? '₹' : ''}${formatPrice(snapshotPrice, decimals)}` : '—'}
                  </span>
                  <span
                    className={clsx(
                      'font-label-numeric-sm text-label-numeric-sm font-medium',
                      changeUsd >= 0 ? 'text-secondary' : 'text-tertiary-container',
                    )}
                  >
                    {/* Live prices are rupees, so they do not get a dollar sign. */}
                    {isLive ? formatPrice(changeUsd, decimals) : formatUsd(changeUsd, { signed: true, decimals })} (
                    {formatPct(changePct)})
                  </span>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-space-sm self-start sm:self-auto">
              <SegmentedControl options={TIMEFRAMES} value={timeframe} onChange={setTimeframe} ariaLabel="Chart timeframe" />
              <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-surface-container font-label-caption text-label-caption text-on-surface-variant">
                <span className="w-2 h-2 rounded-full bg-primary" /> EMA 21
              </div>
            </div>
          </div>

          {candlesQuery.isLoading ? (
            <Skeleton className="h-[360px]" />
          ) : candlesQuery.data && candlesQuery.data.candles.length > 0 ? (
            <PriceChart candles={candlesQuery.data.candles as Candle[]} markers={markers} tick={tick} height={360} />
          ) : (
            <EmptyState icon="candlestick_chart" title="No candles for this instrument" />
          )}
        </Card>

        {/* --------------------------- order book --------------------------- */}
        <Card className="lg:col-span-4 flex flex-col">
          <CardHeader
            title="Order Book"
            icon="format_list_bulleted"
            trailing={<span className="font-label-caption text-label-caption text-on-surface-variant">L2 Depth</span>}
          />

          {isLive && !book ? (
            <div className="p-space-md rounded-xl bg-surface-container flex items-start gap-2">
              <Icon name="info" size={16} />
              <div className="font-body-sm text-body-sm text-on-surface-variant">
                <p className="text-on-surface font-medium">No depth in the latest quote</p>
                <p className="mt-0.5">
                  Kotak returns five levels a side on its `all` quote when the exchange supplies them. This
                  poll carried none, so no ladder is shown rather than a synthesised one. The price and tape
                  above are live.
                </p>
              </div>
            </div>
          ) : book ? (
            <>
              <div className="grid grid-cols-3 font-label-caption text-label-caption text-on-surface-variant uppercase tracking-wider mb-2 pb-1">
                <span>Price ({bookCurrency})</span>
                <span className="text-right">Size</span>
                <span className="text-right">Total ({bookCurrency})</span>
              </div>

              <div className="space-y-1 mb-space-sm">
                {asks.map((level) => (
                  <div key={`ask-${level.price}`} className="relative grid grid-cols-3 font-label-numeric-sm text-label-numeric-sm py-1 px-1.5 rounded items-center overflow-hidden">
                    <DepthBar ratio={maxAsk > 0 ? level.size / maxAsk : 0} tone="ask" />
                    <span className="text-error font-medium z-10">{formatPrice(level.price, decimals)}</span>
                    <span className="text-right text-on-surface-variant z-10">{formatNumber(level.size, 3)}</span>
                    <span className="text-right text-on-surface-variant/80 z-10">
                      {isLive ? formatNumber(level.total, 0) : formatUsd(level.total, { decimals: 0 })}
                    </span>
                  </div>
                ))}
              </div>

              <div className="py-space-sm px-space-md rounded-xl bg-surface-container flex items-center justify-between my-space-sm">
                <div className="flex items-center gap-2">
                  <MicroLabel>Spread</MicroLabel>
                  <span className="font-label-numeric-sm text-label-numeric-sm text-on-surface font-medium">
                    {bookCurrency}
                    {book.spread.toFixed(2)} ({book.spreadPct.toFixed(4)}%)
                  </span>
                </div>
                <span className="font-label-caption text-label-caption text-secondary flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-secondary" /> Tight Feed
                </span>
              </div>

              <div className="space-y-1 mt-space-sm">
                {book.bids.map((level) => (
                  <div key={`bid-${level.price}`} className="relative grid grid-cols-3 font-label-numeric-sm text-label-numeric-sm py-1 px-1.5 rounded items-center overflow-hidden">
                    <DepthBar ratio={maxBid > 0 ? level.size / maxBid : 0} tone="bid" />
                    <span className="text-secondary font-medium z-10">{formatPrice(level.price, decimals)}</span>
                    <span className="text-right text-on-surface-variant z-10">{formatNumber(level.size, 3)}</span>
                    <span className="text-right text-on-surface-variant/80 z-10">
                      {isLive ? formatNumber(level.total, 0) : formatUsd(level.total, { decimals: 0 })}
                    </span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <Skeleton className="h-64" />
          )}

          {/* -------------------------- order ticket -------------------------- */}
          <div className="mt-space-lg pt-space-md border-t border-hairline-strong">
            {/* Live tickets trade in shares against a live quote; simulated
                tickets size in USD notional against the simulator's book. */}
            {isLive ? (
              <>
                <div className="flex items-center justify-between mb-space-sm">
                  <MicroLabel>Quantity (shares)</MicroLabel>
                  <span className="font-label-numeric-sm text-label-numeric-sm text-on-surface-variant">
                    {formatNumber(liveQty, 0)} sh · ≈ {formatPrice(liveQty * (snapshotPrice || 0), 0)} INR
                  </span>
                </div>
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={liveQty}
                  aria-label="Order quantity in shares"
                  onChange={(event) => setLiveQty(Math.max(1, Math.floor(Number(event.target.value) || 0)))}
                  className="w-full mb-space-sm bg-surface-container rounded-xl px-space-md py-space-sm font-label-numeric-sm text-label-numeric-sm text-on-surface focus:outline-none"
                />
                <div className="flex items-center justify-between gap-space-sm mb-space-md">
                  <SegmentedControl
                    options={['paper', 'live'] as const}
                    value={routing}
                    onChange={(mode) => armRouting.mutate(mode)}
                    ariaLabel="Live order routing"
                  />
                  <span
                    className={clsx(
                      'font-label-caption text-label-caption text-right',
                      routing === 'live' ? 'text-error' : 'text-on-surface-variant',
                    )}
                  >
                    {routing === 'live' ? 'Orders reach Kotak Neo' : 'Fills at the live quote'}
                  </span>
                </div>
              </>
            ) : (
              <>
                <div className="flex items-center justify-between mb-space-sm">
                  <MicroLabel>Ticket notional</MicroLabel>
                  <span className="font-label-numeric-sm text-label-numeric-sm text-on-surface-variant">
                    {formatUsd(notional)} {instrument?.quote ?? 'USD'}
                  </span>
                </div>
                <input
                  type="range"
                  min={1_000}
                  max={400_000}
                  step={1_000}
                  value={notional}
                  aria-label="Order notional in USD"
                  onChange={(event) => setNotional(Number(event.target.value))}
                  className="w-full mb-space-md accent-primary-container"
                />
              </>
            )}
            <div className="grid grid-cols-2 gap-space-sm">
              <Button
                variant="secondary"
                icon="arrow_upward"
                onClick={() => placeOrder.mutate('buy')}
                disabled={placeOrder.isPending || (isLive && !(snapshotPrice > 0))}
              >
                Market Buy
              </Button>
              <Button
                variant="neutral"
                icon="arrow_downward"
                className="text-tertiary-container"
                onClick={() => placeOrder.mutate('sell')}
                disabled={placeOrder.isPending || (isLive && !(snapshotPrice > 0))}
              >
                Market Sell
              </Button>
            </div>

            {isLive ? (
              <p className="mt-space-sm flex items-start gap-2 font-body-sm text-body-sm text-on-surface-variant">
                <Icon name={routing === 'live' ? 'warning' : 'science'} size={14} />
                <span>
                  {routing === 'live'
                    ? 'Live routing is armed: the ticket is forwarded to Kotak Neo through the broker adapter and shows up in its order book, not in the simulated one.'
                    : 'Paper mode fills at the live quote and books the position locally in rupees — no order leaves this machine.'}
                </span>
              </p>
            ) : null}

            {ticketNotice ? (
              <div
                role="status"
                className={clsx(
                  'mt-space-md p-space-sm rounded-xl font-body-sm text-body-sm flex items-start gap-2',
                  ticketNotice.tone === 'ok' ? 'bg-secondary/10 text-secondary' : 'bg-error-container/25 text-error',
                )}
              >
                <Icon name={ticketNotice.tone === 'ok' ? 'check_circle' : 'block'} size={16} />
                <div>
                  <p className="font-medium">{ticketNotice.message}</p>
                  {ticketNotice.detail ? <p className="text-on-surface-variant mt-0.5">{ticketNotice.detail}</p> : null}
                </div>
              </div>
            ) : null}
          </div>
        </Card>
      </div>

      {/* ------------------------- positions table ------------------------- */}
      <Card>
        <CardHeader
          title="Active Positions"
          trailing={
            <>
              <Chip tone="primary">{positionsQuery.data?.positions.length ?? 0} Open</Chip>
              <Button variant="ghost" size="micro" icon="tune">
                Filters
              </Button>
              <Button
                variant="ghost"
                size="micro"
                icon="download"
                onClick={() => {
                  const positions = positionsQuery.data?.positions ?? [];
                  if (positions.length === 0) return;
                  const headers = [
                    'ID',
                    'Symbol',
                    'Side',
                    'Strategy ID',
                    'Size',
                    'Entry Price',
                    'Mark Price',
                    'Unrealized PnL USD',
                    'Liquidation Price',
                  ];
                  const rows = positions.map((p) => [
                    p.id,
                    p.symbol,
                    p.side,
                    p.strategyId,
                    p.size,
                    p.entryPrice,
                    p.markPrice,
                    p.unrealizedPnlUsd,
                    p.liquidationPrice ?? '',
                  ]);
                  const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
                  const blob = new Blob([csv], { type: 'text/csv' });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = `positions-${new Date().toISOString().slice(0, 10)}.csv`;
                  a.click();
                  URL.revokeObjectURL(url);
                }}
                disabled={(positionsQuery.data?.positions.length ?? 0) === 0}
              >
                Export CSV
              </Button>
            </>
          }
        />

        {positionsQuery.isLoading ? (
          <Skeleton className="h-40" />
        ) : (positionsQuery.data?.positions.length ?? 0) === 0 ? (
          <EmptyState
            icon="inbox"
            title="No open positions"
            description="Place a market ticket or start an algorithm from the Risk & Fleet screen."
          />
        ) : (
          <div className="overflow-x-auto w-full">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="font-label-caption text-label-caption uppercase tracking-wider text-on-surface-variant">
                  <th className="py-space-sm px-space-md font-medium">Asset &amp; Side</th>
                  <th className="py-space-sm px-space-md font-medium">Strategy</th>
                  <th className="py-space-sm px-space-md font-medium text-right">Size</th>
                  <th className="py-space-sm px-space-md font-medium text-right">Entry Price</th>
                  <th className="py-space-sm px-space-md font-medium text-right">Mark Price</th>
                  <th className="py-space-sm px-space-md font-medium text-right">Unrealized P&amp;L</th>
                  <th className="py-space-sm px-space-md font-medium text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {positionsQuery.data?.positions.map((position) => (
                  <tr key={position.id} className="border-b border-hairline hover:bg-surface-container transition-colors">
                    <td className="py-space-sm px-space-md">
                      <div className="flex items-center gap-space-sm">
                        <span className="font-body-md text-body-md text-on-surface">{position.symbol}</span>
                        <span
                          className={clsx(
                            'font-label-numeric-sm text-label-numeric-sm px-space-sm py-0.5 rounded',
                            position.side === 'long'
                              ? 'bg-secondary/10 text-secondary'
                              : 'bg-tertiary-container/10 text-tertiary-container',
                          )}
                        >
                          {position.side.toUpperCase()} {position.leverage}x
                        </span>
                      </div>
                    </td>
                    <td className="py-space-sm px-space-md font-body-sm text-body-sm text-on-surface-variant">
                      {position.strategyName}
                    </td>
                    <td className="py-space-sm px-space-md text-right font-label-numeric-md text-label-numeric-md text-on-surface">
                      {formatNumber(position.size, 4)}
                    </td>
                    <td className="py-space-sm px-space-md text-right font-label-numeric-md text-label-numeric-md text-on-surface-variant">
                      {formatPrice(position.entryPrice, 2)}
                    </td>
                    <td className="py-space-sm px-space-md text-right font-label-numeric-md text-label-numeric-md text-on-surface">
                      {formatPrice(position.markPrice, 2)}
                    </td>
                    <td className="py-space-sm px-space-md text-right">
                      <span
                        className={clsx(
                          'font-label-numeric-md text-label-numeric-md',
                          position.unrealizedPnlUsd >= 0 ? 'text-secondary' : 'text-tertiary-container',
                        )}
                      >
                        {formatUsd(position.unrealizedPnlUsd, { signed: true, decimals: 0 })}
                      </span>
                      <span
                        className={clsx(
                          'block font-label-numeric-sm text-label-numeric-sm',
                          position.unrealizedPnlPct >= 0 ? 'text-secondary/70' : 'text-tertiary-container/80',
                        )}
                      >
                        {formatPct(position.unrealizedPnlPct)}
                      </span>
                    </td>
                    <td className="py-space-sm px-space-md text-right">
                      <Button
                        variant="ghost"
                        size="micro"
                        onClick={() => closePosition.mutate(position.id)}
                        disabled={closePosition.isPending}
                      >
                        Close
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* --------------------------- live NSE book --------------------------- */}
      {liveTrading &&
      (liveTrading.status.mode === 'live' || liveTrading.paper.length > 0 || (liveTrading.broker?.length ?? 0) > 0) ? (
        <Card>
          <CardHeader
            title="Live NSE Book"
            icon="public"
            trailing={
              <>
                <Chip tone={liveTrading.status.mode === 'live' ? 'negative' : 'primary'}>
                  {liveTrading.status.mode === 'live' ? 'Live routing armed' : 'Paper routing'}
                </Chip>
                <Chip tone={liveTrading.status.connected ? 'primary' : 'negative'}>
                  {liveTrading.status.connected ? 'Kotak session live' : 'Session not connected'}
                </Chip>
                <MicroLabel>{liveTrading.status.workingOrders} resting paper limits</MicroLabel>
              </>
            }
          />

          {liveTrading.brokerError ? (
            <p className="mb-space-sm font-body-sm text-body-sm text-tertiary-container">{liveTrading.brokerError}</p>
          ) : null}

          {liveTrading.paper.length === 0 && (liveTrading.broker?.length ?? 0) === 0 ? (
            <EmptyState
              icon="inbox"
              title="No live positions"
              description="Paper-fill a ticket on an NSE symbol, or open a Kotak session to see the broker's own book here."
            />
          ) : (
            <div className="space-y-2">
              {liveTrading.paper.map((position) => (
                <div
                  key={position.id}
                  className="flex items-center justify-between gap-space-md px-space-md py-space-sm rounded-xl bg-surface-container"
                >
                  <span className="flex items-center gap-space-sm min-w-0">
                    <span className="font-body-md text-body-md text-on-surface">{position.symbol}</span>
                    <span
                      className={clsx(
                        'font-label-numeric-sm text-label-numeric-sm px-2 py-0.5 rounded',
                        position.side === 'long' ? 'bg-secondary/10 text-secondary' : 'bg-tertiary-container/10 text-tertiary-container',
                      )}
                    >
                      {position.side.toUpperCase()} {formatNumber(position.size, 0)}
                    </span>
                    <MicroLabel>paper · entry ₹{formatPrice(position.entryPrice, 2)}</MicroLabel>
                  </span>
                  <span className="text-right">
                    <span
                      className={clsx(
                        'block font-label-numeric-sm text-label-numeric-sm',
                        position.unrealizedPnlUsd >= 0 ? 'text-secondary' : 'text-tertiary-container',
                      )}
                    >
                      ₹{formatPrice(position.unrealizedPnlUsd, 2)}
                    </span>
                    <MicroLabel>mark ₹{formatPrice(position.markPrice, 2)}</MicroLabel>
                  </span>
                  <Button
                    variant="ghost"
                    size="micro"
                    onClick={() => closeLive.mutate(position.id)}
                    disabled={closeLive.isPending}
                  >
                    Close
                  </Button>
                </div>
              ))}

              {(liveTrading.broker ?? []).map((position) => (
                <div
                  key={`broker-${position.tradingSymbol}`}
                  className="flex items-center justify-between gap-space-md px-space-md py-space-sm rounded-xl bg-surface-variant"
                >
                  <span className="flex items-center gap-space-sm min-w-0">
                    <span className="font-body-md text-body-md text-on-surface">{position.tradingSymbol}</span>
                    <span
                      className={clsx(
                        'font-label-numeric-sm text-label-numeric-sm px-2 py-0.5 rounded',
                        position.quantity >= 0 ? 'bg-secondary/10 text-secondary' : 'bg-tertiary-container/10 text-tertiary-container',
                      )}
                    >
                      {position.quantity >= 0 ? 'LONG' : 'SHORT'} {formatNumber(Math.abs(position.quantity), 0)}
                    </span>
                    <MicroLabel>kotak · {position.product || '—'} · avg ₹{formatPrice(position.averagePrice, 2)}</MicroLabel>
                  </span>
                  <span className="text-right">
                    <span
                      className={clsx(
                        'block font-label-numeric-sm text-label-numeric-sm',
                        position.pnl >= 0 ? 'text-secondary' : 'text-tertiary-container',
                      )}
                    >
                      ₹{formatPrice(position.pnl, 2)}
                    </span>
                    <MicroLabel>ltp ₹{formatPrice(position.lastPrice, 2)}</MicroLabel>
                  </span>
                  <Button
                    variant="ghost"
                    size="micro"
                    onClick={() => closeLive.mutate(`broker_${position.tradingSymbol}`)}
                    disabled={closeLive.isPending}
                  >
                    Close
                  </Button>
                </div>
              ))}
            </div>
          )}
        </Card>
      ) : null}
    </div>
  );
}
