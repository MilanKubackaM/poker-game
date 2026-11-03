import type { CloudflareUsage, NetSeries, NetStatsResponse } from '../../../shared/netstats';

const KEY_STORAGE = 'poker.statsKey';

/** Kľúč k štatistikám: z odkazu `/stats#key=…` (alebo `?key=`) sa uloží a z adresy zmizne. */
export function initialStatsKey(): string {
  const fromHash = new URLSearchParams(window.location.hash.slice(1)).get('key');
  const fromQuery = new URLSearchParams(window.location.search).get('key');
  const fromUrl = (fromHash ?? fromQuery ?? '').trim();
  if (fromUrl) {
    saveStatsKey(fromUrl);
    window.history.replaceState(null, '', '/stats');
    return fromUrl;
  }
  try {
    return window.localStorage.getItem(KEY_STORAGE) ?? '';
  } catch {
    return '';
  }
}

export function saveStatsKey(key: string): void {
  try {
    if (key) {
      window.localStorage.setItem(KEY_STORAGE, key);
    } else {
      window.localStorage.removeItem(KEY_STORAGE);
    }
  } catch {
    // Úložisko nie je dostupné (súkromné okno) — kľúč ostane len do zatvorenia stránky.
  }
}

export type StatsQuery = { mode: 'live'; code: string | null } | { mode: 'history'; code: string | null; from: number; to: number };

export type StatsResult =
  | { ok: true; series: NetSeries; relay: NetStatsResponse['relay'] | null; cloudflare: CloudflareUsage | null }
  | { ok: false; error: string; unauthorized: boolean };

export async function fetchNetStats(query: StatsQuery, key: string, signal?: AbortSignal): Promise<StatsResult> {
  const params = new URLSearchParams({ mode: query.mode });
  if (query.code) {
    params.set('code', query.code);
  }
  if (query.mode === 'history') {
    params.set('from', String(query.from));
    params.set('to', String(query.to));
  }
  try {
    const response = await fetch(`/api/netstats?${params}`, { headers: key ? { Authorization: `Bearer ${key}` } : {}, signal });
    const body = (await response.json().catch(() => ({ ok: false, error: `Chyba ${response.status}` }))) as NetStatsResponse;
    if (!response.ok || !body.ok || !body.series) {
      return { ok: false, error: body.error ?? `Chyba ${response.status}`, unauthorized: response.status === 401 };
    }
    return { ok: true, series: body.series, relay: body.relay ?? null, cloudflare: body.cloudflare ?? null };
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      throw error;
    }
    return { ok: false, error: 'Server neodpovedá', unauthorized: false };
  }
}
