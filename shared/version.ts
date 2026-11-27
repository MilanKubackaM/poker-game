/**
 * Verzia hry (semver). Musí sedieť s `package.json` — kontroluje to test `server/test/version.test.ts`.
 * Server ju posiela klientom (`server:version`); klient so staršou verziou ponúkne obnovenie stránky.
 */
export const APP_VERSION = '1.2.0';

/** Server → klient hneď po pripojení socketu. */
export interface ServerVersionPayload {
  version: string;
  /** Odtlačok buildu klienta, ktorý server práve servuje (`buildFingerprint`); chýba pri vývoji bez buildu. */
  build?: string;
}

/**
 * Odtlačok buildu klienta: zoradené cesty `/assets/…` z `index.html`. Vite ich pomenúva podľa obsahu, takže sa zmenia
 * pri každej zmene kódu alebo štýlov aj bez zvýšenia `APP_VERSION` — a rovnaký zdroj dá rovnaký odtlačok (build ostáva
 * reprodukovateľný pre tools/verify-client.ts). Server ho číta zo súboru, klient z vlastného `<head>` pri načítaní.
 * Bez jedinej takej cesty (vývoj cez Vite) vráti null a porovnáva sa len `APP_VERSION`.
 */
export function buildFingerprint(urls: Iterable<string | null | undefined>): string | null {
  const assets = new Set<string>();
  for (const url of urls) {
    if (url && url.startsWith('/assets/')) {
      assets.add(url);
    }
  }
  return assets.size > 0 ? [...assets].sort().join(' ') : null;
}

/** Cesty z atribútov `src` / `href` v HTML (pre `buildFingerprint` na serveri). */
export function htmlAssetUrls(html: string): string[] {
  return [...html.matchAll(/\s(?:src|href)="([^"]+)"/g)].map((match) => match[1]);
}
