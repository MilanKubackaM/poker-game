import { useCallback, useEffect, useRef, useState } from 'react';

export interface MediaState {
  stream: MediaStream | null;
  camera: boolean;
  microphone: boolean;
  version: number;
  error: string | null;
  toggleCamera: () => Promise<boolean>;
  toggleMicrophone: () => Promise<boolean>;
  stopAll: () => void;
}

function insecureMessage(): string {
  const httpsPort = (window as unknown as { __HTTPS_PORT__?: number | null }).__HTTPS_PORT__;
  const target = httpsPort ? `https://${window.location.hostname}:${httpsPort}${window.location.pathname}` : 'HTTPS adresu';
  return `Kamera a mikrofón fungujú len cez zabezpečené pripojenie. Otvor ${target} (alebo localhost).`;
}

export function useMedia(): MediaState {
  const streamRef = useRef<MediaStream | null>(null);
  const [camera, setCamera] = useState(false);
  const [microphone, setMicrophone] = useState(false);
  const [version, setVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const ensureStream = () => {
    if (!streamRef.current) {
      streamRef.current = new MediaStream();
    }
    return streamRef.current;
  };

  const toggle = useCallback(async (kind: 'video' | 'audio'): Promise<boolean> => {
    setError(null);
    const stream = ensureStream();
    const existing = kind === 'video' ? stream.getVideoTracks() : stream.getAudioTracks();
    const setOn = kind === 'video' ? setCamera : setMicrophone;
    if (existing.length) {
      for (const track of existing) {
        track.stop();
        stream.removeTrack(track);
      }
      setOn(false);
      setVersion((value) => value + 1);
      return false;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setError(insecureMessage());
      return false;
    }
    try {
      const constraints: MediaStreamConstraints = kind === 'video'
        ? { video: { width: { ideal: 480 }, height: { ideal: 480 }, frameRate: { ideal: 15, max: 20 }, facingMode: 'user' } }
        : { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } };
      const media = await navigator.mediaDevices.getUserMedia(constraints);
      for (const track of media.getTracks()) {
        stream.addTrack(track);
      }
      setOn(true);
      setVersion((value) => value + 1);
      return true;
    } catch (cause) {
      const name = (cause as DOMException)?.name;
      setError(
        name === 'NotAllowedError'
          ? 'Prístup ku kamere/mikrofónu bol zamietnutý — povoľ ho v nastaveniach prehliadača.'
          : name === 'NotFoundError'
            ? 'Nenašlo sa žiadne zariadenie.'
            : 'Zariadenie sa nepodarilo zapnúť.',
      );
      return false;
    }
  }, []);

  const stopAll = useCallback(() => {
    const stream = streamRef.current;
    if (stream) {
      for (const track of stream.getTracks()) {
        track.stop();
        stream.removeTrack(track);
      }
    }
    setCamera(false);
    setMicrophone(false);
    setVersion((value) => value + 1);
  }, []);

  useEffect(() => () => streamRef.current?.getTracks().forEach((track) => track.stop()), []);

  return {
    stream: streamRef.current,
    camera,
    microphone,
    version,
    error,
    toggleCamera: () => toggle('video'),
    toggleMicrophone: () => toggle('audio'),
    stopAll,
  };
}
