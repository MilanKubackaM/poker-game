import type { RtcPayload } from '../../../shared/types';
import { socket } from '../socket';
import { SignalBuffer, type BufferedSignal } from './logic';

/**
 * Prichádzajúce `rtc:signal` správy. Poslucháč sa registruje hneď pri načítaní aplikácie — Socket.IO udalosť bez
 * poslucháča zahodí, a ponuka od hráča, ktorý ma uvidel skôr, než sa mi vykreslil stôl, by sa stratila.
 * Kým mesh nebeží (alebo nepozná odosielateľa), správy čakajú v bufferi a po zapnutí sa prehrajú v poradí príchodu.
 */
export type SignalHandler = (from: string, data: RtcPayload) => boolean;

const buffer = new SignalBuffer();
let handler: SignalHandler | null = null;

function onSignal(message: { from?: unknown; data?: RtcPayload } | undefined): void {
  if (!message || typeof message.from !== 'string' || !message.data || typeof message.data !== 'object') {
    return;
  }
  const { from, data } = message;
  // Kým čakajú staršie správy od toho istého odosielateľa, nová ide za ne (poradie ponuka → kandidáti).
  const now = performance.now();
  if (handler && !buffer.has(from, now) && handler(from, data)) {
    return;
  }
  buffer.push(from, data, now);
}

socket.on('rtc:signal', onSignal);
// Nový socket (reconnect) = nové socket id; správy adresované starému spojeniu sú neplatné.
socket.on('connect', () => buffer.clear());

/** Zapne spracovanie (mesh beží). Handler vráti `false`, ak správu zatiaľ spracovať nevie — ostane v bufferi. */
export function attachSignalHandler(next: SignalHandler): void {
  handler = next;
}

export function detachSignalHandler(current: SignalHandler): void {
  if (handler === current) {
    handler = null;
  }
}

/** Prehrá čakajúce správy od odosielateľov, ktorých už mesh pozná; ostatné čakajú ďalej (do vypršania). */
export function drainSignals(accept: (from: string) => boolean): BufferedSignal[] {
  return buffer.take(performance.now(), accept);
}
