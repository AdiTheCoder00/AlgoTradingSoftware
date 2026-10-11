import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, kvSet, resetDatabase } from '../src/db/db.ts';
import { createDbBarStore } from '../src/market/barStore.ts';

/* ============================================================================
 * Live bar store.
 *
 * The snapshot has to survive a real SQLite round trip, and a corrupt row must
 * be treated as absent rather than handed to a chart as if it were data.
 * ==========================================================================*/

beforeEach(() => {
  resetDatabase();
});

afterAll(() => {
  closeDatabase();
});

describe('live bar store', () => {
  it('round-trips a snapshot through SQLite', () => {
    const store = createDbBarStore();
    expect(store.load('NSE:RELIANCE')).toBeNull();

    store.save('NSE:RELIANCE', {
      bars: [
        { t: 60_000, o: 100, h: 102, l: 99.5, c: 101, v: 500 },
        { t: 120_000, o: 101, h: 103, l: 100.5, c: 102, v: 300 },
      ],
      volume: 12_345,
    });

    const restored = store.load('NSE:RELIANCE');
    expect(restored?.bars).toHaveLength(2);
    expect(restored?.bars[1]).toMatchObject({ t: 120_000, c: 102, v: 300 });
    expect(restored?.volume).toBe(12_345);
  });

  it('ignores a corrupt or malformed payload instead of feeding it to a chart', () => {
    const store = createDbBarStore();

    kvSet('live:bars:NSE:TCS', '{"bars":[{"t":"oops"}],"volume":5}');
    expect(store.load('NSE:TCS')).toBeNull();

    kvSet('live:bars:NSE:TCS', 'not json at all');
    expect(store.load('NSE:TCS')).toBeNull();

    kvSet('live:bars:NSE:TCS', '{"volume":5}');
    expect(store.load('NSE:TCS')).toBeNull();
  });
});
