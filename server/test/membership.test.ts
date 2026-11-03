import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Avatar, TableEvent, TableSettings } from '../../shared/types';
import { DEFAULT_SETTINGS, HAND_PAUSE_MS, MAX_SEATS } from '../../shared/constants';
import { formatMoney } from '../../shared/money';
import { SessionManager } from '../SessionManager';
import { Table, type TableHooks, type TablePlayer, type TableSnapshot } from '../Table';
import { TEST_BUY_IN, buyIn, setTestBuyIn } from './helpers';

const avatar: Avatar = { emoji: '🦊', color: '#e76f51' };
const silent: TableHooks = { onChange: () => undefined, onEvent: () => undefined, onRemoved: () => undefined };

const disposables: { dispose(): void }[] = [];
const tempDirs: string[] = [];
let socketSeq = 0;

function createTable(testSettings: Partial<TableSettings> & { startingStack?: number } = {}): { table: Table; events: TableEvent[]; removed: { id: string; kicked: boolean }[] } {
  const { startingStack = TEST_BUY_IN, ...settings } = testSettings;
  const events: TableEvent[] = [];
  const removed: { id: string; kicked: boolean }[] = [];
  const table = new Table('MEMB01', { ...DEFAULT_SETTINGS, ...settings }, {
    onChange: () => undefined,
    onEvent: (_table, event) => events.push(event),
    onRemoved: (_table, player, kicked) => {
      removed.push({ id: player.id, kicked });
      player.sockets.clear();
    },
  });
  setTestBuyIn(table, startingStack);
  disposables.push(table);
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

function resume(table: Table, player: TablePlayer): TablePlayer {
  const outcome = table.resume(player.id, player.token);
  if (!outcome.ok || !outcome.data) {
    throw new Error(`resume ${player.name} failed: ${outcome.ok ? '' : outcome.error}`);
  }
  return outcome.data;
}

function startHand(table: Table): void {
  expect(table.hostStart().ok).toBe(true);
  expect(table.hostDealerChoice('random').ok).toBe(true);
  vi.advanceTimersByTime(1500);
  expect(table.engine && !table.engine.isComplete).toBe(true);
}

function foldToEnd(table: Table): void {
  while (table.engine && !table.engine.isComplete) {
    const actorId = table.engine.toAct?.id;
    if (!actorId) {
      throw new Error('nobody to act');
    }
    expect(table.act(table.players.get(actorId)!, { type: 'fold' }).ok).toBe(true);
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
  for (const item of disposables.splice(0)) {
    item.dispose();
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  vi.useRealTimers();
});

describe('voluntary leave keeps the membership', () => {
  it('frees the seat, keeps stack, stats and time bank, writes no cash-out entry and notifies the socket', () => {
    const { table, events, removed } = createTable();
    join(table, 'Milan');
    const juraj = join(table, 'Juraj');
    join(table, 'Peťo');
    startHand(table);
    foldToEnd(table);
    vi.advanceTimersByTime(HAND_PAUSE_MS);
    foldToEnd(table);
    juraj.timeBankMs = 42_000;
    const stack = juraj.stack;
    const handsPlayed = table.records.get(juraj.id)!.handsPlayed;
    const ledgerBefore = table.ledger.length;
    vi.advanceTimersByTime(100);
    table.leave(juraj);
    expect(table.players.has(juraj.id)).toBe(false);
    expect(table.departed.get(juraj.id)).toMatchObject({ stack, timeBankMs: 42_000, token: juraj.token });
    expect(table.ledger).toHaveLength(ledgerBefore);
    expect(table.records.get(juraj.id)!.handsPlayed).toBe(handsPlayed);
    expect(handsPlayed).toBeGreaterThan(0);
    expect(removed).toEqual([{ id: juraj.id, kicked: false }]);
    expect(events.map((event) => event.text)).toContain(`Juraj odchádza od stola (žetóny ${formatMoney(stack, 'EUR')} ostávajú uložené)`);
    expect(ledgerTotal(table)).toBe(chipsEverywhere(table));
  });

  it('folds a mid-hand leaver and moves them to the departed members with the final stack after the hand', () => {
    const { table, events } = createTable();
    join(table, 'Milan');
    join(table, 'Juraj');
    join(table, 'Peťo');
    startHand(table);
    const leaver = table.players.get(table.engine!.toAct!.id)!;
    table.leave(leaver);
    expect(table.engine!.player(leaver.id)!.status).toBe('folded');
    expect(leaver.leaving).toBe(true);
    expect(events.map((event) => event.text)).toContain(`${leaver.name} odchádza od stola (žetóny ostávajú uložené po dohraní ruky)`);
    const finalStack = table.engine!.player(leaver.id)!.stack;
    foldToEnd(table);
    expect(table.players.has(leaver.id)).toBe(false);
    expect(table.departed.get(leaver.id)).toMatchObject({ stack: finalStack, leaving: false });
    expect(table.ledger.some((entry) => entry.kind === 'leave')).toBe(false);
    expect(ledgerTotal(table)).toBe(chipsEverywhere(table));
  });

  it('never removes the table when everyone leaves', () => {
    const sessions = new SessionManager(silent);
    disposables.push(sessions);
    const table = sessions.create(DEFAULT_SETTINGS);
    const milan = join(table, 'Milan');
    const juraj = join(table, 'Juraj');
    table.leave(juraj);
    table.leave(milan);
    expect(table.players.size).toBe(0);
    expect(sessions.get(table.code)).toBe(table);
    sessions.cleanup();
    expect(sessions.get(table.code)).toBe(table);
  });

  it('drops the piggy wins of a departed member but keeps their contributions in the piggy', () => {
    const { table } = createTable();
    join(table, 'Milan');
    const juraj = join(table, 'Juraj');
    join(table, 'Peťo');
    expect(table.hostPiggy('start').ok).toBe(true);
    table.piggy!.wins[juraj.id] = 2;
    table.piggy!.contributed[juraj.id] = 20;
    table.leave(juraj);
    expect(table.piggy!.wins[juraj.id]).toBeUndefined();
    expect(table.piggy!.contributed[juraj.id]).toBe(20);
  });
});

describe('returning with the same account', () => {
  it('re-seats a departed member on the old seat with stack, stats and time bank in the lobby', () => {
    const { table, events } = createTable();
    join(table, 'Milan');
    const juraj = join(table, 'Juraj');
    juraj.timeBankMs = 37_000;
    table.bankChips(juraj, 500, '', 'Milan');
    const seat = juraj.seat;
    table.leave(juraj);
    const back = resume(table, juraj);
    expect(back).toBe(juraj);
    expect(table.players.get(juraj.id)).toMatchObject({ seat, stack: 2500, timeBankMs: 37_000, sittingOut: false, missedBlinds: 'none', returnMode: null });
    expect(table.departed.has(juraj.id)).toBe(false);
    expect(events.map((event) => event.text)).toContain(`Juraj sa vracia ku stolu so stackom ${formatMoney(2500, 'EUR')}`);
  });

  it('uses another free seat when the old one is taken', () => {
    const { table } = createTable();
    join(table, 'Milan');
    const juraj = join(table, 'Juraj');
    const oldSeat = juraj.seat;
    table.leave(juraj);
    const zuzka = join(table, 'Zuzka');
    expect(zuzka.seat).toBe(oldSeat);
    resume(table, juraj);
    expect(juraj.seat).not.toBe(oldSeat);
    expect(new Set([...table.players.values()].map((player) => player.seat)).size).toBe(3);
  });

  it('rejects the return while the table is full and keeps the membership', () => {
    const { table } = createTable();
    const players = Array.from({ length: MAX_SEATS }, (_, index) => join(table, `Hráč ${index}`));
    const leaver = players[3];
    table.leave(leaver);
    join(table, 'Nový');
    expect(table.resume(leaver.id, leaver.token)).toEqual({ ok: false, error: 'Stôl je plný — počkaj, kým sa uvoľní miesto' });
    expect(table.departed.has(leaver.id)).toBe(true);
    expect(table.hasMembership(leaver.id, leaver.token)).toBe(true);
    table.leave(players[5]);
    expect(resume(table, leaver).seat).toBe(players[5].seat);
  });

  it('returns during the game standing, owing the big blind and waiting for it', () => {
    const { table, events } = createTable();
    join(table, 'Milan');
    join(table, 'Juraj');
    join(table, 'Peťo');
    const zuzka = join(table, 'Zuzka');
    startHand(table);
    foldToEnd(table);
    table.leave(zuzka);
    vi.advanceTimersByTime(HAND_PAUSE_MS);
    foldToEnd(table);
    resume(table, zuzka);
    expect(zuzka).toMatchObject({ sittingOut: true, missedBlinds: 'big', returnMode: 'wait-bb' });
    expect(events.map((event) => event.text)).toContain('Zuzka čaká na big blind (alebo ho môže zaplatiť hneď)');
  });

  it('keeps a bigger missed-blind debt from before the departure', () => {
    const { table } = createTable();
    join(table, 'Milan');
    join(table, 'Juraj');
    const zuzka = join(table, 'Zuzka');
    startHand(table);
    foldToEnd(table);
    zuzka.missedBlinds = 'small-and-big';
    table.leave(zuzka);
    resume(table, zuzka);
    expect(zuzka).toMatchObject({ sittingOut: true, missedBlinds: 'small-and-big', returnMode: 'wait-bb' });
  });

  it('a member without chips comes back sitting out until the host credits them', () => {
    const { table } = createTable({ startingStack: 0 });
    join(table, 'Milan');
    const juraj = join(table, 'Juraj');
    table.leave(juraj);
    resume(table, juraj);
    expect(juraj).toMatchObject({ stack: 0, sittingOut: true });
    expect(table.bankChips(juraj, 1000, '', 'Milan').ok).toBe(true);
    expect(juraj.sittingOut).toBe(false);
  });

  it('cancels a mid-hand leave when the player resumes before the hand ends', () => {
    const { table } = createTable();
    join(table, 'Milan');
    join(table, 'Juraj');
    join(table, 'Peťo');
    startHand(table);
    const leaver = [...table.players.values()].find((player) => player.id !== table.engine!.toAct!.id)!;
    table.leave(leaver);
    expect(leaver.leaving).toBe(true);
    resume(table, leaver);
    expect(leaver).toMatchObject({ leaving: false, sittingOut: false });
    foldToEnd(table);
    expect(table.players.has(leaver.id)).toBe(true);
    expect(table.departed.has(leaver.id)).toBe(false);
  });

  it('rejects an unknown player or a wrong token', () => {
    const { table } = createTable();
    const milan = join(table, 'Milan');
    expect(table.resume(milan.id, 'nope')).toEqual({ ok: false, error: 'Relácia vypršala' });
    expect(table.resume('nobody', milan.token)).toEqual({ ok: false, error: 'Relácia vypršala' });
    expect(table.resume(undefined, undefined)).toEqual({ ok: false, error: 'Relácia vypršala' });
  });

  it('shows a departed member in the leaderboard and the summary with the kept stack', () => {
    const { table } = createTable();
    const milan = join(table, 'Milan');
    const juraj = join(table, 'Juraj');
    startHand(table);
    foldToEnd(table);
    const stack = juraj.stack;
    table.leave(juraj);
    const row = table.leaderboard().find((entry) => entry.playerId === juraj.id)!;
    expect(row).toMatchObject({ present: false, stack, deposited: 2000, withdrawn: 0, result: stack - 2000, handsPlayed: 1 });
    expect(table.leaderboard().reduce((sum, entry) => sum + entry.result, 0)).toBe(0);
    expect(table.summary(juraj.id)).toMatchObject({ myStack: stack, myIsAdmin: false, playerCount: 1, hostName: 'Milan' });
    expect(table.summary(milan.id).myIsAdmin).toBe(true);
  });
});

describe('admin rights when people leave', () => {
  it('founder (host + banker) leaving leaves the table without roles — nobody random gets them', () => {
    const { table, events } = createTable();
    const milan = join(table, 'Milan');
    const juraj = join(table, 'Juraj');
    const peto = join(table, 'Peťo');
    table.leave(milan);
    expect(table.hostId).toBe(milan.id);
    expect(table.isAdmin(juraj.id) || table.isAdmin(peto.id)).toBe(false);
    expect(table.isBanker(juraj.id) || table.isBanker(peto.id)).toBe(false);
    expect(table.bankerId).toBe(milan.id);
    expect(events.some((event) => event.text.startsWith('Práva hosta'))).toBe(false);
    expect(table.view(juraj.id).adminIds).toEqual([]);
  });

  it('host leaving hands the host rights to the seated banker', () => {
    const { table, events } = createTable();
    const milan = join(table, 'Milan');
    const juraj = join(table, 'Juraj');
    const peto = join(table, 'Peťo');
    expect(table.hostSetBanker(milan, juraj, undefined).ok).toBe(true);
    table.leave(milan);
    expect(table.isAdmin(juraj.id)).toBe(true);
    expect(table.isAdmin(peto.id)).toBe(false);
    expect(table.isBanker(juraj.id)).toBe(true);
    expect(events.map((event) => event.text)).toContain('Práva hosta preberá bankár Juraj (pri stole nebol žiadny host)');
  });

  it('banker leaving hands the banker role to the founder, otherwise to a co-host — never a plain player', () => {
    const { table } = createTable();
    const milan = join(table, 'Milan');
    const juraj = join(table, 'Juraj');
    const peto = join(table, 'Peťo');
    const zuzka = join(table, 'Zuzka');
    expect(table.hostSetBanker(milan, juraj, undefined).ok).toBe(true);
    table.leave(juraj);
    expect(table.isBanker(milan.id)).toBe(true);

    expect(table.hostSetAdmin(milan, peto, true).ok).toBe(true);
    table.leave(milan);
    expect(table.isBanker(peto.id)).toBe(true);
    expect(table.isAdmin(peto.id)).toBe(true);
    expect(table.isAdmin(zuzka.id) || table.isBanker(zuzka.id)).toBe(false);
  });

  it('a mid-hand leaving banker does not take over the host rights', () => {
    const { table } = createTable();
    const milan = join(table, 'Milan');
    const juraj = join(table, 'Juraj');
    const peto = join(table, 'Peťo');
    expect(table.hostSetBanker(milan, juraj, undefined).ok).toBe(true);
    startHand(table);
    table.leave(juraj);
    table.leave(milan);
    expect(table.isAdmin(juraj.id)).toBe(false);
    expect(table.isAdmin(peto.id)).toBe(false);
  });

  it('founder gets the admin rights back on return', () => {
    const { table, events } = createTable();
    const milan = join(table, 'Milan');
    join(table, 'Juraj');
    table.leave(milan);
    resume(table, milan);
    expect(table.isAdmin(milan.id)).toBe(true);
    expect(table.isHost(milan.id)).toBe(true);
    expect(events.map((event) => event.text)).toContain('Zakladateľ Milan sa vracia — má späť práva hosta');
    expect(table.canDelete(milan, table.code)).toEqual({ ok: true });
  });

  it('a non-founder admin loses the rights on leave and does not get them back on return', () => {
    const { table, events } = createTable();
    const milan = join(table, 'Milan');
    const juraj = join(table, 'Juraj');
    table.hostSetAdmin(milan, juraj, true);
    const eventsBefore = events.length;
    table.leave(juraj);
    expect(table.adminIds.has(juraj.id)).toBe(false);
    expect(events.slice(eventsBefore).some((event) => event.text.startsWith('Práva hosta dostáva'))).toBe(false);
    resume(table, juraj);
    expect(table.isAdmin(juraj.id)).toBe(false);
  });

  it('when nobody with a role is seated, a returning plain member gets nothing; the returning founder gets both roles', () => {
    const { table } = createTable();
    const milan = join(table, 'Milan');
    const juraj = join(table, 'Juraj');
    table.leave(juraj);
    table.leave(milan);
    expect(table.adminIds.size).toBe(0);
    resume(table, juraj);
    expect(table.isAdmin(juraj.id)).toBe(false);
    expect(table.isBanker(juraj.id)).toBe(false);
    resume(table, milan);
    expect(table.isAdmin(milan.id)).toBe(true);
    expect(table.isBanker(milan.id)).toBe(true);
  });

  it('a former banker who returns does not get any role back automatically', () => {
    const { table } = createTable();
    const milan = join(table, 'Milan');
    const juraj = join(table, 'Juraj');
    join(table, 'Peťo');
    expect(table.hostSetBanker(milan, juraj, undefined).ok).toBe(true);
    table.leave(juraj);
    expect(table.isBanker(milan.id)).toBe(true);
    expect(table.hostSetBanker(milan, juraj, undefined).ok).toBe(false);
    resume(table, juraj);
    table.leave(milan);
    expect(table.isBanker(milan.id)).toBe(false);
  });

  it('forgets the missed blinds of departed members when the table goes back to the lobby', () => {
    const { table } = createTable();
    join(table, 'Milan');
    join(table, 'Juraj');
    const zuzka = join(table, 'Zuzka');
    startHand(table);
    foldToEnd(table);
    zuzka.missedBlinds = 'small-and-big';
    table.leave(zuzka);
    expect(table.hostToLobby().ok).toBe(true);
    resume(table, zuzka);
    expect(zuzka).toMatchObject({ sittingOut: false, missedBlinds: 'none', returnMode: null });
  });

  it('a join request at a table without a seated host just waits — nobody can approve it', () => {
    const { table } = createTable();
    const milan = join(table, 'Milan');
    const juraj = join(table, 'Juraj');
    table.leave(milan);
    const request = table.requestJoin('Zuzka', avatar, '1.2.3.4');
    expect(request.ok).toBe(true);
    expect(table.resolveJoin(juraj, request.ok ? request.data!.id : '', true)).toEqual({ ok: false, error: 'Žiadosti schvaľuje len host' });
    expect(table.players.size).toBe(1);
  });
});

describe('kick stays a cash-out', () => {
  it('writes the ledger entry, removes the account and invalidates the token', () => {
    const { table, removed } = createTable();
    join(table, 'Milan');
    const peto = join(table, 'Peťo');
    table.leave(peto, true, 'Milan');
    expect(table.ledger.at(-1)).toMatchObject({ kind: 'leave', playerId: peto.id, amount: -2000, note: 'Vyhodenie hostom', byName: 'Milan' });
    expect(table.departed.has(peto.id)).toBe(false);
    expect(table.hasMembership(peto.id, peto.token)).toBe(false);
    expect(table.resume(peto.id, peto.token)).toEqual({ ok: false, error: 'Relácia vypršala' });
    expect(removed).toEqual([{ id: peto.id, kicked: true }]);
    expect(ledgerTotal(table)).toBe(chipsEverywhere(table));
  });

  it('a mid-hand kick cashes out after the hand and the token is invalid right away', () => {
    const { table } = createTable();
    join(table, 'Milan');
    join(table, 'Juraj');
    const peto = join(table, 'Peťo');
    startHand(table);
    table.leave(peto, true, 'Milan');
    expect(table.resume(peto.id, peto.token).ok).toBe(false);
    foldToEnd(table);
    expect(table.players.has(peto.id)).toBe(false);
    expect(table.departed.has(peto.id)).toBe(false);
    expect(table.ledger.filter((entry) => entry.kind === 'leave')).toHaveLength(1);
    expect(ledgerTotal(table)).toBe(chipsEverywhere(table));
  });
});

describe('deleting a table', () => {
  it('allows only the seated founder and requires the table code', () => {
    const { table } = createTable();
    const milan = join(table, 'Milan');
    const juraj = join(table, 'Juraj');
    table.hostSetAdmin(milan, juraj, true);
    expect(table.canDelete(juraj, table.code)).toEqual({ ok: false, error: 'Stôl môže zmazať len zakladateľ' });
    expect(table.canDelete(milan, 'XXXXXX')).toEqual({ ok: false, error: 'Kód stola nesedí' });
    expect(table.canDelete(milan, undefined)).toEqual({ ok: false, error: 'Kód stola nesedí' });
    expect(table.canDelete(milan, ` ${table.code.toLowerCase()} `)).toEqual({ ok: true });
  });

  it('removing the table deletes its file and makes summaries report it missing', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'poker-member-'));
    tempDirs.push(dir);
    const sessions = new SessionManager(silent, { dataDir: dir });
    disposables.push(sessions);
    const table = sessions.create(DEFAULT_SETTINGS);
    const milan = join(table, 'Milan');
    sessions.flush();
    const file = path.join(dir, 'tables', `${table.code}.json`);
    expect(existsSync(file)).toBe(true);
    sessions.remove(table.code);
    table.updateProfile(milan, { name: 'Neskoro' });
    sessions.flush();
    expect(existsSync(file)).toBe(false);
    expect(sessions.get(table.code)).toBeUndefined();
    expect(sessions.summaries([{ code: table.code, playerId: milan.id, token: milan.token }]).missing).toEqual([table.code]);
  });
});

