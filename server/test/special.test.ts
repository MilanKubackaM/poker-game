import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Avatar, TableEvent, TableSettings } from '../../shared/types';
import { DEFAULT_SETTINGS, DISCARD_TIMEOUT_SEC, HAND_PAUSE_MS, MAX_SPECIAL_HANDS } from '../../shared/constants';
import { Table, type TableHooks, type TablePlayer, type TableSnapshot } from '../Table';
import { buyIn } from './helpers';

const rigged = vi.hoisted(() => ({ forcedRandomInt: [] as number[] }));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    randomInt: ((...args: Parameters<typeof actual.randomInt>) => {
      const forced = rigged.forcedRandomInt.shift();
      return forced ?? (actual.randomInt as (...rest: unknown[]) => number)(...args);
    }) as typeof actual.randomInt,
  };
});

const avatar: Avatar = { emoji: '🦊', color: '#e76f51' };
let current: Table[] = [];
let socketSeq = 0;

function createTable(settings: Partial<TableSettings> = {}): { table: Table; events: TableEvent[]; hooks: TableHooks } {
  const events: TableEvent[] = [];
  const hooks: TableHooks = { onChange: () => undefined, onEvent: (_table, event) => events.push(event), onRemoved: () => undefined };
  const table = new Table('SPEC01', { ...DEFAULT_SETTINGS, ...settings }, hooks);
  current.push(table);
  return { table, events, hooks };
}

function join(table: Table, name: string): TablePlayer {
  const added = table.addPlayer(name, avatar);
  if (!added.ok || !added.data) {
    throw new Error(`join ${name} failed`);
  }
  table.attachSocket(added.data, `socket-${++socketSeq}`);
  buyIn(table, added.data);
  return added.data;
}

function inHand(table: Table): boolean {
  return !!table.engine && !table.engine.isComplete;
}

function ackIntros(table: Table): void {
  while (table.modeIntro) {
    for (const id of [...table.modeIntro.participants]) {
      table.modeAck(table.players.get(id)!);
    }
    vi.advanceTimersByTime(2000);
  }
}

function foldHand(table: Table): void {
  while (inHand(table)) {
    const actor = table.players.get(table.engine!.toAct!.id)!;
    expect(table.act(actor, { type: 'fold' }).ok).toBe(true);
  }
}

/** Dohrá rozdanú ruku a rozdá ďalšiu (potvrdí úvody módov). Vráti variant novej ruky. */
function playNext(table: Table): string {
  foldHand(table);
  vi.advanceTimersByTime(HAND_PAUSE_MS + 100);
  ackIntros(table);
  expect(inHand(table)).toBe(true);
  return table.engine!.rules.variant;
}

function startGame(table: Table): string {
  expect(table.hostStart().ok).toBe(true);
  expect(table.hostDealerChoice('random').ok).toBe(true);
  vi.advanceTimersByTime(1500);
  ackIntros(table);
  expect(inHand(table)).toBe(true);
  return table.engine!.rules.variant;
}

const modeTexts = (events: TableEvent[]) => events.filter((event) => event.kind === 'mode').map((event) => event.text);

beforeEach(() => {
  vi.useFakeTimers();
  rigged.forcedRandomInt.length = 0;
});

afterEach(() => {
  for (const table of current) {
    table.dispose();
  }
  current = [];
  vi.useRealTimers();
});

