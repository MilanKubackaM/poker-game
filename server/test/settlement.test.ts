import { describe, expect, it } from 'vitest';
import type { LedgerEntry, Settlement } from '../../shared/types';
import { computeCashout, isChipEntry, simplifyDebts, type Cashout, type CashoutMember } from '../../shared/settlement';

let nextId = 0;

function chips(playerId: string, amount: number, settlement: Settlement | undefined, bankerId: string | null = null, kind: LedgerEntry['kind'] = amount > 0 ? 'credit' : 'debit'): LedgerEntry {
  return {
    id: ++nextId,
    at: 0,
    kind,
    playerId,
    playerName: playerId,
    amount,
    stackAfter: null,
    note: '',
    byName: null,
    deferred: false,
    ...(settlement ? { settlement, bankerId, bankerName: bankerId } : {}),
  };
}

function cash(kind: 'debt-paid' | 'payout' | 'handover' | 'reversal', fromId: string, toId: string, amount: number, reverts?: number): LedgerEntry {
  return { id: ++nextId, at: 0, kind, playerId: fromId, playerName: fromId, amount, stackAfter: null, note: '', byName: null, deferred: false, toId, toName: toId, ...(reverts ? { reverts } : {}) };
}

function members(stacks: Record<string, number>): CashoutMember[] {
  return Object.entries(stacks).map(([playerId, stack]) => ({ playerId, playerName: playerId, stack }));
}

function row(cashout: Cashout, playerId: string) {
  const found = cashout.rows.find((item) => item.playerId === playerId);
  if (!found) {
    throw new Error(`missing row ${playerId}`);
  }
  return found;
}

function plan(cashout: Cashout): string[] {
  return cashout.transfers.map((transfer) => `${transfer.fromId}→${transfer.toId}:${transfer.amount}`);
}

