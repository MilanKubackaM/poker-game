import type { Avatar, Currency, HandHistoryEntry, JoinResult, LeaderboardRow, LedgerEntry, MyHandRecord, PendingJoin, TableSummary } from './types';
import type { Cashout } from './settlement';

/**
 * Používateľské účty (v1.2.0): registrácia e-mailom, povinné overenie e-mailu, prihlásenie e-mailom alebo hráčskym menom.
 * Hráčske meno je jedno pre všetky stoly a je jedinečné bez ohľadu na veľké/malé písmená.
 */

export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 20;
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;
export const EMAIL_MAX_LENGTH = 254;
/** Profilová fotka: klient ju zmenší na štvorec PHOTO_SIZE_PX a server prijme najviac PHOTO_MAX_BYTES (WebP alebo JPEG). */
export const PHOTO_SIZE_PX = 256;
export const PHOTO_MAX_BYTES = 150_000;
export const PHOTO_MIME_TYPES = ['image/webp', 'image/jpeg'] as const;
export type PhotoMimeType = (typeof PHOTO_MIME_TYPES)[number];

/** Platnosť odkazov z e-mailu a prihlásenia. */
export const VERIFY_TOKEN_TTL_MS = 48 * 60 * 60 * 1000;
export const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;
export const SESSION_TTL_MS = 180 * 24 * 60 * 60 * 1000;

/** Písmená (aj s diakritikou), číslice, medzera, podčiarkovník, pomlčka, bodka — bez @, aby sa nepomýlilo s e-mailom. */
const USERNAME_PATTERN = /^[\p{L}\p{N}_.\- ]+$/u;
/** Zámerne prísny tvar (žiadne medzery, úvodzovky, lomené zátvorky ani riadiace znaky) — adresa ide aj do SMTP obálky. */
const EMAIL_PATTERN = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

/** Meno tak, ako sa uloží: NFC, zlúčené medzery, orezané. */
export function cleanUsername(value: string): string {
  return value.normalize('NFC').replace(/\s+/g, ' ').trim();
}

/** Kľúč jedinečnosti mena (bez ohľadu na veľkosť písmen). */
export function usernameKey(value: string): string {
  return cleanUsername(value).toLocaleLowerCase('sk');
}

export function cleanEmail(value: string): string {
  return value.trim().toLowerCase();
}

/** Chyba hráčskeho mena pre používateľa, alebo null. Volá klient aj server. */
export function validateUsername(value: string): string | null {
  const name = cleanUsername(value);
  if (name.length < USERNAME_MIN_LENGTH) {
    return `Hráčske meno musí mať aspoň ${USERNAME_MIN_LENGTH} znaky`;
  }
  if (name.length > USERNAME_MAX_LENGTH) {
    return `Hráčske meno môže mať najviac ${USERNAME_MAX_LENGTH} znakov`;
  }
  if (!USERNAME_PATTERN.test(name)) {
    return 'Hráčske meno môže obsahovať len písmená, číslice, medzeru a znaky _ - .';
  }
  return null;
}

export function validateEmail(value: string): string | null {
  const email = cleanEmail(value);
  if (!email) {
    return 'Zadaj e-mail';
  }
  if (email.length > EMAIL_MAX_LENGTH || !EMAIL_PATTERN.test(email)) {
    return 'Neplatný e-mail';
  }
  return null;
}

