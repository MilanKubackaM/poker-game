import { readFileSync, statSync } from 'node:fs';
import type { ClientConfig } from '../shared/types';

type IceServer = ClientConfig['iceServers'][number];

/** Prihlasovacie údaje platia 24 h a sidecar ich obnovuje každú hodinu; staršie ako 20 h sa už nerozdávajú. */
export const CLOUDFLARE_MAX_AGE_MS = 20 * 3600_000;
const MAX_SERVERS = 8;
const MAX_URLS = 12;

/** Port 53 prehliadače blokujú — taká adresa by len čakala na timeout. */
const PORT_53 = /:53(\?|$)/;
const ICE_URL = /^(stun|turns?):[\w.-]+(:\d{1,5})?(\?transport=(udp|tcp))?$/;

/**
 * Odpoveď Cloudflare `generate-ice-servers` → zoznam pre `RTCPeerConnection`. Ponechá len platné STUN/TURN adresy
 * (bez portu 53), TURN len s menom a heslom. Pri čomkoľvek neočakávanom vráti null (hra potom použije záložný relay).
 */
export function parseCloudflareIce(raw: unknown): IceServer[] | null {
  const list = (raw as { iceServers?: unknown } | null)?.iceServers;
  const entries = Array.isArray(list) ? list : list && typeof list === 'object' ? [list] : [];
  const servers: IceServer[] = [];
  for (const entry of entries.slice(0, MAX_SERVERS)) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const { urls, username, credential } = entry as Record<string, unknown>;
    const candidates = (Array.isArray(urls) ? urls : [urls]).filter((url): url is string => typeof url === 'string');
    const valid = candidates.slice(0, MAX_URLS).filter((url) => ICE_URL.test(url) && !PORT_53.test(url));
    const turn = valid.filter((url) => url.startsWith('turn'));
    const stun = valid.filter((url) => url.startsWith('stun:'));
    if (turn.length && typeof username === 'string' && typeof credential === 'string' && username && credential) {
      servers.push({ urls: turn, username: username.slice(0, 512), credential: credential.slice(0, 512) });
    }
    if (stun.length) {
      servers.push({ urls: stun });
    }
  }
  return servers.some((server) => server.username) ? servers : null;
}

/**
 * Súbor s prihlasovacími údajmi k Cloudflare TURN, ktorý zapisuje sidecar `turn-creds` (kontajner hry nemá prístup
 * na internet). Číta sa znova len pri zmene súboru.
 */
export class CloudflareIceFile {
  private cachedAt = -1;
  private cached: IceServer[] | null = null;

  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** Čas poslednej zmeny súboru (na zistenie obnovy), alebo null, ak súbor nie je. */
  version(): number | null {
    if (!this.file) {
      return null;
    }
    try {
      return statSync(this.file).mtimeMs;
    } catch {
      return null;
    }
  }

  servers(): IceServer[] | null {
    const version = this.version();
    if (version === null || this.now() - version > CLOUDFLARE_MAX_AGE_MS) {
      return null;
    }
    if (version !== this.cachedAt) {
      this.cachedAt = version;
      try {
        this.cached = parseCloudflareIce(JSON.parse(readFileSync(this.file, 'utf8')));
      } catch {
        this.cached = null;
      }
    }
    return this.cached;
  }
}