describe('cashout — kto komu pošle', () => {
  it('celý bank drží bankár: posiela len bankár a sebe si nechá svoj stack', () => {
    const ledger = [chips('milan', 10_000, 'paid', 'dominik'), chips('juraj', 8000, 'paid', 'dominik'), chips('dominik', 2000, 'paid', 'dominik')];
    const cashout = computeCashout(ledger, members({ milan: 0, juraj: 15_000, dominik: 5000 }));
    expect(plan(cashout)).toEqual(['dominik→juraj:15000']);
    expect(row(cashout, 'dominik')).toMatchObject({ result: 3000, holds: 18_000, balance: -15_000, debt: 0 });
    expect(row(cashout, 'milan')).toMatchObject({ result: -10_000, balance: 0, debt: 0 });
    expect(cashout.imbalance).toBe(0);
  });

  it('bankár drží 180 €, Milan dlží 20 € a všetko prehral — Milan musí ešte poslať 20 €', () => {
    const ledger = [chips('milan', 18_000, 'paid', 'dominik'), chips('milan', 2000, 'owed'), chips('juraj', 10_000, 'paid', 'dominik')];
    const cashout = computeCashout(ledger, members({ milan: 0, juraj: 30_000, dominik: 0 }));
    expect(plan(cashout)).toEqual(['dominik→juraj:28000', 'milan→juraj:2000']);
    expect(row(cashout, 'milan')).toMatchObject({ result: -20_000, balance: -2000, debt: 2000, debtNetted: false });
    expect(row(cashout, 'dominik')).toMatchObject({ holds: 28_000, balance: -28_000 });
  });

  it('dlh vyhrávajúceho hráča sa započíta do výhry — nič nedlží, dostane menej', () => {
    const ledger = [chips('milan', 2000, 'owed'), chips('juraj', 4000, 'paid', 'dominik')];
    const cashout = computeCashout(ledger, members({ milan: 5000, juraj: 1000, dominik: 0 }));
    expect(row(cashout, 'milan')).toMatchObject({ result: 3000, balance: 3000, debt: 2000, debtNetted: true });
    expect(row(cashout, 'juraj')).toMatchObject({ result: -3000, balance: 1000 });
    expect(plan(cashout)).toEqual(['dominik→milan:3000', 'dominik→juraj:1000']);
  });

  it('dlh čiastočne pokrytý zvyškom stacku ukáže len to, čo treba doplatiť', () => {
    const ledger = [chips('milan', 2000, 'owed'), chips('juraj', 2000, 'paid', 'dominik')];
    const cashout = computeCashout(ledger, members({ milan: 1000, juraj: 3000, dominik: 0 }));
    expect(row(cashout, 'milan')).toMatchObject({ balance: -1000, debt: 2000, debtNetted: false });
  });

  it('Milky: 40 € bankárovi + 40 € na dlh, ostalo mu 40,20 € — dlh 40 € je vidieť celý a započíta sa (dostane 0,20 €)', () => {
    const ledger = [chips('milky', 4000, 'paid', 'korki'), chips('milky', 4000, 'owed'), chips('korki', 4000, 'paid', 'korki')];
    const cashout = computeCashout(ledger, members({ milky: 4020, korki: 7980 }));
    expect(row(cashout, 'milky')).toMatchObject({ result: -3980, balance: 20, debt: 4000, debtNetted: true });
    expect(row(cashout, 'korki')).toMatchObject({ result: 3980, holds: 4000, balance: -20, debt: 0 });
    expect(plan(cashout)).toEqual(['korki→milky:20']);
  });

  it('Milky splatí dlh bankárovi v hotovosti: dlh zmizne a bankár mu vráti celú hodnotu žetónov', () => {
    const ledger = [chips('milky', 4000, 'paid', 'korki'), chips('milky', 4000, 'owed'), chips('korki', 4000, 'paid', 'korki'), cash('debt-paid', 'milky', 'korki', 4000)];
    const cashout = computeCashout(ledger, members({ milky: 4020, korki: 7980 }));
    expect(row(cashout, 'milky')).toMatchObject({ balance: 4020, debt: 0, debtNetted: false });
    expect(plan(cashout)).toEqual(['korki→milky:4020']);
  });

  it('dlžník, ktorý prehral, splatí dlh výplatou z cashoutu — dlh potom zmizne', () => {
    const ledger = [chips('milan', 18_000, 'paid', 'dominik'), chips('milan', 2000, 'owed'), chips('juraj', 10_000, 'paid', 'dominik'), cash('payout', 'milan', 'juraj', 2000)];
    const cashout = computeCashout(ledger, members({ milan: 0, juraj: 30_000, dominik: 0 }));
    expect(row(cashout, 'milan')).toMatchObject({ balance: 0, debt: 0 });
  });

  it('výber „bank dlží“ znižuje dlh z dobitia na dlh', () => {
    const ledger = [chips('milan', 4000, 'owed'), chips('milan', -1500, 'owed')];
    const cashout = computeCashout(ledger, members({ milan: 2500, dominik: 0 }));
    expect(row(cashout, 'milan')).toMatchObject({ debt: 2500 });
  });

  it('splatený dlh bankárovi presunie platbu na bankára', () => {
    const ledger = [chips('milan', 18_000, 'paid', 'dominik'), chips('milan', 2000, 'owed'), chips('juraj', 10_000, 'paid', 'dominik'), cash('debt-paid', 'milan', 'dominik', 2000)];
    const cashout = computeCashout(ledger, members({ milan: 0, juraj: 30_000, dominik: 0 }));
    expect(row(cashout, 'milan')).toMatchObject({ balance: 0, debt: 0 });
    expect(plan(cashout)).toEqual(['dominik→juraj:30000']);
  });

  it('potvrdená výplata zníži plán, zrušená ho vráti', () => {
    const base = [chips('milan', 2000, 'paid', 'dominik'), chips('juraj', 2000, 'paid', 'dominik')];
    const stacks = members({ milan: 0, juraj: 4000, dominik: 0 });
    expect(plan(computeCashout(base, stacks))).toEqual(['dominik→juraj:4000']);
    const payout = cash('payout', 'dominik', 'juraj', 1500);
    const paid = computeCashout([...base, payout], stacks);
    expect(plan(paid)).toEqual(['dominik→juraj:2500']);
    const reverted = computeCashout([...base, payout, cash('reversal', 'juraj', 'dominik', 1500, payout.id)], stacks);
    expect(plan(reverted)).toEqual(['dominik→juraj:4000']);
  });

  it('zrušené splatenie dlhu vráti dlh', () => {
    const debtPaid = cash('debt-paid', 'milan', 'dominik', 2000);
    const ledger = [chips('milan', 2000, 'owed'), debtPaid, cash('reversal', 'dominik', 'milan', 2000, debtPaid.id)];
    const cashout = computeCashout(ledger, members({ milan: 0, juraj: 2000, dominik: 0 }));
    expect(row(cashout, 'milan')).toMatchObject({ balance: -2000, debt: 2000 });
  });

  it('výber vyplatený hneď je vyrovnaný, výber „bank dlží“ čaká na cashout', () => {
    const ledger = [chips('milan', 5000, 'paid', 'dominik'), chips('milan', -3000, 'paid', 'dominik'), chips('juraj', 5000, 'paid', 'dominik'), chips('juraj', -2000, 'owed')];
    const cashout = computeCashout(ledger, members({ milan: 2000, juraj: 3000, dominik: 0 }));
    expect(row(cashout, 'milan')).toMatchObject({ result: 0, balance: 2000 });
    expect(row(cashout, 'juraj')).toMatchObject({ result: 0, balance: 5000 });
    expect(row(cashout, 'dominik')).toMatchObject({ holds: 7000, balance: -7000 });
    expect(cashout.imbalance).toBe(0);
  });

  it('vyhodený hráč (leave, bank dlží) dostane svoje žetóny v cashoute', () => {
    const ledger = [chips('peto', 2000, 'paid', 'dominik'), chips('peto', -2500, 'owed', null, 'leave'), chips('milan', 2000, 'paid', 'dominik')];
    const cashout = computeCashout(ledger, members({ milan: 1500, dominik: 0 }));
    expect(row(cashout, 'peto')).toMatchObject({ stack: 0, result: 500, balance: 2500 });
    expect(row(cashout, 'milan')).toMatchObject({ result: -500, balance: 1500 });
    expect(plan(cashout)).toEqual(['dominik→peto:2500', 'dominik→milan:1500']);
  });

  it('staršie záznamy bez spôsobu vyrovnania sa berú ako dlh', () => {
    const ledger = [chips('milan', 18_000, undefined, null, 'buyin'), chips('dominik', 4000, undefined)];
    const cashout = computeCashout(ledger, members({ milan: 4428, dominik: 17_572 }));
    expect(row(cashout, 'milan')).toMatchObject({ result: -13_572, balance: -13_572, debt: 18_000, holds: 0 });
    expect(plan(cashout)).toEqual(['milan→dominik:13572']);
  });

  it('odovzdanie banku: platí nový bankár, starý už nič nedrží', () => {
    const ledger = [chips('milan', 10_000, 'paid', 'dominik'), cash('handover', 'dominik', 'juraj', 10_000), chips('peto', 5000, 'paid', 'juraj')];
    const cashout = computeCashout(ledger, members({ milan: 0, peto: 15_000, dominik: 0, juraj: 0 }));
    expect(row(cashout, 'dominik')).toMatchObject({ holds: 0, balance: 0 });
    expect(row(cashout, 'juraj')).toMatchObject({ holds: 15_000 });
    expect(plan(cashout)).toEqual(['juraj→peto:15000']);
  });

  it('dvaja držitelia peňazí (bank neodovzdaný) — každý vyplatí svoj diel', () => {
    const ledger = [chips('milan', 10_000, 'paid', 'dominik'), chips('peto', 5000, 'paid', 'juraj')];
    const cashout = computeCashout(ledger, members({ milan: 0, peto: 15_000, dominik: 0, juraj: 0 }));
    expect(plan(cashout).sort()).toEqual(['dominik→peto:10000', 'juraj→peto:5000']);
  });

  it('žetóny mimo stackov (Prasiatko) sa ukážu ako nevyrovnaný rozdiel', () => {
    const ledger = [chips('milan', 2000, 'paid', 'dominik'), chips('juraj', 2000, 'paid', 'dominik')];
    const cashout = computeCashout(ledger, members({ milan: 1980, juraj: 1980, dominik: 0 }));
    expect(cashout.imbalance).toBe(-40);
  });

  it('peňažné operácie nie sú žetónové', () => {
    expect(isChipEntry({ kind: 'credit' })).toBe(true);
    expect(isChipEntry({ kind: 'leave' })).toBe(true);
    expect(isChipEntry({ kind: 'payout' })).toBe(false);
    expect(isChipEntry({ kind: 'handover' })).toBe(false);
  });
});

describe('simplifyDebts', () => {
  it('vyrovná všetkých najviac n−1 prevodmi a nikto neposiela aj neprijíma', () => {
    const balances = { a: 5000, b: 3000, c: -1000, d: -2500, e: -4500, f: 0 };
    const rows = Object.entries(balances).map(([playerId, balance]) => ({ playerId, playerName: playerId, balance }));
    const transfers = simplifyDebts(rows);
    const settled = new Map(Object.entries(balances));
    for (const transfer of transfers) {
      expect(transfer.amount).toBeGreaterThan(0);
      settled.set(transfer.fromId, settled.get(transfer.fromId)! + transfer.amount);
      settled.set(transfer.toId, settled.get(transfer.toId)! - transfer.amount);
    }
    expect([...settled.values()].every((value) => value === 0)).toBe(true);
    expect(transfers.length).toBeLessThanOrEqual(4);
    const senders = new Set(transfers.map((transfer) => transfer.fromId));
    expect(transfers.some((transfer) => senders.has(transfer.toId))).toBe(false);
  });

  it('bez nevyrovnaných nič', () => {
    expect(simplifyDebts([{ playerId: 'a', playerName: 'a', balance: 0 }])).toEqual([]);
  });
});
