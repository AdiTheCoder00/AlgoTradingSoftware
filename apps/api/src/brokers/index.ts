import type { BrokerStatus } from '@kinetix/shared';

import { config } from '../config.ts';
import { createKotakNeoAdapter } from './kotakNeo.ts';
import type { BrokerAdapter } from './types.ts';

/* ============================================================================
 * Broker selection.
 *
 * The adapter is created once per process. When Kotak Neo is not the selected
 * venue its status is still reported, so the Risk & Fleet screen can show the
 * venue as unconfigured with the exact missing variables rather than hiding it.
 * ==========================================================================*/

let adapter: BrokerAdapter | null = null;

export function getKotakAdapter(): BrokerAdapter {
  adapter ??= createKotakNeoAdapter();
  return adapter;
}

/** Which venue new orders are routed to. */
export function executionVenue(): 'sim' | 'kotakneo' {
  return config.executionVenue === 'kotakneo' ? 'kotakneo' : 'sim';
}

export function marketVenue(): 'sim' | 'kotakneo' {
  return config.marketProvider === 'kotakneo' ? 'kotakneo' : 'sim';
}

export function brokerStatus(): BrokerStatus {
  const kotak = getKotakAdapter();
  const active = executionVenue() === 'kotakneo' || marketVenue() === 'kotakneo';

  if (active) return kotak.status();

  // Simulated mode: report the real configuration state, but make clear that the
  // running platform is not routing anything to a brokerage.
  return {
    provider: 'simulated',
    configured: kotak.isConfigured(),
    connected: kotak.status().connected,
    mode: 'simulated',
    venueLabel: 'Deterministic simulator',
    accountLabel: null,
    sessionExpiresAt: null,
    connectedAt: null,
    lastError: null,
    missingEnv: kotak.missingEnv(),
    endpoints: kotak.status().endpoints,
  };
}

export type { BrokerAdapter };
export * from './types.ts';
