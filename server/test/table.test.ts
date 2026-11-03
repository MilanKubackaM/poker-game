import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Avatar, TableEvent, TableSettings } from '../../shared/types';
import { DEFAULT_SETTINGS, MAX_NOTE_LENGTH } from '../../shared/constants';
import { formatMoney } from '../../shared/money';
import { Table, type TablePlayer } from '../Table';
import { TEST_BUY_IN, buyIn, setTestBuyIn } from './helpers';

const avatar: Avatar = { emoji: '🦊', color: '#e76f51' };

function createTable(testSettings: Partial<TableSettings> & { startingStack?: number } = {}): { table: Table; events: TableEvent[] } {
  const { startingStack = TEST_BUY_IN, ...settings } = testSettings;
  const events: TableEvent[] = [];
  const table = new Table('TEST01', { ...DEFAULT_SETTINGS, ...settings }, {
    onChange: () => undefined,
    onEvent: (_table, event) => events.push(event),
    onRemoved: () => undefined,
  });
  setTestBuyIn(table, startingStack);
  return { table, events };
}

function join(table: Table, name: string): TablePlayer {
  const added = table.addPlayer(name, avatar);
  if (!added.ok || !added.data) {
    throw new Error(`join ${name} failed`);
  }
  buyIn(table, added.data);
  return added.data;
}

/** Žetóny sediacich hráčov aj členov, ktorí odišli (ich stack ostáva uložený pri stole). */
function chipsAtTable(table: Table): number {
  return [...table.players.values(), ...table.departed.values()].reduce((sum, player) => sum + player.stack + player.pendingChips, 0);
}

function ledgerTotal(table: Table): number {
  return table.ledger.reduce((sum, entry) => sum + entry.amount, 0);
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
    const outcome = table.act(table.players.get(actorId)!, { type: 'fold' });
    expect(outcome.ok).toBe(true);
  }
}

let current: Table | null = null;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  current?.dispose();
  current = null;
  vi.useRealTimers();
});

describe('hostSettings validation', () => {
  it('accepts decimal-like cent values and currency CZK', () => {
    const { table } = createTable();
    current = table;
    const outcome = table.hostSettings({ currency: 'CZK', smallBlind: 5, bigBlind: 10, sevenDeuceBounty: 25 });
    expect(outcome.ok).toBe(true);
    expect(table.settings).toMatchObject({ currency: 'CZK', smallBlind: 5, bigBlind: 10, sevenDeuceBounty: 25 });
  });

  it('scales the 7-2 bonus with the big blind unless the host sets it in the same change', () => {
    const { table } = createTable();
    current = table;
    expect(table.settings).toMatchObject({ bigBlind: 20, sevenDeuceBounty: 40 });
    expect(table.hostSettings({ smallBlind: 50, bigBlind: 100 }).ok).toBe(true);
    expect(table.settings.sevenDeuceBounty).toBe(200);
    expect(table.hostSettings({ ...table.settings, smallBlind: 25, bigBlind: 50 }).ok).toBe(true);
    expect(table.settings.sevenDeuceBounty).toBe(100);
    expect(table.hostSettings({ bigBlind: 100, sevenDeuceBounty: 30 }).ok).toBe(true);
    expect(table.settings.sevenDeuceBounty).toBe(30);
  });

  it('ignores the removed starting stack sent by an older client', () => {
    const { table } = createTable();
    current = table;
    expect(table.hostSettings({ startingStack: 5000 } as Partial<TableSettings>).ok).toBe(true);
    expect(table.settings).not.toHaveProperty('startingStack');
  });

  it('rejects an unknown currency, fractional cents and negative bounty', () => {
    const { table } = createTable();
    current = table;
    expect(table.hostSettings({ currency: 'USD' as never }).ok).toBe(false);
    expect(table.hostSettings({ smallBlind: 10.5 }).ok).toBe(false);
    expect(table.hostSettings({ sevenDeuceBounty: -1 }).ok).toBe(false);
    expect(table.hostSettings({ smallBlind: 0, bigBlind: 0 }).ok).toBe(false);
    expect(table.hostSettings({ smallBlind: 30, bigBlind: 20 }).ok).toBe(false);
    expect(table.settings).toEqual(DEFAULT_SETTINGS);
  });

  it('ignores unknown keys and describes the change in the table currency', () => {
    const { table, events } = createTable();
    current = table;
    expect(table.hostSettings({ currency: 'CZK', smallBlind: 50, bigBlind: 100, junk: 'x' } as Partial<TableSettings>).ok).toBe(true);
    expect(table.settings).not.toHaveProperty('junk');
    const text = events.at(-1)!.text;
    expect(text).toContain('Nové pravidlá');
    expect(text).toContain('mena Koruna (Kč)');
    expect(text).toContain(`blindy ${formatMoney(50, 'CZK')}/${formatMoney(100, 'CZK')}`);
  });
});

