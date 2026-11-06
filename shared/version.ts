/**
 * Verzia hry (semver). Musí sedieť s `package.json` — kontroluje to test `server/test/version.test.ts`.
 * Server ju posiela klientom (`server:version`); klient so staršou verziou ponúkne obnovenie stránky.
 */
export const APP_VERSION = '1.1.0';

/** Server → klient hneď po pripojení socketu. */
export interface ServerVersionPayload {
  version: string;
}
