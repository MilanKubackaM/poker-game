import type { FairProof } from './fairness';
import type { Card, Currency, DoubleBoardView, GameMode, HandRules, LegalActions, NextHandOverride, PlayerStatus, Street, TablePhase, TableSummary, Variant } from './types';

/**
 * Coach API — rozhranie len na čítanie pre pomocné aplikácie hráča (rady, štatistiky, rozbor rúk).
 *
 * Beží na samostatnom Socket.IO serveri (`COACH_SOCKET_PATH`), nie na hernom sokete. Pristupuje k nemu len účet s coach
 * tokenom (`coach:login`), ten nemôže hrať ani meniť nič v hre, a vidí len to, čo vidí sám hráč pri stole.
 *
 * Klient → server (všetko s ack `Ack<…>`):
 * - `coach:login` { login, password } → `CoachLoginResult` (token pre ďalšie pripojenia v `auth.token`)
 * - `coach:logout` {}
 * - `coach:tables` {} → `TableSummary[]` (stoly, pri ktorých účet sedí)
 * - `coach:subscribe` { code } → `{ you }`; server potom pošle `hand:action` (celá bežiaca ruka) a `coach:state`
 * - `coach:unsubscribe` { code }
 * - `coach:proofs` { code } → `CoachProofsResponse` (shuffle proofs of the hands dealt; the server seed only after the game)
 *
 * Server → klient:
 * - `coach:hello` `CoachHello` — hneď po pripojení
 * - `coach:state` `CoachStateEvent` — celý stav stola z pohľadu hráča pri každej zmene (rovnaké stavy sa neopakujú)
 * - `hand:action` `CoachActionEvent` — jedna akcia ruky v poradí `seq`; nič sa nevynecháva ani nezlučuje
 * - `coach:closed` `CoachClosedEvent` — odber stola skončil (stôl zmazaný, hráč vyhodený)
 * - `coach:revoked` {} — token už neplatí (zmena hesla, odhlásenie)
 */
export const COACH_API_VERSION = 1;
export const COACH_SOCKET_PATH = '/coach-io';

export interface CoachHello {
  apiVersion: number;
  serverVersion: string;
  /** Spojenie je prihlásené (platný coach token v handshake). */
  authenticated: boolean;
  /** Stále ID účtu, rovnaké pri každom stole. */
  you?: string;
}

export interface CoachLoginResult {
  token: string;
  username: string;
  you: string;
}

export type CoachActionType = 'sb' | 'bb' | 'return-blind' | 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'discard' | 'uncalled';

/** Akcia ruky. Neobsahuje karty (ani zahodenú kartu v Pineapple). `pid` je stále ID hráča. */
export interface CoachActionEvent {
  code: string;
  hand: number;
  seq: number;
  street: Street;
  pid: string;
  type: CoachActionType;
  /** Koľko žetónov akcia pridala do potu; pri `uncalled` koľko sa hráčovi vrátilo (nedorovnaná stávka) a pot sa o to zmenší. */
  amount: number;
  /** Stávka hráča na ulici po akcii. */
  toAmount: number;
  /** Pot tesne pred akciou, vrátane ante a mŕtvych peňazí. */
  potBefore: number;
  allin: boolean;
  /** Server konal za hráča (vypršaný čas, pauza, vyhodenie hostom). */
  auto: boolean;
}

export interface CoachPlayer {
  pid: string;
  name: string;
  seat: number;
  stack: number;
  connected: boolean;
  sittingOut: boolean;
  away: boolean;
  inHand: boolean;
  status: PlayerStatus | null;
  bet: number;
  totalContributed: number;
  /** Karty, ktoré vidí hráč: vlastné, a cudzie len keď sú na stole (showdown, all-in pred dorozdaním). Inak `null`. */
  cards: (Card | null)[];
  cardCount: number;
  hasDiscarded: boolean;
  lastAction: string | null;
  handDescription: string | null;
  isYou: boolean;
}

