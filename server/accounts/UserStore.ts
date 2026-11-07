import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Avatar } from '../../shared/types';
import { cleanEmail, usernameKey, type AccountTableStat } from '../../shared/account';

export const USERS_FILE_VERSION = 1;
/** Najviac súčasných prihlásení jedného účtu — pri ďalšom sa zahodí najstaršie. */
export const MAX_SESSIONS = 20;
const SAVE_DELAY_MS = 1000;

export interface UserSession {
  /** SHA-256 (hex) tokenu — samotný token server neukladá. */
  hash: string;
  createdAt: number;
  lastSeenAt: number;
}

export interface OneTimeToken {
  kind: 'verify' | 'reset';
  hash: string;
  expiresAt: number;
  /** Pri overení: adresa, na ktorú odkaz odišiel (po zmene e-mailu starý odkaz neplatí). */
  email?: string;
}

export interface UserPhoto {
  ext: 'webp' | 'jpg';
  version: number;
}

export interface UserRecord {
  id: string;
  email: string;
  emailVerified: boolean;
  username: string;
  passwordHash: string;
  /** Emoji + farba (bez `photo` — URL fotky sa skladá z `photo`). */
  avatar: Avatar;
  photo: UserPhoto | null;
  /** Posledná použitá verzia fotky — rastie aj cez zmazanie, aby sa nová fotka nikdy netrafila do starej URL v cache. */
  photoSeq: number;
  createdAt: number;
  updatedAt: number;
  sessions: UserSession[];
  tokens: OneTimeToken[];
  stats: Record<string, AccountTableStat>;
}

interface UsersFile {
  version: number;
  users: UserRecord[];
}

interface IndexKeys {
  email: string;
  username: string;
  sessions: string[];
  tokens: string[];
}

/**
 * Úložisko účtov: jeden súbor `<dataDir>/users.json` zapisovaný atomicky (tmp + rename).
 * Bežné zmeny sa zapisujú s krátkym oneskorením, bezpečnostné (heslo, prihlásenia, e-mail) hneď cez `save(true)`.
 * Bez `dataDir` (testy) drží všetko len v pamäti.
 */
export class UserStore {
  readonly file: string | null;
  private readonly users = new Map<string, UserRecord>();
  private readonly byEmail = new Map<string, string>();
  private readonly byUsername = new Map<string, string>();
  private readonly bySession = new Map<string, string>();
  private readonly byToken = new Map<string, string>();
  private readonly indexed = new Map<string, IndexKeys>();
  private dirty = false;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(dataDir: string | null) {
    this.file = dataDir ? path.join(dataDir, 'users.json') : null;
    if (dataDir) {
      mkdirSync(dataDir, { recursive: true });
    }
    this.load();
  }

  get(id: string): UserRecord | undefined {
    return this.users.get(id);
  }

  all(): IterableIterator<UserRecord> {
    return this.users.values();
  }

  count(): number {
    return this.users.size;
  }

  byEmailAddress(email: string): UserRecord | undefined {
    return this.lookup(this.byEmail, cleanEmail(email));
  }

  byName(username: string): UserRecord | undefined {
    return this.lookup(this.byUsername, usernameKey(username));
  }

  bySessionHash(hash: string): UserRecord | undefined {
    return this.lookup(this.bySession, hash);
  }

  byTokenHash(hash: string): UserRecord | undefined {
    return this.lookup(this.byToken, hash);
  }

  /** Nový účet (volajúci overil jedinečnosť e-mailu aj mena). */
  insert(user: UserRecord): void {
    this.users.set(user.id, user);
    this.reindex(user);
    this.save(true);
  }

  /** Po zmene záznamu: obnoví indexy a naplánuje zápis (`immediate` = zapísať hneď). */
  update(user: UserRecord, immediate = false): void {
    this.reindex(user);
    this.save(immediate);
  }

  /** Okamžite zapíše zmeny (pri vypínaní servera). */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.dirty || !this.file) {
      this.dirty = false;
      return;
    }
    this.dirty = false;
    const data: UsersFile = { version: USERS_FILE_VERSION, users: [...this.users.values()] };
    const tmp = `${this.file}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(data));
      renameSync(tmp, this.file);
    } catch (error) {
      this.dirty = true;
      console.error('Účty sa nepodarilo uložiť', error);
    }
  }

  dispose(): void {
    this.flush();
  }

  private save(immediate: boolean): void {
    this.dirty = true;
    if (immediate) {
      this.flush();
      return;
    }
    if (!this.saveTimer) {
      this.saveTimer = setTimeout(() => {
        this.saveTimer = null;
        this.flush();
      }, SAVE_DELAY_MS);
      this.saveTimer.unref();
    }
  }

  private lookup(index: Map<string, string>, key: string): UserRecord | undefined {
    const id = index.get(key);
    return id === undefined ? undefined : this.users.get(id);
  }

  private reindex(user: UserRecord): void {
    const previous = this.indexed.get(user.id);
    if (previous) {
      this.unindex(user.id, previous);
    }
    const keys: IndexKeys = {
      email: cleanEmail(user.email),
      username: usernameKey(user.username),
      sessions: user.sessions.map((session) => session.hash),
      tokens: user.tokens.map((token) => token.hash),
    };
    this.byEmail.set(keys.email, user.id);
    this.byUsername.set(keys.username, user.id);
    for (const hash of keys.sessions) {
      this.bySession.set(hash, user.id);
    }
    for (const hash of keys.tokens) {
      this.byToken.set(hash, user.id);
    }
    this.indexed.set(user.id, keys);
  }

  private unindex(id: string, keys: IndexKeys): void {
    const drop = (index: Map<string, string>, key: string) => {
      if (index.get(key) === id) {
        index.delete(key);
      }
    };
    drop(this.byEmail, keys.email);
    drop(this.byUsername, keys.username);
    keys.sessions.forEach((hash) => drop(this.bySession, hash));
    keys.tokens.forEach((hash) => drop(this.byToken, hash));
  }

  /**
   * Načíta účty. Poškodený súbor server odmietne (nespustí sa) — prázdny štart by pri ďalšom zápise zmazal všetky účty.
   */
  private load(): void {
    if (!this.file || !existsSync(this.file)) {
      return;
    }
    let data: UsersFile;
    try {
      data = JSON.parse(readFileSync(this.file, 'utf8')) as UsersFile;
    } catch (error) {
      throw new Error(`Súbor účtov ${this.file} sa nedá načítať — oprav ho alebo obnov zo zálohy`, { cause: error });
    }
    if (data?.version !== USERS_FILE_VERSION || !Array.isArray(data.users)) {
      throw new Error(`Súbor účtov ${this.file} má nepodporovaný formát (verzia ${String(data?.version)})`);
    }
    for (const user of data.users) {
      user.sessions ??= [];
      user.tokens ??= [];
      user.stats ??= {};
      user.photo ??= null;
      user.photoSeq ??= user.photo?.version ?? 0;
      this.users.set(user.id, user);
      this.reindex(user);
    }
  }
}
