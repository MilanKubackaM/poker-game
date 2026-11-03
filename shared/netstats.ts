import { MAX_NAME_LENGTH, MAX_SEATS } from './constants';

/**
 * Sieťové štatistiky kamier a mikrofónov pre stránku `/stats`.
 *
 * Každý hráč pri stole raz za `NET_SAMPLE_MS` pošle jednu vzorku: pre každého protihráča (spojenie v mesh sieti) koľko
 * dát posiela a prijíma, cestu (priamo / relay), RTT, straty, koľko zvuku musel prehliadač doplniť a či zamrzol obraz.
 * Server vzorky uloží (pamäť + JSONL na disku) a stránka z nich poskladá časové rady, maticu spojení a diagnózu.
 *
 * Smer: záznam hráča R so spojením na P obsahuje prichádzajúce metriky P → R (čo R prijíma od P) a odchádzajúce R → P.
 */

export const NET_SAMPLE_MS = 5000;
/** Koľko posledných minút drží server v pamäti pre živý pohľad. */
export const NET_LIVE_MS = 15 * 60_000;
/** Najviac bodov na časový rad — dlhší rozsah sa zlučuje do väčších intervalov. */
export const NET_MAX_POINTS = 360;
/** Najdlhší rozsah histórie v jednej požiadavke. */
export const NET_HISTORY_MAX_MS = 48 * 3600_000;
/** Najviac udalostí v jednej odpovedi (najnovšie). */
export const NET_MAX_EVENTS = 500;
const MAX_LINK_EVENTS = 20;

export type NetLimit = 'none' | 'cpu' | 'bandwidth' | 'other';
export const ICE_STATES = ['new', 'checking', 'connected', 'completed', 'disconnected', 'failed', 'closed'] as const;
export type IceState = (typeof ICE_STATES)[number];
export type NetIceEvent = IceState | 'restart';

/** Spojenie s jedným protihráčom za posledný interval (rýchlosti sú priemery za interval, počítadlá sú rozdiely). */
export interface NetLinkSample {
  /** playerId protihráča. */
  to: string;
  /** Meno protihráča — dopĺňa server. */
  toName?: string;
  state?: IceState;
  /** Napr. `host/udp→srflx`, `relay/tls→relay`. */
  path?: string;
  relay?: boolean;
  rttMs?: number;
  /** Všetko, čo ide k protihráčovi / od neho (vybraný pár ICE, vrátane réžie). */
  upKbps?: number;
  downKbps?: number;
  /** Odhad prehliadača, koľko sa dá k protihráčovi poslať. */
  availKbps?: number;
  audioInKbps?: number;
  audioLossPct?: number;
  /** Koľko % zvuku musel prehliadač dopočítať, lebo pakety neprišli včas — počuteľné sekanie. */
  concealPct?: number;
  jitterMs?: number;
  jitterBufferMs?: number;
  videoInKbps?: number;
  videoLossPct?: number;
  videoInFps?: number;
  videoInHeight?: number;
  /** Zamrznutia prichádzajúceho obrazu za interval a ich trvanie. */
  freezes?: number;
  freezeMs?: number;
  audioOutKbps?: number;
  videoOutKbps?: number;
  videoOutFps?: number;
  videoOutHeight?: number;
  /** Prečo prehliadač znižuje kvalitu odchádzajúceho videa. */
  limit?: NetLimit;
  /** Strata môjho streamu tak, ako ju hlási protihráč (RTCP). */
  remoteLossPct?: number;
  /** Zmeny stavu spojenia (ICE) počas intervalu; `ageMs` = pred koľkými ms pred odoslaním vzorky. */
  events?: { ageMs: number; kind: NetIceEvent }[];
}

export interface NetConnectionInfo {
  type?: string;
  effectiveType?: string;
  downlinkMbps?: number;
  rttMs?: number;
}

export interface NetSample {
  /** Čas odozvy servera hry (potvrdenie predchádzajúcej vzorky). */
  serverRttMs?: number;
  /** Karta s hrou je na pozadí — prehliadač tlmí časovače aj prehrávanie. */
  hidden?: boolean;
  camera?: boolean;
  microphone?: boolean;
  connection?: NetConnectionInfo;
  links: NetLinkSample[];
}

export interface NetServerSample {
  /** Záťaž procesu hry v % jedného jadra. */
  cpuPct: number;
  /** Load average NAS za 1 min a počet jadier (load / jadrá > 1 = preťažené). */
  load1: number;
  cores: number;
  /** Oneskorenie event loopu servera (99. percentil a maximum za interval). */
  loopP99Ms: number;
  loopMaxMs: number;
  rssMb: number;
  heapMb: number;
  sockets: number;
  /** Počet hráčov s kamerou/mikrofónom hlásiacich štatistiky za posledný interval. */
  reporters: number;
}

export type NetLine =
  | { kind: 'player'; t: number; code: string; table: string; from: string; name: string; sample: NetSample }
  | { kind: 'server'; t: number; server: NetServerSample }
  | { kind: 'event'; t: number; code: string; table: string; from: string; name: string; text: string };

export type NetEventKind = 'ice' | 'freeze' | 'audio' | 'socket';

