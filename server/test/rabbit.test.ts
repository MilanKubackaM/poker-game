import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Avatar, Card, TableEvent } from '../../shared/types';
import { DEFAULT_SETTINGS, HAND_PAUSE_MS, RABBIT_SHOW_MS } from '../../shared/constants';
import { formatMoney } from '../../shared/money';
import { HandEngine } from '../poker/HandEngine';
import { Table, type TableHooks, type TablePlayer, type TableSnapshot } from '../Table';
import { buyIn, rules, seats, stackDeck } from './helpers';

const avatar: Avatar = { emoji: '🦊', color: '#e76f51' };
let current: Table[] = [];
let socketSeq = 0;

function createTable(): { table: Table; events: TableEvent[]; hooks: TableHooks } {
  const events: TableEvent[] = [];
  const hooks: TableHooks = { onChange: () => undefined, onEvent: (_table, event) => events.push(event), onRemoved: () => undefined };
  const table = new Table('RABB01', { ...DEFAULT_SETTINGS }, hooks);
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

function actor(table: Table): TablePlayer {
  return table.players.get(table.engine!.toAct!.id)!;
}

function foldHand(table: Table): void {
  while (inHand(table)) {
    expect(table.act(actor(table), { type: 'fold' }).ok).toBe(true);
  }
}

function startGame(table: Table): void {
  expect(table.hostStart().ok).toBe(true);
  expect(table.hostDealerChoice('random').ok).toBe(true);
  vi.advanceTimersByTime(1500);
  expect(inHand(table)).toBe(true);
}

/** Všetky žetóny: stacky (počas ruky z enginu vrátane príspevkov a ante) + čakajúce ante. */
function totalChips(table: Table): number {
  const engine = inHand(table) ? table.engine! : null;
  const stacks = [...table.players.values()].reduce((sum, player) => {
    const enginePlayer = engine?.player(player.id);
    return sum + (enginePlayer ? enginePlayer.stack + enginePlayer.total + enginePlayer.dead : player.stack) + player.pendingChips;
  }, 0);
  return stacks + (engine ? engine.ante : 0) + (engine ? 0 : table.anteAmount());
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const table of current) {
    table.dispose();
  }
  current = [];
  vi.useRealTimers();
});

describe('HandEngine.remainingBoard', () => {
  it('vráti karty, ktoré by prišli, s pálením — a balíček nezmení', () => {
    const deck = stackDeck(['As Ks', 'Qd Jd'], '2c 3d 8h 9s Kd');
    const engine = new HandEngine({ handNumber: 1, seats: seats(1000, 1000), dealerSeat: 0, rules: rules(), deck });
    engine.start();
    expect(engine.remainingBoard()).toEqual(['2c', '3d', '8h', '9s', 'Kd'] as Card[]);
    expect(engine.remainingBoard()).toEqual(['2c', '3d', '8h', '9s', 'Kd'] as Card[]);
  });

  it('ante je mŕtve peniaze v hlavnom pote a dostane ho víťaz', () => {
    const engine = new HandEngine({ handNumber: 1, seats: seats(1000, 1000), dealerSeat: 0, rules: rules(), ante: 20 });
    engine.start();
    expect(engine.totalPot).toBe(30 + 20);
    const toAct = engine.toAct!;
    engine.act(toAct.id, { type: 'fold' });
    const winner = engine.players.find((player) => player.id !== toAct.id)!;
    expect(winner.stack).toBe(1000 + 10 + 20);
  });
});