/** Heslo a jeho zopakovanie; `confirm` je povinné všade, kde sa heslo nastavuje. */
export function validatePassword(password: string, confirm: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Heslo musí mať aspoň ${PASSWORD_MIN_LENGTH} znakov`;
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return `Heslo môže mať najviac ${PASSWORD_MAX_LENGTH} znakov`;
  }
  if (password !== confirm) {
    return 'Heslá sa nezhodujú';
  }
  return null;
}

/** Môj účet tak, ako ho vidí klient. */
export interface AccountView {
  id: string;
  username: string;
  email: string;
  emailVerified: boolean;
  /** Emoji + farba (náhrada, keď nie je fotka) a `photo`, ak je nahratá. */
  avatar: Avatar;
  createdAt: number;
}

/** Odpoveď na prihlásenie / registráciu / reset hesla — token ide do localStorage a do socket.io `auth.token`. */
export interface AuthSession {
  token: string;
  account: AccountView;
}

/** Štatistika účtu pri jednom stole — priebežne sa ukladá do účtu, takže prežije zmazanie stola. */
export interface AccountTableStat {
  code: string;
  tableName: string;
  currency: Currency;
  handsPlayed: number;
  handsWon: number;
  /** Najväčší vyhraný pot (centy). */
  biggestPot: number;
  deposited: number;
  withdrawn: number;
  /** stack + withdrawn − deposited (centy) — rovnako ako leaderboard stola. */
  result: number;
  /** Posledná aktivita stola (epoch ms). */
  lastPlayed: number;
  /** Historický stôl spred účtov (len na čítanie). */
  archived: boolean;
  /** Stôl už neexistuje (zmazaný / expirovaný) — štatistika ostáva. */
  deleted: boolean;
}

/** Súčty cez všetky stoly; sumy zvlášť podľa meny (EUR a CZK sa nesčítavajú). */
export interface AccountGlobalStats {
  tables: number;
  handsPlayed: number;
  handsWon: number;
  /** handsWon / handsPlayed v percentách (0, keď nehral). */
  winRate: number;
  biggestPot: Partial<Record<Currency, number>>;
  result: Partial<Record<Currency, number>>;
}

export interface AccountStats {
  global: AccountGlobalStats;
  /** Najnovšie prvé. */
  tables: AccountTableStat[];
}

/** Historický stôl (spred účtov) v „Moje stoly → Archív“. */
export interface ArchivedTableSummary {
  code: string;
  name: string;
  currency: Currency;
  handNumber: number;
  createdAt: number;
  lastActivity: number;
  /** Môj výsledok pri stole (súčet cez moje miesta). */
  myResult: number;
  /** Stôl je prevzatý do môjho účtu (inak ho vidím len vďaka tokenu v tomto prehliadači). */
  claimed: boolean;
}

/** Miesto pri stole uložené v tomto prehliadači (z čias pred účtami) — dôkaz na prezretie / prevzatie archívu. */
export interface DeviceSeat {
  code: string;
  playerId: string;
  token: string;
}

/** `account:tables` — aktívne stoly účtu + archív (prevzatý aj ten, ku ktorému má tento prehliadač token). */
export interface AccountTablesResponse {
  active: TableSummary[];
  archived: ArchivedTableSummary[];
}

/** `archive:view` — celý historický stôl len na čítanie. */
export interface ArchivedTableView {
  code: string;
  name: string;
  currency: Currency;
  createdAt: number;
  lastActivity: number;
  handNumber: number;
  /** Moje miesta pri stole (prevzaté do účtu alebo z tokenu v tomto prehliadači). */
  myPlayerIds: string[];
  leaderboard: LeaderboardRow[];
  history: HandHistoryEntry[];
  ledger: LedgerEntry[];
  cashout: Cashout;
  /** Moje karty a výsledky v dohraných rukách (všetky moje miesta). */
  myHistory: MyHandRecord[];
}

export interface ArchiveClaimResult {
  claimed: string[];
  failed: { code: string; error: string }[];
}

/** `table:join` — už som členom (pripojím sa hneď), alebo vznikla žiadosť, ktorú musí schváliť host. */
export type TableJoinResponse = { joined: JoinResult } | { pending: PendingJoin };

/**
 * Socket udalosti (klient → server, odpoveď cez ack `Ack<T>`):
 * - `auth:register` { email, username, password, passwordConfirm } → AuthSession (účet je neoverený, odíde overovací e-mail)
 * - `auth:login` { login, password } → AuthSession (`login` = e-mail alebo hráčske meno)
 * - `auth:logout` {} → zruší aktuálne prihlásenie
 * - `auth:me` {} → AccountView
 * - `auth:verifyEmail` { token } → AccountView | undefined (funguje aj bez prihlásenia — odkaz sa môže otvoriť na inom zariadení)
 * - `auth:resendVerification` {} → odošle nový overovací e-mail
 * - `auth:changeEmail` { email, password } → AccountView (nový e-mail je neoverený, odíde overovací e-mail)
 * - `auth:forgotPassword` { login } → vždy ok (bez prezradenia, či účet existuje); e-mail ide len na overenú adresu
 * - `auth:resetPassword` { token, password, passwordConfirm } → AuthSession (zruší všetky ostatné prihlásenia)
 * - `account:changePassword` { currentPassword, password, passwordConfirm } → ok (zruší ostatné prihlásenia, toto ostane)
 * - `account:update` { username?, avatar?: { emoji, color } } → AccountView
 * - `account:deletePhoto` {} → AccountView
 * - `account:stats` {} → AccountStats
 * - `account:tables` { deviceSeats?: DeviceSeat[] } → AccountTablesResponse
 * - `archive:view` { code, deviceSeats?: DeviceSeat[] } → ArchivedTableView
 * - `archive:claim` { seats: DeviceSeat[] } → ArchiveClaimResult
 * HTTP:
 * - `POST /api/account/photo` (Authorization: Bearer <token>, Content-Type image/webp | image/jpeg, ≤ PHOTO_MAX_BYTES) → Ack<AccountView>
 * - `GET /api/photos/<userId>.<webp|jpg>` → obrázok
 * Server → klient:
 * - `account:updated` AccountView — po zmene účtu (aj z iného zariadenia) a hneď po pripojení prihláseného socketu
 * - `auth:invalid` {} — token neplatí (odhlásenie, reset hesla, expirácia) → klient sa odhlási
 */
export type AccountSocketEvent =
  | 'auth:register'
  | 'auth:login'
  | 'auth:logout'
  | 'auth:me'
  | 'auth:verifyEmail'
  | 'auth:resendVerification'
  | 'auth:changeEmail'
  | 'auth:forgotPassword'
  | 'auth:resetPassword'
  | 'account:changePassword'
  | 'account:update'
  | 'account:deletePhoto'
  | 'account:stats'
  | 'account:tables'
  | 'archive:view'
  | 'archive:claim';

/** Súčty pre profil zo štatistík jednotlivých stolov. */
export function aggregateStats(tables: AccountTableStat[]): AccountGlobalStats {
  const global: AccountGlobalStats = { tables: tables.length, handsPlayed: 0, handsWon: 0, winRate: 0, biggestPot: {}, result: {} };
  for (const table of tables) {
    global.handsPlayed += table.handsPlayed;
    global.handsWon += table.handsWon;
    global.biggestPot[table.currency] = Math.max(global.biggestPot[table.currency] ?? 0, table.biggestPot);
    global.result[table.currency] = (global.result[table.currency] ?? 0) + table.result;
  }
  global.winRate = global.handsPlayed > 0 ? Math.round((global.handsWon / global.handsPlayed) * 1000) / 10 : 0;
  return global;
}