export interface NetEvent {
  t: number;
  kind: NetEventKind;
  /** Hráč, u ktorého sa to stalo (prijímateľ pri obraze a zvuku). */
  player: string;
  /** Protihráč (odosielateľ pri obraze a zvuku). */
  peer?: string;
  /** Koniec epizódy — po sebe idúce zamrznutia / sekanie toho istého spojenia sa zlúčia do jednej udalosti. */
  end?: number;
  text: string;
}

/** Surová udalosť pred zlúčením do epizód. */
interface RawEvent {
  t: number;
  kind: NetEventKind;
  player: string;
  peer?: string;
  text?: string;
  freezes?: number;
  freezeMs?: number;
  concealPct?: number;
}

/** Medzera, po ktorej začína nová epizóda sekania (dve vynechané vzorky). */
const EPISODE_GAP_MS = 2 * NET_SAMPLE_MS + 1000;

function decimalText(value: number): string {
  return value.toFixed(1).replace('.', ',').replace(/,0$/, '');
}

/** Zlúči po sebe idúce zamrznutia a sekanie zvuku toho istého spojenia do epizód (od–do, súčet, maximum). */
export function mergeEvents(raw: RawEvent[]): NetEvent[] {
  const sorted = [...raw].sort((left, right) => left.t - right.t);
  const merged: NetEvent[] = [];
  const open = new Map<string, { event: NetEvent; last: number; freezes: number; freezeMs: number; concealPct: number; samples: number }>();
  const describe = (kind: NetEventKind, episode: { freezes: number; freezeMs: number; concealPct: number; samples: number }) =>
    kind === 'freeze'
      ? `obraz zamrzol ${episode.freezes}×${episode.freezeMs ? ` (spolu ${decimalText(episode.freezeMs / 1000)} s)` : ''}`
      : `zvuk seká — doplnené až ${decimalText(episode.concealPct)} %${episode.samples > 1 ? ` (${episode.samples} merania)` : ''}`;
  for (const entry of sorted) {
    if (entry.kind !== 'freeze' && entry.kind !== 'audio') {
      merged.push({ t: entry.t, kind: entry.kind, player: entry.player, ...(entry.peer ? { peer: entry.peer } : {}), text: entry.text ?? '' });
      continue;
    }
    const key = `${entry.kind}|${entry.player}|${entry.peer ?? ''}`;
    const current = open.get(key);
    if (current && entry.t - current.last <= EPISODE_GAP_MS) {
      current.last = entry.t;
      current.freezes += entry.freezes ?? 0;
      current.freezeMs += entry.freezeMs ?? 0;
      current.concealPct = Math.max(current.concealPct, entry.concealPct ?? 0);
      current.samples += 1;
      current.event.end = entry.t;
      current.event.text = describe(entry.kind, current);
      continue;
    }
    const episode = { freezes: entry.freezes ?? 0, freezeMs: entry.freezeMs ?? 0, concealPct: entry.concealPct ?? 0, samples: 1 };
    const event: NetEvent = { t: entry.t, kind: entry.kind, player: entry.player, ...(entry.peer ? { peer: entry.peer } : {}), text: describe(entry.kind, episode) };
    open.set(key, { event, last: entry.t, ...episode });
    merged.push(event);
  }
  return merged.sort((left, right) => right.t - left.t);
}

export interface NetTableInfo {
  code: string;
  name: string;
  lastT: number;
}

export type Series = (number | null)[];

export interface NetPlayerSeries {
  up: Series;
  down: Series;
  serverRtt: Series;
  hidden: Series;
  /** Najhorší doplnený zvuk zo všetkých prichádzajúcich spojení. */
  conceal: Series;
  /** Najhoršia strata paketov zo všetkých prichádzajúcich spojení. */
  loss: Series;
  /** Najhoršie RTT zo všetkých spojení. */
  rtt: Series;
  freezes: Series;
  /** Počet spojení cez relay. */
  relay: Series;
}

export interface NetLinkSeries {
  /** Kto hlási (prijímateľ prichádzajúcich metrík). */
  from: string;
  to: string;
  path: (string | null)[];
  state: (string | null)[];
  limit: (NetLimit | null)[];
  relay: Series;
  rtt: Series;
  up: Series;
  down: Series;
  avail: Series;
  audioIn: Series;
  audioLoss: Series;
  conceal: Series;
  jitterBuffer: Series;
  videoIn: Series;
  videoLoss: Series;
  fps: Series;
  height: Series;
  freezes: Series;
  freezeMs: Series;
  videoOut: Series;
  outFps: Series;
  remoteLoss: Series;
}

export interface NetServerSeries {
  cpu: Series;
  load: Series;
  cores: Series;
  loop: Series;
  rss: Series;
  sockets: Series;
}

export interface NetSeries {
  from: number;
  to: number;
  bucketMs: number;
  /** Začiatky intervalov. */
  times: number[];
  code: string | null;
  tables: NetTableInfo[];
  players: { id: string; name: string }[];
  player: Record<string, NetPlayerSeries>;
  /** Kľúč `${from}>${to}` (hlásiaci hráč > protihráč). */
  links: Record<string, NetLinkSeries>;
  server: NetServerSeries;
  events: NetEvent[];
  /** Čas servera pri odpovedi (pre živý pohľad). */
  serverNow: number;
}

