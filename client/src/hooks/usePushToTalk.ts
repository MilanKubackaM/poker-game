import { useEffect, useState } from 'react';
import { useSoundPreferences } from '../sound';

const DESKTOP_QUERY = '(hover: hover) and (pointer: fine)';

function isTyping(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) {
    return false;
  }
  const tag = element.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || element.isContentEditable;
}

/**
 * Push-to-talk na desktope: kým je zapnutý, audio stopy mikrofónu vysielajú len počas držania zvoleného klávesu.
 * Pri písaní do poľa (chat, sumy) sa kláves ignoruje; pri strate fokusu okna sa mikrofón hneď stlmí.
 */
export function usePushToTalk(stream: MediaStream | null, microphone: boolean, tracksVersion: number): { key: string; talking: boolean } | null {
  const [prefs] = useSoundPreferences();
  const [talking, setTalking] = useState(false);
  const [desktop] = useState(() => typeof window !== 'undefined' && window.matchMedia(DESKTOP_QUERY).matches);
  const active = desktop && prefs.pushToTalk && microphone;
  const key = prefs.pushToTalkKey;

  useEffect(() => {
    if (!active) {
      setTalking(false);
      return;
    }
    const onDown = (event: KeyboardEvent) => {
      if (event.code !== key || isTyping(event.target)) {
        return;
      }
      event.preventDefault();
      if (!event.repeat) {
        setTalking(true);
      }
    };
    const onUp = (event: KeyboardEvent) => {
      if (event.code === key) {
        setTalking(false);
      }
    };
    const release = () => setTalking(false);
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    window.addEventListener('blur', release);
    document.addEventListener('visibilitychange', release);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
      window.removeEventListener('blur', release);
      document.removeEventListener('visibilitychange', release);
    };
  }, [active, key]);

  useEffect(() => {
    for (const track of stream?.getAudioTracks() ?? []) {
      track.enabled = !active || talking;
    }
  }, [stream, active, talking, tracksVersion]);

  return active ? { key, talking } : null;
}
