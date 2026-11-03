import type { LedgerEntry, LedgerKind } from './types';

/**
 * Cashout stola — kto koľko vyhral, kto drží peniaze, kto ešte dlží a kto komu má poslať koľko, aby sa všetko vyrovnalo
 * čo najmenším počtom prevodov. Počíta sa rovnako na serveri (overenie platieb bankára) aj v klientovi (zobrazenie).
 *
 * Model (všetko v centoch):
 * - výsledok hráča = stack + výbery − vklady (len žetónové operácie),
 * - hotovosť: dobitie `paid` = hráč poslal peniaze bankárovi, výber `paid` = bankár vyplatil hráča hneď,
 *   `debt-paid` / `payout` / `handover` / `reversal` = peniaze prešli od `playerId` k `toId`,
 * - saldo = výsledok + odoslaná hotovosť − prijatá hotovosť (kladné = má dostať, záporné = má poslať).
 * Súčet sald je 0, pokiaľ nie sú žetóny mimo stackov (bežiace Prasiatko).
 */

const CHIP_KINDS: ReadonlySet<LedgerKind> = new Set<LedgerKind>(['buyin', 'credit', 'debit', 'leave']);

/** Žetónová operácia (mení stack) — na rozdiel od peňažných (platby v cashoute, odovzdanie banku). */
export function isChipEntry(entry: Pick<LedgerEntry, 'kind'>): boolean {
  return CHIP_KINDS.has(entry.kind);
}

/** Dobitie/výber, pri ktorom peniaze reálne prešli hneď (staršie záznamy bez bankára sa berú ako dlh). */
export function isPaidChipEntry(entry: LedgerEntry): boolean {
  return isChipEntry(entry) && entry.settlement === 'paid' && !!entry.bankerId;
}

/** ID platieb (`debt-paid`, `payout`), ktoré bankár neskôr zrušil. */
export function revertedIds(ledger: LedgerEntry[]): Set<number> {
  const ids = new Set<number>();
  for (const entry of ledger) {
    if (entry.kind === 'reversal' && entry.reverts !== undefined) {
      ids.add(entry.reverts);
    }
  }
  return ids;
}

export interface CashoutMember {
  playerId: string;
  playerName: string;
  /** Aktuálne žetóny (aj čakajúce); kto odišiel, má uložený stack, vyhodený 0. */
  stack: number;
}

export interface CashoutRow {
  playerId: string;
  playerName: string;
  stack: number;
  /** stack + výbery − vklady */
  result: number;
  /** Hotovosť, ktorú má z hry u seba (prijatá − odoslaná); kladná typicky u bankára. */
  holds: number;
  /**
   * Nezaplatené dobitia (súčet „na dlh“ mínus výbery „bank dlží“, splatenia bankárovi a výplaty, ktoré hráč z cashoutu
   * poslal) — presne to, čo vidno v histórii na jeho karte. Toto bankár „odmazáva“.
   */
  debt: number;
  /** Dlh je pokrytý žetónmi / výhrou — hráč nič neposiela, dlh sa len započíta vo vyrovnaní. */
  debtNetted: boolean;
  /** Kladné = má dostať, záporné = má poslať. */
  balance: number;
}

export interface CashoutTransfer {
  fromId: string;
  fromName: string;
  toId: string;
  toName: string;
  amount: number;
}

export interface Cashout {
  rows: CashoutRow[];
  transfers: CashoutTransfer[];
  /** Súčet sald — 0, ak sú všetky žetóny v stackoch; inak suma, ktorá je mimo nich (Prasiatko). */
  imbalance: number;
}

interface Accumulator {
  playerId: string;
  playerName: string;
  stack: number;
  deposited: number;
  withdrawn: number;
  cashIn: number;
  cashOut: number;
  owedChips: number;
  debtPaid: number;
  payoutsSent: number;
}

