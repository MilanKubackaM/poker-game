import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_SEATS } from '../../shared/constants';
import { NET_LIVE_MS, NET_SAMPLE_MS, NetSeriesBuilder, diagnoseNet, lastFilledIndex, netCells, sanitizeNetSample, type NetLine, type NetLinkSample, type NetSample, type NetServerSample } from '../../shared/netstats';
import { NetStatsStore, statsAccess } from '../NetStats';

const T0 = Date.UTC(2026, 10, 3, 18, 0, 0);
const IDS = { milky: 'p-milky', korki: 'p-korki', juraj: 'p-juraj' };
const NAMES: Record<string, string> = { [IDS.milky]: 'Milky', [IDS.korki]: 'Korki', [IDS.juraj]: 'Juraj' };

function link(to: string, extra: Partial<NetLinkSample> = {}): NetLinkSample {
  return { to, toName: NAMES[to], state: 'connected', path: 'host/udp→srflx', relay: false, rttMs: 40, upKbps: 400, downKbps: 400, concealPct: 0, audioLossPct: 0, videoLossPct: 0, videoInFps: 15, freezes: 0, ...extra };
}

function player(from: string, t: number, links: NetLinkSample[], extra: Partial<NetSample> = {}): NetLine {
  return { kind: 'player', t, code: 'ABC123', table: 'Piatok', from, name: NAMES[from], sample: { serverRttMs: 50, hidden: false, links, ...extra } };
}

function server(t: number, extra: Partial<NetServerSample> = {}): NetLine {
  return { kind: 'server', t, server: { cpuPct: 3, load1: 0.5, cores: 6, loopP99Ms: 12, loopMaxMs: 20, rssMb: 90, heapMb: 40, sockets: 3, reporters: 3, ...extra } };
}

/** Tri hráči, každý so spojením na dvoch ostatných; `tweak` upraví spojenie (hlásiaci, protihráč). */
function table(t: number, tweak: (from: string, to: string) => Partial<NetLinkSample> = () => ({}), sample: (from: string) => Partial<NetSample> = () => ({})): NetLine[] {
  const ids = Object.values(IDS);
  return ids.map((from) =>
    player(
      from,
      t,
      ids.filter((to) => to !== from).map((to) => link(to, tweak(from, to))),
      sample(from),
    ),
  );
}

function build(lines: NetLine[], from = T0, to = T0 + 60_000) {
  const builder = new NetSeriesBuilder(from, to);
  for (const line of lines) {
    builder.add(line);
  }
  return builder.result(null, to);
}

describe('sanitizeNetSample', () => {
  it('nechá len známe polia, oreže čísla a zahodí neplatné spojenia', () => {
    const sample = sanitizeNetSample({
      serverRttMs: 120.4,
      hidden: true,
      evil: '<script>',
      connection: { type: 'wifi', effectiveType: '4g', downlinkMbps: 9.87, junk: 1 },
      links: [
        { to: 'p-korki', rttMs: 88.6, concealPct: 150, upKbps: -5, path: 'relay/tls→relay', state: 'connected', limit: 'cpu', events: [{ ageMs: 1200, kind: 'disconnected' }, { ageMs: 5, kind: 'boom' }] },
        { to: 'p-korki', rttMs: 1 },
        { to: '../../etc', rttMs: 1 },
        { to: 'p-juraj', path: '<img onerror=x>', state: 'weird', limit: 'nope', freezes: Number.NaN },
        null,
      ],
    });
    expect(sample).toEqual({
      serverRttMs: 120,
      hidden: true,
      connection: { type: 'wifi', effectiveType: '4g', downlinkMbps: 9.9 },
      links: [
        { to: 'p-korki', rttMs: 89, concealPct: 100, upKbps: 0, path: 'relay/tls→relay', state: 'connected', limit: 'cpu', events: [{ ageMs: 1200, kind: 'disconnected' }] },
        { to: 'p-juraj' },
      ],
    });
  });

  it('odmietne vzorku bez zoznamu spojení a oreže počet spojení na počet miest', () => {
    expect(sanitizeNetSample(null)).toBeNull();
    expect(sanitizeNetSample({ links: 'x' })).toBeNull();
    const many = sanitizeNetSample({ links: Array.from({ length: 30 }, (_, index) => ({ to: `p-${index}` })) });
    expect(many!.links).toHaveLength(MAX_SEATS);
  });
});

