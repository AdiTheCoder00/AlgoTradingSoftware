import type { DatabaseSync } from 'node:sqlite';

import type { AuditEvent, Guardrail, RiskEvent } from '@kinetix/shared';

import { bool, getDb, listRiskEvents, recordAuditEvent, recordRiskEvent } from '../db/db.ts';
import type { PortfolioService } from './portfolio.ts';

/* ============================================================================
 * Automated risk guardrails.
 *
 * These are enforced, not decorative: the fat-finger cap sits on the order path
 * and rejects tickets before they are booked; the drawdown rule pauses every
 * running algorithm; the slippage rule pulls resting limit orders once the
 * measured average slippage breaches its limit. Each breach writes a risk event
 * and an audit entry.
 * ==========================================================================*/

export interface GuardrailCheck {
  allowed: boolean;
  code: string;
  reason: string;
  guardrailId?: string;
  threshold?: number;
}

export interface RiskService {
  guardrails(): Guardrail[];
  guardrail(id: string): Guardrail | null;
  updateGuardrail(id: string, patch: { enabled?: boolean; threshold?: number }, actor: string): Guardrail | null;
  /** Pre-trade enforcement, called by the order route before booking. */
  checkOrder(input: { notionalUsd: number; symbol: string; side: 'buy' | 'sell' }): GuardrailCheck;
  recordRejection(guardrailId: string, detail: string): void;
  /** Periodic evaluation of the portfolio-level rules. */
  monitor(): void;
  isPausedByRisk(): boolean;
  events(limit?: number): RiskEvent[];
  rejectionsToday(): number;
}

export interface RiskServiceOptions {
  portfolio: PortfolioService;
  /** Invoked when a guardrail requires the fleet to stop trading. */
  onAutoPause: (reason: string) => void;
  /** Invoked when the slippage rule pulls resting orders. */
  onSlippageBreach: (orderIds: string[]) => void;
}

const FAT_FINGER = 'fat-finger-cap';
const DRAWDOWN = 'portfolio-drawdown';
const SLIPPAGE = 'slippage-limiter';

/** Slippage is measured in basis points; the guardrail threshold is a percent. */
const BPS_PER_PERCENT = 100;

