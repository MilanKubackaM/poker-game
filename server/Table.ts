import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import type { Avatar, Card, DealerChoice, DrawStage, DrawView, GameMode, HandHistoryEntry, HandHistoryWinner, HandResultView, HandRules, LeaderboardRow, LedgerEntry, LedgerKind, MissedBlinds, ModeIntroView, NextHandOverride, PiggyView, RabbitView, RunVoteView, PlayerAction, ReturnMode, SeatPlayerView, Settlement, TableEvent, TablePhase, TableSettings, TableStateView, TableSummary, TableView, Variant } from '../shared/types';
import { CURRENCIES, CURRENCY_LABELS, DEFAULT_SETTINGS, DISCARD_TIMEOUT_SEC, DRAW_ACK_TIMEOUT_SEC, DRAW_PICK_TIMEOUT_SEC, DRAW_RESULT_MS, DRAW_SUIT_ORDER, HAND_PAUSE_MS, HOLE_CARD_COUNT, MAX_CHIPS, MAX_HISTORY_HANDS, MAX_NOTE_LENGTH, MAX_SEATS, MAX_SPECIAL_HANDS, MAX_TABLE_NAME_LENGTH, RABBIT_SHOW_MS, RUN_VOTE_SEC, MIN_PLAYERS_TO_START, MODE_INTRO_TIMEOUT_SEC, PIGGY_CELEBRATION_MS, PIGGY_TARGET_WINS, RUNOUT_STEP_MS, TIME_BANK_MAX_SEC, TIME_BANK_MIN_SEC, TIME_BANK_SAVED_RATIO, SUIT_SYMBOLS, VARIANT_LABELS } from '../shared/constants';
import { formatMoney } from '../shared/money';
import { handsLabel } from '../shared/plural';
import { computeCashout, isChipEntry, type Cashout } from '../shared/settlement';
import { LIMITS } from './limits';
import { HandEngine, blindSeats, type EngineLog, type HandSeat } from './poker/HandEngine';
import { splitAmount } from './poker/pots';
import { freshDeck, rankValue, shuffle, suitOf } from './poker/cards';
import { FairDealer, type PersistedFair } from './FairDealer';
import { FAIR_REVEAL_IDLE_MS, type FairProofsResponse } from '../shared/fairness';
import { evaluateHoldem, evaluateOmaha } from './poker/evaluator';

const DISCONNECTED_TIMEOUT_MS = 15_000;
const SITTING_OUT_TIMEOUT_MS = 1_500;
/** Hráč na krátkej pauze (`away`) koná hneď — check, ak je zadarmo, inak fold; v Pineapple zahodí kartu. */
const AWAY_ACT_DELAY_MS = 0;
const MAX_EVENTS = 150;
/** O koľko sa predĺži zobrazenie výsledku ruky, keď niekto dobrovoľne ukáže karty. */
const SHOW_CARDS_EXTRA_MS = 3000;
/** Pauza medzi potvrdením pravidiel módu a rozdaním ruky. */
const INTRO_DEAL_DELAY_MS = 1500;
const PIGGY_SHORT_ERROR = 'Nemáš dosť žetónov na vstup do prasiatka — požiadaj bankára o dobitie';
const KICK_NOTE = 'Vyhodenie hostom';
const SESSION_EXPIRED = 'Relácia vypršala';
const TABLE_FULL_ON_RETURN = 'Stôl je plný — počkaj, kým sa uvoľní miesto';
const GAME_MODES: GameMode[] = ['omaha', 'pineapple', 'seven-deuce', 'piggy'];
const MODE_LABELS: Record<GameMode, string> = {
  omaha: VARIANT_LABELS.omaha,
  pineapple: VARIANT_LABELS.pineapple,
  'seven-deuce': 'Pravidlo 7-2',
  piggy: 'Prasiatko',
};
const SETTINGS_KEYS: (keyof TableSettings)[] = ['name', 'currency', 'smallBlind', 'bigBlind', 'defaultVariant', 'sevenDeuceAlways', 'sevenDeuceBounty', 'actionTimeoutSec', 'timeBankSec', 'omahaPotLimit'];

export interface TablePlayer {
  id: string;
  token: string;
  name: string;
  avatar: Avatar;
  seat: number;
  stack: number;
  pendingChips: number;
  sockets: Set<string>;
  /** Postavil sa od stola (alebo nemá žetóny): nedostáva karty, neplatí blindy; zmeškané blindy sa evidujú v `missedBlinds`. */
  sittingOut: boolean;
  /** Krátka pauza: ostáva rozdávaný, platí blindy, server za neho hneď checkuje/folduje. */
  away: boolean;
  missedBlinds: MissedBlinds;
  /** Zvolený spôsob návratu (len kým `sittingOut` a dlží blindy). */
  returnMode: ReturnMode | null;
  /** Osobný timebank v ms — vždy v rozsahu TIME_BANK_MIN_SEC…TIME_BANK_MAX_SEC; drží sa naprieč rukami aj čakárňou. */
  timeBankMs: number;
  /** Odchádza od stola počas rozdanej ruky — z miesta sa uvoľní až po jej skončení. */
  leaving: boolean;
  /** Vyhodenie hostom (cash-out do ledgeru); dobrovoľný odchod má null — hráč ostáva členom stola so svojimi žetónmi. */
  departure: { note: string; byName: string | null } | null;
  camera: boolean;
  microphone: boolean;
}

export type Result<T = undefined> = { ok: true; data?: T } | { ok: false; error: string };

export interface TableHooks {
  onChange(table: Table): void;
  onEvent(table: Table, event: TableEvent): void;
  onRemoved(table: Table, player: TablePlayer, kicked: boolean): void;
  /** Žiadosť o prístup skončila — schválená (`player` je nový člen), zamietnutá, vypršaná, zrušená žiadateľom alebo zmazaním stola. */
  onJoinClosed?(table: Table, request: JoinRequest, outcome: JoinOutcome, player: TablePlayer | null, byName: string | null): void;
}

/** Žiadosť o prístup ku stolu — žiadateľ nie je členom a nedostáva stav stola, kým ho host nepustí. Len v pamäti. */
export interface JoinRequest {
  id: string;
  /** Tajomstvo žiadateľa — návrat k žiadosti po obnovení stránky. */
  token: string;
  name: string;
  avatar: Avatar;
  at: number;
  /** Kľúč klienta (IP / IPv6 /64) pre limity. */
  ip: string;
  sockets: Set<string>;
}

export type JoinOutcome = 'approved' | 'rejected' | 'expired' | 'cancelled' | 'deleted';

const JOIN_SWEEP_MS = 30 * 1000;

export interface TableOptions {
  /** Zdroj 52 kariet pre losovanie o dealer button (testy podstrčia deterministické poradie). */
  drawDeck?: () => Card[];
}

/** Interný stav losovania — `deck` obsahuje skutočné rozloženie a nikdy neopúšťa server. */
export interface DrawState {
  stage: DrawStage;
  participants: string[];
  acknowledged: string[];
  deck: Card[];
  drawnBy: (string | null)[];
  deadline: number | null;
  winnerId: string | null;
}

/** Štatistiky hráča pre leaderboard — držia sa aj po jeho odchode od stola. */
export interface PlayerRecord {
  id: string;
  name: string;
  avatar: Avatar;
  handsPlayed: number;
  handsWon: number;
  biggestPot: number;
}

export interface PersistedPlayer {
  id: string;
  token: string;
  name: string;
  avatar: Avatar;
  seat: number;
  /** Stack pred rozdanou rukou (počas ruky drží žetóny engine). */
  stack: number;
  pendingChips: number;
  sittingOut: boolean;
  /** Polia pribudli neskôr — staršie súbory (rovnaká verzia formátu) ich nemajú, pri obnove platia predvolené hodnoty. */
  away?: boolean;
  missedBlinds?: MissedBlinds;
  returnMode?: ReturnMode | null;
  /** Staršie súbory ho nemajú → `timeBankSec` stola. */
  timeBankMs?: number;
  leaving: boolean;
  departure: { note: string; byName: string | null } | null;
}

/** Interný stav módu Prasiatko — `PiggyView` + vstupy práve rozdanej ruky (kvôli zrušeniu ruky po reštarte). */
export interface PiggyState {
  status: 'running' | 'finished';
  amount: number;
  entry: number;
  target: number;
  wins: Record<string, number>;
  contributed: Record<string, number>;
  startedAtHand: number;
  winners: { playerId: string; playerName: string; amount: number }[];
  /** Vstupy zaplatené pri rozdaní ruky `handNumber`; po jej dohraní null. */
  handEntries: { handNumber: number; entries: Record<string, number> } | null;
}

/** Uložené Prasiatko — ukladá sa len bežiace (`finished` sa po reštarte nezobrazuje). */
export interface PersistedPiggy {
  amount: number;
  entry: number;
  target: number;
  wins: Record<string, number>;
  contributed: Record<string, number>;
  startedAtHand: number;
}

export const SNAPSHOT_VERSION = 1;

/** Uložený stav stola (`DATA_DIR/tables/<CODE>.json`). Rozohraná ruka ani losovanie sa neukladajú. */
export interface TableSnapshot {
  version: typeof SNAPSHOT_VERSION;
  code: string;
  createdAt: number;
  lastActivity: number;
  settings: TableSettings;
  hostId: string;
  adminIds: string[];
  /** Staršie súbory pole nemajú → bankárom je zakladateľ. */
  bankerId?: string;
  nextHand: NextHandOverride | null;
  phase: TablePhase;
  running: boolean;
  paused: boolean;
  returnToLobbyPending: boolean;
  /** V momente uloženia prebiehala ruka — pri obnove sa zruší a hráči dostanú stacky spred nej. */
  handInProgress: boolean;
  players: PersistedPlayer[];
  records: PlayerRecord[];
  ledger: LedgerEntry[];
  events: TableEvent[];
  history: HandHistoryEntry[];
  handNumber: number;
  lastDealerSeat: number;
  /** Miesta SB/BB poslednej rozdanej ruky (−1 = v tejto hre ešte žiadna) — z nich sa počítajú zmeškané blindy. */
  lastSmallBlindSeat?: number;
  lastBigBlindSeat?: number;
  firstDealerId: string | null;
  eventId: number;
  ledgerId: number;
  /** Bežiace Prasiatko (staršie súbory pole nemajú → žiadne); vstupy zrušenej ruky sú už vrátené hráčom. */
  piggy?: PersistedPiggy | null;
  /** Módy poslednej rozdanej ruky — ich úvodný dialóg sa pri ďalšej ruke neopakuje. */
  dealtModes?: GameMode[];
  /** Ante z odkrytí boardu čakajúce na ďalšiu ruku (aj z ruky zrušenej reštartom). */
  pendingAnte?: AnteEntry[];
  /** Členovia, ktorí od stola odišli a môžu sa vrátiť so svojím stackom (staršie súbory pole nemajú). */
  departed?: PersistedPlayer[];
  /** Overiteľné miešanie: čakajúce kolo a dôkazy rozdaných rúk (staršie súbory pole nemajú). */
  fair?: PersistedFair;
}

/** Kto koľko zaplatil za odkrytie boardu — pri návrate do čakárne sa to vráti. */
export interface AnteEntry {
  playerId: string;
  amount: number;
}

/** Prebiehajúci ťah s časovým limitom: `owner` = ruka:hráč:ulica:stávka, `capAt` = skrátenie pri odpojení. */
interface TurnClock {
  owner: string;
  playerId: string;
  startedAt: number;
  baseMs: number;
  bankMs: number;
  capAt: number | null;
}

/** Stav pred rozdaním ruky — pri obnove po reštarte (ruka sa ruší) sa vráti, aby rozdanie nezmenilo dlhy na blindoch. */
interface PreHandState {
  lastSmallBlindSeat: number;
  lastBigBlindSeat: number;
  dealtModes: GameMode[];
  players: Map<string, { sittingOut: boolean; missedBlinds: MissedBlinds; returnMode: ReturnMode | null }>;
}

const DRAW_SLOTS = 52;

export class Table {
  readonly code: string;
  /** Zakladateľ (vlastník) stola — jeho práva hosta sa nedajú odobrať. */
  hostId = '';
  readonly adminIds = new Set<string>();
  /** Bankár — jediný, kto mení hráčom žetóny a potvrdzuje platby v cashoute. Predvolene zakladateľ. */
  bankerId = '';
  createdAt = Date.now();
  returnToLobbyPending = false;
  readonly history: HandHistoryEntry[] = [];
  readonly records = new Map<string, PlayerRecord>();
  settings: TableSettings;
  nextHand: NextHandOverride | null = null;
  phase: TablePhase = 'lobby';
  draw: DrawState | null = null;
  running = false;
  paused = false;
  /** Sediaci hráči (vrátane tých, čo odchádzajú po dohraní ruky). */
  readonly players = new Map<string, TablePlayer>();
  /** Členovia, ktorí od stola odišli — ich žetóny, štatistiky a timebank ostávajú uložené do návratu. */
  readonly departed = new Map<string, TablePlayer>();
  readonly events: TableEvent[] = [];
  readonly ledger: LedgerEntry[] = [];
  engine: HandEngine | null = null;
  lastResult: HandResultView | null = null;
  lastActivity = Date.now();
  private handNumber = 0;
  private lastDealerSeat = -1;
  private eventId = 0;
  private ledgerId = 0;
  private turnTimer: NodeJS.Timeout | null = null;
  private turnDeadline: number | null = null;
  private discardDeadline: number | null = null;
  private runoutTimer: NodeJS.Timeout | null = null;
  /** Ruka, v ktorej už bolo ohlásené odkrytie kariet pri all-in. */
  private runoutAnnounced: number | null = null;
  /** Hlasovanie o počte behov po all-in (1×/2×/3×). */
  runVote: RunVoteView | null = null;
  private runVoteTimer: NodeJS.Timeout | null = null;
  private nextHandTimer: NodeJS.Timeout | null = null;
  private nextHandAt: number | null = null;
  /** Číslo ruky, ktorej pauzu už predĺžilo dobrovoľné ukázanie kariet. */
  private showExtendedHand: number | null = null;
  /** Ante z odkrytí boardu pre ďalšiu ruku a ante v práve rozdanej ruke. */
  private pendingAnte: AnteEntry[] = [];
  private handAnte: AnteEntry[] = [];
  rabbit: RabbitView | null = null;
  private turnOwner = '';
  /** Koniec základného času aktuálneho ťahu (potom beží timebank hráča). */
  private turnBaseDeadline: number | null = null;
  /** Ťah hráča so základným časom + timebankom — po jeho skončení sa timebank prepočíta. */
  private turnClock: TurnClock | null = null;
  private drawTimer: NodeJS.Timeout | null = null;
  private firstDealerId: string | null = null;
  private lastSmallBlindSeat = -1;
  private lastBigBlindSeat = -1;
  private preHand: PreHandState | null = null;
  piggy: PiggyState | null = null;
  /** Čakajúce žiadosti o prístup (id → žiadosť). */
  readonly joinRequests = new Map<string, JoinRequest>();
  /** Schválené žiadosti, ktorých žiadateľ bol práve offline — po návrate (`approvedJoin`) dostane svoj token hráča. */
  private readonly approvedJoins = new Map<string, { token: string; playerId: string; until: number }>();
  private joinTimer: NodeJS.Timeout | null = null;
  modeIntro: ModeIntroView | null = null;
  /** Módy poslednej rozdanej ruky (prázdne na začiatku hry) — ich úvod sa neopakuje. */
  private dealtModes = new Set<GameMode>();
  /** Variant špeciálneho kola poslednej rozdanej ruky (null = bežná ruka) — z neho sa hlási koniec špeciálneho kola. */
  private specialInHand: Variant | null = null;
  /** Módy, ktorých pravidlá už všetci potvrdili pre najbližšiu ruku. */
  private readonly introDone = new Set<GameMode>();
  private introTimer: NodeJS.Timeout | null = null;
  private piggyTimer: NodeJS.Timeout | null = null;
  /** Hráči posadení mimo hry, lebo nemali na vstup do prasiatka — po dobití / konci Prasiatka sa vracajú ako po bankrote. */
  private readonly piggyShort = new Set<string>();
  /** Overiteľné miešanie (commit–reveal so semienkami hráčov). */
  readonly fair: FairDealer;
  /** Kolo miešania, z ktorého je balíček rozdanej ruky. */
  private fairRoundOfHand = '';
  /** Ruka čaká na semienka hráčov (najdlhšie do termínu kola). */
  private fairTimer: NodeJS.Timeout | null = null;

  constructor(code: string, settings: TableSettings, private readonly hooks: TableHooks, private readonly options: TableOptions = {}) {
    this.code = code;
    this.settings = { ...settings };
    this.fair = new FairDealer(code);
  }

  /** Stôl, na ktorom sa nikdy nehralo a nikto okrem zakladateľa k nemu neprišiel — po dni bez aktivity sa maže. */
  isUnused(): boolean {
    return this.handNumber === 0 && this.players.size + this.departed.size <= 1;
  }

  addPlayer(name: string, avatar: Avatar): Result<TablePlayer> {
    if (this.players.size + this.departed.size >= LIMITS.maxMembersPerTable) {
      return { ok: false, error: 'Stôl má už priveľa členov — host môže vyhodiť tých, ktorí sa nevrátia' };
    }
    const seat = this.freeSeat();
    if (seat === null) {
      return { ok: false, error: 'Stôl je plný' };
    }
    const player: TablePlayer = {
      id: randomUUID(),
      token: randomBytes(24).toString('hex'),
      name,
      avatar,
      seat,
      stack: 0,
      pendingChips: 0,
      sockets: new Set(),
      sittingOut: true,
      away: false,
      missedBlinds: this.blindsInMotion() ? 'big' : 'none',
      returnMode: null,
      timeBankMs: clampTimeBank(this.settings.timeBankSec * 1000),
      leaving: false,
      departure: null,
      camera: false,
      microphone: false,
    };
    this.players.set(player.id, player);
    this.records.set(player.id, { id: player.id, name, avatar, handsPlayed: 0, handsWon: 0, biggestPot: 0 });
    if (!this.hostId) {
      this.hostId = player.id;
      this.adminIds.add(player.id);
    }
    this.event('info', `${name} prisadá ku stolu — čaká na dobitie od bankára`, player.id);
    this.ensureSeatedBanker();
    this.ensureSeatedAdmin();
    this.changed();
    this.maybeScheduleNextHand();
    return { ok: true, data: player };
  }

