import type { HandView, TableSettings } from '../../shared/types';

/** Stav času hráča na ťahu: najprv základný čas, potom sa míňa jeho timebank. */
export interface TurnClock {
  phase: 'base' | 'bank';
  /** Zvyšok aktuálnej fázy 0–1 (pre prstenec). */
  progress: number;
  /** Sekundy do konca aktuálnej fázy. */
  secondsLeft: number;
}

/**
 * `turnBaseDeadline` = koniec základného času, `turnDeadline` = koniec základu + timebank hráča na začiatku ťahu.
 * Starší server `turnBaseDeadline` neposiela — vtedy je celý čas „základný“ (ako predtým).
 */
export function turnClock(hand: HandView | null, settings: TableSettings, now: number): TurnClock | null {
  if (!hand?.turnDeadline || !settings.actionTimeoutSec) {
    return null;
  }
  const end = hand.turnDeadline;
  const base = hand.turnBaseDeadline ?? null;
  const clamp = (value: number) => Math.max(0, Math.min(1, value));
  if (base === null || now < base) {
    const deadline = base ?? end;
    return { phase: 'base', progress: clamp((deadline - now) / (settings.actionTimeoutSec * 1000)), secondsLeft: Math.max(0, Math.ceil((deadline - now) / 1000)) };
  }
  const bankTotal = Math.max(1, end - base);
  return { phase: 'bank', progress: clamp((end - now) / bankTotal), secondsLeft: Math.max(0, Math.ceil((end - now) / 1000)) };
}

/** „50 s“, „2 min 5 s“ */
export function secondsLabel(seconds: number): string {
  if (seconds < 120) {
    return `${seconds} s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes} min ${rest} s` : `${minutes} min`;
}
