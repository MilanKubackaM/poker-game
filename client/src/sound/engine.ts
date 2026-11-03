import type { SoundName } from './names';
import { getSoundPreferences, subscribeSoundPreferences } from './preferences';
import { synthesize } from './synth';

export interface PlayOptions {
  /** Oneskorenie od teraz v ms (plánuje sa na hodinách AudioContextu, nie cez setTimeout). */
  delayMs?: number;
  /** Relatívna hlasitosť 0–1 (násobí prednastavenú úroveň zvuku). */
  volume?: number;
}

type AudioContextConstructor = new () => AudioContext;

const MASTER_LEVEL = 0.85;
/** Minimálny odstup rovnakého zvuku v sekundách — zhluk aktualizácií stavu nenavrství desiatky kópií. */
const MIN_GAP: Partial<Record<SoundName, number>> = { chips: 0.08, allin: 0.25, win: 1, bounty: 1.5, turn: 0.6, timeWarning: 0.5, message: 0.15 };
const DEFAULT_MIN_GAP = 0.04;
/** Najviac toľko zvukov sa môže začať v jednom okne `BURST_WINDOW` sekúnd. */
const BURST_LIMIT = 14;
const BURST_WINDOW = 0.4;

let context: AudioContext | null = null;
let master: GainNode | null = null;
let unavailable = false;
const lastStart = new Map<SoundName, number>();
let recentStarts: number[] = [];

function audioContextClass(): AudioContextConstructor | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const scope = window as unknown as { AudioContext?: AudioContextConstructor; webkitAudioContext?: AudioContextConstructor };
  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}

/** Hlavná vetva: master gain → jemný kompresor (ochrana pred clippingom pri súbehu zvukov) → výstup. */
export function createOutputChain(ctx: BaseAudioContext, level = MASTER_LEVEL): GainNode {
  const gain = ctx.createGain();
  gain.gain.value = level;
  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = -8;
  compressor.knee.value = 6;
  compressor.ratio.value = 8;
  compressor.attack.value = 0.002;
  compressor.release.value = 0.12;
  gain.connect(compressor).connect(ctx.destination);
  return gain;
}

function getContext(): AudioContext | null {
  if (context || unavailable) {
    return context;
  }
  const Ctor = audioContextClass();
  if (!Ctor) {
    unavailable = true;
    return null;
  }
  try {
    context = new Ctor();
    master = createOutputChain(context, MASTER_LEVEL * effectiveVolume());
    context.addEventListener?.('statechange', () => {
      if (context && context.state !== 'running') {
        registerUnlockListeners();
      }
    });
  } catch {
    unavailable = true;
    context = null;
    master = null;
  }
  return context;
}

/**
 * Odomkne zvuk — prehliadače spustia AudioContext až po geste používateľa. Volať priamo v obsluhe kliknutia/klávesy;
 * modul sa navyše sám zaregistruje na prvý `pointerdown`/`keydown`/`touchend`.
 */
export function unlockAudio(): void {
  const ctx = getContext();
  if (!ctx) {
    return;
  }
  try {
    if (ctx.state !== 'running') {
      void ctx.resume().then(
        () => {
          if (ctx.state === 'running') {
            removeUnlockListeners();
          }
        },
        () => undefined,
      );
      // iOS Safari: prehranie tichého bufferu v rámci gesta odblokuje výstup.
      const silent = ctx.createBufferSource();
      silent.buffer = ctx.createBuffer(1, 1, 22050);
      silent.connect(ctx.destination);
      silent.start(0);
    } else {
      removeUnlockListeners();
    }
  } catch {
    return;
  }
}

/** true, ak AudioContext beží a zvuky sa reálne prehrajú. */
export function isAudioReady(): boolean {
  return context?.state === 'running';
}

export function setMasterVolume(volume: number): void {
  if (master && context) {
    master.gain.setTargetAtTime(Math.max(0, Math.min(1, volume)) * MASTER_LEVEL, context.currentTime, 0.02);
  }
}

/** Prehrá zvuk; bez Web Audio alebo pred odomknutím je to ticho (nikdy nevyhodí výnimku). */
export function playSound(name: SoundName, options: PlayOptions = {}): void {
  // Kontext vzniká až pri geste (unlockAudio) — inak by prehliadač hlásil zablokovaný autoplay.
  const ctx = context;
  if (!ctx || !master || ctx.state !== 'running') {
    return;
  }
  try {
    const start = ctx.currentTime + 0.01 + Math.max(0, options.delayMs ?? 0) / 1000;
    const previous = lastStart.get(name);
    if (previous !== undefined && Math.abs(start - previous) < (MIN_GAP[name] ?? DEFAULT_MIN_GAP)) {
      return;
    }
    recentStarts = recentStarts.filter((at) => Math.abs(start - at) < BURST_WINDOW);
    if (recentStarts.length >= BURST_LIMIT) {
      return;
    }
    recentStarts.push(start);
    lastStart.set(name, start);
    synthesize(ctx, master, name, start, Math.max(0, Math.min(1, options.volume ?? 1)));
  } catch {
    return;
  }
}

/** Hlasitosť efektov; stlmený reproduktor = 0. */
function effectiveVolume(): number {
  const prefs = getSoundPreferences();
  return prefs.muted ? 0 : prefs.effectsVolume;
}

// Posuvník hlasitosti efektov a hlavný vypínač zvuku v hornej lište.
subscribeSoundPreferences(() => setMasterVolume(effectiveVolume()));

const UNLOCK_EVENTS = ['pointerdown', 'keydown', 'touchend'] as const;
let listening = false;

function onGesture(): void {
  unlockAudio();
}

function registerUnlockListeners(): void {
  if (listening || typeof window === 'undefined') {
    return;
  }
  listening = true;
  for (const type of UNLOCK_EVENTS) {
    window.addEventListener(type, onGesture, { capture: true, passive: true });
  }
}

function removeUnlockListeners(): void {
  if (!listening || typeof window === 'undefined') {
    return;
  }
  listening = false;
  for (const type of UNLOCK_EVENTS) {
    window.removeEventListener(type, onGesture, { capture: true });
  }
}

registerUnlockListeners();
