import { createHash, createHmac, randomBytes } from 'node:crypto';
import { FAIR_HEX, FAIR_VERSION } from '../../shared/fairness';
import type { Card } from '../../shared/types';
import { freshDeck, shuffle } from './cards';

const TWO_POW_32 = 0x1_0000_0000;
const SEPARATOR = Buffer.from([0]);

export function newSeed(): string {
  return randomBytes(32).toString('hex');
}

export function isFairHex(value: unknown): value is string {
  return typeof value === 'string' && FAIR_HEX.test(value);
}

/** Odtlačok semienka: SHA-256 jeho 32 bajtov (nie hex textu). */
export function commitOf(seedHex: string): string {
  return createHash('sha256').update(Buffer.from(seedHex, 'hex')).digest('hex');
}

export interface DeckInput {
  table: string;
  roundId: string;
  serverSeed: string;
  /** playerId → semienko; zoradia sa podľa playerId. */
  seeds: Record<string, string>;
}

/**
 * Kľúč miešania: SHA-256( "poker-night/shuffle/v1" ‖ 0x00 ‖ table ‖ 0x00 ‖ roundId ‖ 0x00 ‖ serverSeed(32 B)
 *   ‖ pre každého hráča zoradene podľa playerId: playerId ‖ 0x00 ‖ seed(32 B) ).
 */
export function shuffleKey(input: DeckInput): Buffer {
  const hash = createHash('sha256');
  hash.update(FAIR_VERSION, 'utf8').update(SEPARATOR);
  hash.update(input.table, 'utf8').update(SEPARATOR);
  hash.update(input.roundId, 'utf8').update(SEPARATOR);
  hash.update(Buffer.from(input.serverSeed, 'hex'));
  for (const playerId of Object.keys(input.seeds).sort(compareIds)) {
    hash.update(playerId, 'utf8').update(SEPARATOR);
    hash.update(Buffer.from(input.seeds[playerId], 'hex'));
  }
  return hash.digest();
}

/** Poradie podľa UTF-16 kódových jednotiek (štandardné `sort()` v JS) — ID hráčov sú ASCII UUID. */
function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Deterministický zdroj náhody: blok i = HMAC-SHA256(kľúč, i ako uint32 big-endian), z každého bloku 8 slov uint32
 * big-endian v poradí. `below(n)` zahodí slová ≥ 2^32 − (2^32 mod n), aby výsledok `slovo mod n` nebol skreslený.
 */
export function seededRandom(key: Buffer): (max: number) => number {
  let counter = 0;
  let block = Buffer.alloc(0);
  let offset = 0;
  const nextWord = (): number => {
    if (offset >= block.length) {
      const index = Buffer.alloc(4);
      index.writeUInt32BE(counter++);
      block = createHmac('sha256', key).update(index).digest();
      offset = 0;
    }
    const word = block.readUInt32BE(offset);
    offset += 4;
    return word;
  };
  return (max: number): number => {
    if (!Number.isInteger(max) || max < 1 || max > TWO_POW_32) {
      throw new Error('Invalid range');
    }
    const limit = TWO_POW_32 - (TWO_POW_32 % max);
    for (;;) {
      const word = nextWord();
      if (word < limit) {
        return word % max;
      }
    }
  };
}

/** Balíček ruky: Fisher–Yates (`shuffle`) nad kanonickým poradím `freshDeck()` s náhodou zo semienok. */
export function deriveDeck(input: DeckInput): Card[] {
  return shuffle(freshDeck(), seededRandom(shuffleKey(input)));
}
