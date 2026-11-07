import { useSyncExternalStore } from 'react';
import type { AccountView, AuthSession } from '../../../shared/account';
import { AUTH_TOKEN_KEY, NO_RESPONSE, emit, loadAuthToken, reconnectSocket, socket } from '../socket';

/**
 * Prihlásenie účtu na klientovi. Token je v localStorage (`poker-night:auth`) a socket ho posiela v `auth.token`
 * pri každom pripojení (pozri `socket.ts`). Stav žije mimo Reactu — listenery sú registrované hneď pri načítaní modulu,
 * aby nezmeškali `account:updated`, ktorý server pošle hneď po pripojení.
 */
export type AccountStatus = 'loading' | 'signed-out' | 'unverified' | 'ready';

export interface AccountSnapshot {
  status: AccountStatus;
  account: AccountView | null;
  /** Oznámenie na prihlasovacej obrazovke (napr. „Prihlásenie vypršalo“). */
  notice: string | null;
  /** Server je nedostupný (posledný pokus o spojenie zlyhal) — socket.io skúša znova. */
  offline: boolean;
}

const EXPIRED_NOTICE = 'Prihlásenie vypršalo alebo bolo zrušené — prihlás sa znova.';
/** Po odmietnutom spojení (preťažený server) alebo zlyhanom `auth:me` sa skúša znova po tejto pauze. */
const RETRY_MS = 5000;

let snapshot: AccountSnapshot = { status: loadAuthToken() ? 'loading' : 'signed-out', account: null, notice: null, offline: false };
const listeners = new Set<() => void>();
let started = false;

function update(next: AccountSnapshot): void {
  snapshot = next;
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): AccountSnapshot {
  return snapshot;
}

export function useAccount(): AccountSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function getAccount(): AccountView | null {
  return snapshot.account;
}

/** Token pre HTTP (nahratie fotky). */
export function authToken(): string | null {
  return loadAuthToken();
}

function saveToken(token: string | null): void {
  try {
    if (token) {
      localStorage.setItem(AUTH_TOKEN_KEY, token);
    } else {
      localStorage.removeItem(AUTH_TOKEN_KEY);
    }
  } catch {
    // Prehliadač bez localStorage — prihlásenie sa neudrží (socket token číta odtiaľ); prihlasovací formulár to ukáže.
  }
}

function currentToken(): string | null {
  return loadAuthToken();
}

/** Nový stav účtu zo servera (odpoveď na akciu alebo `account:updated`). */
export function applyAccount(account: AccountView): void {
  if (!currentToken()) {
    return;
  }
  update({ status: account.emailVerified ? 'ready' : 'unverified', account, notice: null, offline: false });
}

/**
 * Po prihlásení / registrácii / resete hesla: uloží token a znova pripojí socket, aby ho server videl.
 * Vráti false, keď prehliadač nedovolí token uložiť (bez neho by socket ostal neprihlásený).
 */
export function signIn(session: AuthSession): boolean {
  saveToken(session.token);
  if (loadAuthToken() !== session.token) {
    return false;
  }
  update({ status: session.account.emailVerified ? 'ready' : 'unverified', account: session.account, notice: null, offline: false });
  reconnectSocket();
  return true;
}

/** Lokálne odhlásenie (bez volania servera) — po `auth:invalid` alebo po `auth:logout`. */
function signOutLocally(notice: string | null): void {
  saveToken(null);
  update({ ...snapshot, status: 'signed-out', account: null, notice });
  reconnectSocket();
}

/** Odhlásenie z tohto zariadenia; server zruší aktuálne prihlásenie. */
export async function signOut(): Promise<void> {
  await emit('auth:logout');
  signOutLocally(null);
}

export function clearAuthNotice(): void {
  if (snapshot.notice) {
    update({ ...snapshot, notice: null });
  }
}

/** Overí uložený token cez `auth:me` (spoľahlivá cesta; `account:updated` po pripojení je len rýchlejšia). */
export async function refreshAccount(): Promise<void> {
  const token = currentToken();
  if (!token) {
    return;
  }
  const response = await emit<AccountView>('auth:me');
  if (currentToken() !== token) {
    return;
  }
  if (response.ok && response.data) {
    applyAccount(response.data);
    return;
  }
  // Neplatný token oznámi server cez `auth:invalid`; iná chyba (výpadok, chyba servera) prihlásenie nezahadzuje.
  if (snapshot.status === 'loading' && response.error !== NO_RESPONSE) {
    window.setTimeout(() => {
      if (snapshot.status === 'loading' && socket.connected) {
        void refreshAccount();
      }
    }, RETRY_MS);
  }
}

function setOffline(offline: boolean): void {
  if (snapshot.offline !== offline) {
    update({ ...snapshot, offline });
  }
}

socket.on('connect', () => {
  setOffline(false);
  if (currentToken()) {
    void refreshAccount();
  }
});

socket.on('account:updated', (account: AccountView) => {
  if (account && typeof account.id === 'string') {
    applyAccount(account);
  }
});

socket.on('auth:invalid', () => {
  if (currentToken()) {
    signOutLocally(EXPIRED_NOTICE);
  }
});

socket.on('connect_error', () => {
  setOffline(true);
  // `active === false` = server spojenie odmietol (napr. preťaženie) a socket.io sa sám znova nepripojí — skúsime neskôr.
  // Neplatný token spojenie neodmieta (príde `auth:invalid`), preto tu prihlásenie nezahadzujeme.
  if (!socket.active) {
    window.setTimeout(() => {
      if (!socket.connected && !socket.active) {
        socket.connect();
      }
    }, RETRY_MS);
  }
});

/** Prihlásenie / odhlásenie v inej karte prehliadača. */
function onStorage(event: StorageEvent): void {
  if (event.key !== AUTH_TOKEN_KEY) {
    return;
  }
  if (!event.newValue) {
    if (snapshot.status !== 'signed-out') {
      update({ ...snapshot, status: 'signed-out', account: null, notice: null });
      reconnectSocket();
    }
    return;
  }
  update({ ...snapshot, status: 'loading', account: null, notice: null });
  reconnectSocket();
}

/** Spustí prihlásenie (raz, z koreňa aplikácie) — s uloženým tokenom sa pripojí a overí ho. */
export function startAccount(): void {
  if (started) {
    return;
  }
  started = true;
  window.addEventListener('storage', onStorage);
  if (currentToken()) {
    if (socket.connected) {
      void refreshAccount();
    } else {
      socket.connect();
    }
  }
}
