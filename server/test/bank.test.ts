import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Avatar, TableEvent, TableSettings } from '../../shared/types';
import { DEFAULT_SETTINGS } from '../../shared/constants';
import { formatMoney } from '../../shared/money';
import { Table, type TableHooks, type TablePlayer, type TableSnapshot } from '../Table';

const avatar: Avatar = { emoji: '🦊', color: '#e76f51' };
let current: Table[] = [];
let socketSeq = 0;

function createTable(settings: Partial<TableSettings> = {}): { table: Table; events: TableEvent[]; hooks: TableHooks } {
  const events: TableEvent[] = [];
  const hooks: TableHooks = { onChange: () => undefined, onEvent: (_table, event) => events.push(event), onRemoved: () => undefined };
  const table = new Table('BANK01', { ...DEFAULT_SETTINGS, ...settings }, hooks);
  current.push(table);
  return { table, events, hooks };
}

/** Prisadne bez žetónov — tie dáva len bankár. */
function sit(table: Table, name: string): TablePlayer {
  const added = table.addPlayer(name, avatar);
  if (!added.ok || !added.data) {
    throw new Error(`join ${name} failed`);
  }
  table.attachSocket(added.data, `socket-${++socketSeq}`);
  return added.data;
}

function topUp(table: Table, player: TablePlayer, amount: number, settlement: 'paid' | 'owed'): void {
  const banker = table.member(table.bankerId)!;
  const outcome = table.bankChips(player, amount, '', banker.name, settlement);
  expect(outcome).toEqual({ ok: true });
}

function startHand(table: Table): void {
  expect(table.hostStart().ok).toBe(true);
  expect(table.hostDealerChoice('random').ok).toBe(true);
  vi.advanceTimersByTime(1500);
  expect(table.engine && !table.engine.isComplete).toBe(true);
}

function foldToEnd(table: Table): void {
  while (table.engine && !table.engine.isComplete) {
    const actor = table.players.get(table.engine.toAct!.id)!;
    expect(table.act(actor, { type: 'fold' }).ok).toBe(true);
  }
}

