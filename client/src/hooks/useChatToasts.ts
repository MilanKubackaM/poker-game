import { useCallback, useEffect, useRef, useState } from 'react';
import type { TableEvent } from '../../../shared/types';

export interface ChatToastItem {
  id: number;
  playerId?: string;
  text: string;
  /** `mode` = upozornenie na zapnutie/vypnutie módu hry (bez autora). */
  kind: 'chat' | 'mode';
  /** Práve odchádza (animácia) — o chvíľu zmizne zo zoznamu. */
  leaving: boolean;
}

/** Mobil / úzke okno: posledné 3 správy, každá 10 s. */
export const CHAT_TOAST_MAX = 3;
export const CHAT_TOAST_TTL_MS = 10_000;
/** Desktop s bočným panelom: posledných 5 správ, každá 15 s (vľavo hore nad stolom). */
export const CHAT_TOAST_MAX_DOCKED = 5;
export const CHAT_TOAST_TTL_DOCKED_MS = 15_000;
const CHAT_TOAST_EXIT_MS = 320;

/**
 * Nové chat správy (aj vlastné) a upozornenia na módy ako toasty. Správy, ktoré prišli s históriou pri pripojení / obnovení
 * (`resetKey` sa zmení pri každom `table:history`), sa iba zapamätajú ako prečítané.
 */
export function useChatToasts(events: readonly TableEvent[], youId: string | null | undefined, resetKey: number, docked = false) {
  const max = docked ? CHAT_TOAST_MAX_DOCKED : CHAT_TOAST_MAX;
  const ttlMs = docked ? CHAT_TOAST_TTL_DOCKED_MS : CHAT_TOAST_TTL_MS;
  const [toasts, setToasts] = useState<ChatToastItem[]>([]);
  const toastsRef = useRef<ChatToastItem[]>([]);
  const lastIdRef = useRef<number | null>(null);
  const baselineRef = useRef<{ resetKey: number; youId: string | null | undefined } | null>(null);
  const timersRef = useRef(new Set<number>());

  const commit = useCallback((next: ChatToastItem[]) => {
    toastsRef.current = next;
    setToasts(next);
  }, []);

  const later = useCallback((callback: () => void, delay: number) => {
    const timer = window.setTimeout(() => {
      timersRef.current.delete(timer);
      callback();
    }, delay);
    timersRef.current.add(timer);
  }, []);

  const dismiss = useCallback(
    (ids: number[]) => {
      const leaving = new Set(ids);
      commit(toastsRef.current.map((toast) => (leaving.has(toast.id) ? { ...toast, leaving: true } : toast)));
      later(() => commit(toastsRef.current.filter((toast) => !leaving.has(toast.id))), CHAT_TOAST_EXIT_MS);
    },
    [commit, later],
  );

  useEffect(() => {
    let latest = 0;
    for (const event of events) {
      if ((event.kind === 'chat' || event.kind === 'mode') && event.id > latest) {
        latest = event.id;
      }
    }
    const baseline = baselineRef.current;
    if (!baseline || baseline.resetKey !== resetKey || baseline.youId !== youId || lastIdRef.current === null) {
      baselineRef.current = { resetKey, youId };
      lastIdRef.current = latest;
      return;
    }
    const since = lastIdRef.current;
    lastIdRef.current = Math.max(since, latest);
    const fresh = events
      .filter((event) => event.id > since && (event.kind === 'chat' || event.kind === 'mode'))
      .slice(-max)
      .map((event): ChatToastItem => ({ id: event.id, playerId: event.playerId, text: event.text, kind: event.kind === 'mode' ? 'mode' : 'chat', leaving: false }));
    if (fresh.length === 0) {
      return;
    }
    const next = [...toastsRef.current, ...fresh];
    const active = next.filter((toast) => !toast.leaving);
    commit(next);
    if (active.length > max) {
      dismiss(active.slice(0, active.length - max).map((toast) => toast.id));
    }
    for (const toast of fresh) {
      later(() => {
        if (toastsRef.current.some((candidate) => candidate.id === toast.id && !candidate.leaving)) {
          dismiss([toast.id]);
        }
      }, ttlMs);
    }
  }, [events, youId, resetKey, commit, dismiss, later, max, ttlMs]);

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers) {
        window.clearTimeout(timer);
      }
      timers.clear();
    };
  }, []);

  const clear = useCallback(() => {
    if (toastsRef.current.length > 0) {
      commit([]);
    }
  }, [commit]);

  return { toasts, clear };
}