  /**
   * Nový hráč sa k stolu nedostane hneď: vznikne žiadosť, ktorú musí schváliť host (zakladateľ alebo hráč s právami hosta).
   * Žiadateľ medzitým nevidí nič zo stola; členovia vidia len jeho meno a avatara.
   */
  requestJoin(name: string, avatar: Avatar, ip: string): Result<JoinRequest> {
    if (this.players.size + this.departed.size >= LIMITS.maxMembersPerTable) {
      return { ok: false, error: 'Stôl má už priveľa členov — host môže vyhodiť tých, ktorí sa nevrátia' };
    }
    if (this.freeSeat() === null) {
      return { ok: false, error: 'Stôl je plný' };
    }
    if (this.joinRequests.size >= LIMITS.joinRequestsPerTable) {
      return { ok: false, error: 'Ku stolu už čaká priveľa žiadostí — skús to neskôr' };
    }
    if ([...this.joinRequests.values()].filter((request) => request.ip === ip).length >= LIMITS.joinRequestsPerIp) {
      return { ok: false, error: 'Z tvojej siete už čakajú žiadosti — počkaj, kým ich host vybaví' };
    }
    const request: JoinRequest = { id: randomUUID(), token: randomBytes(24).toString('hex'), name, avatar, at: Date.now(), ip, sockets: new Set() };
    this.joinRequests.set(request.id, request);
    this.event('info', `${name} žiada o prístup ku stolu — čaká na schválenie hostom`);
    this.armJoinTimer();
    this.changed();
    return { ok: true, data: request };
  }

  /** Čakajúca žiadosť, ak sedí token žiadateľa. */
  joinRequest(requestId: unknown, token: unknown): JoinRequest | undefined {
    const request = typeof requestId === 'string' ? this.joinRequests.get(requestId) : undefined;
    return request && typeof token === 'string' && request.token === token ? request : undefined;
  }

  /** Schválená žiadosť (žiadateľ bol pri schválení offline) → člen stola, ku ktorému sa môže pripojiť. */
  approvedJoin(requestId: unknown, token: unknown): TablePlayer | undefined {
    const approved = typeof requestId === 'string' ? this.approvedJoins.get(requestId) : undefined;
    if (!approved || typeof token !== 'string' || approved.token !== token || approved.until <= Date.now()) {
      return undefined;
    }
    return this.players.get(approved.playerId);
  }

  detachJoinSocket(requestId: string, socketId: string): void {
    this.joinRequests.get(requestId)?.sockets.delete(socketId);
  }

  /** Žiadateľ sám ruší svoju žiadosť. */
  cancelJoin(requestId: unknown, token: unknown): Result {
    const request = this.joinRequest(requestId, token);
    if (!request) {
      return { ok: false, error: 'Žiadosť už neplatí' };
    }
    this.closeJoin(request, 'cancelled', null, null);
    this.event('info', `${request.name} ruší žiadosť o prístup ku stolu`);
    this.changed();
    return { ok: true };
  }

  /** Host pustí žiadateľa ku stolu (vznikne člen s 0 žetónmi, ako doteraz) alebo žiadosť zamietne. */
  resolveJoin(actor: TablePlayer, requestId: unknown, approve: boolean): Result<TablePlayer | null> {
    if (!this.isAdmin(actor.id)) {
      return { ok: false, error: 'Žiadosti schvaľuje len host' };
    }
    const request = typeof requestId === 'string' ? this.joinRequests.get(requestId) : undefined;
    if (!request) {
      return { ok: false, error: 'Žiadosť už neplatí' };
    }
    if (!approve) {
      this.closeJoin(request, 'rejected', null, actor.name);
      this.event('host', `${actor.name} zamieta žiadosť hráča ${request.name}`);
      this.changed();
      return { ok: true, data: null };
    }
    const added = this.addPlayer(request.name, request.avatar);
    if (!added.ok || !added.data) {
      return { ok: false, error: added.ok ? 'Hráča sa nepodarilo pridať' : added.error };
    }
    const player = added.data;
    this.approvedJoins.set(request.id, { token: request.token, playerId: player.id, until: Date.now() + LIMITS.joinRequestTtlMs });
    this.event('host', `${actor.name} púšťa ku stolu hráča ${request.name}`, player.id);
    this.closeJoin(request, 'approved', player, actor.name);
    this.armJoinTimer();
    this.changed();
    return { ok: true, data: player };
  }

  /** Pri zmazaní stola — žiadatelia dostanú správu, že stôl už neexistuje. */
  closeAllJoins(): void {
    for (const request of [...this.joinRequests.values()]) {
      this.closeJoin(request, 'deleted', null, null);
    }
  }

  /** Zahodí vypršané žiadosti (a pamäť schválených pre offline žiadateľov). */
  expireJoins(now = Date.now()): void {
    let changed = false;
    for (const request of [...this.joinRequests.values()]) {
      if (now - request.at >= LIMITS.joinRequestTtlMs) {
        this.closeJoin(request, 'expired', null, null);
        this.event('info', `Žiadosť hráča ${request.name} o prístup vypršala`);
        changed = true;
      }
    }
    for (const [id, approved] of this.approvedJoins) {
      if (approved.until <= now) {
        this.approvedJoins.delete(id);
      }
    }
    if (changed) {
      this.changed();
    }
  }

  private closeJoin(request: JoinRequest, outcome: JoinOutcome, player: TablePlayer | null, byName: string | null): void {
    this.joinRequests.delete(request.id);
    this.hooks.onJoinClosed?.(this, request, outcome, player, byName);
    request.sockets.clear();
  }

  private armJoinTimer(): void {
    if (this.joinTimer || (this.joinRequests.size === 0 && this.approvedJoins.size === 0)) {
      return;
    }
    this.joinTimer = setTimeout(() => {
      this.joinTimer = null;
      this.expireJoins();
      this.armJoinTimer();
    }, JOIN_SWEEP_MS);
    this.joinTimer.unref?.();
  }

  /** Zmazať stôl smie len zakladateľ a musí na potvrdenie zadať kód stola. */
  canDelete(player: TablePlayer, code: unknown): Result {
    if (!this.isHost(player.id) || this.players.get(player.id) !== player) {
      return { ok: false, error: 'Stôl môže zmazať len zakladateľ' };
    }
    if (typeof code !== 'string' || code.trim().toUpperCase() !== this.code) {
      return { ok: false, error: 'Kód stola nesedí' };
    }
    return { ok: true };
  }

  /** Sediaci hráč alebo člen, ktorý od stola odišiel (a môže sa vrátiť). */
  member(playerId: string): TablePlayer | undefined {
    return this.players.get(playerId) ?? this.departed.get(playerId);
  }

  /** Platí token pre „Moje stoly“ a návrat? Vyhodený hráč (aj počas dohrávanej ruky) už nie. */
  hasMembership(playerId: string, token: unknown): boolean {
    const player = this.member(playerId);
    return !!player && typeof token === 'string' && player.token === token && !isKicked(player);
  }

  /**
   * Návrat k stolu podľa tokenu. Sediaci hráč sa len pripojí; kto odchádza po dohraní ruky, odchod sa zruší;
   * člen, ktorý odišiel, si znova sadne (na svoje miesto, ak je voľné) so svojím stackom, štatistikami a timebankom.
   */
  /** `standing` = návrat do čakárne (Moje stoly → Pokračovať): počas hry ostane stáť bez automatického čakania na BB. */
  resume(playerId: unknown, token: unknown, standing = false): Result<TablePlayer> {
    if (typeof playerId !== 'string' || !this.hasMembership(playerId, token)) {
      return { ok: false, error: SESSION_EXPIRED };
    }
    const seated = this.players.get(playerId);
    if (seated) {
      if (seated.leaving) {
        seated.leaving = false;
        if (!standing && seated.missedBlinds === 'none' && this.visibleStack(seated) + seated.pendingChips > this.minStack()) {
          seated.sittingOut = false;
          seated.returnMode = null;
        }
        if (standing && seated.sittingOut) {
          seated.returnMode = null;
        }
        this.welcomeBack(seated);
      }
      return { ok: true, data: seated };
    }
    const member = this.departed.get(playerId)!;
    const taken = new Set([...this.players.values()].map((player) => player.seat));
    const seat = taken.has(member.seat) ? this.freeSeat() : member.seat;
    if (seat === null) {
      return { ok: false, error: TABLE_FULL_ON_RETURN };
    }
    this.departed.delete(member.id);
    member.seat = seat;
    this.players.set(member.id, member);
    this.applyReturnRules(member);
    if (standing && member.sittingOut) {
      member.returnMode = null;
    }
    this.welcomeBack(member);
    return { ok: true, data: member };
  }

  /** Vlastník stola (zakladateľ alebo ten, komu vlastníctvo odovzdal). */
  isHost(playerId: string): boolean {
    return this.hostId === playerId;
  }

  /** Má práva hosta — smie spúšťať všetky host príkazy. */
  isAdmin(playerId: string): boolean {
    return this.adminIds.has(playerId) && this.players.has(playerId);
  }

  /** Je bankár a sedí pri stole — smie meniť žetóny a potvrdzovať platby. */
  isBanker(playerId: string): boolean {
    return this.bankerId === playerId && this.players.has(playerId);
  }

  connectedCount(): number {
    return [...this.players.values()].filter((player) => player.sockets.size > 0).length;
  }

  attachSocket(player: TablePlayer, socketId: string): void {
    const wasOffline = player.sockets.size === 0;
    player.sockets.add(socketId);
    this.lastActivity = Date.now();
    if (wasOffline) {
      this.event('info', `${player.name} je online`, player.id);
    }
    this.changed();
    this.armTimers();
    this.syncDraw();
  }

  detachSocket(player: TablePlayer, socketId: string): void {
    player.sockets.delete(socketId);
    this.lastActivity = Date.now();
    if (player.sockets.size === 0) {
      player.camera = false;
      player.microphone = false;
      this.event('info', `${player.name} je offline`, player.id);
      this.armTimers();
      this.syncDraw();
      this.syncIntro();
    }
    this.changed();
  }

  updateProfile(player: TablePlayer, patch: { name?: string; avatar?: Avatar; camera?: boolean; microphone?: boolean }): void {
    if (patch.name !== undefined && patch.name !== player.name) {
      this.event('info', `${player.name} mení meno na ${patch.name}`, player.id);
      player.name = patch.name;
    }
    if (patch.avatar) {
      player.avatar = patch.avatar;
    }
    const record = this.records.get(player.id);
    if (record) {
      record.name = player.name;
      record.avatar = player.avatar;
    }
    if (patch.camera !== undefined) {
      player.camera = patch.camera;
    }
    if (patch.microphone !== undefined) {
      player.microphone = patch.microphone;
    }
    this.changed();
  }

  changeSeat(player: TablePlayer, seat: number): Result {
    if (!Number.isInteger(seat) || seat < 0 || seat >= MAX_SEATS) {
      return { ok: false, error: 'Neplatné miesto' };
    }
    if (this.isInHand(player.id)) {
      return { ok: false, error: 'Miesto môžeš zmeniť až po skončení ruky' };
    }
    if ([...this.players.values()].some((other) => other.seat === seat && other !== player)) {
      return { ok: false, error: 'Miesto je obsadené' };
    }
    if (seat === player.seat) {
      return { ok: true };
    }
    const dodgesBlinds = this.blindsInMotion() && !player.leaving && this.dealCandidates().filter((other) => other !== player).length >= 2;
    player.seat = seat;
    if (dodgesBlinds) {
      const wasPlaying = !player.sittingOut;
      if (player.missedBlinds === 'none') {
        player.missedBlinds = 'big';
      }
      if (wasPlaying) {
        player.sittingOut = true;
        player.returnMode = 'wait-bb';
      }
      this.event('info', wasPlaying ? `${player.name} mení miesto — čaká na big blind (alebo ho môže zaplatiť hneď)` : `${player.name} mení miesto — zmeškané blindy ostávajú`, player.id);
      this.syncIntro();
    }
    this.changed();
    return { ok: true };
  }

  /**
   * `true` = postaví sa od stola (nedostáva karty, neplatí blindy, eviduje sa `missedBlinds`).
   * `false` = sadne si späť — len ak nič nedlží; inak treba `returnToGame` s voľbou `wait-bb` / `post`.
   */
  setSittingOut(player: TablePlayer, value: boolean): Result {
    if (value) {
      if (player.sittingOut && player.returnMode === null) {
        return { ok: true };
      }
      const cancelsReturn = player.sittingOut;
      player.sittingOut = true;
      player.returnMode = null;
      this.event('info', cancelsReturn ? `${player.name} ostáva mimo hry` : `${player.name} vstáva od stola`, player.id);
      this.syncIntro();
      this.changed();
      this.armTimers();
      return { ok: true };
    }
    if (!player.sittingOut) {
      return { ok: true };
    }
    if (player.stack + player.pendingChips <= 0 && !this.isInHand(player.id)) {
      return { ok: false, error: 'Nemáš žetóny — požiadaj bankára o dobitie' };
    }
    if (player.stack + player.pendingChips <= this.minStack() && !this.isInHand(player.id)) {
      return { ok: false, error: PIGGY_SHORT_ERROR };
    }
    if (player.missedBlinds !== 'none') {
      return { ok: false, error: 'Najprv si vyber, či počkáš na big blind alebo zaplatíš' };
    }
    this.sitIn(player);
    return { ok: true };
  }

  /** Návrat do hry po postavení sa od stola. Keď hráč nič nedlží, sadne si hneď (rovnako ako `setSittingOut(false)`). */
  returnToGame(player: TablePlayer, mode: ReturnMode): Result {
    if (player.leaving) {
      return { ok: false, error: 'Odchádzaš od stola' };
    }
    if (!player.sittingOut) {
      return { ok: false, error: 'Už si v hre' };
    }
    if (player.stack + player.pendingChips <= 0) {
      return { ok: false, error: 'Nemáš žetóny — požiadaj bankára o dobitie' };
    }
    if (player.stack + player.pendingChips <= this.minStack()) {
      return { ok: false, error: PIGGY_SHORT_ERROR };
    }
    if (player.missedBlinds === 'none') {
      this.sitIn(player);
      return { ok: true };
    }
    if (player.returnMode !== mode) {
      player.returnMode = mode;
      this.event('info', mode === 'post' ? `${player.name} dopláca zmeškané blindy a vracia sa od ďalšej ruky` : `${player.name} čaká na big blind`, player.id);
    }
    this.changed();
    this.maybeScheduleNextHand();
    return { ok: true };
  }

  /** Krátka pauza (WC, cigareta): hráč ostáva v hre a platí blindy, server za neho hneď checkuje alebo folduje. */
  setAway(player: TablePlayer, value: boolean): Result {
    if (player.away === value) {
      return { ok: true };
    }
    player.away = value;
    this.event('info', value ? `${player.name} si dáva krátku pauzu` : `${player.name} je späť`, player.id);
    this.syncIntro();
    this.changed();
    this.armTimers();
    return { ok: true };
  }

  /**
   * Dobrovoľný odchod: hráč ostáva členom stola — jeho stack, štatistiky a timebank sa uložia a pri návrate
   * (`resume`) sa mu vrátia; do ledgeru sa nič nezapisuje. Vyhodenie (`kicked`) je cash-out: zápis do ledgeru a token
   * prestane platiť. Počas rozdanej ruky sa miesto uvoľní až po jej skončení. Zakladateľ ostáva zakladateľom.
   */
  leave(player: TablePlayer, kicked = false, kickedByName: string | null = null): void {
    if (player.leaving || this.players.get(player.id) !== player) {
      return;
    }
    const kickedBy = kicked ? (kickedByName ?? this.member(this.hostId)?.name ?? null) : null;
    player.departure = kicked ? { note: KICK_NOTE, byName: kickedBy } : null;
    this.adminIds.delete(player.id);
    const inHand = !!this.engine && !this.engine.isComplete && this.isInHand(player.id);
    if (kicked) {
      this.event('info', `${kickedBy ?? 'Host'} vyhadzuje zo stola hráča ${player.name}`, player.id);
    } else if (inHand) {
      this.event('info', `${player.name} odchádza od stola (žetóny ostávajú uložené po dohraní ruky)`, player.id);
    } else {
      this.event('info', `${player.name} odchádza od stola (žetóny ${this.money(player.stack + player.pendingChips)} ostávajú uložené)`, player.id);
    }
    if (inHand) {
      player.leaving = true;
      player.sittingOut = true;
      const enginePlayer = this.engine!.player(player.id);
      if (enginePlayer && enginePlayer.status !== 'folded' && this.engine!.toAct?.id === player.id) {
        this.engine!.act(player.id, { type: 'fold' });
        this.afterEngineChange();
      }
    } else {
      this.vacateSeat(player);
    }
    this.dropFromDraw(player);
    this.piggyShort.delete(player.id);
    this.syncIntro();
    this.hooks.onRemoved(this, player, kicked);
    this.ensureSeatedAdmin();
    this.ensureSeatedBanker();
    this.changed();
    this.armTimers();
  }

  act(player: TablePlayer, action: PlayerAction): Result {
    if (!this.engine || this.engine.isComplete) {
      return { ok: false, error: 'Neprebieha žiadna ruka' };
    }
    const outcome = this.engine.act(player.id, action);
    if (!outcome.ok) {
      return outcome;
    }
    this.afterEngineChange();
    return { ok: true };
  }

