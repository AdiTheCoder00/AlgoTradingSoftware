import type { BrokerAdapter } from './types.ts';

/* ============================================================================
 * Kotak scrip master.
 *
 * Kotak publishes a dated CSV per exchange segment behind a link endpoint, and
 * every market-data and order call is addressed by `pSymbol` (the instrument
 * token) rather than by trading symbol. So this module is the bridge between
 * human symbols (`RELIANCE`) and the IDs the API actually accepts.
 *
 * The CSV is parsed by column *name* rather than position: the header carries
 * trailing spaces and a stray semicolon (`dTickSize `, `dStrikePrice;`), and the
 * column order is Kotak's to change, so indexing by name is the only stable
 * approach.
 * ==========================================================================*/

export interface ScripMasterInstrument {
  /** `pSymbol` — the instrument token every API call is addressed by. */
  token: string;
  /** `pExchSeg`, e.g. `nse_cm`. */
  exchangeSegment: string;
  /** `pTrdSymbol` — what order placement wants in its `ts` field. */
  tradingSymbol: string;
  /** `pSymbolName` — the underlying name, e.g. `NIFTY`. */
  name: string;
  /** `pGroup` — series such as `EQ`. */
  group: string;
  /** `pInstType` — `XX` for equities, `OPTIDX`/`FUTIDX` for derivatives. */
  instrumentType: string;
  isin: string;
  lotSize: number;
  tickSize: number;
}

export interface ScripMaster {
  exchangeSegment: string;
  /** Source CSV the data came from, kept for provenance in the UI. */
  sourceUrl: string;
  fetchedAt: number;
  instruments: ScripMasterInstrument[];
  /** Case-insensitive trading-symbol index. */
  byTradingSymbol: Map<string, ScripMasterInstrument>;
  /**
   * Underlying-name index. An equity's trading symbol carries a series suffix
   * (`RELIANCE-EQ`) while its name does not (`RELIANCE`), and operators type the
   * name — so both have to resolve.
   */
  byName: Map<string, ScripMasterInstrument>;
  byToken: Map<string, ScripMasterInstrument>;
}

/** Split one CSV line, honouring double-quoted fields. */
function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      // A doubled quote inside a quoted field is an escaped quote.
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (character === ',' && !quoted) {
      fields.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  fields.push(current);
  return fields;
}

/** Header names arrive with stray whitespace and trailing punctuation. */
const normaliseHeader = (name: string): string => name.trim().replace(/[;\s]+$/, '').toLowerCase();