function plan(table: Table): string[] {
  const names = (id: string) => table.cashout().rows.find((row) => row.playerId === id)!.playerName;
  return table.cashout().transfers.map((transfer) => `${names(transfer.fromId)}→${names(transfer.toId)}:${transfer.amount}`);
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

describe('bankár — rola', () => {
  it('prvý hráč (zakladateľ) je bankár, hráči prisadajú bez žetónov', () => {
    const { table, events } = createTable();
    const milan = sit(table, 'Milan');
    const juraj = sit(table, 'Juraj');
    expect(table.bankerId).toBe(milan.id);
    expect(table.view(juraj.id).bankerId).toBe(milan.id);
    expect(table.isBanker(milan.id)).toBe(true);
    expect(table.isBanker(juraj.id)).toBe(false);
    expect(juraj).toMatchObject({ stack: 0, sittingOut: true });
    expect(table.ledger).toHaveLength(0);
    expect(events.map((event) => event.text)).toContain('Juraj prisadá ku stolu — čaká na dobitie od bankára');
  });

  it('host môže dať rolu bankára komukoľvek vrátane seba a bez peňazí v banku sa nič nepýta', () => {
    const { table, events } = createTable();
    const milan = sit(table, 'Milan');
    const juraj = sit(table, 'Juraj');
    expect(table.hostSetBanker(milan, juraj, undefined)).toEqual({ ok: true });
    expect(table.bankerId).toBe(juraj.id);
    expect(events.at(-1)!.text).toBe('Milan robí bankárom hráča Juraj');
    expect(table.hostSetBanker(milan, milan, undefined)).toEqual({ ok: true });
    expect(table.bankerId).toBe(milan.id);
  });

  it('keď bankár drží peniaze, host musí vybrať, či ich odovzdá — a odovzdanie sa zapíše', () => {
    const { table, events } = createTable();
    const milan = sit(table, 'Milan');
    const juraj = sit(table, 'Juraj');
    const peto = sit(table, 'Peťo');
    topUp(table, juraj, 5000, 'paid');
    topUp(table, peto, 3000, 'owed');
    expect(table.cashHeldBy(milan.id)).toBe(5000);
    const refused = table.hostSetBanker(milan, peto, undefined);
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.error).toContain(formatMoney(5000, 'EUR'));
    expect(table.bankerId).toBe(milan.id);
    expect(table.hostSetBanker(milan, peto, true)).toEqual({ ok: true });
    expect(table.ledger.at(-1)).toMatchObject({ kind: 'handover', playerId: milan.id, toId: peto.id, amount: 5000, byName: 'Milan' });
    expect(table.cashHeldBy(milan.id)).toBe(0);
    expect(table.cashHeldBy(peto.id)).toBe(5000);
    expect(events.at(-1)!.text).toBe(`Milan robí bankárom hráča Peťo — Milan mu odovzdáva ${formatMoney(5000, 'EUR')}`);
  });

  it('bez odovzdania si starý bankár peniaze ponechá a v cashoute ich rozdá on', () => {
    const { table, events } = createTable();
    const milan = sit(table, 'Milan');
    const juraj = sit(table, 'Juraj');
    const peto = sit(table, 'Peťo');
    topUp(table, juraj, 5000, 'paid');
    expect(table.hostSetBanker(milan, peto, false)).toEqual({ ok: true });
    expect(table.ledger.some((entry) => entry.kind === 'handover')).toBe(false);
    expect(table.cashHeldBy(milan.id)).toBe(5000);
    expect(events.at(-1)!.text).toBe(`Milan robí bankárom hráča Peťo — Milan si ponecháva ${formatMoney(5000, 'EUR')} do cashoutu`);
    topUp(table, milan, 4000, 'paid');
    expect(table.ledger.at(-1)).toMatchObject({ playerId: milan.id, settlement: 'paid', bankerId: peto.id, bankerName: 'Peťo' });
    expect(table.cashHeldBy(peto.id)).toBe(4000);
  });

  it('host neprenesie rolu na hráča, ktorý odchádza, a voľba musí byť boolean', () => {
    const { table } = createTable();
    const milan = sit(table, 'Milan');
    const juraj = sit(table, 'Juraj');
    topUp(table, juraj, 1000, 'paid');
    expect(table.hostSetBanker(milan, juraj, 'áno').ok).toBe(false);
    table.leave(juraj);
    expect(table.hostSetBanker(milan, juraj, true).ok).toBe(false);
  });

  it('keď bankár odíde od stola, rolu dostane zakladateľ a peniaze ostanú u pôvodného bankára', () => {
    const { table, events } = createTable();
    const milan = sit(table, 'Milan');
    const juraj = sit(table, 'Juraj');
    const peto = sit(table, 'Peťo');
    expect(table.hostSetBanker(milan, juraj, undefined).ok).toBe(true);
    topUp(table, peto, 2000, 'paid');
    table.leave(juraj);
    expect(table.bankerId).toBe(milan.id);
    expect(table.cashHeldBy(juraj.id)).toBe(2000);
    expect(events.map((event) => event.text)).toContain(`Bankárom je Milan (Juraj odišiel od stola) — Juraj si ponecháva ${formatMoney(2000, 'EUR')} do cashoutu`);
  });

  it('vyhodený bankár stratí rolu, cashout s ním naďalej počíta', () => {
    const { table } = createTable();
    const milan = sit(table, 'Milan');
    const juraj = sit(table, 'Juraj');
    const peto = sit(table, 'Peťo');
    expect(table.hostSetBanker(milan, juraj, undefined).ok).toBe(true);
    topUp(table, peto, 2000, 'paid');
    table.leave(juraj, true, 'Milan');
    expect(table.bankerId).toBe(milan.id);
    expect(table.cashout().rows.find((row) => row.playerId === juraj.id)).toMatchObject({ holds: 2000, balance: -2000 });
  });

  it('keď zakladateľ nesedí, rolu dostane host, ktorý sedí', () => {
    const { table } = createTable();
    const milan = sit(table, 'Milan');
    const juraj = sit(table, 'Juraj');
    const peto = sit(table, 'Peťo');
    expect(table.hostSetAdmin(milan, peto, true).ok).toBe(true);
    expect(table.hostSetBanker(milan, juraj, undefined).ok).toBe(true);
    table.leave(milan);
    table.leave(juraj);
    expect(table.bankerId).toBe(peto.id);
  });
});

