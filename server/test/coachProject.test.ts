import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Avatar, Card, TableSettings } from '../../shared/types';
import { DEFAULT_SETTINGS } from '../../shared/constants';
import { Table, type TablePlayer } from '../Table';
import { createPublicIds } from '../coach/publicId';
import { projectCoachState } from '../coach/project';
import { TEST_BUY_IN, buyIn, setTestBuyIn } from './helpers';

const avatar: Avatar = { emoji: '🦊', color: '#e76f51', photo: '/api/photos/secret-photo.webp' };
const ids = createPublicIds(Buffer.alloc(32, 7));
const tables: Table[] = [];

function createTable(settings: Partial<TableSettings> = {}): Table {
  const table = new Table('COACH1', { ...DEFAULT_SETTINGS, ...settings }, { onChange: () => undefined, onEvent: () => undefined, onRemoved: () => undefined });
  setTestBuyIn(table, TEST_BUY_IN);
  tables.push(table);
  return table;
}

function join(table: Table, name: string, userId: string): TablePlayer {
  const added = table.addPlayer(name, avatar, userId);
  if (!added.ok || !added.data) {
    throw new Error(`join ${name} failed`);
  }
  buyIn(table, added.data);
  return added.data;
}

function startHand(table: Table): void {
  expect(table.hostStart().ok).toBe(true);
  expect(table.hostDealerChoice('random').ok).toBe(true);
  vi.advanceTimersByTime(1500);
  expect(table.engine && !table.engine.isComplete).toBe(true);
}

function pidOf(table: Table): (playerId: string) => string {
  return (playerId) => {
    const member = table.players.get(playerId) ?? table.departed.get(playerId);
    return member?.userId ? ids.ofUser(member.userId) : ids.ofSeat(table.code, playerId);
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const table of tables.splice(0)) {
    table.dispose();
  }
  vi.useRealTimers();
});

/** Karty, ktoré hráč smie vidieť: vlastné, board a to, čo ostatní ukázali. */
function visibleTo(table: Table, viewer: TablePlayer): Set<Card> {
  const view = table.liveView(viewer.id);
  const visible = new Set<Card>();
  for (const player of view.players) {
    if (player.id === viewer.id) {
      for (const card of player.cards) {
        if (card) {
          visible.add(card);
        }
      }
    }
  }
  for (const cards of Object.values(view.lastResult?.revealed ?? {})) {
    cards.forEach((card) => visible.add(card));
  }
  for (const card of view.hand?.board ?? []) {
    visible.add(card);
  }
  for (const card of view.hand?.secondBoard ?? []) {
    visible.add(card);
  }
  for (const board of view.hand?.extraBoards ?? []) {
    board.forEach((card) => visible.add(card));
  }
  return visible;
}

function coachCards(state: ReturnType<typeof projectCoachState>): Card[] {
  const cards: Card[] = [];
  const add = (list: (Card | null)[]) => list.forEach((card) => card && cards.push(card));
  state.players.forEach((player) => add(player.cards));
  if (state.hand) {
    add(state.hand.board);
    add(state.hand.secondBoard ?? []);
    (state.hand.extraBoards ?? []).forEach(add);
  }
  Object.values(state.lastResult?.revealed ?? {}).forEach(add);
  state.lastResult?.winners.forEach((winner) => add(winner.bestCards));
  add(state.rabbit?.cards ?? []);
  return cards;
}

