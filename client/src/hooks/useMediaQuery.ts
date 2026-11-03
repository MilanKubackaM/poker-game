import { useEffect, useState } from 'react';

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const listener = () => setMatches(media.matches);
    listener();
    media.addEventListener('change', listener);
    return () => media.removeEventListener('change', listener);
  }, [query]);
  return matches;
}

/** Bočný panel je na širokej obrazovke stále vedľa stola (pod 1100 px sa otvára tlačidlom 💬). */
export const SIDE_PANEL_DOCKED_QUERY = '(min-width: 1101px)';
