import type { FairStateView } from './fairness';

export type Suit = 's' | 'h' | 'd' | 'c';
export type Rank = '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | 'T' | 'J' | 'Q' | 'K' | 'A';
export type Card = `${Rank}${Suit}`;

export type Variant = 'holdem' | 'omaha' | 'pineapple';
export type BettingStructure = 'no-limit' | 'pot-limit';
export type Street = 'preflop' | 'discard' | 'flop' | 'turn' | 'river' | 'showdown' | 'complete';

export type ActionType = 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'allin';

export interface PlayerAction {
  type: ActionType;
  amount?: number;
}

export interface Avatar {
  emoji: string;
  color: string;
}

/** Mena stola. Všetky sumy (stacky, blindy, stávky, poty, ledger) sú celé čísla v centoch/haliernoch. */
export type Currency = 'EUR' | 'CZK';

export interface TableSettings {
  /** Názov stola zobrazený v čakárni a v zozname „Moje stoly“ (napr. „Piatkový poker“). */
  name: string;
  currency: Currency;
  smallBlind: number;
  bigBlind: number;
  defaultVariant: Variant;
  sevenDeuceAlways: boolean;
  sevenDeuceBounty: number;
  /** Základný čas na ťah v sekundách (0 = bez limitu, vtedy sa nepoužije ani timebank). */
  actionTimeoutSec: number;
  /** Počiatočný timebank každého hráča v sekundách (pri príchode ku stolu). */
  timeBankSec: number;
  omahaPotLimit: boolean;
}

export interface NextHandOverride {
  variant?: Variant;
  /** Koľko kôl (rúk) za sebou sa ešte zahrá v tomto variante; chýba = 1. Po každej rozdanej ruke klesá. */
  hands?: number;
  /** @deprecated 7-2 sa zapína len natrvalo cez `TableSettings.sevenDeuceAlways`; server toto pole ignoruje. */
  sevenDeuce?: boolean;
}

/**
 * Zmeškané blindy hráča, ktorý sa postavil od stola (alebo prišiel počas hry):
 * `none` = nič nedlží, `big` = zmeškal BB, `small-and-big` = zmeškal SB aj BB.
 */
export type MissedBlinds = 'none' | 'big' | 'small-and-big';

/**
 * Ako sa hráč vracia do hry: `wait-bb` = čaká, kým na neho príde big blind, `post` = zaplatí dlžné blindy
 * (BB živý + SB mŕtvy, ak ho zmeškal) a hrá od najbližšej ruky.
 */
export type ReturnMode = 'wait-bb' | 'post';

export interface HandRules {
  variant: Variant;
  structure: BettingStructure;
  sevenDeuce: boolean;
  sevenDeuceBounty: number;
  smallBlind: number;
  bigBlind: number;
}

export type PlayerStatus = 'active' | 'folded' | 'allin';

export interface SeatPlayerView {
  id: string;
  name: string;
  avatar: Avatar;
  seat: number;
  stack: number;
  connected: boolean;
  /** Postavil sa od stola: nedostáva karty a neplatí blindy (eviduje sa `missedBlinds`). */
  sittingOut: boolean;
  /** Krátka pauza („som hneď späť“): ostáva v hre, blindy sa mu strhávajú a ruky sa mu automaticky foldnú (check, ak je zadarmo). */
  away: boolean;
  missedBlinds: MissedBlinds;
  /**
   * Timebank hráča v ms. Ušetrený základný čas sa delí dvomi a pripočíta; minutý timebank sa odpočíta.
   * Nikdy neklesne pod TIME_BANK_MIN_SEC a nikdy nepresiahne TIME_BANK_MAX_SEC.
   * Počas jeho ťahu je to hodnota na začiatku ťahu (živý odpočet si klient počíta z turnBaseDeadline/turnDeadline).
   */
  timeBankMs: number;
  /** Zvolený spôsob návratu, kým sa hráč reálne nevráti do hry; null = nevracia sa / nič nedlží. */
  returnMode: ReturnMode | null;
  isHost: boolean;
  camera: boolean;
  microphone: boolean;
  rtcId: string | null;
  /** Má práva hosta (zakladateľ alebo hráč, ktorému ich niekto s právami hosta pridelil). */
  isAdmin: boolean;
  inHand: boolean;
  status: PlayerStatus | null;
  bet: number;
  totalContributed: number;
  cards: (Card | null)[];
  cardCount: number;
  hasDiscarded: boolean;
  lastAction: string | null;
  handDescription: string | null;
}