describe('bankár — dobíjanie a výber', () => {
  it('dobitie zaplatené bankárovi aj na dlh sa zapíše s bankárom a vidno ho v udalostiach', () => {
    const { table, events } = createTable();
    const milan = sit(table, 'Milan');
    const juraj = sit(table, 'Juraj');
    topUp(table, juraj, 2000, 'paid');
    expect(table.ledger.at(-1)).toMatchObject({ kind: 'credit', amount: 2000, settlement: 'paid', bankerId: milan.id, bankerName: 'Milan', byName: 'Milan' });
    expect(events.at(-1)!.text).toBe(`Bankár dobíja ${formatMoney(2000, 'EUR')} hráčovi Juraj (zaplatené bankárovi)`);
    topUp(table, juraj, 1000, 'owed');
    expect(table.ledger.at(-1)).toMatchObject({ kind: 'credit', amount: 1000, settlement: 'owed', bankerId: null });
    expect(events.at(-1)!.text).toBe(`Bankár dobíja ${formatMoney(1000, 'EUR')} hráčovi Juraj (na dlh)`);
    expect(juraj).toMatchObject({ stack: 3000, sittingOut: false });
  });

  it('bankár sám sebe dobíja vždy ako zaplatené (drží vlastné peniaze)', () => {
    const { table } = createTable();
    const milan = sit(table, 'Milan');
    topUp(table, milan, 2000, 'owed');
    expect(table.ledger.at(-1)).toMatchObject({ settlement: 'paid', bankerId: milan.id });
    expect(table.cashHeldBy(milan.id)).toBe(0);
  });

  it('výber: vyplatené hneď vs. bank dlží', () => {
    const { table, events } = createTable();
    sit(table, 'Milan');
    const juraj = sit(table, 'Juraj');
    topUp(table, juraj, 5000, 'paid');
    expect(table.bankChips(juraj, -2000, '', 'Milan', 'paid').ok).toBe(true);
    expect(events.at(-1)!.text).toBe(`Bankár vyberá ${formatMoney(2000, 'EUR')} hráčovi Juraj (vyplatené hneď)`);
    expect(table.bankChips(juraj, -1000, '', 'Milan', 'owed').ok).toBe(true);
    expect(events.at(-1)!.text).toBe(`Bankár vyberá ${formatMoney(1000, 'EUR')} hráčovi Juraj (bank dlží)`);
    expect(juraj.stack).toBe(2000);
    expect(table.cashout().rows.find((row) => row.playerId === juraj.id)).toMatchObject({ result: 0, balance: 3000 });
  });

  it('odmietne neznámy spôsob vyrovnania', () => {
    const { table } = createTable();
    sit(table, 'Milan');
    const juraj = sit(table, 'Juraj');
    expect(table.bankChips(juraj, 1000, '', 'Milan', 'cash')).toEqual({ ok: false, error: 'Vyber, či sú peniaze zaplatené alebo na dlh' });
    expect(table.ledger).toHaveLength(0);
  });

  it('hráč, ktorý prisadne počas hry, po dobití čaká na big blind', () => {
    const { table, events } = createTable();
    const milan = sit(table, 'Milan');
    const juraj = sit(table, 'Juraj');
    topUp(table, milan, 2000, 'paid');
    topUp(table, juraj, 2000, 'paid');
    startHand(table);
    foldToEnd(table);
    const late = sit(table, 'Dana');
    expect(late).toMatchObject({ sittingOut: true, missedBlinds: 'big', returnMode: null });
    topUp(table, late, 2000, 'owed');
    expect(late).toMatchObject({ sittingOut: true, returnMode: 'wait-bb' });
    expect(events.at(-1)!.text).toBe('Dana čaká na big blind (alebo ho môže zaplatiť hneď)');
  });

  it('leaderboard počíta len žetónové operácie, nie platby v cashoute', () => {
    const { table } = createTable();
    const milan = sit(table, 'Milan');
    const juraj = sit(table, 'Juraj');
    topUp(table, milan, 2000, 'paid');
    topUp(table, juraj, 2000, 'owed');
    juraj.stack = 0;
    milan.stack = 4000;
    expect(table.bankSettle(milan, 'debt', juraj.id, milan.id, 2000).ok).toBe(true);
    expect(table.bankSettle(milan, 'payout', milan.id, milan.id, 1).ok).toBe(false);
    const row = table.leaderboard().find((item) => item.playerId === juraj.id)!;
    expect(row).toMatchObject({ deposited: 2000, withdrawn: 0, result: -2000 });
  });
});

