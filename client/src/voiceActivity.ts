import { useEffect, useRef, useState } from 'react';
import { nextSpeakState, rmsLevel, type SpeakState } from './voiceLevel';

const SAMPLE_MS = 100;

type AudioContextConstructor = new () => AudioContext;

let context: AudioContext | null = null;
let unavailable = false;

/** Vlastný AudioContext len na meranie hlasu (nič nehrá) — nezávislý od stlmenia zvukových efektov. */
function analysisContext(): AudioContext | null {
  if (context || unavailable || typeof window === 'undefined') {
    return context;
  }
  const scope = window as unknown as { AudioContext?: AudioContextConstructor; webkitAudioContext?: AudioContextConstructor };
  const Ctor = scope.AudioContext ?? scope.webkitAudioContext;
  if (!Ctor) {
    unavailable = true;
    return null;
  }
  try {
    context = new Ctor();
  } catch {
    unavailable = true;
    return null;
  }
  // Prehliadač spustí AudioContext až po geste používateľa — dovtedy meranie vracia ticho.
  const resume = () => {
    if (context && context.state !== 'running') {
      void context.resume().catch(() => undefined);
    }
  };
  for (const type of ['pointerdown', 'keydown', 'touchend'] as const) {
    window.addEventListener(type, resume, { passive: true });
  }
  resume();
  return context;
}

interface Meter {
  stream: MediaStream;
  trackIds: string;
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  samples: Uint8Array<ArrayBuffer>;
}

function audioTrackIds(stream: MediaStream): string {
  return stream
    .getAudioTracks()
    .map((track) => track.id)
    .join(',');
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((id) => b.has(id));
}

/**
 * Kto práve hovorí: meria hlasitosť mikrofónu každého hráča (`sources` = id hráča → stream s audiom, len tí so zapnutým
 * mikrofónom). Pri vlastnom streame je ticho aj vypnutý mikrofón či nestlačený push-to-talk (stopa je `enabled = false`).
 * Vráti novú množinu len pri zmene, takže stôl sa neprekresľuje každých 100 ms.
 */
export function useSpeakingIds(sources: ReadonlyMap<string, MediaStream>): ReadonlySet<string> {
  const [speaking, setSpeaking] = useState<ReadonlySet<string>>(() => new Set());
  const meters = useRef(new Map<string, Meter>());
  const states = useRef(new Map<string, SpeakState>());
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;
  const key = [...sources.entries()].map(([id, stream]) => `${id}:${stream.id}:${audioTrackIds(stream)}`).join('|');

  useEffect(() => {
    const ctx = key ? analysisContext() : null;
    const current = meters.current;
    for (const [id, meter] of current) {
      const stream = sourcesRef.current.get(id);
      if (!stream || stream !== meter.stream || audioTrackIds(stream) !== meter.trackIds) {
        meter.source.disconnect();
        current.delete(id);
        states.current.delete(id);
      }
    }
    if (!ctx) {
      return;
    }
    for (const [id, stream] of sourcesRef.current) {
      if (current.has(id) || stream.getAudioTracks().length === 0) {
        continue;
      }
      try {
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        current.set(id, { stream, trackIds: audioTrackIds(stream), source, analyser, samples: new Uint8Array(analyser.fftSize) });
      } catch {
        continue;
      }
    }
  }, [key]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = Date.now();
      const next = new Set<string>();
      for (const [id, meter] of meters.current) {
        const live = meter.stream.getAudioTracks().some((track) => track.enabled && track.readyState === 'live' && !track.muted);
        meter.analyser.getByteTimeDomainData(meter.samples);
        const state = nextSpeakState(states.current.get(id) ?? { speaking: false, lastLoudAt: 0 }, live ? rmsLevel(meter.samples) : 0, now);
        states.current.set(id, state);
        if (state.speaking) {
          next.add(id);
        }
      }
      setSpeaking((previous) => (sameSet(previous, next) ? previous : next));
    }, SAMPLE_MS);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(
    () => () => {
      for (const meter of meters.current.values()) {
        meter.source.disconnect();
      }
      meters.current.clear();
    },
    [],
  );

  return speaking;
}
