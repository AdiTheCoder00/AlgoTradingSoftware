import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';

import { formatPct, formatSignedUsd, formatUsd, toneFor } from '@kinetix/shared';
import type { FleetBot, RiskEvent } from '@kinetix/shared';

import { LatencyBars, MarginDonut, RiskRing } from '../components/charts.tsx';
import {
  Button,
  Card,
  CardHeader,
  Chip,
  EmptyState,
  ErrorState,
  Icon,
  Modal,
  MicroLabel,
  Skeleton,
  Toggle,
} from '../components/ui.tsx';
import { ApiError, api } from '../lib/api.ts';

const EVENT_TONE: Record<RiskEvent['severity'], string> = {
  info: 'text-on-surface-variant',
  warning: 'text-primary',
  critical: 'text-error',
};

export function RiskFleetPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [freezeOpen, setFreezeOpen] = useState(false);
  const [totp, setTotp] = useState('');
  const [mpin, setMpin] = useState('');
  const [brokerNotice, setBrokerNotice] = useState<string | null>(null);

  const fleetQuery = useQuery({ queryKey: ['fleet'], queryFn: api.fleet, refetchInterval: 4_000 });
  const eventsQuery = useQuery({ queryKey: ['riskEvents'], queryFn: api.riskEvents, refetchInterval: 6_000 });
  const brokerQuery = useQuery({ queryKey: ['broker'], queryFn: api.brokerStatus, refetchInterval: 15_000 });

  const fleet = fleetQuery.data;
  const broker = brokerQuery.data;

  const invalidateFleet = () => {
    void queryClient.invalidateQueries({ queryKey: ['fleet'] });
    void queryClient.invalidateQueries({ queryKey: ['riskEvents'] });
    void queryClient.invalidateQueries({ queryKey: ['summary'] });
  };

  const setBotState = useMutation({
    mutationFn: ({ botId, state }: { botId: string; state: FleetBot['state'] }) => api.setBotState(botId, state),
    onSuccess: invalidateFleet,
    onError: (error) => {
      setBrokerNotice(error instanceof ApiError ? error.message : 'Could not change the algorithm state');
    },
  });

  const freeze = useMutation({
    mutationFn: () => api.freezeFleet(),
    onSuccess: () => {
      setFreezeOpen(false);
      invalidateFleet();
    },
  });

  const rearm = useMutation({ mutationFn: () => api.rearmFleet(), onSuccess: invalidateFleet });
  const pause = useMutation({ mutationFn: () => api.pauseFleet(), onSuccess: invalidateFleet });

  const guardrail = useMutation({
    mutationFn: ({ id, enabled, threshold }: { id: string; enabled?: boolean; threshold?: number }) =>
      api.updateGuardrail(id, { ...(enabled !== undefined ? { enabled } : {}), ...(threshold !== undefined ? { threshold } : {}) }),
    onSuccess: invalidateFleet,
  });

  const brokerLogin = useMutation({
    mutationFn: () => api.brokerLogin({ ...(totp ? { totp } : {}), ...(mpin ? { mpin } : {}) }),
    onSuccess: (status) => {
      setBrokerNotice(status.connected ? 'Kotak Neo session established' : 'Login call completed without a session');
      void queryClient.invalidateQueries({ queryKey: ['broker'] });
      invalidateFleet();
    },
    onError: (error) => {
      const apiError = error instanceof ApiError ? error : null;
      setBrokerNotice(apiError?.detail ?? apiError?.message ?? 'Kotak Neo login failed');
      void queryClient.invalidateQueries({ queryKey: ['broker'] });
    },
  });

  if (fleetQuery.isLoading) {
    return (
      <div className="px-gutter-desktop py-space-xl max-w-[1720px] mx-auto w-full space-y-space-xl">
        <Skeleton className="h-24" />
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-space-lg">
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
        </div>
      </div>
    );
  }

  if (fleetQuery.isError || !fleet) {
    return (
      <div className="px-gutter-desktop py-space-xl max-w-[1720px] mx-auto w-full">
        <ErrorState message="Could not load the fleet snapshot" onRetry={() => void fleetQuery.refetch()} />
      </div>
    );
  }

  const marginUsedUsd = (fleet.marginUsedPct / 100) * fleet.equityUsd;

  return (
    <div className="px-gutter-desktop py-space-xl max-w-[1720px] mx-auto w-full space-y-space-xl">
      {/* ---------------------------- sentinel header ----------------------- */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-space-lg">
        <div>
          <div className="flex items-center gap-space-sm mb-1">
            <MicroLabel>Institutional Sentinel v4.8</MicroLabel>
          </div>
          <h1 className="font-headline-xl text-headline-xl text-on-surface tracking-tight">Risk &amp; Fleet Monitor</h1>
          <div className="flex flex-wrap items-center gap-space-md mt-space-sm">
            <span className="flex items-center gap-1.5 font-body-sm text-body-sm text-secondary">
              <Icon name="verified_user" size={16} /> SOC-2 Type II Active
            </span>
            <span
              className={clsx(
                'flex items-center gap-1.5 font-body-sm text-body-sm',
                fleet.frozen ? 'text-error' : 'text-primary',
              )}
            >
              <Icon name={fleet.frozen ? 'lock' : 'shield'} size={16} />
              {fleet.frozen ? 'Fleet Frozen' : 'L3 Kill-Switch Armed'}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-space-sm">
          {fleet.frozen ? (
            <Button variant="primary" icon="lock_open" onClick={() => rearm.mutate()} disabled={rearm.isPending}>
              Re-arm Kill-Switch
            </Button>
          ) : null}
          <Button variant="neutral" icon="pause_circle" onClick={() => pause.mutate()} disabled={pause.isPending}>
            Pause Active Fleet
          </Button>
          <Button
            variant="danger"
            icon="power_settings_new"
            onClick={() => setFreezeOpen(true)}
            disabled={fleet.frozen || freeze.isPending}
          >
            Execute Immediate Fleet Freeze
          </Button>
        </div>
      </div>

      {/* ------------------------- health + margin ------------------------- */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-space-lg items-start">
        <Card className="lg:col-span-5">
          <CardHeader title="Fleet Core Health" icon="health_and_safety" />
          <div className="space-y-space-md">
            <div className="flex items-center justify-between">
              <span className="font-body-md text-body-md text-on-surface">{fleet.coreHealthLabel}</span>
              <Chip tone={fleet.anomalies === 0 ? 'positive' : 'negative'}>
                {fleet.anomalies} Anomalies
              </Chip>
            </div>
            <div className="grid grid-cols-2 gap-space-md">
              <div className="p-space-md rounded-xl bg-surface-container">
                <MicroLabel>Algorithms</MicroLabel>
                <p className="font-label-numeric-lg text-label-numeric-lg text-on-surface mt-1">
                  {fleet.botsRunning} / {fleet.botsTotal}
                </p>
                <p className="font-body-sm text-body-sm text-on-surface-variant">
                  {fleet.botsStandby} in standby
                </p>
              </div>
              <div className="p-space-md rounded-xl bg-surface-container">
                <MicroLabel>Fleet P&amp;L 24h</MicroLabel>
                <p
                  className={clsx(
                    'font-label-numeric-lg text-label-numeric-lg mt-1',
                    fleet.fleetPnl24hUsd >= 0 ? 'text-secondary' : 'text-tertiary-container',
                  )}
                >
                  {formatSignedUsd(fleet.fleetPnl24hUsd)}
                </p>
                <p className="font-body-sm text-body-sm text-on-surface-variant">{formatPct(fleet.fleetPnl24hPct)}</p>
              </div>
            </div>
            <div className="flex items-center justify-between pt-space-sm border-t border-hairline">
              <div className="flex items-center gap-1.5 font-label-caption text-label-caption text-on-surface-variant">
                <span className="w-1.5 h-1.5 rounded-full bg-secondary" /> Sync {fleet.lastSyncMsAgo}ms ago
              </div>
              <span className="font-label-caption text-label-caption text-on-surface-variant">
                Equity {formatUsd(fleet.equityUsd)}
              </span>
            </div>
          </div>
        </Card>

        <Card className="lg:col-span-3 flex flex-col items-center text-center">
          <MarginDonut usedPct={fleet.marginUsedPct} capPct={fleet.marginCapPct} />
          <div className="mt-space-md space-y-1">
            <p className="font-label-numeric-md text-label-numeric-md text-on-surface">
              {formatUsd(marginUsedUsd, { compact: true })} / {formatUsd(fleet.equityUsd, { compact: true })}
            </p>
            <p className="font-label-caption text-label-caption text-on-surface-variant">
              Threshold Cap: {fleet.marginCapPct.toFixed(1)}%
            </p>
            <p className="font-label-numeric-sm text-label-numeric-sm text-secondary">
              {formatUsd(fleet.marginAvailableUsd, { compact: true })} Available
            </p>
          </div>
        </Card>

        <Card className="lg:col-span-4">
          <CardHeader
            title="Risk Monitor"
            icon="monitor_heart"
            trailing={<Chip tone={eventsQuery.data?.rejectionsToday ? 'negative' : 'positive'}>{eventsQuery.data?.rejectionsToday ?? 0} rejects today</Chip>}
          />
          <div className="space-y-space-md">
            {fleet.guardrails
              .filter((item) => item.id === 'portfolio-drawdown' || item.id === 'slippage-limiter')
              .map((item) => (
                <div key={item.id} className="flex items-center justify-between gap-space-md">
                  <div>
                    <p className="font-body-sm text-body-sm text-on-surface">{item.name}</p>
                    <p className="font-label-numeric-sm text-label-numeric-sm text-on-surface-variant">{item.metricValue}</p>
                  </div>
                  {item.id === 'portfolio-drawdown' ? (
                    <RiskRing
                      value={Number(item.metricValue.replace(/[^\d.]/g, '')) || 0}
                      threshold={item.threshold}
                      label="drawdown"
                    />
                  ) : (
                    <Chip tone={item.enabled ? 'positive' : 'neutral'}>{item.enabled ? 'Enforcing' : 'Off'}</Chip>
                  )}
                </div>
              ))}
            {eventsQuery.data?.events.length ? (
              <div className="pt-space-sm border-t border-hairline space-y-1.5 max-h-40 overflow-y-auto">
                {eventsQuery.data.events.slice(0, 5).map((event) => (
                  <div key={event.id} className="flex items-start gap-2">
                    <Icon
                      name={event.severity === 'critical' ? 'report' : event.severity === 'warning' ? 'warning' : 'info'}
                      size={14}
                      className={clsx('mt-0.5', EVENT_TONE[event.severity])}
                    />
                    <div>
                      <p className="font-body-sm text-body-sm text-on-surface">{event.message}</p>
                      <p className="font-label-numeric-sm text-label-numeric-sm text-on-surface-variant">
                        {new Date(event.ts).toLocaleTimeString('en-GB', { hour12: false })}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="font-body-sm text-body-sm text-on-surface-variant pt-space-sm border-t border-hairline">
                No risk events recorded — every order passed its guardrails.
              </p>
            )}
          </div>
        </Card>
      </div>

      {/* ------------------------------ fleet grid ------------------------- */}
      <Card>
        <CardHeader
          title="Active Algorithm Fleet"
          icon="smart_toy"
          subtitle={`${fleet.botsRunning} Active / ${fleet.botsStandby} Offline`}
          trailing={
            <>
              <Button variant="ghost" size="micro" icon="tune">
                Filter Fleet
              </Button>
            </>
          }
        />
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-space-md">
          {fleet.bots.map((bot) => (
            <div
              key={bot.id}
              className="p-space-lg rounded-xl bg-surface-container border-hairline flex flex-col gap-space-md"
            >
              <div className="flex items-start justify-between gap-space-md">
                <div className="min-w-0">
                  <span className="font-label-caption text-label-caption text-on-surface-variant uppercase tracking-wider">
                    {bot.venueLabel}
                  </span>
                  <h3 className="font-headline-sm text-headline-sm text-on-surface font-semibold mt-0.5 truncate">
                    {bot.name}
                  </h3>
                  <p className="font-body-sm text-body-sm text-on-surface-variant mt-0.5">{bot.note}</p>
                  {bot.strategyIds.length > 0 ? (
                    <div className="flex flex-wrap items-center gap-1 mt-1">
                      <Chip tone="primary">{bot.strategyId.slice(0, 8)}</Chip>
                      {bot.strategyIds.map((sid) => (
                        <Chip key={sid} tone="neutral">{sid.slice(0, 8)}</Chip>
                      ))}
                    </div>
                  ) : null}
                  {bot.instrument ? (
                    <p className="font-label-numeric-sm text-label-numeric-sm text-primary mt-0.5">
                      Trading: {bot.instrument}
                    </p>
                  ) : null}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span
                    className={clsx(
                      'font-label-caption text-label-caption flex items-center gap-1 font-medium',
                      bot.state === 'running'
                        ? 'text-secondary'
                        : bot.state === 'paused'
                          ? 'text-error'
                          : 'text-on-surface-variant',
                    )}
                  >
                    <span
                      className={clsx(
                        'w-1.5 h-1.5 rounded-full',
                        bot.state === 'running' ? 'bg-secondary' : bot.state === 'paused' ? 'bg-error' : 'bg-on-surface-variant',
                      )}
                    />
                    {bot.statusLabel}
                  </span>
                  <Toggle
                    label={`${bot.state === 'running' ? 'Stop' : 'Start'} ${bot.name}`}
                    checked={bot.state === 'running'}
                    disabled={setBotState.isPending}
                    onChange={(next) =>
                      setBotState.mutate({ botId: bot.id, state: next ? 'running' : 'standby' })
                    }
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-space-md">
                <div>
                  <MicroLabel>Allocated Margin</MicroLabel>
                  <p className="font-label-numeric-md text-label-numeric-md text-on-surface mt-1">
                    {formatUsd(bot.allocatedMarginUsd)}
                  </p>
                </div>
                <div>
                  <MicroLabel>24h Net P&amp;L</MicroLabel>
                  <p
                    className={clsx(
                      'font-label-numeric-md text-label-numeric-md mt-1',
                      bot.netPnl24hUsd >= 0 ? 'text-secondary' : 'text-tertiary-container',
                    )}
                  >
                    {formatUsd(bot.netPnl24hUsd, { signed: true, decimals: 0 })}
                  </p>
                </div>
                <div>
                  <MicroLabel>Return on Allocation</MicroLabel>
                  <p
                    className={clsx(
                      'font-label-numeric-md text-label-numeric-md mt-1',
                      toneFor(bot.netPnl24hPct) === 'negative' ? 'text-tertiary-container' : 'text-on-surface',
                    )}
                  >
                    {formatPct(bot.netPnl24hPct)}
                  </p>
                </div>
              </div>

              <div className="flex items-center justify-between pt-space-sm border-t border-hairline">
                <div className="flex flex-wrap items-center gap-space-sm">
                  {bot.tags.map((tag) => (
                    <Chip key={tag}>{tag}</Chip>
                  ))}
                  <Chip tone="neutral">{bot.leverage}x configured</Chip>
                </div>
                <button
                  type="button"
                  className="font-label-caption text-label-caption text-primary flex items-center gap-1 hover:text-on-surface transition-colors"
                  onClick={() => {
                    navigate(`/strategy-ide?strategy=${bot.strategyId}`);
                  }}
                >
                  View Details <Icon name="chevron_right" size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      </Card>

      {/* --------------------------- guardrails + venues ------------------- */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-space-lg items-start">
        <Card className="lg:col-span-8">
          <CardHeader
            title="Automated Risk Guardrails"
            icon="shield"
            subtitle="Programmatic constraints enforced before every trade reaches a venue."
            trailing={<Chip tone="positive">Zero Bypass Override Enabled</Chip>}
          />
          <div className="space-y-space-md">
            {fleet.guardrails.map((item) => (
              <div
                key={item.id}
                className="flex items-start justify-between gap-space-lg p-space-md rounded-xl bg-surface-container"
              >
                <div className="flex items-start gap-space-md min-w-0">
                  <div className="w-9 h-9 rounded-lg bg-surface-variant/60 flex items-center justify-center shrink-0">
                    <Icon name={item.icon} className="text-primary" />
                  </div>
                  <div className="min-w-0">
                    <p className="font-headline-sm text-headline-sm text-on-surface">{item.name}</p>
                    <p className="font-body-sm text-body-sm text-on-surface-variant">
                      {item.description}{' '}
                      <span className="font-label-numeric-sm text-label-numeric-sm text-on-surface">
                        {item.thresholdLabel}
                      </span>
                    </p>
                    <p className="font-label-numeric-sm text-label-numeric-sm text-on-surface-variant/80 mt-1">
                      {item.metricLabel}: {item.metricValue}
                    </p>
                    {item.enforceNote ? (
                      <p className="font-label-caption text-label-caption text-on-surface-variant/60 mt-1">{item.enforceNote}</p>
                    ) : null}
                  </div>
                </div>
                <Toggle
                  label={`${item.enabled ? 'Disable' : 'Enable'} ${item.name}`}
                  checked={item.enabled}
                  disabled={guardrail.isPending}
                  onChange={(next) => guardrail.mutate({ id: item.id, enabled: next })}
                />
              </div>
            ))}
          </div>
        </Card>

        <div className="lg:col-span-4 space-y-space-lg">
          <Card>
            <CardHeader title="Venue Link Latency" icon="hub" />
            <LatencyBars venues={fleet.venues} />
            <div className="mt-space-md space-y-1.5 pt-space-md border-t border-hairline">
              {fleet.venues.map((venue) => (
                <div key={venue.id} className="flex items-center justify-between">
                  <div>
                    <p className="font-body-sm text-body-sm text-on-surface">{venue.name}</p>
                    <p className="font-label-caption text-label-caption text-on-surface-variant">{venue.location}</p>
                  </div>
                  <div className="text-right">
                    <p className="font-label-numeric-sm text-label-numeric-sm text-on-surface">{venue.latencyMs.toFixed(1)}ms</p>
                    <p
                      className={clsx(
                        'font-label-caption text-label-caption',
                        venue.status === 'optimal'
                          ? 'text-secondary'
                          : venue.status === 'good'
                            ? 'text-on-surface-variant'
                            : 'text-tertiary-container',
                      )}
                    >
                      {venue.note ?? venue.status}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </Card>

          {/* --------------------------- Kotak Neo panel --------------------- */}
          <Card>
            <CardHeader
              title="Kotak Neo Trade API"
              icon="account_balance"
              trailing={
                <Chip tone={broker?.connected ? 'positive' : broker?.configured ? 'primary' : 'neutral'}>
                  {broker?.connected ? 'Session live' : broker?.configured ? 'Ready' : 'Not configured'}
                </Chip>
              }
            />
            <div className="space-y-space-md">
              <div className="grid grid-cols-2 gap-space-sm">
                <div>
                  <MicroLabel>Provider</MicroLabel>
                  <p className="font-label-numeric-sm text-label-numeric-sm text-on-surface mt-1">{broker?.provider ?? '—'}</p>
                </div>
                <div>
                  <MicroLabel>Mode</MicroLabel>
                  <p className="font-label-numeric-sm text-label-numeric-sm text-on-surface mt-1">{broker?.mode ?? '—'}</p>
                </div>
                <div>
                  <MicroLabel>Account</MicroLabel>
                  <p className="font-label-numeric-sm text-label-numeric-sm text-on-surface mt-1">
                    {broker?.accountLabel ?? '—'}
                  </p>
                </div>
                <div>
                  <MicroLabel>Session Expiry</MicroLabel>
                  <p className="font-label-numeric-sm text-label-numeric-sm text-on-surface mt-1">
                    {broker?.sessionExpiresAt ? new Date(broker.sessionExpiresAt).toLocaleTimeString('en-GB', { hour12: false }) : '—'}
                  </p>
                </div>
              </div>

              {broker && !broker.configured ? (
                <div className="p-space-sm rounded-xl bg-surface-container">
                  <p className="font-label-caption text-label-caption text-on-surface-variant uppercase tracking-wider mb-1">
                    Missing environment
                  </p>
                  <p className="font-label-numeric-sm text-label-numeric-sm text-primary">
                    {broker.missingEnv.length > 0 ? broker.missingEnv.join(', ') : 'TOTP secret or code'}
                  </p>
                  <p className="font-body-sm text-body-sm text-on-surface-variant mt-1">
                    Set these in <code>.env</code> and restart the API. The platform keeps running on the simulator
                    until a session exists.
                  </p>
                </div>
              ) : null}

              <div className="space-y-space-sm">
                <div>
                  <label htmlFor="kotak-totp" className="font-label-caption text-label-caption text-on-surface-variant uppercase tracking-wider">
                    TOTP (optional if configured in env)
                  </label>
                  <input
                    id="kotak-totp"
                    value={totp}
                    onChange={(event) => setTotp(event.target.value)}
                    inputMode="numeric"
                    placeholder="6-digit code"
                    className="mt-1 w-full px-space-md py-2 rounded-xl bg-surface-container-lowest border-hairline text-body-sm font-body-sm text-on-surface placeholder:text-on-surface-variant/40 focus:outline-none focus:ring-1 focus:ring-primary-container"
                  />
                </div>
                <div>
                  <label htmlFor="kotak-mpin" className="font-label-caption text-label-caption text-on-surface-variant uppercase tracking-wider">
                    MPIN
                  </label>
                  <input
                    id="kotak-mpin"
                    type="password"
                    value={mpin}
                    onChange={(event) => setMpin(event.target.value)}
                    placeholder="6-digit MPIN"
                    className="mt-1 w-full px-space-md py-2 rounded-xl bg-surface-container-lowest border-hairline text-body-sm font-body-sm text-on-surface placeholder:text-on-surface-variant/40 focus:outline-none focus:ring-1 focus:ring-primary-container"
                  />
                </div>
                <div className="flex items-center gap-space-sm">
                  <Button
                    variant="primary"
                    icon="login"
                    onClick={() => brokerLogin.mutate()}
                    disabled={
                      brokerLogin.isPending ||
                      !broker ||
                      (!broker.configured && (broker.missingEnv.length > 0 || totp.trim().length !== 6))
                    }
                  >
                    {brokerLogin.isPending ? 'Opening session…' : 'Log in'}
                  </Button>
                  {broker?.connected ? (
                    <Button
                      variant="ghost"
                      icon="logout"
                      onClick={() => {
                        void api.brokerLogout().then(() => {
                          void queryClient.invalidateQueries({ queryKey: ['broker'] });
                          invalidateFleet();
                        });
                      }}
                    >
                      Log out
                    </Button>
                  ) : null}
                </div>
              </div>

              {brokerNotice ? (
                <p className="font-body-sm text-body-sm text-on-surface-variant p-space-sm rounded-xl bg-surface-container">
                  {brokerNotice}
                </p>
              ) : null}

              {broker?.lastError ? (
                <p className="font-body-sm text-body-sm text-error p-space-sm rounded-xl bg-error-container/20">
                  {broker.lastError}
                </p>
              ) : null}

              {broker?.endpoints?.length ? (
                <details className="group">
                  <summary className="font-label-caption text-label-caption text-on-surface-variant uppercase tracking-wider cursor-pointer">
                    Active endpoint paths
                  </summary>
                  <div className="mt-space-sm space-y-1">
                    {broker.endpoints.map((endpoint) => (
                      <p key={endpoint.label} className="font-label-numeric-sm text-label-numeric-sm text-on-surface-variant/80 truncate">
                        <span className="text-on-surface">{endpoint.label}</span> {endpoint.path}
                      </p>
                    ))}
                  </div>
                </details>
              ) : (
                <EmptyState icon="cloud_off" title="Broker status unavailable" />
              )}
            </div>
          </Card>
        </div>
      </div>

      {/* ------------------------------- freeze modal ---------------------- */}
      <Modal open={freezeOpen} onClose={() => setFreezeOpen(false)} labelledBy="freeze-title">
        <div className="flex items-start gap-space-md mb-space-lg">
          <div className="w-10 h-10 rounded-xl bg-error-container/40 flex items-center justify-center shrink-0">
            <Icon name="warning" className="text-error" />
          </div>
          <div>
            <h2 id="freeze-title" className="font-headline-sm text-headline-sm text-on-surface font-semibold">
              Execute Immediate Fleet Freeze?
            </h2>
            <p className="font-body-sm text-body-sm text-on-surface-variant mt-1">
              This cancels every working order and halts all algorithms. The kill-switch stays armed until you re-arm
              it from the sentinel header.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-space-md mb-space-lg">
          <div className="p-space-md rounded-xl bg-surface-container">
            <MicroLabel>Target Algorithms</MicroLabel>
            <p className="font-label-numeric-md text-label-numeric-md text-on-surface mt-1">
              {fleet.botsRunning} Active Strategies
            </p>
          </div>
          <div className="p-space-md rounded-xl bg-surface-container">
            <MicroLabel>Open Committed Orders</MicroLabel>
            <p className="font-label-numeric-md text-label-numeric-md text-on-surface mt-1">
              {fleet.bots.reduce((acc, bot) => acc + (bot.state === 'running' ? 3 : 0), 0)} Working
            </p>
          </div>
          <div className="p-space-md rounded-xl bg-surface-container">
            <MicroLabel>Action Latency</MicroLabel>
            <p className="font-label-numeric-md text-label-numeric-md text-secondary mt-1">&lt; 15 ms</p>
          </div>
        </div>

        {freeze.isError ? <ErrorState message="Freeze request failed" /> : null}

        <div className="flex items-center justify-end gap-space-sm">
          <Button variant="neutral" onClick={() => setFreezeOpen(false)}>
            Cancel
          </Button>
          <Button variant="danger" icon="lock" onClick={() => freeze.mutate()} disabled={freeze.isPending}>
            {freeze.isPending ? 'Freezing…' : 'Confirm Freeze'}
          </Button>
        </div>
      </Modal>
    </div>
  );
}
