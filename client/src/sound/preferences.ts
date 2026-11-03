import { useSyncExternalStore } from 'react';

const STORAGE_KEY = 'poker-night:sound';

export interface SoundPreferences {
  /** Hlavný vypínač: stlmí všetko — efekty, upozornenia aj hlas hráčov (klik na reproduktor). */
  muted: boolean;
  /** Zvukové efekty hry (karty, žetóny, výhra…). */
  effects: boolean;
  /** Upozornenie, keď som na ťahu, a tikanie pri dochádzajúcom čase. */
  turnAlert: boolean;
  /** Hlasitosť efektov a upozornení 0–1. */
  effectsVolume: number;
  /** Hlasitosť hlasu ostatných hráčov 0–1. */
  voiceVolume: number;
  /** Push-to-talk: mikrofón vysiela len počas držania klávesu (desktop, predvolene vypnuté). */
  pushToTalk: boolean;
  /** `KeyboardEvent.code` klávesu pre push-to-talk. */
  pushToTalkKey: string;
}

export const DEFAULT_SOUND_PREFERENCES: SoundPreferences = {
  muted: false,
  effects: true,
  turnAlert: true,
  effectsVolume: 0.8,
  voiceVolume: 1,
  pushToTalk: false,
  pushToTalkKey: 'KeyV',
};

function volume(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback;
}

function normalize(stored: Partial<SoundPreferences> | null | undefined): SoundPreferences {
  const defaults = DEFAULT_SOUND_PREFERENCES;
  return {
    muted: typeof stored?.muted === 'boolean' ? stored.muted : defaults.muted,
    effects: typeof stored?.effects === 'boolean' ? stored.effects : defaults.effects,
    turnAlert: typeof stored?.turnAlert === 'boolean' ? stored.turnAlert : defaults.turnAlert,
    effectsVolume: volume(stored?.effectsVolume, defaults.effectsVolume),
    voiceVolume: volume(stored?.voiceVolume, defaults.voiceVolume),
    pushToTalk: typeof stored?.pushToTalk === 'boolean' ? stored.pushToTalk : defaults.pushToTalk,
    pushToTalkKey: typeof stored?.pushToTalkKey === 'string' && stored.pushToTalkKey ? stored.pushToTalkKey : defaults.pushToTalkKey,
  };
}

function parse(raw: string | null): SoundPreferences {
  if (!raw) {
    return DEFAULT_SOUND_PREFERENCES;
  }
  try {
    return normalize(JSON.parse(raw) as Partial<SoundPreferences> | null);
  } catch {
    return DEFAULT_SOUND_PREFERENCES;
  }
}

function same(left: SoundPreferences, right: SoundPreferences): boolean {
  return (Object.keys(DEFAULT_SOUND_PREFERENCES) as (keyof SoundPreferences)[]).every((key) => left[key] === right[key]);
}

export function loadSoundPreferences(): SoundPreferences {
  try {
    return parse(localStorage.getItem(STORAGE_KEY));
  } catch {
    return DEFAULT_SOUND_PREFERENCES;
  }
}

export function saveSoundPreferences(prefs: SoundPreferences): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    return;
  }
}

let current: SoundPreferences = loadSoundPreferences();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

/** Aktuálne nastavenia — čítajú sa aj mimo Reactu (napr. v časovači upozornenia). */
export function getSoundPreferences(): SoundPreferences {
  return current;
}

export type SoundPreferencesUpdate = Partial<SoundPreferences> | ((previous: SoundPreferences) => SoundPreferences);

export function setSoundPreferences(update: SoundPreferencesUpdate): void {
  const next = normalize(typeof update === 'function' ? update(current) : { ...current, ...update });
  if (same(next, current)) {
    return;
  }
  current = next;
  saveSoundPreferences(current);
  emit();
}

/** Odber zmien mimo Reactu (napr. hlasitosť v audio engine). */
export function subscribeSoundPreferences(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Zmena v inej karte toho istého prehliadača.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== null && event.key !== STORAGE_KEY) {
      return;
    }
    const next = event.key === null ? DEFAULT_SOUND_PREFERENCES : parse(event.newValue);
    if (!same(next, current)) {
      current = next;
      emit();
    }
  });
}

/** Zdieľané nastavenia zvuku — všetky komponenty používajúce hook sa prekreslia naraz. */
export function useSoundPreferences(): [SoundPreferences, (update: SoundPreferencesUpdate) => void] {
  const prefs = useSyncExternalStore(subscribeSoundPreferences, getSoundPreferences, getSoundPreferences);
  return [prefs, setSoundPreferences];
}
