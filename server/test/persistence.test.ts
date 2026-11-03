import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Avatar, TableSettings } from '../../shared/types';
import { DEFAULT_SETTINGS, MAX_SUMMARY_REQUEST, TABLE_RETENTION_DAYS } from '../../shared/constants';
import { SessionManager } from '../SessionManager';
import { Table, type TableHooks, type TablePlayer, type TableSnapshot } from '../Table';
import { TEST_BUY_IN, buyIn, setTestBuyIn } from './helpers';

const avatar: Avatar = { emoji: '🦊', color: '#e76f51' };
const hooks: TableHooks = { onChange: () => undefined, onEvent: () => undefined, onRemoved: () => undefined };
const DAY_MS = 24 * 60 * 60 * 1000;

const disposables: { dispose(): void }[] = [];
const tempDirs: string[] = [];

function createTable(testSettings: Partial<TableSettings> & { startingStack?: number } = {}): Table {
  const { startingStack = TEST_BUY_IN, ...settings } = testSettings;
  const table = new Table('PERS01', { ...DEFAULT_SETTINGS, ...settings }, hooks);
  setTestBuyIn(table, startingStack);
  disposables.push(table);
  return table;
}

function join(table: Table, name: string): TablePlayer {
  const added = table.addPlayer(name, avatar);
  if (!added.ok || !added.data) {
    throw new Error(`join ${name} failed`);
  }
  table.attachSocket(added.data, `socket-${name}`);
  buyIn(table, added.data);
  return added.data;
}

function startHand(table: Table): void {
  expect(table.hostStart().ok).toBe(true);
  expect(table.hostDealerChoice('random').ok).toBe(true);
  vi.advanceTimersByTime(1500);
  expect(table.engine && !table.engine.isComplete).toBe(true);
}

function roundTrip(table: Table): Table {
  const snapshot = JSON.parse(JSON.stringify(table.toSnapshot())) as TableSnapshot;
  const restored = Table.fromSnapshot(snapshot, hooks);
  disposables.push(restored);
  return restored;
}

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'poker-data-'));
  tempDirs.push(dir);
  return dir;
}

