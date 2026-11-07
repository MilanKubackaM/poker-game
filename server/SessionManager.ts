import { randomInt } from 'node:crypto';
import path from 'node:path';
import type { TableSettings, TableSummary } from '../shared/types';
import type { AccountTableStat, AccountTablesResponse, ArchiveClaimResult, ArchivedTableSummary, ArchivedTableView, DeviceSeat } from '../shared/account';
import { MAX_SUMMARY_REQUEST, TABLE_RETENTION_DAYS } from '../shared/constants';
import { LIMITS } from './limits';
import { Table, type Result, type TableHooks, type TableOptions, type TableSnapshot } from './Table';
import { TableStore } from './TableStore';
import type { AccountDirectory, AccountProfile } from './accounts/directory';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const SAVE_DELAY_MS = 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const RETENTION_MS = TABLE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
/** Pôvodné súbory stolov spred účtov — kópia sa urobí raz, pred prvým archivovaním (`DATA_DIR/backup-v1.1.0/tables`). */
export const ARCHIVE_BACKUP_DIR = 'backup-v1.1.0';
const ARCHIVE_UNAVAILABLE = 'Archív tohto stola nie je dostupný';
const SEAT_CODE_PATTERN = /^[A-Za-z0-9]{1,16}$/;
const MAX_SEAT_ID_LENGTH = 64;
const MAX_SEAT_TOKEN_LENGTH = 128;
/** Archivovaný stôl nič nevysiela — nikto pri ňom nesedí. */
const ARCHIVE_HOOKS: TableHooks = { onChange: () => undefined, onEvent: () => undefined, onRemoved: () => undefined };

export interface SessionManagerOptions {
  /** Adresár na uloženie stolov; bez neho sú stoly len v pamäti (testy). */
  dataDir?: string | null;
  tableOptions?: TableOptions;
  /** Účty — profil hráča a štatistiky stolov v účte; bez neho (testy) sa štatistiky nikam neposielajú. */
  accounts?: AccountDirectory;
}

export interface SummaryRequestItem {
  code: string;
  playerId: string;
  token: string;
}

export class SessionManager {
  private readonly tables = new Map<string, Table>();
  /** Stoly spred účtov len na čítanie — mimo `tables`, takže ich žiadny herný príkaz nenájde; neexpirujú. */
  private readonly archive = new Map<string, Table>();
  /** Posledná odoslaná štatistika (`kód|účet` → JSON bez `lastPlayed`) — účtu sa posiela len zmena. */
  private readonly sentStats = new Map<string, string>();
  private readonly accounts: AccountDirectory | null;
  private readonly cleanupTimer: NodeJS.Timeout;
  private readonly store: TableStore | null;
  private readonly dirty = new Set<string>();
  private saveTimer: NodeJS.Timeout | null = null;
  private readonly tableHooks: TableHooks;

  constructor(hooks: TableHooks, private readonly options: SessionManagerOptions = {}) {
    this.store = options.dataDir ? new TableStore(options.dataDir) : null;
    this.accounts = options.accounts ?? null;
    this.tableHooks = {
      onChange: (table) => {
        this.markDirty(table);
        hooks.onChange(table);
      },
      onEvent: (table, event) => {
        this.markDirty(table);
        hooks.onEvent(table, event);
      },
      onRemoved: (table, player, kicked) => hooks.onRemoved(table, player, kicked),
      onJoinClosed: (table, request, outcome, player, byName) => {
        if (player) {
          this.markDirty(table);
        }
        hooks.onJoinClosed?.(table, request, outcome, player, byName);
      },
    };
    this.load();
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref();
  }

  create(settings: TableSettings): Table {
    let code = generateCode();
    while (this.tables.has(code)) {
      code = generateCode();
    }
    const table = new Table(code, settings, this.tableHooks, this.options.tableOptions);
    this.tables.set(code, table);
    this.markDirty(table);
    return table;
  }

  get(code: string): Table | undefined {
    return this.tables.get(code.toUpperCase());
  }

  /** Archivovaný stôl spred účtov (len na čítanie). */
  getArchived(code: string): Table | undefined {
    return this.archive.get(code.toUpperCase());
  }

