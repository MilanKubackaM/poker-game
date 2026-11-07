import { createHash, randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/** Predvolené parametre scrypt (≈ 16 MB pamäte, desiatky ms na jedno overenie). */
export const SCRYPT_DEFAULTS = { N: 16384, r: 8, p: 1 } as const;
const SALT_BYTES = 16;
const KEY_BYTES = 64;
const MAX_MEMORY = 128 * 1024 * 1024;

function scryptAsync(password: string, salt: Buffer, keyLength: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, options, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

/** Hash hesla v tvare `scrypt$N$r$p$soľB64$hashB64` (parametre sú v reťazci, dajú sa neskôr zvýšiť). */
export async function hashPassword(password: string, N: number = SCRYPT_DEFAULTS.N): Promise<string> {
  const { r, p } = SCRYPT_DEFAULTS;
  const salt = randomBytes(SALT_BYTES);
  const key = await scryptAsync(password, salt, KEY_BYTES, { N, r, p, maxmem: MAX_MEMORY });
  return ['scrypt', N, r, p, salt.toString('base64'), key.toString('base64')].join('$');
}

/** Overí heslo voči uloženému hashu v konštantnom čase; poškodený hash = nesprávne heslo. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    return false;
  }
  const [N, r, p] = parts.slice(1, 4).map(Number);
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  if (![N, r, p].every((value) => Number.isInteger(value) && value > 0) || !salt.length || !expected.length) {
    return false;
  }
  const key = await scryptAsync(password, salt, expected.length, { N, r, p, maxmem: MAX_MEMORY });
  return timingSafeEqual(key, expected);
}

/** Náhodný token prihlásenia / odkazu z e-mailu (32 bajtov hex); ukladá sa len jeho SHA-256. */
export function randomToken(): string {
  return randomBytes(32).toString('hex');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

export function isTokenShape(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_PATTERN.test(value);
}