export interface LegalActions {
  canFold: boolean;
  canCheck: boolean;
  callAmount: number;
  canBet: boolean;
  canRaise: boolean;
  minRaiseTo: number;
  maxRaiseTo: number;
  currentBet: number;
}

export interface PotView {
  amount: number;
  eligible: string[];
}

export interface WinnerView {
  playerId: string;
  amount: number;
  potIndex: number;
  handDescription: string | null;
  bestCards: Card[];
  /** Pri behu viackrát (all-in) — index behu od 0; pri jednom behu chýba. */
  run?: number;
}

export interface BountyView {
  winnerId: string;
  total: number;
  payers: { playerId: string; amount: number }[];
}

export interface HandResultView {
  handNumber: number;
  winners: WinnerView[];
  bounty: BountyView | null;
  revealed: Record<string, Card[]>;
  wonWithoutShowdown: boolean;
}

export interface HandView {
  handNumber: number;
  rules: HandRules;
  street: Street;
  board: Card[];
  /** All-in na viac behov: boardy 2. a 3. behu (prvý je `board`); spoločné karty sú prvých `runoutBase`. */
  extraBoards?: Card[][];
  runs?: number;
  runoutBase?: number;
  pots: PotView[];
  totalPot: number;
  dealerSeat: number;
  smallBlindSeat: number;
  bigBlindSeat: number;
  toActId: string | null;
  /** Koniec celého času hráča na ťahu (základný čas + jeho timebank), server epoch ms. */
  turnDeadline: number | null;
  /** Koniec základného času; po ňom sa míňa timebank hráča (cinknutie). null = bez limitu. */
  turnBaseDeadline: number | null;
  discardDeadline: number | null;
  /** Kolo overiteľného miešania, z ktorého je balíček tejto ruky. */
  fairRoundId: string;
}

/**
 * Záznam v transakciách stola. Žetónové operácie (`buyin`, `credit`, `debit`, `leave`) menia stack hráča:
 * amount > 0 = hráč dostal žetóny (dobitie), amount < 0 = žetóny mu boli odobraté (výber, vyhodenie).
 * Peňažné operácie (`debt-paid`, `payout`, `handover`, `reversal`) žetóny nemenia — zaznamenávajú, že peniaze reálne prešli
 * od `playerId` k `toId` (amount > 0).
 */
export type LedgerKind = 'buyin' | 'credit' | 'debit' | 'leave' | 'debt-paid' | 'payout' | 'handover' | 'reversal';

/** Žetónová operácia: `paid` = peniaze prešli hneď (hráč → bankár pri dobití, bankár → hráč pri výbere), `owed` = vyrovná sa v cashoute. */
export type Settlement = 'paid' | 'owed';

export interface LedgerEntry {
  id: number;
  at: number;
  kind: LedgerKind;
  playerId: string;
  playerName: string;
  amount: number;
  /** Stack hráča po operácii (vrátane čakajúcich žetónov); null pri odchode a peňažných operáciách. */
  stackAfter: number | null;
  /** Komentár bankára, napr. „poslal na účet". */
  note: string;
  /** Meno toho, kto operáciu zadal; null pri automatickej operácii (vyhodenie zapisuje meno hosta). */
  byName: string | null;
  /** true = počas rozdanej ruky; žetóny sa pripíšu/odpíšu až po jej skončení. */
  deferred: boolean;
  /** Žetónové operácie: ako sa vyrovnali peniaze. Staršie záznamy pole nemajú — počítajú sa ako `owed`. */
  settlement?: Settlement;
  /** Bankár, ktorý pri `paid` peniaze prijal / vyplatil. */
  bankerId?: string | null;
  bankerName?: string | null;
  /** Peňažné operácie: komu peniaze prešli. */
  toId?: string;
  toName?: string;
  /** `reversal`: ID zrušenej operácie (`debt-paid` / `payout`). */
  reverts?: number;
}