/** Free tier Cloudflare Realtime: prvých 1 000 GB odchádzajúcich dát (egress) mesačne, zdieľané medzi TURN a SFU. */
export const CLOUDFLARE_FREE_BYTES = 1000 * 1e9;

/**
 * Spotreba Cloudflare TURN v aktuálnom mesiaci (UTC) podľa Cloudflare GraphQL Analytics — sťahuje ju sidecar `turn-creds`.
 * Účtuje sa len egress (z Cloudflare k hráčom); `accountEgressBytes` je celý účet (free tier je spoločný), `key*` len kľúč hry.
 */
export interface CloudflareUsage {
  /** Sidecar má prístup k Analytics API (CF_ACCOUNT_ID + CF_ANALYTICS_TOKEN). */
  configured: boolean;
  /** Kedy sidecar čísla stiahol (ms epoch), null = ešte nikdy. */
  updatedAt: number | null;
  /** Mesiac, za ktorý čísla sú, napr. 2026-11. */
  month: string | null;
  accountEgressBytes: number | null;
  keyEgressBytes: number | null;
  keyIngressBytes: number | null;
  todayEgressBytes: number | null;
  freeBytes: number;
  /** Chyba z Cloudflare (zlý token, chýbajúce oprávnenie Account Analytics …). */
  error: string | null;
}

export interface NetStatsResponse {
  ok: boolean;
  error?: string;
  series?: NetSeries;
  /** Ktorý relay hra práve rozdáva hráčom (Cloudflare TURN alebo vlastný coturn na NAS). */
  relay?: 'cloudflare' | 'coturn' | null;
  cloudflare?: CloudflareUsage;
}

/**
 * Ide spojenie cez relay po TCP/TLS? Vlastný relay vidno priamo (`relay/tls→…`); relay protihráča nie, ale dostáva ho
 * od toho istého servera — ak server dáva relay s UDP (Cloudflare), protihráč ho používa tiež.
 */
export function isSlowRelay(path: string, iceServers: { urls: string | string[] }[]): boolean {
  const [local = '', rest = ''] = path.split('/');
  const [protocol = '', remote = ''] = rest.split('→');
  if (local === 'relay') {
    return protocol !== 'udp';
  }
  if (remote !== 'relay') {
    return false;
  }
  const urls = iceServers.flatMap((server) => (Array.isArray(server.urls) ? server.urls : [server.urls]));
  return !urls.some((url) => url.startsWith('turn:') && !url.includes('transport=tcp'));
}

// ---------------------------------------------------------------------------------------------------------------------
// Sanitizácia vzorky od klienta

function num(value: unknown, max: number, digits = 0): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  const factor = 10 ** digits;
  return Math.round(Math.min(max, Math.max(0, value)) * factor) / factor;
}

function text(value: unknown, pattern: RegExp, maxLength: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const cleaned = value.slice(0, maxLength);
  return pattern.test(cleaned) ? cleaned : undefined;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

function compact<T extends object>(value: T): T {
  for (const key of Object.keys(value) as (keyof T)[]) {
    if (value[key] === undefined) {
      delete value[key];
    }
  }
  return value;
}

const KBPS_MAX = 200_000;
const MS_MAX = 60_000;
const LIMITS: readonly NetLimit[] = ['none', 'cpu', 'bandwidth', 'other'];
const EVENT_KINDS: readonly NetIceEvent[] = [...ICE_STATES, 'restart'];

function sanitizeLink(raw: unknown): NetLinkSample | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const link = raw as Record<string, unknown>;
  const to = text(link.to, /^[\w-]{1,64}$/, 64);
  if (!to) {
    return null;
  }
  const events = Array.isArray(link.events)
    ? link.events
        .slice(0, MAX_LINK_EVENTS)
        .map((event) => {
          const entry = (event ?? {}) as Record<string, unknown>;
          const kind = oneOf(entry.kind, EVENT_KINDS);
          const ageMs = num(entry.ageMs, MS_MAX);
          return kind && ageMs !== undefined ? { ageMs, kind } : null;
        })
        .filter((event): event is { ageMs: number; kind: NetIceEvent } => event !== null)
    : [];
  return compact<NetLinkSample>({
    to,
    state: oneOf(link.state, ICE_STATES),
    path: text(link.path, /^[\w/→?.-]{1,40}$/u, 40),
    relay: typeof link.relay === 'boolean' ? link.relay : undefined,
    rttMs: num(link.rttMs, MS_MAX),
    upKbps: num(link.upKbps, KBPS_MAX),
    downKbps: num(link.downKbps, KBPS_MAX),
    availKbps: num(link.availKbps, KBPS_MAX),
    audioInKbps: num(link.audioInKbps, KBPS_MAX),
    audioLossPct: num(link.audioLossPct, 100, 1),
    concealPct: num(link.concealPct, 100, 1),
    jitterMs: num(link.jitterMs, MS_MAX),
    jitterBufferMs: num(link.jitterBufferMs, MS_MAX),
    videoInKbps: num(link.videoInKbps, KBPS_MAX),
    videoLossPct: num(link.videoLossPct, 100, 1),
    videoInFps: num(link.videoInFps, 240, 1),
    videoInHeight: num(link.videoInHeight, 4320),
    freezes: num(link.freezes, 1000),
    freezeMs: num(link.freezeMs, MS_MAX * 10),
    audioOutKbps: num(link.audioOutKbps, KBPS_MAX),
    videoOutKbps: num(link.videoOutKbps, KBPS_MAX),
    videoOutFps: num(link.videoOutFps, 240, 1),
    videoOutHeight: num(link.videoOutHeight, 4320),
    limit: oneOf(link.limit, LIMITS),
    remoteLossPct: num(link.remoteLossPct, 100, 1),
    events: events.length ? events : undefined,
  });
}

