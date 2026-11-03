import { io, type Socket } from 'socket.io-client';
import type { Ack } from '../../shared/types';

export const socket: Socket = io({ autoConnect: false, transports: ['websocket', 'polling'] });

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
