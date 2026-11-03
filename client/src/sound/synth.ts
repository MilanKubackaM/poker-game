import type { SoundName } from './names';

/**
 * Syntéza zvukov cez Web Audio API — bez audio súborov. Každá funkcia naplánuje uzly do `out` od času `t`
 * a funguje s `AudioContext` aj `OfflineAudioContext` (kvôli testom hlasitosti).
 */

interface Voice {
  ctx: BaseAudioContext;
  out: AudioNode;
  vol: number;
}

const SILENT = 0.0001;
const noiseBuffers = new WeakMap<BaseAudioContext, AudioBuffer>();

function noiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  let buffer = noiseBuffers.get(ctx);
  if (!buffer) {
    buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate), ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let index = 0; index < data.length; index++) {
      data[index] = Math.random() * 2 - 1;
    }
    noiseBuffers.set(ctx, buffer);
  }
  return buffer;
}

/** Obálka: nábeh na `peak` za `attack` s, potom exponenciálny dozvuk za `decay` s. */
function envelope(ctx: BaseAudioContext, t: number, attack: number, decay: number, peak: number): GainNode {
  const gain = ctx.createGain();
  const top = Math.max(peak, SILENT * 2);
  gain.gain.setValueAtTime(SILENT, t);
  gain.gain.exponentialRampToValueAtTime(top, t + attack);
  gain.gain.exponentialRampToValueAtTime(SILENT, t + attack + decay);
  gain.gain.setValueAtTime(0, t + attack + decay + 0.01);
  return gain;
}

interface ToneOptions {
  freq: number;
  freqEnd?: number;
  type?: OscillatorType;
  attack?: number;
  decay: number;
  peak: number;
}

function tone(voice: Voice, t: number, options: ToneOptions): void {
  const { ctx, out, vol } = voice;
  const attack = options.attack ?? 0.004;
  const osc = ctx.createOscillator();
  osc.type = options.type ?? 'sine';
  osc.frequency.setValueAtTime(options.freq, t);
  if (options.freqEnd) {
    osc.frequency.exponentialRampToValueAtTime(options.freqEnd, t + attack + options.decay);
  }
  const gain = envelope(ctx, t, attack, options.decay, options.peak * vol);
  osc.connect(gain).connect(out);
  osc.start(t);
  osc.stop(t + attack + options.decay + 0.05);
}

interface NoiseOptions {
  filter: BiquadFilterType;
  freq: number;
  freqEnd?: number;
  q?: number;
  attack?: number;
  decay: number;
  peak: number;
}

function noise(voice: Voice, t: number, options: NoiseOptions): void {
  const { ctx, out, vol } = voice;
  const attack = options.attack ?? 0.002;
  const source = ctx.createBufferSource();
  source.buffer = noiseBuffer(ctx);
  const filter = ctx.createBiquadFilter();
  filter.type = options.filter;
  filter.Q.value = options.q ?? 0.8;
  filter.frequency.setValueAtTime(options.freq, t);
  if (options.freqEnd) {
    filter.frequency.exponentialRampToValueAtTime(options.freqEnd, t + attack + options.decay);
  }
  const gain = envelope(ctx, t, attack, options.decay, options.peak * vol);
  source.connect(filter).connect(gain).connect(out);
  const offset = Math.random() * 0.5;
  source.start(t, offset);
  source.stop(t + attack + options.decay + 0.05);
}

/** Zvonček s harmonickými alikvotami — mäkký, „kasínový“ tón. */
function bell(voice: Voice, t: number, freq: number, decay: number, peak: number): void {
  tone(voice, t, { freq, decay, peak, attack: 0.006 });
  tone(voice, t, { freq: freq * 2, decay: decay * 0.55, peak: peak * 0.28, attack: 0.004 });
  tone(voice, t, { freq: freq * 3, decay: decay * 0.3, peak: peak * 0.1, attack: 0.003 });
  tone(voice, t, { freq: freq * 4.2, decay: decay * 0.12, peak: peak * 0.05, attack: 0.002 });
}

