import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, resetDatabase } from '../src/db/db.ts';
import { createEngine, isRejected, type Engine } from '../src/engine/world.ts';
import { seedBot, seedPortfolioRow, seedStrategy, TEST_BALANCE_USD } from './fixtures.ts';

/* ============================================================================
 * Guardrail enforcement.
 *
 * Every order in the platform funnels through `engine.placeOrder`, so these
 * assertions run against the real order path rather than against a helper.
 *
 * The demo fleet was removed from the seed, so the lifecycle cases provision
 * their own bots (three running sim bots and one standby Kotak bot) before the
 * engine boots — the fleet service reads its table once at construction.
 * ==========================================================================*/

const STRATEGY_ID = 'fixture-guardrail-strategy';
const RUNNING_BOTS = ['fixture-bot-a', 'fixture-bot-b', 'fixture-bot-c'] as const;
const KOTAK_BOT_ID = 'fixture-kotak-bot';

let engine: Engine;

beforeEach(() => {
  resetDatabase();
  seedPortfolioRow({ balanceUsd: TEST_BALANCE_USD });
  seedStrategy({ id: STRATEGY_ID, instrument: 'BTC-USD', timeframe: '1m' });
  for (const botId of RUNNING_BOTS) {
    seedBot({ id: botId, strategyId: STRATEGY_ID, state: 'running', allocatedMarginUsd: 150_000, leverage: 3 });
  }
  seedBot({ id: KOTAK_BOT_ID, strategyId: STRATEGY_ID, venue: 'kotakneo', state: 'standby', allocatedMarginUsd: 100_000 });
  engine = createEngine();
});

afterAll(() => {
  closeDatabase();
});

const context = { actor: 'tester', strategyId: 'manual', venue: 'sim' } as const;

describe('fat-finger cap', () => {
  it('rejects a ticket above the cap before it reaches a venue', () => {
    const outcome = engine.placeOrder({ symbol: 'BTC-USD', side: 'buy', type: 'market', notionalUsd: 300_000 }, context);
    expect(isRejected(outcome)).toBe(true);
    if (!isRejected(outcome)) return;

    expect(outcome.code).toBe('fat_finger_cap');
    expect(outcome.guardrailId).toBe('fat-finger-cap');
    expect(outcome.notionalUsd).toBe(300_000);
    expect(outcome.reason).toContain('$300.0k');
  });

  it('books nothing when it rejects', () => {
    const before = engine.portfolio.positions().length;
    const orders = engine.portfolio.orders(200).length;
    engine.placeOrder({ symbol: 'BTC-USD', side: 'buy', type: 'market', notionalUsd: 500_000 }, context);
    expect(engine.portfolio.positions()).toHaveLength(before);
    expect(engine.portfolio.orders(200)).toHaveLength(orders);
  });

  it('records the rejection on the guardrail, in the risk feed and in the audit trail', () => {
    engine.placeOrder({ symbol: 'BTC-USD', side: 'buy', type: 'market', notionalUsd: 300_000 }, context);

    expect(engine.risk.rejectionsToday()).toBe(1);
    const guardrail = engine.risk.guardrails().find((candidate) => candidate.id === 'fat-finger-cap');
    expect(guardrail?.metricValue).toBe('1 Rejections today');
    expect(engine.risk.events(5).some((event) => event.kind === 'order_rejected')).toBe(true);
  });

  it('allows a ticket within the cap', () => {
    const outcome = engine.placeOrder({ symbol: 'BTC-USD', side: 'buy', type: 'market', notionalUsd: 200_000 }, context);
    expect(isRejected(outcome)).toBe(false);
    if (isRejected(outcome)) return;
    expect(outcome.status).toBe('filled');
  });

  it('follows a threshold edit and can be switched off entirely', () => {
    engine.risk.updateGuardrail('fat-finger-cap', { threshold: 400_000 }, 'tester');
    expect(isRejected(engine.placeOrder({ symbol: 'BTC-USD', side: 'buy', type: 'market', notionalUsd: 300_000 }, context))).toBe(
      false,
    );

    engine.risk.updateGuardrail('fat-finger-cap', { enabled: false }, 'tester');
    expect(engine.risk.checkOrder({ notionalUsd: 999_000_000, symbol: 'BTC-USD', side: 'buy' }).allowed).toBe(true);
  });
});

describe('portfolio drawdown rule', () => {
  it('pauses the fleet once the threshold is breached and blocks new risk', () => {
    engine.risk.updateGuardrail('portfolio-drawdown', { threshold: 0 }, 'tester');
    engine.risk.monitor();

    expect(engine.risk.isPausedByRisk()).toBe(true);
    expect(engine.fleet.isPaused()).toBe(true);
    expect(engine.risk.events(10).some((event) => event.kind === 'drawdown_pause')).toBe(true);

    const outcome = engine.placeOrder({ symbol: 'BTC-USD', side: 'buy', type: 'market', notionalUsd: 10_000 }, context);
    expect(isRejected(outcome)).toBe(true);
    if (!isRejected(outcome)) return;
    expect(outcome.code).toBe('risk_paused');
  });

  it('stops every running algorithm while paused', () => {
    expect(engine.fleet.bots().filter((bot) => bot.state === 'running')).toHaveLength(RUNNING_BOTS.length);
    engine.risk.updateGuardrail('portfolio-drawdown', { threshold: 0 }, 'tester');
    engine.risk.monitor();
    expect(engine.fleet.bots().filter((bot) => bot.state === 'running')).toHaveLength(0);
  });

  it('re-arms only after drawdown recovers well clear of the limit', () => {
    engine.risk.updateGuardrail('portfolio-drawdown', { threshold: 0 }, 'tester');
    engine.risk.monitor();
    expect(engine.risk.isPausedByRisk()).toBe(true);

    // Hysteresis: a value sitting on the threshold must not flap the fleet on
    // and off, so recovery is only accepted below 80% of the limit.
    engine.risk.updateGuardrail('portfolio-drawdown', { threshold: 100 }, 'tester');
    engine.risk.monitor();
    expect(engine.risk.isPausedByRisk()).toBe(false);
  });
});