/** Overí a oreže vzorku od klienta; neznáme polia zahodí, čísla oreže do rozumného rozsahu. */
export function sanitizeNetSample(raw: unknown): NetSample | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const sample = raw as Record<string, unknown>;
  if (!Array.isArray(sample.links)) {
    return null;
  }
  const seen = new Set<string>();
  const links: NetLinkSample[] = [];
  for (const entry of sample.links.slice(0, MAX_SEATS)) {
    const link = sanitizeLink(entry);
    if (link && !seen.has(link.to)) {
      seen.add(link.to);
      links.push(link);
    }
  }
  const connection = sample.connection && typeof sample.connection === 'object' ? (sample.connection as Record<string, unknown>) : null;
  const info = connection
    ? compact<NetConnectionInfo>({
        type: text(connection.type, /^[\w-]{1,20}$/, 20),
        effectiveType: text(connection.effectiveType, /^[\w-]{1,10}$/, 10),
        downlinkMbps: num(connection.downlinkMbps, 10_000, 1),
        rttMs: num(connection.rttMs, MS_MAX),
      })
    : undefined;
  return compact<NetSample>({
    serverRttMs: num(sample.serverRttMs, MS_MAX),
    hidden: typeof sample.hidden === 'boolean' ? sample.hidden : undefined,
    camera: typeof sample.camera === 'boolean' ? sample.camera : undefined,
    microphone: typeof sample.microphone === 'boolean' ? sample.microphone : undefined,
    connection: info && Object.keys(info).length ? info : undefined,
    links,
  });
}

/** Meno pre uloženie (rovnaké pravidlá ako meno hráča). */
export function cleanNetName(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
}

// ---------------------------------------------------------------------------------------------------------------------
// Skladanie časových radov

type Aggregate = 'avg' | 'max' | 'min' | 'sum';

/** Zlučuje hodnoty do intervalov jedným zo spôsobov; prázdny interval = null (čiara sa preruší). */
class Accumulator {
  private readonly values: Series;
  private readonly counts: number[];

  constructor(
    size: number,
    private readonly mode: Aggregate,
  ) {
    this.values = new Array<number | null>(size).fill(null);
    this.counts = new Array<number>(size).fill(0);
  }

  add(index: number, value: number | undefined): void {
    if (value === undefined) {
      return;
    }
    const current = this.values[index];
    this.counts[index] += 1;
    if (current === null) {
      this.values[index] = value;
      return;
    }
    switch (this.mode) {
      case 'avg':
      case 'sum':
        this.values[index] = current + value;
        break;
      case 'max':
        this.values[index] = Math.max(current, value);
        break;
      case 'min':
        this.values[index] = Math.min(current, value);
        break;
    }
  }

  result(): Series {
    if (this.mode !== 'avg') {
      return this.values.map((value) => (value === null ? null : Math.round(value * 10) / 10));
    }
    return this.values.map((value, index) => (value === null ? null : Math.round((value / this.counts[index]) * 10) / 10));
  }
}

class Last<T> {
  private readonly values: (T | null)[];

  constructor(size: number) {
    this.values = new Array<T | null>(size).fill(null);
  }

  add(index: number, value: T | undefined): void {
    if (value !== undefined) {
      this.values[index] = value;
    }
  }

  result(): (T | null)[] {
    return this.values;
  }
}

/** Najhoršie obmedzenie v intervale (cpu/bandwidth prebije none). */
class WorstLimit {
  private readonly values: (NetLimit | null)[];

  constructor(size: number) {
    this.values = new Array<NetLimit | null>(size).fill(null);
  }

  add(index: number, value: NetLimit | undefined): void {
    if (value === undefined) {
      return;
    }
    const current = this.values[index];
    const rank = (limit: NetLimit | null) => (limit === null ? -1 : limit === 'none' ? 0 : limit === 'other' ? 1 : 2);
    if (rank(value) > rank(current)) {
      this.values[index] = value;
    }
  }

  result(): (NetLimit | null)[] {
    return this.values;
  }
}

const PLAYER_METRICS: Record<keyof NetPlayerSeries, Aggregate> = {
  up: 'avg',
  down: 'avg',
  serverRtt: 'max',
  hidden: 'max',
  conceal: 'max',
  loss: 'max',
  rtt: 'max',
  freezes: 'sum',
  relay: 'max',
};

type LinkNumeric = Exclude<keyof NetLinkSeries, 'from' | 'to' | 'path' | 'state' | 'limit'>;

