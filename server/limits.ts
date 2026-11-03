/**
 * Ochrana verejného servera pred zahltením: limity zakladania stolov (na IP aj celkovo), spojení, požiadaviek a veľkosti stolov.
 * Všetky hodnoty sa dajú prepísať premennými prostredia (`LIMIT_*`), predvolené sú nastavené pre partie kamarátov.
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

export const LIMITS = {
  /** Nové stoly z jednej IP (siete) za hodinu / za deň. */
  createPerIpHour: envInt('LIMIT_CREATE_PER_IP_HOUR', 3),
  createPerIpDay: envInt('LIMIT_CREATE_PER_IP_DAY', 10),
  /** Nové stoly na celom serveri za hodinu / za deň — chráni aj pred útokom z mnohých IP. */
  createGlobalHour: envInt('LIMIT_CREATE_GLOBAL_HOUR', 30),
  createGlobalDay: envInt('LIMIT_CREATE_GLOBAL_DAY', 100),
  /** Najviac stolov uložených naraz. */
  maxTables: envInt('LIMIT_MAX_TABLES', 300),
  /** Pripojenia nového hráča ku stolu (`table:join`) z jednej IP / celkovo za hodinu. */
  joinPerIpHour: envInt('LIMIT_JOIN_PER_IP_HOUR', 30),
  joinGlobalHour: envInt('LIMIT_JOIN_GLOBAL_HOUR', 600),
  /** Vyhľadanie stola podľa kódu / návrat s tokenom z jednej IP za minútu (proti hádaniu kódov). */
  lookupsPerIpMinute: envInt('LIMIT_LOOKUPS_PER_IP_MINUTE', 60),
  /** Súčasné spojenia z jednej IP (celá domácnosť / Wi-Fi) a celkovo. */
  connectionsPerIp: envInt('LIMIT_CONNECTIONS_PER_IP', 30),
  connectionsTotal: envInt('LIMIT_CONNECTIONS_TOTAL', 1000),
  /** Bežné herné požiadavky jedného spojenia: priemer za sekundu a krátkodobá rezerva. */
  eventsPerSecond: envInt('LIMIT_EVENTS_PER_SECOND', 15),
  eventsBurst: envInt('LIMIT_EVENTS_BURST', 40),
  /** WebRTC signalizácia (pri pripájaní 9 kamier ide naraz veľa správ). */
  rtcPerSecond: envInt('LIMIT_RTC_PER_SECOND', 60),
  rtcBurst: envInt('LIMIT_RTC_BURST', 300),
  /** Po toľkých odmietnutých požiadavkách za minútu sa spojenie odpojí. */
  rejectionsBeforeDisconnect: envInt('LIMIT_REJECTIONS_BEFORE_DISCONNECT', 200),
  /** Členovia stola (pri stole + odídení so žetónmi) a záznamy v transakciách jedného stola. */
  maxMembersPerTable: envInt('LIMIT_MAX_MEMBERS_PER_TABLE', 40),
  /** Žiadosti o prístup ku stolu: najviac čakajúcich na stôl / z jednej IP, platnosť a pauza po zamietnutí. */
  joinRequestsPerTable: envInt('LIMIT_JOIN_REQUESTS_PER_TABLE', 10),
  joinRequestsPerIp: envInt('LIMIT_JOIN_REQUESTS_PER_IP', 3),
  joinRequestTtlMs: envInt('LIMIT_JOIN_REQUEST_TTL_MINUTES', 15) * 60 * 1000,
  joinRejectCooldownMs: envInt('LIMIT_JOIN_REJECT_COOLDOWN_MINUTES', 5) * 60 * 1000,
  maxLedgerEntries: envInt('LIMIT_MAX_LEDGER_ENTRIES', 5000),
  /** Nepoužitý stôl (žiadna ruka, nikto okrem zakladateľa) sa zmaže po tejto dobe bez aktivity. */
  unusedTableRetentionMs: envInt('LIMIT_UNUSED_TABLE_RETENTION_HOURS', 24) * HOUR,
} as const;

export const WINDOWS = { MINUTE: 60 * 1000, HOUR, DAY } as const;

