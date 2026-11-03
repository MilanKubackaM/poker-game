import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Avatar, Card, TableEvent, TableSettings } from '../../shared/types';
import { DEFAULT_SETTINGS, DRAW_ACK_TIMEOUT_SEC, DRAW_PICK_TIMEOUT_SEC, DRAW_RESULT_MS } from '../../shared/constants';
import { freshDeck } from '../poker/cards';
import { Table, type TablePlayer } from '../Table';
import { TEST_BUY_IN, buyIn, setTestBuyIn } from './helpers';

const avatar: Avatar = { emoji: '🦊', color: '#e76f51' };

/** Slot 0 = A♥, slot 1 = A♠, slot 2 = K♦, slot 3 = 2♣, ostatné v poradí čerstvého balíčka. */
const CRAFTED: Card[] = ['Ah', 'As', 'Kd', '2c'];
const craftedDeck = (): Card[] => [...CRAFTED, ...freshDeck().filter((card) => !CRAFTED.includes(card))];

let current: Table | null = null;
let socketSeq = 0;

function createTable(testSettings: Partial<TableSettings> & { startingStack?: number } = {}, drawDeck: (() => Card[]) | undefined = craftedDeck): { table: Table; events: TableEvent[] } {
  const { startingStack = TEST_BUY_IN, ...settings } = testSettings;
  const events: TableEvent[] = [];
  const table = new Table('DRAW01', { ...DEFAULT_SETTINGS, ...settings }, {
    onChange: () => undefined,
    onEvent: (_table, event) => events.push(event),
    onRemoved: () => undefined,
  }, { drawDeck });
  setTestBuyIn(table, startingStack);
  current = table;
  return { table, events };
}

function join(table: Table, name: string, online = true): TablePlayer {
  const added = table.addPlayer(name, avatar);
  if (!added.ok || !added.data) {
    throw new Error(`join ${name} failed`);
  }
  if (online) {
    table.attachSocket(added.data, `socket-${++socketSeq}`);
  }
  buyIn(table, added.data);
  return added.data;
}

function enterDrawing(table: Table, players: TablePlayer[]): void {
  expect(table.hostStart().ok).toBe(true);
  expect(table.hostDealerChoice('draw').ok).toBe(true);
  for (const player of players) {
    expect(table.drawAck(player).ok).toBe(true);
  }
  expect(table.draw?.stage).toBe('drawing');
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  current?.dispose();
  current = null;
  vi.useRealTimers();
});

describe('lobby', () => {
  it('starts in the lobby and refuses to start with fewer than 2 funded players', () => {
    const { table } = createTable({ startingStack: 0 });
    const host = join(table, 'Milan');
    expect(table.view(host.id).phase).toBe('lobby');
    expect(table.view(host.id).draw).toBeNull();
    const alone = table.hostStart();
    expect(alone.ok).toBe(false);
    expect(!alone.ok && alone.error).toBe('Na spustenie treba aspoň 2 hráčov so žetónmi');
    const juraj = join(table, 'Juraj');
    expect(table.bankChips(juraj, 2000, '', host.name).ok).toBe(true);
    expect(table.hostStart().ok).toBe(false);
    expect(table.bankChips(host, 2000, '', host.name).ok).toBe(true);
    expect(table.hostStart().ok).toBe(true);
    expect(table.phase).toBe('draw');
  });

  it('refuses pause in the lobby and does not deal on join', () => {
    const { table } = createTable();
    join(table, 'Milan');
    join(table, 'Juraj');
    join(table, 'Peťo');
    vi.advanceTimersByTime(60_000);
    expect(table.engine).toBeNull();
    expect(table.hostPause()).toEqual({ ok: false, error: 'Hra ešte nezačala' });
    expect(table.hostNextHand({ variant: 'omaha' }).ok).toBe(true);
  });
});

