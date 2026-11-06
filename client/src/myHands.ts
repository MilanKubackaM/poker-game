import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { MyHandRecord } from '../../shared/types';
import { emit } from './socket';

/** Načíta moje karty a výsledky z histórie; null = server to nevie (starší server, výpadok) — riadok sa vtedy neukáže. */
export type MyHandsLoader = () => Promise<MyHandRecord[] | null>;

/** Po pribudnutí ruky počkáme, kým server dopíše výsledok (a kým sa nenazbiera viac rúk naraz). */
const REFETCH_DEBOUNCE_MS = 600;

async function loadFromServer(): Promise<MyHandRecord[] | null> {
  const response = await emit<MyHandRecord[]>('history:mine');
  return response.ok && Array.isArray(response.data) ? response.data : null;
}

/** Odkiaľ sa berú moje ruky; demo podstrčí ukážkové dáta, aby sa nepripájalo k serveru. */
export const MyHandsContext = createContext<MyHandsLoader>(loadFromServer);

const empty = new Map<number, MyHandRecord>();

/**
 * Moje ruky z histórie podľa čísla ruky. Načíta sa pri otvorení histórie a znova, keď pribudne nová ruka
 * (`latestHand` = číslo najnovšej ruky; dĺžka histórie po naplnení limitu už nerastie).
 */
export function useMyHands(latestHand: number | null): Map<number, MyHandRecord> {
  const load = useContext(MyHandsContext);
  const [records, setRecords] = useState(empty);
  const loadedRef = useRef(false);

  useEffect(() => {
    if (latestHand === null) {
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(
      () => {
        load()
          .then((list) => {
            if (cancelled || !list) {
              return;
            }
            loadedRef.current = true;
            setRecords(new Map(list.map((record) => [record.handNumber, record])));
          })
          .catch(() => undefined);
      },
      loadedRef.current ? REFETCH_DEBOUNCE_MS : 0,
    );
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [latestHand, load]);

  return records;
}