describe('coach: priemet stavu stola', () => {
  it('cudzie skryté karty nikdy nepríde a vlastné áno', () => {
    const table = createTable();
    const players = [join(table, 'Ana', 'user-a'), join(table, 'Boris', 'user-b'), join(table, 'Cyril', 'user-c')];
    startHand(table);
    const engine = table.engine!;
    for (const viewer of players) {
      const state = projectCoachState(table.liveView(viewer.id), pidOf(table));
      const mine = state.players.find((player) => player.isYou)!;
      expect(mine.cards).toEqual(engine.player(viewer.id)!.hole);
      for (const other of state.players.filter((player) => !player.isYou)) {
        expect(other.cards.every((card) => card === null)).toBe(true);
        expect(other.cards).toHaveLength(2);
      }
    }
  });

  it('všetky karty v coach stave vidí aj sám hráč, počas celej ruky vrátane showdownu', () => {
    const table = createTable();
    const players = [join(table, 'Ana', 'user-a'), join(table, 'Boris', 'user-b'), join(table, 'Cyril', 'user-c')];
    startHand(table);
    const engine = table.engine!;
    let guard = 0;
    while (!engine.isComplete && guard++ < 200) {
      for (const viewer of players) {
        const state = projectCoachState(table.liveView(viewer.id), pidOf(table));
        const allowed = visibleTo(table, viewer);
        for (const card of coachCards(state)) {
          expect(allowed.has(card)).toBe(true);
        }
      }
      const actor = engine.toAct;
      if (actor) {
        const legal = engine.legalActions(actor.id)!;
        table.act(table.players.get(actor.id)!, legal.canCheck ? { type: 'check' } : { type: 'call' });
      } else {
        vi.advanceTimersByTime(1500);
      }
    }
    expect(engine.isComplete).toBe(true);
    for (const viewer of players) {
      const state = projectCoachState(table.liveView(viewer.id), pidOf(table));
      expect(state.lastResult).not.toBeNull();
      const allowed = visibleTo(table, viewer);
      for (const card of coachCards(state)) {
        expect(allowed.has(card)).toBe(true);
      }
    }
  });

  it('stav neobsahuje interné ID, tokeny, fotky ani odtlačky miešania', () => {
    const table = createTable();
    const players = [join(table, 'Ana', 'user-a'), join(table, 'Boris', 'user-b')];
    startHand(table);
    const json = JSON.stringify(projectCoachState(table.liveView(players[0].id), pidOf(table)));
    for (const player of players) {
      expect(json).not.toContain(player.id);
      expect(json).not.toContain(player.token);
    }
    expect(json).not.toContain('user-a');
    expect(json).not.toContain('secret-photo');
    expect(json).not.toContain('fairRoundId');
    expect(json).not.toContain('commit');
  });

  it('stále ID je rovnaké naprieč stolmi a pre iný účet iné', () => {
    expect(ids.ofUser('user-a')).toBe(ids.ofUser('user-a'));
    expect(ids.ofUser('user-a')).not.toBe(ids.ofUser('user-b'));
    expect(ids.ofUser('user-a')).not.toContain('user-a');
    expect(createPublicIds(Buffer.alloc(32, 9)).ofUser('user-a')).not.toBe(ids.ofUser('user-a'));
    expect(ids.ofSeat('AAAA11', 'p1')).not.toBe(ids.ofSeat('BBBB22', 'p1'));
  });

  it('posiela módy: Prasiatko s krúžkami a sumou, 7-2 a Double Board', () => {
    const table = createTable({ sevenDeuceAlways: true, sevenDeuceBounty: 40 });
    const [ana] = [join(table, 'Ana', 'user-a'), join(table, 'Boris', 'user-b')];
    expect(table.hostStart().ok).toBe(true);
    expect(table.hostDealerChoice('random').ok).toBe(true);
    expect(table.hostPiggy({ action: 'start' }).ok).toBe(true);
    expect(table.hostDoubleBoard({ action: 'start', hands: 2 }).ok).toBe(true);
    const state = projectCoachState(table.liveView(ana.id), pidOf(table));
    expect(state.settings.sevenDeuceAlways).toBe(true);
    expect(state.settings.sevenDeuceBounty).toBe(40);
    expect(state.piggy).toMatchObject({ status: 'running', target: 3, amount: 0 });
    expect(Object.keys(state.piggy!.rings).every((pid) => pid.startsWith('u_'))).toBe(true);
    expect(state.doubleBoard).toMatchObject({ remaining: 2, permanent: false });
  });
});
