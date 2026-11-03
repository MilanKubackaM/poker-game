import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Avatar, TableEvent, TableSettings } from '../../shared/types';
import { DEFAULT_SETTINGS, HAND_PAUSE_MS } from '../../shared/constants';
import { Table, type TableHooks, type TablePlayer, type TableSnapshot } from '../Table';
import { TEST_BUY_IN, buyIn, setTestBuyIn } from './helpers';

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
const hooks: TableHooks = { onChange: () => undefined, onEvent: () => undefined, onRemoved: () => undefined };
const BASE = DEFAULT_SETTINGS.actionTimeoutSec * 1000;
const BANK = DEFAULT_SETTINGS.timeBankSec * 1000;

let current: Table[] = [];
let socketSeq = 0;

function createTable(testSettings: Partial<TableSettings> & { startingStack?: number } = {}): { table: Table; events: TableEvent[] } {
  const { startingStack = TEST_BUY_IN, ...settings } = testSettings;
  const events: TableEvent[] = [];
  const table = new Table('TIME01', { ...DEFAULT_SETTINGS, ...settings }, {
    onChange: () => undefined,
    onEvent: (_table, event) => events.push(event),
    onRemoved: () => undefined,
  });
  setTestBuyIn(table, startingStack);
  current.push(table);
  return { table, events };
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

/** Heads-up, dealer (= SB, koná preflop prvý) je Adam na mieste 0. */
function headsUp(settings: Partial<TableSettings> = {}): { table: Table; events: TableEvent[]; a: TablePlayer; b: TablePlayer } {
  const { table, events } = createTable(settings);
  const a = join(table, 'Adam');
  const b = join(table, 'Bea');
  expect(table.hostStart().ok).toBe(true);
  rigged.forcedRandomInt.push(0);
  expect(table.hostDealerChoice('random').ok).toBe(true);
  vi.advanceTimersByTime(1500);
  expect(table.engine?.toAct?.id).toBe(a.id);
  return { table, events, a, b };
}

function seat(table: Table, player: TablePlayer) {
  return table.view(player.id).players.find((view) => view.id === player.id)!;
}

/** Hráč na ťahu dorovná (alebo checkne). */
function callOrCheck(table: Table, player: TablePlayer): void {
  expect(table.engine!.toAct?.id).toBe(player.id);
  const legal = table.engine!.legalActions(player.id)!;
  expect(table.act(player, legal.callAmount > 0 ? { type: 'call' } : { type: 'check' }).ok).toBe(true);
}

beforeEach(() => {
  vi.useFakeTimers();
  rigged.forcedRandomInt.length = 0;
});

afterEach(() => {
  for (const table of current.splice(0)) {
    table.dispose();
  }
  vi.useRealTimers();
});

describe('time bank', () => {
  it('starts every player with timeBankSec and shows base and full deadlines in the view', () => {
    const { table, a, b } = headsUp();
    const start = Date.now();
    expect(seat(table, a).timeBankMs).toBe(BANK);
    expect(seat(table, b).timeBankMs).toBe(BANK);
    const hand = table.view(b.id).hand!;
    expect(hand.turnBaseDeadline).toBe(start + BASE);
    expect(hand.turnDeadline).toBe(start + BASE + BANK);
    vi.advanceTimersByTime(3000);
    table.detachSocket(b, [...b.sockets][0]);
    expect(table.view(a.id).hand!.turnBaseDeadline).toBe(start + BASE);
  });

  it('adds half of the saved base time (rounded down to ms) when acting within the base', () => {
    const { table, a, b } = headsUp();
    vi.advanceTimersByTime(5000);
    callOrCheck(table, a);
    expect(a.timeBankMs).toBe(BANK + 5000);
    expect(seat(table, a).timeBankMs).toBe(BANK + 5000);
    vi.advanceTimersByTime(7001);
    callOrCheck(table, b);
    expect(b.timeBankMs).toBe(BANK + 3999);
  });

  it('runs the bank after the base time and subtracts what was used', () => {
    const { table, a, events } = headsUp();
    vi.advanceTimersByTime(BASE + 20_000);
    expect(table.engine!.toAct?.id).toBe(a.id);
    expect(events.some((event) => event.text.includes('čas na ťah vypršal'))).toBe(false);
    callOrCheck(table, a);
    expect(a.timeBankMs).toBe(BANK - 20_000);
  });

  it('never drops below the 5 s floor and never exceeds 200 s', () => {
    const { table, a, b } = headsUp();
    b.timeBankMs = 199_000;
    vi.advanceTimersByTime(BASE + BANK - 1000);
    callOrCheck(table, a);
    expect(a.timeBankMs).toBe(5000);
    expect(table.view(b.id).hand!.turnDeadline).toBe(Date.now() + BASE + 199_000);
    callOrCheck(table, b);
    expect(b.timeBankMs).toBe(200_000);
  });

  it('a full timeout auto-acts and leaves the bank at 5 s; the next turn gets at least 5 s of bank', () => {
    const { table, a, events } = headsUp();
    vi.advanceTimersByTime(BASE + BANK);
    expect(events.some((event) => event.text === 'Adam: čas na ťah vypršal — automatický ťah')).toBe(true);
    expect(table.engine!.player(a.id)!.status).toBe('folded');
    expect(a.timeBankMs).toBe(5000);
    vi.advanceTimersByTime(HAND_PAUSE_MS);
    const view = table.view(a.id).hand!;
    expect(view.turnDeadline! - view.turnBaseDeadline!).toBeGreaterThanOrEqual(5000);
  });

  it('with timeouts disabled there are no deadlines and the bank does not change', () => {
    const { table, a } = headsUp({ actionTimeoutSec: 0 });
    const hand = table.view(a.id).hand!;
    expect(hand.turnDeadline).toBeNull();
    expect(hand.turnBaseDeadline).toBeNull();
    vi.advanceTimersByTime(500_000);
    expect(table.engine!.toAct?.id).toBe(a.id);
    callOrCheck(table, a);
    expect(a.timeBankMs).toBe(BANK);
  });

  it('a player on a short break acts instantly without a bank change', () => {
    const { table, a } = headsUp();
    vi.advanceTimersByTime(2000);
    table.setAway(a, true);
    vi.advanceTimersByTime(1);
    expect(table.engine!.player(a.id)!.status).toBe('folded');
    expect(a.timeBankMs).toBe(BANK);
  });

  it('a disconnected player gets at most 15 s from the disconnect, the bank charged only for the time used past the base', () => {
    const { table, a } = headsUp();
    vi.advanceTimersByTime(BASE + 5000);
    table.detachSocket(a, [...a.sockets][0]);
    const hand = table.view(a.id).hand!;
    expect(hand.turnDeadline).toBe(Date.now() + 15_000);
    vi.advanceTimersByTime(15_000);
    expect(table.engine!.player(a.id)!.status).toBe('folded');
    expect(a.timeBankMs).toBe(BANK - 20_000);
  });

  it('keeps the bank across hands, a return to the lobby and a server restart; old files get timeBankSec', () => {
    const { table, a, b } = headsUp();
    vi.advanceTimersByTime(BASE + 30_000);
    callOrCheck(table, a);
    expect(a.timeBankMs).toBe(BANK - 30_000);
    expect(table.hostToLobby().ok).toBe(true);
    while (table.engine && !table.engine.isComplete) {
      const id = table.engine.toAct!.id;
      table.act(table.players.get(id)!, { type: 'fold' });
    }
    expect(table.phase).toBe('lobby');
    expect(a.timeBankMs).toBe(BANK - 30_000);
    const snapshot = JSON.parse(JSON.stringify(table.toSnapshot())) as TableSnapshot;
    expect(snapshot.players.find((player) => player.id === a.id)!.timeBankMs).toBe(BANK - 30_000);
    const restored = Table.fromSnapshot(snapshot, hooks);
    current.push(restored);
    expect(restored.players.get(a.id)!.timeBankMs).toBe(BANK - 30_000);
    for (const player of snapshot.players) {
      delete player.timeBankMs;
    }
    snapshot.settings.timeBankSec = 80;
    const old = Table.fromSnapshot(snapshot, hooks);
    current.push(old);
    expect(old.players.get(b.id)!.timeBankMs).toBe(80_000);
  });

  it('validates timeBankSec 5–200 s; a change applies to newly joining players only', () => {
    const { table, events } = createTable();
    const a = join(table, 'Adam');
    expect(table.hostSettings({ timeBankSec: 4 })).toEqual({ ok: false, error: 'Timebank musí byť 5–200 s' });
    expect(table.hostSettings({ timeBankSec: 201 })).toEqual({ ok: false, error: 'Timebank musí byť 5–200 s' });
    expect(table.hostSettings({ timeBankSec: 2.5 })).toEqual({ ok: false, error: 'Neplatná hodnota: timeBankSec' });
    expect(table.hostSettings({ timeBankSec: 5 }).ok).toBe(true);
    expect(table.hostSettings({ timeBankSec: 200 }).ok).toBe(true);
    expect(events.at(-1)!.text).toBe('Nové pravidlá: timebank pre nových hráčov 200 s');
    expect(table.hostSettings({ actionTimeoutSec: 4 }).ok).toBe(false);
    expect(a.timeBankMs).toBe(BANK);
    const late = join(table, 'Bea');
    expect(late.timeBankMs).toBe(200_000);
  });
});
