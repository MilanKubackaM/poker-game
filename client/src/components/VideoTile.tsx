import { useEffect, useRef, useState } from 'react';
import { usePlayerAudio } from '../playerAudio';
import { useSoundPreferences } from '../sound';

interface VideoTileProps {
  stream: MediaStream;
  mirrored?: boolean;
}

export function VideoTile({ stream, mirrored }: VideoTileProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    if (video.srcObject !== stream) {
      video.srcObject = stream;
    }
    video.play().catch(() => undefined);
  }, [stream]);
  return <video ref={videoRef} className={mirrored ? 'seat-video mirrored' : 'seat-video'} autoPlay playsInline muted />;
}

// ---------------------------------------------------------------------------------------------------------------------
// Prehrávanie hlasu ostatných hráčov
// ---------------------------------------------------------------------------------------------------------------------

/** Čakajúce pokusy o `play()`, ktoré prehliadač zablokoval (autoplay) — zopakujú sa pri najbližšom geste. */
const gestureWaiters = new Set<() => void>();
const GESTURES = ['pointerdown', 'keydown', 'touchend'] as const;

function onGesture(): void {
  const waiters = [...gestureWaiters];
  gestureWaiters.clear();
  for (const type of GESTURES) {
    window.removeEventListener(type, onGesture);
  }
  for (const waiter of waiters) {
    waiter();
  }
}

function waitForGesture(callback: () => void): () => void {
  if (gestureWaiters.size === 0) {
    for (const type of GESTURES) {
      window.addEventListener(type, onGesture, { passive: true });
    }
  }
  gestureWaiters.add(callback);
  return () => {
    gestureWaiters.delete(callback);
  };
}

/** Spustí prehrávanie; ak ho prehliadač zablokuje, skúsi znova pri najbližšom kliknutí / klávese. */
function playWhenAllowed(media: HTMLMediaElement): () => void {
  let cancelled = false;
  let cancelWait: (() => void) | null = null;
  const attempt = () => {
    cancelWait = null;
    media.play().catch(() => {
      if (!cancelled) {
        cancelWait = waitForGesture(attempt);
      }
    });
  };
  attempt();
  return () => {
    cancelled = true;
    cancelWait?.();
  };
}

type AudioContextConstructor = new () => AudioContext;

let playback: AudioContext | null = null;
let playbackUnavailable = false;

/** AudioContext na zosilnenie hlasu nad 100 % (spustí sa až po geste používateľa). */
function playbackContext(): AudioContext | null {
  if (playback || playbackUnavailable || typeof window === 'undefined') {
    return playback;
  }
  const scope = window as unknown as { AudioContext?: AudioContextConstructor; webkitAudioContext?: AudioContextConstructor };
  const Ctor = scope.AudioContext ?? scope.webkitAudioContext;
  if (!Ctor) {
    playbackUnavailable = true;
    return null;
  }
  try {
    playback = new Ctor();
  } catch {
    playbackUnavailable = true;
    return null;
  }
  const context = playback;
  const resume = () => {
    if (context.state !== 'running') {
      void context.resume().catch(() => undefined);
    }
  };
  for (const type of GESTURES) {
    window.addEventListener(type, resume, { passive: true });
  }
  resume();
  return context;
}

/** Beží AudioContext na zosilnenie? Kým nie (žiadne gesto), hrá sa cez prvok `<audio>` s hlasitosťou max. 100 %. */
function useBoostContext(wanted: boolean): AudioContext | null {
  const [context, setContext] = useState<AudioContext | null>(null);
  useEffect(() => {
    if (!wanted) {
      setContext(null);
      return;
    }
    const candidate = playbackContext();
    if (!candidate) {
      return;
    }
    const sync = () => setContext(candidate.state === 'running' ? candidate : null);
    sync();
    candidate.addEventListener('statechange', sync);
    return () => candidate.removeEventListener('statechange', sync);
  }, [wanted]);
  return context;
}

/**
 * Hlas jedného hráča. Hlasitosť = celková hlasitosť hlasu × hlasitosť hráča (0–150 %); stlmené, ak je stlmený zvuk
 * alebo hráč. Nad 100 % ide zvuk cez Web Audio (GainNode) — prvok `<audio>` vtedy ostáva pripojený, ale stlmený:
 * Chrome vzdialený WebRTC zvuk do Web Audio pustí len vtedy, keď stream zároveň hrá aj v prvku.
 */
export function RemoteAudio({ stream, playerId }: { stream: MediaStream; playerId: string }) {
  const [{ voiceVolume, muted }] = useSoundPreferences();
  const [setting] = usePlayerAudio(playerId);
  const level = muted || setting.muted ? 0 : voiceVolume * setting.volume;
  const boostContext = useBoostContext(level > 1);
  const boosted = level > 1 && !!boostContext;
  const audioRef = useRef<HTMLAudioElement>(null);
  const gainRef = useRef<GainNode | null>(null);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }
    if (audio.srcObject !== stream) {
      audio.srcObject = stream;
    }
    return playWhenAllowed(audio);
  }, [stream]);

  useEffect(() => {
    if (!boosted || !boostContext || stream.getAudioTracks().length === 0) {
      return;
    }
    let source: MediaStreamAudioSourceNode;
    try {
      source = boostContext.createMediaStreamSource(stream);
    } catch {
      return;
    }
    const gain = boostContext.createGain();
    source.connect(gain);
    gain.connect(boostContext.destination);
    gainRef.current = gain;
    return () => {
      gainRef.current = null;
      source.disconnect();
      gain.disconnect();
    };
  }, [boosted, boostContext, stream]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }
    const gain = gainRef.current;
    if (boosted && gain) {
      audio.muted = true;
      gain.gain.value = level;
      return;
    }
    // iOS hlasitosť prvku ignoruje (vždy 100 %) — tam funguje len stlmenie.
    audio.muted = level === 0;
    audio.volume = Math.min(1, Math.max(0, level));
  }, [boosted, level, stream]);

  return <audio ref={audioRef} autoPlay />;
}

/** Má stream živú audio stopu (nezávisle od príznaku mikrofónu zo servera)? */
export function hasLiveAudio(stream: MediaStream): boolean {
  return stream.getAudioTracks().some((track) => track.readyState === 'live');
}
