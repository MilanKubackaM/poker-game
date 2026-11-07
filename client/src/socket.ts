import { io, type Socket } from 'socket.io-client';
import type { Ack } from '../../shared/types';

/** Token prihláseného účtu v localStorage — číta ho `auth` pri každom (aj automatickom) pripojení socketu. */
export const AUTH_TOKEN_KEY = 'poker-night:auth';

export function loadAuthToken(): string | null {
  try {
    const token = localStorage.getItem(AUTH_TOKEN_KEY);
    return token && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

export const socket: Socket = io({
  autoConnect: false,
  transports: ['websocket', 'polling'],
  // Funkcia (nie objekt) — socket.io ju zavolá pri každom pripojení, takže reconnect vždy nesie aktuálny token.
  auth: (callback) => {
    const token = loadAuthToken();
    callback(token ? { token } : {});
  },
});

/** Chyba, ktorú vráti `emit`, keď server do 8 s neodpovie (výpadok spojenia, starší server bez daného eventu). */
export const NO_RESPONSE = 'Server neodpovedá';

export function emit<T = undefined>(event: string, payload: unknown = {}): Promise<Ack<T>> {
  return new Promise((resolve) => {
    if (!socket.connected) {
      socket.connect();
    }
    socket.timeout(8000).emit(event, payload, (error: Error | null, response: Ack<T>) => {
      resolve(error ? { ok: false, error: NO_RESPONSE } : response);
    });
  });
}

/** Nové spojenie (po prihlásení / odhlásení), aby serverový middleware videl aktuálny token. */
export function reconnectSocket(): void {
  socket.disconnect();
  socket.connect();
}
