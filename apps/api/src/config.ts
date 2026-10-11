import path from 'node:path';
import { z } from 'zod';

/* ============================================================================
 * Environment configuration.
 *
 * Everything has a working default, so `npm run dev` boots the full platform on
 * the deterministic simulator with no .env file at all. Kotak Neo only becomes
 * active when it is explicitly selected *and* credentialed.
 * ==========================================================================*/

/**
 * Environment values arrive as strings, and an unset variable can present as
 * `undefined` *or* as an empty string (e.g. `PORT=` in a .env file). Normalising
 * both to `undefined` is what lets `.default()` apply — with a bare
 * `z.coerce.number()` an empty value silently becomes 0 and fails validation.
 */
const asNumberInput = (value: unknown): unknown => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  const text = String(value).trim();
  if (text === '') return undefined;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const asTextInput = (value: unknown): unknown => {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text === '' ? undefined : text;
};

const envInt = (fallback: number, min: number, max: number) =>
  z.preprocess(asNumberInput, z.number().int().min(min).max(max).default(fallback));

const envNumber = (fallback: number, min: number, max = Number.MAX_SAFE_INTEGER) =>
  z.preprocess(asNumberInput, z.number().min(min).max(max).default(fallback));

/**
 * Ports parse like any other number, except that `0` is treated as unset. Some
 * host environments export `PORT=0` meaning "any free port"; honouring that
 * would bind an ephemeral port and silently break the web terminal's /api proxy,
 * so we fall back to the documented default instead.
 */
const envPort = (fallback: number) =>
  z.preprocess((value) => {
    const parsed = asNumberInput(value);
    return typeof parsed === 'number' && parsed <= 0 ? undefined : parsed;
  }, z.number().int().min(1).max(65_535).default(fallback));

const envEnum = <const T extends readonly [string, ...string[]]>(values: T, fallback: T[number]) =>
  z.preprocess(asTextInput, z.enum(values).default(fallback));

const envText = (fallback: string) => z.preprocess(asTextInput, z.string().default(fallback));

const envSecret = () => z.preprocess(asTextInput, z.string().optional());

const EnvSchema = z.object({
  NODE_ENV: envEnum(['development', 'test', 'production'] as const, 'development'),
  HOST: envText('127.0.0.1'),
  PORT: envPort(8787),
  LOG_LEVEL: envEnum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const, 'info'),

  SIM_SEED: envInt(1337, 0, 2_147_483_647),
  SIM_TICK_HZ: envNumber(4, 0.1, 50),
  DATABASE_PATH: envText('./data/kinetix.db'),

  MARKET_PROVIDER: envEnum(['simulated', 'kotakneo'] as const, 'simulated'),
  EXECUTION_VENUE: envEnum(['simulated', 'kotakneo'] as const, 'simulated'),

  KOTAK_NEO_CONSUMER_KEY: envSecret(),
  KOTAK_NEO_CONSUMER_SECRET: envSecret(),
  KOTAK_NEO_MOBILE: envSecret(),
  KOTAK_NEO_UCC: envSecret(),
  KOTAK_NEO_MPIN: envSecret(),
  KOTAK_NEO_TOTP_SECRET: envSecret(),
  KOTAK_NEO_TOTP_CODE: envSecret(),
  /**
   * Login/bootstrap host for the current Kotak Neo Trade API.
   *
   * Taken from the maintained `kotak-neo-python` SDK, whose production constants
   * are `mis.kotaksecurities.com` for session endpoints. Two hosts that appear in
   * older drafts are wrong for the current API: `gw-napi.kotaksecurities.com`
   * does not resolve, and `neoapi.kotaksecurities.com` resolves but drops every
   * TCP connection. After the MPIN step Kotak returns an account-specific
   * `baseUrl`, which the adapter then uses for all subsequent calls.
   */
  KOTAK_NEO_BASE_URL: envText('https://mis.kotaksecurities.com'),
  KOTAK_NEO_API_VERSION: envText('1.0'),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

const env = parsed.data;

/** API package root (`apps/api`), used to anchor relative paths. */
const appRoot = path.resolve(import.meta.dirname, '..');

const databasePath = path.isAbsolute(env.DATABASE_PATH)
  ? env.DATABASE_PATH
  : path.resolve(appRoot, env.DATABASE_PATH);

/**
 * Environment variables Kotak Neo needs but that are not set. Surfaced through
 * `/api/broker/status` so the terminal can tell the operator precisely what is
 * missing instead of failing with a generic error.
 */
export const kotakMissingEnv: string[] = (
  [
    ['KOTAK_NEO_CONSUMER_KEY', env.KOTAK_NEO_CONSUMER_KEY],
    ['KOTAK_NEO_MOBILE', env.KOTAK_NEO_MOBILE],
    ['KOTAK_NEO_UCC', env.KOTAK_NEO_UCC],
    ['KOTAK_NEO_MPIN', env.KOTAK_NEO_MPIN],
  ] as const
)
  .filter(([, value]) => !value || value.trim() === '')
  .map(([name]) => name);

/** Whether the TOTP half of the second factor is available. */
const hasTotp = Boolean(env.KOTAK_NEO_TOTP_SECRET?.trim() || env.KOTAK_NEO_TOTP_CODE?.trim());

export const config = {
  env: env.NODE_ENV,
  isProduction: env.NODE_ENV === 'production',
  host: env.HOST,
  port: env.PORT,
  logLevel: env.LOG_LEVEL,
  appRoot,

  db: { path: databasePath, dir: path.dirname(databasePath) },

  sim: {
    seed: env.SIM_SEED,
    tickHz: env.SIM_TICK_HZ,
    tickMs: Math.round(1000 / env.SIM_TICK_HZ),
  },

  marketProvider: env.MARKET_PROVIDER,
  executionVenue: env.EXECUTION_VENUE,

  kotak: {
    consumerKey: env.KOTAK_NEO_CONSUMER_KEY?.trim() ?? '',
    consumerSecret: env.KOTAK_NEO_CONSUMER_SECRET?.trim() ?? '',
    mobile: env.KOTAK_NEO_MOBILE?.trim() ?? '',
    ucc: env.KOTAK_NEO_UCC?.trim() ?? '',
    mpin: env.KOTAK_NEO_MPIN?.trim() ?? '',
    totpSecret: env.KOTAK_NEO_TOTP_SECRET?.trim() ?? '',
    totpCode: env.KOTAK_NEO_TOTP_CODE?.trim() ?? '',
    baseUrl: env.KOTAK_NEO_BASE_URL,
    apiVersion: env.KOTAK_NEO_API_VERSION,
  },

  /** True when the broker half of the config is complete enough to attempt login. */
  kotakCredentialsPresent: kotakMissingEnv.length === 0 && hasTotp,
  kotakMissingEnv,
} as const;

export type Config = typeof config;