  discard(player: TablePlayer, cardIndex: number): Result {
    if (!this.engine) {
      return { ok: false, error: 'Neprebieha žiadna ruka' };
    }
    const outcome = this.engine.discard(player.id, cardIndex);
    if (!outcome.ok) {
      return outcome;
    }
    this.afterEngineChange();
    return { ok: true };
  }

  chat(player: TablePlayer, text: string): void {
    this.event('chat', text, player.id);
  }

  hostStart(): Result {
    if (this.phase === 'draw') {
      return { ok: false, error: 'Najprv sa rozhodne o dealer buttone' };
    }
    if (this.phase === 'lobby') {
      const participants = this.eligiblePlayers();
      if (participants.length < MIN_PLAYERS_TO_START) {
        return { ok: false, error: `Na spustenie treba aspoň ${MIN_PLAYERS_TO_START} hráčov so žetónmi` };
      }
      this.phase = 'draw';
      this.draw = {
        stage: 'choose',
        participants: participants.map((player) => player.id),
        acknowledged: [],
        deck: [],
        drawnBy: Array<string | null>(DRAW_SLOTS).fill(null),
        deadline: null,
        winnerId: null,
      };
      this.event('host', 'Host spúšťa hru — rozhoduje sa o dealer buttone');
      this.changed();
      return { ok: true };
    }
    if (this.returnToLobbyPending) {
      this.returnToLobbyPending = false;
      this.event('host', 'Host ruší návrat do čakárne — hra pokračuje');
      if (this.running && !this.paused) {
        this.changed();
        this.maybeScheduleNextHand();
        return { ok: true };
      }
    }
    if (this.running && !this.paused) {
      return { ok: false, error: 'Hra už beží' };
    }
    this.running = true;
    this.paused = false;
    this.event('host', 'Host spúšťa hru');
    this.changed();
    this.maybeScheduleNextHand(1500);
    return { ok: true };
  }

  hostDealerChoice(mode: DealerChoice): Result {
    const draw = this.draw;
    if (this.phase !== 'draw' || !draw || draw.stage !== 'choose') {
      return { ok: false, error: 'O dealer buttone sa teraz nerozhoduje' };
    }
    if (mode === 'random') {
      const dealerId = draw.participants[randomInt(draw.participants.length)];
      const dealer = this.players.get(dealerId)!;
      this.event('host', `Dealer button náhodne dostáva ${dealer.name}`, dealer.id);
      this.beginPlaying(dealer.id, 1500);
      return { ok: true };
    }
    if (mode === 'draw') {
      draw.deck = this.options.drawDeck ? this.options.drawDeck() : shuffle(freshDeck());
      draw.stage = 'explain';
      draw.acknowledged = [];
      draw.deadline = Date.now() + DRAW_ACK_TIMEOUT_SEC * 1000;
      this.event('host', 'Host volí losovanie o dealer button — najprv si všetci prečítajte pravidlá');
      this.syncDraw();
      this.changed();
      return { ok: true };
    }
    return { ok: false, error: 'Neplatná voľba' };
  }

  drawAck(player: TablePlayer): Result {
    const draw = this.draw;
    if (this.phase !== 'draw' || !draw || draw.stage !== 'explain') {
      return { ok: false, error: 'Pravidlá losovania sa teraz nepotvrdzujú' };
    }
    if (!draw.participants.includes(player.id)) {
      return { ok: false, error: 'Nie si účastníkom losovania' };
    }
    if (!draw.acknowledged.includes(player.id)) {
      draw.acknowledged.push(player.id);
      this.syncDraw();
      this.changed();
    }
    return { ok: true };
  }

  drawPick(player: TablePlayer, index: number): Result {
    const draw = this.draw;
    if (this.phase !== 'draw' || !draw || draw.stage !== 'drawing') {
      return { ok: false, error: 'Karty sa teraz neťahajú' };
    }
    if (!draw.participants.includes(player.id)) {
      return { ok: false, error: 'Nie si účastníkom losovania' };
    }
    if (!Number.isInteger(index) || index < 0 || index >= DRAW_SLOTS) {
      return { ok: false, error: 'Neplatná karta' };
    }
    if (draw.drawnBy.includes(player.id)) {
      return { ok: false, error: 'Kartu už máš vytiahnutú' };
    }
    if (draw.drawnBy[index] !== null) {
      return { ok: false, error: 'Túto kartu už niekto vytiahol' };
    }
    draw.drawnBy[index] = player.id;
    this.event('info', `${player.name} si ťahá ${prettyCard(draw.deck[index])}`, player.id);
    this.syncDraw();
    this.changed();
    return { ok: true };
  }

  hostPause(): Result {
    if (this.phase === 'lobby') {
      return { ok: false, error: 'Hra ešte nezačala' };
    }
    if (this.phase === 'draw') {
      return { ok: false, error: 'Počas rozhodovania o dealer buttone sa hra nedá pozastaviť' };
    }
    if (!this.running) {
      return { ok: false, error: 'Hra nebeží' };
    }
    this.paused = true;
    this.clearNextHandTimer();
    this.cancelIntro();
    this.event('host',this.engine && !this.engine.isComplete ? 'Host pozastavuje hru — po dohraní tejto ruky' : 'Host pozastavuje hru');
    this.changed();
    return { ok: true };
  }

