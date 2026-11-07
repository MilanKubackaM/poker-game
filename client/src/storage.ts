import type { DeviceSeat } from '../../shared/account';

/** Miesta pri stoloch z čias pred účtami (v1.1.0 a staršie) — dnes slúžia len ako dôkaz pre archív (`deviceSeats`). */
const SESSION_PREFIX = 'poker-night:session:';
/** Čakajúca žiadosť o prístup ku stolu (kým ju host neschváli) — prežije obnovenie stránky. */
const PENDING_PREFIX = 'poker-night:pending:';
/** Pozvánka ku stolu otvorená pred prihlásením — po prihlásení / overení e-mailu (aj v inej karte) sa ku stolu pokračuje. */
const INVITE_KEY = 'poker-night:invite';
/** Ako dlho si pozvánku pamätáme (pokrýva aj platnosť overovacieho odkazu). */
const INVITE_TTL_MS = 48 * 60 * 60 * 1000;

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

function isSeat(value: unknown): value is { playerId: string; token: string } {
  const session = value as { playerId?: unknown; token?: unknown } | null;
  return !!session && typeof session.playerId === 'string' && typeof session.token === 'string';
}

/** Všetky staré miesta pri stoloch uložené v tomto prehliadači (len na čítanie — nové stoly patria účtu). */
export function listSavedTables(): DeviceSeat[] {
  const seats: DeviceSeat[] = [];
  try {
    for (let position = 0; position < localStorage.length; position += 1) {
      const key = localStorage.key(position);
      if (!key?.startsWith(SESSION_PREFIX)) {
        continue;
      }
      const session = read<unknown>(key);
      if (isSeat(session)) {
        seats.push({ code: key.slice(SESSION_PREFIX.length).toUpperCase(), playerId: session.playerId, token: session.token });
      }
    }
  } catch {
    return seats;
  }
  return seats;
}

export function rememberInvite(code: string): void {
  write(INVITE_KEY, { code: code.toUpperCase(), at: Date.now() });
}

/** Zapamätaná pozvánka (a zabudne ju), alebo null. */
export function takeRememberedInvite(): string | null {
  const stored = read<{ code?: unknown; at?: unknown }>(INVITE_KEY);
  write(INVITE_KEY, null);
  if (!stored || typeof stored.code !== 'string' || typeof stored.at !== 'number' || Date.now() - stored.at > INVITE_TTL_MS) {
    return null;
  }
  return /^[A-Z0-9]{4,8}$/.test(stored.code) ? stored.code : null;
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