describe('dealer choice', () => {
  it('start → phase draw/choose with fixed participants and no hand dealt', () => {
    const { table } = createTable();
    const host = join(table, 'Milan');
    const juraj = join(table, 'Juraj');
    expect(table.hostStart().ok).toBe(true);
    const view = table.view(host.id);
    expect(view.phase).toBe('draw');
    expect(view.running).toBe(false);
    expect(view.draw).toMatchObject({ stage: 'choose', participants: [host.id, juraj.id], acknowledged: [], deadline: null, winnerId: null });
    expect(view.draw!.slots).toHaveLength(52);
    const late = join(table, 'Peťo');
    vi.advanceTimersByTime(60_000);
    expect(table.engine).toBeNull();
    expect(table.draw!.participants).not.toContain(late.id);
    expect(table.hostStart()).toEqual({ ok: false, error: 'Najprv sa rozhodne o dealer buttone' });
    expect(table.hostPause().ok).toBe(false);
    expect(table.drawAck(host).ok).toBe(false);
  });

  it('random choice → playing, first hand dealer is the chosen player, then the button rotates', () => {
    for (let round = 0; round < 12; round++) {
      const { table, events } = createTable();
      const players = [join(table, 'Milan'), join(table, 'Juraj'), join(table, 'Peťo')];
      expect(table.hostStart().ok).toBe(true);
      expect(table.hostDealerChoice('random').ok).toBe(true);
      expect(table.phase).toBe('playing');
      expect(table.draw).toBeNull();
      expect(table.view(players[0].id).running).toBe(true);
      const text = events.find((event) => event.text.startsWith('Dealer button náhodne dostáva '))!.text;
      const chosen = players.find((player) => text === `Dealer button náhodne dostáva ${player.name}`)!;
      expect(chosen).toBeDefined();
      vi.advanceTimersByTime(1500);
      expect(table.engine!.dealerSeat).toBe(chosen.seat);
      const firstDealerSeat = table.engine!.dealerSeat;
      while (table.engine && !table.engine.isComplete) {
        table.act(table.players.get(table.engine.toAct!.id)!, { type: 'fold' });
      }
      vi.advanceTimersByTime(5000);
      expect(table.engine!.handNumber).toBe(2);
      expect(table.engine!.dealerSeat).toBe((firstDealerSeat + 1) % 3);
      table.dispose();
    }
  });

  it('rejects an invalid choice', () => {
    const { table } = createTable();
    join(table, 'Milan');
    join(table, 'Juraj');
    expect(table.hostDealerChoice('random').ok).toBe(false);
    expect(table.hostStart().ok).toBe(true);
    expect(table.hostDealerChoice('coin' as never)).toEqual({ ok: false, error: 'Neplatná voľba' });
  });
});