describe('bankár — cashout', () => {
  /** Milan bankár drží 180 € od Juraja, Peťo dobil 20 € na dlh a všetko prehral; Juraj vyhral. */
  function scenario() {
    const created = createTable();
    const { table } = created;
    const milan = sit(table, 'Milan');
    const juraj = sit(table, 'Juraj');
    const peto = sit(table, 'Peťo');
    topUp(table, juraj, 18_000, 'paid');
    topUp(table, peto, 2000, 'owed');
    expect(table.bankChips(peto, -2000, '', 'Milan', 'owed').ok).toBe(true);
    expect(table.bankChips(juraj, 2000, '', 'Milan', 'paid').ok).toBe(true);
    return { ...created, milan, juraj, peto };
  }

  it('pri dlžníkovi, ktorý prehral, mu plán prikáže doplatiť', () => {
    const { table, milan, peto, juraj } = scenarioLost();
    expect(plan(table)).toEqual(['Milan→Juraj:18000', 'Peťo→Juraj:2000']);
    expect(table.cashout().rows.find((row) => row.playerId === peto.id)).toMatchObject({ debt: 2000, balance: -2000 });
    expect(table.cashout().rows.find((row) => row.playerId === milan.id)).toMatchObject({ holds: 18_000 });
    expect(juraj.stack).toBe(20_000);
  });

  function scenarioLost() {
    const created = createTable();
    const { table } = created;
    const milan = sit(table, 'Milan');
    const juraj = sit(table, 'Juraj');
    const peto = sit(table, 'Peťo');
    topUp(table, juraj, 18_000, 'paid');
    topUp(table, peto, 2000, 'owed');
    // Peťo prehrá všetko Jurajovi — simulované presunom žetónov mimo ruky.
    peto.stack = 0;
    juraj.stack = 20_000;
    return { ...created, milan, juraj, peto };
  }

  it('splatenie dlhu: len do výšky dlhu, nie bankár sám sebe, potom platí len bankár', () => {
    const { table, milan, peto } = scenarioLost();
    expect(table.bankSettle(milan, 'debt', peto.id, milan.id, 2001)).toEqual({ ok: false, error: 'Cashout sa medzitým zmenil — skús to znova' });
    expect(table.bankSettle(milan, 'debt', milan.id, milan.id, 100)).toEqual({ ok: false, error: 'Bankár nemôže splatiť dlh sám sebe' });
    expect(table.bankSettle(milan, 'debt', peto.id, 'ignored', 2000)).toEqual({ ok: true });
    expect(table.ledger.at(-1)).toMatchObject({ kind: 'debt-paid', playerId: peto.id, toId: milan.id, amount: 2000, byName: 'Milan' });
    expect(plan(table)).toEqual(['Milan→Juraj:20000']);
    expect(table.bankSettle(milan, 'debt', peto.id, milan.id, 1)).toEqual({ ok: false, error: 'Peťo nemá nesplatený dlh' });
  });

  it('výplaty: musia sedieť s cashoutom a po všetkých je plán prázdny', () => {
    const { table, milan, juraj, peto } = scenarioLost();
    expect(table.bankSettle(milan, 'payout', peto.id, juraj.id, 2001).ok).toBe(false);
    expect(table.bankSettle(milan, 'payout', juraj.id, peto.id, 100).ok).toBe(false);
    expect(table.bankSettle(milan, 'payout', peto.id, peto.id, 100).ok).toBe(false);
    expect(table.bankSettle(milan, 'payout', 'nikto', juraj.id, 100).ok).toBe(false);
    expect(table.bankSettle(milan, 'payout', peto.id, juraj.id, 2000)).toEqual({ ok: true });
    expect(table.bankSettle(milan, 'payout', milan.id, juraj.id, 18_000)).toEqual({ ok: true });
    expect(plan(table)).toEqual([]);
    expect(table.cashout().rows.every((row) => row.balance === 0)).toBe(true);
    expect(table.cashout().rows.find((row) => row.playerId === peto.id)!.debt).toBe(0);
  });

  it('zrušenie platby vráti plán, druhýkrát sa zrušiť nedá a dobitie sa zrušiť nedá', () => {
    const { table, milan, juraj, peto } = scenarioLost();
    expect(table.bankSettle(milan, 'payout', peto.id, juraj.id, 2000).ok).toBe(true);
    const payoutId = table.ledger.at(-1)!.id;
    expect(table.bankUndo(milan, payoutId)).toEqual({ ok: true });
    expect(table.ledger.at(-1)).toMatchObject({ kind: 'reversal', playerId: juraj.id, toId: peto.id, amount: 2000, reverts: payoutId });
    expect(plan(table)).toEqual(['Milan→Juraj:18000', 'Peťo→Juraj:2000']);
    expect(table.bankUndo(milan, payoutId)).toEqual({ ok: false, error: 'Platba už je zrušená' });
    expect(table.bankUndo(milan, table.ledger[0].id)).toEqual({ ok: false, error: 'Platba neexistuje' });
    expect(table.bankUndo(milan, 'x')).toEqual({ ok: false, error: 'Platba neexistuje' });
  });

  it('kým sú žetóny v Prasiatku, výplaty sa nepotvrdzujú', () => {
    const { table, milan, juraj, peto } = scenarioLost();
    table.piggy = { status: 'running', amount: 40, entry: 20, target: 3, wins: {}, contributed: {}, startedAtHand: 1, winners: [], handEntries: null, series: { games: 1, remaining: 1, permanent: false, stopping: false } };
    expect(table.bankSettle(milan, 'payout', peto.id, juraj.id, 100)).toEqual({ ok: false, error: 'V Prasiatku sú žetóny — výplaty potvrdíš po jeho výplate alebo zrušení' });
    expect(table.bankSettle(milan, 'debt', peto.id, milan.id, 2000).ok).toBe(true);
    table.piggy = null;
  });

  it('platby nemenia žetóny ani leaderboard', () => {
    const { table, milan, juraj, peto } = scenarioLost();
    const before = JSON.stringify(table.leaderboard());
    expect(table.bankSettle(milan, 'payout', peto.id, juraj.id, 2000).ok).toBe(true);
    expect(JSON.stringify(table.leaderboard())).toBe(before);
  });

  it('scenár s výbermi sedí do nuly', () => {
    const { table } = scenario();
    expect(table.cashout().imbalance).toBe(0);
  });
});