describe('NetSeriesBuilder', () => {
  it('zlúči vzorky do intervalov: rýchlosti priemerom, sekanie maximom, zamrznutia súčtom', () => {
    const series = build(
      [
        player(IDS.milky, T0 + 1000, [link(IDS.korki, { upKbps: 300, concealPct: 1, freezes: 1, freezeMs: 400 })]),
        player(IDS.milky, T0 + 3000, [link(IDS.korki, { upKbps: 500, concealPct: 7, freezes: 2, freezeMs: 900 })]),
        player(IDS.milky, T0 + 21_000, [link(IDS.korki, { upKbps: 100 })]),
      ],
      T0,
      T0 + 30_000,
    );
    expect(series.bucketMs).toBe(NET_SAMPLE_MS);
    expect(series.times).toHaveLength(7);
    const milky = series.player[IDS.milky];
    expect(milky.up.slice(0, 5)).toEqual([400, null, null, null, 100]);
    expect(milky.conceal[0]).toBe(7);
    expect(milky.freezes[0]).toBe(3);
    const pair = series.links[`${IDS.milky}>${IDS.korki}`];
    expect(pair.freezeMs[0]).toBe(1300);
    expect(series.players).toEqual([
      { id: IDS.korki, name: 'Korki' },
      { id: IDS.milky, name: 'Milky' },
    ]);
    expect(lastFilledIndex(series)).toBe(4);
  });

  it('dlhý rozsah zlúči do najviac 360 bodov', () => {
    const series = build([], T0, T0 + 24 * 3600_000);
    expect(series.times.length).toBeLessThanOrEqual(360);
    expect(series.bucketMs % NET_SAMPLE_MS).toBe(0);
  });

  it('z hlásení spraví udalosti: výpadok spojenia s presným časom, zamrznutie, sekanie zvuku, odpojenie od servera', () => {
    const series = build([
      player(IDS.korki, T0 + 10_000, [link(IDS.milky, { freezes: 2, freezeMs: 3400, concealPct: 12.5, events: [{ ageMs: 4000, kind: 'disconnected' }, { ageMs: 1000, kind: 'restart' }] })]),
      { kind: 'event', t: T0 + 20_000, code: 'ABC123', table: 'Piatok', from: IDS.korki, name: 'Korki', text: 'odpojený od servera (transport close)' },
    ]);
    expect(series.events.map((event) => [event.t - T0, event.kind, event.player, event.peer ?? null, event.text])).toEqual([
      [20_000, 'socket', 'Korki', null, 'odpojený od servera (transport close)'],
      [10_000, 'freeze', 'Korki', 'Milky', 'obraz zamrzol 2× (spolu 3,4 s)'],
      [10_000, 'audio', 'Korki', 'Milky', 'zvuk seká — doplnené až 12,5 %'],
      [9000, 'ice', 'Korki', 'Milky', 'spojenie: reštart (ICE)'],
      [6000, 'ice', 'Korki', 'Milky', 'spojenie: prerušené'],
    ]);
  });

  it('po sebe idúce sekanie toho istého spojenia zlúči do jednej epizódy, po prestávke začne novú', () => {
    const bad = (t: number, concealPct: number) => player(IDS.korki, T0 + t, [link(IDS.milky, { concealPct, freezes: 1, freezeMs: 500 })]);
    const series = build([bad(5000, 8), bad(10_000, 21.4), bad(15_000, 6), bad(45_000, 9)]);
    const audio = series.events.filter((event) => event.kind === 'audio').map((event) => [event.t - T0, event.end ? event.end - T0 : null, event.text]);
    expect(audio).toEqual([
      [45_000, null, 'zvuk seká — doplnené až 9 %'],
      [5000, 15_000, 'zvuk seká — doplnené až 21,4 % (3 merania)'],
    ]);
    const freeze = series.events.filter((event) => event.kind === 'freeze').map((event) => event.text);
    expect(freeze).toEqual(['obraz zamrzol 1× (spolu 0,5 s)', 'obraz zamrzol 3× (spolu 1,5 s)']);
  });

  it('drží stoly zvlášť a bez voľby vráti ten s najnovšími dátami', () => {
    const other: NetLine = { ...player(IDS.juraj, T0 + 30_000, [link(IDS.milky)]), code: 'XYZ999', table: 'Sobota' } as NetLine;
    const builder = new NetSeriesBuilder(T0, T0 + 60_000);
    for (const line of [...table(T0 + 1000), other, server(T0 + 2000, { load1: 9 })]) {
      builder.add(line);
    }
    const latest = builder.result(null, T0);
    expect(latest.code).toBe('XYZ999');
    expect(latest.tables.map((entry) => entry.code)).toEqual(['XYZ999', 'ABC123']);
    expect(latest.server.load[0]).toBe(9);
    const chosen = builder.result('ABC123', T0);
    expect(chosen.players).toHaveLength(3);
    expect(Object.keys(chosen.links)).toHaveLength(6);
  });
});

