import type { Avatar } from '../../shared/types';
import type { AccountTableStat } from '../../shared/account';

/** Verejný profil účtu tak, ako ho potrebujú stoly. */
export interface AccountProfile {
  id: string;
  username: string;
  /** Emoji + farba a `photo` (URL), ak má účet fotku. */
  avatar: Avatar;
  emailVerified: boolean;
}

/**
 * Rozhranie medzi účtami (`server/accounts/*`) a stolmi (`Table`, `SessionManager`, `server/index.ts`).
 * Stoly nepoznajú úložisko účtov — vidia len toto. V testoch stolov sa dá podstrčiť jednoduchá mapa.
 */
export interface AccountDirectory {
  /** Profil účtu, alebo undefined (neexistuje / zmazaný). */
  profile(userId: string): AccountProfile | undefined;
  /** Uloží (prepíše) štatistiku účtu pri jednom stole — volá sa po uložení stola. */
  recordTableStat(userId: string, stat: AccountTableStat): void;
  /** Stôl zmizol (zmazanie / expirácia) — štatistiky ostávajú, len sa označia `deleted`. */
  markTableDeleted(code: string): void;
}
