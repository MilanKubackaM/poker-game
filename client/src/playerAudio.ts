import { useSyncExternalStore } from 'react';

/**
 * Hlasitosť a stlmenie jednotlivých hráčov — platí len v tomto prehliadači (ostatní nič nevidia), pamätá sa podľa id hráča.
 * `volume` 0–1.5 (nad 1 zosilňuje cez Web Audio), `muted` = hráča vôbec nepočuť.
 */
export interface PlayerAudioSetting {
  volume: number;
  muted: boolean;
}

export const PLAYER_VOLUME_MAX = 1.5;
export const DEFAULT_PLAYER_AUDIO: PlayerAudioSetting = { volume: 1, muted: false };

const STORAGE_KEY = 'poker-night:player-audio';
/** Najviac pamätaných hráčov — staré záznamy sa zahodia (id hráča je náhodné na každý stôl). */
const MAX_ENTRIES = 200;

type Settings = Record<string, PlayerAudioSetting>;

function sanitize(value: unknown): PlayerAudioSetting | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const { volume, muted } = value as Partial<PlayerAudioSetting>;
  if (typeof volume !== 'number' || !Number.isFinite(volume) || typeof muted !== 'boolean') {
    return null;
  }
  return { volume: Math.min(PLAYER_VOLUME_MAX, Math.max(0, volume)), muted };
}

function load(): Settings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const result: Settings = {};
    for (const [id, value] of Object.entries(parsed)) {
      const setting = sanitize(value);
      if (setting) {
        result[id] = setting;
      }
    }
    return result;
  } catch {
    return {};
  }
}

let settings: Settings = typeof window === 'undefined' ? {} : load();
const listeners = new Set<() => void>();

function save(): void {
  try {
    const entries = Object.entries(settings);
    const kept = entries.length > MAX_ENTRIES ? Object.fromEntries(entries.slice(-MAX_ENTRIES)) : settings;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(kept));
  } catch {
    // Súkromné okno / plné úložisko — nastavenie platí aspoň do zatvorenia okna.
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): Settings {
  return settings;
}

export function getPlayerAudio(playerId: string): PlayerAudioSetting {
  return settings[playerId] ?? DEFAULT_PLAYER_AUDIO;
}

export function setPlayerAudio(playerId: string, patch: Partial<PlayerAudioSetting>): void {
  const next = sanitize({ ...getPlayerAudio(playerId), ...patch });
  if (!next) {
    return;
  }
  const { [playerId]: _previous, ...rest } = settings;
  // Predvolené nastavenie sa neukladá; zmenený hráč ide na koniec (najnovší sa pri orezaní zachová).
  settings = next.volume === DEFAULT_PLAYER_AUDIO.volume && !next.muted ? rest : { ...rest, [playerId]: next };
  save();
  for (const listener of listeners) {
    listener();
  }
}

/** Nastavenie jedného hráča (re-render pri zmene). */
export function usePlayerAudio(playerId: string): [PlayerAudioSetting, (patch: Partial<PlayerAudioSetting>) => void] {
  const all = useSyncExternalStore(subscribe, snapshot, snapshot);
  return [all[playerId] ?? DEFAULT_PLAYER_AUDIO, (patch) => setPlayerAudio(playerId, patch)];
}

/** Všetky upravené nastavenia (napr. ikonka stlmenia pri sedadlách). */
export function usePlayerAudioMap(): Readonly<Settings> {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
