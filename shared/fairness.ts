import type { Card } from './types';

/**
 * Overiteľné miešanie (commit–reveal). Algoritmus je opísaný v README.md („Fairness“) — tento súbor drží len typy,
 * konštanty a formát exportu, ktoré zdieľa server, klient a overovací skript `tools/verify-fairness.ts`.
 */
export const FAIR_VERSION = 'poker-night/shuffle/v1';

/** Semienko aj odtlačok (SHA-256) sú 32 bajtov zapísaných ako 64 malých hex znakov. */
export const FAIR_HEX = /^[0-9a-f]{64}$/;

/** Ako dlho po zmrazení zoznamu odtlačkov čaká server na semienka hráčov, kým rozdá bez chýbajúcich. */
export const FAIR_REVEAL_MS = 4000;

/**
 * Semienko servera sa zverejní až po skončení hry: keď sa stôl vráti do čakárne alebo keď 30 min nepadla nová ruka.
 * Skôr by sa z neho dali dopočítať zahodené karty súperov ešte počas večera.
 */
export const FAIR_REVEAL_IDLE_MS = 30 * 60_000;

/** Kolo miešania tak, ako ho vidí hráč pred odhalením svojho semienka (časť `table:state`). */
export interface FairRoundView {
  roundId: string;
  serverCommit: string;
  /** Zmrazený zoznam odtlačkov hráčov (playerId → SHA-256 semienka). */
  commitments: Record<string, string>;
  /** Kto už semienko poslal. */
  revealed: string[];
  deadline: number;
}

export interface FairStateView {
  round: FairRoundView | null;
  /** Server má od diváka odtlačok semienka pre ďalšie kolo. */
  committed: boolean;
}

/** Dôkaz jednej rozdanej ruky. `serverSeed` je null, kým sa nesmie zverejniť. */
export interface FairProof {
  v: typeof FAIR_VERSION;
  table: string;
  roundId: string;
  handNumber: number;
  at: number;
  serverCommit: string;
  serverSeed: string | null;
  commitments: Record<string, string>;
  /** Odhalené semienka, ktoré sedeli s odtlačkom — len tie vstúpili do miešania. */
  seeds: Record<string, string>;
  /** Hráči zo zoznamu, ktorých semienko neprišlo včas (alebo nesedelo) — do miešania nevstúpili. */
  excluded: string[];
  dealerSeat: number;
  /** Rozdaní hráči podľa miest (z nich a z dealera vyplýva poradie rozdávania). */
  seats: { id: string; seat: number }[];
  holeCount: number;
  /** Double Board: na každej ulici po pálení najprv vrchný, potom spodný board (staršie dôkazy pole nemajú). */
  doubleBoard?: true;
}

/** Odpoveď na `fair:proofs`. */
export interface FairProofsResponse {
  proofs: FairProof[];
  /** Semienka servera sú zverejnené (hra skončila). */
  revealed: boolean;
  /** Kedy sa najneskôr zverejnia (30 min po poslednej ruke), ak hra beží. */
  revealAt: number | null;
  /** Zmrazené kolo, ktoré ešte čaká na najbližšiu ruku. */
  pendingRoundId: string | null;
}

/** Čo videl prehliadač hráča — zapisuje sa lokálne a nikdy sa neberie zo servera spätne. */
export interface FairRoundRecord {
  roundId: string;
  serverCommit: string;
  commitments: Record<string, string>;
  /** Vlastné semienko, ktoré prehliadač poslal. */
  seed: string;
  sentAt: number;
}

export interface FairHandRecord {
  handNumber: number;
  roundId: string;
  dealerSeat: number;
  seats: { id: string; seat: number }[];
  hole: Card[];
  board: Card[];
  extraBoards: Card[][];
  runoutBase: number;
  /** Double Board: spodný board, ako ho hráč videl (staršie záznamy pole nemajú). */
  secondBoard?: Card[];
  /** Karty, ktoré iní hráči ukázali (showdown, dobrovoľné ukázanie). */
  shown: Record<string, Card[]>;
  /** Zaplatené odkrytie zvyšku boardu. */
  rabbit: Card[];
}

export interface FairExport {
  format: 'poker-night-fairness-export';
  version: 1;
  table: string;
  playerId: string;
  exportedAt: number;
  rounds: FairRoundRecord[];
  hands: FairHandRecord[];
  proofs: FairProof[];
  /** Kolo, ktoré v čase exportu ešte čakalo na najbližšiu ruku. */
  pendingRoundId?: string | null;
}

/** Ktoré karty komu podľa pravidiel rozdávania pripadnú z daného balíčka (pre overenie). */
export interface ExpectedDeal {
  holes: Record<string, Card[]>;
  /** Hlavný board, ako by sa dorozdal celý (pálenie, flop, pálenie, turn, pálenie, river). */
  board: Card[];
  /** Double Board: spodný board (pri jednom boarde prázdny). */
  secondBoard: Card[];
  /** Index v balíčku, kde začína prvá karta po hlavnom boarde (od neho idú ďalšie behy). */
  afterBoard: number;
  /** Index prvej karty po rozdaní karát hráčom (od neho ide hlavný board). */
  afterHoles: number;
}

/**
 * Rozdávanie z vrchu balíčka: hráčom po jednej karte dokola od prvého miesta vľavo od dealera, potom board
 * s pálením pred flopom, turnom aj riverom. Pri Double Board ide na každej ulici po pálení najprv vrchný board, potom
 * spodný (flop 3 + 3, turn 1 + 1, river 1 + 1). Zhoduje sa s `HandEngine.start()` a `dealNextStreet()`.
 */
export function expectedDeal(deck: Card[], seats: { id: string; seat: number }[], dealerSeat: number, holeCount: number, options: { doubleBoard?: boolean } = {}): ExpectedDeal {
  const ordered = [...seats].sort((left, right) => left.seat - right.seat);
  const dealerIndex = ordered.findIndex((entry) => entry.seat === dealerSeat);
  if (dealerIndex < 0) {
    throw new Error('Dealer is not seated in the hand');
  }
  const order = ordered.map((_, offset) => ordered[(dealerIndex + 1 + offset) % ordered.length]);
  const holes: Record<string, Card[]> = Object.fromEntries(order.map((entry) => [entry.id, [] as Card[]]));
  let next = 0;
  for (let round = 0; round < holeCount; round++) {
    for (const entry of order) {
      holes[entry.id].push(deck[next++]);
    }
  }
  const afterHoles = next;
  const board: Card[] = [];
  const secondBoard: Card[] = [];
  next = dealStreets(deck, next, board, 0, options.doubleBoard ? secondBoard : undefined);
  return { holes, board, secondBoard, afterBoard: next, afterHoles };
}

/**
 * Dorozdá board z dĺžky `from` do 5 kariet (pred každou ulicou páli kartu); vráti index ďalšej karty.
 * S `second` (Double Board) dostane na každej ulici po kartách vrchného boardu svoje karty aj spodný board.
 */
export function dealStreets(deck: Card[], start: number, board: Card[], from: number, second?: Card[]): number {
  let next = start;
  let length = from;
  while (length < 5) {
    next += 1;
    const count = length === 0 ? 3 : 1;
    for (let index = 0; index < count; index++) {
      board.push(deck[next++]);
    }
    if (second) {
      for (let index = 0; index < count; index++) {
        second.push(deck[next++]);
      }
    }
    length += count;
  }
  return next;
}
