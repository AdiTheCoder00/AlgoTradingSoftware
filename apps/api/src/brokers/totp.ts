import { createHmac } from 'node:crypto';

/* ============================================================================
 * RFC 6238 TOTP, implemented against node:crypto so the Kotak Neo second factor
 * needs no dependency. Kotak accepts the standard 6-digit / 30-second code that
 * Google Authenticator produces for their enrolment QR.
 * ==========================================================================*/

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Decode an RFC 4648 base32 secret (padding and whitespace tolerated). */
export function base32Decode(input: string): Buffer {
  const cleaned = input.replace(/[\s=-]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (const character of cleaned) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index === -1) throw new Error(`Invalid base32 character: ${character}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export interface TotpOptions {
  digits?: number;
  periodSeconds?: number;
  algorithm?: 'sha1' | 'sha256' | 'sha512';
}

/** Generate the code valid for `at` (defaults to now). */
export function generateTotp(secretBase32: string, at: number = Date.now(), options: TotpOptions = {}): string {
  const { digits = 6, periodSeconds = 30, algorithm = 'sha1' } = options;
  if (!secretBase32.trim()) throw new Error('TOTP secret is empty');

  const counter = Math.floor(at / 1000 / periodSeconds);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac(algorithm, base32Decode(secretBase32)).update(counterBuffer).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary =
    ((digest[offset] ?? 0) & 0x7f) * 2 ** 24 +
    ((digest[offset + 1] ?? 0) & 0xff) * 2 ** 16 +
    ((digest[offset + 2] ?? 0) & 0xff) * 2 ** 8 +
    ((digest[offset + 3] ?? 0) & 0xff);

  return (binary % 10 ** digits).toString().padStart(digits, '0');
}

/** Seconds until the current code expires — surfaced so the UI can prompt re-login. */
export function totpSecondsRemaining(at: number = Date.now(), periodSeconds = 30): number {
  const elapsed = Math.floor(at / 1000) % periodSeconds;
  return periodSeconds - elapsed;
}