/**
 * Fáza stola: `lobby` = čakacia miestnosť pred prvou rukou, `draw` = výber/losovanie o dealer button po štarte,
 * `playing` = rozdávajú sa ruky (pauza je `paused` v rámci tejto fázy).
 */
export type TablePhase = 'lobby' | 'draw' | 'playing';

export type DealerChoice = 'random' | 'draw';

/**
 * `choose` = host vyberá náhodný button / losovanie, `explain` = všetci potvrdzujú pravidlá losovania,
 * `drawing` = hráči ťahajú karty, `done` = výsledok sa chvíľu zobrazuje pred prvou rukou.
 */
export type DrawStage = 'choose' | 'explain' | 'drawing' | 'done';

export interface DrawSlotView {
  /** Pozícia karty na stole (0–51), poradie je náhodné a karta je rubom, kým ju niekto nevytiahne. */
  index: number;
  /** Odkrytá karta po vytiahnutí, inak null (klient nesmie poznať rozloženie). */
  card: Card | null;
  drawnBy: string | null;
}

export interface DrawView {
  stage: DrawStage;
  /** Hráči, ktorí sa losovania zúčastňujú (sedia a majú žetóny v momente štartu). */
  participants: string[];
  acknowledged: string[];
  slots: DrawSlotView[];
  /** Termín aktuálnej fázy (explain/drawing/done) v ms epoch servera; po ňom server rozhodne za nečinných. */
  deadline: number | null;
  winnerId: string | null;
}

/** Záznam jednej dohranej ruky pre históriu v čakárni. */
export interface HandHistoryWinner {
  playerId: string;
  playerName: string;
  amount: number;
  handDescription: string | null;
  cards: Card[];
}

export interface HandHistoryEntry {
  handNumber: number;
  at: number;
  variant: Variant;
  sevenDeuce: boolean;
  dealerName: string;
  board: Card[];
  /** Boardy ďalších behov pri all-in na viackrát. */
  extraBoards?: Card[][];
  totalPot: number;
  wonWithoutShowdown: boolean;
  winners: HandHistoryWinner[];
  bounty: { winnerName: string; total: number } | null;
}

/** Riadok leaderboardu — počíta server z ledgeru, stackov a histórie rúk (aj pre hráčov, ktorí odišli). */
export interface LeaderboardRow {
  playerId: string;
  playerName: string;
  avatar: Avatar;
  /** Sedí ešte pri stole. */
  present: boolean;
  /** Σ kladných ledger operácií (vklady, dobitia). */
  deposited: number;
  /** Σ |záporných| ledger operácií (odobratia, odchod). */
  withdrawn: number;
  /** Aktuálny stack vrátane čakajúcich žetónov; hráčovi, ktorý odišiel, ostáva uložený (0 len po vyhodení). */
  stack: number;
  /** stack + withdrawn − deposited */
  result: number;
  handsPlayed: number;
  handsWon: number;
  biggestPot: number;
}

/** Krátky prehľad stola pre zoznam „Moje stoly“ na úvodnej obrazovke. */
export interface TableSummary {
  code: string;
  name: string;
  currency: Currency;
  phase: TablePhase;
  paused: boolean;
  handNumber: number;
  playerCount: number;
  onlineCount: number;
  hostName: string;
  /** Môj stack (vrátane čakajúcich žetónov) a či mám práva hosta. */
  myStack: number;
  myIsAdmin: boolean;
  createdAt: number;
  lastActivity: number;
}

