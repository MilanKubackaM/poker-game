/** Hlasitosť (RMS 0–1), od ktorej hráč „hovorí“, a nižšia hranica, pod ktorou prestane (hysterézia proti blikaniu). */
export const SPEAK_ON_LEVEL = 0.04;
export const SPEAK_OFF_LEVEL = 0.02;
/** Ako dlho po stíchnutí ostane označenie — krátke pauzy medzi slovami ho nezhasnú. */
export const SPEAK_HOLD_MS = 450;

/** Stav jedného hráča medzi vzorkami: či hovorí a kedy naposledy prekročil spodnú hranicu. */
export interface SpeakState {
  speaking: boolean;
  lastLoudAt: number;
}

/** Ďalší stav podľa aktuálnej hlasitosti — čistá funkcia kvôli testom. */
export function nextSpeakState(state: SpeakState, level: number, now: number): SpeakState {
  if (level >= SPEAK_ON_LEVEL || (state.speaking && level >= SPEAK_OFF_LEVEL)) {
    return { speaking: true, lastLoudAt: now };
  }
  if (state.speaking && now - state.lastLoudAt < SPEAK_HOLD_MS) {
    return state;
  }
  return { speaking: false, lastLoudAt: state.lastLoudAt };
}

/** RMS z časových vzoriek analyzátora (bajty 0–255, ticho = 128). */
export function rmsLevel(samples: Uint8Array): number {
  if (samples.length === 0) {
    return 0;
  }
  let sum = 0;
  for (const sample of samples) {
    const value = (sample - 128) / 128;
    sum += value * value;
  }
  return Math.sqrt(sum / samples.length);
}
