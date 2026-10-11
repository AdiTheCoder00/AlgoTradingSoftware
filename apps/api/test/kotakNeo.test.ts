import { afterEach, describe, expect, it, vi } from 'vitest';

/* ============================================================================
 * Kotak Neo adapter.
 *
 * Nothing here touches the network: the scrip-master fixtures are real rows
 * copied from the live `nse_cm-v1.csv`, and the adapter's login handshake is
 * driven through a stubbed `fetch` that answers the way Kotak's API does
 * (including a 2xx response carrying an error body, which their API does).
 *
 * The environment is set in `vi.hoisted` because the adapter's configuration is
 * read once, at import time, so the values must exist before the module graph
 * loads.
 * ==========================================================================*/

vi.hoisted(() => {
  process.env.KOTAK_NEO_CONSUMER_KEY = 'test_consumer_key';
  process.env.KOTAK_NEO_MOBILE = '9000000000';
  process.env.KOTAK_NEO_UCC = 'TESTUCC';
  process.env.KOTAK_NEO_MPIN = '123456';
  process.env.KOTAK_NEO_TOTP_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  process.env.KOTAK_NEO_BASE_URL = 'https://mis.kotaksecurities.test';
});

import { createKotakNeoAdapter, redactBrokerText } from '../src/brokers/kotakNeo.ts';
import {
  indexScripMaster,
  parseScripMasterCsv,
  searchScripMaster,
  selectScripMasterUrl,
} from '../src/brokers/scripMaster.ts';
import { generateTotp } from '../src/brokers/totp.ts';

/** Header copied from the live file, quirks included (trailing space, `;`). */
const HEADER =
  'pSymbol,pGroup,pExchSeg,pInstType,pSymbolName,pTrdSymbol,pOptionType,pScripRefKey,pISIN,pAssetCode,pSubGroup,pCombinedSymbol,pDesc,pAmcCode,pContractId,dTickSize ,lLotSize,lExpiryDate ,lMultiplier ,lPrecision,dStrikePrice;';

/** Real rows from `nse_cm-v1.csv` (2026-10-11), trimmed to the header's length. */
const ROWS = [
  '2885,EQ,nse_cm,,RELIANCE,RELIANCE-EQ,,RELIANCE,INE002A01018,,,,"RELIANCE INDUSTRIES LTD",,,10,1,-1,-1,2,-1',
  '11536,EQ,nse_cm,,TCS,TCS-EQ,,TCS,INE467B01029,,,,"TATA CONSULTANCY SERV LT",,,10,1,-1,-1,2,-1',
  '26000,,nse_cm,,NIFTY,NIFTY,,NIFTY,,,,,NIFTY,,,-1,1,-1,-1,2,-1',
  '2885,EQ,nse_cm,,RELIANCE,RELIANCE-BE,,RELIANCE,INE002A01018,,,,"RELIANCE INDUSTRIES LTD",,,10,1,-1,-1,2,-1',
  ',,,,,,,,,,,,,,,,,,,,',
];

const CSV = [HEADER, ...ROWS].join('\n');

const buildScripMaster = () =>
  indexScripMaster(parseScripMasterCsv(CSV, 'nse_cm'), {
    exchangeSegment: 'nse_cm',
    sourceUrl: 'https://example.test/nse_cm-v1.csv',
    fetchedAt: 0,
  });

describe('scrip master parsing', () => {
  it('reads instrument tokens and trading symbols from the real column names', () => {
    const instruments = parseScripMasterCsv(CSV, 'nse_cm');
    const reliance = instruments.find((item) => item.tradingSymbol === 'RELIANCE-EQ');

    expect(reliance).toBeDefined();
    expect(reliance?.token).toBe('2885');
    expect(reliance?.exchangeSegment).toBe('nse_cm');
    expect(reliance?.name).toBe('RELIANCE');
    expect(reliance?.group).toBe('EQ');
    expect(reliance?.isin).toBe('INE002A01018');
  });

  it('keeps index rows, whose lot size is -1 in Kotak\'s file', () => {
    const nifty = parseScripMasterCsv(CSV, 'nse_cm').find((item) => item.tradingSymbol === 'NIFTY');
    expect(nifty?.token).toBe('26000');
    expect(nifty?.lotSize).toBe(1);
  });

  it('drops rows with no token or no symbol and tolerates quoted fields', () => {
    const instruments = parseScripMasterCsv(CSV, 'nse_cm');
    expect(instruments).toHaveLength(4);
    // The quoted description must survive the comma inside the quotes.
    expect(instruments.find((item) => item.tradingSymbol === 'TCS-EQ')?.name).toBe('TCS');
  });

  it('prefers the equity series when one symbol appears in several', () => {
    const scripMaster = buildScripMaster();
    // The file lists RELIANCE-BE after RELIANCE-EQ; the EQ series must win.
    expect(scripMaster.byTradingSymbol.get('RELIANCE-EQ')?.group).toBe('EQ');
    expect(scripMaster.byName.get('RELIANCE')?.tradingSymbol).toBe('RELIANCE-EQ');
  });

  it('resolves the symbol an operator types, which is the name, not the trading symbol', () => {
    const scripMaster = buildScripMaster();
    const [first] = searchScripMaster(scripMaster, 'RELIANCE', 5);
    expect(first?.tradingSymbol).toBe('RELIANCE-EQ');
    expect(first?.token).toBe('2885');
  });

  it('returns instruments rather than an empty list when the segment file is unnamed', () => {
    const scripMaster = buildScripMaster();
    expect(searchScripMaster(scripMaster, '', 2)).toHaveLength(2);
  });
});