describe('špeciálne kolo na viac kôl', () => {
  it('predvolene platí na jedno kolo a potom sa ohlási koniec', () => {
    const { table, events } = createTable();
    join(table, 'Milan');
    join(table, 'Juraj');
    expect(table.hostNextHand({ variant: 'omaha' })).toEqual({ ok: true });
    expect(table.nextHand).toEqual({ variant: 'omaha', hands: 1 });
    expect(modeTexts(events)).toEqual(['Host vyhlasuje špeciálne kolo: Omaha na 1 kolo od ďalšej ruky']);
    expect(startGame(table)).toBe('omaha');
    expect(table.nextHand).toBeNull();
    expect(playNext(table)).toBe('holdem');
    expect(modeTexts(events).at(-1)).toBe("Špeciálne kolo Omaha skončilo — znova sa hrá Texas Hold'em");
  });

  it('platí presne zadaný počet kôl, počet klesá a pravidlá sa ukážu len pred prvým', () => {
    const { table, events } = createTable();
    join(table, 'Milan');
    join(table, 'Juraj');
    expect(table.hostNextHand({ variant: 'pineapple', hands: 3 }).ok).toBe(true);
    expect(modeTexts(events)).toEqual(['Host vyhlasuje špeciálne kolo: Pineapple na 3 kolá od ďalšej ruky']);
    const introsBefore = events.filter((event) => event.text.startsWith('Nový mód: Pineapple')).length;
    expect(startGame(table)).toBe('pineapple');
    expect(table.nextHand).toEqual({ variant: 'pineapple', hands: 2 });
    expect(table.view(table.hostId).nextHand).toEqual({ variant: 'pineapple', hands: 2 });
    expect(playNext(table)).toBe('pineapple');
    expect(table.nextHand).toEqual({ variant: 'pineapple', hands: 1 });
    expect(playNext(table)).toBe('pineapple');
    expect(table.nextHand).toBeNull();
    expect(events.filter((event) => event.text.startsWith('Nový mód: Pineapple')).length).toBe(introsBefore + 1);
    expect(events.some((event) => event.text === 'Špeciálne kolo: Pineapple — posledná ruka')).toBe(true);
    expect(playNext(table)).toBe('holdem');
    expect(modeTexts(events).at(-1)).toBe("Špeciálne kolo Pineapple skončilo — znova sa hrá Texas Hold'em");
  });

  it('zmena počtu kôl a zrušenie počas hry sa ohlási všetkým', () => {
    const { table, events } = createTable();
    join(table, 'Milan');
    join(table, 'Juraj');
    expect(table.hostNextHand({ variant: 'omaha', hands: 5 }).ok).toBe(true);
    expect(startGame(table)).toBe('omaha');
    expect(table.hostNextHand({ variant: 'omaha', hands: 2 }).ok).toBe(true);
    expect(modeTexts(events).at(-1)).toBe('Host mení špeciálne kolo: Omaha ešte 2 kolá po tejto ruke');
    expect(table.hostNextHand(null).ok).toBe(true);
    expect(modeTexts(events).at(-1)).toBe("Host ruší špeciálne kolo — po tejto ruke sa hrá Texas Hold'em");
    expect(playNext(table)).toBe('holdem');
    expect(modeTexts(events).at(-1)).toBe("Špeciálne kolo Omaha skončilo — znova sa hrá Texas Hold'em");
  });

  it('odmietne neplatný počet kôl', () => {
    const { table } = createTable();
    join(table, 'Milan');
    expect(table.hostNextHand({ variant: 'omaha', hands: 0 }).ok).toBe(false);
    expect(table.hostNextHand({ variant: 'omaha', hands: 2.5 }).ok).toBe(false);
    expect(table.hostNextHand({ variant: 'omaha', hands: MAX_SPECIAL_HANDS + 1 }).ok).toBe(false);
    expect(table.hostNextHand({ variant: 'omaha', hands: MAX_SPECIAL_HANDS }).ok).toBe(true);
  });

  it('zostávajúce kolá prežijú reštart servera', () => {
    const { table, hooks } = createTable();
    join(table, 'Milan');
    join(table, 'Juraj');
    expect(table.hostNextHand({ variant: 'omaha', hands: 4 }).ok).toBe(true);
    const snapshot = JSON.parse(JSON.stringify(table.toSnapshot())) as TableSnapshot;
    const restored = Table.fromSnapshot(snapshot, hooks);
    current.push(restored);
    expect(restored.nextHand).toEqual({ variant: 'omaha', hands: 4 });
    snapshot.nextHand = { variant: 'omaha', hands: -3 };
    const sanitized = Table.fromSnapshot(snapshot, hooks);
    current.push(sanitized);
    expect(sanitized.nextHand).toEqual({ variant: 'omaha', hands: 1 });
  });

  it('zapnutie a vypnutie 7-2 aj Prasiatka sú upozornenia pre všetkých', () => {
    const { table, events } = createTable();
    join(table, 'Milan');
    join(table, 'Juraj');
    expect(table.hostSettings({ sevenDeuceAlways: true }).ok).toBe(true);
    expect(table.hostSettings({ sevenDeuceAlways: false }).ok).toBe(true);
    expect(table.hostPiggy({ action: 'start' }).ok).toBe(true);
    expect(table.hostPiggy({ action: 'cancel' }).ok).toBe(true);
    const texts = modeTexts(events);
    expect(texts).toContain('Pravidlo 7-2 je zapnuté (od ďalšej ruky)');
    expect(texts).toContain('Pravidlo 7-2 je vypnuté');
    expect(texts.some((text) => text.startsWith('Host spúšťa Prasiatko'))).toBe(true);
    expect(texts).toContain('Host ruší Prasiatko — vstupy sa vracajú');
  });
});