const LINK_METRICS: Record<LinkNumeric, [Aggregate, (link: NetLinkSample) => number | undefined]> = {
  relay: ['max', (link) => (link.relay === undefined ? undefined : link.relay ? 1 : 0)],
  rtt: ['max', (link) => link.rttMs],
  up: ['avg', (link) => link.upKbps],
  down: ['avg', (link) => link.downKbps],
  avail: ['min', (link) => link.availKbps],
  audioIn: ['avg', (link) => link.audioInKbps],
  audioLoss: ['max', (link) => link.audioLossPct],
  conceal: ['max', (link) => link.concealPct],
  jitterBuffer: ['max', (link) => link.jitterBufferMs],
  videoIn: ['avg', (link) => link.videoInKbps],
  videoLoss: ['max', (link) => link.videoLossPct],
  fps: ['min', (link) => link.videoInFps],
  height: ['min', (link) => link.videoInHeight],
  freezes: ['sum', (link) => link.freezes],
  freezeMs: ['sum', (link) => link.freezeMs],
  videoOut: ['avg', (link) => link.videoOutKbps],
  outFps: ['min', (link) => link.videoOutFps],
  remoteLoss: ['max', (link) => link.remoteLossPct],
};

const SERVER_METRICS: Record<keyof NetServerSeries, [Aggregate, (server: NetServerSample) => number]> = {
  cpu: ['avg', (server) => server.cpuPct],
  load: ['max', (server) => server.load1],
  cores: ['max', (server) => server.cores],
  loop: ['max', (server) => server.loopP99Ms],
  rss: ['max', (server) => server.rssMb],
  sockets: ['max', (server) => server.sockets],
};

/** Zvuk s viac ako týmto % doplnených vzoriek sa zapíše ako udalosť (počuteľné sekanie). */
export const CONCEAL_EVENT_PCT = 5;

const ICE_TEXT: Record<NetIceEvent, string> = {
  new: 'spojenie: nové',
  checking: 'spojenie: hľadá cestu',
  connected: 'spojenie: pripojené',
  completed: 'spojenie: pripojené',
  disconnected: 'spojenie: prerušené',
  failed: 'spojenie: zlyhalo',
  closed: 'spojenie: zatvorené',
  restart: 'spojenie: reštart (ICE)',
};

function bucketSize(from: number, to: number, maxPoints: number): number {
  const raw = Math.ceil((to - from) / Math.max(1, maxPoints - 2));
  return Math.max(NET_SAMPLE_MS, Math.ceil(raw / NET_SAMPLE_MS) * NET_SAMPLE_MS);
}

interface LinkAccumulators {
  from: string;
  to: string;
  path: Last<string>;
  state: Last<string>;
  limit: WorstLimit;
  numeric: Record<LinkNumeric, Accumulator>;
}

class TableSeriesBuilder {
  readonly players = new Map<string, string>();
  readonly playerSeries = new Map<string, Record<keyof NetPlayerSeries, Accumulator>>();
  readonly links = new Map<string, LinkAccumulators>();
  readonly events: RawEvent[] = [];

  constructor(private readonly size: number) {}

  player(id: string, name: string): Record<keyof NetPlayerSeries, Accumulator> {
    this.players.set(id, name);
    let series = this.playerSeries.get(id);
    if (!series) {
      series = Object.fromEntries(Object.entries(PLAYER_METRICS).map(([key, mode]) => [key, new Accumulator(this.size, mode)])) as Record<keyof NetPlayerSeries, Accumulator>;
      this.playerSeries.set(id, series);
    }
    return series;
  }

  link(from: string, to: string): LinkAccumulators {
    const key = `${from}>${to}`;
    let link = this.links.get(key);
    if (!link) {
      link = {
        from,
        to,
        path: new Last<string>(this.size),
        state: new Last<string>(this.size),
        limit: new WorstLimit(this.size),
        numeric: Object.fromEntries(Object.entries(LINK_METRICS).map(([metric, [mode]]) => [metric, new Accumulator(this.size, mode)])) as Record<LinkNumeric, Accumulator>,
      };
      this.links.set(key, link);
    }
    return link;
  }
}

function maxOf(values: (number | undefined)[]): number | undefined {
  const present = values.filter((value): value is number => value !== undefined);
  return present.length ? Math.max(...present) : undefined;
}

function sumOf(values: (number | undefined)[]): number | undefined {
  const present = values.filter((value): value is number => value !== undefined);
  return present.length ? present.reduce((sum, value) => sum + value, 0) : undefined;
}

/**
 * Postupne skladá časové rady z riadkov (pamäť aj súbor sa čítajú po jednom, celý súbor sa nedrží v pamäti).
 * Rady sa skladajú pre každý stôl zvlášť; `result` vráti zvolený stôl (alebo ten s najnovšími dátami).
 */
export class NetSeriesBuilder {
  readonly from: number;
  readonly to: number;
  readonly bucketMs: number;
  private readonly size: number;
  private readonly tables = new Map<string, NetTableInfo>();
  private readonly builders = new Map<string, TableSeriesBuilder>();
  private readonly server: Record<keyof NetServerSeries, Accumulator>;

  constructor(from: number, to: number, maxPoints = NET_MAX_POINTS) {
    this.bucketMs = bucketSize(from, to, maxPoints);
    this.from = Math.floor(from / this.bucketMs) * this.bucketMs;
    this.to = to;
    this.size = Math.max(1, Math.floor((to - this.from) / this.bucketMs) + 1);
    this.server = Object.fromEntries(Object.entries(SERVER_METRICS).map(([key, [mode]]) => [key, new Accumulator(this.size, mode)])) as Record<keyof NetServerSeries, Accumulator>;
  }