describe('diagnoseNet — prečo seká', () => {
  it('bez problémov nevráti nič', () => {
    const series = build(table(T0 + 1000));
    expect(diagnoseNet(series, 0)).toEqual([]);
    expect(netCells(series, 0).every((cell) => !cell.problem)).toBe(true);
  });

  it('celý riadok zlý (všetci majú problém s Milkyho streamom) = upload Milkyho', () => {
    const series = build(table(T0 + 1000, (_from, to) => (to === IDS.milky ? { concealPct: 9, videoLossPct: 8 } : {})));
    const hints = diagnoseNet(series, 0);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toMatchObject({ cause: 'upload', severity: 'critical', title: 'Upload hráča Milky nestačí' });
    expect(hints[0].detail).toContain('Milky → Juraj (zvuk) (obraz)');
    expect(hints[0].detail).toContain('Milky → Korki');
  });

  it('celý stĺpec zlý (Korkimu seká všetko) = sieť Korkiho', () => {
    const series = build(table(T0 + 1000, (from) => (from === IDS.korki ? { concealPct: 6 } : {})));
    const hints = diagnoseNet(series, 0);
    expect(hints.map((hint) => hint.cause)).toEqual(['download']);
    expect(hints[0].title).toBe('Sieť hráča Korki neprijíma plynulo');
  });

  it('prehliadač hlási obmedzenie CPU u odosielateľa — má prednosť pred vzorom v matici', () => {
    const series = build(table(T0 + 1000, (from, to) => (from === IDS.juraj && to === IDS.korki ? { limit: 'cpu' } : from === IDS.korki && to === IDS.juraj ? { freezes: 1 } : {})));
    expect(diagnoseNet(series, 0).map((hint) => [hint.cause, hint.title])).toEqual([['cpu', 'Zariadenie hráča Juraj nestíha (CPU)']]);
  });

  it('seká len jedno spojenie cez relay = relay na NAS s RTT', () => {
    const relayed = (from: string, to: string) => (from === IDS.korki && to === IDS.milky) || (from === IDS.milky && to === IDS.korki);
    const series = build(table(T0 + 1000, (from, to) => (relayed(from, to) ? { relay: true, path: 'relay/tls→relay', rttMs: 420, ...(from === IDS.korki ? { concealPct: 11 } : {}) } : {})));
    const hints = diagnoseNet(series, 0);
    expect(hints.map((hint) => [hint.cause, hint.title])).toEqual([['relay', 'Spojenie cez relay po TCP']]);
    expect(hints[0].detail).toContain('RTT 420 ms');
    expect(hints[0].detail).toContain('Milky → Korki (zvuk)');
  });

  it('hra na pozadí, preťažený NAS a pomalý server sa ukážu tiež', () => {
    const lines = [
      ...table(T0 + 1000, (from, to) => (from === IDS.juraj && to === IDS.milky ? { concealPct: 20 } : {}), (from) => (from === IDS.juraj ? { hidden: true, serverRttMs: 900 } : {})),
      server(T0 + 2000, { load1: 12, cores: 6, loopP99Ms: 350 }),
    ];
    const causes = diagnoseNet(build(lines), 0).map((hint) => hint.cause);
    expect(causes).toEqual(['server', 'nas', 'hidden', 'signal']);
  });
});