  /**
   * Zmaže stôl z pamäte aj z disku (explicitné zmazanie zakladateľom alebo expirácia) — odchod hráčov stôl nemaže.
   * Štatistiky v účtoch ostávajú (posledný stav sa ešte zapíše), len sa označia ako zmazaný stôl.
   */
  remove(code: string): void {
    const table = this.tables.get(code);
    if (!table) {
      return;
    }
    this.recordStats(table);
    table.dispose();
    this.tables.delete(code);
    this.dirty.delete(code);
    this.store?.remove(code);
    for (const key of [...this.sentStats.keys()]) {
      if (key.startsWith(`${code}|`)) {
        this.sentStats.delete(key);
      }
    }
    try {
      this.accounts?.markTableDeleted(code);
    } catch (error) {
      console.error(`Štatistiky zmazaného stola ${code} sa nepodarilo označiť`, error);
    }
  }

  /** Počet hrateľných stolov (limit `maxTables`) — archív sa nepočíta. */
  count(): number {
    return this.tables.size;
  }

  archivedCount(): number {
    return this.archive.size;
  }

  /** Nová profilová fotka / meno / avatar účtu → pri všetkých živých stoloch, kde je účet členom. */
  applyProfile(userId: string, profile: AccountProfile): void {
    for (const table of this.tables.values()) {
      table.applyAccountProfile(userId, profile.username, profile.avatar);
    }
  }


  /**
   * „Moje stoly“: aktívne stoly účtu (aj tie, od ktorých odišiel — `left`) a archív — prevzatý do účtu aj ten, ku ktorému
   * má tento prehliadač token miesta spred účtov. Najnovšie prvé.
   */
  accountTables(userId: string, deviceSeats: unknown): AccountTablesResponse {
    const active: TableSummary[] = [];
    for (const table of this.tables.values()) {
      const member = table.memberByUser(userId);
      if (member) {
        active.push(table.summary(member.id));
      }
    }
    active.sort((left, right) => right.lastActivity - left.lastActivity);
    const seats = parseDeviceSeats(deviceSeats);
    const codes = new Set<string>();
    for (const table of this.archive.values()) {
      if (table.membersOfUser(userId).length > 0) {
        codes.add(table.code);
      }
    }
    for (const seat of seats) {
      codes.add(seat.code);
    }
    const archived: ArchivedTableSummary[] = [];
    for (const code of codes) {
      const table = this.archive.get(code);
      const mine = table ? archiveSeats(table, userId, seats) : null;
      if (!table || !mine || mine.ids.length === 0) {
        continue;
      }
      const ids = new Set(mine.ids);
      archived.push({
        code: table.code,
        name: table.settings.name,
        currency: table.settings.currency,
        handNumber: table.handsDealt(),
        createdAt: table.createdAt,
        lastActivity: table.lastActivity,
        myResult: table.leaderboard().filter((row) => ids.has(row.playerId)).reduce((sum, row) => sum + row.result, 0),
        claimed: mine.claimed,
      });
    }
    archived.sort((left, right) => right.lastActivity - left.lastActivity);
    return { active, archived };
  }

  /** Celý archivovaný stôl na prezeranie — len pre účet, ktorý ho prevzal, alebo s platným tokenom miesta z prehliadača. */
  archiveView(userId: string, code: unknown, deviceSeats: unknown): Result<ArchivedTableView> {
    const table = typeof code === 'string' ? this.getArchived(code) : undefined;
    const mine = table ? archiveSeats(table, userId, parseDeviceSeats(deviceSeats)) : null;
    if (!table || !mine || mine.ids.length === 0) {
      return { ok: false, error: ARCHIVE_UNAVAILABLE };
    }
    const myHistory = mine.ids.flatMap((id) => table.myHistory(id)).sort((left, right) => left.handNumber - right.handNumber);
    return {
      ok: true,
      data: {
        code: table.code,
        name: table.settings.name,
        currency: table.settings.currency,
        createdAt: table.createdAt,
        lastActivity: table.lastActivity,
        handNumber: table.handsDealt(),
        myPlayerIds: mine.ids,
        leaderboard: table.leaderboard(),
        history: table.history,
        ledger: table.ledger,
        cashout: table.cashout(),
        myHistory,
      },
    };
  }

  /**
   * Prevezme miesta spred účtov (dôkaz = token z prehliadača) do účtu: stôl sa uloží a jeho štatistiky pribudnú do účtu.
   * Miesto iného účtu sa prevziať nedá; to isté miesto znova je v poriadku.
   */
  claimArchive(userId: string, seats: unknown): ArchiveClaimResult {
    const claimed = new Set<string>();
    const failed: ArchiveClaimResult['failed'] = [];
    const touched = new Set<Table>();
    for (const seat of parseDeviceSeats(seats)) {
      const table = this.archive.get(seat.code);
      if (!table) {
        failed.push({ code: seat.code, error: this.tables.has(seat.code) ? 'Tento stôl nie je v archíve' : 'Stôl v archíve neexistuje' });
        continue;
      }
      const outcome = table.claimSeat(seat.playerId, seat.token, userId);
      if (!outcome.ok) {
        failed.push({ code: seat.code, error: outcome.error });
        continue;
      }
      claimed.add(table.code);
      touched.add(table);
    }
    for (const table of touched) {
      this.saveSnapshot(table);
      this.recordStats(table);
    }
    return { claimed: [...claimed], failed };
  }