describe('odkrytie boardu (1 BB)', () => {
  it('po folde pred riverom: hráč zaplatí BB, všetci vidia karty 5 s a BB je ante v ďalšej ruke', () => {
    const { table, events } = createTable();
    const milan = join(table, 'Milan');
    const juraj = join(table, 'Juraj');
    startGame(table);
    const before = totalChips(table);
    foldHand(table);
    const engine = table.engine!;
    expect(engine.board.length).toBeLessThan(5);
    const expected = engine.remainingBoard();
    const stackBefore = juraj.stack;
    vi.advanceTimersByTime(3000);
    expect(table.rabbitHunt(juraj)).toEqual({ ok: true });
    expect(juraj.stack).toBe(stackBefore - DEFAULT_SETTINGS.bigBlind);
    const view = table.view(milan.id);
    expect(view.rabbit).toMatchObject({ handNumber: engine.handNumber, cards: expected, playerId: juraj.id, playerName: 'Juraj' });
    expect(view.rabbit!.cards).toHaveLength(5 - engine.board.length);
    expect(view.anteAmount).toBe(DEFAULT_SETTINGS.bigBlind);
    expect(events.some((event) => event.text.startsWith('Juraj platí') && event.text.includes('ante do ďalšej ruky'))).toBe(true);
    expect(totalChips(table)).toBe(before);

    vi.advanceTimersByTime(HAND_PAUSE_MS - 3000 + 100);
    expect(table.engine).toBe(engine);
    vi.advanceTimersByTime(RABBIT_SHOW_MS - (HAND_PAUSE_MS - 3000));
    expect(inHand(table)).toBe(true);
    expect(table.engine!.ante).toBe(DEFAULT_SETTINGS.bigBlind);
    expect(table.view(milan.id).rabbit).toBeNull();
    expect(table.view(milan.id).anteAmount).toBe(DEFAULT_SETTINGS.bigBlind);
    expect(events.some((event) => event.text === `V pote je ante ${formatMoney(DEFAULT_SETTINGS.bigBlind, 'EUR')} z odkrytia boardu`)).toBe(true);
    expect(totalChips(table)).toBe(before);
    foldHand(table);
    expect(table.anteAmount()).toBe(0);
    expect(totalChips(table)).toBe(before);
  });

  it('odkryť sa dá len raz, len po skončení ruky a len s dosť žetónmi', () => {
    const { table } = createTable();
    const milan = join(table, 'Milan');
    const juraj = join(table, 'Juraj');
    startGame(table);
    expect(table.rabbitHunt(milan).ok).toBe(false);
    foldHand(table);
    juraj.stack = DEFAULT_SETTINGS.bigBlind - 1;
    expect(table.rabbitHunt(juraj)).toEqual({ ok: false, error: `Na odkrytie boardu treba ${formatMoney(DEFAULT_SETTINGS.bigBlind, 'EUR')}` });
    expect(table.rabbitHunt(milan).ok).toBe(true);
    expect(table.rabbitHunt(milan)).toEqual({ ok: false, error: 'Board už odkryl Milan' });
  });

  it('pri celom boarde (showdown) sa nedá odkryť', () => {
    const { table } = createTable();
    const milan = join(table, 'Milan');
    join(table, 'Juraj');
    startGame(table);
    while (inHand(table)) {
      const player = actor(table);
      const legal = table.engine!.legalActions(player.id)!;
      expect(table.act(player, legal.callAmount > 0 ? { type: 'call' } : { type: 'check' }).ok).toBe(true);
    }
    expect(table.engine!.board).toHaveLength(5);
    expect(table.rabbitHunt(milan)).toEqual({ ok: false, error: 'Board je už celý' });
  });

  it('návrat do čakárne pred ďalšou rukou vráti zaplatené ante', () => {
    const { table, events } = createTable();
    const milan = join(table, 'Milan');
    join(table, 'Juraj');
    startGame(table);
    foldHand(table);
    const stack = milan.stack;
    expect(table.rabbitHunt(milan).ok).toBe(true);
    expect(table.hostToLobby().ok).toBe(true);
    expect(milan.stack).toBe(stack);
    expect(table.anteAmount()).toBe(0);
    expect(events.some((event) => event.text.startsWith('Milan dostáva späť'))).toBe(true);
  });

  it('čakajúce ante prežije reštart servera aj s rozohranou rukou', () => {
    const { table, hooks } = createTable();
    const milan = join(table, 'Milan');
    join(table, 'Juraj');
    startGame(table);
    foldHand(table);
    expect(table.rabbitHunt(milan).ok).toBe(true);
    const between = JSON.parse(JSON.stringify(table.toSnapshot())) as TableSnapshot;
    expect(between.pendingAnte).toEqual([{ playerId: milan.id, amount: DEFAULT_SETTINGS.bigBlind }]);
    vi.advanceTimersByTime(RABBIT_SHOW_MS + 100);
    expect(inHand(table)).toBe(true);
    const during = JSON.parse(JSON.stringify(table.toSnapshot())) as TableSnapshot;
    expect(during.pendingAnte).toEqual([{ playerId: milan.id, amount: DEFAULT_SETTINGS.bigBlind }]);
    const restored = Table.fromSnapshot(during, hooks);
    current.push(restored);
    expect(restored.anteAmount()).toBe(DEFAULT_SETTINGS.bigBlind);
  });
});