describe('persistence of departed members', () => {
  it('round-trips departed members through the snapshot and lets them return', () => {
    const { table } = createTable();
    const milan = join(table, 'Milan');
    const juraj = join(table, 'Juraj');
    juraj.timeBankMs = 33_000;
    table.bankChips(juraj, 700, '', 'Milan');
    table.leave(juraj);
    table.leave(milan);
    const snapshot = JSON.parse(JSON.stringify(table.toSnapshot())) as TableSnapshot;
    expect(snapshot.departed).toHaveLength(2);
    const restored = Table.fromSnapshot(snapshot, silent);
    disposables.push(restored);
    expect(restored.hostId).toBe(milan.id);
    expect(restored.players.size).toBe(0);
    expect(restored.departed.get(juraj.id)).toMatchObject({ stack: 2700, timeBankMs: 33_000, token: juraj.token });
    expect(restored.leaderboard().find((row) => row.playerId === juraj.id)).toMatchObject({ present: false, stack: 2700, result: 0 });
    expect(restored.resume(juraj.id, juraj.token).ok).toBe(true);
    expect(restored.isAdmin(juraj.id)).toBe(false);
    expect(restored.resume(milan.id, milan.token).ok).toBe(true);
    expect(restored.isAdmin(milan.id)).toBe(true);
    expect(restored.isBanker(milan.id)).toBe(true);
  });

  it('loads older files without departed members and turns a saved voluntary leave into a membership', () => {
    const { table } = createTable();
    join(table, 'Milan');
    const juraj = join(table, 'Juraj');
    const snapshot = JSON.parse(JSON.stringify(table.toSnapshot())) as TableSnapshot;
    delete snapshot.departed;
    const saved = snapshot.players.find((player) => player.id === juraj.id)!;
    saved.leaving = true;
    saved.departure = { note: 'Odchod od stola', byName: null };
    const restored = Table.fromSnapshot(snapshot, silent);
    disposables.push(restored);
    expect(restored.departed.get(juraj.id)).toMatchObject({ stack: 2000 });
    expect(restored.ledger.some((entry) => entry.kind === 'leave')).toBe(false);
  });

  it('a departed member survives a server restart (SessionManager reload) and can resume', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'poker-member-'));
    tempDirs.push(dir);
    const first = new SessionManager(silent, { dataDir: dir });
    disposables.push(first);
    const table = first.create(DEFAULT_SETTINGS);
    join(table, 'Milan');
    const juraj = join(table, 'Juraj');
    table.leave(juraj);
    first.flush();
    const second = new SessionManager(silent, { dataDir: dir });
    disposables.push(second);
    const loaded = second.get(table.code)!;
    expect(second.summaries([{ code: table.code, playerId: juraj.id, token: juraj.token }]).summaries[0]).toMatchObject({ myStack: 2000 });
    expect(loaded.resume(juraj.id, juraj.token).ok).toBe(true);
    expect(loaded.players.get(juraj.id)).toMatchObject({ stack: 2000 });
  });
});