export function computeCashout(ledger: LedgerEntry[], members: CashoutMember[]): Cashout {
  const rows = new Map<string, Accumulator>();
  const row = (playerId: string, playerName: string): Accumulator => {
    let current = rows.get(playerId);
    if (!current) {
      current = { playerId, playerName, stack: 0, deposited: 0, withdrawn: 0, cashIn: 0, cashOut: 0, owedChips: 0, debtPaid: 0, payoutsSent: 0 };
      rows.set(playerId, current);
    }
    return current;
  };
  for (const member of members) {
    const current = row(member.playerId, member.playerName);
    current.playerName = member.playerName;
    current.stack = member.stack;
  }
  const reverted = revertedIds(ledger);
  const cash = (fromId: string, fromName: string, toId: string, toName: string, amount: number) => {
    row(fromId, fromName).cashOut += amount;
    row(toId, toName).cashIn += amount;
  };

  for (const entry of ledger) {
    if (isChipEntry(entry)) {
      const current = row(entry.playerId, entry.playerName);
      if (entry.amount > 0) {
        current.deposited += entry.amount;
      } else {
        current.withdrawn -= entry.amount;
      }
      if (isPaidChipEntry(entry)) {
        const bankerId = entry.bankerId!;
        const bankerName = entry.bankerName ?? '';
        if (entry.amount > 0) {
          cash(entry.playerId, entry.playerName, bankerId, bankerName, entry.amount);
        } else {
          cash(bankerId, bankerName, entry.playerId, entry.playerName, -entry.amount);
        }
      } else {
        current.owedChips += entry.amount;
      }
      continue;
    }
    if (!entry.toId || entry.amount <= 0) {
      continue;
    }
    cash(entry.playerId, entry.playerName, entry.toId, entry.toName ?? '', entry.amount);
    if (entry.kind === 'debt-paid' && !reverted.has(entry.id)) {
      row(entry.playerId, entry.playerName).debtPaid += entry.amount;
    }
    if (entry.kind === 'payout' && !reverted.has(entry.id)) {
      row(entry.playerId, entry.playerName).payoutsSent += entry.amount;
    }
  }

  const result: CashoutRow[] = [...rows.values()].map((current) => {
    const outcome = current.stack + current.withdrawn - current.deposited;
    const balance = outcome + current.cashOut - current.cashIn;
    const debt = Math.max(0, current.owedChips - current.debtPaid - current.payoutsSent);
    return {
      playerId: current.playerId,
      playerName: current.playerName,
      stack: current.stack,
      result: outcome,
      holds: current.cashIn - current.cashOut,
      debt,
      debtNetted: debt > 0 && balance >= 0,
      balance,
    };
  });
  result.sort((left, right) => right.balance - left.balance || byName(left, right));
  return { rows: result, transfers: simplifyDebts(result), imbalance: result.reduce((sum, current) => sum + current.balance, 0) };
}

function byName(left: { playerName: string; playerId: string }, right: { playerName: string; playerId: string }): number {
  return left.playerName.localeCompare(right.playerName, 'sk') || left.playerId.localeCompare(right.playerId);
}

/**
 * Zjednodušenie dlhov (ako v Splitwise): najväčší dlžník platí najväčšiemu veriteľovi, kým sa jeden z nich nevyrovná.
 * Výsledok má najviac (počet nevyrovnaných − 1) prevodov a nikto zároveň neposiela aj neprijíma.
 */
export function simplifyDebts(rows: Pick<CashoutRow, 'playerId' | 'playerName' | 'balance'>[]): CashoutTransfer[] {
  const creditors = rows.filter((current) => current.balance > 0).map((current) => ({ ...current, left: current.balance }));
  const debtors = rows.filter((current) => current.balance < 0).map((current) => ({ ...current, left: -current.balance }));
  creditors.sort((left, right) => right.left - left.left || byName(left, right));
  debtors.sort((left, right) => right.left - left.left || byName(left, right));
  const transfers: CashoutTransfer[] = [];
  let creditorIndex = 0;
  let debtorIndex = 0;
  while (creditorIndex < creditors.length && debtorIndex < debtors.length) {
    const creditor = creditors[creditorIndex];
    const debtor = debtors[debtorIndex];
    const amount = Math.min(creditor.left, debtor.left);
    transfers.push({ fromId: debtor.playerId, fromName: debtor.playerName, toId: creditor.playerId, toName: creditor.playerName, amount });
    creditor.left -= amount;
    debtor.left -= amount;
    if (creditor.left === 0) {
      creditorIndex++;
    }
    if (debtor.left === 0) {
      debtorIndex++;
    }
  }
  return transfers;
}
