import { timingSafeEqual } from 'node:crypto';
import { appendFileSync, createReadStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { NET_HISTORY_MAX_MS, NET_LIVE_MS, NetSeriesBuilder, type NetLine, type NetSample, type NetSeries, type NetServerSample } from '../shared/netstats';

const DAY_MS = 24 * 3600_000;
const FILE_PATTERN = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

export interface NetStatsOptions {
  /** Koľko dní histórie ostáva na disku. */
  retentionDays?: number;
  /** Strop veľkosti priečinka s históriou; pri prekročení sa mažú najstaršie dni. */
  maxBytes?: number;
  now?: () => number;
}

function dayOf(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * Úložisko sieťových štatistík: posledných `NET_LIVE_MS` v pamäti pre živý pohľad a všetko do `<dataDir>/net/<deň>.jsonl`
 * (jeden riadok = jedna vzorka hráča / servera / udalosť). História sa číta po riadkoch a hneď zlučuje do intervalov,
 * takže ani dlhý rozsah sa nenačíta do pamäte celý.
 */
export class NetStatsStore {
  readonly dir: string;
  private readonly retentionDays: number;
  private readonly maxBytes: number;
  private readonly now: () => number;
  private recent: NetLine[] = [];
  private writeFailed = false;

  constructor(dataDir: string, options: NetStatsOptions = {}) {
    this.dir = path.join(dataDir, 'net');
    this.retentionDays = options.retentionDays ?? 7;
    this.maxBytes = options.maxBytes ?? 300 * 1024 * 1024;
    this.now = options.now ?? Date.now;
    mkdirSync(this.dir, { recursive: true });
  }

  recordPlayer(code: string, table: string, from: string, name: string, sample: NetSample): void {
    this.push({ kind: 'player', t: this.now(), code, table, from, name, sample });
  }

  recordServer(server: NetServerSample, persist: boolean): void {
    const line: NetLine = { kind: 'server', t: this.now(), server };
    if (persist) {
      this.push(line);
    } else {
      this.remember(line);
    }
  }

  recordEvent(code: string, table: string, from: string, name: string, text: string): void {
    this.push({ kind: 'event', t: this.now(), code, table, from, name, text });
  }

  private remember(line: NetLine): void {
    this.recent.push(line);
    const cutoff = this.now() - NET_LIVE_MS;
    if (this.recent.length > 64 && this.recent[0].t < cutoff) {
      this.recent = this.recent.filter((entry) => entry.t >= cutoff);
    }
  }

  private push(line: NetLine): void {
    this.remember(line);
    try {
      appendFileSync(path.join(this.dir, `${dayOf(line.t)}.jsonl`), `${JSON.stringify(line)}\n`);
      this.writeFailed = false;
    } catch (error) {
      if (!this.writeFailed) {
        console.error('Sieťové štatistiky sa nedajú zapísať', error);
        this.writeFailed = true;
      }
    }
  }

  /** Živý pohľad: posledných `NET_LIVE_MS` z pamäte. */
  live(code: string | null): NetSeries {
    const now = this.now();
    const builder = new NetSeriesBuilder(now - NET_LIVE_MS, now);
    for (const line of this.recent) {
      builder.add(line);
    }
    return builder.result(code, now);
  }

  /** História z disku (rozsah najviac `NET_HISTORY_MAX_MS`). */
  async history(from: number, to: number, code: string | null): Promise<NetSeries> {
    const end = Math.min(to, this.now());
    const start = Math.max(from, end - NET_HISTORY_MAX_MS);
    const builder = new NetSeriesBuilder(start, end);
    for (let day = Math.floor(start / DAY_MS) * DAY_MS; day <= end; day += DAY_MS) {
      const file = path.join(this.dir, `${dayOf(day)}.jsonl`);
      if (!existsSync(file)) {
        continue;
      }
      const lines = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
      for await (const text of lines) {
        if (!text) {
          continue;
        }
        try {
          builder.add(JSON.parse(text) as NetLine);
        } catch {
          continue;
        }
      }
    }
    return builder.result(code, this.now());
  }

  /** Zmaže dni staršie ako retencia a pri prekročení stropu veľkosti aj najstaršie ďalšie. */
  prune(): void {
    const today = dayOf(this.now());
    const cutoff = dayOf(this.now() - this.retentionDays * DAY_MS);
    const files = readdirSync(this.dir)
      .map((file) => ({ file, day: FILE_PATTERN.exec(file)?.[1] }))
      .filter((entry): entry is { file: string; day: string } => !!entry.day)
      .sort((left, right) => left.day.localeCompare(right.day));
    let total = 0;
    const sizes = new Map<string, number>();
    for (const entry of files) {
      const size = statSync(path.join(this.dir, entry.file)).size;
      sizes.set(entry.file, size);
      total += size;
    }
    for (const entry of files) {
      if (entry.day >= today) {
        break;
      }
      if (entry.day < cutoff || total > this.maxBytes) {
        rmSync(path.join(this.dir, entry.file), { force: true });
        total -= sizes.get(entry.file) ?? 0;
      }
    }
  }
}

export type StatsAccess = 'ok' | 'disabled' | 'denied';

/**
 * Prístup k `/api/netstats`: kľúč z `STATS_TOKEN` (porovnanie v konštantnom čase). Bez nastaveného kľúča je stránka
 * v produkcii vypnutá a pri vývoji otvorená.
 */
export function statsAccess(token: string, provided: string | undefined, production: boolean): StatsAccess {
  if (!token) {
    return production ? 'disabled' : 'ok';
  }
  if (!provided) {
    return 'denied';
  }
  const expected = Buffer.from(token);
  const actual = Buffer.from(provided);
  return expected.length === actual.length && timingSafeEqual(expected, actual) ? 'ok' : 'denied';
}