describe('scrip master URL selection', () => {
  it('picks the segment CSV and prefers the plain transformed folder', () => {
    const paths = [
      'https://lapi.test/prod/2026-10-11/transformed-v1/nse_cm-v1.csv',
      'https://lapi.test/prod/2026-10-11/transformed/nse_cm-v1.csv',
      'https://lapi.test/prod/2026-10-11/transformed/bse_fo.csv',
    ];
    expect(selectScripMasterUrl(paths, 'nse_cm')).toBe(
      'https://lapi.test/prod/2026-10-11/transformed/nse_cm-v1.csv',
    );
  });

  it('does not confuse nse_cm with nse_com or nse_fo', () => {
    const paths = [
      'https://lapi.test/prod/2026-10-11/transformed/nse_com.csv',
      'https://lapi.test/prod/2026-10-11/transformed/nse_fo.csv',
      'https://lapi.test/prod/2026-10-11/transformed/nse_cm-v1.csv',
    ];
    expect(selectScripMasterUrl(paths, 'nse_cm')).toContain('nse_cm-v1.csv');
  });

  it('reports a miss instead of guessing', () => {
    expect(selectScripMasterUrl(['https://lapi.test/prod/2026-10-11/transformed/bse_fo.csv'], 'nse_cm')).toBeNull();
  });
});

describe('TOTP', () => {
  it('matches the RFC 6238 test vector', () => {
    // RFC 6238 seed "12345678901234567890" is base32
    // GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ; at t=59s (counter 1) the 6-digit code is
    // 287082.
    expect(generateTotp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59_000)).toBe('287082');
  });

  it('advances to the next code at the 30-second boundary', () => {
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    expect(generateTotp(secret, 30_000)).not.toBe(generateTotp(secret, 60_000));
  });
});

describe('credential redaction', () => {
  it('removes tokens, sid values and JWTs from broker text', () => {
    const raw =
      'Response: {"data":{"token":"view_abc123","sid":"9f2b1c","baseUrl":"https://e21.test"}} Authorization: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const safe = redactBrokerText(raw);

    expect(safe).not.toContain('view_abc123');
    expect(safe).not.toContain('9f2b1c');
    expect(safe).not.toContain('dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk');
    // Non-secret context is preserved so the message stays useful.
    expect(safe).toContain('https://e21.test');
  });
});