function manager(dataDir: string): SessionManager {
  const created = new SessionManager(hooks, { dataDir });
  disposables.push(created);
  return created;
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

describe('table snapshot', () => {
  it('voids a running hand: pre-hand stacks + pending chips, paused playing phase, same tokens', () => {
    const table = createTable();
    const milan = join(table, 'Milan');
    const juraj = join(table, 'Juraj');
    const peto = join(table, 'Peťo');
    table.hostSetAdmin(milan, juraj, true);
    startHand(table);
    const engine = table.engine!;
    const dealerSeat = engine.dealerSeat;
    expect(table.act(table.players.get(engine.toAct!.id)!, { type: 'call' }).ok).toBe(true);
    expect(table.bankChips(peto, 500, 'dobitie', 'Milan').ok).toBe(true);
    const ledger = JSON.parse(JSON.stringify(table.ledger));

    const restored = roundTrip(table);
    expect(restored.phase).toBe('playing');
    expect(restored.running).toBe(true);
    expect(restored.paused).toBe(true);
    expect(restored.engine).toBeNull();
    expect(restored.players.get(milan.id)).toMatchObject({ stack: 2000, pendingChips: 0, token: milan.token });
    expect(restored.players.get(juraj.id)).toMatchObject({ stack: 2000, pendingChips: 0, token: juraj.token });
    expect(restored.players.get(peto.id)).toMatchObject({ stack: 2500, pendingChips: 0, token: peto.token });
    expect([...restored.players.values()].every((player) => player.sockets.size === 0)).toBe(true);
    expect(restored.ledger).toEqual(ledger);
    expect(restored.hostId).toBe(milan.id);
    expect(restored.isAdmin(juraj.id)).toBe(true);
    expect(restored.events.some((event) => event.text === 'Server sa reštartoval — rozohraná ruka bola zrušená a žetóny vrátené')).toBe(true);
    expect(restored.history).toHaveLength(0);

    const view = restored.view(milan.id);
    expect(view.hand).toBeNull();
    expect(view.paused).toBe(true);
    expect(view.leaderboard.reduce((sum, row) => sum + row.result, 0)).toBe(0);

    expect(restored.hostStart().ok).toBe(true);
    vi.advanceTimersByTime(1500);
    expect(restored.engine?.handNumber).toBe(1);
    expect(restored.engine?.dealerSeat).toBe(dealerSeat);
  });

  it('keeps a player who was leaving during the voided hand as a departed member with the pre-hand stack', () => {
    const table = createTable();
    join(table, 'Milan');
    join(table, 'Juraj');
    const peto = join(table, 'Peťo');
    startHand(table);
    table.leave(peto);
    const restored = roundTrip(table);
    expect(restored.players.has(peto.id)).toBe(false);
    expect(restored.departed.get(peto.id)).toMatchObject({ stack: 2000, token: peto.token });
    expect(restored.ledger.some((entry) => entry.kind === 'leave')).toBe(false);
    const chips = [...restored.players.values(), ...restored.departed.values()].reduce((sum, player) => sum + player.stack, 0);
    expect(restored.ledger.reduce((sum, entry) => sum + entry.amount, 0)).toBe(chips);
    expect(restored.leaderboard().find((row) => row.playerId === peto.id)).toMatchObject({ present: false, stack: 2000, result: 0 });
  });

  it('restores a draw as lobby and a pending return to lobby as lobby', () => {
    const table = createTable();
    join(table, 'Milan');
    join(table, 'Juraj');
    expect(table.hostStart().ok).toBe(true);
    expect(table.phase).toBe('draw');
    const fromDraw = roundTrip(table);
    expect(fromDraw.phase).toBe('lobby');
    expect(fromDraw.draw).toBeNull();
    expect(fromDraw.running).toBe(false);

    expect(table.hostDealerChoice('random').ok).toBe(true);
    vi.advanceTimersByTime(1500);
    table.hostToLobby();
    const fromPending = roundTrip(table);
    expect(fromPending.phase).toBe('lobby');
    expect(fromPending.returnToLobbyPending).toBe(false);
  });

  it('keeps history, stats, settings and counters after a completed hand', () => {
    const table = createTable();
    const milan = join(table, 'Milan');
    join(table, 'Juraj');
    table.hostSettings({ name: 'Piatok' });
    startHand(table);
    while (table.engine && !table.engine.isComplete) {
      table.act(table.players.get(table.engine.toAct!.id)!, { type: 'fold' });
    }
    const restored = roundTrip(table);
    expect(restored.settings.name).toBe('Piatok');
    expect(restored.history).toEqual(table.history);
    expect(restored.leaderboard()).toEqual(table.leaderboard());
    expect(restored.summary(milan.id).handNumber).toBe(1);
    const lastEventId = restored.events.at(-1)!.id;
    restored.chat(restored.players.get(milan.id)!, 'ahoj');
    expect(restored.events.at(-1)!.id).toBe(lastEventId + 1);
  });
});

describe('SessionManager persistence', () => {
  it('saves tables to DATA_DIR and loads them again with working tokens', () => {
    const dir = tempDir();
    const first = manager(dir);
    const table = first.create({ ...DEFAULT_SETTINGS, name: 'Stôl Milan' });
    const milan = join(table, 'Milan');
    const juraj = join(table, 'Juraj');
    table.bankChips(juraj, 1000, '', 'Milan');
    table.hostSetAdmin(milan, juraj, true);
    first.flush();
    const file = path.join(dir, 'tables', `${table.code}.json`);
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ version: 1, code: table.code });
    expect(existsSync(`${file}.tmp`)).toBe(false);

    const second = manager(dir);
    const loaded = second.get(table.code)!;
    expect(loaded).toBeDefined();
    expect(loaded.players.get(juraj.id)).toMatchObject({ stack: 3000, token: juraj.token });
    expect(loaded.isAdmin(juraj.id)).toBe(true);
    expect(loaded.ledger).toHaveLength(3);
    const { summaries, missing } = second.summaries([{ code: table.code, playerId: juraj.id, token: juraj.token }]);
    expect(missing).toEqual([]);
    expect(summaries[0]).toMatchObject({ code: table.code, name: 'Stôl Milan', myStack: 3000, myIsAdmin: true, playerCount: 2, onlineCount: 0, hostName: 'Milan', phase: 'lobby' });
  });

  it('saves debounced after a change', () => {
    const dir = tempDir();
    const sessions = manager(dir);
    const table = sessions.create(DEFAULT_SETTINGS);
    join(table, 'Milan');
    const file = path.join(dir, 'tables', `${table.code}.json`);
    expect(existsSync(file)).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(existsSync(file)).toBe(true);
  });

  it('keeps an empty table but drops tables idle longer than the retention period', () => {
    const dir = tempDir();
    const first = manager(dir);
    const kept = first.create(DEFAULT_SETTINGS);
    const player = join(kept, 'Milan');
    kept.leave(player);
    const expired = first.create(DEFAULT_SETTINGS);
    join(expired, 'Juraj');
    first.flush();
    const expiredFile = path.join(dir, 'tables', `${expired.code}.json`);
    const data = JSON.parse(readFileSync(expiredFile, 'utf8')) as TableSnapshot;
    data.lastActivity = Date.now() - (TABLE_RETENTION_DAYS + 1) * DAY_MS;
    writeFileSync(expiredFile, JSON.stringify(data));
    writeFileSync(path.join(dir, 'tables', 'BROKEN.json'), '{nope');

    const second = manager(dir);
    expect(second.get(kept.code)).toBeDefined();
    expect(second.get(kept.code)!.players.size).toBe(0);
    expect(second.get(expired.code)).toBeUndefined();
    expect(existsSync(expiredFile)).toBe(false);

    second.cleanup(Date.now() + (TABLE_RETENTION_DAYS + 1) * DAY_MS);
    expect(second.get(kept.code)).toBeUndefined();
    expect(existsSync(path.join(dir, 'tables', `${kept.code}.json`))).toBe(false);
  });

  it('answers summaries for seated and departed members, lists kicked players and wrong tokens as missing', () => {
    const sessions = new SessionManager(hooks);
    disposables.push(sessions);
    const table = sessions.create(DEFAULT_SETTINGS);
    const milan = join(table, 'Milan');
    const juraj = join(table, 'Juraj');
    const kicked = join(table, 'Peťo');
    const departed = join(table, 'Zuzka');
    table.leave(kicked, true);
    table.leave(departed);
    const result = sessions.summaries([
      { code: table.code.toLowerCase(), playerId: milan.id, token: milan.token },
      { code: table.code, playerId: juraj.id, token: 'wrong' },
      { code: table.code, playerId: kicked.id, token: kicked.token },
      { code: table.code, playerId: departed.id, token: departed.token },
      { code: 'ZZZZZZ', playerId: milan.id, token: milan.token },
      { nonsense: true },
    ]);
    expect(result.summaries).toHaveLength(2);
    expect(result.summaries[0]).toMatchObject({ code: table.code, myIsAdmin: true, myStack: 2000, playerCount: 2, onlineCount: 2 });
    expect(result.summaries[1]).toMatchObject({ code: table.code, myIsAdmin: false, myStack: 2000, playerCount: 2, hostName: 'Milan' });
    expect(result.missing).toEqual([table.code, table.code, 'ZZZZZZ']);
    expect(sessions.summaries('nope')).toEqual({ summaries: [], missing: [] });
    const many = Array.from({ length: MAX_SUMMARY_REQUEST + 10 }, () => ({ code: 'ZZZZZZ', playerId: 'x', token: 'y' }));
    expect(sessions.summaries(many).missing).toHaveLength(MAX_SUMMARY_REQUEST);
  });
});