/** Herné módy, ktoré pred prvou rukou ukážu všetkým pravidlá a čakajú na „Rozumiem“. */
export type GameMode = 'omaha' | 'pineapple' | 'seven-deuce' | 'piggy';

/**
 * Mód „Prasiatko“: pred každou rukou dá každý rozdaný hráč vstup (1 BB) do prasiatka (mimo potu),
 * potom sa hrá štandardne (SB, BB…). Kto vyhrá ruku (aj časť potu), dostane zelený krúžok.
 * Prvý s `target` krúžkami berie celé prasiatko a mód končí.
 */
export interface PiggyView {
  /** `running` = hrá sa, `finished` = práve skončilo (oslava + dialóg pre všetkých). */
  status: 'running' | 'finished';
  /** Aktuálna suma v prasiatku (centy). */
  amount: number;
  /** Vstup na jednu ruku (centy) — BB v čase štartu módu. */
  entry: number;
  target: number;
  /** playerId → počet zelených krúžkov (0…target). */
  wins: Record<string, number>;
  /** Hráč → koľko spolu vložil do prasiatka (pre férové vrátenie pri zrušení a prehľad). */
  contributed: Record<string, number>;
  startedAtHand: number;
  /** Pri `finished`: víťaz(i) a výplata; pri remíze sa prasiatko delí (zvyšný cent prvému vľavo od buttonu). */
  winners: { playerId: string; playerName: string; amount: number }[];
}

/** Dialóg s pravidlami módu pred jeho prvou rukou — ruka sa nerozdá, kým nepotvrdia všetci (alebo neuplynie termín). */
export interface ModeIntroView {
  mode: GameMode;
  participants: string[];
  acknowledged: string[];
  /** Server epoch ms; po ňom sa ruka rozdá aj bez zvyšných potvrdení. */
  deadline: number;
}

/** Po all-in hráči v ruke volia, koľkokrát sa board dorozdá; platí najmenšia voľba (kto nezvolí, má 1). */
export interface RunVoteView {
  handNumber: number;
  participants: string[];
  /** playerId → zvolený počet behov. */
  choices: Record<string, number>;
  maxRuns: number;
  /** Server epoch ms. */
  deadline: number;
}

/** Odkrytie zvyšku boardu: `cards` = karty, ktoré by ešte prišli; vidno ich do `until` (server epoch ms). */
export interface RabbitView {
  handNumber: number;
  cards: Card[];
  playerId: string;
  playerName: string;
  until: number;
}

export interface TableView {
  code: string;
  /** Zakladateľ stola — jeho práva hosta sa nedajú odobrať. */
  hostId: string;
  /** Všetci s právami hosta (vrátane zakladateľa). */
  adminIds: string[];
  /** Bankár — jediný, kto mení žetóny hráčom a potvrdzuje platby v cashoute (vždy práve jeden člen stola). */
  bankerId: string;
  createdAt: number;
  youId: string;
  settings: TableSettings;
  nextHand: NextHandOverride | null;
  running: boolean;
  paused: boolean;
  players: SeatPlayerView[];
  hand: HandView | null;
  /** Overiteľné miešanie: zmrazené kolo (odtlačky pred odhalením semienok) a či server má divákov odtlačok. */
  fair: FairStateView;
  legal: LegalActions | null;
  lastResult: HandResultView | null;
  nextHandAt: number | null;
  serverTime: number;
  ledger: LedgerEntry[];
  phase: TablePhase;
  draw: DrawView | null;
  /** Dohrané ruky, najnovšia na konci (server drží posledných MAX_HISTORY_HANDS). */
  history: HandHistoryEntry[];
  leaderboard: LeaderboardRow[];
  /** Host požiadal o návrat do čakárne — stane sa po dohraní aktuálnej ruky. */
  returnToLobbyPending: boolean;
  /** Mód Prasiatko (null = nehrá sa a ani práve neskončil). */
  piggy: PiggyView | null;
  modeIntro: ModeIntroView | null;
  /** Hlasovanie o počte behov po all-in (null = nehlasuje sa). */
  runVote: RunVoteView | null;
  /** Zaplatené odkrytie zvyšku boardu po skončení ruky (null = nikto neplatil). */
  rabbit: RabbitView | null;
  /** Žetóny z odkrytí boardu, ktoré idú ako ante do ďalšej ruky (počas ruky už sú v pote). */
  anteAmount: number;
  /** Čakajúce žiadosti o prístup ku stolu (schvaľuje host). */
  joinRequests: JoinRequestView[];
}

