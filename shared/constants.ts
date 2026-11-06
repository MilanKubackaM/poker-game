import type { Currency, TableSettings, Variant } from './types';

export const MAX_SEATS = 9;
export const MAX_NAME_LENGTH = 20;
export const MAX_CHAT_LENGTH = 300;
export const MAX_CHIPS = 100_000_000;
export const HAND_PAUSE_MS = 5000;
/** Pauza medzi ulicami pri dorozdávaní boardu po all-in (karty hráčov sú už odkryté, nech je čas ich vidieť). */
export const RUNOUT_STEP_MS = 2500;
/** Čas na voľbu, koľkokrát sa po all-in dorozdá board (1×/2×/3×). */
export const RUN_VOTE_SEC = 12;
export const DISCARD_TIMEOUT_SEC = 10;
export const MAX_NOTE_LENGTH = 120;

/** Losovanie o dealer button. */
export const DRAW_ACK_TIMEOUT_SEC = 60;
export const DRAW_PICK_TIMEOUT_SEC = 30;
export const DRAW_RESULT_MS = 4000;
/** Poradie farieb pri rovnakej hodnote karty, od najvyššej: ♠ > ♥ > ♦ > ♣. */
export const DRAW_SUIT_ORDER = ['s', 'h', 'd', 'c'] as const;
export const SUIT_SYMBOLS: Record<'s' | 'h' | 'd' | 'c', string> = { s: '♠', h: '♥', d: '♦', c: '♣' };
/** Minimálny počet hráčov so žetónmi na spustenie hry z čakacej miestnosti. */
export const MIN_PLAYERS_TO_START = 2;

export const MAX_TABLE_NAME_LENGTH = 40;
/** Koľko posledných rúk sa drží v histórii stola. */
export const MAX_HISTORY_HANDS = 300;

/** Najviac kôl za sebou, na ktoré sa dá vyhlásiť špeciálny variant. */
export const MAX_SPECIAL_HANDS = 50;

/** Ako dlho je vidieť zaplatené odkrytie zvyšku boardu (od zaplatenia). */
export const RABBIT_SHOW_MS = 5000;
/** Uložený stôl bez aktivity sa po tomto čase zmaže. */
export const TABLE_RETENTION_DAYS = 90;
/** Max. počet stolov, ktoré klient pošle naraz na `table:summaries`. */
export const MAX_SUMMARY_REQUEST = 50;

/** Mód Prasiatko: počet výhier na zisk prasiatka, dĺžka oslavy. */
export const PIGGY_TARGET_WINS = 3;
export const PIGGY_CELEBRATION_MS = 6000;
/** Najviac hier Prasiatka za sebou pri spustení na počet (natrvalo = bez limitu). */
export const MAX_PIGGY_GAMES = 20;

/** Jukebox: najviac čakajúcich pesničiek, najdlhšia pesnička. */
export const JUKEBOX_MAX_QUEUE = 5;
export const JUKEBOX_MAX_DURATION_SEC = 600;
/** Dialóg s pravidlami módu: max. čakanie na „Rozumiem“. */
export const MODE_INTRO_TIMEOUT_SEC = 60;

/** Timebank: hranice a pomer pripísania ušetreného základného času (1/4). */
export const TIME_BANK_MIN_SEC = 5;
export const TIME_BANK_MAX_SEC = 200;
export const TIME_BANK_SAVED_RATIO = 0.25;

export const CURRENCIES: Currency[] = ['EUR', 'CZK'];

export const CURRENCY_LABELS: Record<Currency, string> = {
  EUR: 'Euro (€)',
  CZK: 'Koruna (Kč)',
};

/** Sumy sú v centoch: blindy 0,10/0,20, 7-2 bonus 0,40 (2 BB). */
export const DEFAULT_SETTINGS: TableSettings = {
  name: 'Poker Night',
  currency: 'EUR',
  smallBlind: 10,
  bigBlind: 20,
  defaultVariant: 'holdem',
  sevenDeuceAlways: false,
  sevenDeuceBounty: 40,
  actionTimeoutSec: 15,
  timeBankSec: 50,
  omahaPotLimit: true,
};

export const VARIANT_LABELS: Record<Variant, string> = {
  holdem: "Texas Hold'em",
  omaha: 'Omaha',
  pineapple: 'Pineapple',
};

export const HOLE_CARD_COUNT: Record<Variant, number> = {
  holdem: 2,
  omaha: 4,
  pineapple: 3,
};

/** Avatary na výber (zmestia sa do jedného riadku). */
export const AVATAR_EMOJIS = ['🦊', '🐻', '🐼', '🐯', '🦁', '🐸', '🐵', '🦉', '🐙', '🦄', '🐺', '🐲', '🤠', '😎', '👽', '🤖', '🎩'];

/** Platné avatary vrátane vyradených z výberu — uložené profily a hráči s nimi fungujú ďalej. */
export const ACCEPTED_AVATAR_EMOJIS = [...AVATAR_EMOJIS, '🃏'];

export const AVATAR_COLORS = ['#e76f51', '#f4a261', '#e9c46a', '#2a9d8f', '#264653', '#8e7dbe', '#d62828', '#3a86ff', '#ff006e', '#06d6a0'];