  hostSettings(patch: Partial<TableSettings>): Result {
    const next: TableSettings = { ...this.settings };
    for (const key of SETTINGS_KEYS) {
      if (patch[key] !== undefined) {
        (next as unknown as Record<string, unknown>)[key] = patch[key];
      }
    }
    if (typeof next.name !== 'string') {
      return { ok: false, error: 'Neplatný názov stola' };
    }
    next.name = next.name.replace(/\s+/g, ' ').trim();
    if (next.name.length < 1 || next.name.length > MAX_TABLE_NAME_LENGTH) {
      return { ok: false, error: `Názov stola musí mať 1 až ${MAX_TABLE_NAME_LENGTH} znakov` };
    }
    if (!CURRENCIES.includes(next.currency)) {
      return { ok: false, error: 'Neznáma mena' };
    }
    const integers: (keyof TableSettings)[] = ['smallBlind', 'bigBlind', 'sevenDeuceBounty', 'actionTimeoutSec', 'timeBankSec'];
    for (const key of integers) {
      const value = next[key];
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_CHIPS) {
        return { ok: false, error: `Neplatná hodnota: ${key}` };
      }
    }
    if (next.smallBlind < 1 || next.bigBlind < next.smallBlind) {
      return { ok: false, error: 'Big blind musí byť aspoň taký ako small blind (min. 1)' };
    }
    if (next.actionTimeoutSec !== 0 && (next.actionTimeoutSec < 5 || next.actionTimeoutSec > 600)) {
      return { ok: false, error: 'Časový limit musí byť 0 (vypnutý) alebo 5–600 s' };
    }
    if (next.timeBankSec < TIME_BANK_MIN_SEC || next.timeBankSec > TIME_BANK_MAX_SEC) {
      return { ok: false, error: `Timebank musí byť ${TIME_BANK_MIN_SEC}–${TIME_BANK_MAX_SEC} s` };
    }
    if (!isVariant(next.defaultVariant)) {
      return { ok: false, error: 'Neznámy variant' };
    }
    if (typeof next.sevenDeuceAlways !== 'boolean' || typeof next.omahaPotLimit !== 'boolean') {
      return { ok: false, error: 'Neplatné nastavenie' };
    }
    if (next.bigBlind !== this.settings.bigBlind && next.sevenDeuceBounty === this.settings.sevenDeuceBounty && this.settings.bigBlind > 0) {
      // 7-2 bonus je v násobkoch BB — pri zmene blindov sa posunie s nimi, pokiaľ ho host v tej istej zmene nenastavil sám.
      next.sevenDeuceBounty = Math.min(MAX_CHIPS, Math.round((this.settings.sevenDeuceBounty * next.bigBlind) / this.settings.bigBlind));
    }
    const changes = describeSettingsChange(this.settings, next);
    const sevenDeuceToggled = this.settings.sevenDeuceAlways !== next.sevenDeuceAlways;
    this.settings = next;
    const handRunning = !!this.engine && !this.engine.isComplete;
    if (changes) {
      this.event('host', `Nové pravidlá: ${changes}${handRunning ? ' (od ďalšej ruky)' : ''}`);
    }
    if (sevenDeuceToggled) {
      this.event('mode', next.sevenDeuceAlways ? 'Pravidlo 7-2 je zapnuté (od ďalšej ruky)' : 'Pravidlo 7-2 je vypnuté');
      this.dealtModes.delete('seven-deuce');
      this.introDone.delete('seven-deuce');
    }
    this.revalidateIntro();
    this.changed();
    return { ok: true };
  }

  /**
   * Špeciálne kolo = variant na `hands` kôl za sebou (predvolene 1) od ďalšej ruky; `sevenDeuce` sa ignoruje (7-2 sa zapína
   * natrvalo v nastaveniach). Vyhlásenie, zmena počtu kôl aj zrušenie idú všetkým ako upozornenie (`mode`).
   */
  hostNextHand(override: NextHandOverride | null): Result {
    if (override && override.variant !== undefined && !isVariant(override.variant)) {
      return { ok: false, error: 'Neznámy variant' };
    }
    const hands = override?.hands ?? 1;
    if (!Number.isInteger(hands) || hands < 1 || hands > MAX_SPECIAL_HANDS) {
      return { ok: false, error: `Počet kôl musí byť 1 až ${MAX_SPECIAL_HANDS}` };
    }
    const previous = this.nextHand;
    const variant = override?.variant;
    this.nextHand = variant ? { variant, hands } : null;
    const live = this.engine && !this.engine.isComplete ? this.specialInHand : null;
    if (variant && previous?.variant === variant) {
      if ((previous.hands ?? 1) !== hands) {
        this.event('mode', `Host mení špeciálne kolo: ${VARIANT_LABELS[variant]} ešte ${handsLabel(hands)}${live ? ' po tejto ruke' : ''}`);
      }
    } else if (variant) {
      this.event('mode', `Host vyhlasuje špeciálne kolo: ${VARIANT_LABELS[variant]} na ${handsLabel(hands)} od ďalšej ruky`);
    } else if (previous?.variant) {
      this.event('mode', `Host ruší špeciálne kolo — ${live ? 'po tejto ruke sa' : 'znova sa'} hrá ${VARIANT_LABELS[this.settings.defaultVariant]}`);
    }
    this.revalidateIntro();
    this.changed();
    return { ok: true };
  }

  /**
   * Bankár dobíja (kladná suma) alebo vyberá (záporná) žetóny. `paid` = peniaze prešli hneď (hráč → bankár pri dobití,
   * bankár → hráč pri výbere), `owed` = vyrovná sa v cashoute. Bankárovi samému sa zapíše vždy `paid` (drží vlastné peniaze).
   */
  bankChips(target: TablePlayer, amount: number, note: unknown = '', byName: string | null = null, settlement: unknown = 'owed'): Result {
    if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > MAX_CHIPS) {
      return { ok: false, error: 'Neplatná suma' };
    }
    if (settlement !== 'paid' && settlement !== 'owed') {
      return { ok: false, error: 'Vyber, či sú peniaze zaplatené alebo na dlh' };
    }
    if (note !== undefined && note !== null && typeof note !== 'string') {
      return { ok: false, error: 'Neplatná poznámka' };
    }
    const cleanNote = (note ?? '').replace(/\s+/g, ' ').trim();
    if (cleanNote.length > MAX_NOTE_LENGTH) {
      return { ok: false, error: `Poznámka môže mať najviac ${MAX_NOTE_LENGTH} znakov` };
    }
    if (this.ledger.length >= LIMITS.maxLedgerEntries) {
      return { ok: false, error: 'Stôl dosiahol limit transakcií — založ nový stôl' };
    }
    if (target.leaving) {
      return { ok: false, error: 'Hráč odchádza od stola' };
    }
    const inHand = this.isInHand(target.id);
    if (amount < 0 && inHand) {
      return { ok: false, error: 'Žetóny môžeš hráčovi odobrať až po skončení ruky' };
    }
    if (amount < 0 && -amount > target.stack) {
      return { ok: false, error: `Hráč má len ${this.money(target.stack)}` };
    }
    if (inHand) {
      target.pendingChips += amount;
    } else {
      target.stack += amount;
    }
    const couldNotPlay = target.stack - amount <= 0 || this.piggyShort.has(target.id);
    let waitsForBigBlind = false;
    if (!inHand && amount > 0 && couldNotPlay && target.sittingOut && target.stack > this.minStack()) {
      this.fundedAgain(target);
      waitsForBigBlind = target.sittingOut && target.returnMode === 'wait-bb';
    } else if (!inHand && amount > 0 && couldNotPlay && target.sittingOut && target.stack > 0) {
      this.piggyShort.add(target.id);
    } else if (target.stack <= 0 && !inHand) {
      target.sittingOut = true;
      target.returnMode = null;
    }
    const banker = this.member(this.bankerId);
    const how: Settlement = target.id === this.bankerId ? 'paid' : settlement;
    this.record(amount > 0 ? 'credit' : 'debit', target, amount, this.visibleStack(target) + target.pendingChips, cleanNote, byName, inHand, {
      settlement: how,
      bankerId: how === 'paid' ? (banker?.id ?? null) : null,
      bankerName: how === 'paid' ? (banker?.name ?? null) : null,
    });
    const verb = amount > 0 ? `dobíja ${this.money(amount)}` : `vyberá ${this.money(-amount)}`;
    const cash = target.id === this.bankerId ? '' : amount > 0 ? (how === 'paid' ? ' (zaplatené bankárovi)' : ' (na dlh)') : how === 'paid' ? ' (vyplatené hneď)' : ' (bank dlží)';
    this.event('host', `Bankár ${verb} hráčovi ${target.name}${cash}${inHand ? ' — pripíšu sa po ruke' : ''}${cleanNote ? ` — „${cleanNote}“` : ''}`, target.id);
    if (waitsForBigBlind) {
      this.event('info', `${target.name} čaká na big blind (alebo ho môže zaplatiť hneď)`, target.id);
    }
    this.changed();
    this.maybeScheduleNextHand();
    return { ok: true };
  }

  /**
   * Host prideľuje rolu bankára. Ak doterajší bankár drží peniaze, `moveCash` určí, či ich odovzdá novému bankárovi
   * (zapíše sa `handover`), alebo si ich ponechá (v cashoute ich potom rozdá on).
   */
  hostSetBanker(actor: TablePlayer, target: TablePlayer, moveCash: unknown): Result {
    if (target.leaving || this.players.get(target.id) !== target) {
      return { ok: false, error: 'Hráč odchádza od stola' };
    }
    if (target.id === this.bankerId) {
      return { ok: true };
    }
    if (moveCash !== undefined && typeof moveCash !== 'boolean') {
      return { ok: false, error: 'Neplatná voľba' };
    }
    const previousName = this.memberName(this.bankerId);
    const held = this.cashHeldBy(this.bankerId);
    if (held > 0 && moveCash === undefined) {
      return { ok: false, error: `${previousName} drží ${this.money(held)} — vyber, či ich odovzdá novému bankárovi` };
    }
    if (held > 0 && moveCash) {
      if (this.ledger.length >= LIMITS.maxLedgerEntries) {
        return { ok: false, error: 'Stôl dosiahol limit transakcií — založ nový stôl' };
      }
      this.record('handover', { id: this.bankerId, name: previousName }, held, null, '', actor.name, false, { toId: target.id, toName: target.name });
    }
    this.bankerId = target.id;
    const cash = held <= 0 ? '' : moveCash ? ` — ${previousName} mu odovzdáva ${this.money(held)}` : ` — ${previousName} si ponecháva ${this.money(held)} do cashoutu`;
    this.event('host', `${actor.name} robí bankárom hráča ${target.name}${cash}`, target.id);
    this.changed();
    return { ok: true };
  }

  /**
   * Bankár potvrdzuje platbu v cashoute: `debt` = hráč splatil dlh bankárovi, `payout` = prevod z cashoutu
   * (od `fromId` k `toId`) prebehol. Suma nesmie prekročiť to, čo cashout aktuálne požaduje.
   */
  bankSettle(actor: TablePlayer, kind: unknown, fromId: unknown, toId: unknown, amount: unknown): Result {
    if (kind !== 'debt' && kind !== 'payout') {
      return { ok: false, error: 'Neplatná voľba' };
    }
    if (typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0 || amount > MAX_CHIPS) {
      return { ok: false, error: 'Neplatná suma' };
    }
    if (this.ledger.length >= LIMITS.maxLedgerEntries) {
      return { ok: false, error: 'Stôl dosiahol limit transakcií — založ nový stôl' };
    }
    const cashout = this.cashout();
    const from = cashout.rows.find((row) => row.playerId === fromId);
    const receiverId = kind === 'debt' ? this.bankerId : toId;
    const to = cashout.rows.find((row) => row.playerId === receiverId);
    if (!from || !to || from === to) {
      return { ok: false, error: kind === 'debt' ? 'Bankár nemôže splatiť dlh sám sebe' : 'Neplatný hráč' };
    }
    const stale = 'Cashout sa medzitým zmenil — skús to znova';
    if (kind === 'debt') {
      if (amount > from.debt) {
        return { ok: false, error: from.debt > 0 ? stale : `${from.playerName} nemá nesplatený dlh` };
      }
    } else {
      if (this.piggy?.status === 'running' && this.piggy.amount > 0) {
        return { ok: false, error: 'V Prasiatku sú žetóny — výplaty potvrdíš po jeho výplate alebo zrušení' };
      }
      if (this.anteAmount() > 0) {
        return { ok: false, error: 'Ante z odkrytia boardu ešte nie je rozohrané — výplaty potvrdíš po ďalšej ruke' };
      }
      if (amount > -from.balance || amount > to.balance) {
        return { ok: false, error: stale };
      }
    }
    this.record(kind === 'debt' ? 'debt-paid' : 'payout', { id: from.playerId, name: from.playerName }, amount, null, '', actor.name, false, { toId: to.playerId, toName: to.playerName });
    this.event(
      'host',
      kind === 'debt' ? `${from.playerName} splatil bankárovi ${to.playerName} dlh ${this.money(amount)}` : `Cashout: ${from.playerName} poslal ${to.playerName} ${this.money(amount)}`,
      from.playerId,
    );
    this.changed();
    return { ok: true };
  }

  /** Bankár ruší omylom potvrdenú platbu z cashoutu — zapíše sa opačný pohyb peňazí. */
  bankUndo(actor: TablePlayer, entryId: unknown): Result {
    const entry = typeof entryId === 'number' ? this.ledger.find((item) => item.id === entryId) : undefined;
    if (!entry || (entry.kind !== 'debt-paid' && entry.kind !== 'payout') || !entry.toId) {
      return { ok: false, error: 'Platba neexistuje' };
    }
    if (this.ledger.some((item) => item.kind === 'reversal' && item.reverts === entry.id)) {
      return { ok: false, error: 'Platba už je zrušená' };
    }
    if (this.ledger.length >= LIMITS.maxLedgerEntries) {
      return { ok: false, error: 'Stôl dosiahol limit transakcií — založ nový stôl' };
    }
    this.record('reversal', { id: entry.toId, name: entry.toName ?? '' }, entry.amount, null, '', actor.name, false, {
      toId: entry.playerId,
      toName: entry.playerName,
      reverts: entry.id,
    });
    this.event('host', `Bankár ruší platbu ${entry.playerName} → ${entry.toName ?? ''} ${this.money(entry.amount)}`, entry.playerId);
    this.changed();
    return { ok: true };
  }

  /** Cashout z transakcií a aktuálnych stackov (rovnaké stacky ako leaderboard, vrátane členov, ktorí odišli). */
  cashout(): Cashout {
    return computeCashout(
      this.ledger,
      this.leaderboard().map((row) => ({ playerId: row.playerId, playerName: row.playerName, stack: row.stack })),
    );
  }

  /** Hotovosť z hry, ktorú má člen u seba (kladná typicky u bankára). */
  cashHeldBy(playerId: string): number {
    return this.cashout().rows.find((row) => row.playerId === playerId)?.holds ?? 0;
  }

  /** Odovzdá vlastníctvo stola; doterajší vlastník si práva hosta ponechá. */
  hostTransfer(target: TablePlayer): Result {
    if (target.leaving) {
      return { ok: false, error: 'Hráč odchádza od stola' };
    }
    this.adminIds.add(this.hostId);
    this.hostId = target.id;
    this.adminIds.add(target.id);
    this.event('host', `${target.name} je nový host`, target.id);
    this.changed();
    return { ok: true };
  }

  hostSetAdmin(actor: TablePlayer, target: TablePlayer, admin: boolean): Result {
    if (target.leaving) {
      return { ok: false, error: 'Hráč odchádza od stola' };
    }
    if (!admin && target.id === this.hostId) {
      return { ok: false, error: 'Zakladateľovi stola sa práva hosta nedajú odobrať' };
    }
    if (this.adminIds.has(target.id) === admin) {
      return { ok: true };
    }
    if (admin) {
      this.adminIds.add(target.id);
      this.event('host', `${actor.name} prideľuje práva hosta hráčovi ${target.name}`, target.id);
    } else {
      this.adminIds.delete(target.id);
      this.event('host', `${actor.name} odoberá práva hosta hráčovi ${target.name}`, target.id);
      this.ensureSeatedAdmin();
    }
    this.changed();
    return { ok: true };
  }

  /** Ukončí hru a vráti stôl do čakárne — hneď, alebo po dohraní rozdanej ruky. */
  hostToLobby(): Result {
    if (this.phase === 'lobby') {
      return { ok: false, error: 'Stôl už je v čakárni' };
    }
    if (this.phase === 'draw') {
      return { ok: false, error: 'Počas rozhodovania o dealer buttone sa do čakárne nedá vrátiť' };
    }
    if (this.returnToLobbyPending) {
      return { ok: true };
    }
    this.event('host', 'Host ukončuje hru — návrat do čakárne');
    if (this.engine && !this.engine.isComplete) {
      this.returnToLobbyPending = true;
      this.clearNextHandTimer();
      this.changed();
      return { ok: true };
    }
    this.enterLobby();
    return { ok: true };
  }

  /**
   * Mód Prasiatko. `start`: od najbližšej rozdanej ruky dá každý rozdaný hráč vstup (BB v čase štartu) do prasiatka;
   * pred prvou takou rukou sa ukážu pravidlá. `cancel`: každý prítomný dostane späť svoje vstupy, vstupy hráčov, ktorí
   * odišli, sa rovnomerne rozdelia medzi prítomných prispievateľov (zvyšný cent prvému vľavo od buttonu).
   */
  hostPiggy(action: 'start' | 'cancel'): Result {
    if (action === 'start') {
      return this.startPiggy();
    }
    if (action === 'cancel') {
      return this.cancelPiggy();
    }
    return { ok: false, error: 'Neplatná voľba' };
  }

  /** Hráč potvrdzuje pravidlá módu pred jeho prvou rukou („Rozumiem“). */
  /**
   * Dobrovoľné ukázanie kariet po skončení ruky (aj foldnuté či nevyložené). Prvé ukázanie predĺži pauzu pred ďalšou
   * rukou o SHOW_CARDS_EXTRA_MS, ďalšie zaručia, že ostane aspoň SHOW_CARDS_EXTRA_MS na pozretie.
   */
  showCards(player: TablePlayer): Result {
    const engine = this.engine;
    const result = engine?.result;
    if (!engine || !engine.isComplete || !result || !this.lastResult || this.lastResult.handNumber !== engine.handNumber) {
      return { ok: false, error: 'Karty sa dajú ukázať až po skončení ruky' };
    }
    const enginePlayer = engine.player(player.id);
    if (!enginePlayer || enginePlayer.hole.length === 0) {
      return { ok: false, error: 'V tejto ruke si nemal karty' };
    }
    if (result.revealed[player.id]) {
      return { ok: false, error: 'Tvoje karty sú už ukázané' };
    }
    const cards = [...enginePlayer.hole];
    result.revealed[player.id] = cards;
    this.lastResult.revealed[player.id] = cards;
    this.event('info', `${player.name} ukazuje karty: ${cards.map(prettyCard).join(' ')}`, player.id);
    if (this.nextHandTimer && this.nextHandAt !== null) {
      const now = Date.now();
      const at = this.showExtendedHand === engine.handNumber ? Math.max(this.nextHandAt, now + SHOW_CARDS_EXTRA_MS) : this.nextHandAt + SHOW_CARDS_EXTRA_MS;
      this.showExtendedHand = engine.handNumber;
      clearTimeout(this.nextHandTimer);
      this.nextHandAt = at;
      this.nextHandTimer = setTimeout(() => {
        this.nextHandTimer = null;
        this.nextHandAt = null;
        this.startHand();
      }, Math.max(0, at - now));
    }
    this.changed();
    return { ok: true };
  }

  /**
   * Odkrytie zvyšku boardu po ruke, ktorá skončila pred riverom: hráč zaplatí 1 BB, ktorý ide ako ante do ďalšej ruky,
   * a všetci uvidia karty, ktoré by ešte prišli, RABBIT_SHOW_MS od zaplatenia (ďalšia ruka sa o toľko odloží).
   */
  rabbitHunt(player: TablePlayer): Result {
    const engine = this.engine;
    if (!engine || !engine.isComplete || !this.lastResult || this.lastResult.handNumber !== engine.handNumber) {
      return { ok: false, error: 'Board sa dá odkryť až po skončení ruky' };
    }
    if (engine.board.length >= 5) {
      return { ok: false, error: 'Board je už celý' };
    }
    if (this.rabbit?.handNumber === engine.handNumber) {
      return { ok: false, error: `Board už odkryl ${this.rabbit.playerName}` };
    }
    if (this.players.get(player.id) !== player || player.leaving) {
      return { ok: false, error: 'Nie si pri stole' };
    }
    const cost = this.settings.bigBlind;
    if (player.stack < cost) {
      return { ok: false, error: `Na odkrytie boardu treba ${this.money(cost)}` };
    }
    player.stack -= cost;
    if (player.stack <= 0) {
      player.sittingOut = true;
      player.returnMode = null;
    }
    this.pendingAnte.push({ playerId: player.id, amount: cost });
    const cards = engine.remainingBoard();
    this.rabbit = { handNumber: engine.handNumber, cards, playerId: player.id, playerName: player.name, until: Date.now() + RABBIT_SHOW_MS };
    this.event('info', `${player.name} platí ${this.money(cost)} za odkrytie boardu: ${cards.map(prettyCard).join(' ')} — ide ako ante do ďalšej ruky`, player.id);
    this.delayNextHand(RABBIT_SHOW_MS);
    this.changed();
    return { ok: true };
  }

  /** Žetóny z odkrytí boardu mimo stackov: čakajúce ante + ante v práve rozohranej ruke. */
  anteAmount(): number {
    const live = this.engine && !this.engine.isComplete ? this.handAnte : [];
    return [...this.pendingAnte, ...live].reduce((sum, entry) => sum + entry.amount, 0);
  }

  /** Ďalšia ruka sa rozdá najskôr o `ms` od teraz (ak už je naplánovaná). */
  private delayNextHand(ms: number): void {
    if (!this.nextHandTimer || this.nextHandAt === null) {
      return;
    }
    const at = Math.max(this.nextHandAt, Date.now() + ms);
    if (at === this.nextHandAt) {
      return;
    }
    clearTimeout(this.nextHandTimer);
    this.nextHandAt = at;
    this.nextHandTimer = setTimeout(() => {
      this.nextHandTimer = null;
      this.nextHandAt = null;
      this.startHand();
    }, Math.max(0, at - Date.now()));
  }

  modeAck(player: TablePlayer): Result {
    const intro = this.modeIntro;
    if (!intro) {
      return { ok: false, error: 'Pravidlá módu sa teraz nepotvrdzujú' };
    }
    if (!intro.participants.includes(player.id)) {
      return { ok: false, error: 'Nie si účastníkom tejto ruky' };
    }
    if (!intro.acknowledged.includes(player.id)) {
      intro.acknowledged.push(player.id);
      this.syncIntro();
      this.changed();
    }
    return { ok: true };
  }

  summary(playerId: string): TableSummary {
    const me = this.member(playerId);
    const present = [...this.players.values()].filter((player) => !player.leaving);
    return {
      code: this.code,
      name: this.settings.name,
      currency: this.settings.currency,
      phase: this.phase,
      paused: this.paused,
      handNumber: this.handNumber,
      playerCount: present.length,
      onlineCount: present.filter((player) => player.sockets.size > 0).length,
      hostName: this.member(this.hostId)?.name ?? this.records.get(this.hostId)?.name ?? '',
      myStack: me ? this.visibleStack(me) + me.pendingChips : 0,
      myIsAdmin: this.isAdmin(playerId),
      createdAt: this.createdAt,
      lastActivity: this.lastActivity,
    };
  }

  /**
   * Leaderboard z ledgeru, stackov a štatistík rúk. Stack je stack spred rozdanej ruky + čakajúce žetóny,
   * takže výsledok sa počas ruky nemení podľa žetónov v pote.
   */
  leaderboard(): LeaderboardRow[] {
    const money = new Map<string, { deposited: number; withdrawn: number; name: string }>();
    for (const entry of this.ledger) {
      if (!isChipEntry(entry)) {
        continue;
      }
      const row = money.get(entry.playerId) ?? { deposited: 0, withdrawn: 0, name: entry.playerName };
      if (entry.amount > 0) {
        row.deposited += entry.amount;
      } else {
        row.withdrawn += -entry.amount;
      }
      row.name = entry.playerName;
      money.set(entry.playerId, row);
    }
    const ids = new Set<string>(money.keys());
    for (const record of this.records.values()) {
      if (record.handsPlayed > 0) {
        ids.add(record.id);
      }
    }
    for (const player of this.players.values()) {
      if (!player.leaving) {
        ids.add(player.id);
      }
    }
    for (const id of this.departed.keys()) {
      ids.add(id);
    }
    const rows: LeaderboardRow[] = [...ids].map((id) => {
      const seated = this.players.get(id);
      const present = !!seated && !seated.leaving;
      const player = seated ?? this.departed.get(id);
      const record = this.records.get(id);
      const flow = money.get(id) ?? { deposited: 0, withdrawn: 0, name: '' };
      const stack = player ? player.stack + player.pendingChips : 0;
      return {
        playerId: id,
        playerName: player?.name ?? record?.name ?? flow.name,
        avatar: player?.avatar ?? record?.avatar ?? { emoji: '🃏', color: '#264653' },
        present,
        deposited: flow.deposited,
        withdrawn: flow.withdrawn,
        stack,
        result: stack + flow.withdrawn - flow.deposited,
        handsPlayed: record?.handsPlayed ?? 0,
        handsWon: record?.handsWon ?? 0,
        biggestPot: record?.biggestPot ?? 0,
      };
    });
    return rows.sort((left, right) => right.result - left.result || left.playerName.localeCompare(right.playerName, 'sk'));
  }

  /** Plný pohľad (testy, demo) — na sieť ide `liveView` + `meta` zvlášť. */
  view(viewerId: string): TableView {
    return { ...this.liveView(viewerId), ledger: this.ledger, history: this.history, leaderboard: this.leaderboard() };
  }

  /** Posledné ID v ledgeri a číslo poslednej dohranej ruky v histórii (na posielanie len nových položiek). */
  metaCursor(): { ledgerId: number; handNumber: number } {
    return { ledgerId: this.ledger.at(-1)?.id ?? 0, handNumber: this.history.at(-1)?.handNumber ?? 0 };
  }

  /** Položky ledgeru a histórie novšie ako `since` (bez `since` všetky). */
  metaSince(since?: { ledgerId: number; handNumber: number }): { ledger: LedgerEntry[]; history: HandHistoryEntry[] } {
    if (!since) {
      return { ledger: this.ledger, history: this.history };
    }
    return {
      ledger: since.ledgerId >= (this.ledger.at(-1)?.id ?? 0) ? [] : this.ledger.filter((entry) => entry.id > since.ledgerId),
      history: since.handNumber >= (this.history.at(-1)?.handNumber ?? 0) ? [] : this.history.filter((entry) => entry.handNumber > since.handNumber),
    };
  }

  /** Stav stola pre jedného hráča bez ledgeru, histórie a leaderboardu (tie idú cez `table:meta`). */
  liveView(viewerId: string): TableStateView {
    const engine = this.engine;
    const result = engine?.result ?? null;
    const players: SeatPlayerView[] = [...this.players.values()]
      .sort((left, right) => left.seat - right.seat)
      .map((player) => {
        const enginePlayer = engine?.player(player.id);
        // All-in bez ďalších stávok: karty hráčov v ruke sa odkryjú hneď pred dorozdaním boardu (štandard v cash game).
        const tabled = !!engine?.awaitingRunout && !!enginePlayer && enginePlayer.status !== 'folded';
        const revealed = result?.revealed[player.id] ?? (tabled ? enginePlayer!.hole : undefined);
        let cards: (Card | null)[] = [];
        let handDescription: string | null = null;
        if (enginePlayer) {
          if (player.id === viewerId || revealed) {
            cards = revealed ?? enginePlayer.hole;
          } else {
            cards = enginePlayer.hole.map(() => null);
          }
          if (enginePlayer.evaluated && revealed) {
            handDescription = enginePlayer.evaluated.description;
          } else if ((player.id === viewerId || tabled) && engine && engine.board.length >= 3 && enginePlayer.status !== 'folded') {
            handDescription = currentHandDescription(engine, enginePlayer.hole);
          }
        }
        return {
          id: player.id,
          name: player.name,
          avatar: player.avatar,
          seat: player.seat,
          stack: enginePlayer && !engine?.isComplete ? enginePlayer.stack : player.stack,
          connected: player.sockets.size > 0,
          sittingOut: player.sittingOut,
          away: player.away,
          missedBlinds: player.missedBlinds,
          timeBankMs: player.timeBankMs,
          returnMode: player.returnMode,
          isHost: player.id === this.hostId,
          isAdmin: this.adminIds.has(player.id),
          camera: player.camera,
          microphone: player.microphone,
          rtcId: player.sockets.size > 0 ? [...player.sockets].at(-1)! : null,
          inHand: !!enginePlayer,
          status: enginePlayer?.status ?? null,
          bet: enginePlayer && !engine?.isComplete ? enginePlayer.bet : 0,
          totalContributed: enginePlayer ? enginePlayer.total + enginePlayer.dead : 0,
          cards,
          cardCount: enginePlayer?.hole.length ?? 0,
          hasDiscarded: enginePlayer?.discarded ?? false,
          lastAction: enginePlayer?.lastAction ?? null,
          handDescription,
        };
      });

    return {
      code: this.code,
      hostId: this.hostId,
      adminIds: [...this.adminIds].filter((id) => this.players.has(id)),
      bankerId: this.bankerId,
      createdAt: this.createdAt,
      youId: viewerId,
      settings: this.settings,
      nextHand: this.nextHand,
      running: this.running,
      paused: this.paused,
      players,
      hand: engine
        ? {
            handNumber: engine.handNumber,
            rules: engine.rules,
            street: engine.street,
            board: engine.board,
            ...(engine.runs > 1 || engine.extraBoards.length ? { extraBoards: engine.extraBoards.map((board) => [...board]), runs: engine.runs, runoutBase: engine.runoutBase } : {}),
            pots: engine.isComplete ? [] : engine.pots(),
            totalPot: engine.isComplete ? 0 : engine.totalPot,
            dealerSeat: engine.dealerSeat,
            smallBlindSeat: engine.smallBlindSeat,
            bigBlindSeat: engine.bigBlindSeat,
            toActId: engine.toAct?.id ?? null,
            turnDeadline: this.turnDeadline,
            turnBaseDeadline: this.turnBaseDeadline,
            discardDeadline: this.discardDeadline,
            fairRoundId: this.fairRoundOfHand,
          }
        : null,
      fair: this.fair.view(viewerId),
      legal: engine?.legalActions(viewerId) ?? null,
      lastResult: this.lastResult,
      nextHandAt: this.nextHandAt,
      serverTime: Date.now(),
      phase: this.phase,
      draw: this.drawView(),
      returnToLobbyPending: this.returnToLobbyPending,
      piggy: this.piggyView(),
      rabbit: this.rabbit,
      anteAmount: this.anteAmount(),
      runVote: this.runVote ? { ...this.runVote, participants: [...this.runVote.participants], choices: { ...this.runVote.choices } } : null,
      modeIntro: this.modeIntro
        ? { ...this.modeIntro, participants: [...this.modeIntro.participants], acknowledged: [...this.modeIntro.acknowledged] }
        : null,
      joinRequests: [...this.joinRequests.values()].map(({ id, name, avatar, at }) => ({ id, name, avatar, at })),
    };
  }

  /**
   * Hráč v ruke po all-in volí, koľkokrát sa board dorozdá. Platí najmenšia voľba — keď niekto zvolí 1×,
   * rozhodnuté je hneď; inak sa čaká na všetkých (alebo na termín, kto nezvolí, má 1×).
   */
  chooseRuns(player: TablePlayer, runs: unknown): Result {
    const vote = this.runVote;
    const engine = this.engine;
    if (!vote || !engine || engine.handNumber !== vote.handNumber) {
      return { ok: false, error: 'Teraz sa o behoch nehlasuje' };
    }
    if (!vote.participants.includes(player.id)) {
      return { ok: false, error: 'Nie si v tejto ruke' };
    }
    if (typeof runs !== 'number' || !Number.isInteger(runs) || runs < 1 || runs > vote.maxRuns) {
      return { ok: false, error: `Vyber 1 až ${vote.maxRuns}` };
    }
    vote.choices[player.id] = runs;
    this.event('info', `${player.name} chce ísť na ${runs}×`, player.id);
    this.syncRunVote();
    this.changed();
    return { ok: true };
  }

  private openRunVote(engine: HandEngine): void {
    const maxRuns = engine.maxRuns();
    const participants = engine.players.filter((player) => player.status !== 'folded').map((player) => player.id);
    if (maxRuns < 2 || participants.length < 2) {
      return;
    }
    this.runVote = { handNumber: engine.handNumber, participants, choices: {}, maxRuns, deadline: Date.now() + RUN_VOTE_SEC * 1000 };
    this.event('info', `Hráči v ruke volia, koľkokrát sa ide (1× až ${maxRuns}×) — platí najmenšia voľba`);
    this.runVoteTimer = setTimeout(() => {
      this.runVoteTimer = null;
      this.finishRunVote();
    }, RUN_VOTE_SEC * 1000);
    this.syncRunVote();
  }

  /** Rozhodne hneď, keď už je výsledok jasný: niekto zvolil 1×, niekto nie je pripojený / je na pauze, alebo zvolili všetci. */
  private syncRunVote(): void {
    const vote = this.runVote;
    if (!vote) {
      return;
    }
    const absent = vote.participants.some((id) => {
      const player = this.players.get(id);
      return !player || player.sockets.size === 0 || player.away || player.leaving;
    });
    const choices = Object.values(vote.choices);
    if (absent || choices.includes(1) || vote.participants.every((id) => vote.choices[id] !== undefined)) {
      this.finishRunVote();
    }
  }

  private clearRunVote(): void {
    if (this.runVoteTimer) {
      clearTimeout(this.runVoteTimer);
      this.runVoteTimer = null;
    }
    this.runVote = null;
  }

  private finishRunVote(): void {
    const vote = this.runVote;
    if (!vote) {
      return;
    }
    if (this.runVoteTimer) {
      clearTimeout(this.runVoteTimer);
      this.runVoteTimer = null;
    }
    this.runVote = null;
    const engine = this.engine;
    if (!engine || engine.handNumber !== vote.handNumber || !engine.awaitingRunout) {
      return;
    }
    const wanted = Math.min(...vote.participants.map((id) => vote.choices[id] ?? 1));
    const runs = engine.setRuns(wanted);
    this.event('info', runs > 1 ? `Ide sa na ${runs}× — každý pot sa delí na ${runs} časti` : 'Ide sa na 1×');
    this.armTimers();
    this.changed();
  }

  dispose(): void {
    if (this.joinTimer) {
      clearTimeout(this.joinTimer);
      this.joinTimer = null;
    }
    this.clearRunVote();
    this.clearTurnTimer();
    this.clearNextHandTimer();
    this.clearDrawTimer();
    this.clearIntroTimer();
    this.clearPiggyTimer();
    this.clearFairTimer();
    if (this.runoutTimer) {
      clearTimeout(this.runoutTimer);
    }
  }

  private money(cents: number): string {
    return formatMoney(cents, this.settings.currency);
  }

  private visibleStack(player: TablePlayer): number {
    const enginePlayer = this.engine && !this.engine.isComplete ? this.engine.player(player.id) : undefined;
    return enginePlayer ? enginePlayer.stack : player.stack;
  }

  private record(kind: LedgerKind, player: Pick<TablePlayer, 'id' | 'name'>, amount: number, stackAfter: number | null, note: string, byName: string | null, deferred: boolean, extra: Partial<LedgerEntry> = {}): LedgerEntry {
    const entry: LedgerEntry = { id: ++this.ledgerId, at: Date.now(), kind, playerId: player.id, playerName: player.name, amount, stackAfter, note, byName, deferred, ...extra };
    this.ledger.push(entry);
    return entry;
  }

  /** Uvoľní miesto odchádzajúceho hráča: vyhodený ide preč nadobro (cash-out), inak sa presunie medzi členov, ktorí odišli. */
  private vacateSeat(player: TablePlayer): void {
    if (isKicked(player)) {
      this.removePlayer(player);
      return;
    }
    this.players.delete(player.id);
    this.piggyShort.delete(player.id);
    if (this.piggy?.status === 'running') {
      delete this.piggy.wins[player.id];
    }
    player.stack += player.pendingChips;
    player.pendingChips = 0;
    player.leaving = false;
    player.departure = null;
    player.sittingOut = true;
    player.away = false;
    player.returnMode = null;
    player.camera = false;
    player.microphone = false;
    this.departed.set(player.id, player);
  }

  /**
   * Pravidlá návratu člena, ktorý odišiel: počas hry (blindy už išli) čaká na big blind ako nový hráč (dlží aspoň BB),
   * v čakárni / pri losovaní si rovno sadne. Bez žetónov (alebo bez vstupu do Prasiatka) čaká na dokúpenie.
   */
  private applyReturnRules(player: TablePlayer): void {
    const chips = player.stack + player.pendingChips;
    player.stack = chips;
    player.pendingChips = 0;
    player.leaving = false;
    player.departure = null;
    player.away = false;
    player.returnMode = null;
    if (this.blindsInMotion()) {
      if (player.missedBlinds === 'none') {
        player.missedBlinds = 'big';
      }
      player.sittingOut = true;
      if (chips > this.minStack()) {
        player.returnMode = 'wait-bb';
      }
    } else {
      player.missedBlinds = 'none';
      player.sittingOut = chips <= this.minStack();
    }
    if (chips > 0 && chips <= this.minStack()) {
      this.piggyShort.add(player.id);
    }
  }

  private welcomeBack(player: TablePlayer): void {
    const chips = this.visibleStack(player) + player.pendingChips;
    this.event('info', `${player.name} sa vracia ku stolu so stackom ${this.money(chips)}`, player.id);
    if (player.sittingOut && player.returnMode === 'wait-bb') {
      this.event('info', `${player.name} čaká na big blind (alebo ho môže zaplatiť hneď)`, player.id);
    } else if (chips <= 0) {
      this.event('info', `${player.name} nemá žetóny — čaká na dobitie od bankára`, player.id);
    }
    if (this.isHost(player.id)) {
      this.adminIds.add(player.id);
      this.event('host', `Zakladateľ ${player.name} sa vracia — má späť práva hosta`, player.id);
    }
    this.ensureSeatedAdmin();
    this.ensureSeatedBanker();
    this.changed();
    this.armTimers();
    this.maybeScheduleNextHand();
  }

  /**
   * Keď bankár odíde (alebo ho vyhodia), rolu dostane zakladateľ, ak sedí, inak niektorý host — vždy niekto, kto už rolu
   * a zodpovednosť má, nikdy náhodný hráč. Ak pri stole nie je nikto s rolou, bankár ostáva a dobíjanie počká na jeho
   * návrat (alebo kým sa vráti zakladateľ/host). Peniaze, ktoré doterajší bankár drží, ostávajú uňho (rozdá ich v cashoute).
   */
  private ensureSeatedBanker(): void {
    const current = this.players.get(this.bankerId);
    if (current && !current.leaving) {
      return;
    }
    const seated = [...this.players.values()].filter((player) => !player.leaving);
    if (!seated.length) {
      return;
    }
    const chosen = seated.find((player) => player.id === this.hostId) ?? seated.find((player) => this.adminIds.has(player.id));
    if (!chosen) {
      return;
    }
    const previous = this.bankerId;
    this.bankerId = chosen.id;
    if (!previous) {
      return;
    }
    const held = this.cashHeldBy(previous);
    const cash = held > 0 ? ` — ${this.memberName(previous)} si ponecháva ${this.money(held)} do cashoutu` : '';
    this.event('host', `Bankárom je ${chosen.name} (${this.memberName(previous)} odišiel od stola)${cash}`, chosen.id);
  }

  private memberName(playerId: string): string {
    return this.member(playerId)?.name ?? this.records.get(playerId)?.name ?? this.ledger.findLast((entry) => entry.playerId === playerId)?.playerName ?? '';
  }

  /**
   * Keď pri stole nesedí nikto s právami hosta (odišli), prevezme ich bankár — niekto, kto už rolu a zodpovednosť má.
   * Ak nesedí ani bankár, práva nedostane nikto (náhodný hráč nie): hra beží ďalej, ale nikto nepúšťa nových hráčov
   * ani nemení nastavenia, kým sa nevráti zakladateľ, host alebo bankár.
   */
  private ensureSeatedAdmin(): void {
    const seated = [...this.players.values()].filter((player) => !player.leaving);
    if (!seated.length || seated.some((player) => this.adminIds.has(player.id))) {
      return;
    }
    const banker = this.players.get(this.bankerId);
    if (!banker || banker.leaving) {
      return;
    }
    this.adminIds.add(banker.id);
    this.event('host', `Práva hosta preberá bankár ${banker.name} (pri stole nebol žiadny host)`, banker.id);
  }

  private removePlayer(player: TablePlayer): void {
    const chips = player.stack + player.pendingChips;
    if (chips > 0) {
      const departure = player.departure ?? { note: 'Odchod od stola', byName: null };
      this.record('leave', player, -chips, null, departure.note, departure.byName, false, { settlement: 'owed', bankerId: null, bankerName: null });
    }
    this.players.delete(player.id);
    this.piggyShort.delete(player.id);
    if (this.piggy?.status === 'running') {
      delete this.piggy.wins[player.id];
    }
  }

  private piggyView(): PiggyView | null {
    const piggy = this.piggy;
    if (!piggy) {
      return null;
    }
    return {
      status: piggy.status,
      amount: piggy.amount,
      entry: piggy.entry,
      target: piggy.target,
      wins: { ...piggy.wins },
      contributed: { ...piggy.contributed },
      startedAtHand: piggy.startedAtHand,
      winners: piggy.winners.map((winner) => ({ ...winner })),
    };
  }

  /** Minimálny stack, s ktorým hráč dostane karty: počas Prasiatka musí po zaplatení vstupu ostať aspoň 1 cent. */
  private minStack(): number {
    return this.piggy?.status === 'running' ? this.piggy.entry : 0;
  }

  /** Hráč, ktorý nemohol hrať pre nedostatok žetónov, ich znova má: hrá hneď, alebo čaká na BB, ak ho medzitým minul blind. */
  private fundedAgain(player: TablePlayer): void {
    this.piggyShort.delete(player.id);
    if (player.missedBlinds === 'none') {
      player.sittingOut = false;
      player.returnMode = null;
    } else {
      player.returnMode ??= 'wait-bb';
    }
  }

  /** Pripíše žetóny mimo ledgeru (vrátenie vstupov z prasiatka) — počas ruky ako čakajúce, inak rovno do stacku. */
  private creditChips(player: TablePlayer, amount: number): void {
    if (this.isInHand(player.id)) {
      player.pendingChips += amount;
      return;
    }
    const couldNotPlay = player.stack <= 0 || this.piggyShort.has(player.id);
    player.stack += amount;
    if (couldNotPlay && player.sittingOut && player.stack > this.minStack()) {
      this.fundedAgain(player);
    }
  }

  /** Po skončení Prasiatka sa hráči, ktorí nemali na vstup, vracajú do hry (alebo čakajú na BB, ak dlžia blindy). */
  private releasePiggyShort(): void {
    for (const id of [...this.piggyShort]) {
      const player = this.players.get(id);
      if (player && !player.leaving && player.sittingOut && player.stack > 0) {
        this.fundedAgain(player);
      }
    }
    this.piggyShort.clear();
  }

  /** Pred rozdaním: kto počas Prasiatka nemá viac než vstup, nedostane karty a nič neplatí (eviduje sa ako bez žetónov). */
  private sitOutShortStacks(): void {
    const minimum = this.minStack();
    if (minimum <= 0) {
      return;
    }
    for (const player of this.players.values()) {
      if (!player.sittingOut && !player.leaving && player.stack > 0 && player.stack <= minimum) {
        player.sittingOut = true;
        player.returnMode = null;
        this.piggyShort.add(player.id);
        this.event('info', `${player.name} nemá dosť žetónov na vstup do prasiatka — čaká na dobitie od bankára`, player.id);
      }
    }
  }

  private startPiggy(): Result {
    if (this.phase === 'draw') {
      return { ok: false, error: 'Počas rozhodovania o dealer buttone sa Prasiatko nedá spustiť' };
    }
    if (this.piggy?.status === 'running') {
      return { ok: false, error: 'Prasiatko už beží' };
    }
    this.clearPiggyTimer();
    const wins: Record<string, number> = {};
    for (const player of this.dealCandidates()) {
      wins[player.id] = 0;
    }
    this.piggy = {
      status: 'running',
      amount: 0,
      entry: this.settings.bigBlind,
      target: PIGGY_TARGET_WINS,
      wins,
      contributed: {},
      startedAtHand: this.handNumber + 1,
      winners: [],
      handEntries: null,
    };
    this.dealtModes.delete('piggy');
    this.introDone.delete('piggy');
    this.event('mode', `Host spúšťa Prasiatko — vstup ${this.money(this.piggy.entry)} do prasiatka pred každou rukou, prvý s ${PIGGY_TARGET_WINS} výhrami berie všetko`);
    this.changed();
    this.maybeScheduleNextHand();
    return { ok: true };
  }

  private cancelPiggy(): Result {
    const piggy = this.piggy;
    if (!piggy || piggy.status !== 'running') {
      return { ok: false, error: 'Prasiatko nebeží' };
    }
    const present = [...this.players.values()].filter((player) => !player.leaving);
    const refunds = new Map<TablePlayer, number>();
    let orphaned = 0;
    for (const [id, amount] of Object.entries(piggy.contributed)) {
      const player = present.find((candidate) => candidate.id === id);
      if (player) {
        refunds.set(player, (refunds.get(player) ?? 0) + amount);
      } else {
        orphaned += amount;
      }
    }
    if (orphaned > 0) {
      const heirs = this.leftOfButton(refunds.size ? [...refunds.keys()] : present, this.lastDealerSeat);
      if (heirs.length) {
        const shares = splitAmount(orphaned, heirs.map((player) => player.id));
        for (const heir of heirs) {
          refunds.set(heir, (refunds.get(heir) ?? 0) + (shares.get(heir.id) ?? 0));
        }
      }
    }
    this.piggy = null;
    this.introDone.delete('piggy');
    this.event('mode', 'Host ruší Prasiatko — vstupy sa vracajú');
    const parts: string[] = [];
    for (const player of this.leftOfButton([...refunds.keys()], this.lastDealerSeat)) {
      const amount = refunds.get(player) ?? 0;
      if (amount > 0) {
        this.creditChips(player, amount);
        parts.push(`${player.name} ${this.money(amount)}`);
      }
    }
    if (parts.length) {
      this.event('info', `Z prasiatka sa vracia: ${parts.join(', ')}`);
    }
    this.releasePiggyShort();
    this.revalidateIntro();
    this.changed();
    this.maybeScheduleNextHand();
    return { ok: true };
  }

  /** Hráči zoradení v smere hry od miesta vľavo od `buttonSeat` (button je posledný). */
  private leftOfButton(players: TablePlayer[], buttonSeat: number): TablePlayer[] {
    const order = (seat: number) => seatDistance(buttonSeat, seat) || MAX_SEATS;
    return [...players].sort((left, right) => order(left.seat) - order(right.seat));
  }

  /** Vstupy do prasiatka pri rozdaní ruky — odpočítajú sa zo stacku ešte pred blindami (nejdú do potu). */
  private payPiggyEntries(seats: HandSeat[]): void {
    const piggy = this.piggy;
    if (!piggy || piggy.status !== 'running') {
      return;
    }
    const entries: Record<string, number> = {};
    for (const seat of seats) {
      const player = this.players.get(seat.id)!;
      const paid = Math.min(piggy.entry, player.stack);
      player.stack -= paid;
      seat.stack = player.stack;
      entries[player.id] = paid;
      piggy.amount += paid;
      piggy.contributed[player.id] = (piggy.contributed[player.id] ?? 0) + paid;
      piggy.wins[player.id] ??= 0;
    }
    piggy.handEntries = { handNumber: this.handNumber, entries };
    this.event('info', `Do prasiatka ide ${seats.length} × ${this.money(piggy.entry)} (spolu ${this.money(piggy.amount)})`);
  }

  /**
   * Po dohraní ruky s vstupmi: každý prítomný hráč, ktorý vyhral akúkoľvek časť potu, dostane krúžok. Kto dosiahne
   * `target`, berie prasiatko (viacerí naraz sa delia, zvyšný cent prvému vľavo od buttonu) — výplata ide do čakajúcich
   * žetónov, takže sa pripíše spolu s výsledkom ruky. Vráti true, keď Prasiatko práve skončilo.
   */
  private settlePiggy(engine: HandEngine): boolean {
    const piggy = this.piggy;
    if (!piggy || piggy.status !== 'running' || piggy.handEntries?.handNumber !== engine.handNumber) {
      return false;
    }
    piggy.handEntries = null;
    const winnerIds = new Set(engine.result!.winners.filter((winner) => winner.amount > 0).map((winner) => winner.playerId));
    for (const id of winnerIds) {
      const player = this.players.get(id);
      if (!player || player.leaving) {
        continue;
      }
      piggy.wins[id] = Math.min(piggy.target, (piggy.wins[id] ?? 0) + 1);
      this.event('info', `${player.name} získava krúžok v Prasiatku (${piggy.wins[id]}/${piggy.target})`, id);
    }
    const champions = this.leftOfButton(
      [...this.players.values()].filter((player) => !player.leaving && (piggy.wins[player.id] ?? 0) >= piggy.target),
      engine.dealerSeat,
    );
    if (!champions.length) {
      return false;
    }
    const shares = splitAmount(piggy.amount, champions.map((player) => player.id));
    piggy.winners = champions.map((player) => ({ playerId: player.id, playerName: player.name, amount: shares.get(player.id) ?? 0 }));
    for (const winner of piggy.winners) {
      const player = this.players.get(winner.playerId)!;
      if (engine.player(player.id)) {
        player.pendingChips += winner.amount;
      } else {
        player.stack += winner.amount;
      }
    }
    piggy.status = 'finished';
    if (piggy.winners.length === 1) {
      const [winner] = piggy.winners;
      this.event('result', `${winner.playerName} vyhráva Prasiatko — ${this.money(winner.amount)}!`, winner.playerId);
    } else {
      const names = piggy.winners.map((winner) => `${winner.playerName} (${this.money(winner.amount)})`);
      this.event('result', `Prasiatko si delia ${names.slice(0, -1).join(', ')} a ${names.at(-1)}!`);
    }
    this.clearPiggyTimer();
    this.piggyTimer = setTimeout(() => {
      this.piggyTimer = null;
      if (this.piggy === piggy) {
        this.piggy = null;
        this.changed();
      }
    }, PIGGY_CELEBRATION_MS);
    return true;
  }

  private clearPiggyTimer(): void {
    if (this.piggyTimer) {
      clearTimeout(this.piggyTimer);
      this.piggyTimer = null;
    }
  }

  /** Módy najbližšej ruky (podľa pravidiel, ktoré by dostala, keby sa rozdala teraz). */
  private upcomingModes(): GameMode[] {
    const rules = this.buildRules();
    const modes: GameMode[] = [];
    if (rules.variant !== 'holdem') {
      modes.push(rules.variant);
    }
    if (rules.sevenDeuce) {
      modes.push('seven-deuce');
    }
    if (this.piggy?.status === 'running') {
      modes.push('piggy');
    }
    return modes;
  }

  /** Prvý mód najbližšej ruky, ktorý v minulej ruke nebol a ktorého pravidlá ešte nikto nepotvrdil (poradie variant → 7-2 → Prasiatko). */
  private pendingIntroMode(): GameMode | null {
    return this.upcomingModes().find((mode) => !this.dealtModes.has(mode) && !this.introDone.has(mode)) ?? null;
  }

  private openIntro(mode: GameMode, participants: string[]): void {
    this.clearIntroTimer();
    const intro: ModeIntroView = { mode, participants, acknowledged: [], deadline: Date.now() + MODE_INTRO_TIMEOUT_SEC * 1000 };
    this.modeIntro = intro;
    this.event('info', `Nový mód: ${MODE_LABELS[mode]} — pred rozdaním si všetci prečítajte pravidlá`);
    this.introTimer = setTimeout(() => {
      this.introTimer = null;
      if (this.modeIntro !== intro) {
        return;
      }
      this.event('info', 'Čas na potvrdenie pravidiel vypršal — rozdáva sa');
      this.finishIntro();
    }, MODE_INTRO_TIMEOUT_SEC * 1000);
    this.changed();
    this.syncIntro();
  }

  /** Potvrdí za odpojených, hráčov na pauze, postavených a odchádzajúcich; keď sú všetci, rozdá sa. Bez 2 hráčov sa úvod ruší. */
  private syncIntro(): void {
    const intro = this.modeIntro;
    if (!intro) {
      return;
    }
    if (this.dealCandidates().length < 2) {
      this.cancelIntro();
      this.changed();
      return;
    }
    for (const id of intro.participants) {
      const player = this.players.get(id);
      const absent = !player || player.leaving || player.sockets.size === 0 || player.away || (player.sittingOut && player.returnMode === null);
      if (absent && !intro.acknowledged.includes(id)) {
        intro.acknowledged.push(id);
      }
    }
    if (intro.participants.every((id) => intro.acknowledged.includes(id))) {
      this.finishIntro();
    }
  }

  private finishIntro(): void {
    const intro = this.modeIntro;
    if (!intro) {
      return;
    }
    this.introDone.add(intro.mode);
    this.clearIntroTimer();
    this.modeIntro = null;
    this.changed();
    this.maybeScheduleNextHand(INTRO_DEAL_DELAY_MS);
  }

  /** Zruší otvorený úvod (pauza, čakáreň) — pred rozdaním sa ukáže znova, aj už potvrdené módy. */
  private cancelIntro(): void {
    this.clearIntroTimer();
    this.modeIntro = null;
    this.introDone.clear();
  }

  /** Host zmenil pravidlá počas úvodu tak, že mód v ďalšej ruke nebude — úvod sa zavrie a pokračuje sa ďalej. */
  private revalidateIntro(): void {
    const intro = this.modeIntro;
    if (!intro || this.upcomingModes().includes(intro.mode)) {
      return;
    }
    this.clearIntroTimer();
    this.modeIntro = null;
    this.maybeScheduleNextHand(INTRO_DEAL_DELAY_MS);
  }

  private clearIntroTimer(): void {
    if (this.introTimer) {
      clearTimeout(this.introTimer);
      this.introTimer = null;
    }
  }

  private isInHand(playerId: string): boolean {
    return !!this.engine && !this.engine.isComplete && !!this.engine.player(playerId);
  }

  private freeSeat(): number | null {
    const taken = new Set([...this.players.values()].map((player) => player.seat));
    for (let seat = 0; seat < MAX_SEATS; seat++) {
      if (!taken.has(seat)) {
        return seat;
      }
    }
    return null;
  }

  /** Hráči, ktorí normálne hrajú (sedia, majú žetóny, neodchádzajú). */
  private eligiblePlayers(): TablePlayer[] {
    return [...this.players.values()]
      .filter((player) => !player.sittingOut && !player.leaving && player.stack > this.minStack())
      .sort((left, right) => left.seat - right.seat);
  }

  /** Hráči, ktorí sa vracajú do hry (zvolili `wait-bb` / `post`) a čakajú na rozdanie. */
  private returningPlayers(): TablePlayer[] {
    return [...this.players.values()]
      .filter((player) => player.sittingOut && player.returnMode !== null && !player.leaving && player.stack > this.minStack())
      .sort((left, right) => left.seat - right.seat);
  }

  /** Kto môže dostať karty v ďalšej ruke — podľa počtu sa rozhoduje, či sa ruka vôbec rozdá. */
  private dealCandidates(): TablePlayer[] {
    return [...this.eligiblePlayers(), ...this.returningPlayers()];
  }

  /** Blindy už v tejto hre (fáza `playing`) aspoň raz išli — odteraz sa evidujú zmeškané blindy. */
  private blindsInMotion(): boolean {
    return this.phase === 'playing' && this.lastBigBlindSeat >= 0;
  }

  private sitIn(player: TablePlayer): void {
    this.piggyShort.delete(player.id);
    player.sittingOut = false;
    player.returnMode = null;
    player.missedBlinds = 'none';
    this.event('info', `${player.name} sa vracia do hry`, player.id);
    this.changed();
    this.armTimers();
    this.maybeScheduleNextHand();
  }

  private drawView(): DrawView | null {
    const draw = this.draw;
    if (!draw) {
      return null;
    }
    return {
      stage: draw.stage,
      participants: [...draw.participants],
      acknowledged: [...draw.acknowledged],
      slots: draw.drawnBy.map((drawnBy, index) => ({ index, card: drawnBy ? draw.deck[index] : null, drawnBy })),
      deadline: draw.deadline,
      winnerId: draw.winnerId,
    };
  }

  /** Posunie losovanie, keď už nie je na koho čakať, a nastaví časovač aktuálnej fázy. */
  private syncDraw(): void {
    const draw = this.draw;
    if (this.phase !== 'draw' || !draw) {
      return;
    }
    if (draw.stage === 'explain') {
      for (const id of draw.participants) {
        const player = this.players.get(id);
        if ((!player || player.sockets.size === 0) && !draw.acknowledged.includes(id)) {
          draw.acknowledged.push(id);
        }
      }
      if (draw.participants.every((id) => draw.acknowledged.includes(id))) {
        this.event('info', 'Pravidlá sú potvrdené — ťahajte karty');
        this.startDrawing();
        return;
      }
    } else if (draw.stage === 'drawing') {
      for (const id of draw.participants) {
        const player = this.players.get(id);
        if ((!player || player.sockets.size === 0) && !draw.drawnBy.includes(id)) {
          this.autoPick(id);
        }
      }
      if (draw.participants.every((id) => draw.drawnBy.includes(id))) {
        this.finishDraw();
        return;
      }
    }
    this.armDrawTimer();
  }

  private startDrawing(): void {
    const draw = this.draw!;
    draw.stage = 'drawing';
    draw.deadline = Date.now() + DRAW_PICK_TIMEOUT_SEC * 1000;
    this.syncDraw();
    this.changed();
  }

  private finishDraw(): void {
    const draw = this.draw!;
    const winnerId = this.drawLeader();
    if (!winnerId) {
      return;
    }
    draw.stage = 'done';
    draw.winnerId = winnerId;
    draw.deadline = Date.now() + DRAW_RESULT_MS;
    const winner = this.players.get(winnerId);
    const card = draw.deck[draw.drawnBy.indexOf(winnerId)];
    this.event('result', `${winner?.name ?? 'Hráč'} vyhráva losovanie s ${prettyCard(card)} a dostáva dealer button`, winnerId);
    this.armDrawTimer();
    this.changed();
  }

  /** Účastník s najvyššou vytiahnutou kartou (eso vysoko, pri rovnakej hodnote rozhoduje farba ♠ > ♥ > ♦ > ♣). */
  private drawLeader(): string | null {
    const draw = this.draw!;
    let best: { id: string; card: Card } | null = null;
    for (const id of draw.participants) {
      const index = draw.drawnBy.indexOf(id);
      if (index < 0) {
        continue;
      }
      const card = draw.deck[index];
      if (!best || compareDrawCards(card, best.card) > 0) {
        best = { id, card };
      }
    }
    return best?.id ?? null;
  }

  private armDrawTimer(): void {
    this.clearDrawTimer();
    const draw = this.draw;
    if (this.phase !== 'draw' || !draw || draw.deadline === null) {
      return;
    }
    this.drawTimer = setTimeout(() => {
      this.drawTimer = null;
      this.onDrawDeadline();
    }, Math.max(0, draw.deadline - Date.now()));
  }

  private onDrawDeadline(): void {
    const draw = this.draw;
    if (this.phase !== 'draw' || !draw) {
      return;
    }
    if (draw.stage === 'explain') {
      draw.acknowledged = [...draw.participants];
      this.event('info', 'Čas na potvrdenie pravidiel vypršal — ťahajte karty');
      this.startDrawing();
    } else if (draw.stage === 'drawing') {
      for (const id of draw.participants) {
        if (!draw.drawnBy.includes(id)) {
          this.autoPick(id);
        }
      }
      this.finishDraw();
    } else if (draw.stage === 'done' && draw.winnerId) {
      this.beginPlaying(draw.winnerId, 0);
    }
  }

  private autoPick(id: string): void {
    const draw = this.draw!;
    const free = draw.drawnBy.flatMap((drawnBy, index) => (drawnBy === null ? [index] : []));
    const index = free[randomInt(free.length)];
    draw.drawnBy[index] = id;
    const name = this.players.get(id)?.name ?? 'Hráč';
    this.event('info', `${name}: čas na ťahanie vypršal — automaticky dostáva ${prettyCard(draw.deck[index])}`, id);
  }

  /** Ukončí fázu losovania; prvá ruka sa rozdá s `dealerId` na buttone. */
  private beginPlaying(dealerId: string, delay: number): void {
    this.clearDrawTimer();
    this.phase = 'playing';
    this.draw = null;
    this.running = true;
    this.paused = false;
    this.firstDealerId = dealerId;
    this.lastSmallBlindSeat = -1;
    this.lastBigBlindSeat = -1;
    const dealer = this.players.get(dealerId);
    if (dealer) {
      this.lastDealerSeat = dealer.seat - 1;
    }
    this.changed();
    if (delay > 0) {
      this.maybeScheduleNextHand(delay);
    } else {
      this.startHand();
    }
  }

  private dropFromDraw(player: TablePlayer): void {
    const draw = this.draw;
    if (this.phase !== 'draw' || !draw || !draw.participants.includes(player.id)) {
      return;
    }
    draw.participants = draw.participants.filter((id) => id !== player.id);
    draw.acknowledged = draw.acknowledged.filter((id) => id !== player.id);
    if (draw.participants.length < MIN_PLAYERS_TO_START) {
      this.clearDrawTimer();
      this.phase = 'lobby';
      this.draw = null;
      this.event('info', `Losovanie o dealer button sa zrušilo — na hru treba aspoň ${MIN_PLAYERS_TO_START} hráčov, stôl sa vracia do čakárne`);
      this.changed();
      return;
    }
    if (draw.stage === 'done' && draw.winnerId === player.id) {
      this.finishDraw();
      return;
    }
    this.syncDraw();
  }

  private clearDrawTimer(): void {
    if (this.drawTimer) {
      clearTimeout(this.drawTimer);
      this.drawTimer = null;
    }
  }

  private maybeScheduleNextHand(delay = HAND_PAUSE_MS): void {
    if (this.phase !== 'playing' || !this.running || this.paused || this.nextHandTimer || this.modeIntro) {
      return;
    }
    if (this.engine && !this.engine.isComplete) {
      return;
    }
    if (this.dealCandidates().length < 2) {
      return;
    }
    this.nextHandAt = Date.now() + delay;
    this.nextHandTimer = setTimeout(() => {
      this.nextHandTimer = null;
      this.nextHandAt = null;
      this.startHand();
    }, delay);
    // Kolo miešania sa zmrazí hneď na začiatku pauzy — semienka hráčov prídu skôr, ako pauza skončí.
    this.openFairRound();
    this.changed();
  }

  /** Zmrazí kolo miešania z odtlačkov pripojených hráčov, ktorí môžu dostať karty (ak kolo ešte nie je). */
  private openFairRound(): boolean {
    if (this.fair.readiness()) {
      return false;
    }
    this.fair.ensureRound(this.dealCandidates().filter((player) => player.sockets.size > 0).map((player) => player.id));
    return true;
  }

  /** Ruka sa rozdá, až keď všetci zo zoznamu poslali semienko alebo vypršal termín kola. */
  private fairReady(): boolean {
    const opened = this.openFairRound();
    const state = this.fair.readiness()!;
    if (state.ready) {
      this.clearFairTimer();
      return true;
    }
    if (!this.fairTimer) {
      this.fairTimer = setTimeout(() => {
        this.fairTimer = null;
        this.startHand();
      }, Math.max(0, state.deadline - Date.now()));
    }
    if (opened) {
      this.changed();
    }
    return false;
  }

  private clearFairTimer(): void {
    if (this.fairTimer) {
      clearTimeout(this.fairTimer);
      this.fairTimer = null;
    }
  }

  fairCommit(player: TablePlayer, commitment: unknown): Result {
    return this.fair.commit(player.id, commitment);
  }

  fairReveal(player: TablePlayer, roundId: unknown, seed: unknown): Result {
    const result = this.fair.reveal(player.id, roundId, seed);
    if (result.ok && this.fairTimer && this.fair.readiness()?.ready) {
      this.clearFairTimer();
      this.startHand();
    }
    return result;
  }

  /** Dôkazy rozdaných rúk; semienka servera až po hre (stôl v čakárni alebo FAIR_REVEAL_IDLE_MS bez novej ruky). */
  fairProofs(): FairProofsResponse {
    const last = this.fair.lastDealtAt();
    const revealed = last === null || this.phase !== 'playing' || Date.now() - last >= FAIR_REVEAL_IDLE_MS;
    return {
      proofs: this.fair.publicProofs(revealed),
      revealed,
      revealAt: revealed || last === null ? null : last + FAIR_REVEAL_IDLE_MS,
      pendingRoundId: this.fair.pendingRoundId(),
    };
  }

  private clearNextHandTimer(): void {
    if (this.nextHandTimer) {
      clearTimeout(this.nextHandTimer);
      this.nextHandTimer = null;
    }
    this.nextHandAt = null;
  }

  private startHand(): void {
    if (!this.running || this.paused || this.modeIntro || (this.engine && !this.engine.isComplete)) {
      return;
    }
    if (!this.fairReady()) {
      return;
    }
    if (this.piggy?.status === 'finished') {
      this.clearPiggyTimer();
      this.piggy = null;
    }
    this.sitOutShortStacks();
    const eligible = this.eligiblePlayers();
    const returning = this.returningPlayers();
    if (eligible.length + returning.length < 2) {
      this.changed();
      return;
    }
    const dealerPool = eligible.length ? eligible : returning;
    const forcedDealer = this.firstDealerId ? dealerPool.find((player) => player.id === this.firstDealerId) : undefined;
    const dealer = forcedDealer ?? dealerPool.find((player) => player.seat > this.lastDealerSeat) ?? dealerPool[0];
    const lineup = this.chooseLineup(eligible, returning, dealer);
    const introMode = this.pendingIntroMode();
    if (introMode) {
      this.openIntro(introMode, lineup.seats.map((seat) => seat.id));
      return;
    }
    this.firstDealerId = null;
    this.lastDealerSeat = dealer.seat;
    const modes = this.upcomingModes();
    const sevenDeuceContinues = this.settings.sevenDeuceAlways && this.dealtModes.has('seven-deuce');
    this.preHand = {
      lastSmallBlindSeat: this.lastSmallBlindSeat,
      lastBigBlindSeat: this.lastBigBlindSeat,
      dealtModes: [...this.dealtModes],
      players: new Map([...this.players.values()].map((player) => [player.id, { sittingOut: player.sittingOut, missedBlinds: player.missedBlinds, returnMode: player.returnMode }])),
    };
    this.dealtModes = new Set(modes);
    if (sevenDeuceContinues) {
      this.dealtModes.add('seven-deuce');
    }
    this.introDone.clear();
    for (const seat of lineup.seats) {
      const player = this.players.get(seat.id)!;
      if (player.sittingOut) {
        player.sittingOut = false;
        player.returnMode = null;
        player.missedBlinds = 'none';
        this.event('info', `${player.name} sa vracia do hry`, player.id);
      }
    }
    this.handNumber += 1;
    const rules = this.buildRules();
    const special = this.nextHand?.variant ? this.nextHand : null;
    const remaining = special ? (special.hands ?? 1) - 1 : 0;
    this.nextHand = special && remaining > 0 ? { variant: special.variant, hands: remaining } : null;
    if (this.specialInHand && !special) {
      this.event('mode', `Špeciálne kolo ${VARIANT_LABELS[this.specialInHand]} skončilo — znova sa hrá ${VARIANT_LABELS[this.settings.defaultVariant]}`);
    }
    this.specialInHand = special?.variant ?? null;
    this.lastResult = null;
    this.rabbit = null;
    this.clearRunVote();
    this.handAnte = this.pendingAnte;
    this.pendingAnte = [];
    const ante = this.handAnte.reduce((sum, entry) => sum + entry.amount, 0);
    this.payPiggyEntries(lineup.seats);
    const fairDeal = this.fair.deal({
      handNumber: this.handNumber,
      dealerSeat: dealer.seat,
      seats: lineup.seats.map((seat) => ({ id: seat.id, seat: seat.seat })),
      holeCount: HOLE_CARD_COUNT[rules.variant],
    });
    this.fairRoundOfHand = fairDeal.proof.roundId;
    this.engine = new HandEngine({
      handNumber: this.handNumber,
      seats: lineup.seats,
      dealerSeat: dealer.seat,
      rules,
      formatAmount: (cents) => this.money(cents),
      ante,
      deck: fairDeal.deck,
    });
    if (fairDeal.proof.excluded.length) {
      const names = fairDeal.proof.excluded.map((id) => this.memberName(id) || 'Hráč').join(', ');
      this.event('info', `Do miešania neprispeli (semienko neprišlo včas): ${names}`);
    }
    if (ante > 0) {
      this.event('info', `V pote je ante ${this.money(ante)} z odkrytia boardu`);
    }
    if (special) {
      this.event('host', `Špeciálne kolo: ${describeOverride(special)}${remaining > 0 ? ` — po tejto ruke ešte ${handsLabel(remaining)}` : ' — posledná ruka'}`);
    }
    this.engine.start();
    this.trackMissedBlinds(this.engine);
    this.afterEngineChange();
  }

  /**
   * Kto dostane karty. Bežní hráči vždy; vracajúci sa hráči podľa `returnMode` (štandardné cash-game pravidlá):
   * - `post`: hrá od najbližšej ruky — dá živý BB (počíta sa ako jeho stávka) a pri `small-and-big` aj mŕtvy SB do potu.
   *   Keď mu práve vychádza pozícia SB, počká ešte jednu ruku (z pozície SB sa doplácať nedá). Keď mu vychádza BB,
   *   dá len bežný BB.
   * - `wait-bb`: dostane karty presne v ruke, v ktorej by bol na pozícii BB (počíta sa, akoby už bol rozdaný), a dá bežný BB.
   * Keď by bez vracajúcich sa hráčov nebolo s kým hrať (menej ako 2 bežní hráči, napr. heads-up), vrátia sa všetci
   * hneď a nič nedopláca — zmeškané blindy sa im odpúšťajú.
   */
  private chooseLineup(eligible: TablePlayer[], returning: TablePlayer[], dealer: TablePlayer): { seats: HandSeat[] } {
    const toSeat = (player: TablePlayer, post?: HandSeat['post']): HandSeat => ({ id: player.id, name: player.name, seat: player.seat, stack: player.stack, ...(post ? { post } : {}) });
    if (eligible.length < 2) {
      return { seats: [...eligible, ...returning].map((player) => toSeat(player)) };
    }
    const seatsOf = (players: TablePlayer[]) => players.map((player) => player.seat);
    const clockwise = (players: TablePlayer[]) => [...players].sort((left, right) => seatDistance(dealer.seat, left.seat) - seatDistance(dealer.seat, right.seat));
    let posting = returning.filter((player) => player.returnMode === 'post');
    for (;;) {
      const { smallBlindSeat } = blindSeats(seatsOf([...eligible, ...posting]), dealer.seat);
      const blocked = posting.find((player) => player.seat === smallBlindSeat);
      if (!blocked) {
        break;
      }
      posting = posting.filter((player) => player !== blocked);
    }
    const lineup = [...eligible, ...posting];
    for (const waiting of clockwise(returning.filter((player) => player.returnMode === 'wait-bb'))) {
      if (blindSeats(seatsOf([...lineup, waiting]), dealer.seat).bigBlindSeat === waiting.seat) {
        lineup.push(waiting);
        break;
      }
    }
    const { smallBlindSeat, bigBlindSeat } = blindSeats(seatsOf(lineup), dealer.seat);
    return {
      seats: lineup
        .sort((left, right) => left.seat - right.seat)
        .map((player) => {
          const owesPost = player.sittingOut && player.returnMode === 'post' && player.seat !== bigBlindSeat && player.seat !== smallBlindSeat && lineup.length > 2;
          if (!owesPost) {
            return toSeat(player);
          }
          return toSeat(player, { live: this.settings.bigBlind, dead: player.missedBlinds === 'small-and-big' ? this.settings.smallBlind : 0 });
        }),
    };
  }

  /**
   * Zmeškané blindy: každému, kto pri stole sedí, ale nedostal karty (postavil sa, čaká na návrat, nemá žetóny),
   * sa pozrie, či mu cez miesto prešiel blind — BB prešiel, ak jeho miesto leží v oblúku (minulý BB, aktuálny BB],
   * SB podobne. Každý prejdený blind posunie dlh o stupeň: `none` → `big` → `small-and-big`
   * (zmeškaný len SB sa teda tiež splatí živým BB; typ nepozná „len SB“). Prvá ruka hry nič neeviduje.
   */
  private trackMissedBlinds(engine: HandEngine): void {
    if (this.lastBigBlindSeat >= 0) {
      for (const player of this.players.values()) {
        if (player.leaving || engine.player(player.id)) {
          continue;
        }
        const passed = Number(inSeatArc(player.seat, this.lastBigBlindSeat, engine.bigBlindSeat)) + Number(inSeatArc(player.seat, this.lastSmallBlindSeat, engine.smallBlindSeat));
        for (let step = 0; step < passed; step++) {
          player.missedBlinds = player.missedBlinds === 'none' ? 'big' : 'small-and-big';
        }
      }
    }
    this.lastSmallBlindSeat = engine.smallBlindSeat;
    this.lastBigBlindSeat = engine.bigBlindSeat;
  }

  private buildRules(): HandRules {
    const variant = this.nextHand?.variant ?? this.settings.defaultVariant;
    return {
      variant,
      structure: variant === 'omaha' && this.settings.omahaPotLimit ? 'pot-limit' : 'no-limit',
      sevenDeuce: variant !== 'omaha' && this.settings.sevenDeuceAlways,
      sevenDeuceBounty: this.settings.sevenDeuceBounty,
      smallBlind: this.settings.smallBlind,
      bigBlind: this.settings.bigBlind,
    };
  }

  private afterEngineChange(): void {
    const engine = this.engine;
    if (!engine) {
      return;
    }
    this.lastActivity = Date.now();
    for (const entry of engine.drainLog()) {
      this.engineEvent(entry);
    }
    if (engine.isComplete) {
      this.finishHand(engine);
    }
    this.armTimers();
    this.changed();
  }

  private finishHand(engine: HandEngine): void {
    this.clearTurnTimer();
    const result = engine.result!;
    this.handAnte = [];
    this.lastResult = { handNumber: engine.handNumber, ...result };
    this.recordHand(engine);
    const piggyFinished = this.settlePiggy(engine);
    for (const enginePlayer of engine.players) {
      const player = this.players.get(enginePlayer.id);
      if (!player) {
        continue;
      }
      player.stack = enginePlayer.stack + player.pendingChips;
      player.pendingChips = 0;
      if (player.leaving) {
        this.vacateSeat(player);
        continue;
      }
      if (player.stack <= 0 && !player.sittingOut) {
        player.sittingOut = true;
        player.returnMode = null;
        this.event('info', `${player.name} nemá žetóny — čaká na dobitie od bankára`, player.id);
      }
    }
    if (piggyFinished) {
      this.releasePiggyShort();
    }
    if (this.returnToLobbyPending) {
      this.enterLobby();
      return;
    }
    this.maybeScheduleNextHand(piggyFinished ? Math.max(HAND_PAUSE_MS, PIGGY_CELEBRATION_MS) : HAND_PAUSE_MS);
  }

  /** Zapíše dohranú ruku do histórie a štatistík. Karty víťaza len ak boli ukázané všetkým (nikdy zahodené karty). */
  private recordHand(engine: HandEngine): void {
    const result = engine.result!;
    const nameOf = (id: string) => this.players.get(id)?.name ?? this.records.get(id)?.name ?? engine.player(id)?.name ?? 'Hráč';
    const wonBy = new Map<string, HandHistoryWinner>();
    for (const winner of result.winners) {
      const existing = wonBy.get(winner.playerId);
      if (existing) {
        existing.amount += winner.amount;
        existing.handDescription ??= winner.handDescription;
        continue;
      }
      wonBy.set(winner.playerId, {
        playerId: winner.playerId,
        playerName: nameOf(winner.playerId),
        amount: winner.amount,
        handDescription: winner.handDescription,
        cards: [...(result.revealed[winner.playerId] ?? [])],
      });
    }
    for (const enginePlayer of engine.players) {
      const record = this.records.get(enginePlayer.id) ?? { id: enginePlayer.id, name: nameOf(enginePlayer.id), avatar: this.players.get(enginePlayer.id)?.avatar ?? { emoji: '🃏', color: '#264653' }, handsPlayed: 0, handsWon: 0, biggestPot: 0 };
      record.handsPlayed += 1;
      const won = wonBy.get(enginePlayer.id)?.amount ?? 0;
      if (won > 0) {
        record.handsWon += 1;
        record.biggestPot = Math.max(record.biggestPot, won);
      }
      this.records.set(record.id, record);
    }
    const dealer = engine.players.find((player) => player.seat === engine.dealerSeat);
    const winners = [...wonBy.values()];
    this.history.push({
      handNumber: engine.handNumber,
      at: Date.now(),
      variant: engine.rules.variant,
      sevenDeuce: engine.rules.sevenDeuce,
      dealerName: dealer ? nameOf(dealer.id) : '',
      board: [...engine.board],
      ...(engine.extraBoards.length ? { extraBoards: engine.extraBoards.map((board) => [...board]) } : {}),
      totalPot: winners.reduce((sum, winner) => sum + winner.amount, 0),
      wonWithoutShowdown: result.wonWithoutShowdown,
      winners,
      bounty: result.bounty ? { winnerName: nameOf(result.bounty.winnerId), total: result.bounty.total } : null,
    });
    if (this.history.length > MAX_HISTORY_HANDS) {
      this.history.splice(0, this.history.length - MAX_HISTORY_HANDS);
    }
  }

  /** Hra skončila skôr, než sa ante z odkrytia boardu dostalo do ruky — vráti sa tým, čo ho zaplatili. */
  private refundAnte(): void {
    const entries = [...this.handAnte, ...this.pendingAnte];
    this.handAnte = [];
    this.pendingAnte = [];
    for (const entry of entries) {
      const member = this.member(entry.playerId);
      if (!member) {
        continue;
      }
      member.stack += entry.amount;
      if (this.players.get(member.id) === member && member.sittingOut && member.returnMode === null && member.stack > this.minStack()) {
        member.sittingOut = false;
      }
      this.event('info', `${member.name} dostáva späť ${this.money(entry.amount)} za odkrytie boardu (hra skončila)`, member.id);
    }
  }

  private enterLobby(): void {
    this.clearNextHandTimer();
    this.clearTurnTimer();
    this.phase = 'lobby';
    this.running = false;
    this.paused = false;
    this.returnToLobbyPending = false;
    this.engine = null;
    this.rabbit = null;
    this.clearRunVote();
    this.refundAnte();
    this.firstDealerId = null;
    this.preHand = null;
    this.lastSmallBlindSeat = -1;
    this.lastBigBlindSeat = -1;
    this.cancelIntro();
    this.dealtModes.clear();
    for (const player of this.players.values()) {
      if (player.returnMode !== null && player.stack > 0) {
        player.sittingOut = false;
      }
      player.missedBlinds = 'none';
      player.returnMode = null;
    }
    for (const member of this.departed.values()) {
      member.missedBlinds = 'none';
    }
    this.changed();
  }

  private armTimers(): void {
    const previousDeadline = this.turnDeadline;
    this.settleTurnClock();
    this.clearTurnTimer();
    const engine = this.engine;
    if (!engine || engine.isComplete) {
      return;
    }
    if (engine.awaitingRunout) {
      if (this.runoutAnnounced !== engine.handNumber) {
        this.runoutAnnounced = engine.handNumber;
        const tabled = engine.players.filter((player) => player.status !== 'folded').map((player) => `${player.name} ${player.hole.map(prettyCard).join(' ')}`);
        this.event('info', `All-in — karty na stôl: ${tabled.join(', ')}`);
        this.openRunVote(engine);
      }
      if (this.runVote) {
        return;
      }
      if (!this.runoutTimer) {
        this.runoutTimer = setTimeout(() => {
          this.runoutTimer = null;
          engine.runoutStep();
          this.afterEngineChange();
        }, RUNOUT_STEP_MS);
      }
      return;
    }
    if (engine.street === 'discard') {
      this.discardDeadline ??= Date.now() + DISCARD_TIMEOUT_SEC * 1000;
      const onBreak = engine.pendingDiscards().filter((pending) => this.players.get(pending.id)?.away);
      if (onBreak.length) {
        this.turnTimer = setTimeout(() => {
          this.turnTimer = null;
          if (this.engine !== engine) {
            return;
          }
          for (const pending of onBreak) {
            if (engine.street === 'discard') {
              engine.discard(pending.id, pending.hole.length - 1);
            }
          }
          this.afterEngineChange();
        }, AWAY_ACT_DELAY_MS);
        return;
      }
      const everyoneAway = engine.pendingDiscards().every((pending) => {
        const player = this.players.get(pending.id);
        return !player || player.sockets.size === 0 || player.sittingOut;
      });
      const delay = everyoneAway ? SITTING_OUT_TIMEOUT_MS : Math.max(0, this.discardDeadline - Date.now());
      this.turnTimer = setTimeout(() => {
        this.turnTimer = null;
        engine.autoDiscardRemaining();
        this.afterEngineChange();
      }, delay);
      return;
    }
    this.discardDeadline = null;
    const actor = engine.toAct;
    if (!actor) {
      return;
    }
    const player = this.players.get(actor.id);
    const onBreak = !!player && player.away && !player.leaving;
    if (player && !onBreak && !player.sittingOut && !player.leaving && this.settings.actionTimeoutSec > 0) {
      this.armTurnClock(engine, player);
      return;
    }
    let delay: number | null = this.settings.actionTimeoutSec > 0 ? this.settings.actionTimeoutSec * 1000 : null;
    if (onBreak) {
      delay = AWAY_ACT_DELAY_MS;
    } else if (!player || player.sittingOut || player.leaving) {
      delay = SITTING_OUT_TIMEOUT_MS;
    } else if (player.sockets.size === 0) {
      delay = Math.min(delay ?? DISCONNECTED_TIMEOUT_MS, DISCONNECTED_TIMEOUT_MS);
    }
    if (delay === null) {
      this.turnDeadline = null;
      return;
    }
    const actorId = actor.id;
    const handNumber = engine.handNumber;
    const owner = `${handNumber}:${actorId}:${engine.street}:${engine.currentBet}`;
    const sameTurn = previousDeadline !== null && previousDeadline > Date.now() && this.turnOwner === owner;
    this.turnDeadline = sameTurn ? Math.min(previousDeadline, Date.now() + delay) : Date.now() + delay;
    this.turnOwner = owner;
    this.turnTimer = setTimeout(() => {
      this.turnTimer = null;
      if (this.engine !== engine || engine.toAct?.id !== actorId) {
        return;
      }
      if (!onBreak) {
        const name = this.players.get(actorId)?.name ?? 'Hráč';
        this.event('info', `${name}: čas na ťah vypršal — automatický ťah`, actorId);
      }
      engine.autoAct();
      this.afterEngineChange();
    }, Math.max(0, this.turnDeadline - Date.now()));
  }

  private turnOwnerOf(engine: HandEngine | null): string | null {
    if (!engine || engine.isComplete || engine.awaitingRunout || engine.street === 'discard' || !engine.toAct) {
      return null;
    }
    return `${engine.handNumber}:${engine.toAct.id}:${engine.street}:${engine.currentBet}`;
  }

  /**
   * Bežný ťah: základný čas (`actionTimeoutSec`), po ňom beží timebank hráča. Odpojenému sa celkový čas skráti
   * najviac na DISCONNECTED_TIMEOUT_MS od odpojenia. Po vypršaní celého času automatický ťah.
   */
  private armTurnClock(engine: HandEngine, player: TablePlayer): void {
    const now = Date.now();
    const owner = this.turnOwnerOf(engine)!;
    let clock = this.turnClock;
    if (!clock || clock.owner !== owner) {
      clock = { owner, playerId: player.id, startedAt: now, baseMs: this.settings.actionTimeoutSec * 1000, bankMs: player.timeBankMs, capAt: null };
      this.turnClock = clock;
    }
    if (player.sockets.size === 0) {
      clock.capAt ??= now + DISCONNECTED_TIMEOUT_MS;
    }
    const baseDeadline = clock.startedAt + clock.baseMs;
    const fullDeadline = baseDeadline + clock.bankMs;
    this.turnDeadline = clock.capAt === null ? fullDeadline : Math.min(fullDeadline, clock.capAt);
    this.turnBaseDeadline = Math.min(baseDeadline, this.turnDeadline);
    this.turnOwner = owner;
    const actorId = player.id;
    this.turnTimer = setTimeout(() => {
      this.turnTimer = null;
      if (this.engine !== engine || engine.toAct?.id !== actorId) {
        return;
      }
      const name = this.players.get(actorId)?.name ?? 'Hráč';
      this.event('info', `${name}: čas na ťah vypršal — automatický ťah`, actorId);
      engine.autoAct();
      this.afterEngineChange();
    }, Math.max(0, this.turnDeadline - now));
  }

  /**
   * Keď sa ťah s časovým limitom skončil (hráč konal, vypršal čas, ruka skončila), prepočíta timebank: ušetrený základný čas
   * × TIME_BANK_SAVED_RATIO sa pripočíta (zaokrúhlené nadol na ms), čas minutý po základe sa odpočíta; výsledok sa orezá na
   * TIME_BANK_MIN_SEC…TIME_BANK_MAX_SEC — po vypršaní celého času teda ostane minimum. Hráčovi na pauze ani odchádzajúcemu sa nemení.
   */
  private settleTurnClock(): void {
    const clock = this.turnClock;
    if (!clock || clock.owner === this.turnOwnerOf(this.engine)) {
      return;
    }
    this.turnClock = null;
    const player = this.players.get(clock.playerId);
    if (!player || player.away || player.leaving) {
      return;
    }
    const elapsed = Date.now() - clock.startedAt;
    const next = elapsed <= clock.baseMs
      ? clock.bankMs + Math.floor((clock.baseMs - elapsed) * TIME_BANK_SAVED_RATIO)
      : clock.bankMs - (elapsed - clock.baseMs);
    player.timeBankMs = clampTimeBank(next);
  }

  private clearTurnTimer(): void {
    if (this.turnTimer) {
      clearTimeout(this.turnTimer);
      this.turnTimer = null;
    }
    this.turnDeadline = null;
    this.turnBaseDeadline = null;
  }

  private engineEvent(entry: EngineLog): void {
    this.event(entry.kind, entry.text, entry.playerId);
  }

  private event(kind: TableEvent['kind'], text: string, playerId?: string): void {
    const event: TableEvent = { id: ++this.eventId, at: Date.now(), kind, text, playerId };
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) {
      this.events.splice(0, this.events.length - MAX_EVENTS);
    }
    this.hooks.onEvent(this, event);
  }

  private changed(): void {
    this.lastActivity = Date.now();
    this.hooks.onChange(this);
  }

  toSnapshot(): TableSnapshot {
    const engine = this.engine && !this.engine.isComplete ? this.engine : null;
    const piggy = this.piggy?.status === 'running' ? this.piggy : null;
    const voidedEntries = engine && piggy?.handEntries?.handNumber === engine.handNumber ? piggy.handEntries.entries : {};
    const contributed = { ...(piggy?.contributed ?? {}) };
    for (const [id, amount] of Object.entries(voidedEntries)) {
      contributed[id] = (contributed[id] ?? 0) - amount;
      if (contributed[id] <= 0) {
        delete contributed[id];
      }
    }
    return {
      version: SNAPSHOT_VERSION,
      code: this.code,
      createdAt: this.createdAt,
      lastActivity: this.lastActivity,
      settings: { ...this.settings },
      hostId: this.hostId,
      adminIds: [...this.adminIds],
      bankerId: this.bankerId,
      nextHand: this.nextHand,
      phase: this.phase,
      running: this.running,
      paused: this.paused,
      returnToLobbyPending: this.returnToLobbyPending,
      handInProgress: !!engine,
      players: [...this.players.values()].map((player) => {
        const before = engine ? this.preHand?.players.get(player.id) : undefined;
        const dealtReturner = !!before && before.sittingOut && !!engine?.player(player.id) && !player.leaving;
        return {
          id: player.id,
          token: player.token,
          name: player.name,
          avatar: player.avatar,
          seat: player.seat,
          stack: player.stack + (voidedEntries[player.id] ?? 0),
          pendingChips: player.pendingChips,
          sittingOut: dealtReturner || player.sittingOut,
          away: player.away,
          missedBlinds: before ? before.missedBlinds : player.missedBlinds,
          returnMode: dealtReturner ? before.returnMode : player.returnMode,
          timeBankMs: player.timeBankMs,
          leaving: player.leaving,
          departure: player.departure,
        };
      }),
      records: [...this.records.values()].map((record) => ({ ...record })),
      ledger: this.ledger,
      events: this.events,
      history: this.history,
      handNumber: engine ? engine.handNumber - 1 : this.handNumber,
      lastDealerSeat: engine ? engine.dealerSeat - 1 : this.lastDealerSeat,
      lastSmallBlindSeat: engine && this.preHand ? this.preHand.lastSmallBlindSeat : this.lastSmallBlindSeat,
      lastBigBlindSeat: engine && this.preHand ? this.preHand.lastBigBlindSeat : this.lastBigBlindSeat,
      firstDealerId: this.firstDealerId,
      eventId: this.eventId,
      ledgerId: this.ledgerId,
      piggy: piggy
        ? {
            amount: piggy.amount - Object.values(voidedEntries).reduce((sum, amount) => sum + amount, 0),
            entry: piggy.entry,
            target: piggy.target,
            wins: { ...piggy.wins },
            contributed,
            startedAtHand: piggy.startedAtHand,
          }
        : null,
      dealtModes: engine && this.preHand ? [...this.preHand.dealtModes] : [...this.dealtModes],
      pendingAnte: [...(engine ? this.handAnte : []), ...this.pendingAnte].map((entry) => ({ ...entry })),
      departed: [...this.departed.values()].map((member) => ({
        id: member.id,
        token: member.token,
        name: member.name,
        avatar: member.avatar,
        seat: member.seat,
        stack: member.stack,
        pendingChips: member.pendingChips,
        sittingOut: true,
        away: false,
        missedBlinds: member.missedBlinds,
        returnMode: null,
        timeBankMs: member.timeBankMs,
        leaving: false,
        departure: null,
      })),
      fair: this.fair.toPersisted(),
    };
  }

  /**
   * Obnoví stôl po reštarte servera. Všetci sú odpojení; rozohraná ruka sa ruší (hráči majú stack spred nej
   * + čakajúce žetóny), losovanie o button sa ruší (návrat do čakárne), bežiaca hra je pozastavená.
   */
  static fromSnapshot(snapshot: TableSnapshot, hooks: TableHooks, options: TableOptions = {}): Table {
    // Základný čas na ťah je pevný — aj staršie uložené stoly (napr. so 60 s) dostanú aktuálnu hodnotu.
    const { startingStack: _legacyStartingStack, ...savedSettings } = snapshot.settings as TableSettings & { startingStack?: number };
    const table = new Table(snapshot.code, { ...DEFAULT_SETTINGS, ...savedSettings, actionTimeoutSec: DEFAULT_SETTINGS.actionTimeoutSec }, hooks, options);
    table.createdAt = snapshot.createdAt;
    table.lastActivity = snapshot.lastActivity;
    table.hostId = snapshot.hostId;
    const savedHands = snapshot.nextHand?.hands;
    const hands = typeof savedHands === 'number' && Number.isInteger(savedHands) && savedHands >= 1 && savedHands <= MAX_SPECIAL_HANDS ? savedHands : 1;
    table.nextHand = snapshot.nextHand?.variant && isVariant(snapshot.nextHand.variant) ? { variant: snapshot.nextHand.variant, hands } : null;
    table.handNumber = snapshot.handNumber;
    table.lastDealerSeat = snapshot.lastDealerSeat;
    table.lastSmallBlindSeat = snapshot.lastSmallBlindSeat ?? -1;
    table.lastBigBlindSeat = snapshot.lastBigBlindSeat ?? -1;
    table.firstDealerId = snapshot.handInProgress ? null : snapshot.firstDealerId;
    table.eventId = snapshot.eventId;
    table.ledgerId = snapshot.ledgerId;
    table.ledger.push(...snapshot.ledger);
    table.events.push(...snapshot.events);
    table.history.push(...snapshot.history);
    table.fair.restore(snapshot.fair);
    for (const record of snapshot.records) {
      table.records.set(record.id, { ...record });
    }
    const savedPiggy = snapshot.piggy;
    if (savedPiggy && Number.isInteger(savedPiggy.amount) && Number.isInteger(savedPiggy.entry) && savedPiggy.entry > 0) {
      table.piggy = {
        status: 'running',
        amount: savedPiggy.amount,
        entry: savedPiggy.entry,
        target: savedPiggy.target > 0 ? savedPiggy.target : PIGGY_TARGET_WINS,
        wins: { ...(savedPiggy.wins ?? {}) },
        contributed: { ...(savedPiggy.contributed ?? {}) },
        startedAtHand: savedPiggy.startedAtHand,
        winners: [],
        handEntries: null,
      };
    }
    table.dealtModes = new Set((snapshot.dealtModes ?? []).filter((mode) => GAME_MODES.includes(mode)));
    table.pendingAnte = (snapshot.pendingAnte ?? [])
      .filter((entry) => typeof entry?.playerId === 'string' && Number.isInteger(entry.amount) && entry.amount > 0)
      .map((entry) => ({ playerId: entry.playerId, amount: entry.amount }));
    const departing: TablePlayer[] = [];
    for (const saved of snapshot.players) {
      const player: TablePlayer = {
        ...saved,
        stack: saved.stack + saved.pendingChips,
        pendingChips: 0,
        sittingOut: saved.sittingOut,
        away: saved.away ?? false,
        missedBlinds: saved.missedBlinds ?? 'none',
        returnMode: saved.returnMode ?? null,
        timeBankMs: clampTimeBank(typeof saved.timeBankMs === 'number' && Number.isFinite(saved.timeBankMs) ? saved.timeBankMs : table.settings.timeBankSec * 1000),
        sockets: new Set(),
        camera: false,
        microphone: false,
      };
      if (player.stack <= 0) {
        player.sittingOut = true;
        player.returnMode = null;
      }
      if (!player.sittingOut || player.missedBlinds === 'none') {
        player.returnMode = null;
      }
      if (player.sittingOut && player.returnMode !== null && player.missedBlinds === 'none') {
        player.sittingOut = false;
      }
      table.players.set(player.id, player);
      if (player.leaving) {
        departing.push(player);
      }
    }
    for (const player of departing) {
      table.vacateSeat(player);
    }
    for (const saved of snapshot.departed ?? []) {
      if (table.players.has(saved.id) || table.departed.has(saved.id)) {
        continue;
      }
      table.departed.set(saved.id, {
        ...saved,
        stack: saved.stack + saved.pendingChips,
        pendingChips: 0,
        sittingOut: true,
        away: false,
        missedBlinds: saved.missedBlinds ?? 'none',
        returnMode: null,
        timeBankMs: clampTimeBank(typeof saved.timeBankMs === 'number' && Number.isFinite(saved.timeBankMs) ? saved.timeBankMs : table.settings.timeBankSec * 1000),
        leaving: false,
        departure: null,
        sockets: new Set(),
        camera: false,
        microphone: false,
      });
    }
    for (const id of snapshot.adminIds) {
      if (table.players.has(id)) {
        table.adminIds.add(id);
      }
    }
    if (!table.member(table.hostId)) {
      table.hostId = [...table.adminIds][0] ?? [...table.players.keys()][0] ?? '';
    }
    if (table.players.has(table.hostId)) {
      table.adminIds.add(table.hostId);
    }
    table.bankerId = snapshot.bankerId && table.member(snapshot.bankerId) ? snapshot.bankerId : table.hostId;
    table.ensureSeatedAdmin();
    table.ensureSeatedBanker();
    const piggyEntry = table.minStack();
    for (const player of table.players.values()) {
      if (player.sittingOut && player.returnMode === null && player.stack > 0 && player.stack <= piggyEntry) {
        table.piggyShort.add(player.id);
      }
    }
    if (snapshot.phase === 'playing' && !snapshot.returnToLobbyPending) {
      table.phase = 'playing';
      table.running = true;
      table.paused = true;
    }
    if (snapshot.handInProgress) {
      table.event('info', 'Server sa reštartoval — rozohraná ruka bola zrušená a žetóny vrátené');
    }
    if (snapshot.phase === 'draw') {
      table.event('info', 'Server sa reštartoval — losovanie o dealer button sa zrušilo, stôl je späť v čakárni');
    } else if (table.phase === 'playing') {
      table.event('info', 'Server sa reštartoval — hra je pozastavená, host ju obnoví tlačidlom Spustiť');
    }
    return table;
  }
}

