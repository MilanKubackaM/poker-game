import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Avatar, TableEvent, TableSettings } from '../../shared/types';
import { DEFAULT_SETTINGS, PIGGY_TARGET_WINS } from '../../shared/constants';
import { formatMoney } from '../../shared/money';
import { Table, type TablePlayer, type TableSnapshot } from '../Table';
import { TEST_BUY_IN, buyIn, makeHand, setTestBuyIn, totalChips } from './helpers';

const avatar: Avatar = { emoji: '🦊', color: '#e76f51' };
const tables: Table[] = [];
let socketSeq = 0;

interface Setup {
  table: Table;
  events: TableEvent[];
  removed: { id: string; kicked: boolean }[];
}

function createTable(settings: Partial<TableSettings> = {}): Setup {
  const events: TableEvent[] = [];
  const removed: { id: string; kicked: boolean }[] = [];
  const table = new Table('MEMB02', { ...DEFAULT_SETTINGS, ...settings }, {
    onChange: () => undefined,
    onEvent: (_table, event) => events.push(event),
    onRemoved: (_table, player, kicked) => {
      removed.push({ id: player.id, kicked });
      player.sockets.clear();
    },
  });
  setTestBuyIn(table, TEST_BUY_IN);
  tables.push(table);
  return { table, events, removed };
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

function goOffline(table: Table, player: TablePlayer): void {
  for (const socketId of [...player.sockets]) {
    table.detachSocket(player, socketId);
  }
}

function inHand(table: Table): boolean {
  return !!table.engine && !table.engine.isComplete;
}

function startHand(table: Table): void {
  expect(table.hostStart().ok).toBe(true);
  expect(table.hostDealerChoice('random').ok).toBe(true);
  vi.advanceTimersByTime(1500);
  expect(inHand(table)).toBe(true);
}

function toAct(table: Table): TablePlayer {
  const id = table.engine?.toAct?.id;
  if (!id) {
    throw new Error('nobody to act');
  }
  return table.players.get(id)!;
}

function foldToEnd(table: Table): void {
  while (inHand(table)) {
    expect(table.act(toAct(table), { type: 'fold' }).ok).toBe(true);
  }
}

/** Všetci okrem `winner` foldujú; `winner` dorovná / checkuje. */
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

function chipsEverywhere(table: Table): number {
  return [...table.players.values(), ...table.departed.values()].reduce((sum, player) => sum + player.stack + player.pendingChips, 0);
}

function ledgerTotal(table: Table): number {
  return table.ledger.reduce((sum, entry) => sum + entry.amount, 0);
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

describe('host kicks any member', () => {
  it('kicks an offline seated player in the lobby: cash-out to the ledger, membership gone, leaderboard row stays', () => {
    const { table, removed, events } = createTable();
    const host = join(table, 'Milan');
    const juraj = join(table, 'Juraj');
    goOffline(table, juraj);
    expect(table.kickMember(host, juraj.id)).toEqual({ ok: true });
    expect(table.member(juraj.id)).toBeUndefined();
    expect(table.hasMembership(juraj.id, juraj.token)).toBe(false);
    expect(table.resume(juraj.id, juraj.token).ok).toBe(false);
    expect(removed).toContainEqual({ id: juraj.id, kicked: true });
    expect(table.ledger.at(-1)).toMatchObject({ kind: 'leave', playerId: juraj.id, amount: -TEST_BUY_IN, note: 'Vyhodenie hostom', byName: 'Milan', settlement: 'owed' });
    expect(table.leaderboard().find((row) => row.playerId === juraj.id)).toMatchObject({ present: false, stack: 0, result: 0 });
    expect(events.map((event) => event.text)).toContain('Milan vyhadzuje zo stola hráča Juraj');
    expect(ledgerTotal(table)).toBe(chipsEverywhere(table));
  });

  it('folds a kicked player in a running hand right away even when it is not their turn; they cannot win the pot', () => {
    const { table } = createTable();
    const host = join(table, 'Milan');
    join(table, 'Juraj');
    join(table, 'Peťo');
    startHand(table);
    const actorId = table.engine!.toAct!.id;
    const target = [...table.players.values()].find((player) => player !== host && player.id !== actorId)!;
    expect(table.kickMember(host, target.id).ok).toBe(true);
    expect(table.engine!.player(target.id)!.status).toBe('folded');
    expect(table.engine!.toAct!.id).toBe(actorId);
    expect(target.leaving).toBe(true);
    expect(table.hasMembership(target.id, target.token)).toBe(false);
    foldToEnd(table);
    expect(table.engine!.result!.winners.some((winner) => winner.playerId === target.id)).toBe(false);
    // Nedorovnaná časť jeho stávky (napr. BB proti SB) sa mu vráti, kým sa zapíše cash-out.
    const finalStack = table.engine!.player(target.id)!.stack;
    expect(finalStack).toBeLessThan(TEST_BUY_IN);
    expect(table.member(target.id)).toBeUndefined();
    expect(table.ledger.filter((entry) => entry.kind === 'leave')).toEqual([expect.objectContaining({ playerId: target.id, amount: -finalStack })]);
    expect(ledgerTotal(table)).toBe(chipsEverywhere(table));
  });

  it('ends the hand when the kicked player was the last opponent', () => {
    const { table } = createTable();
    const host = join(table, 'Milan');
    const juraj = join(table, 'Juraj');
    startHand(table);
    expect(table.kickMember(host, juraj.id).ok).toBe(true);
    expect(inHand(table)).toBe(false);
    expect(table.engine!.result!.winners.map((winner) => winner.playerId)).toEqual([host.id]);
    expect(table.member(juraj.id)).toBeUndefined();
    expect(ledgerTotal(table)).toBe(chipsEverywhere(table));
  });

  it('kicks a member who already left the table: stored chips go to the ledger and the token stops working', () => {
    const { table, removed } = createTable();
    const host = join(table, 'Milan');
    const juraj = join(table, 'Juraj');
    table.leave(juraj);
    expect(table.departed.has(juraj.id)).toBe(true);
    expect(table.liveView(host.id).departed.map((member) => member.id)).toEqual([juraj.id]);
    expect(table.kickMember(host, juraj.id).ok).toBe(true);
    expect(table.departed.has(juraj.id)).toBe(false);
    expect(table.liveView(host.id).departed).toEqual([]);
    expect(table.hasMembership(juraj.id, juraj.token)).toBe(false);
    expect(table.resume(juraj.id, juraj.token)).toEqual({ ok: false, error: 'Relácia vypršala' });
    expect(removed).toContainEqual({ id: juraj.id, kicked: true });
    expect(table.ledger.at(-1)).toMatchObject({ kind: 'leave', playerId: juraj.id, amount: -TEST_BUY_IN, byName: 'Milan' });
    expect(table.leaderboard().find((row) => row.playerId === juraj.id)).toMatchObject({ present: false, stack: 0 });
    expect(ledgerTotal(table)).toBe(chipsEverywhere(table));
  });

  it('kicks a player who is leaving after the hand: folds now, cash-out instead of stored chips', () => {
    const { table } = createTable();
    const host = join(table, 'Milan');
    join(table, 'Juraj');
    join(table, 'Peťo');
    startHand(table);
    const actorId = table.engine!.toAct!.id;
    const leaver = [...table.players.values()].find((player) => player !== host && player.id !== actorId)!;
    table.leave(leaver);
    expect(leaver.leaving).toBe(true);
    expect(table.engine!.player(leaver.id)!.status).not.toBe('folded');
    expect(table.kickMember(host, leaver.id).ok).toBe(true);
    expect(table.engine!.player(leaver.id)!.status).toBe('folded');
    expect(table.hasMembership(leaver.id, leaver.token)).toBe(false);
    foldToEnd(table);
    expect(table.member(leaver.id)).toBeUndefined();
    expect(table.ledger.some((entry) => entry.kind === 'leave' && entry.playerId === leaver.id)).toBe(true);
    expect(ledgerTotal(table)).toBe(chipsEverywhere(table));
  });

  it('refuses to kick oneself, the owner, an unknown or already kicked member, and non-hosts cannot kick', () => {
    const { table } = createTable();
    const host = join(table, 'Milan');
    const juraj = join(table, 'Juraj');
    const peto = join(table, 'Peťo');
    expect(table.kickMember(host, host.id)).toEqual({ ok: false, error: 'Neplatný hráč' });
    expect(table.kickMember(host, 'nobody')).toEqual({ ok: false, error: 'Neplatný hráč' });
    expect(table.kickMember(juraj, peto.id)).toEqual({ ok: false, error: 'Toto môže len host' });
    expect(table.hostSetAdmin(host, juraj, true).ok).toBe(true);
    expect(table.kickMember(juraj, host.id)).toEqual({ ok: false, error: 'Zakladateľa stola nemôžeš vyhodiť' });
    startHand(table);
    const actorId = table.engine!.toAct!.id;
    const target = actorId === peto.id ? juraj : peto;
    expect(table.kickMember(host, target.id).ok).toBe(true);
    expect(table.kickMember(host, target.id)).toEqual({ ok: false, error: 'Neplatný hráč' });
  });

  it('a member who left by themselves still returns freely', () => {
    const { table } = createTable();
    join(table, 'Milan');
    const juraj = join(table, 'Juraj');
    table.leave(juraj);
    expect(table.resume(juraj.id, juraj.token).ok).toBe(true);
    expect(table.players.get(juraj.id)?.stack).toBe(TEST_BUY_IN);
  });
});

describe('host merges two members', () => {
  it('moves a departed member into a new one: stack, ledger, records, history and my cards, without a leave entry', () => {
    const { table, events } = createTable();
    const host = join(table, 'Milan');
    const juraj = join(table, 'Juraj');
    join(table, 'Peťo');
    startHand(table);
    winHand(table, juraj);
    const jurajStack = juraj.stack;
    const handsPlayed = table.records.get(juraj.id)!.handsPlayed;
    const mine = table.myHistory(juraj.id);
    expect(mine).toHaveLength(1);
    table.leave(juraj);
    setTestBuyIn(table, 0);
    const fresh = join(table, 'Juraj 2');
    goOffline(table, fresh);
    table.attachSocket(fresh, 'socket-fresh');
    const ledgerLength = table.ledger.length;

    expect(table.mergeMember(host, juraj.id, fresh.id)).toEqual({ ok: true });
    expect(table.member(juraj.id)).toBeUndefined();
    expect(fresh.stack).toBe(jurajStack);
    expect(table.ledger).toHaveLength(ledgerLength);
    expect(table.ledger.some((entry) => entry.playerId === juraj.id || entry.toId === juraj.id || entry.bankerId === juraj.id)).toBe(false);
    expect(table.ledger.filter((entry) => entry.playerId === fresh.id).map((entry) => [entry.kind, entry.amount, entry.playerName])).toEqual([['credit', TEST_BUY_IN, 'Juraj 2']]);
    expect(table.records.has(juraj.id)).toBe(false);
    expect(table.records.get(fresh.id)!.handsPlayed).toBe(handsPlayed);
    expect(table.records.get(fresh.id)!.handsWon).toBe(1);
    expect(table.history[0].winners.map((winner) => [winner.playerId, winner.playerName])).toEqual([[fresh.id, 'Juraj 2']]);
    expect(table.myHistory(fresh.id)).toEqual(mine);
    expect(table.myHistory(juraj.id)).toEqual([]);
    expect(table.leaderboard().some((row) => row.playerId === juraj.id)).toBe(false);
    expect(table.leaderboard().find((row) => row.playerId === fresh.id)).toMatchObject({ deposited: TEST_BUY_IN, stack: jurajStack, handsWon: 1 });
    expect(events.map((event) => event.text)).toContain(`Host Milan zlučuje hráča Juraj do Juraj 2 (presunutých ${formatMoney(jurajStack, 'EUR')})`);
    expect(ledgerTotal(table)).toBe(chipsEverywhere(table));
    expect(table.cashout().imbalance).toBe(0);
  });

  it('hands over roles and sums results of two identities dealt in the same hand', () => {
    const { table } = createTable();
    const host = join(table, 'Milan');
    const juraj = join(table, 'Juraj');
    const peto = join(table, 'Peťo');
    expect(table.hostSetAdmin(host, juraj, true).ok).toBe(true);
    expect(table.hostSetBanker(host, juraj, undefined).ok).toBe(true);
    startHand(table);
    foldToEnd(table);
    const jurajNet = table.myHistory(juraj.id)[0].net;
    const petoRecord = table.myHistory(peto.id)[0];
    const total = juraj.stack + peto.stack;
    goOffline(table, juraj);

    expect(table.mergeMember(host, juraj.id, peto.id).ok).toBe(true);
    expect(peto.stack).toBe(total);
    expect(table.isAdmin(peto.id)).toBe(true);
    expect(table.bankerId).toBe(peto.id);
    expect(table.adminIds.has(juraj.id)).toBe(false);
    expect(table.myHistory(peto.id)).toEqual([{ ...petoRecord, net: petoRecord.net + jurajNet }]);
    expect(table.records.get(peto.id)!.handsPlayed).toBe(2);
    expect(ledgerTotal(table)).toBe(chipsEverywhere(table));
  });

  it('moves the table ownership and merges Prasiatko circles (capped) and contributions', () => {
    const { table } = createTable();
    const host = join(table, 'Milan');
    const juraj = join(table, 'Juraj');
    const peto = join(table, 'Peťo');
    expect(table.hostSetAdmin(host, juraj, true).ok).toBe(true);
    expect(table.hostPiggy('start').ok).toBe(true);
    const piggy = table.piggy!;
    piggy.wins[host.id] = 2;
    piggy.wins[peto.id] = 2;
    piggy.contributed[host.id] = 40;
    piggy.contributed[peto.id] = 20;
    goOffline(table, host);

    expect(table.mergeMember(juraj, host.id, peto.id).ok).toBe(true);
    expect(table.hostId).toBe(peto.id);
    expect(table.isAdmin(peto.id)).toBe(true);
    expect(table.bankerId).toBe(peto.id);
    expect(piggy.wins[peto.id]).toBe(PIGGY_TARGET_WINS);
    expect(piggy.wins[host.id]).toBeUndefined();
    expect(piggy.contributed).toEqual({ [peto.id]: 60 });
    expect(peto.stack).toBe(2 * TEST_BUY_IN);
  });

  it('refuses an online, in-hand, kicked or identical member, during the dealer draw, and for non-hosts', () => {
    const { table } = createTable();
    const host = join(table, 'Milan');
    const juraj = join(table, 'Juraj');
    const peto = join(table, 'Peťo');
    const fero = join(table, 'Fero');
    expect(table.mergeMember(host, juraj.id, peto.id)).toEqual({ ok: false, error: 'Juraj je online — zlúčiť sa dá len offline hráč' });
    goOffline(table, juraj);
    expect(table.mergeMember(host, juraj.id, juraj.id)).toEqual({ ok: false, error: 'Hráča nemôžeš zlúčiť so sebou samým' });
    expect(table.mergeMember(peto, juraj.id, fero.id)).toEqual({ ok: false, error: 'Toto môže len host' });
    expect(table.mergeMember(host, juraj.id, 'nobody')).toEqual({ ok: false, error: 'Neplatný hráč' });
    expect(table.hostStart().ok).toBe(true);
    expect(table.phase).toBe('draw');
    expect(table.mergeMember(host, juraj.id, peto.id)).toEqual({ ok: false, error: 'Počas rozhodovania o dealer buttone sa hráči zlúčiť nedajú' });
    expect(table.hostDealerChoice('random').ok).toBe(true);
    vi.advanceTimersByTime(1500);
    expect(inHand(table)).toBe(true);
    expect(table.engine!.player(juraj.id)).toBeDefined();
    expect(table.mergeMember(host, juraj.id, peto.id)).toEqual({ ok: false, error: 'Juraj hrá rozdanú ruku — zlúčiť ho môžeš po jej skončení' });
    const actorId = table.engine!.toAct!.id;
    const kicked = [peto, fero].find((player) => player.id !== actorId)!;
    expect(table.kickMember(host, kicked.id).ok).toBe(true);
    expect(table.mergeMember(host, kicked.id, host.id)).toEqual({ ok: false, error: 'Neplatný hráč' });
  });

  it('survives a snapshot round trip', () => {
    const { table } = createTable();
    const host = join(table, 'Milan');
    const juraj = join(table, 'Juraj');
    const peto = join(table, 'Peťo');
    startHand(table);
    foldToEnd(table);
    table.leave(juraj);
    expect(table.mergeMember(host, juraj.id, peto.id).ok).toBe(true);
    const restored = Table.fromSnapshot(JSON.parse(JSON.stringify(table.toSnapshot())) as TableSnapshot, { onChange: () => undefined, onEvent: () => undefined, onRemoved: () => undefined });
    tables.push(restored);
    expect(restored.member(juraj.id)).toBeUndefined();
    expect(restored.member(peto.id)!.stack).toBe(peto.stack);
    expect(restored.ledger).toEqual(table.ledger);
    expect(restored.records.has(juraj.id)).toBe(false);
    expect(restored.myHistory(peto.id)).toEqual(table.myHistory(peto.id));
    expect(restored.leaderboard()).toEqual(table.leaderboard());
  });
});

describe('engine fold out of turn (kick)', () => {
  it('finishes the Pineapple discard when the last pending player is folded out', () => {
    const engine = makeHand({ stacks: [1000, 1000, 1000], rules: { variant: 'pineapple' } });
    while (engine.street === 'preflop') {
      const actor = engine.toAct!;
      const legal = engine.legalActions(actor.id)!;
      expect(engine.act(actor.id, legal.callAmount > 0 ? { type: 'call' } : { type: 'check' }).ok).toBe(true);
    }
    expect(engine.street).toBe('discard');
    expect(engine.discard('p0', 0).ok).toBe(true);
    expect(engine.discard('p1', 0).ok).toBe(true);
    expect(engine.foldOut('p2')).toBe(true);
    expect(engine.street).toBe('flop');
    expect(engine.player('p2')!.status).toBe('folded');
    expect(totalChips(engine)).toBe(3000);
  });

  it('folds an all-in player during the runout and ends the hand when one player is left', () => {
    const engine = makeHand({ stacks: [100, 100, 100] });
    while (!engine.awaitingRunout) {
      expect(engine.act(engine.toAct!.id, { type: 'allin' }).ok).toBe(true);
    }
    expect(engine.foldOut('p2')).toBe(true);
    expect(engine.awaitingRunout).toBe(true);
    expect(engine.foldOut('p1')).toBe(true);
    expect(engine.isComplete).toBe(true);
    expect(engine.result!.winners).toEqual([expect.objectContaining({ playerId: 'p0', amount: 300 })]);
    expect(engine.foldOut('p1')).toBe(false);
    expect(engine.players.reduce((sum, player) => sum + player.stack, 0)).toBe(300);
  });
});
