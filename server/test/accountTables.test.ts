import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Avatar, TableEvent } from '../../shared/types';
import type { AccountTableStat } from '../../shared/account';
import { DEFAULT_SETTINGS, MAX_SUMMARY_REQUEST, TABLE_RETENTION_DAYS } from '../../shared/constants';
import { ARCHIVE_BACKUP_DIR, SessionManager, parseDeviceSeats } from '../SessionManager';
import { Table, type TableHooks, type TablePlayer, type TableSnapshot } from '../Table';
import type { AccountDirectory, AccountProfile } from '../accounts/directory';
import { buyIn } from './helpers';

const avatar: Avatar = { emoji: '🦊', color: '#e76f51' };
const silent: TableHooks = { onChange: () => undefined, onEvent: () => undefined, onRemoved: () => undefined };
const DAY_MS = 24 * 60 * 60 * 1000;

const disposables: { dispose(): void }[] = [];
const tempDirs: string[] = [];
let socketSeq = 0;

/** Jednoduchý adresár účtov pre testy — profily v mape, zapísané štatistiky a zmazané stoly sa zbierajú. */
class FakeDirectory implements AccountDirectory {
  readonly profiles = new Map<string, AccountProfile>();
  readonly recorded: { userId: string; stat: AccountTableStat }[] = [];
  readonly deleted: string[] = [];

  profile(userId: string): AccountProfile | undefined {
    return this.profiles.get(userId);
  }

  recordTableStat(userId: string, stat: AccountTableStat): void {
    this.recorded.push({ userId, stat: { ...stat } });
  }

  markTableDeleted(code: string): void {
    this.deleted.push(code);
  }

  lastStat(userId: string, code: string): AccountTableStat | undefined {
    return this.recorded.filter((entry) => entry.userId === userId && entry.stat.code === code).at(-1)?.stat;
  }
}

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'poker-accounts-'));
  tempDirs.push(dir);
  return dir;
}

function manager(options: ConstructorParameters<typeof SessionManager>[1] = {}, hooks: TableHooks = silent): SessionManager {
  const created = new SessionManager(hooks, options);
  disposables.push(created);
  return created;
}

function createTable(code = 'ACCT01', hooks: TableHooks = silent): Table {
  const table = new Table(code, { ...DEFAULT_SETTINGS }, hooks);
  disposables.push(table);
  return table;
}

function seat(table: Table, name: string, userId: string | null): TablePlayer {
  const added = table.addPlayer(name, avatar, userId);
  if (!added.ok || !added.data) {
    throw new Error(`join ${name} failed: ${added.ok ? '' : added.error}`);
  }
  table.attachSocket(added.data, `socket-${++socketSeq}`);
  buyIn(table, added.data);
  return added.data;
}

/**
 * Uloží do DATA_DIR stôl tak, ako ho zapísala verzia 1.1.0 (bez `accounts`, bez `userId`) — Milan, Juraj a druhé miesto
 * Milana z iného zariadenia (Milan 2), s odohranými rukami v štatistikách a kartami v `holeHistory`.
 */
