import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Avatar, Card, TableSettings } from '../../shared/types';
import { DEFAULT_SETTINGS, HAND_PAUSE_MS, PIGGY_CELEBRATION_MS, PIGGY_TARGET_WINS } from '../../shared/constants';
import { Table, type TableHooks, type TablePlayer, type TableSnapshot } from '../Table';
import { stackDeck, buyIn } from './helpers';

const rigged = vi.hoisted(() => ({ forcedRandomInt: [] as number[], decks: [] as Card[][] }));

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

vi.mock('../poker/cards', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../poker/cards')>();
  return {
    ...actual,
    shuffle: (<T>(items: T[], random?: (max: number) => number): T[] => {
      const deck = items.length === 52 ? rigged.decks.shift() : undefined;
      return deck ? ([...deck] as T[]) : actual.shuffle(items, random);
    }) as typeof actual.shuffle,
  };
});

const avatar: Avatar = { emoji: '🦊', color: '#e76f51' };
const silent: TableHooks = { onChange: () => undefined, onEvent: () => undefined, onRemoved: () => undefined };
const tables: Table[] = [];
let socketSeq = 0;

function createTable(settings: Partial<TableSettings> = {}, hooks: TableHooks = silent): Table {
  const table = new Table('MINE01', { ...DEFAULT_SETTINGS, ...settings }, hooks);
  tables.push(table);
  return table;
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

/** Dealer prvej ruky je hráč na mieste 0; pravidlá módov sa potvrdia za všetkých. */
function startGame(table: Table): void {
  expect(table.hostStart().ok).toBe(true);
  rigged.forcedRandomInt.push(0);
  expect(table.hostDealerChoice('random').ok).toBe(true);
  vi.advanceTimersByTime(1500);
  ackIntros(table);
}

function ackIntros(table: Table): void {
  while (table.modeIntro) {
    for (const id of [...table.modeIntro.participants]) {
      table.modeAck(table.players.get(id)!);
    }
    vi.advanceTimersByTime(1500);
  }
  expect(inHand(table)).toBe(true);
}

function toAct(table: Table): TablePlayer {
  return table.players.get(table.engine!.toAct!.id)!;
}

function checkDown(table: Table): void {
  while (inHand(table)) {
    if (table.engine!.street === 'discard') {
      for (const pending of table.engine!.pendingDiscards()) {
        expect(table.discard(table.players.get(pending.id)!, 0).ok).toBe(true);
      }
      continue;
    }
    const player = toAct(table);
    const legal = table.engine!.legalActions(player.id)!;
    expect(table.act(player, legal.callAmount > 0 ? { type: 'call' } : { type: 'check' }).ok).toBe(true);
  }
}

function winHand(table: Table, winner: TablePlayer): void {
  while (inHand(table)) {
    const player = toAct(table);
    if (player === winner) {
      const legal = table.engine!.legalActions(player.id)!;
      expect(table.act(player, legal.callAmount > 0 ? { type: 'call' } : { type: 'check' }).ok).toBe(true);
    } else {
      expect(table.act(player, { type: 'fold' }).ok).toBe(true);
    }
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  rigged.forcedRandomInt.length = 0;
  rigged.decks.length = 0;
});

afterEach(() => {
  for (const table of tables.splice(0)) {
    table.dispose();
  }
  vi.useRealTimers();
});

describe('my cards in history (history:mine)', () => {
  it('keeps every dealt player’s cards and net result, but returns only the requester’s records', () => {
    const table = createTable();
    const adam = join(table, 'Adam');
    const bea = join(table, 'Bea');
    // Heads-up, dealer Adam (miesto 0): karty sa rozdávajú od Bey.
    rigged.decks.push(stackDeck(['As Ah', '7c 2d'], '2h 3d 8s 9c Kd'));
    startGame(table);
    checkDown(table);
    const pot = table.engine!.result!.winners.reduce((sum, winner) => sum + winner.amount, 0);
    expect(table.myHistory(bea.id)).toEqual([{ handNumber: 1, cards: ['As', 'Ah'], net: pot / 2, folded: false, handDescription: expect.any(String) }]);
    expect(table.myHistory(adam.id)).toEqual([{ handNumber: 1, cards: ['7c', '2d'], net: -pot / 2, folded: false, handDescription: expect.any(String) }]);

    // Druhá ruka: dealer Bea, Bea zloží — jej karty ostanú len v jej histórii, nikdy v stave stola pre Adama.
    rigged.decks.push(stackDeck(['Qc Jd', '5s 6s'], '4h 4d Tc 9h 3s'));
    vi.advanceTimersByTime(HAND_PAUSE_MS);
    expect(table.engine!.handNumber).toBe(2);
    expect(table.act(toAct(table), { type: 'fold' }).ok).toBe(true);
    expect(inHand(table)).toBe(false);
    expect(table.myHistory(bea.id).at(-1)).toEqual({ handNumber: 2, cards: ['5s', '6s'], net: -DEFAULT_SETTINGS.smallBlind, folded: true, handDescription: null });
    expect(table.myHistory(adam.id).at(-1)).toEqual({ handNumber: 2, cards: ['Qc', 'Jd'], net: DEFAULT_SETTINGS.smallBlind, folded: false, handDescription: null });
    const adamSees = JSON.stringify(table.view(adam.id));
    expect(adamSees).not.toContain('"5s"');
    expect(adamSees).not.toContain('"6s"');
    expect(JSON.stringify(table.liveView(adam.id))).not.toContain('holeHistory');
  });

  it('stores the final Pineapple cards after the discard', () => {
    const table = createTable({ defaultVariant: 'pineapple' });
    const adam = join(table, 'Adam');
    join(table, 'Bea');
    rigged.decks.push(stackDeck(['As Ah Kd', '7c 2d 9s'], '2h 3d 8s 9c Kc'));
    startGame(table);
    checkDown(table);
    expect(table.myHistory(adam.id)[0].cards).toEqual(['2d', '9s']);
  });

  it('persists through a snapshot and loads older snapshots without the field', () => {
    const table = createTable();
    const adam = join(table, 'Adam');
    const bea = join(table, 'Bea');
    startGame(table);
    checkDown(table);
    const snapshot = JSON.parse(JSON.stringify(table.toSnapshot())) as TableSnapshot;
    const restored = Table.fromSnapshot(snapshot, silent);
    tables.push(restored);
    expect(restored.myHistory(adam.id)).toEqual(table.myHistory(adam.id));
    expect(restored.myHistory(bea.id)).toHaveLength(1);
    delete snapshot.holeHistory;
    const legacy = Table.fromSnapshot(snapshot, silent);
    tables.push(legacy);
    expect(legacy.myHistory(adam.id)).toEqual([]);
  });
});

describe('Prasiatko payout in history', () => {
  it('attaches the piggy winners to the deciding hand before any change is broadcast', () => {
    const seen: (string | undefined)[] = [];
    let decidingHand = 0;
    let table: Table;
    const hooks: TableHooks = {
      ...silent,
      onChange: () => {
        const entry = table?.history.find((item) => item.handNumber === decidingHand);
        if (entry) {
          seen.push(entry.piggy?.winners[0]?.playerName);
        }
      },
    };
    table = createTable({}, hooks);
    const adam = join(table, 'Adam');
    join(table, 'Bea');
    join(table, 'Cyril');
    expect(table.hostPiggy('start').ok).toBe(true);
    startGame(table);
    table.piggy!.wins[adam.id] = PIGGY_TARGET_WINS - 1;
    decidingHand = table.engine!.handNumber;
    const cursor = table.metaCursor();
    winHand(table, adam);
    const amount = table.piggy!.winners[0].amount;
    expect(table.piggy!.status).toBe('finished');
    expect(table.history.at(-1)!.piggy).toEqual({ winners: [{ playerId: adam.id, playerName: 'Adam', amount }] });
    expect(table.metaSince(cursor).history.map((entry) => entry.piggy?.winners.map((winner) => winner.playerName))).toEqual([['Adam']]);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((name) => name === 'Adam')).toBe(true);
    vi.advanceTimersByTime(PIGGY_CELEBRATION_MS);
    expect(table.history.find((entry) => entry.handNumber === decidingHand)!.piggy?.winners[0].amount).toBe(amount);
  });

  it('leaves ordinary hands without a piggy record', () => {
    const table = createTable();
    const adam = join(table, 'Adam');
    join(table, 'Bea');
    startGame(table);
    winHand(table, adam);
    expect(table.history.at(-1)!.piggy).toBeUndefined();
  });
});