const toNumber = (value: string | undefined): number => {
  const parsed = Number((value ?? '').trim());
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Parse a scrip-master CSV into instruments.
 *
 * Rows without a token or a trading symbol are unusable — every downstream call
 * needs both — so they are dropped rather than carried as broken entries.
 */
export function parseScripMasterCsv(csv: string, exchangeSegment: string): ScripMasterInstrument[] {
  const lines = csv.split(/\r?\n/).filter((line) => line.trim() !== '');
  const headerLine = lines.shift();
  if (!headerLine) return [];

  const columns = splitCsvLine(headerLine).map(normaliseHeader);
  const column = (name: string): number => columns.indexOf(name);

  const tokenColumn = column('psymbol');
  const symbolColumn = column('ptrdsymbol');
  if (tokenColumn === -1 || symbolColumn === -1) return [];

  const segmentColumn = column('pexchseg');
  const nameColumn = column('psymbolname');
  const groupColumn = column('pgroup');
  const typeColumn = column('pinsttype');
  const isinColumn = column('pisin');
  const lotColumn = column('llotsize');
  const tickColumn = column('dticksize');

  const instruments: ScripMasterInstrument[] = [];
  for (const line of lines) {
    const fields = splitCsvLine(line);
    const token = (fields[tokenColumn] ?? '').trim();
    const tradingSymbol = (fields[symbolColumn] ?? '').trim();
    if (!token || !tradingSymbol) continue;

    instruments.push({
      token,
      exchangeSegment: (segmentColumn >= 0 ? fields[segmentColumn]?.trim() : '') || exchangeSegment,
      tradingSymbol,
      name: (nameColumn >= 0 ? fields[nameColumn]?.trim() : '') || tradingSymbol,
      group: groupColumn >= 0 ? (fields[groupColumn] ?? '').trim() : '',
      instrumentType: typeColumn >= 0 ? (fields[typeColumn] ?? '').trim() : '',
      isin: isinColumn >= 0 ? (fields[isinColumn] ?? '').trim() : '',
      lotSize: lotSize(fields[lotColumn]),
      tickSize: toNumber(fields[tickColumn]),
    });
  }
  return instruments;
}

/** `lLotSize` is `-1` for instruments that have no lot, e.g. indices. */
function lotSize(value: string | undefined): number {
  const parsed = toNumber(value);
  return parsed > 0 ? parsed : 1;
}

/** Build the lookup indexes, preferring the `EQ` series for a given symbol. */
export function indexScripMaster(
  instruments: ScripMasterInstrument[],
  meta: { exchangeSegment: string; sourceUrl: string; fetchedAt: number },
): ScripMaster {
  const byTradingSymbol = new Map<string, ScripMasterInstrument>();
  const byName = new Map<string, ScripMasterInstrument>();
  const byToken = new Map<string, ScripMasterInstrument>();

  for (const instrument of instruments) {
    const key = instrument.tradingSymbol.toUpperCase();
    const existing = byTradingSymbol.get(key);
    // The same trading symbol can appear in several series; the equity series
    // is the one a plain `RELIANCE` lookup means.
    if (!existing || (existing.group !== 'EQ' && instrument.group === 'EQ')) {
      byTradingSymbol.set(key, instrument);
    }

    const nameKey = instrument.name.toUpperCase();
    const existingName = byName.get(nameKey);
    if (!existingName || (existingName.group !== 'EQ' && instrument.group === 'EQ')) {
      byName.set(nameKey, instrument);
    }

    byToken.set(instrument.token, instrument);
  }

  return { ...meta, instruments, byTradingSymbol, byName, byToken };
}

const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

interface CacheEntry {
  scripMaster: ScripMaster;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
/** In-flight loads, so concurrent callers share one download. */
const inFlight = new Map<string, Promise<ScripMaster>>();

/**
 * Pick the CSV for a segment out of Kotak's dated link list.
 *
 * Kotak lists the same segment under several folder variants
 * (`transformed/` and `transformed-v1/`). They currently carry an identical
 * schema, and the plain `transformed` path is the one their docs show, so it is
 * preferred when both are present.
 */
export function selectScripMasterUrl(paths: string[], exchangeSegment: string): string | null {
  const matches = paths.filter((path) => {
    const file = path.split('/').pop() ?? '';
    return file.toLowerCase().startsWith(`${exchangeSegment.toLowerCase()}-`) ||
      file.toLowerCase() === `${exchangeSegment.toLowerCase()}.csv`;
  });
  if (matches.length === 0) {
    // Fall back to a plain contains, which covers unexpected naming.
    return paths.find((path) => path.toLowerCase().includes(exchangeSegment.toLowerCase())) ?? null;
  }
  return matches.find((path) => !path.includes('transformed-v1')) ?? matches[0] ?? null;
}

export interface ScripMasterOptions {
  exchangeSegment?: string;
  /** Bypass the in-memory cache. */
  refresh?: boolean;
  fetchImpl?: typeof fetch;
}

/**
 * Download and index the Kotak scrip master for one exchange segment.
 *
 * Only the consumer key is needed for this — no trading session — which is why
 * symbol resolution is available even before a login succeeds.
 */
export async function loadScripMaster(
  adapter: BrokerAdapter,
  options: ScripMasterOptions = {},
): Promise<ScripMaster> {
  const exchangeSegment = options.exchangeSegment ?? 'nse_cm';
  const cached = cache.get(exchangeSegment);
  if (!options.refresh && cached && cached.expiresAt > Date.now()) return cached.scripMaster;

  const pending = inFlight.get(exchangeSegment);
  if (!options.refresh && pending) return pending;

  const load = (async (): Promise<ScripMaster> => {
    const files = await adapter.scripMasterFilePaths();
    const url = selectScripMasterUrl(files, exchangeSegment);
    if (!url) {
      throw new Error(`Kotak's scrip-master list contained no CSV for segment ${exchangeSegment}`);
    }

    const fetchImpl = options.fetchImpl ?? fetch;
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) {
      throw new Error(`Scrip master download failed (HTTP ${response.status}) from ${url}`);
    }

    const instruments = parseScripMasterCsv(await response.text(), exchangeSegment);
    const scripMaster = indexScripMaster(instruments, {
      exchangeSegment,
      sourceUrl: url,
      fetchedAt: Date.now(),
    });
    cache.set(exchangeSegment, { scripMaster, expiresAt: Date.now() + CACHE_TTL_MS });
    return scripMaster;
  })();

  inFlight.set(exchangeSegment, load);
  try {
    return await load;
  } finally {
    inFlight.delete(exchangeSegment);
  }
}

/** Search by trading symbol or underlying name, for the terminal's instrument picker. */
export function searchScripMaster(
  scripMaster: ScripMaster,
  query: string,
  limit = 25,
): ScripMasterInstrument[] {
  const needle = query.trim().toUpperCase();
  if (needle === '') {
    // No query means "show me something usable": the most liquid equities.
    return scripMaster.instruments.filter((item) => item.group === 'EQ').slice(0, limit);
  }

  // `RELIANCE` is an equity's *name*, `RELIANCE-EQ` its trading symbol, so both
  // indexes are consulted for an exact match.
  const exact = scripMaster.byTradingSymbol.get(needle) ?? scripMaster.byName.get(needle);
  const matches = scripMaster.instruments.filter(
    (item) => item.tradingSymbol.toUpperCase().includes(needle) || item.name.toUpperCase().includes(needle),
  );
  // An exact hit first, then equities before derivatives, then alphabetical.
  matches.sort((a, b) => {
    if (a.tradingSymbol.toUpperCase() === needle) return -1;
    if (b.tradingSymbol.toUpperCase() === needle) return 1;
    if (a.group === 'EQ' && b.group !== 'EQ') return -1;
    if (b.group === 'EQ' && a.group !== 'EQ') return 1;
    return a.tradingSymbol.localeCompare(b.tradingSymbol);
  });

  const results = exact ? [exact, ...matches.filter((item) => item !== exact)] : matches;
  return results.slice(0, limit);
}
