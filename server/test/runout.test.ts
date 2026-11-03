import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Avatar, TableEvent } from '../../shared/types';
import { DEFAULT_SETTINGS, RUN_VOTE_SEC, RUNOUT_STEP_MS } from '../../shared/constants';
import { Table, type TablePlayer } from '../Table';
import { buyIn, makeHand } from './helpers';

const avatar: Avatar = { emoji: '🦊', color: '#e76f51' };
let current: Table[] = [];
let socketSeq = 0;

function setup(): { table: Table; events: TableEvent[]; players: TablePlayer[] } {
  const events: TableEvent[] = [];
  const table = new Table('RUNO01', { ...DEFAULT_SETTINGS }, { onChange: () => undefined, onEvent: (_table, event) => events.push(event), onRemoved: () => undefined });
  current.push(table);
  const players = ['Milan', 'Juraj', 'Peťo'].map((name) => {
    const added = table.addPlayer(name, avatar);
    if (!added.ok || !added.data) {
      throw new Error('join failed');
    }
    table.attachSocket(added.data, `socket-${++socketSeq}`);
    buyIn(table, added.data);
    return added.data;
  });
  expect(table.hostStart().ok).toBe(true);
  expect(table.hostDealerChoice('random').ok).toBe(true);
  vi.advanceTimersByTime(1500);
  return { table, events, players };
}