describe('špeciálne kolo natrvalo', () => {
  it('beží, kým ho host nevypne — počet sa neodpočítava a pravidlá sa ukážu len raz', () => {
    const { table, events } = createTable();
    join(table, 'Milan');
    join(table, 'Juraj');
    expect(table.hostNextHand({ variant: 'omaha', hands: 0, permanent: true })).toEqual({ ok: true });
    expect(table.nextHand).toEqual({ variant: 'omaha', permanent: true });
    expect(modeTexts(events)).toEqual(['Host vyhlasuje špeciálne kolo: Omaha natrvalo od ďalšej ruky']);
    expect(startGame(table)).toBe('omaha');
    for (let hand = 0; hand < MAX_SPECIAL_HANDS + 2; hand++) {
      expect(playNext(table)).toBe('omaha');
    }
    expect(table.nextHand).toEqual({ variant: 'omaha', permanent: true });
    expect(table.view(table.hostId).nextHand).toEqual({ variant: 'omaha', permanent: true });
    expect(events.filter((event) => event.text.startsWith('Nový mód: Omaha'))).toHaveLength(1);
    expect(events.filter((event) => event.text === 'Špeciálne kolo: Omaha — natrvalo, kým ho host nevypne')).toHaveLength(1);
    expect(events.some((event) => event.text.includes('posledná ruka'))).toBe(false);

    expect(table.hostNextHand(null).ok).toBe(true);
    expect(modeTexts(events).at(-1)).toBe("Host ruší špeciálne kolo — po tejto ruke sa hrá Texas Hold'em");
    expect(playNext(table)).toBe('holdem');
    expect(modeTexts(events).at(-1)).toBe("Špeciálne kolo Omaha skončilo — znova sa hrá Texas Hold'em");
  });

  it('prepínanie medzi počtom kôl a natrvalo sa ohlási a počet sa potom znova odpočítava', () => {
    const { table, events } = createTable();
    join(table, 'Milan');
    join(table, 'Juraj');
    expect(table.hostNextHand({ variant: 'pineapple', hands: 3 }).ok).toBe(true);
    expect(startGame(table)).toBe('pineapple');
    expect(table.hostNextHand({ variant: 'pineapple', permanent: true }).ok).toBe(true);
    expect(modeTexts(events).at(-1)).toBe('Host mení špeciálne kolo: Pineapple natrvalo — do vypnutia hostom');
    const count = modeTexts(events).length;
    expect(table.hostNextHand({ variant: 'pineapple', hands: 7, permanent: true }).ok).toBe(true);
    expect(modeTexts(events)).toHaveLength(count);
    expect(playNext(table)).toBe('pineapple');
    expect(table.nextHand).toEqual({ variant: 'pineapple', permanent: true });
    expect(table.hostNextHand({ variant: 'pineapple', hands: 1 }).ok).toBe(true);
    expect(modeTexts(events).at(-1)).toBe('Host mení špeciálne kolo: Pineapple ešte 1 kolo po tejto ruke');
    expect(table.hostNextHand({ variant: 'pineapple', hands: 0 }).ok).toBe(false);
    expect(playNext(table)).toBe('pineapple');
    expect(table.nextHand).toBeNull();
    expect(playNext(table)).toBe('holdem');
  });

  it('prepnutie natrvalo na iný variant platí od ďalšej ruky', () => {
    const { table, events } = createTable();
    join(table, 'Milan');
    join(table, 'Juraj');
    expect(table.hostNextHand({ variant: 'omaha', permanent: true }).ok).toBe(true);
    expect(startGame(table)).toBe('omaha');
    expect(table.hostNextHand({ variant: 'pineapple', permanent: true }).ok).toBe(true);
    expect(modeTexts(events).at(-1)).toBe('Host vyhlasuje špeciálne kolo: Pineapple natrvalo od ďalšej ruky');
    expect(playNext(table)).toBe('pineapple');
    expect(playNext(table)).toBe('pineapple');
  });

  it('prežije reštart servera', () => {
    const { table, hooks } = createTable();
    join(table, 'Milan');
    join(table, 'Juraj');
    expect(table.hostNextHand({ variant: 'omaha', permanent: true }).ok).toBe(true);
    const snapshot = JSON.parse(JSON.stringify(table.toSnapshot())) as TableSnapshot;
    const restored = Table.fromSnapshot(snapshot, hooks);
    current.push(restored);
    expect(restored.nextHand).toEqual({ variant: 'omaha', permanent: true });
  });
});