describe('bankár — scenár Milky (40 € bankárovi + 40 € na dlh)', () => {
  it('cashout ukazuje celý dlh 40 € ako v histórii, vyrovnanie ho započíta a splatenie 40 € sa dá zapísať', () => {
    const { table } = createTable();
    const korki = sit(table, 'Korki');
    const milky = sit(table, 'Milky');
    topUp(table, korki, 4000, 'paid');
    topUp(table, milky, 4000, 'paid');
    topUp(table, milky, 4000, 'owed');
    milky.stack = 4020;
    korki.stack = 7980;
    const rows = () => table.cashout().rows;
    expect(rows().find((row) => row.playerId === milky.id)).toMatchObject({ result: -3980, debt: 4000, debtNetted: true, balance: 20 });
    expect(table.cashout().transfers).toEqual([{ fromId: korki.id, fromName: 'Korki', toId: milky.id, toName: 'Milky', amount: 20 }]);
    expect(table.bankSettle(korki, 'debt', milky.id, korki.id, 4001).ok).toBe(false);
    expect(table.bankSettle(korki, 'debt', milky.id, korki.id, 4000)).toEqual({ ok: true });
    expect(rows().find((row) => row.playerId === milky.id)).toMatchObject({ debt: 0, balance: 4020 });
    expect(table.cashout().transfers).toEqual([{ fromId: korki.id, fromName: 'Korki', toId: milky.id, toName: 'Milky', amount: 4020 }]);
  });
});