export interface CoachWinner {
  pid: string;
  amount: number;
  potIndex: number;
  handDescription: string | null;
  bestCards: Card[];
  run?: number;
  board?: 0 | 1;
}

export interface CoachHand {
  handNumber: number;
  rules: HandRules;
  street: Street;
  board: Card[];
  secondBoard?: Card[];
  extraBoards?: Card[][];
  runs?: number;
  runoutBase?: number;
  pots: { amount: number; eligible: string[] }[];
  totalPot: number;
  dealerSeat: number;
  smallBlindSeat: number;
  bigBlindSeat: number;
  toAct: string | null;
  turnDeadline: number | null;
  discardDeadline: number | null;
}

export interface CoachResult {
  handNumber: number;
  winners: CoachWinner[];
  bounty: { winner: string; total: number; payers: { pid: string; amount: number }[] } | null;
  revealed: Record<string, Card[]>;
  wonWithoutShowdown: boolean;
}

export interface CoachPiggy {
  status: 'running' | 'finished';
  amount: number;
  entry: number;
  target: number;
  /** Počet krúžkov každého hráča (0…target). */
  rings: Record<string, number>;
  /** Koľko spolu vložil každý hráč. */
  contributed: Record<string, number>;
  startedAtHand: number;
  winners: { pid: string; amount: number }[];
  series: { remaining: number; permanent: boolean; stopping: boolean; total: number };
}

export interface CoachSettings {
  name: string;
  currency: Currency;
  smallBlind: number;
  bigBlind: number;
  defaultVariant: Variant;
  sevenDeuceAlways: boolean;
  sevenDeuceBounty: number;
  actionTimeoutSec: number;
  omahaPotLimit: boolean;
}

/** Stav stola z pohľadu hráča — priemet `TableStateView`, v ktorom sú ID hráčov nahradené stálym `pid`. */
export interface CoachState {
  code: string;
  you: string;
  phase: TablePhase;
  running: boolean;
  paused: boolean;
  handNumber: number;
  settings: CoachSettings;
  players: CoachPlayer[];
  hand: CoachHand | null;
  /** Legálne akcie hráča, keď je na ťahu. */
  legal: LegalActions | null;
  lastResult: CoachResult | null;
  /** Ohlásený variant alebo mód pre najbližšie ruky. */
  nextHand: NextHandOverride | null;
  doubleBoard: DoubleBoardView | null;
  piggy: CoachPiggy | null;
  modeIntro: { mode: GameMode; participants: string[]; acknowledged: string[]; deadline: number } | null;
  runVote: { handNumber: number; participants: string[]; choices: Record<string, number>; maxRuns: number; deadline: number } | null;
  /** Odkrytý zvyšok boardu po skončení ruky (zaplatené). */
  rabbit: { handNumber: number; cards: Card[]; pid: string; until: number } | null;
  /** Ante z odkrytia boardu, ktoré ide do ďalšej ruky. */
  anteAmount: number;
  serverTime: number;
}

export interface CoachStateEvent {
  code: string;
  /** Poradové číslo stavu v rámci odberu, rastie o 1. */
  rev: number;
  state: CoachState;
}

/**
 * Dôkazy miešania rúk stola (rovnaké ako `fair:proofs` pre hráča pri stole). Server publikuje semienko balíčka až po hre
 * (`revealed`), vtedy sa dá z dôkazu zložiť každá ruka vrátane zahodených. Dôkaz používa ID hráčov v stole — tie vidí
 * každý člen stola — lebo vstupujú do odvodenia balíčka; `pids` ich prekladá na stále `pid`.
 */
export interface CoachProofsResponse {
  proofs: FairProof[];
  revealed: boolean;
  revealAt: number | null;
  pids: Record<string, string>;
}

export interface CoachClosedEvent {
  code: string;
  reason: 'deleted' | 'removed' | 'left';
}

export type CoachTables = TableSummary[];