/** Cvaknutie keramického žetónu o žetón. */
function chipClack(voice: Voice, t: number, pitch: number, peak: number): void {
  noise(voice, t, { filter: 'highpass', freq: 2600, decay: 0.012, peak: peak * 0.55, attack: 0.001 });
  tone(voice, t, { freq: 3150 * pitch, decay: 0.045, peak: peak * 0.42, attack: 0.001 });
  tone(voice, t, { freq: 4720 * pitch, decay: 0.03, peak: peak * 0.26, attack: 0.001 });
  tone(voice, t, { freq: 6300 * pitch, decay: 0.02, peak: peak * 0.14, attack: 0.001 });
}

function chipShower(voice: Voice, t: number, count: number, spread: number, peak: number): void {
  for (let index = 0; index < count; index++) {
    const at = t + (spread * index) / count + Math.random() * (spread / count) * 0.6;
    const fade = 1 - (index / count) * 0.45;
    chipClack(voice, at, 0.88 + Math.random() * 0.24, peak * fade * (0.75 + Math.random() * 0.25));
  }
}

function cardFlick(voice: Voice, t: number, peak: number): void {
  noise(voice, t, { filter: 'bandpass', freq: 4200, freqEnd: 1600, q: 1.1, attack: 0.003, decay: 0.07, peak });
  noise(voice, t + 0.055, { filter: 'lowpass', freq: 1100, decay: 0.035, peak: peak * 0.45 });
}

function knock(voice: Voice, t: number, peak: number): void {
  tone(voice, t, { freq: 150, freqEnd: 70, decay: 0.09, peak, attack: 0.002 });
  noise(voice, t, { filter: 'lowpass', freq: 700, decay: 0.045, peak: peak * 0.7, attack: 0.001 });
}

const NOTE = {
  G4: 392,
  C5: 523.25,
  E5: 659.25,
  G5: 783.99,
  A5: 880,
  C6: 1046.5,
  E6: 1318.51,
} as const;

function brass(voice: Voice, t: number, freq: number, length: number, peak: number): void {
  const { ctx, out, vol } = voice;
  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(freq, t);
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.Q.value = 1.2;
  filter.frequency.setValueAtTime(500, t);
  filter.frequency.exponentialRampToValueAtTime(2600, t + 0.05);
  filter.frequency.exponentialRampToValueAtTime(1100, t + length);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(SILENT, t);
  gain.gain.exponentialRampToValueAtTime(peak * vol, t + 0.03);
  gain.gain.setValueAtTime(peak * vol * 0.8, t + Math.max(0.04, length - 0.08));
  gain.gain.exponentialRampToValueAtTime(SILENT, t + length);
  osc.connect(filter).connect(gain).connect(out);
  osc.start(t);
  osc.stop(t + length + 0.05);
}

type Synth = (voice: Voice, t: number) => void;