function actor(table: Table): TablePlayer {
  return table.players.get(table.engine!.toAct!.id)!;
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

describe('all-in: karty na stôl a pomalé dorozdanie', () => {
  it('po all-in a calle vidia všetci karty hráčov v ruke hneď, zložené karty ostanú skryté', () => {
    const { table, events, players } = setup();
    const folder = actor(table);
    expect(table.act(folder, { type: 'fold' }).ok).toBe(true);
    const shover = actor(table);
    expect(table.act(shover, { type: 'allin' }).ok).toBe(true);
    const caller = actor(table);
    expect(table.act(caller, { type: 'call' }).ok).toBe(true);
    const engine = table.engine!;
    expect(engine.awaitingRunout).toBe(true);
    expect(engine.board).toHaveLength(0);

    const watcher = table.view(folder.id);
    const seat = (id: string) => watcher.players.find((player) => player.id === id)!;
    expect(seat(shover.id).cards).toEqual(engine.player(shover.id)!.hole);
    expect(seat(caller.id).cards).toEqual(engine.player(caller.id)!.hole);
    expect(table.view(shover.id).players.find((player) => player.id === folder.id)!.cards.every((card) => card === null)).toBe(true);
    expect(events.some((event) => event.text.startsWith('All-in — karty na stôl:') && event.text.includes(shover.name) && event.text.includes(caller.name))).toBe(true);
    expect(players).toHaveLength(3);
    expect(table.view(folder.id).runVote).toMatchObject({ participants: expect.arrayContaining([shover.id, caller.id]), maxRuns: 3 });
    expect(table.chooseRuns(folder, 2).ok).toBe(false);
    expect(table.chooseRuns(shover, 1)).toEqual({ ok: true });
    expect(table.runVote).toBeNull();
    expect(engine.runs).toBe(1);

    vi.advanceTimersByTime(RUNOUT_STEP_MS - 100);
    expect(engine.board).toHaveLength(0);
    vi.advanceTimersByTime(200);
    expect(engine.board).toHaveLength(3);
    expect(table.view(folder.id).players.find((player) => player.id === shover.id)!.handDescription).not.toBeNull();
    vi.advanceTimersByTime(RUNOUT_STEP_MS);
    expect(engine.board).toHaveLength(4);
    vi.advanceTimersByTime(RUNOUT_STEP_MS);
    expect(engine.isComplete).toBe(true);
    expect(events.filter((event) => event.text.startsWith('All-in — karty na stôl:'))).toHaveLength(1);
  });

  it('na viackrát: platí najmenšia voľba, každý beh má vlastný board a pot sa delí, žetóny sedia', () => {
    const { table, events } = setup();
    const total = () => [...table.players.values()].reduce((sum, player) => sum + player.stack, 0);
    const before = total();
    const folder = actor(table);
    expect(table.act(folder, { type: 'fold' }).ok).toBe(true);
    const shover = actor(table);
    expect(table.act(shover, { type: 'allin' }).ok).toBe(true);
    const caller = actor(table);
    expect(table.act(caller, { type: 'call' }).ok).toBe(true);
    const engine = table.engine!;
    expect(table.chooseRuns(shover, 4).ok).toBe(false);
    expect(table.chooseRuns(shover, 3)).toEqual({ ok: true });
    expect(table.runVote).not.toBeNull();
    expect(table.chooseRuns(caller, 2)).toEqual({ ok: true });
    expect(table.runVote).toBeNull();
    expect(engine.runs).toBe(2);
    expect(events.some((event) => event.text === 'Ide sa na 2× — každý pot sa delí na 2 časti')).toBe(true);
    for (let step = 0; step < 6; step++) {
      vi.advanceTimersByTime(RUNOUT_STEP_MS);
    }
    expect(engine.isComplete).toBe(true);
    expect(engine.board).toHaveLength(5);
    expect(engine.extraBoards).toHaveLength(1);
    expect(engine.extraBoards[0]).toHaveLength(5);
    expect(new Set([...engine.board, ...engine.extraBoards[0]]).size).toBe(10);
    const runs = new Set(engine.result!.winners.map((winner) => winner.run));
    expect(runs).toEqual(new Set([0, 1]));
    const view = table.view(folder.id);
    expect(view.history.at(-1)!.extraBoards).toHaveLength(1);
    vi.advanceTimersByTime(100);
    expect(total()).toBe(before);
  });

  it('bez voľby do termínu sa ide na 1×', () => {
    const { table } = setup();
    expect(table.act(actor(table), { type: 'fold' }).ok).toBe(true);
    const shover = actor(table);
    expect(table.act(shover, { type: 'allin' }).ok).toBe(true);
    expect(table.act(actor(table), { type: 'call' }).ok).toBe(true);
    expect(table.chooseRuns(shover, 3).ok).toBe(true);
    vi.advanceTimersByTime(RUN_VOTE_SEC * 1000 + 10);
    expect(table.runVote).toBeNull();
    expect(table.engine!.runs).toBe(1);
  });
});

describe('HandEngine — viac behov', () => {
  it('pot sa rozdelí na polovice podľa behov a žetóny sedia (aj nepárny cent)', () => {
    const engine = makeHand({ stacks: [1001, 1001], holes: ['As Ah', 'Kd Kc'], board: '2c 7d 9h Js 3s' });
    while (!engine.awaitingRunout) {
      const player = engine.toAct!;
      const legal = engine.legalActions(player.id)!;
      engine.act(player.id, legal.callAmount > 0 ? { type: 'call' } : { type: 'allin' });
    }
    expect(engine.maxRuns()).toBe(3);
    expect(engine.setRuns(2)).toBe(2);
    while (!engine.isComplete) {
      engine.runoutStep();
    }
    expect(engine.board).toEqual(['2c', '7d', '9h', 'Js', '3s']);
    expect(engine.extraBoards).toHaveLength(1);
    const perRun = [0, 1].map((run) => engine.result!.winners.filter((winner) => winner.run === run).reduce((sum, winner) => sum + winner.amount, 0));
    expect(perRun).toEqual([1001, 1001]);
    expect(engine.players.reduce((sum, player) => sum + player.stack, 0)).toBe(2002);
    const aces = engine.players.find((player) => player.hole.includes('As'))!.id;
    expect(engine.result!.winners.filter((winner) => winner.run === 0).map((winner) => winner.playerId)).toEqual([aces]);
  });

  it('nastaviť behy sa dá len pred prvým dorozdaním', () => {
    const engine = makeHand({ stacks: [500, 500] });
    while (!engine.awaitingRunout) {
      const player = engine.toAct!;
      const legal = engine.legalActions(player.id)!;
      engine.act(player.id, legal.callAmount > 0 ? { type: 'call' } : { type: 'allin' });
    }
    engine.runoutStep();
    expect(engine.setRuns(3)).toBe(1);
  });
});