/** Počítadlo v pevných oknách (napr. „najviac 3 za hodinu“) pre ľubovoľné kľúče; staré kľúče sa priebežne zahadzujú. */
export class WindowCounter {
  private readonly counts = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys = 50_000,
  ) {}

  /** Zostáva v limite po pripočítaní? Nepripočíta nič (na kontrolu viacerých limitov pred zápisom). */
  allows(key: string, now = Date.now()): boolean {
    const entry = this.counts.get(key);
    return !entry || entry.resetAt <= now || entry.count < this.limit;
  }

  add(key: string, now = Date.now()): void {
    const entry = this.counts.get(key);
    if (!entry || entry.resetAt <= now) {
      if (this.counts.size >= this.maxKeys) {
        this.prune(now);
      }
      this.counts.set(key, { count: 1, resetAt: now + this.windowMs });
      return;
    }
    entry.count += 1;
  }

  /** `allows` + `add` naraz. */
  hit(key: string, now = Date.now()): boolean {
    if (!this.allows(key, now)) {
      return false;
    }
    this.add(key, now);
    return true;
  }

  private prune(now: number): void {
    for (const [key, entry] of this.counts) {
      if (entry.resetAt <= now) {
        this.counts.delete(key);
      }
    }
    if (this.counts.size >= this.maxKeys) {
      this.counts.clear();
    }
  }
}

/** Token bucket jedného spojenia: `rate` tokenov za sekundu, najviac `burst` naraz. */
export class TokenBucket {
  private tokens: number;
  private updatedAt: number;

  constructor(
    private readonly rate: number,
    private readonly burst: number,
    now = Date.now(),
  ) {
    this.tokens = burst;
    this.updatedAt = now;
  }

  take(now = Date.now()): boolean {
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.updatedAt) / 1000) * this.rate);
    this.updatedAt = now;
    if (this.tokens < 1) {
      return false;
    }
    this.tokens -= 1;
    return true;
  }
}

export type TrustProxy = 'off' | 'xff' | 'cloudflare';

export function trustProxyFromEnv(value = process.env.TRUST_PROXY): TrustProxy {
  const normalized = (value ?? '').trim().toLowerCase();
  if (normalized === 'xff' || normalized === 'tailscale' || normalized === 'caddy') {
    return 'xff';
  }
  if (normalized === 'cloudflare') {
    return 'cloudflare';
  }
  return 'off';
}

/**
 * Kľúč klienta pre limity. Hlavičky sa berú len za dôveryhodnou proxy (`TRUST_PROXY`), inak by si ich útočník podvrhol:
 * `xff` = posledná položka X-Forwarded-For (Tailscale Funnel ju nastaví, Caddy ju pripojí na koniec),
 * `cloudflare` = CF-Connecting-IP. IPv6 sa zoskupí podľa /64 — jedna domácnosť/útočník ich má celý blok.
 */
export function clientKey(remoteAddress: string | undefined, headers: Record<string, string | string[] | undefined>, trust: TrustProxy): string {
  let address = remoteAddress ?? '';
  if (trust === 'xff') {
    const forwarded = headerValue(headers['x-forwarded-for']);
    const last = forwarded?.split(',').map((part) => part.trim()).filter(Boolean).pop();
    if (last) {
      address = last;
    }
  } else if (trust === 'cloudflare') {
    const connecting = headerValue(headers['cf-connecting-ip'])?.trim();
    if (connecting) {
      address = connecting;
    }
  }
  return normalizeAddress(address);
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[value.length - 1] : value;
}

export function normalizeAddress(raw: string): string {
  let address = raw.trim().toLowerCase();
  if (address.startsWith('[')) {
    address = address.slice(1, address.indexOf(']') > 0 ? address.indexOf(']') : undefined);
  }
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) {
    return mapped[1];
  }
  if (/^\d+\.\d+\.\d+\.\d+(:\d+)?$/.test(address)) {
    return address.split(':')[0];
  }
  if (address.includes(':')) {
    return `${expandIpv6(address).slice(0, 4).join(':')}::/64`;
  }
  return address || 'unknown';
}

function expandIpv6(address: string): string[] {
  const withoutZone = address.split('%')[0];
  const [head, tail] = withoutZone.split('::');
  const left = head ? head.split(':') : [];
  const right = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const missing = tail === undefined ? 0 : Math.max(0, 8 - left.length - right.length);
  return [...left, ...Array<string>(missing).fill('0'), ...right].map((part) => part.replace(/^0+(?=.)/, '') || '0');
}

/**
 * Prehliadač z cudzej stránky nesmie ovládať hru (inak by útočník rozložil zakladanie stolov na IP návštevníkov svojej stránky).
 * Bez hlavičky Origin (nie prehliadač) je spojenie povolené; s ňou musí sedieť s Host alebo byť v ALLOWED_ORIGINS.
 */
export function originAllowed(origin: string | undefined, host: string | undefined, allowed: string[]): boolean {
  if (!origin) {
    return true;
  }
  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }
  if (host && originHost === host.toLowerCase()) {
    return true;
  }
  return allowed.some((entry) => entry.toLowerCase() === origin.toLowerCase() || entry.toLowerCase() === originHost);
}
