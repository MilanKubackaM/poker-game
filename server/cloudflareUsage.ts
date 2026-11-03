import { readFileSync, statSync } from 'node:fs';
import { CLOUDFLARE_FREE_BYTES, type CloudflareUsage } from '../shared/netstats';

/** Starší súbor ako 2 h znamená, že sidecar prestal sťahovať — čísla sa ukážu, ale s chybou. */
const STALE_MS = 2 * 3600_000;
const STALE_ERROR = 'Čísla sú staršie ako 2 h — sidecar turn-creds ich prestal sťahovať';

function bytes(value: unknown): number | null {
  const number = typeof value === 'string' ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) && number >= 0 ? number : null;
}

function sumOf(groups: unknown, field: 'egressBytes' | 'ingressBytes'): number | null {
  if (!Array.isArray(groups)) {
    return null;
  }
  // Bez dimenzií vráti Cloudflare jeden riadok; prázdne pole = v období žiadny prenos.
  return groups.reduce<number>((total, group) => total + (bytes((group as { sum?: Record<string, unknown> })?.sum?.[field]) ?? 0), 0);
}

/**
 * Súbor `usage.json` od sidecaru `turn-creds`: `{"month":"2026-11","configured":true,"response":<odpoveď GraphQL>}`.
 * Odpoveď má aliasy `monthAll` (celý účet), `monthKey` a `todayKey` (len TURN kľúč hry).
 */
export function parseCloudflareUsage(raw: unknown, updatedAt: number | null, now = Date.now()): CloudflareUsage {
  const empty: CloudflareUsage = {
    configured: false,
    updatedAt,
    month: null,
    accountEgressBytes: null,
    keyEgressBytes: null,
    keyIngressBytes: null,
    todayEgressBytes: null,
    freeBytes: CLOUDFLARE_FREE_BYTES,
    error: null,
  };
  const file = raw as { month?: unknown; configured?: unknown; response?: { data?: unknown; errors?: unknown } } | null;
  if (!file || typeof file !== 'object') {
    return { ...empty, error: 'Neplatný súbor so spotrebou' };
  }
  if (file.configured !== true) {
    return empty;
  }
  const month = typeof file.month === 'string' && /^\d{4}-\d{2}$/.test(file.month) ? file.month : null;
  const errors = Array.isArray(file.response?.errors) ? file.response!.errors : [];
  const firstError = errors.length ? String((errors[0] as { message?: unknown })?.message ?? 'Chyba Cloudflare').slice(0, 200) : null;
  const account = (file.response?.data as { viewer?: { accounts?: Record<string, unknown>[] } } | undefined)?.viewer?.accounts?.[0];
  const usage: CloudflareUsage = {
    ...empty,
    configured: true,
    month,
    accountEgressBytes: account ? sumOf(account.monthAll, 'egressBytes') : null,
    keyEgressBytes: account ? sumOf(account.monthKey, 'egressBytes') : null,
    keyIngressBytes: account ? sumOf(account.monthKey, 'ingressBytes') : null,
    todayEgressBytes: account ? sumOf(account.todayKey, 'egressBytes') : null,
    error: firstError ?? (account ? null : 'Cloudflare nevrátil údaje o účte (skontroluj CF_ACCOUNT_ID a oprávnenie Account Analytics)'),
  };
  if (updatedAt !== null && now - updatedAt > STALE_MS) {
    usage.error = usage.error ?? STALE_ERROR;
  }
  return usage;
}

/** Číta `usage.json` znova len pri zmene súboru. */
export class CloudflareUsageFile {
  private cachedAt = -1;
  private cached: CloudflareUsage | null = null;

  constructor(private readonly file: string) {}

  read(now = Date.now()): CloudflareUsage | null {
    if (!this.file) {
      return null;
    }
    let version: number;
    try {
      version = statSync(this.file).mtimeMs;
    } catch {
      return null;
    }
    if (version !== this.cachedAt) {
      this.cachedAt = version;
      try {
        this.cached = parseCloudflareUsage(JSON.parse(readFileSync(this.file, 'utf8')), version, now);
      } catch {
        this.cached = parseCloudflareUsage(null, version, now);
      }
    }
    const cached = this.cached;
    if (cached && !cached.error && cached.updatedAt !== null && now - cached.updatedAt > STALE_MS) {
      return { ...cached, error: STALE_ERROR };
    }
    return cached;
  }
}