/**
 * Stav stola posielaný pri každej zmene (`table:state`) — bez ledgeru, histórie rúk a leaderboardu.
 * Tie idú zvlášť cez `table:meta` (pri pripojení celé, potom len nové položky), aby každý ťah neposielal stovky KB.
 */
export type TableStateView = Omit<TableView, 'ledger' | 'history' | 'leaderboard'>;

/** `table:meta` — `full` = nahradiť všetko; inak pripojiť nové položky (ledger podľa `id`, história podľa `handNumber`). */
export interface TableMetaPayload {
  code: string;
  full: boolean;
  ledger: LedgerEntry[];
  history: HandHistoryEntry[];
  /** Celý leaderboard, len keď sa zmenil (pri `full` vždy). */
  leaderboard?: LeaderboardRow[];
}

export interface TableEvent {
  id: number;
  at: number;
  /** `mode` = zapnutie / vypnutie módu hry — všetci ho dostanú aj ako upozornenie. */
  kind: 'info' | 'action' | 'result' | 'bounty' | 'host' | 'chat' | 'mode';
  text: string;
  playerId?: string;
}

export interface Ack<T = undefined> {
  ok: boolean;
  error?: string;
  data?: T;
}

/** Žiadosť o prístup ku stolu, ktorú ešte neschválil host — členovia stola vidia len meno a avatara. */
export interface JoinRequestView {
  id: string;
  name: string;
  avatar: Avatar;
  /** Server epoch ms. */
  at: number;
}

/** Odpoveď na `table:join`: žiadosť čaká na schválenie hostom (stav stola žiadateľ nedostane). */
export interface PendingJoin {
  code: string;
  requestId: string;
  token: string;
}

/** Odpoveď na `table:pendingResume` — žiadosť ešte čaká, alebo ju host medzitým schválil. */
export type PendingResumeResult = { pending: PendingJoin } | { approved: JoinResult };

/** `table:joinClosed` — žiadosť skončila inak ako schválením. */
export interface JoinClosedPayload {
  code: string;
  requestId: string;
  outcome: 'rejected' | 'expired' | 'cancelled' | 'deleted';
  byName: string | null;
}

export interface JoinResult {
  code: string;
  playerId: string;
  token: string;
}

export interface RtcSignal {
  from: string;
  to: string;
  data: RtcPayload;
}

export type RtcPayload =
  | { kind: 'description'; description: { type: 'offer' | 'answer' | 'pranswer' | 'rollback'; sdp?: string } }
  | { kind: 'candidate'; candidate: { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null; usernameFragment?: string | null } };

export interface ClientConfig {
  iceServers: { urls: string | string[]; username?: string; credential?: string }[];
  httpsPort: number | null;
  publicHost: string | null;
}

/** Server → klient po `host:deleteTable`: stôl bol zmazaný, klient ho zabudne a vráti sa na úvodnú obrazovku. */
export interface TableDeletedPayload {
  code: string;
  byName: string;
}

/** Server → klient po `player:leave` / vyhodení. Pri `kicked: false` si klient token ponechá (návrat je možný). */
export interface TableLeftPayload {
  kicked: boolean;
}