/* ------------------------------- login flow ------------------------------- */

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Stub fetch with Kotak's real envelope shapes, recording what was sent. */
function stubKotak(): Recorded[] {
  const calls: Recorded[] = [];

  vi.stubGlobal('fetch', async (url: string | URL, init: RequestInit = {}) => {
    const target = String(url);
    const headers = Object.fromEntries(
      Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
    );
    const rawBody = typeof init.body === 'string' ? init.body : '';
    // Form-encoded calls carry the payload inside `jData`, per Kotak's SDK.
    const body = rawBody.startsWith('jData=')
      ? JSON.parse(new URLSearchParams(rawBody).get('jData') ?? '{}')
      : rawBody
        ? JSON.parse(rawBody)
        : undefined;
    calls.push({ url: target, method: init.method ?? 'GET', headers, body });

    if (target.includes('tradeApiLogin')) {
      return new Response(JSON.stringify({ data: { token: 'view_token_1', sid: 'login_sid_1', ucc: 'TESTUCC' } }), {
        status: 200,
      });
    }
    if (target.includes('tradeApiValidate')) {
      return new Response(
        JSON.stringify({
          data: {
            token: 'session_token_1',
            sid: 'edit_sid_1',
            baseUrl: 'https://e21.kotaksecurities.test',
            dataCenter: 'E21',
          },
        }),
        { status: 200 },
      );
    }
    if (target.includes('/quotes/neosymbol/')) {
      // Real `quoteType=all` payload for RELIANCE: `ohlc.close` equals `ltp`,
      // while `change`/`per_change` hold the move against the previous close.
      return new Response(
        JSON.stringify([
          {
            exchange_token: '2885',
            display_symbol: 'RELIANCE-EQ',
            exchange: 'nse_cm',
            ltp: '1170.3',
            last_traded_quantity: '500',
            last_volume: '0',
            change: '-7.7',
            per_change: '-0.6537',
            ohlc: { open: '1179', high: '1179', low: '1160.2', close: '1170.3' },
          },
        ]),
        { status: 200 },
      );
    }
    if (target.includes('/portfolio/v2/positions')) {
      return new Response(
        JSON.stringify({ data: [{ trdSym: 'RELIANCE-EQ', netQty: '10', avgPrc: '2500', ltp: '2550', prod: 'MIS' }] }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ error: [{ code: '400', message: 'unexpected call' }] }), { status: 200 });
  });

  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Kotak login handshake', () => {
  it('posts JSON with mobileNumber/ucc/totp and the required headers', async () => {
    const calls = stubKotak();
    const adapter = createKotakNeoAdapter();
    await adapter.login({});

    const login = calls[0];
    expect(login?.url).toBe('https://mis.kotaksecurities.test/login/1.0/tradeApiLogin');
    expect(login?.headers.authorization).toBe('test_consumer_key');
    expect(login?.headers['neo-fin-key']).toBe('neotradeapi');
    expect(login?.headers['content-type']).toBe('application/json');
    expect(login?.body).toMatchObject({ mobileNumber: '9000000000', ucc: 'TESTUCC' });
    // The TOTP is generated from the secret, so it must be a 6-digit code.
    expect(String((login?.body as { totp: string }).totp)).toMatch(/^\d{6}$/);
  });

  it('validates the MPIN with the login sid and view token as headers', async () => {
    const calls = stubKotak();
    const adapter = createKotakNeoAdapter();
    await adapter.login({});

    const validate = calls[1];
    expect(validate?.url).toBe('https://mis.kotaksecurities.test/login/1.0/tradeApiValidate');
    expect(validate?.headers.sid).toBe('login_sid_1');
    expect(validate?.headers.auth).toBe('view_token_1');
    expect(validate?.body).toEqual({ mpin: '123456' });
  });

  it('routes later calls to the account baseUrl Kotak returns, with Sid/Auth', async () => {
    const calls = stubKotak();
    const adapter = createKotakNeoAdapter();
    const status = await adapter.login({});
    expect(status.connected).toBe(true);

    const positions = await adapter.positions();
    const call = calls.at(-1);

    // This is the detail that breaks every naive integration: `mis` is the
    // session host only, and positions must go to the returned account host.
    expect(call?.url).toBe('https://e21.kotaksecurities.test/portfolio/v2/positions');
    expect(call?.headers.sid).toBe('edit_sid_1');
    expect(call?.headers.auth).toBe('session_token_1');
    expect(positions[0]).toMatchObject({ tradingSymbol: 'RELIANCE-EQ', quantity: 10, averagePrice: 2500, pnl: 500 });
  });

  it('treats a 2xx response carrying an error body as a failure', async () => {
    stubKotak();
    const adapter = createKotakNeoAdapter();
    await adapter.login({});

    // The stub answers `{error: [...]}` with HTTP 200 for anything unexpected;
    // Kotak does the same, so it must not be read as success.
    await expect(adapter.limits()).rejects.toThrow(/unexpected call/);
  });

  it('derives the previous close from `change`, not from ohlc.close', async () => {
    stubKotak();
    const adapter = createKotakNeoAdapter();
    await adapter.login({});

    const [quote] = await adapter.quotes([
      { symbol: 'RELIANCE', tradingSymbol: 'RELIANCE-EQ', exchangeSegment: 'nse_cm', instrumentToken: '2885' },
    ]);

    expect(quote?.lastPrice).toBe(1170.3);
    // 1170.3 - (-7.7) = 1178, and the reported change is -0.6537%.
    expect(quote?.previousClose).toBeCloseTo(1178, 6);
    expect(quote?.changePct).toBeCloseTo(-0.6537, 4);
  });

  it('refuses to quote an instrument with no resolved token', async () => {
    stubKotak();
    const adapter = createKotakNeoAdapter();
    await adapter.login({});

    await expect(
      adapter.quotes([{ symbol: 'RELIANCE', tradingSymbol: 'RELIANCE-EQ', exchangeSegment: 'nse_cm' }]),
    ).rejects.toThrow(/scrip master/i);
  });

  it('reports the session as disconnected before a login', () => {
    const adapter = createKotakNeoAdapter();
    expect(adapter.status().connected).toBe(false);
    expect(adapter.status().mode).toBe('simulated');
  });
});