export function createRiskService(options: RiskServiceOptions): RiskService {
  const db: DatabaseSync = getDb();
  const { portfolio } = options;

  let pausedByRisk = false;
  let lastSlippageActionAt = 0;
  let lastDrawdownEventAt = 0;

  const readRow = (id: string): (Omit<Guardrail, 'metricValue'> & { metricValue: string; rejections: number }) | null => {
    const row = db
      .prepare(
        `SELECT id, name, description, icon, enabled, threshold, threshold_unit AS thresholdUnit,
                threshold_label AS thresholdLabel, metric_label AS metricLabel, metric_value AS metricValue,
                enforce_note AS enforceNote, rejections
         FROM guardrails WHERE id = ?`,
      )
      .get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      name: String(row.name),
      description: String(row.description),
      icon: String(row.icon),
      enabled: Number(row.enabled) === 1,
      threshold: Number(row.threshold),
      thresholdUnit: String(row.thresholdUnit),
      thresholdLabel: String(row.thresholdLabel),
      metricLabel: String(row.metricLabel),
      metricValue: String(row.metricValue),
      ...(row.enforceNote ? { enforceNote: String(row.enforceNote) } : {}),
      rejections: Number(row.rejections ?? 0),
    };
  };

  const writeMetric = (id: string, value: string): void => {
    db.prepare('UPDATE guardrails SET metric_value = ? WHERE id = ?').run(value, id);
  };

  const bumpRejections = (id: string): void => {
    db.prepare('UPDATE guardrails SET rejections = rejections + 1 WHERE id = ?').run(id);
  };

  const guardrails = (): Guardrail[] =>
    ([FAT_FINGER, DRAWDOWN, SLIPPAGE] as const)
      .map((id) => readRow(id))
      .filter((row): row is NonNullable<typeof row> => row !== null)
      .map(({ rejections: _rejections, ...guardrail }) => guardrail);

  const checkOrder = (input: { notionalUsd: number; symbol: string; side: 'buy' | 'sell' }): GuardrailCheck => {
    const fatFinger = readRow(FAT_FINGER);
    if (!fatFinger) {
      // Fail *closed*. A missing row means the risk configuration never loaded,
      // and treating that as "no cap" would let an unbounded ticket straight
      // through — the one failure mode a size cap must never have.
      return {
        allowed: false,
        code: 'guardrail_unavailable',
        reason:
          'Fat-finger cap is not configured — refusing to route orders until the guardrails are seeded',
      };
    }
    if (!fatFinger.enabled) return { allowed: true, code: 'ok', reason: 'No guardrail active' };

    if (input.notionalUsd > fatFinger.threshold) {
      return {
        allowed: false,
        code: 'fat_finger_cap',
        guardrailId: FAT_FINGER,
        threshold: fatFinger.threshold,
        reason: `Order notional ${formatUsdCompact(input.notionalUsd)} exceeds the fat-finger cap of ${fatFinger.thresholdLabel} on ${input.symbol} ${input.side.toUpperCase()}`,
      };
    }

    if (pausedByRisk) {
      return {
        allowed: false,
        code: 'risk_paused',
        reason: 'Fleet is paused by the drawdown guardrail — new risk cannot be opened',
      };
    }

    return { allowed: true, code: 'ok', reason: 'Within all guardrails' };
  };

  const monitor = (): void => {
    const drawdown = readRow(DRAWDOWN);
    const slippage = readRow(SLIPPAGE);
    const now = Date.now();

    if (drawdown) {
      const current = portfolio.drawdownPct();
      writeMetric(DRAWDOWN, `Current DD: ${current.toFixed(2)}%`);
      const breached = drawdown.enabled && current >= drawdown.threshold;

      if (breached && !pausedByRisk && now - lastDrawdownEventAt > 5_000) {
        pausedByRisk = true;
        lastDrawdownEventAt = now;
        recordRiskEvent({
          kind: 'drawdown_pause',
          severity: 'critical',
          message: `Portfolio drawdown ${current.toFixed(2)}% breached the ${drawdown.thresholdLabel} limit — fleet paused`,
          detail: 'Every running algorithm was halted by the automated risk guardrail.',
          value: current,
        });
        recordAuditEvent({
          actor: 'risk-engine',
          action: 'pause_fleet',
          target: 'portfolio',
          result: 'ok',
          detail: `drawdown ${current.toFixed(2)}% >= ${drawdown.threshold}%`,
        });
        options.onAutoPause(`drawdown ${current.toFixed(2)}% breached ${drawdown.thresholdLabel}`);
      }

      if (!breached && pausedByRisk && current < drawdown.threshold * 0.8) {
        // Hysteresis: only re-arm once drawdown has clearly recovered, otherwise
        // a value sitting exactly on the threshold would flap every tick.
        pausedByRisk = false;
      }
    }

    if (slippage) {
      const averageBps = portfolio.averageSlippageBps();
      writeMetric(SLIPPAGE, `Avg slip: ${(averageBps / BPS_PER_PERCENT).toFixed(3)}%`);
      const breached = slippage.enabled && averageBps > slippage.threshold * BPS_PER_PERCENT;

      if (breached && now - lastSlippageActionAt > 20_000) {
        lastSlippageActionAt = now;
        const resting = portfolio.openOrders().filter((order) => order.type === 'limit');
        const ids: string[] = [];
        for (const order of resting) {
          portfolio.cancelOrder(order.id);
          ids.push(order.id);
        }
        if (ids.length > 0) {
          recordRiskEvent({
            kind: 'slippage_cancel',
            severity: 'warning',
            message: `Average slippage ${(averageBps / BPS_PER_PERCENT).toFixed(3)}% exceeded ${slippage.thresholdLabel} — ${ids.length} resting order(s) pulled`,
            detail: 'The slippage limiter cancels working limit orders to prevent chasing a widening book.',
            value: averageBps,
          });
          options.onSlippageBreach(ids);
        }
      }
    }
  };

  return {
    guardrails,
    guardrail: (id) => guardrails().find((guardrail) => guardrail.id === id) ?? null,

    updateGuardrail: (id, patch, actor) => {
      const existing = readRow(id);
      if (!existing) return null;
      const enabled = patch.enabled ?? existing.enabled;
      const threshold = patch.threshold ?? existing.threshold;
      db.prepare('UPDATE guardrails SET enabled = ?, threshold = ?, threshold_label = ? WHERE id = ?').run(
        bool(enabled),
        threshold,
        `${threshold}${existing.thresholdUnit}`,
        id,
      );
      recordAuditEvent({
        actor,
        action: 'update_guardrail',
        target: id,
        result: 'ok',
        detail: `enabled=${enabled} threshold=${threshold}`,
      });
      const updated = readRow(id);
      if (!updated) return null;
      const { rejections: _rejections, ...guardrail } = updated;
      return guardrail;
    },

    checkOrder,
    recordRejection: (guardrailId, detail) => {
      bumpRejections(guardrailId);
      if (guardrailId === FAT_FINGER) {
        const row = readRow(FAT_FINGER);
        writeMetric(FAT_FINGER, `${row?.rejections ?? 0} Rejections today`);
      }
      recordRiskEvent({ kind: 'order_rejected', severity: 'warning', message: detail, detail });
    },

    monitor,
    isPausedByRisk: () => pausedByRisk,
    events: (limit = 50) => listRiskEvents(limit),
    rejectionsToday: () => {
      const row = db
        .prepare("SELECT COUNT(*) AS n FROM risk_events WHERE kind = 'order_rejected' AND ts >= ?")
        .get(startOfDay()) as { n: number } | undefined;
      return row?.n ?? 0;
    },
  };
}

function startOfDay(): number {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

function formatUsdCompact(value: number): string {
  return `$${(value / 1_000).toFixed(1)}k`;
}

export type { AuditEvent };