function writeLegacyTable(dataDir: string, code = 'OLD001', lastActivity = Date.now() - 200 * DAY_MS) {
  const table = new Table(code, { ...DEFAULT_SETTINGS, name: 'Starý stôl' }, silent);
  const milan = seat(table, 'Milan', null);
  const juraj = seat(table, 'Juraj', null);
  const milanAgain = seat(table, 'Milan 2', null);
  table.bankChips(milan, 500, '', null, 'owed');
  table.leave(milanAgain);
  const snapshot = JSON.parse(JSON.stringify(table.toSnapshot())) as TableSnapshot & Record<string, unknown>;
  table.dispose();
  delete snapshot.accounts;
  for (const player of [...snapshot.players, ...(snapshot.departed ?? [])]) {
    delete player.userId;
  }
  for (const record of snapshot.records) {
    delete record.userId;
    record.handsPlayed = record.id === juraj.id ? 3 : 2;
    record.handsWon = record.id === milan.id ? 2 : record.id === milanAgain.id ? 1 : 0;
    record.biggestPot = record.id === milanAgain.id ? 900 : 400;
  }
  snapshot.handNumber = 3;
  snapshot.lastActivity = lastActivity;
  snapshot.holeHistory = [
    { handNumber: 2, players: { [milan.id]: { cards: ['As', 'Kd'], net: 300, folded: false, handDescription: null } } },
    { handNumber: 1, players: { [milanAgain.id]: { cards: ['2c', '7d'], net: -100, folded: true, handDescription: null } } },
  ];
  mkdirSync(path.join(dataDir, 'tables'), { recursive: true });
  const file = path.join(dataDir, 'tables', `${code}.json`);
  writeFileSync(file, JSON.stringify(snapshot));
  return { file, raw: readFileSync(file, 'utf8'), milan, juraj, milanAgain };
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

describe('table membership by account', () => {
  it('finds a member by account (seated or departed, not kicked) and refuses a second seat for the same account', () => {
    const table = createTable();
    const milan = seat(table, 'Milan', 'user-milan');
    const juraj = seat(table, 'Juraj', 'user-juraj');
    expect(milan.userId).toBe('user-milan');
    expect(table.records.get(milan.id)?.userId).toBe('user-milan');
    expect(table.memberByUser('user-milan')).toBe(milan);
    expect(table.addPlayer('Milan', avatar, 'user-milan')).toEqual({ ok: false, error: 'Pri tomto stole už máš miesto' });
    expect(table.requestJoin('Milan', avatar, 'ip', 'user-milan')).toEqual({ ok: false, error: 'Pri tomto stole už máš miesto' });
    table.leave(juraj);
    expect(table.memberByUser('user-juraj')).toBe(juraj);
    expect(table.kickMember(milan, juraj.id).ok).toBe(true);
    expect(table.memberByUser('user-juraj')).toBeUndefined();
    expect(table.memberByUser('nobody')).toBeUndefined();
  });

  it('a member returns by account without a token and without approval, a non-member must ask the host', () => {
    const table = createTable();
    const milan = seat(table, 'Milan', 'user-milan');
    const juraj = seat(table, 'Juraj', 'user-juraj');
    table.leave(juraj);
    const back = table.resumeByUser('user-juraj', true);
    expect(back).toMatchObject({ ok: true, data: { id: juraj.id, stack: 2000 } });
    expect(table.players.has(juraj.id)).toBe(true);
    expect(table.resumeByUser('user-zuzka')).toEqual({ ok: false, error: 'Relácia vypršala' });

    const requested = table.requestJoin('Zuzka', avatar, 'ip-z', 'user-zuzka');
    expect(requested).toMatchObject({ ok: true, data: { userId: 'user-zuzka', name: 'Zuzka' } });
    expect(table.joinRequestByUser('user-zuzka')).toBe(requested.ok ? requested.data : undefined);
    // Druhá žiadosť toho istého účtu nevznikne (ani z inej siete).
    expect(table.requestJoin('Zuzka', avatar, 'ip-other', 'user-zuzka')).toEqual({ ok: false, error: 'Žiadosť o prístup ku stolu už čaká na schválenie' });
    const approved = table.resolveJoin(milan, requested.ok ? requested.data!.id : '', true);
    expect(approved).toMatchObject({ ok: true, data: { userId: 'user-zuzka', name: 'Zuzka' } });
    expect(table.memberByUser('user-zuzka')).toBe(approved.ok ? approved.data : undefined);
    expect(table.joinRequestByUser('user-zuzka')).toBeUndefined();
  });

  it('approving a request of an account that meanwhile became a member closes it without a second seat', () => {
    const table = createTable();
    const milan = seat(table, 'Milan', 'user-milan');
    const request = table.requestJoin('Juraj', avatar, 'ip', 'user-juraj');
    const closed: string[] = [];
    const hooked = createTable('ACCT02', { ...silent, onJoinClosed: (_table, _request, outcome) => closed.push(outcome) });
    expect(request.ok).toBe(true);
    // Iné zariadenie toho istého účtu sa medzitým stalo členom (simulované priamym pridaním).
    expect(table.addPlayer('Juraj', avatar, 'user-juraj').ok).toBe(true);
    const members = table.players.size;
    expect(table.resolveJoin(milan, request.ok ? request.data!.id : '', true)).toEqual({ ok: false, error: 'Pri tomto stole už máš miesto' });
    expect(table.players.size).toBe(members);
    expect(table.joinRequests.size).toBe(0);

    const host = seat(hooked, 'Host', 'user-host');
    const pending = hooked.requestJoin('Peťo', avatar, 'ip', 'user-peto');
    expect(pending.ok).toBe(true);
    hooked.closeJoinsOfUser('user-peto');
    expect(closed).toEqual(['cancelled']);
    expect(hooked.joinRequests.size).toBe(0);
    expect(host.userId).toBe('user-host');
  });

  it('a new device takes over the seat: old sockets are detached, the player never goes offline, camera turns off', () => {
    const events: TableEvent[] = [];
    const table = createTable('ACCT03', { ...silent, onEvent: (_table, event) => events.push(event) });
    seat(table, 'Milan', 'user-milan');
    const juraj = seat(table, 'Juraj', 'user-juraj');
    table.attachSocket(juraj, 'old-tab');
    table.updateProfile(juraj, { camera: true, microphone: true });
    const before = [...juraj.sockets];
    events.length = 0;
    const detached = table.takeOver(juraj, 'new-device');
    expect(detached.sort()).toEqual(before.sort());
    expect([...juraj.sockets]).toEqual(['new-device']);
    expect(juraj).toMatchObject({ camera: false, microphone: false });
    expect(events.some((event) => /offline|online/.test(event.text))).toBe(false);
    // To isté spojenie znova — nič sa neodpojí.
    expect(table.takeOver(juraj, 'new-device')).toEqual([]);
    expect(table.connectedCount()).toBe(2);
  });

  it('persists the account of seated and departed members and of the stats records', () => {
    const table = createTable();
    seat(table, 'Milan', 'user-milan');
    const juraj = seat(table, 'Juraj', 'user-juraj');
    seat(table, 'Host', null);
    table.leave(juraj);
    const snapshot = JSON.parse(JSON.stringify(table.toSnapshot())) as TableSnapshot;
    expect(snapshot.accounts).toBe(true);
    expect(snapshot.archived).toBeUndefined();
    const restored = Table.fromSnapshot(snapshot, silent);
    disposables.push(restored);
    expect(restored.archived).toBe(false);
    expect(restored.memberByUser('user-milan')?.name).toBe('Milan');
    expect(restored.departed.get(juraj.id)?.userId).toBe('user-juraj');
    expect(restored.records.get(juraj.id)?.userId).toBe('user-juraj');
    expect([...restored.players.values()].find((player) => player.name === 'Host')?.userId).toBeNull();
    expect(restored.summary(juraj.id)).toMatchObject({ left: true, myStack: 2000 });
    expect(restored.summary(restored.memberByUser('user-milan')!.id).left).toBeUndefined();
  });

  it('account profile changes (name, avatar, photo) reach every seat and the stats record, past ledger keeps the old name', () => {
    const events: TableEvent[] = [];
    const table = createTable('ACCT04', { ...silent, onEvent: (_table, event) => events.push(event) });
    const milan = seat(table, 'Milan', 'user-milan');
    const juraj = seat(table, 'Juraj', 'user-juraj');
    const photo: Avatar = { emoji: '🐻', color: '#264653', photo: '/api/photos/user-juraj.webp?v=2' };
    expect(table.applyAccountProfile('user-juraj', 'Jurko', photo)).toBe(true);
    expect(juraj).toMatchObject({ name: 'Jurko', avatar: photo });
    expect(table.records.get(juraj.id)).toMatchObject({ name: 'Jurko', avatar: photo });
    expect(table.leaderboard().find((row) => row.playerId === juraj.id)).toMatchObject({ playerName: 'Jurko', avatar: photo });
    expect(table.ledger.find((entry) => entry.playerId === juraj.id)?.playerName).toBe('Juraj');
    expect(events.at(-1)?.text).toBe('Juraj mení meno na Jurko');
    events.length = 0;
    expect(table.applyAccountProfile('user-juraj', 'Jurko', { ...photo })).toBe(false);
    expect(events).toHaveLength(0);
    // Vyhodený hráč už nie je členom — jeho riadok v štatistikách sa aj tak premenuje.
    expect(table.kickMember(milan, juraj.id).ok).toBe(true);
    expect(table.applyAccountProfile('user-juraj', 'Juraj K.', photo)).toBe(true);
    expect(table.records.get(juraj.id)?.name).toBe('Juraj K.');
  });
});

describe('SessionManager with accounts', () => {
  it('applyProfile updates only live tables where the account is a member', () => {
    const sessions = manager();
    const first = sessions.create(DEFAULT_SETTINGS);
    const second = sessions.create(DEFAULT_SETTINGS);
    const mine = seat(first, 'Milan', 'user-milan');
    const other = seat(second, 'Milan', 'user-other');
    sessions.applyProfile('user-milan', { id: 'user-milan', username: 'Milan K', avatar: { emoji: '🐻', color: '#264653' }, emailVerified: true });
    expect(mine.name).toBe('Milan K');
    expect(other.name).toBe('Milan');
  });

  it('account:tables lists live tables of the account incl. departed (left), not kicked, most recent first', () => {
    const sessions = manager();
    const older = sessions.create({ ...DEFAULT_SETTINGS, name: 'Starší' });
    const newer = sessions.create({ ...DEFAULT_SETTINGS, name: 'Novší' });
    const kickedFrom = sessions.create({ ...DEFAULT_SETTINGS, name: 'Vyhodený' });
    seat(older, 'Host', 'user-host');
    const juraj = seat(older, 'Juraj', 'user-juraj');
    older.leave(juraj);
    older.lastActivity = 1_000;
    seat(newer, 'Juraj', 'user-juraj');
    newer.lastActivity = 2_000;
    const host = seat(kickedFrom, 'Host', 'user-host');
    const kicked = seat(kickedFrom, 'Juraj', 'user-juraj');
    expect(kickedFrom.kickMember(host, kicked.id).ok).toBe(true);
    const { active, archived } = sessions.accountTables('user-juraj', undefined);
    expect(active.map((summary) => summary.name)).toEqual(['Novší', 'Starší']);
    expect(active[0].left).toBeUndefined();
    expect(active[1]).toMatchObject({ left: true, myStack: 2000, hostName: 'Host' });
    expect(archived).toEqual([]);
    expect(sessions.accountTables('nobody', [])).toEqual({ active: [], archived: [] });
  });

  it('records per-account table stats after a save, only when they change, and marks a removed table as deleted', () => {
    const directory = new FakeDirectory();
    const sessions = manager({ accounts: directory });
    const table = sessions.create({ ...DEFAULT_SETTINGS, name: 'Piatok' });
    const milan = seat(table, 'Milan', 'user-milan');
    seat(table, 'Juraj', 'user-juraj');
    seat(table, 'Hosť', null);
    table.bankChips(milan, 500, '', null, 'owed');
    vi.advanceTimersByTime(1000);
    expect(directory.lastStat('user-milan', table.code)).toEqual({
      code: table.code,
      tableName: 'Piatok',
      currency: DEFAULT_SETTINGS.currency,
      handsPlayed: 0,
      handsWon: 0,
      biggestPot: 0,
      deposited: 2500,
      withdrawn: 0,
      result: 0,
      lastPlayed: table.lastActivity,
      archived: false,
      deleted: false,
    });
    expect(directory.lastStat('user-juraj', table.code)).toMatchObject({ deposited: 2000 });
    expect(directory.recorded).toHaveLength(2);
    // Pripojenie / odpojenie mení len čas aktivity — účet sa znova nezapisuje.
    table.attachSocket(milan, 'another');
    sessions.flush();
    expect(directory.recorded).toHaveLength(2);
    table.hostSettings({ name: 'Sobota' });
    sessions.flush();
    expect(directory.recorded).toHaveLength(4);
    expect(directory.lastStat('user-milan', table.code)?.tableName).toBe('Sobota');

    sessions.remove(table.code);
    expect(directory.deleted).toEqual([table.code]);
    expect(sessions.get(table.code)).toBeUndefined();
  });

  it('a removed table pushes its last unsaved stats before being marked deleted', () => {
    const directory = new FakeDirectory();
    const sessions = manager({ accounts: directory });
    const table = sessions.create(DEFAULT_SETTINGS);
    seat(table, 'Milan', 'user-milan');
    sessions.remove(table.code);
    expect(directory.lastStat('user-milan', table.code)).toMatchObject({ deposited: 2000, deleted: false });
    expect(directory.deleted).toEqual([table.code]);
  });

  it('stats of a kicked account stay in its account', () => {
    const directory = new FakeDirectory();
    const sessions = manager({ accounts: directory });
    const table = sessions.create(DEFAULT_SETTINGS);
    const host = seat(table, 'Host', 'user-host');
    const juraj = seat(table, 'Juraj', 'user-juraj');
    expect(table.kickMember(host, juraj.id).ok).toBe(true);
    sessions.flush();
    expect(directory.lastStat('user-juraj', table.code)).toMatchObject({ deposited: 2000, withdrawn: 2000, result: 0 });
  });
});

describe('archive of tables from before accounts', () => {
  it('loads a v1.1.0 table as a read-only archive: backed up, not playable, not counted, never expires', () => {
    const dir = tempDir();
    const legacy = writeLegacyTable(dir);
    const sessions = manager({ dataDir: dir });
    expect(sessions.get('OLD001')).toBeUndefined();
    expect(sessions.count()).toBe(0);
    expect(sessions.archivedCount()).toBe(1);
    const archived = sessions.getArchived('old001')!;
    expect(archived.archived).toBe(true);
    expect(archived.phase).toBe('lobby');
    expect(archived.events.some((event) => event.text.includes('Server sa reštartoval'))).toBe(false);
    expect(archived.memberByUser('anyone')).toBeUndefined();

    const backup = path.join(dir, ARCHIVE_BACKUP_DIR, 'tables');
    expect(readdirSync(backup)).toEqual(['OLD001.json']);
    expect(readFileSync(path.join(backup, 'OLD001.json'), 'utf8')).toBe(legacy.raw);
    // Súbor archívu sa pri načítaní nemení ani nemaže (hoci je starší ako retencia).
    sessions.flush();
    vi.advanceTimersByTime(5000);
    expect(readFileSync(legacy.file, 'utf8')).toBe(legacy.raw);
    sessions.cleanup(Date.now() + (TABLE_RETENTION_DAYS + 10) * DAY_MS);
    expect(sessions.getArchived('OLD001')).toBe(archived);
    expect(existsSync(legacy.file)).toBe(true);
  });

  it('keeps the first backup when the server starts again', () => {
    const dir = tempDir();
    const legacy = writeLegacyTable(dir);
    manager({ dataDir: dir }).dispose();
    const backupFile = path.join(dir, ARCHIVE_BACKUP_DIR, 'tables', 'OLD001.json');
    writeFileSync(backupFile, 'first backup');
    writeLegacyTable(dir, 'OLD002');
    const again = manager({ dataDir: dir });
    expect(again.archivedCount()).toBe(2);
    expect(readFileSync(backupFile, 'utf8')).toBe('first backup');
    expect(existsSync(path.join(dir, ARCHIVE_BACKUP_DIR, 'tables', 'OLD002.json'))).toBe(false);
    expect(readFileSync(legacy.file, 'utf8')).toBe(legacy.raw);
  });

  it('table:join / archive code is unknown for live lookups but a live table of the account era stays live', () => {
    const dir = tempDir();
    writeLegacyTable(dir);
    const first = manager({ dataDir: dir });
    const live = first.create(DEFAULT_SETTINGS);
    seat(live, 'Milan', 'user-milan');
    first.flush();
    const second = manager({ dataDir: dir });
    expect(second.get(live.code)?.memberByUser('user-milan')?.name).toBe('Milan');
    expect(second.getArchived(live.code)).toBeUndefined();
    expect(second.get('OLD001')).toBeUndefined();
    expect(existsSync(path.join(dir, ARCHIVE_BACKUP_DIR, 'tables', `${live.code}.json`))).toBe(false);
  });

  it('archive is visible with a device seat token, claim links seats to the account and survives a restart', () => {
    const dir = tempDir();
    const directory = new FakeDirectory();
    const { milan, juraj, milanAgain } = writeLegacyTable(dir);
    const sessions = manager({ dataDir: dir, accounts: directory });
    const seatOf = (player: TablePlayer, code = 'old001') => ({ code, playerId: player.id, token: player.token });

    expect(sessions.accountTables('user-milan', [])).toEqual({ active: [], archived: [] });
    expect(sessions.archiveView('user-milan', 'OLD001', [])).toEqual({ ok: false, error: 'Archív tohto stola nie je dostupný' });
    const byDevice = sessions.accountTables('user-milan', [seatOf(milan), { code: 'OLD001', playerId: juraj.id, token: 'wrong' }]);
    expect(byDevice.archived).toEqual([
      { code: 'OLD001', name: 'Starý stôl', currency: DEFAULT_SETTINGS.currency, handNumber: 3, createdAt: expect.any(Number), lastActivity: expect.any(Number), myResult: 0, claimed: false },
    ]);

    const result = sessions.claimArchive('user-milan', [
      seatOf(milan),
      seatOf(milanAgain),
      { code: 'OLD001', playerId: juraj.id, token: 'wrong' },
      { code: 'ZZZZZZ', playerId: milan.id, token: milan.token },
      'nonsense',
    ]);
    expect(result).toEqual({
      claimed: ['OLD001'],
      failed: [
        { code: 'OLD001', error: 'Miesto pri stole sa nenašlo' },
        { code: 'ZZZZZZ', error: 'Stôl v archíve neexistuje' },
      ],
    });
    // Juraj (iný účet) svoje miesto prevezme, Milanove miesta už nie.
    expect(sessions.claimArchive('user-juraj', [seatOf(juraj), seatOf(milan)])).toEqual({ claimed: ['OLD001'], failed: [{ code: 'OLD001', error: 'Toto miesto už patrí inému účtu' }] });
    // To isté miesto znova do toho istého účtu je v poriadku.
    expect(sessions.claimArchive('user-milan', [seatOf(milan)])).toEqual({ claimed: ['OLD001'], failed: [] });

    // Štatistiky: súčet oboch Milanových miest, archív.
    expect(directory.lastStat('user-milan', 'OLD001')).toMatchObject({ handsPlayed: 4, handsWon: 3, biggestPot: 900, deposited: 4500, withdrawn: 0, result: 0, archived: true, deleted: false });
    expect(directory.lastStat('user-juraj', 'OLD001')).toMatchObject({ handsPlayed: 3, deposited: 2000, archived: true });

    const listed = sessions.accountTables('user-milan', undefined);
    expect(listed.archived).toMatchObject([{ code: 'OLD001', claimed: true, myResult: 0 }]);
    // Token miesta, ktoré patrí inému účtu, nesprístupní nič.
    expect(sessions.accountTables('user-zuzka', [seatOf(juraj)]).archived).toEqual([]);
    expect(sessions.archiveView('user-zuzka', 'OLD001', [seatOf(juraj)])).toMatchObject({ ok: false });

    const view = sessions.archiveView('user-milan', 'old001', undefined);
    expect(view.ok).toBe(true);
    const data = view.ok ? view.data! : null;
    expect(new Set(data?.myPlayerIds)).toEqual(new Set([milan.id, milanAgain.id]));
    expect(data?.myHistory.map((hand) => hand.handNumber)).toEqual([1, 2]);
    expect(data?.leaderboard).toHaveLength(3);
    expect(data?.cashout.rows.length).toBeGreaterThan(0);
    expect(data).toMatchObject({ code: 'OLD001', name: 'Starý stôl', handNumber: 3 });

    // Po reštarte: stále archív, prevzaté miesta ostávajú prevzaté.
    const saved = JSON.parse(readFileSync(path.join(dir, 'tables', 'OLD001.json'), 'utf8')) as TableSnapshot;
    expect(saved.archived).toBe(true);
    expect(saved.accounts).toBeUndefined();
    const restarted = manager({ dataDir: dir });
    expect(restarted.get('OLD001')).toBeUndefined();
    expect(restarted.getArchived('OLD001')?.membersOfUser('user-milan').map((member) => member.id).sort()).toEqual([milan.id, milanAgain.id].sort());
    expect(restarted.accountTables('user-juraj', undefined).archived).toMatchObject([{ code: 'OLD001', claimed: true }]);
  });

  it('claiming a seat of a live table is refused', () => {
    const sessions = manager();
    const table = sessions.create(DEFAULT_SETTINGS);
    const milan = seat(table, 'Milan', null);
    expect(sessions.claimArchive('user-milan', [{ code: table.code, playerId: milan.id, token: milan.token }])).toEqual({
      claimed: [],
      failed: [{ code: table.code, error: 'Tento stôl nie je v archíve' }],
    });
    expect(milan.userId).toBeNull();
  });
});

describe('device seat validation', () => {
  it('accepts only well-formed seats, upper-cases codes and caps the count', () => {
    expect(parseDeviceSeats('nope')).toEqual([]);
    expect(parseDeviceSeats([
      { code: 'abc123', playerId: 'p', token: 't' },
      { code: 'bad code', playerId: 'p', token: 't' },
      { code: 'ABC123', playerId: 'x'.repeat(65), token: 't' },
      { code: 'ABC123', playerId: 'p', token: '' },
      { code: 'ABC123', playerId: 'p', token: 7 },
      null,
    ])).toEqual([{ code: 'ABC123', playerId: 'p', token: 't' }]);
    const many = Array.from({ length: MAX_SUMMARY_REQUEST + 5 }, () => ({ code: 'ABC123', playerId: 'p', token: 't' }));
    expect(parseDeviceSeats(many)).toHaveLength(MAX_SUMMARY_REQUEST);
  });
});