  /**
   * Prehľad stolov pre „Moje stoly“ — aj pre členov, ktorí od stola odišli (ich stack ostáva uložený);
   * `missing` = stoly, ktoré už neexistujú (zmazané, expirované) alebo token neplatí (vyhodený hráč).
   */
  summaries(items: unknown): { summaries: TableSummary[]; missing: string[] } {
    const summaries: TableSummary[] = [];
    const missing: string[] = [];
    if (!Array.isArray(items)) {
      return { summaries, missing };
    }
    for (const item of items.slice(0, MAX_SUMMARY_REQUEST) as Partial<SummaryRequestItem>[]) {
      if (!item || typeof item.code !== 'string') {
        continue;
      }
      const table = this.get(item.code);
      if (!table || typeof item.playerId !== 'string' || !table.hasMembership(item.playerId, item.token)) {
        missing.push(item.code);
        continue;
      }
      summaries.push(table.summary(item.playerId));
    }
    return { summaries, missing };
  }

  /** Okamžite zapíše všetky zmenené stoly (pri vypínaní servera) a ich štatistiky do účtov. */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    for (const code of [...this.dirty]) {
      this.dirty.delete(code);
      const table = this.tables.get(code);
      if (!table) {
        continue;
      }
      this.saveSnapshot(table);
      this.recordStats(table);
    }
  }

  private saveSnapshot(table: Table): void {
    if (!this.store) {
      return;
    }
    try {
      this.store.save(table.toSnapshot());
    } catch (error) {
      console.error(`Stôl ${table.code} sa nepodarilo uložiť`, error);
    }
  }

  /**
   * Štatistika každého účtu pri stole → účet. Súčet cez všetky riadky leaderboardu účtu (prevzatý archív môže mať
   * niekoľko miest toho istého človeka; vyhodený hráč má účet aspoň v zázname štatistík). Posiela sa len zmena.
   */
  private recordStats(table: Table): void {
    const accounts = this.accounts;
    if (!accounts) {
      return;
    }
    const owners = new Map<string, string>();
    for (const member of [...table.players.values(), ...table.departed.values()]) {
      if (member.userId) {
        owners.set(member.id, member.userId);
      }
    }
    for (const record of table.records.values()) {
      if (record.userId && !owners.has(record.id)) {
        owners.set(record.id, record.userId);
      }
    }
    if (owners.size === 0) {
      return;
    }
    const stats = new Map<string, AccountTableStat>();
    for (const row of table.leaderboard()) {
      const userId = owners.get(row.playerId);
      if (!userId) {
        continue;
      }
      const stat = stats.get(userId) ?? {
        code: table.code,
        tableName: table.settings.name,
        currency: table.settings.currency,
        handsPlayed: 0,
        handsWon: 0,
        biggestPot: 0,
        deposited: 0,
        withdrawn: 0,
        result: 0,
        lastPlayed: table.lastActivity,
        archived: table.archived,
        deleted: false,
      };
      stat.handsPlayed += row.handsPlayed;
      stat.handsWon += row.handsWon;
      stat.biggestPot = Math.max(stat.biggestPot, row.biggestPot);
      stat.deposited += row.deposited;
      stat.withdrawn += row.withdrawn;
      stat.result += row.result;
      stats.set(userId, stat);
    }
    for (const [userId, stat] of stats) {
      const key = `${table.code}|${userId}`;
      // `lastPlayed` sa mení pri každom pripojení — sám o sebe zápis do účtu nespustí.
      const { lastPlayed: _lastPlayed, ...comparable } = stat;
      const json = JSON.stringify(comparable);
      if (this.sentStats.get(key) === json) {
        continue;
      }
      try {
        accounts.recordTableStat(userId, stat);
        this.sentStats.set(key, json);
      } catch (error) {
        console.error(`Štatistiku stola ${table.code} sa nepodarilo zapísať do účtu`, error);
      }
    }
  }

  dispose(): void {
    clearInterval(this.cleanupTimer);
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    for (const table of [...this.tables.values(), ...this.archive.values()]) {
      table.dispose();
    }
  }

  /** Zmaže (z pamäte aj z disku) stoly bez aktivity dlhšie ako TABLE_RETENTION_DAYS; nepoužité (bez hry a hostí) už po dni. */
  cleanup(now = Date.now()): void {
    for (const [code, table] of this.tables) {
      const idle = now - table.lastActivity;
      if (idle > RETENTION_MS || (table.isUnused() && idle > LIMITS.unusedTableRetentionMs)) {
        this.remove(code);
      }
    }
  }

  private load(): void {
    if (!this.store) {
      return;
    }
    const now = Date.now();
    const snapshots = this.store.loadAll();
    if (snapshots.some((snapshot) => isArchivedSnapshot(snapshot) && snapshot.archived !== true)) {
      this.backupBeforeArchiving();
    }
    for (const snapshot of snapshots) {
      if (isArchivedSnapshot(snapshot)) {
        // Stôl spred účtov: len na čítanie, neexpiruje, súbor sa nemení (uloží sa až po prevzatí miesta do účtu).
        try {
          this.archive.set(snapshot.code, Table.fromSnapshot(snapshot, ARCHIVE_HOOKS, this.options.tableOptions, true));
        } catch (error) {
          console.warn(`Stôl ${snapshot.code} sa nepodarilo načítať do archívu`, error);
        }
        continue;
      }
      if (now - snapshot.lastActivity > RETENTION_MS) {
        this.store.remove(snapshot.code);
        continue;
      }
      try {
        const table = Table.fromSnapshot(snapshot, this.tableHooks, this.options.tableOptions);
        this.tables.set(table.code, table);
        this.markDirty(table);
      } catch (error) {
        console.warn(`Stôl ${snapshot.code} sa nepodarilo obnoviť`, error);
      }
    }
    this.flush();
  }

  private backupBeforeArchiving(): void {
    const target = path.join(this.options.dataDir!, ARCHIVE_BACKUP_DIR, 'tables');
    try {
      if (this.store!.backup(target)) {
        console.log(`Stoly spred účtov sú zálohované v ${target}`);
      }
    } catch (error) {
      console.error(`Zálohu stolov do ${target} sa nepodarilo vytvoriť`, error);
    }
  }

  private markDirty(table: Table): void {
    if ((!this.store && !this.accounts) || this.tables.get(table.code) !== table) {
      return;
    }
    this.dirty.add(table.code);
    if (!this.saveTimer) {
      this.saveTimer = setTimeout(() => {
        this.saveTimer = null;
        this.flush();
      }, SAVE_DELAY_MS);
      this.saveTimer.unref();
    }
  }
}