describe('ledger', () => {
  it('records the banker top-up of a new player', () => {
    const { table } = createTable();
    current = table;
    const host = join(table, 'Milan');
    expect(table.ledger).toHaveLength(1);
    expect(table.ledger[0]).toMatchObject({ id: 1, kind: 'credit', playerId: host.id, playerName: 'Milan', amount: 2000, stackAfter: 2000, deferred: false });
    expect(table.view(host.id).ledger).toEqual(table.ledger);
  });

  it('gives no chips on join, the player sits out until the banker tops him up', () => {
    const { table } = createTable({ startingStack: 0 });
    current = table;
    const host = join(table, 'Milan');
    expect(table.ledger).toHaveLength(0);
    expect(host.sittingOut).toBe(true);
    expect(table.setSittingOut(host, false).ok).toBe(false);
    expect(host.sittingOut).toBe(true);
  });

  it('records a credit with a note and returns the player to the game', () => {
    const { table, events } = createTable({ currency: 'CZK', smallBlind: 50, bigBlind: 100, startingStack: 0 });
    current = table;
    const host = join(table, 'Milan');
    const juraj = join(table, 'Juraj');
    const outcome = table.bankChips(juraj, 5000, '  dlží peniaze   do banku ', host.name);
    expect(outcome.ok).toBe(true);
    expect(juraj.stack).toBe(5000);
    expect(juraj.sittingOut).toBe(false);
    expect(table.ledger.at(-1)).toMatchObject({ kind: 'credit', playerId: juraj.id, amount: 5000, stackAfter: 5000, note: 'dlží peniaze do banku', byName: 'Milan', deferred: false });
    const text = events.at(-1)!.text;
    expect(text).toContain(formatMoney(5000, 'CZK'));
    expect(text).toContain('dlží peniaze do banku');
  });

  it('records a debit and rejects removing more than the player has', () => {
    const { table } = createTable();
    current = table;
    const host = join(table, 'Milan');
    const juraj = join(table, 'Juraj');
    const tooMuch = table.bankChips(juraj, -2001, '', host.name);
    expect(tooMuch.ok).toBe(false);
    expect(!tooMuch.ok && tooMuch.error).toContain(formatMoney(2000, 'EUR'));
    expect(table.bankChips(juraj, -500, 'poslal Milanovi na účet', host.name).ok).toBe(true);
    expect(table.ledger.at(-1)).toMatchObject({ kind: 'debit', amount: -500, stackAfter: 1500, note: 'poslal Milanovi na účet', byName: 'Milan' });
    expect(table.bankChips(juraj, -1500, undefined, host.name).ok).toBe(true);
    expect(juraj.stack).toBe(0);
    expect(juraj.sittingOut).toBe(true);
  });

  it('validates the note', () => {
    const { table } = createTable();
    current = table;
    const host = join(table, 'Milan');
    expect(table.bankChips(host, 100, 42, host.name).ok).toBe(false);
    expect(table.bankChips(host, 100, 'x'.repeat(MAX_NOTE_LENGTH + 1), host.name).ok).toBe(false);
    expect(table.bankChips(host, 100, 'x'.repeat(MAX_NOTE_LENGTH), host.name).ok).toBe(true);
    expect(table.bankChips(host, 100, null, host.name).ok).toBe(true);
    expect(table.ledger.at(-1)!.note).toBe('');
  });

  it('defers a credit during a hand and refuses a debit until the hand ends', () => {
    const { table } = createTable();
    current = table;
    const host = join(table, 'Milan');
    const juraj = join(table, 'Juraj');
    startHand(table);
    const visible = table.view(juraj.id).players.find((player) => player.id === juraj.id)!.stack;
    expect(table.bankChips(juraj, 1000, 'dobitie', host.name).ok).toBe(true);
    expect(table.ledger.at(-1)).toMatchObject({ kind: 'credit', amount: 1000, deferred: true, stackAfter: visible + 1000 });
    expect(juraj.pendingChips).toBe(1000);
    expect(table.bankChips(juraj, -100, '', host.name).ok).toBe(false);
    foldToEnd(table);
    expect(juraj.pendingChips).toBe(0);
    expect(chipsAtTable(table)).toBe(5000);
    expect(ledgerTotal(table)).toBe(chipsAtTable(table));
  });

  it('keeps the chips of a voluntary leaver without a ledger entry, while a kick cashes out', () => {
    const { table } = createTable();
    current = table;
    const host = join(table, 'Milan');
    const juraj = join(table, 'Juraj');
    const peto = join(table, 'Peťo');
    const before = table.ledger.length;
    table.leave(juraj);
    expect(table.ledger).toHaveLength(before);
    expect(table.players.has(juraj.id)).toBe(false);
    expect(table.departed.get(juraj.id)).toMatchObject({ stack: 2000 });
    table.leave(peto, true);
    expect(table.ledger.at(-1)).toMatchObject({ kind: 'leave', playerId: peto.id, amount: -2000, note: 'Vyhodenie hostom', byName: 'Milan', settlement: 'owed' });
    expect(table.departed.has(peto.id)).toBe(false);
    expect(ledgerTotal(table)).toBe(chipsAtTable(table));
    expect(chipsAtTable(table)).toBe(host.stack + 2000);
  });

  it('moves a mid-hand leaver to the departed members after the hand without a ledger entry, keeping chips conserved', () => {
    const { table } = createTable();
    current = table;
    const host = join(table, 'Milan');
    join(table, 'Juraj');
    const peto = join(table, 'Peťo');
    startHand(table);
    const ledgerBefore = table.ledger.length;
    table.leave(peto);
    table.leave(peto, true);
    expect(table.ledger).toHaveLength(ledgerBefore);
    expect(table.bankChips(peto, 100, '', host.name).ok).toBe(false);
    foldToEnd(table);
    expect(table.players.has(peto.id)).toBe(false);
    expect(table.departed.has(peto.id)).toBe(true);
    expect(table.ledger.filter((entry) => entry.kind === 'leave')).toHaveLength(0);
    expect(ledgerTotal(table)).toBe(chipsAtTable(table));
  });
});

