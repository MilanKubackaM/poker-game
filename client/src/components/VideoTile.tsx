import { useEffect, useRef } from 'react';
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

export function RemoteAudio({ stream }: { stream: MediaStream }) {
  const [{ voiceVolume, muted }] = useSoundPreferences();
  const audioRef = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }
    if (audio.srcObject !== stream) {
      audio.srcObject = stream;
    }
    audio.play().catch(() => undefined);
  }, [stream]);
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume = voiceVolume;
      audioRef.current.muted = muted;
    }
  }, [voiceVolume, muted]);
  return <audio ref={audioRef} autoPlay />;
}
