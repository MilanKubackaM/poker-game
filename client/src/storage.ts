import type { Avatar } from '../../shared/types';
import { ACCEPTED_AVATAR_EMOJIS, AVATAR_COLORS, AVATAR_EMOJIS } from '../../shared/constants';

const PROFILE_KEY = 'poker-night:profile';
const SESSION_PREFIX = 'poker-night:session:';
/** Index stolov, ktoré som v tomto prehliadači založil alebo ku ktorým som si prisadol: kód → posledné otvorenie. */
const TABLES_KEY = 'poker-night:tables';
/** Čakajúca žiadosť o prístup ku stolu (kým ju host neschváli) — prežije obnovenie stránky. */
const PENDING_PREFIX = 'poker-night:pending:';

export interface Profile {
  name: string;
  avatar: Avatar;
}

export interface StoredSession {
  playerId: string;
  token: string;
}

export interface SavedTable extends StoredSession {
  code: string;
  lastOpened: number;
  /** Kedy som od stola odišiel cez „Odísť od stola“ (účet a žetóny ostali pri stole); null = sedím pri ňom. */
  leftAt: number | null;
}

type TableIndex = Record<string, { lastOpened: number; leftAt?: number }>;

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    if (value === null) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, JSON.stringify(value));
    }
  } catch {
    return;
  }
}

export function loadProfile(): Profile {
  const stored = read<Profile>(PROFILE_KEY);
  if (stored?.name && stored.avatar && ACCEPTED_AVATAR_EMOJIS.includes(stored.avatar.emoji) && AVATAR_COLORS.includes(stored.avatar.color)) {
    return stored;
  }
  return {
    name: '',
    avatar: {
      emoji: AVATAR_EMOJIS[Math.floor(Math.random() * AVATAR_EMOJIS.length)],
      color: AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)],
    },
  };
}

export interface StoredPendingJoin {
  requestId: string;
  token: string;
}

export function loadPendingJoin(code: string): StoredPendingJoin | null {
  const stored = read<StoredPendingJoin>(PENDING_PREFIX + code.toUpperCase());
  return stored && typeof stored.requestId === 'string' && typeof stored.token === 'string' ? stored : null;
}

export function savePendingJoin(code: string, pending: StoredPendingJoin | null): void {
  write(PENDING_PREFIX + code.toUpperCase(), pending);
}

export function saveProfile(profile: Profile): void {
  write(PROFILE_KEY, profile);
}

function isSession(value: unknown): value is StoredSession {
  const session = value as Partial<StoredSession> | null;
  return !!session && typeof session.playerId === 'string' && typeof session.token === 'string';
}

/** Načíta index; pri prvom spustení ho postaví zo starších kľúčov `poker-night:session:*` (bez známeho času otvorenia). */
function loadIndex(): TableIndex {
  const stored = read<TableIndex>(TABLES_KEY);
  if (stored && typeof stored === 'object') {
    return stored;
  }
  const index: TableIndex = {};
  try {
    for (let position = 0; position < localStorage.length; position += 1) {
      const key = localStorage.key(position);
      if (key?.startsWith(SESSION_PREFIX) && isSession(read(key))) {
        index[key.slice(SESSION_PREFIX.length).toUpperCase()] = { lastOpened: 0 };
      }
    }
  } catch {
    return index;
  }
  write(TABLES_KEY, index);
  return index;
}

export function loadSession(code: string): StoredSession | null {
  const session = read<StoredSession>(SESSION_PREFIX + code.toUpperCase());
  return isSession(session) ? session : null;
}

/** Uloží prihlásenie ku stolu a zapíše stôl do „Moje stoly“; `null` stôl zabudne. */
export function saveSession(code: string, session: StoredSession | null): void {
  const key = code.toUpperCase();
  write(SESSION_PREFIX + key, session);
  const index = loadIndex();
  if (session) {
    index[key] = { lastOpened: Date.now() };
  } else {
    delete index[key];
  }
  write(TABLES_KEY, index);
}

/** Zapamätá si, že som od stola dobrovoľne odišiel — token ostáva, stôl ostáva v „Moje stoly“ (návrat cez `table:resume`). */
export function markTableLeft(code: string): void {
  const key = code.toUpperCase();
  if (!loadSession(key)) {
    return;
  }
  const index = loadIndex();
  const now = Date.now();
  index[key] = { lastOpened: now, leftAt: now };
  write(TABLES_KEY, index);
}

/** Uložené stoly, naposledy otvorené prvé. */
export function listSavedTables(): SavedTable[] {
  const index = loadIndex();
  const tables: SavedTable[] = [];
  for (const [code, meta] of Object.entries(index)) {
    const session = loadSession(code);
    if (session) {
      tables.push({ code, lastOpened: meta?.lastOpened ?? 0, leftAt: typeof meta?.leftAt === 'number' ? meta.leftAt : null, ...session });
    }
  }
  return tables.sort((left, right) => right.lastOpened - left.lastOpened);
}

const ROOM_VIEW_PREFIX = 'poker-night:room-view:';

/** Som počas hry v čakárni (odišiel som od stola, ale nie z hry) — len pre túto kartu prehliadača, prežije obnovenie stránky. */
export function loadRoomView(code: string): boolean {
  try {
    return sessionStorage.getItem(ROOM_VIEW_PREFIX + code.toUpperCase()) === '1';
  } catch {
    return false;
  }
}

export function saveRoomView(code: string, value: boolean): void {
  try {
    if (value) {
      sessionStorage.setItem(ROOM_VIEW_PREFIX + code.toUpperCase(), '1');
    } else {
      sessionStorage.removeItem(ROOM_VIEW_PREFIX + code.toUpperCase());
    }
  } catch {
    return;
  }
}
