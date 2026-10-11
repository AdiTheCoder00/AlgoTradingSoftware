import { describe, expect, it } from 'vitest';

import { mapOrderState, mapOrderStatus } from '../src/brokers/kotakNeo.ts';

/* ============================================================================
 * Kotak order-book mapping.
 *
 * This is what reconciliation trusts, so it is tested against the venue's own
 * vocabulary — including the parts of it this adapter does not know, which must
 * produce "no opinion" rather than a guess.
 * ==========================================================================*/

describe('Kotak order status mapping', () => {
  it('maps the vocabulary to the four states the terminal understands', () => {
    expect(mapOrderStatus('complete')).toBe('filled');
    expect(mapOrderStatus('COMPLETE')).toBe('filled');
    expect(mapOrderStatus('fully executed')).toBe('filled');
    expect(mapOrderStatus('rejected')).toBe('rejected');
    expect(mapOrderStatus('order rejected by RMS')).toBe('rejected');
    expect(mapOrderStatus('cancelled')).toBe('cancelled');
    expect(mapOrderStatus('cancel pending')).toBe('cancelled');
    expect(mapOrderStatus('open')).toBe('working');
    expect(mapOrderStatus('open pending')).toBe('working');
    expect(mapOrderStatus('trigger pending')).toBe('working');
    expect(mapOrderStatus('put order req received')).toBe('working');
    expect(mapOrderStatus('partially executed')).toBe('partially_filled');
  });

  it('has no opinion about a status it does not recognise', () => {
    // Reconciling on an unknown string would move a real order to an invented
    // state, so the mapper says nothing instead.
    expect(mapOrderStatus('something new')).toBeNull();
    expect(mapOrderStatus('')).toBeNull();
  });
});

describe('Kotak order row normalisation', () => {
  it('normalises a filled row from Kotak field names', () => {
    const [order] = mapOrderState([
      {
        nOrdNo: '250427000123456',
        ordSt: 'complete',
        qty: '10',
        fqty: '10',
        avgPrc: '1170.30',
        trdSym: 'RELIANCE-EQ',
        trnsTp: 'B',
        prd: 'MIS',
        ordTm: '1791677880',
      },
    ]);

    expect(order?.orderId).toBe('250427000123456');
    expect(order?.status).toBe('filled');
    expect(order?.quantity).toBe(10);
    expect(order?.filledQuantity).toBe(10);
    expect(order?.averagePrice).toBeCloseTo(1170.3, 6);
    expect(order?.symbol).toBe('RELIANCE-EQ');
    expect(order?.side).toBe('buy');
    expect(order?.product).toBe('MIS');
    // Epoch seconds are widened to milliseconds.
    expect(order?.ts).toBe(1_791_677_880_000);
  });

  it('reads a sell that has not filled, and its rejection reason', () => {
    const [order] = mapOrderState([
      { nOrdNo: 'X9', ordSt: 'rejected', qty: '5', fqty: '0', avgPrc: '0', trnsTp: 'S', rejRsn: 'RMS: insufficient margin' },
    ]);
    expect(order?.side).toBe('sell');
    // A zero average on an unfilled order is "no fill price", not a price.
    expect(order?.averagePrice).toBeNull();
    expect(order?.rejectReason).toContain('insufficient margin');
  });

  it('refuses to materialise an order out of an empty envelope', () => {
    // An empty order book arrives as `{ stCode, errMsg, desc, stat }`, which must
    // not be mistaken for a single order that simply has no id.
    expect(mapOrderState([{ stCode: '200', errMsg: 'Success', desc: '', stat: 'Ok' }])).toEqual([]);
    expect(mapOrderState([])).toEqual([]);
  });
});
