import { randomInt } from 'node:crypto';
import type { TableSettings, TableSummary } from '../shared/types';
import { MAX_SUMMARY_REQUEST, TABLE_RETENTION_DAYS } from '../shared/constants';
import { LIMITS } from './limits';
import { Table, type TableHooks, type TableOptions } from './Table';
import { TableStore } from './TableStore';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const SAVE_DELAY_MS = 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const RETENTION_MS = TABLE_RETENTION_DAYS * 24 * 60 * 60 * 1000;

export interface SessionManagerOptions {
  /** Adresár na uloženie stolov; bez neho sú stoly len v pamäti (testy). */
  dataDir?: string | null;
  tableOptions?: TableOptions;
}

export interface SummaryRequestItem {
  code: string;
  playerId: string;
  token: string;
}

export class SessionManager {
  private readonly tables = new Map<string, Table>();
  private readonly cleanupTimer: NodeJS.Timeout;
  private readonly store: TableStore | null;
  private readonly dirty = new Set<string>();
  private saveTimer: NodeJS.Timeout | null = null;
  private readonly tableHooks: TableHooks;

  constructor(hooks: TableHooks, private readonly options: SessionManagerOptions = {}) {
    this.store = options.dataDir ? new TableStore(options.dataDir) : null;
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

  /** Zmaže stôl z pamäte aj z disku (explicitné zmazanie zakladateľom alebo expirácia) — odchod hráčov stôl nemaže. */
  remove(code: string): void {
    const table = this.tables.get(code);
    if (!table) {
      return;
    }
    table.dispose();
    this.tables.delete(code);
    this.dirty.delete(code);
    this.store?.remove(code);
  }

  count(): number {
    return this.tables.size;
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

  /** Okamžite zapíše všetky zmenené stoly (pri vypínaní servera). */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.store) {
      this.dirty.clear();
      return;
    }
    for (const code of [...this.dirty]) {
      this.dirty.delete(code);
      const table = this.tables.get(code);
      if (!table) {
        continue;
      }
      try {
        this.store.save(table.toSnapshot());
      } catch (error) {
        console.error(`Stôl ${code} sa nepodarilo uložiť`, error);
      }
    }
  }

  dispose(): void {
    clearInterval(this.cleanupTimer);
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    for (const table of this.tables.values()) {
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
    for (const snapshot of this.store.loadAll()) {
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

  private markDirty(table: Table): void {
    if (!this.store || this.tables.get(table.code) !== table) {
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

function generateCode(): string {
  return Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
}