describe('Pineapple — zahodenie karty', () => {
  /** Traja hráči v Pineapple dorovnajú preflop — ruka čaká na zahodenie karty. */
  function discardStreet(): { table: Table; players: TablePlayer[] } {
    const { table } = createTable({ defaultVariant: 'pineapple' });
    const players = [join(table, 'Milan'), join(table, 'Juraj'), join(table, 'Peťo')];
    startGame(table);
    while (table.engine!.street === 'preflop') {
      const actor = table.players.get(table.engine!.toAct!.id)!;
      const legal = table.engine!.legalActions(actor.id)!;
      expect(table.act(actor, legal.callAmount > 0 ? { type: 'call' } : { type: 'check' }).ok).toBe(true);
    }
    expect(table.engine!.street).toBe('discard');
    return { table, players };
  }

  it(`po ${DISCARD_TIMEOUT_SEC} s zahodí za nerozhodnutých náhodnú kartu`, () => {
    expect(DISCARD_TIMEOUT_SEC).toBe(10);
    const { table, players } = discardStreet();
    const [milan, juraj, peto] = players;
    const before = new Map(players.map((player) => [player.id, [...table.engine!.player(player.id)!.hole]]));
    expect(table.discard(milan, 0).ok).toBe(true);
    rigged.forcedRandomInt.push(2, 1);
    vi.advanceTimersByTime(DISCARD_TIMEOUT_SEC * 1000 - 1);
    expect(table.engine!.street).toBe('discard');
    vi.advanceTimersByTime(1);
    expect(table.engine!.street).toBe('flop');
    expect(rigged.forcedRandomInt).toEqual([]);
    expect(table.engine!.player(juraj.id)!.hole).toEqual(before.get(juraj.id)!.filter((_card, index) => index !== 2));
    expect(table.engine!.player(peto.id)!.hole).toEqual(before.get(peto.id)!.filter((_card, index) => index !== 1));
  });

  it('hráčovi na pauze zahodí náhodnú kartu hneď', () => {
    const { table, players } = discardStreet();
    const peto = players[2];
    const before = [...table.engine!.player(peto.id)!.hole];
    rigged.forcedRandomInt.push(0);
    table.setAway(peto, true);
    vi.advanceTimersByTime(1);
    expect(table.engine!.player(peto.id)!.hole).toEqual(before.slice(1));
    expect(table.engine!.pendingDiscards()).toHaveLength(2);
  });
});