  private index(t: number): number | null {
    if (t < this.from || t > this.to) {
      return null;
    }
    return Math.min(this.size - 1, Math.floor((t - this.from) / this.bucketMs));
  }

  private table(code: string, name: string, t: number): TableSeriesBuilder {
    const info = this.tables.get(code);
    if (!info || info.lastT <= t) {
      this.tables.set(code, { code, name, lastT: t });
    }
    let builder = this.builders.get(code);
    if (!builder) {
      builder = new TableSeriesBuilder(this.size);
      this.builders.set(code, builder);
    }
    return builder;
  }

  add(line: NetLine): void {
    const index = this.index(line.t);
    if (index === null) {
      return;
    }
    if (line.kind === 'server') {
      for (const [key, [, read]] of Object.entries(SERVER_METRICS) as [keyof NetServerSeries, (typeof SERVER_METRICS)[keyof NetServerSeries]][]) {
        this.server[key].add(index, read(line.server));
      }
      return;
    }
    const table = this.table(line.code, line.table, line.t);
    if (line.kind === 'event') {
      table.players.set(line.from, line.name);
      table.events.push({ t: line.t, kind: 'socket', player: line.name, text: line.text });
      return;
    }
    const { sample } = line;
    const player = table.player(line.from, line.name);
    const links = sample.links;
    player.up.add(index, sumOf(links.map((link) => link.upKbps)));
    player.down.add(index, sumOf(links.map((link) => link.downKbps)));
    player.serverRtt.add(index, sample.serverRttMs);
    player.hidden.add(index, sample.hidden === undefined ? undefined : sample.hidden ? 1 : 0);
    player.conceal.add(index, maxOf(links.map((link) => link.concealPct)));
    player.loss.add(index, maxOf(links.flatMap((link) => [link.audioLossPct, link.videoLossPct])));
    player.rtt.add(index, maxOf(links.map((link) => link.rttMs)));
    player.freezes.add(index, sumOf(links.map((link) => link.freezes)));
    player.relay.add(index, links.length ? links.filter((link) => link.relay).length : undefined);
    for (const link of links) {
      const series = table.link(line.from, link.to);
      if (link.toName) {
        table.players.set(link.to, table.players.get(link.to) ?? link.toName);
      }
      series.path.add(index, link.path);
      series.state.add(index, link.state);
      series.limit.add(index, link.limit);
      for (const [metric, [, read]] of Object.entries(LINK_METRICS) as [LinkNumeric, (typeof LINK_METRICS)[LinkNumeric]][]) {
        series.numeric[metric].add(index, read(link));
      }
      const peer = link.toName ?? link.to.slice(0, 8);
      for (const event of link.events ?? []) {
        table.events.push({ t: Math.max(this.from, line.t - event.ageMs), kind: 'ice', player: line.name, peer, text: ICE_TEXT[event.kind] });
      }
      if (link.freezes) {
        table.events.push({ t: line.t, kind: 'freeze', player: line.name, peer, freezes: link.freezes, freezeMs: link.freezeMs });
      }
      if (link.concealPct !== undefined && link.concealPct >= CONCEAL_EVENT_PCT) {
        table.events.push({ t: line.t, kind: 'audio', player: line.name, peer, concealPct: link.concealPct });
      }
    }
  }