describe('draw for the button', () => {
  it('runs explain → drawing → done → first hand with the winner as dealer', () => {
    const { table, events } = createTable();
    const milan = join(table, 'Milan');
    const juraj = join(table, 'Juraj');
    const peto = join(table, 'Peťo');
    expect(table.hostStart().ok).toBe(true);
    expect(table.hostDealerChoice('draw').ok).toBe(true);
    expect(table.draw!.stage).toBe('explain');
    expect(table.draw!.deadline).toBe(Date.now() + DRAW_ACK_TIMEOUT_SEC * 1000);
    expect(table.drawAck(milan).ok).toBe(true);
    expect(table.drawAck(milan).ok).toBe(true);
    expect(table.draw!.acknowledged).toEqual([milan.id]);
    expect(table.drawAck(juraj).ok).toBe(true);
    expect(table.draw!.stage).toBe('explain');
    expect(table.drawAck(peto).ok).toBe(true);
    expect(table.draw!.stage).toBe('drawing');
    expect(table.draw!.deadline).toBe(Date.now() + DRAW_PICK_TIMEOUT_SEC * 1000);

    expect(table.drawPick(milan, 0).ok).toBe(true);
    expect(events.at(-1)!.text).toBe('Milan si ťahá A♥');
    expect(table.drawPick(milan, 5)).toEqual({ ok: false, error: 'Kartu už máš vytiahnutú' });
    expect(table.drawPick(juraj, 0)).toEqual({ ok: false, error: 'Túto kartu už niekto vytiahol' });
    expect(table.drawPick(juraj, 52)).toEqual({ ok: false, error: 'Neplatná karta' });
    expect(table.drawPick(juraj, 1).ok).toBe(true);
    expect(table.draw!.stage).toBe('drawing');
    expect(table.drawPick(peto, 2).ok).toBe(true);
    expect(events.at(-2)!.text).toBe('Peťo si ťahá K♦');

    const draw = table.view(milan.id).draw!;
    expect(draw.stage).toBe('done');
    expect(draw.winnerId).toBe(juraj.id);
    expect(events.at(-1)!.text).toBe('Juraj vyhráva losovanie s A♠ a dostáva dealer button');
    expect(table.phase).toBe('draw');
    expect(table.engine).toBeNull();

    vi.advanceTimersByTime(DRAW_RESULT_MS - 1);
    expect(table.engine).toBeNull();
    vi.advanceTimersByTime(1);
    expect(table.phase).toBe('playing');
    expect(table.draw).toBeNull();
    expect(table.engine).not.toBeNull();
    expect(table.engine!.dealerSeat).toBe(juraj.seat);
  });

  it('reveals only drawn slots to every viewer, including a spectator', () => {
    const { table } = createTable();
    const milan = join(table, 'Milan');
    const juraj = join(table, 'Juraj');
    enterDrawing(table, [milan, juraj]);
    const spectator = join(table, 'Peťo');
    for (const viewer of [milan, juraj, spectator]) {
      const draw = table.view(viewer.id).draw!;
      expect(draw).not.toHaveProperty('deck');
      expect(draw.slots.every((slot) => slot.card === null && slot.drawnBy === null)).toBe(true);
    }
    expect(table.drawPick(spectator, 3)).toEqual({ ok: false, error: 'Nie si účastníkom losovania' });
    expect(table.drawPick(milan, 2).ok).toBe(true);
    for (const viewer of [milan, juraj, spectator]) {
      const draw = table.view(viewer.id).draw!;
      expect(draw.slots[2]).toEqual({ index: 2, card: 'Kd', drawnBy: milan.id });
      expect(draw.slots.filter((slot) => slot.index !== 2).every((slot) => slot.card === null && slot.drawnBy === null)).toBe(true);
      expect(JSON.stringify(draw)).not.toContain('"Ah"');
    }
  });

  it('breaks a rank tie by suit ♠ > ♥ > ♦ > ♣', () => {
    const { table } = createTable({}, () => {
      const first: Card[] = ['Kc', 'Kd', 'Kh', 'Ks'];
      return [...first, ...freshDeck().filter((card) => !first.includes(card))];
    });
    const players = [join(table, 'A'), join(table, 'B'), join(table, 'C'), join(table, 'D')];
    enterDrawing(table, players);
    players.forEach((player, index) => expect(table.drawPick(player, index).ok).toBe(true));
    expect(table.draw!.winnerId).toBe(players[3].id);
  });

  it('auto-acknowledges and auto-picks when the deadlines pass', () => {
    const { table, events } = createTable();
    const milan = join(table, 'Milan');
    const juraj = join(table, 'Juraj');
    expect(table.hostStart().ok).toBe(true);
    expect(table.hostDealerChoice('draw').ok).toBe(true);
    expect(table.drawAck(milan).ok).toBe(true);
    vi.advanceTimersByTime(DRAW_ACK_TIMEOUT_SEC * 1000 - 1);
    expect(table.draw!.stage).toBe('explain');
    vi.advanceTimersByTime(1);
    expect(table.draw!.stage).toBe('drawing');
    expect(events.some((event) => event.text === 'Čas na potvrdenie pravidiel vypršal — ťahajte karty')).toBe(true);
    expect(table.drawPick(milan, 3).ok).toBe(true);
    vi.advanceTimersByTime(DRAW_PICK_TIMEOUT_SEC * 1000);
    const draw = table.draw!;
    expect(draw.stage).toBe('done');
    expect(draw.drawnBy.filter((id) => id !== null)).toHaveLength(2);
    expect(draw.drawnBy.includes(juraj.id)).toBe(true);
    expect(events.some((event) => event.text.startsWith('Juraj: čas na ťahanie vypršal — automaticky dostáva '))).toBe(true);
    vi.advanceTimersByTime(DRAW_RESULT_MS);
    expect(table.phase).toBe('playing');
    expect(table.engine!.dealerSeat).toBe(table.players.get(draw.winnerId!)!.seat);
  });

  it('auto-acknowledges disconnected participants', () => {
    const { table } = createTable();
    const milan = join(table, 'Milan');
    const offline = join(table, 'Juraj', false);
    const leaver = join(table, 'Peťo');
    expect(table.hostStart().ok).toBe(true);
    expect(table.hostDealerChoice('draw').ok).toBe(true);
    expect(table.draw!.acknowledged).toEqual([offline.id]);
    table.detachSocket(leaver, [...leaver.sockets][0]);
    expect(table.draw!.acknowledged).toEqual([offline.id, leaver.id]);
    expect(table.drawAck(milan).ok).toBe(true);
    expect(table.draw!.stage).toBe('drawing');
  });

  it('auto-picks for disconnected participants right away and finishes when that completes the draw', () => {
    const { table, events } = createTable();
    const milan = join(table, 'Milan');
    const offline = join(table, 'Juraj', false);
    const peto = join(table, 'Peťo');
    expect(table.hostStart().ok).toBe(true);
    expect(table.hostDealerChoice('draw').ok).toBe(true);
    expect(table.drawAck(milan).ok).toBe(true);
    expect(table.draw!.stage).toBe('explain');
    expect(table.draw!.drawnBy.includes(offline.id)).toBe(false);
    expect(table.drawAck(peto).ok).toBe(true);
    const draw = table.draw!;
    expect(draw.stage).toBe('drawing');
    expect(draw.drawnBy.includes(offline.id)).toBe(true);
    expect(draw.drawnBy.includes(milan.id) || draw.drawnBy.includes(peto.id)).toBe(false);
    expect(events.at(-1)!.text.startsWith('Juraj: čas na ťahanie vypršal — automaticky dostáva ')).toBe(true);

    const free = draw.drawnBy.findIndex((id) => id === null);
    expect(table.drawPick(milan, free).ok).toBe(true);
    expect(draw.stage).toBe('drawing');
    table.detachSocket(peto, [...peto.sockets][0]);
    expect(draw.drawnBy.includes(peto.id)).toBe(true);
    expect(events.some((event) => event.text.startsWith('Peťo: čas na ťahanie vypršal — automaticky dostáva '))).toBe(true);
    expect(draw.stage).toBe('done');
    expect(draw.winnerId).not.toBeNull();
    expect(draw.deadline).toBe(Date.now() + DRAW_RESULT_MS);
  });
});