function currentHandDescription(engine: HandEngine, hole: Card[]): string | null {
  try {
    if (engine.rules.variant === 'omaha') {
      return hole.length >= 2 ? evaluateOmaha(hole, engine.board).description : null;
    }
    return hole.length + engine.board.length >= 5 ? evaluateHoldem(hole.slice(0, hole.length), engine.board).description : null;
  } catch {
    return null;
  }
}

/** Vyhodený hostom (aj staršie uložené súbory) — na rozdiel od dobrovoľného odchodu ide o cash-out a token neplatí. */
function isKicked(player: TablePlayer): boolean {
  return player.departure?.note === KICK_NOTE;
}

/** Timebank je vždy celé ms v rozsahu TIME_BANK_MIN_SEC…TIME_BANK_MAX_SEC. */
function clampTimeBank(ms: number): number {
  return Math.round(Math.min(TIME_BANK_MAX_SEC * 1000, Math.max(TIME_BANK_MIN_SEC * 1000, ms)));
}

function prettyCard(card: Card): string {
  const rank = card[0] === 'T' ? '10' : card[0];
  return `${rank}${SUIT_SYMBOLS[suitOf(card)]}`;
}

function compareDrawCards(left: Card, right: Card): number {
  const byRank = rankValue(left) - rankValue(right);
  if (byRank !== 0) {
    return byRank;
  }
  return DRAW_SUIT_ORDER.indexOf(suitOf(right)) - DRAW_SUIT_ORDER.indexOf(suitOf(left));
}