  result(code: string | null, serverNow: number): NetSeries {
    const tables = [...this.tables.values()].sort((left, right) => right.lastT - left.lastT);
    const chosen = code && this.builders.has(code) ? code : (tables[0]?.code ?? null);
    const builder = chosen ? this.builders.get(chosen)! : new TableSeriesBuilder(this.size);
    const player: Record<string, NetPlayerSeries> = {};
    for (const [id, series] of builder.playerSeries) {
      player[id] = Object.fromEntries(Object.entries(series).map(([key, accumulator]) => [key, accumulator.result()])) as unknown as NetPlayerSeries;
    }
    const links: Record<string, NetLinkSeries> = {};
    for (const [key, link] of builder.links) {
      links[key] = {
        from: link.from,
        to: link.to,
        path: link.path.result(),
        state: link.state.result(),
        limit: link.limit.result(),
        ...(Object.fromEntries(Object.entries(link.numeric).map(([metric, accumulator]) => [metric, accumulator.result()])) as Record<LinkNumeric, Series>),
      };
    }
    const events = mergeEvents(builder.events).slice(0, NET_MAX_EVENTS);
    return {
      from: this.from,
      to: this.to,
      bucketMs: this.bucketMs,
      times: Array.from({ length: this.size }, (_, index) => this.from + index * this.bucketMs),
      code: chosen,
      tables,
      players: [...builder.players].map(([id, name]) => ({ id, name })).sort((left, right) => left.name.localeCompare(right.name, 'sk')),
      player,
      links,
      server: Object.fromEntries(Object.entries(this.server).map(([key, accumulator]) => [key, accumulator.result()])) as unknown as NetServerSeries,
      events,
      serverNow,
    };
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Diagnóza — prečo seká

export type NetHintCause = 'cpu' | 'upload' | 'download' | 'hidden' | 'relay' | 'latency' | 'server' | 'nas' | 'signal' | 'unknown';

export interface NetHint {
  cause: NetHintCause;
  severity: 'warning' | 'critical';
  title: string;
  detail: string;
}

/** Spojenie odosielateľ → prijímateľ v jednom intervale (zložené z hlásení oboch strán). */
export interface NetCell {
  sender: string;
  receiver: string;
  /** Hlásenie prijímateľa (prichádzajúce metriky). */
  inbound: NetLinkSeries | null;
  /** Hlásenie odosielateľa (odchádzajúce metriky). */
  outbound: NetLinkSeries | null;
  problem: boolean;
  /** Zvuk sa seká (doplnené / strata) alebo obraz mrzne. */
  audioBad: boolean;
  videoBad: boolean;
}

export const PROBLEM = {
  concealPct: 3,
  audioLossPct: 3,
  videoLossPct: 5,
  relayRttMs: 250,
  rttMs: 300,
  serverRttMs: 500,
  availKbps: 200,
  loopMs: 200,
  loadPerCore: 1.5,
};

function at(series: Series | undefined, index: number): number | null {
  return series ? (series[index] ?? null) : null;
}

/** Matica spojení v intervale `index`: pre každú dvojicu hráčov oba smery. */
export function netCells(series: NetSeries, index: number): NetCell[] {
  const cells: NetCell[] = [];
  const ids = series.players.map((player) => player.id);
  for (const sender of ids) {
    for (const receiver of ids) {
      if (sender === receiver) {
        continue;
      }
      const inbound = series.links[`${receiver}>${sender}`] ?? null;
      const outbound = series.links[`${sender}>${receiver}`] ?? null;
      if (!inbound && !outbound) {
        continue;
      }
      const conceal = at(inbound?.conceal, index);
      const audioLoss = at(inbound?.audioLoss, index);
      const videoLoss = at(inbound?.videoLoss, index);
      const freezes = at(inbound?.freezes, index);
      const audioBad = (conceal ?? 0) >= PROBLEM.concealPct || (audioLoss ?? 0) >= PROBLEM.audioLossPct;
      const videoBad = (freezes ?? 0) > 0 || (videoLoss ?? 0) >= PROBLEM.videoLossPct;
      cells.push({ sender, receiver, inbound, outbound, problem: audioBad || videoBad, audioBad, videoBad });
    }
  }
  return cells;
}

const CAUSE_ORDER: NetHintCause[] = ['server', 'nas', 'cpu', 'upload', 'hidden', 'download', 'relay', 'latency', 'signal', 'unknown'];

function list(names: string[]): string {
  return [...new Set(names)].join(', ');
}

/**
 * Odhad príčiny sekania v intervale `index`. Pravidlá idú od najistejších (prehliadač sám hlási obmedzenie CPU/šírkou
 * pásma) po vzory v matici: zlý celý riadok = problém odosielateľa, zlý celý stĺpec = problém prijímateľa, zlé len
 * spojenia cez relay = relay na NAS.
 */
export function diagnoseNet(series: NetSeries, index: number): NetHint[] {
  const names = new Map(series.players.map((player) => [player.id, player.name]));
  const name = (id: string) => names.get(id) ?? id.slice(0, 8);
  const hints: NetHint[] = [];

  const loop = at(series.server.loop, index);
  if (loop !== null && loop >= PROBLEM.loopMs) {
    hints.push({ cause: 'server', severity: 'warning', title: 'Server hry sa zasekáva', detail: `Oneskorenie event loopu ${Math.round(loop)} ms. Týka sa hry a nadväzovania spojení, nie samotného obrazu a zvuku.` });
  }
  const load = at(series.server.load, index);
  const cores = at(series.server.cores, index);
  if (load !== null && cores && load / cores >= PROBLEM.loadPerCore) {
    hints.push({ cause: 'nas', severity: 'critical', title: 'NAS je preťažený', detail: `Load ${load.toFixed(1).replace('.', ',')} pri ${cores} jadrách. Relay (coturn) beží na tom istom NAS.` });
  }

  const cells = netCells(series, index);
  const outgoing = new Map<string, { total: number; bad: number }>();
  const incoming = new Map<string, { total: number; bad: number }>();
  for (const cell of cells) {
    if (!cell.inbound) {
      continue;
    }
    const out = outgoing.get(cell.sender) ?? { total: 0, bad: 0 };
    const into = incoming.get(cell.receiver) ?? { total: 0, bad: 0 };
    out.total += 1;
    into.total += 1;
    if (cell.problem) {
      out.bad += 1;
      into.bad += 1;
    }
    outgoing.set(cell.sender, out);
    incoming.set(cell.receiver, into);
  }
  const mostly = (counts: { total: number; bad: number } | undefined) => !!counts && counts.total >= 2 && counts.bad / counts.total >= 0.6;

  const groups = new Map<string, { cause: NetHintCause; who: string | null; cells: NetCell[] }>();
  for (const cell of cells) {
    if (!cell.problem) {
      continue;
    }
    const limit = cell.outbound?.limit[index] ?? null;
    const avail = at(cell.outbound?.avail, index);
    const hidden = at(series.player[cell.receiver]?.hidden, index);
    const relay = at(cell.inbound?.relay, index) ?? at(cell.outbound?.relay, index);
    const rtt = at(cell.inbound?.rtt, index) ?? at(cell.outbound?.rtt, index);
    let cause: NetHintCause;
    let who: string | null = null;
    if (limit === 'cpu') {
      cause = 'cpu';
      who = cell.sender;
    } else if (limit === 'bandwidth' || (avail !== null && avail < PROBLEM.availKbps)) {
      cause = 'upload';
      who = cell.sender;
    } else if (hidden === 1) {
      cause = 'hidden';
      who = cell.receiver;
    } else if (mostly(outgoing.get(cell.sender)) && !mostly(incoming.get(cell.receiver))) {
      cause = 'upload';
      who = cell.sender;
    } else if (mostly(incoming.get(cell.receiver))) {
      cause = 'download';
      who = cell.receiver;
    } else if (relay === 1) {
      cause = 'relay';
    } else if (rtt !== null && rtt >= PROBLEM.rttMs) {
      cause = 'latency';
    } else {
      cause = 'unknown';
    }
    const key = `${cause}:${who ?? ''}`;
    const group = groups.get(key) ?? { cause, who, cells: [] };
    group.cells.push(cell);
    groups.set(key, group);
  }

  const route = (cell: NetCell) => `${name(cell.sender)} → ${name(cell.receiver)}${cell.audioBad ? ' (zvuk)' : ''}${cell.videoBad ? ' (obraz)' : ''}`;
  for (const group of groups.values()) {
    const routes = group.cells.map(route).join(', ');
    const who = group.who ? name(group.who) : '';
    switch (group.cause) {
      case 'cpu':
        hints.push({ cause: 'cpu', severity: 'critical', title: `Zariadenie hráča ${who} nestíha (CPU)`, detail: `Prehliadač znižuje video pre výkon. Postihnuté: ${routes}. Pomôže zavrieť iné aplikácie alebo vypnúť kameru.` });
        break;
      case 'upload': {
        const avail = group.cells.map((cell) => at(cell.outbound?.avail, index)).filter((value): value is number => value !== null);
        const availText = avail.length ? ` Odhad dostupného uploadu na spojenie ${Math.min(...avail)} kb/s.` : '';
        hints.push({ cause: 'upload', severity: 'critical', title: `Upload hráča ${who} nestačí`, detail: `Problém má väčšina spojení od neho.${availText} Postihnuté: ${routes}.` });
        break;
      }
      case 'hidden':
        hints.push({ cause: 'hidden', severity: 'warning', title: `Hra hráča ${who} beží na pozadí`, detail: `Prehliadač na pozadí tlmí prehrávanie. Postihnuté: ${routes}.` });
        break;
      case 'download':
        hints.push({ cause: 'download', severity: 'critical', title: `Sieť hráča ${who} neprijíma plynulo`, detail: `Seká mu väčšina prichádzajúcich spojení — download, Wi-Fi alebo mobilný signál. Postihnuté: ${routes}.` });
        break;
      case 'relay': {
        const rtts = group.cells.map((cell) => at(cell.inbound?.rtt, index)).filter((value): value is number => value !== null);
        const rttText = rtts.length ? ` RTT ${Math.round(Math.max(...rtts))} ms.` : '';
        const tcp = group.cells.some((cell) => /^relay\/(tcp|tls)/.test(cell.inbound?.path[index] ?? cell.outbound?.path[index] ?? ''));
        hints.push(
          tcp
            ? { cause: 'relay', severity: 'critical', title: 'Spojenie cez relay po TCP', detail: `Priame spojenie nevyšlo a relay ide cez TCP (coturn cez Funnel alebo TURN cez TLS) — jedna strata zastaví celý prúd.${rttText} Postihnuté: ${routes}.` }
            : { cause: 'relay', severity: 'warning', title: 'Sekanie na spojení cez relay', detail: `Priame spojenie nevyšlo, médiá idú cez relay.${rttText} Postihnuté: ${routes}.` },
        );
        break;
      }
      case 'latency':
        hints.push({ cause: 'latency', severity: 'warning', title: 'Vysoké oneskorenie medzi hráčmi', detail: `Postihnuté: ${routes}.` });
        break;
      default:
        hints.push({ cause: 'unknown', severity: 'warning', title: 'Sekanie bez jasnej príčiny', detail: `Strata paketov na trase bez obmedzenia u odosielateľa. Postihnuté: ${routes}.` });
    }
  }

  const slow = series.players.filter((player) => (at(series.player[player.id]?.serverRtt, index) ?? 0) >= PROBLEM.serverRttMs);
  if (slow.length) {
    hints.push({
      cause: 'signal',
      severity: 'warning',
      title: 'Pomalé spojenie so serverom hry',
      detail: `${list(slow.map((player) => `${player.name} ${Math.round(at(series.player[player.id].serverRtt, index)!)} ms`))}. Ide cez Funnel ako relay — ak skáče súčasne so sekaním, je problém v sieti hráča alebo vo Funnel.`,
    });
  }
  return hints.sort((left, right) => CAUSE_ORDER.indexOf(left.cause) - CAUSE_ORDER.indexOf(right.cause));
}

/** Posledný interval, v ktorom niekto hlásil dáta (pre živý pohľad). */
export function lastFilledIndex(series: NetSeries): number {
  for (let index = series.times.length - 1; index >= 0; index--) {
    if (Object.values(series.player).some((player) => player.up[index] !== null || player.rtt[index] !== null)) {
      return index;
    }
  }
  return series.times.length - 1;
}