describe('dealing', () => {
  it('does not deal in a player with 0 chips', () => {
    const { table } = createTable();
    current = table;
    const host = join(table, 'Milan');
    const juraj = join(table, 'Juraj');
    setTestBuyIn(table, 0);
    const broke = join(table, 'Peťo');
    expect(broke.sittingOut).toBe(true);
    startHand(table);
    expect(table.engine!.players.map((player) => player.id).sort()).toEqual([host.id, juraj.id].sort());
    expect(table.view(broke.id).players.find((player) => player.id === broke.id)!.inHand).toBe(false);
  });

  it('formats engine log and last action in the table currency', () => {
    const { table, events } = createTable({ currency: 'CZK', smallBlind: 50, bigBlind: 100, startingStack: 10_000 });
    current = table;
    join(table, 'Milan');
    join(table, 'Juraj');
    startHand(table);
    expect(events.some((event) => event.kind === 'action' && event.text.endsWith(formatMoney(100, 'CZK')))).toBe(true);
    const lastActions = table.engine!.players.map((player) => player.lastAction);
    expect(lastActions.some((action) => action?.includes(formatMoney(100, 'CZK')))).toBe(true);
    foldToEnd(table);
    const won = formatMoney(table.lastResult!.winners[0].amount, 'CZK');
    expect(events.some((event) => event.kind === 'result' && event.text.includes(won))).toBe(true);
  });
});
