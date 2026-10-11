import { useState, type ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';

import { formatPct, formatSignedUsd, formatMicros } from '@kinetix/shared';

import { Icon, LiveDot, Button } from '../components/ui.tsx';
import { api } from '../lib/api.ts';
import { useConnectionState } from '../lib/socket.ts';

/* ============================================================================
 * Application shell.
 *
 * The persistent header and footer from the mockups: product mark, primary
 * navigation, live fleet readouts, global search, and the disarm control. The
 * connection pill and latency figure are wired to the real socket rather than
 * to a constant.
 * ==========================================================================*/

const NAV_ITEMS = [
  { to: '/', label: 'Live Trading', path: 'live-trading' },
  { to: '/strategy-ide', label: 'Strategy IDE', path: 'strategy-ide' },
  { to: '/backtest', label: 'AI Backtest', path: 'ai-backtest' },
  { to: '/risk', label: 'Risk & Fleet', path: 'risk-and-fleet' },
] as const;

export function AppShell({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const connection = useConnectionState();
  const [search, setSearch] = useState('');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const navigate = useNavigate();

  const fleetQuery = useQuery({ queryKey: ['fleet'], queryFn: api.fleet, refetchInterval: 5_000 });
  const fleet = fleetQuery.data;

  const disarm = useMutation({
    mutationFn: () => api.freezeFleet(),
    onSuccess: (snapshot) => {
      queryClient.setQueryData(['fleet'], snapshot);
      void queryClient.invalidateQueries({ queryKey: ['fleet'] });
      void queryClient.invalidateQueries({ queryKey: ['riskEvents'] });
    },
  });

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <header className="fixed top-0 left-0 right-0 z-50 bg-surface-container-low/90 backdrop-blur-xl shadow-card">
        <div className="h-16 w-full px-gutter-desktop flex items-center justify-between gap-space-sm xl:gap-space-md">
          <div className="flex items-center gap-space-md xl:gap-space-lg flex-shrink-0">
            <div className="flex items-center gap-space-sm">
              <div className="w-7 h-7 rounded-xl bg-primary-container/20 flex items-center justify-center">
                <Icon name="terminal" className="text-primary" />
              </div>
              <span className="font-headline-sm text-headline-sm text-on-surface tracking-tight">
                Kinetix<span className="text-primary ml-1">Algo</span>
              </span>
            </div>

            <nav aria-label="Primary" className="hidden md:flex items-center gap-space-xs">
              {NAV_ITEMS.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.to === '/'}
                  data-path={item.path}
                  className={({ isActive }) =>
                    clsx(
                      'px-space-sm xl:px-space-md py-space-sm rounded-xl transition-colors font-body-sm text-body-sm',
                      isActive
                        ? 'bg-surface-variant text-on-surface font-medium'
                        : 'text-on-surface-variant hover:text-on-surface hover:bg-surface-container',
                    )
                  }
                >
                  {item.label}
                </NavLink>
              ))}
            </nav>

            {/* Mobile hamburger menu */}
            <button
              type="button"
              className="md:hidden p-2 rounded-xl text-on-surface-variant hover:text-on-surface hover:bg-surface-container"
              onClick={() => setMobileMenuOpen((v) => !v)}
              aria-label="Toggle navigation menu"
              aria-expanded={mobileMenuOpen}
            >
              <Icon name={mobileMenuOpen ? 'close' : 'menu'} size={20} />
            </button>
          </div>

          {/* Mobile dropdown nav */}
          {mobileMenuOpen ? (
            <nav aria-label="Mobile" className="md:hidden absolute top-16 left-0 right-0 bg-surface-container-low border-b border-hairline shadow-card">
              <div className="flex flex-col p-space-sm">
                {NAV_ITEMS.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.to === '/'}
                    data-path={item.path}
                    onClick={() => setMobileMenuOpen(false)}
                    className={({ isActive }) =>
                      clsx(
                        'px-space-md py-space-sm rounded-xl transition-colors font-body-sm text-body-sm',
                        isActive
                          ? 'bg-surface-variant text-on-surface font-medium'
                          : 'text-on-surface-variant hover:text-on-surface hover:bg-surface-container',
                      )
                    }
                  >
                    {item.label}
                  </NavLink>
                ))}
              </div>
            </nav>
          ) : null}

          <div className="hidden xl:flex items-center gap-space-sm xl:gap-space-md">
            <div className="flex items-center gap-space-sm px-space-sm xl:px-space-md py-1 rounded-xl bg-surface-container whitespace-nowrap">
              <span className="font-label-caption text-label-caption text-on-surface-variant uppercase tracking-wider">
                Fleet P&amp;L
              </span>
              <span
                className={clsx(
                  'font-label-numeric-md text-label-numeric-md',
                  (fleet?.fleetPnl24hUsd ?? 0) >= 0 ? 'text-secondary' : 'text-tertiary-container',
                )}
              >
                {fleet ? formatSignedUsd(fleet.fleetPnl24hUsd) : '—'}
              </span>
              <span
                className={clsx(
                  'font-label-numeric-sm text-label-numeric-sm px-1.5 py-0.5 rounded',
                  (fleet?.fleetPnl24hPct ?? 0) >= 0 ? 'bg-secondary/10 text-secondary' : 'bg-tertiary-container/10 text-tertiary-container',
                )}
              >
                {fleet ? formatPct(fleet.fleetPnl24hPct) : '—'}
              </span>
            </div>

            <div className="flex items-center gap-space-sm px-space-sm xl:px-space-md py-1 rounded-xl bg-surface-container whitespace-nowrap">
              <span className="font-label-caption text-label-caption text-on-surface-variant uppercase tracking-wider">
                Active Bots
              </span>
              <span className="font-label-numeric-md text-label-numeric-md text-on-surface">
                {fleet ? `${fleet.botsRunning} / ${fleet.botsTotal}` : '—'}
              </span>
            </div>

            <div className="flex items-center gap-1.5 px-space-sm xl:px-space-md py-1 rounded-xl bg-surface-container whitespace-nowrap">
              <LiveDot tone={connection.connected ? 'positive' : 'negative'} animate={connection.connected} />
              <span className="font-label-caption text-label-caption text-on-surface-variant">
                {connection.connected ? 'Clean Status' : 'Reconnecting'}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-space-sm md:gap-space-md flex-shrink-0">
            <div className="relative hidden md:block w-32 xl:w-48 flex-shrink">
              <Icon name="search" size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant" />
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && search.trim()) {
                    navigate(`/strategy-ide?q=${encodeURIComponent(search.trim())}`);
                    setSearch('');
                  }
                }}
                aria-label="Search strategies, bots"
                placeholder="Search strategies, bots..."
                className="w-full pl-9 pr-space-md py-1.5 rounded-xl bg-surface-container text-body-sm font-body-sm text-on-surface placeholder:text-on-surface-variant/50 focus:outline-none focus:ring-1 focus:ring-primary-container transition-all"
              />
            </div>

            <Button
              variant="danger"
              onClick={() => disarm.mutate()}
              disabled={disarm.isPending || fleet?.frozen === true}
              icon="power_settings_new"
              title="Freeze the fleet: cancel working orders and halt every algorithm"
            >
              <span className="hidden sm:inline">{fleet?.frozen ? 'Frozen' : 'Disarm'}</span>
            </Button>

            <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center" title="Operator">
              <Icon name="person" className="text-on-primary" />
            </div>
          </div>
        </div>
      </header>

      <main className="w-full pt-16 bg-background flex-1">
        <div className="flex flex-col w-full">{children}</div>
      </main>

      <footer className="w-full bg-surface-container-low py-space-md">
        <div className="w-full px-gutter-desktop flex flex-col sm:flex-row items-center justify-between gap-space-sm">
          <div className="flex items-center gap-space-md flex-wrap">
            <span className="font-label-caption text-label-caption text-on-surface-variant">
              © 2025 Kinetix Algo Corp. Institutional Architecture.
            </span>
            <span className="w-1 h-1 rounded-full bg-surface-variant" />
            <span className="font-label-caption text-label-caption text-secondary flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-secondary" />
              OMS Latency: {connection.latencyMs === null ? '—' : formatMicros(connection.latencyMs * 1_000)}
            </span>
            <span className="font-label-caption text-label-caption text-on-surface-variant">
              Tick seq {connection.lastSeq}
            </span>
          </div>
          <div className="flex items-center gap-space-lg">
            {['System Telemetry', 'Compliance Audit', 'API Gateway'].map((link) => (
              <button
                key={link}
                type="button"
                data-path={link.toLowerCase().replace(/\s+/g, '-')}
                className="font-label-caption text-label-caption text-on-surface-variant/70 hover:text-on-surface transition-colors"
                onClick={() => navigate('/risk')}
              >
                {link}
              </button>
            ))}
          </div>
        </div>
      </footer>
    </div>
  );
}