/** Súbor bez `accounts: true` je stôl spred účtov (v1.1.0); prevzatý archív sa ukladá s `archived: true`. */
function isArchivedSnapshot(snapshot: TableSnapshot): boolean {
  return snapshot.accounts !== true || snapshot.archived === true;
}

/** Miesta spred účtov z prehliadača — prísna kontrola tvaru, najviac MAX_SUMMARY_REQUEST, kód veľkými písmenami. */
export function parseDeviceSeats(value: unknown): DeviceSeat[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seats: DeviceSeat[] = [];
  for (const item of value.slice(0, MAX_SUMMARY_REQUEST) as unknown[]) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const { code, playerId, token } = item as Record<string, unknown>;
    if (typeof code !== 'string' || !SEAT_CODE_PATTERN.test(code)) {
      continue;
    }
    if (typeof playerId !== 'string' || !playerId || playerId.length > MAX_SEAT_ID_LENGTH) {
      continue;
    }
    if (typeof token !== 'string' || !token || token.length > MAX_SEAT_TOKEN_LENGTH) {
      continue;
    }
    seats.push({ code: code.toUpperCase(), playerId, token });
  }
  return seats;
}

/**
 * Moje miesta pri archivovanom stole: prevzaté do účtu + dokázané tokenom z prehliadača (ak ich neprevzal iný účet).
 * `claimed` = aspoň jedno miesto už patrí účtu.
 */
function archiveSeats(table: Table, userId: string, seats: DeviceSeat[]): { ids: string[]; claimed: boolean } {
  const owned = table.membersOfUser(userId).map((member) => member.id);
  const ids = new Set(owned);
  for (const seat of seats) {
    if (seat.code !== table.code || !table.hasMembership(seat.playerId, seat.token)) {
      continue;
    }
    const owner = table.member(seat.playerId)?.userId ?? null;
    if (owner === null || owner === userId) {
      ids.add(seat.playerId);
    }
  }
  return { ids: [...ids], claimed: owned.length > 0 };
}

function generateCode(): string {
  return Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
}