function isVariant(value: unknown): value is Variant {
  return value === 'holdem' || value === 'omaha' || value === 'pineapple';
}

function describeOverride(override: NextHandOverride): string {
  return override.variant ? VARIANT_LABELS[override.variant] : '';
}

/** Vzdialenosť miesta `seat` od `from` v smere hry (0 = to isté miesto). */
function seatDistance(from: number, seat: number): number {
  return (seat - from + MAX_SEATS) % MAX_SEATS;
}

/** Leží `seat` v oblúku (from, to] v smere hry? Pri `from === to` (blind sa nepohol) je oblúk prázdny. */
function inSeatArc(seat: number, from: number, to: number): boolean {
  if (from < 0) {
    return false;
  }
  const distance = seatDistance(from, seat);
  return distance > 0 && distance <= seatDistance(from, to);
}

function describeSettingsChange(previous: TableSettings, next: TableSettings): string {
  const money = (cents: number) => formatMoney(cents, next.currency);
  const parts: string[] = [];
  if (previous.name !== next.name) {
    parts.push(`názov stola „${next.name}“`);
  }
  if (previous.currency !== next.currency) {
    parts.push(`mena ${CURRENCY_LABELS[next.currency]}`);
  }
  if (previous.smallBlind !== next.smallBlind || previous.bigBlind !== next.bigBlind) {
    parts.push(`blindy ${money(next.smallBlind)}/${money(next.bigBlind)}`);
  }
  if (previous.defaultVariant !== next.defaultVariant) {
    parts.push(`variant ${VARIANT_LABELS[next.defaultVariant]}`);
  }
  if (previous.sevenDeuceBounty !== next.sevenDeuceBounty) {
    parts.push(`7-2 bonus ${money(next.sevenDeuceBounty)}`);
  }
  if (previous.actionTimeoutSec !== next.actionTimeoutSec) {
    parts.push(next.actionTimeoutSec ? `limit na ťah ${next.actionTimeoutSec} s` : 'bez limitu na ťah');
  }
  if (previous.timeBankSec !== next.timeBankSec) {
    parts.push(`timebank pre nových hráčov ${next.timeBankSec} s`);
  }
  if (previous.omahaPotLimit !== next.omahaPotLimit) {
    parts.push(next.omahaPotLimit ? 'Omaha pot-limit' : 'Omaha no-limit');
  }
  return parts.join(', ');
}