describe('bankár — uloženie', () => {
  it('bankár, spôsob vyrovnania aj platby prežijú reštart', () => {
    const { table, hooks } = createTable();
    const milan = sit(table, 'Milan');
    const juraj = sit(table, 'Juraj');
    const peto = sit(table, 'Peťo');
    topUp(table, juraj, 5000, 'paid');
    topUp(table, peto, 3000, 'owed');
    expect(table.hostSetBanker(milan, juraj, true).ok).toBe(true);
    const snapshot = JSON.parse(JSON.stringify(table.toSnapshot())) as TableSnapshot;
    const restored = Table.fromSnapshot(snapshot, hooks);
    current.push(restored);
    expect(restored.bankerId).toBe(juraj.id);
    expect(restored.ledger).toEqual(table.ledger);
    expect(restored.cashout()).toEqual(table.cashout());
  });

  it('starší súbor bez bankára: bankárom je zakladateľ, štartovací vklad z nastavení zmizne', () => {
    const { table, hooks } = createTable();
    const milan = sit(table, 'Milan');
    sit(table, 'Juraj');
    const snapshot = JSON.parse(JSON.stringify(table.toSnapshot())) as TableSnapshot & { settings: { startingStack?: number } };
    delete snapshot.bankerId;
    snapshot.settings.startingStack = 2000;
    const restored = Table.fromSnapshot(snapshot, hooks);
    current.push(restored);
    expect(restored.bankerId).toBe(milan.id);
    expect(restored.settings).not.toHaveProperty('startingStack');
  });

  it('uložený bankár, ktorý medzitým odišiel, odovzdá rolu sediacemu zakladateľovi', () => {
    const { table, hooks } = createTable();
    const milan = sit(table, 'Milan');
    const juraj = sit(table, 'Juraj');
    expect(table.hostSetBanker(milan, juraj, undefined).ok).toBe(true);
    const snapshot = JSON.parse(JSON.stringify(table.toSnapshot())) as TableSnapshot;
    snapshot.departed = [...(snapshot.departed ?? []), ...snapshot.players.filter((player) => player.id === juraj.id)];
    snapshot.players = snapshot.players.filter((player) => player.id !== juraj.id);
    const restored = Table.fromSnapshot(snapshot, hooks);
    current.push(restored);
    expect(restored.bankerId).toBe(milan.id);
  });
});