const SYNTHS: Record<SoundName, Synth> = {
  deal: (voice, t) => cardFlick(voice, t, 0.7),
  flip: (voice, t) => {
    noise(voice, t, { filter: 'bandpass', freq: 2600, q: 0.9, decay: 0.035, peak: 0.55 });
    noise(voice, t + 0.045, { filter: 'highpass', freq: 1900, decay: 0.028, peak: 0.42 });
    tone(voice, t + 0.045, { freq: 170, freqEnd: 90, decay: 0.06, peak: 0.28 });
  },
  chip: (voice, t) => {
    chipClack(voice, t, 1, 0.75);
    chipClack(voice, t + 0.055, 1.04, 0.35);
  },
  chips: (voice, t) => chipShower(voice, t, 6, 0.24, 0.7),
  check: (voice, t) => {
    knock(voice, t, 0.6);
    knock(voice, t + 0.13, 0.48);
  },
  fold: (voice, t) => {
    noise(voice, t, { filter: 'bandpass', freq: 700, freqEnd: 2800, q: 0.7, attack: 0.09, decay: 0.2, peak: 0.55 });
    noise(voice, t + 0.05, { filter: 'lowpass', freq: 500, attack: 0.05, decay: 0.15, peak: 0.25 });
  },
  allin: (voice, t) => {
    noise(voice, t, { filter: 'lowpass', freq: 380, freqEnd: 220, attack: 0.08, decay: 0.42, peak: 0.45 });
    chipShower(voice, t + 0.03, 12, 0.5, 0.72);
  },
  win: (voice, t) => {
    [NOTE.C5, NOTE.E5, NOTE.G5, NOTE.C6].forEach((freq, index) => bell(voice, t + index * 0.09, freq, 0.9, 0.2));
    bell(voice, t + 0.38, NOTE.E6, 0.7, 0.09);
    chipShower(voice, t + 0.02, 4, 0.18, 0.35);
  },
  bounty: (voice, t) => {
    brass(voice, t, NOTE.G4, 0.11, 0.09);
    brass(voice, t + 0.14, NOTE.G4, 0.11, 0.09);
    brass(voice, t + 0.28, NOTE.G4, 0.11, 0.09);
    [NOTE.C5, NOTE.E5, NOTE.G5].forEach((freq) => brass(voice, t + 0.42, freq, 0.85, 0.07));
    bell(voice, t + 0.42, NOTE.C6, 1.0, 0.16);
    bell(voice, t + 0.56, NOTE.E6, 0.8, 0.08);
    chipShower(voice, t + 0.5, 10, 0.55, 0.5);
  },
  turn: (voice, t) => {
    bell(voice, t, NOTE.E5, 0.45, 0.36);
    bell(voice, t + 0.17, NOTE.A5, 0.65, 0.36);
  },
  timeWarning: (voice, t) => {
    tone(voice, t, { freq: 1500, type: 'triangle', decay: 0.035, peak: 0.42, attack: 0.001 });
    noise(voice, t, { filter: 'highpass', freq: 4000, decay: 0.01, peak: 0.2, attack: 0.001 });
    tone(voice, t + 0.24, { freq: 1180, type: 'triangle', decay: 0.035, peak: 0.36, attack: 0.001 });
    noise(voice, t + 0.24, { filter: 'highpass', freq: 4000, decay: 0.01, peak: 0.16, attack: 0.001 });
  },
  draw: (voice, t) => {
    cardFlick(voice, t, 0.55);
    noise(voice, t + 0.13, { filter: 'highpass', freq: 1900, decay: 0.03, peak: 0.4 });
    tone(voice, t + 0.13, { freq: 170, freqEnd: 90, decay: 0.06, peak: 0.25 });
  },
  message: (voice, t) => {
    tone(voice, t, { freq: 520, freqEnd: 980, decay: 0.09, peak: 0.3, attack: 0.005 });
    tone(voice, t + 0.07, { freq: 1180, decay: 0.08, peak: 0.1, attack: 0.004 });
  },
};

/** Približná dĺžka zvuku v sekundách (vrátane dozvuku). */
export const SOUND_DURATIONS: Record<SoundName, number> = {
  deal: 0.15,
  flip: 0.16,
  chip: 0.12,
  chips: 0.32,
  check: 0.26,
  fold: 0.32,
  allin: 0.6,
  win: 1.15,
  bounty: 1.7,
  turn: 0.85,
  timeWarning: 0.3,
  draw: 0.22,
  message: 0.17,
};

/** Naplánuje zvuk `name` do uzla `out` v čase `t` (sekundy kontextu). */
export function synthesize(ctx: BaseAudioContext, out: AudioNode, name: SoundName, t: number, volume = 1): void {
  SYNTHS[name]({ ctx, out, vol: volume }, t);
}