describe('leaving during the draw', () => {
  it('returns to the lobby when fewer than 2 participants remain', () => {
    const { table, events } = createTable();
    const milan = join(table, 'Milan');
    const juraj = join(table, 'Juraj');
    enterDrawing(table, [milan, juraj]);
    table.leave(juraj);
    expect(table.phase).toBe('lobby');
    expect(table.draw).toBeNull();
    expect(table.view(milan.id).draw).toBeNull();
    expect(events.at(-1)!.text).toBe('Losovanie o dealer button sa zrušilo — na hru treba aspoň 2 hráčov, stôl sa vracia do čakárne');
    vi.advanceTimersByTime(120_000);
    expect(table.engine).toBeNull();
    expect(table.phase).toBe('lobby');
  });

  it('keeps going without the leaver and finishes when the others have drawn', () => {
    const { table } = createTable();
    const milan = join(table, 'Milan');
    const juraj = join(table, 'Juraj');
    const peto = join(table, 'Peťo');
    expect(table.hostStart().ok).toBe(true);
    expect(table.hostDealerChoice('draw').ok).toBe(true);
    expect(table.drawAck(milan).ok).toBe(true);
    expect(table.drawAck(juraj).ok).toBe(true);
    table.leave(peto, true);
    expect(table.draw!.stage).toBe('drawing');
    expect(table.draw!.participants).toEqual([milan.id, juraj.id]);
    expect(table.drawPick(milan, 2).ok).toBe(true);
    expect(table.drawPick(juraj, 3).ok).toBe(true);
    expect(table.draw!.winnerId).toBe(milan.id);
  });

  it('keeps the founder, grants no random admin and re-decides the winner if the winner leaves during the result', () => {
    const { table } = createTable();
    const milan = join(table, 'Milan');
    const juraj = join(table, 'Juraj');
    const peto = join(table, 'Peťo');
    enterDrawing(table, [milan, juraj, peto]);
    expect(table.drawPick(milan, 1).ok).toBe(true);
    expect(table.drawPick(juraj, 2).ok).toBe(true);
    expect(table.drawPick(peto, 3).ok).toBe(true);
    expect(table.draw!.winnerId).toBe(milan.id);
    table.leave(milan);
    expect(table.hostId).toBe(milan.id);
    expect([juraj.id, peto.id].filter((id) => table.isAdmin(id))).toHaveLength(0);
    expect(table.draw!.winnerId).toBe(juraj.id);
    vi.advanceTimersByTime(DRAW_RESULT_MS);
    expect(table.engine!.dealerSeat).toBe(juraj.seat);
  });
});
