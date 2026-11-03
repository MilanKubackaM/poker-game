import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Avatar, TableEvent, TableSettings } from '../../shared/types';
import { DEFAULT_SETTINGS, HAND_PAUSE_MS, MAX_HISTORY_HANDS, MAX_TABLE_NAME_LENGTH } from '../../shared/constants';
import { Table, type TablePlayer } from '../Table';
import { TEST_BUY_IN, buyIn, setTestBuyIn } from './helpers';

const avatar: Avatar = { emoji: '🦊', color: '#e76f51' };

let current: Table | null = null;
let socketSeq = 0;

function createTable(testSettings: Partial<TableSettings> & { startingStack?: number } = {}): { table: Table; events: TableEvent[] } {
  const { startingStack = TEST_BUY_IN, ...settings } = testSettings;
  const events: TableEvent[] = [];
  const table = new Table('FEAT01', { ...DEFAULT_SETTINGS, ...settings }, {
    onChange: () => undefined,
    onEvent: (_table, event) => events.push(event),
    onRemoved: () => undefined,
  });
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

function startHand(table: Table): void {
  expect(table.hostStart().ok).toBe(true);
  expect(table.hostDealerChoice('random').ok).toBe(true);
  vi.advanceTimersByTime(1500);
  expect(table.engine && !table.engine.isComplete).toBe(true);
}

function actor(table: Table): TablePlayer {
  const id = table.engine?.toAct?.id;
  if (!id) {
    throw new Error('nobody to act');
  }
  return table.players.get(id)!;
}

function foldToEnd(table: Table): void {
  while (table.engine && !table.engine.isComplete) {
    expect(table.act(actor(table), { type: 'fold' }).ok).toBe(true);
  }
}

function checkDown(table: Table): void {
  while (table.engine && !table.engine.isComplete) {
    const player = actor(table);
    const legal = table.engine.legalActions(player.id)!;
    expect(table.act(player, legal.callAmount > 0 ? { type: 'call' } : { type: 'check' }).ok).toBe(true);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  current?.dispose();
  current = null;
  vi.useRealTimers();
});

describe('admins', () => {
  it('makes the creator owner and admin, grants and revokes rights with an event', () => {
    const { table, events } = createTable();
    const milan = join(table, 'Milan');
    const juraj = join(table, 'Juraj');
    expect(table.isHost(milan.id)).toBe(true);
    expect(table.isAdmin(milan.id)).toBe(true);
    expect(table.isAdmin(juraj.id)).toBe(false);

    expect(table.hostSetAdmin(milan, juraj, true).ok).toBe(true);
    expect(table.isAdmin(juraj.id)).toBe(true);
    expect(events.at(-1)?.text).toBe('Milan prideľuje práva hosta hráčovi Juraj');
    const view = table.view(juraj.id);
    expect(view.adminIds.sort()).toEqual([milan.id, juraj.id].sort());
    expect(view.players.find((player) => player.id === juraj.id)).toMatchObject({ isAdmin: true, isHost: false });
    expect(view.players.find((player) => player.id === milan.id)).toMatchObject({ isAdmin: true, isHost: true });

    expect(table.hostSetAdmin(juraj, juraj, false).ok).toBe(true);
    expect(table.isAdmin(juraj.id)).toBe(false);
    expect(events.at(-1)?.text).toBe('Juraj odoberá práva hosta hráčovi Juraj');
  });

  it('never revokes the owner', () => {
    const { table } = createTable();
    const milan = join(table, 'Milan');
    const juraj = join(table, 'Juraj');
    table.hostSetAdmin(milan, juraj, true);
    const outcome = table.hostSetAdmin(juraj, milan, false);
    expect(outcome).toEqual({ ok: false, error: 'Zakladateľovi stola sa práva hosta nedajú odobrať' });
    expect(table.isAdmin(milan.id)).toBe(true);
  });

  it('lets a granted admin run host commands', () => {
    const { table } = createTable();
    const milan = join(table, 'Milan');
    const juraj = join(table, 'Juraj');
    table.hostSetAdmin(milan, juraj, true);
    expect(table.bankChips(milan, 500, 'dobitie', juraj.name)).toEqual({ ok: true });
    expect(table.ledger.at(-1)).toMatchObject({ kind: 'credit', playerId: milan.id, byName: 'Juraj' });
    table.leave(milan, false);
    expect(table.hostId).toBe(milan.id);
    expect(table.isAdmin(juraj.id)).toBe(true);
    expect(table.adminIds.size).toBe(1);
  });

  it('keeps the previous owner as admin after a transfer', () => {
    const { table } = createTable();
    const milan = join(table, 'Milan');
    const juraj = join(table, 'Juraj');
    expect(table.hostTransfer(juraj).ok).toBe(true);
    expect(table.hostId).toBe(juraj.id);
    expect(table.isAdmin(milan.id)).toBe(true);
    expect(table.isAdmin(juraj.id)).toBe(true);
  });

  it('records the kicking admin as byName', () => {
    const { table } = createTable();
    const milan = join(table, 'Milan');
    const juraj = join(table, 'Juraj');
    const peto = join(table, 'Peťo');
    table.hostSetAdmin(milan, juraj, true);
    table.leave(peto, true, juraj.name);
    expect(table.ledger.at(-1)).toMatchObject({ kind: 'leave', playerId: peto.id, byName: 'Juraj', note: 'Vyhodenie hostom' });
  });
});

describe('table name', () => {
  it('trims and collapses whitespace, rejects empty, too long and non-string names', () => {
    const { table, events } = createTable();
    expect(table.hostSettings({ name: '  Piatkový   poker ' }).ok).toBe(true);
    expect(table.settings.name).toBe('Piatkový poker');
    expect(events.at(-1)?.text).toBe('Nové pravidlá: názov stola „Piatkový poker“');
    const lengthError = `Názov stola musí mať 1 až ${MAX_TABLE_NAME_LENGTH} znakov`;
    expect(table.hostSettings({ name: '   ' })).toEqual({ ok: false, error: lengthError });
    expect(table.hostSettings({ name: 'x'.repeat(MAX_TABLE_NAME_LENGTH + 1) })).toEqual({ ok: false, error: lengthError });
    expect(table.hostSettings({ name: 'x'.repeat(MAX_TABLE_NAME_LENGTH) }).ok).toBe(true);
    expect(table.hostSettings({ name: 42 as unknown as string })).toEqual({ ok: false, error: 'Neplatný názov stola' });
  });
});

describe('hand history and stats', () => {
  it('records a fold win without revealing the winner’s cards', () => {
    const { table } = createTable();
    const milan = join(table, 'Milan');
    const juraj = join(table, 'Juraj');
    startHand(table);
    const engine = table.engine!;
    const dealer = engine.players.find((player) => player.seat === engine.dealerSeat)!;
    foldToEnd(table);
    expect(table.history).toHaveLength(1);
    const entry = table.history[0];
    const winnerId = table.lastResult!.winners[0].playerId;
    expect(entry).toMatchObject({ handNumber: 1, variant: 'holdem', sevenDeuce: false, board: [], wonWithoutShowdown: true, bounty: null, dealerName: dealer.name, totalPot: 20 });
    expect(entry.winners).toEqual([{ playerId: winnerId, playerName: table.players.get(winnerId)!.name, amount: 20, handDescription: null, cards: [] }]);
    const rows = table.leaderboard();
    for (const id of [milan.id, juraj.id]) {
      expect(rows.find((row) => row.playerId === id)!.handsPlayed).toBe(1);
    }
    expect(rows.find((row) => row.playerId === winnerId)).toMatchObject({ handsWon: 1, biggestPot: 20 });
  });

  it('records showdown winners with revealed cards only and never a folded player’s cards', () => {
    const { table } = createTable();
    join(table, 'Milan');
    join(table, 'Juraj');
    const peto = join(table, 'Peťo');
    startHand(table);
    while (table.engine!.toAct?.id !== peto.id) {
      const player = actor(table);
      const legal = table.engine!.legalActions(player.id)!;
      expect(table.act(player, legal.callAmount > 0 ? { type: 'call' } : { type: 'check' }).ok).toBe(true);
    }
    const petoHole = [...table.engine!.player(peto.id)!.hole];
    expect(table.act(peto, { type: 'fold' }).ok).toBe(true);
    checkDown(table);
    const result = table.lastResult!;
    expect(result.wonWithoutShowdown).toBe(false);
    const entry = table.history.at(-1)!;
    expect(entry.board).toHaveLength(5);
    for (const winner of entry.winners) {
      expect(winner.cards).toEqual(result.revealed[winner.playerId]);
      expect(winner.cards).toHaveLength(2);
    }
    const serialized = JSON.stringify(entry);
    expect(petoHole.some((card) => serialized.includes(`"${card}"`))).toBe(false);
    expect(entry.totalPot).toBe(result.winners.reduce((sum, winner) => sum + winner.amount, 0));
  });

  it(`keeps at most ${MAX_HISTORY_HANDS} hands`, () => {
    const { table } = createTable();
    join(table, 'Milan');
    join(table, 'Juraj');
    startHand(table);
    for (let hand = 0; hand < MAX_HISTORY_HANDS + 5; hand++) {
      foldToEnd(table);
      vi.advanceTimersByTime(HAND_PAUSE_MS);
    }
    expect(table.history).toHaveLength(MAX_HISTORY_HANDS);
    expect(table.history[0].handNumber).toBe(6);
  });
});

describe('leaderboard', () => {
  it('computes deposits, withdrawals and result, including a departed player', () => {
    const { table } = createTable();
    const milan = join(table, 'Milan');
    const juraj = join(table, 'Juraj');
    const peto = join(table, 'Peťo');
    table.bankChips(juraj, 1000, '', 'Milan');
    table.bankChips(milan, -500, 'výber', 'Milan');
    table.updateProfile(peto, { name: 'Peter' });
    table.leave(peto, false);
    const rows = table.leaderboard();
    expect(rows.find((row) => row.playerId === milan.id)).toMatchObject({ deposited: 2000, withdrawn: 500, stack: 1500, result: 0, present: true });
    expect(rows.find((row) => row.playerId === juraj.id)).toMatchObject({ deposited: 3000, withdrawn: 0, stack: 3000, result: 0, present: true });
    expect(rows.find((row) => row.playerId === peto.id)).toMatchObject({ playerName: 'Peter', deposited: 2000, withdrawn: 0, stack: 2000, result: 0, present: false });
    expect(table.view(milan.id).leaderboard).toHaveLength(3);
  });

  it('sorts by result after hands are played and counts pending chips in the stack', () => {
    const { table } = createTable();
    const milan = join(table, 'Milan');
    const juraj = join(table, 'Juraj');
    startHand(table);
    table.bankChips(milan, 700, '', 'Milan');
    let rows = table.leaderboard();
    expect(rows.find((row) => row.playerId === milan.id)).toMatchObject({ deposited: 2700, stack: 2700, result: 0 });
    foldToEnd(table);
    rows = table.leaderboard();
    expect(rows[0].result).toBe(10);
    expect(rows[1].result).toBe(-10);
    expect(rows.reduce((sum, row) => sum + row.result, 0)).toBe(0);
    expect([milan.id, juraj.id]).toContain(rows[0].playerId);
  });
});

describe('return to lobby', () => {
  it('returns immediately between hands', () => {
    const { table, events } = createTable();
    join(table, 'Milan');
    join(table, 'Juraj');
    startHand(table);
    foldToEnd(table);
    expect(table.hostToLobby()).toEqual({ ok: true });
    expect(events.at(-1)?.text).toBe('Host ukončuje hru — návrat do čakárne');
    expect(table.phase).toBe('lobby');
    expect(table.running).toBe(false);
    expect(table.paused).toBe(false);
    expect(table.engine).toBeNull();
    vi.advanceTimersByTime(HAND_PAUSE_MS * 2);
    expect(table.engine).toBeNull();
    expect(table.view(table.hostId).hand).toBeNull();
  });

  it('waits for the running hand, then goes to the lobby and starts again through the dealer choice', () => {
    const { table } = createTable();
    join(table, 'Milan');
    join(table, 'Juraj');
    startHand(table);
    expect(table.hostToLobby()).toEqual({ ok: true });
    expect(table.returnToLobbyPending).toBe(true);
    expect(table.phase).toBe('playing');
    expect(table.view(table.hostId).returnToLobbyPending).toBe(true);
    foldToEnd(table);
    expect(table.phase).toBe('lobby');
    expect(table.returnToLobbyPending).toBe(false);
    vi.advanceTimersByTime(HAND_PAUSE_MS * 2);
    expect(table.engine).toBeNull();
    expect(table.hostStart().ok).toBe(true);
    expect(table.phase).toBe('draw');
  });

  it('refuses in the lobby and lets the host cancel a pending return', () => {
    const { table } = createTable();
    join(table, 'Milan');
    join(table, 'Juraj');
    expect(table.hostToLobby()).toEqual({ ok: false, error: 'Stôl už je v čakárni' });
    startHand(table);
    table.hostToLobby();
    expect(table.hostStart()).toEqual({ ok: true });
    expect(table.returnToLobbyPending).toBe(false);
    foldToEnd(table);
    expect(table.phase).toBe('playing');
    vi.advanceTimersByTime(HAND_PAUSE_MS);
    expect(table.engine && !table.engine.isComplete).toBe(true);
  });
});