describe('slippage limiter', () => {
  it('pulls resting limit orders when measured slippage breaches the limit', () => {
    const book = engine.market.book('BTC-USD', 1);
    const bid = book.bids[0];
    expect(bid).toBeDefined();
    if (!bid) return;

    const resting = engine.portfolio.placeOrder(
      { symbol: 'BTC-USD', side: 'buy', type: 'limit', quantity: 0.2, price: Number((bid.price * 0.8).toFixed(2)) },
      { actor: 'tester', strategyId: 'manual', venue: 'sim' },
    );
    if (isRejected(resting)) throw new Error(resting.reason);
    expect(engine.portfolio.openOrders()).toHaveLength(1);

    // Any real fill pays the touch plus a spread-crossing cost, so a limit set
    // just above zero is breached by an ordinary trade.
    engine.placeOrder({ symbol: 'BTC-USD', side: 'buy', type: 'market', notionalUsd: 200_000 }, context);
    engine.risk.updateGuardrail('slippage-limiter', { threshold: 0.001 }, 'tester');
    expect(engine.portfolio.averageSlippageBps()).toBeGreaterThan(0.1);

    engine.risk.monitor();

    const pulled = engine.portfolio.orders(50).find((order) => order.id === resting.id);
    expect(pulled?.status).toBe('cancelled');
    expect(engine.portfolio.openOrders()).toHaveLength(0);
    expect(engine.risk.events(10).some((event) => event.kind === 'slippage_cancel')).toBe(true);

    const guardrail = engine.risk.guardrails().find((candidate) => candidate.id === 'slippage-limiter');
    expect(guardrail?.metricValue).toMatch(/^Avg slip: \d+\.\d{3}%$/);
  });
});

describe('fleet lifecycle', () => {
  it('starts with the fleet the fixture provisioned', () => {
    const snapshot = engine.fleet.snapshot();
    expect(snapshot.botsTotal).toBe(RUNNING_BOTS.length + 1);
    expect(snapshot.botsRunning).toBe(RUNNING_BOTS.length);
    expect(snapshot.marginCapPct).toBe(70);
    // No positions are open on a fresh fixture book, so the gauge reads zero
    // rather than an inherited demo figure.
    expect(snapshot.marginUsedPct).toBeCloseTo(0, 5);
    expect(engine.fleet.deployedAlgos()).toBe(RUNNING_BOTS.length);
  });

  it('refuses to start a Kotak Neo bot without a broker session', () => {
    const result = engine.fleet.setBotState(KOTAK_BOT_ID, 'running', 'tester');
    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    expect(result.error).toMatch(/Kotak Neo session is not connected/);
    expect(engine.fleet.bot(KOTAK_BOT_ID)?.state).toBe('standby');
  });

  it('pauses and resumes an algorithm', () => {
    const target = RUNNING_BOTS[0];
    expect(engine.fleet.setBotState(target, 'paused', 'tester')).toHaveProperty('bot');
    expect(engine.fleet.bot(target)?.state).toBe('paused');
    expect(engine.fleet.deployedAlgos()).toBe(RUNNING_BOTS.length - 1);

    engine.fleet.setBotState(target, 'running', 'tester');
    expect(engine.fleet.deployedAlgos()).toBe(RUNNING_BOTS.length);
  });

  it('freezes every loop on the kill-switch and re-arms on request', () => {
    engine.fleet.freezeFleet('tester');
    expect(engine.fleet.isFrozen()).toBe(true);
    expect(engine.fleet.bots().filter((bot) => bot.state === 'running')).toHaveLength(0);
    expect(engine.risk.events(5).some((event) => event.kind === 'fleet_freeze')).toBe(true);

    // A frozen fleet must refuse to restart anything.
    const blocked = engine.fleet.setBotState(RUNNING_BOTS[0], 'running', 'tester');
    expect('error' in blocked).toBe(true);

    engine.fleet.rearm('tester');
    expect(engine.fleet.isFrozen()).toBe(false);
    expect(engine.fleet.isPaused()).toBe(false);
    expect(engine.fleet.setBotState(RUNNING_BOTS[0], 'running', 'tester')).toHaveProperty('bot');
  });

  it('cancels working orders when the fleet is frozen', () => {
    const book = engine.market.book('BTC-USD', 1);
    const bid = book.bids[0];
    if (!bid) return;
    engine.portfolio.placeOrder(
      { symbol: 'BTC-USD', side: 'buy', type: 'limit', quantity: 0.1, price: Number((bid.price * 0.8).toFixed(2)) },
      { actor: 'tester', strategyId: 'manual', venue: 'sim' },
    );
    expect(engine.portfolio.openOrders()).toHaveLength(1);

    engine.fleet.freezeFleet('tester');
    expect(engine.portfolio.openOrders()).toHaveLength(0);
  });
});