describe('NetStatsStore', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function tempDir(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'netstats-'));
    dirs.push(dir);
    return dir;
  }

  it('živý pohľad z pamäte a história z disku aj po reštarte servera', async () => {
    const dir = tempDir();
    let now = T0;
    const store = new NetStatsStore(dir, { now: () => now });
    for (let step = 0; step < 6; step++) {
      now = T0 + step * NET_SAMPLE_MS;
      store.recordPlayer('ABC123', 'Piatok', IDS.milky, 'Milky', { serverRttMs: 40, links: [link(IDS.korki, { upKbps: 100 * (step + 1) })] });
      store.recordServer({ cpuPct: 2, load1: 0.3, cores: 6, loopP99Ms: 10, loopMaxMs: 15, rssMb: 80, heapMb: 30, sockets: 2, reporters: 1 }, step % 2 === 0);
    }
    store.recordEvent('ABC123', 'Piatok', IDS.korki, 'Korki', 'pripojený k serveru');
    const live = store.live(null);
    expect(live.code).toBe('ABC123');
    expect(live.player[IDS.milky].up.filter((value) => value !== null)).toEqual([100, 200, 300, 400, 500, 600]);
    expect(live.server.cpu.filter((value) => value !== null)).toHaveLength(6);

    const restarted = new NetStatsStore(dir, { now: () => now });
    const history = await restarted.history(T0 - 60_000, now + 1, 'ABC123');
    expect(history.player[IDS.milky].up.filter((value) => value !== null)).toEqual([100, 200, 300, 400, 500, 600]);
    expect(history.server.cpu.filter((value) => value !== null)).toHaveLength(3);
    expect(history.events.map((event) => event.text)).toEqual(['pripojený k serveru']);
    expect(restarted.live(null).players).toEqual([]);
  });

  it('živý pohľad zabudne staré vzorky', () => {
    let now = T0;
    const store = new NetStatsStore(tempDir(), { now: () => now });
    for (let step = 0; step < 100; step++) {
      store.recordPlayer('ABC123', 'Piatok', IDS.milky, 'Milky', { links: [link(IDS.korki)] });
      now += 20_000;
    }
    const live = store.live(null);
    expect(live.from).toBeGreaterThanOrEqual(now - NET_LIVE_MS - NET_SAMPLE_MS);
    expect(live.player[IDS.milky].up.filter((value) => value !== null).length).toBeLessThanOrEqual(NET_LIVE_MS / 20_000 + 1);
  });

  it('história preskočí poškodený riadok a nečíta mimo rozsahu', async () => {
    const dir = tempDir();
    const store = new NetStatsStore(dir, { now: () => T0 + 60_000 });
    store.recordPlayer('ABC123', 'Piatok', IDS.milky, 'Milky', { links: [link(IDS.korki)] });
    writeFileSync(path.join(store.dir, '2026-11-03.jsonl'), '{"kind":"player",broken\n', { flag: 'a' });
    const history = await store.history(T0, T0 + 60_000, null);
    expect(history.players.map((entry) => entry.name)).toEqual(['Korki', 'Milky']);
    const empty = await store.history(T0 - 7200_000, T0 - 3600_000, null);
    expect(empty.players).toEqual([]);
  });

  it('upratovanie zmaže dni staršie ako retencia, dnešok nechá', () => {
    const dir = tempDir();
    const store = new NetStatsStore(dir, { now: () => T0, retentionDays: 3 });
    for (const day of ['2026-10-25', '2026-10-31', '2026-11-01', '2026-11-03', 'notes.txt']) {
      writeFileSync(path.join(store.dir, day.endsWith('.txt') ? day : `${day}.jsonl`), 'x\n');
    }
    store.prune();
    expect(readdirSync(store.dir).sort()).toEqual(['2026-10-31.jsonl', '2026-11-01.jsonl', '2026-11-03.jsonl', 'notes.txt']);
  });

  it('nad stropom veľkosti zmaže najstaršie dni', () => {
    const store = new NetStatsStore(tempDir(), { now: () => T0, maxBytes: 25 });
    for (const day of ['2026-11-01', '2026-11-02', '2026-11-03']) {
      writeFileSync(path.join(store.dir, `${day}.jsonl`), 'x'.repeat(10));
    }
    store.prune();
    expect(readdirSync(store.dir).sort()).toEqual(['2026-11-02.jsonl', '2026-11-03.jsonl']);
  });
});

describe('statsAccess', () => {
  it('pustí len so správnym kľúčom; bez kľúča je v produkcii vypnuté', () => {
    expect(statsAccess('tajne-heslo', 'tajne-heslo', true)).toBe('ok');
    expect(statsAccess('tajne-heslo', 'tajne-hesl0', true)).toBe('denied');
    expect(statsAccess('tajne-heslo', 'kratke', true)).toBe('denied');
    expect(statsAccess('tajne-heslo', undefined, true)).toBe('denied');
    expect(statsAccess('', 'cokolvek', true)).toBe('disabled');
    expect(statsAccess('', undefined, false)).toBe('ok');
  });
});
