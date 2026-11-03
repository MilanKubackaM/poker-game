import { useEffect, useRef } from 'react';
import type { TableEvent, TableView } from '../../../shared/types';
import { playSound } from './engine';
import { getSoundPreferences } from './preferences';
import { soundsForTransition, timeWarningPlan } from './transitions';

/**
 * Prehráva zvuky hry podľa zmien `TableView`. Prvý stav po pripojení (aj po zmene stola/hráča alebo návrate z `null`)
 * slúži len ako východisko. Efekty sa riadia „Zvukové efekty“, zvuk ťahu a tikanie „Upozornenie na ťah“.
 */
export function useGameSounds(view: TableView | null): void {
  const previousRef = useRef<TableView | null>(null);
  const clockOffsetRef = useRef(0);
  const firedRef = useRef<{ key: string | null; ids: Set<string> }>({ key: null, ids: new Set() });

  useEffect(() => {
    const previous = previousRef.current;
    previousRef.current = view;
    if (!view || previous === view) {
      return;
    }
    clockOffsetRef.current = view.serverTime - Date.now();
    if (!previous || previous.code !== view.code || previous.youId !== view.youId) {
      return;
    }
    const cues = soundsForTransition(previous, view, view.youId, getSoundPreferences(), Date.now() + clockOffsetRef.current);
    for (const cue of cues) {
      playSound(cue.sound, { delayMs: cue.delayMs, volume: cue.volume });
    }
  }, [view]);

  useEffect(() => {
    if (!view) {
      return;
    }
    const plan = timeWarningPlan(view, view.youId, Date.now() + clockOffsetRef.current);
    if (!plan) {
      return;
    }
    if (firedRef.current.key !== plan.key) {
      firedRef.current = { key: plan.key, ids: new Set() };
    }
    const fired = firedRef.current;
    const timers = plan.cues
      .filter((cue) => !fired.ids.has(cue.id))
      .map((cue) =>
        window.setTimeout(() => {
          if (fired.ids.has(cue.id)) {
            return;
          }
          fired.ids.add(cue.id);
          if (getSoundPreferences().turnAlert) {
            playSound(cue.sound, cue.volume === undefined ? {} : { volume: cue.volume });
          }
        }, cue.delayMs),
      );
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [view]);
}

/**
 * Jemný zvuk pri novej správe v chate od iného hráča. Sleduje najvyššie `id` chat udalosti (zoznam udalostí
 * sa v App orezáva na 200 a pri reconnecte nahrádza históriou, takže počet správ nie je spoľahlivý).
 */
export function useChatSound(events: readonly TableEvent[], youId: string | null | undefined): void {
  const lastIdRef = useRef<number | null>(null);
  const youIdRef = useRef(youId);

  useEffect(() => {
    if (youIdRef.current !== youId) {
      youIdRef.current = youId;
      lastIdRef.current = null;
    }
    let latest: number | null = null;
    for (const event of events) {
      if (event.kind === 'chat' && event.playerId !== youId && (latest === null || event.id > latest)) {
        latest = event.id;
      }
    }
    if (latest === null) {
      return;
    }
    const previous = lastIdRef.current;
    lastIdRef.current = previous === null ? latest : Math.max(previous, latest);
    if (previous !== null && latest > previous && getSoundPreferences().effects) {
      playSound('message');
    }
  }, [events, youId]);
}
