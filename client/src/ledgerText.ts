import type { Currency, LedgerEntry } from '../../shared/types';
import { formatMoney } from '../../shared/money';
import { isChipEntry, isPaidChipEntry } from '../../shared/settlement';

/** Krátky popis, ako sa vyrovnala žetónová operácia: „zaplatené bankárovi Milan“, „na dlh“, „vyplatené“, „bank dlží“. */
export function settlementText(entry: LedgerEntry): string {
  const paid = isPaidChipEntry(entry);
  if (entry.amount > 0) {
    if (paid && entry.bankerId === entry.playerId) {
      return 'vlastné peniaze bankára';
    }
    return paid ? `zaplatené bankárovi ${entry.bankerName ?? ''}`.trim() : 'na dlh';
  }
  if (entry.kind === 'leave') {
    return paid ? 'vyhodenie · vyplatené' : 'vyhodenie · bank dlží';
  }
  return paid ? `vyplatil bankár ${entry.bankerName ?? ''}`.trim() : 'bank dlží';
}

/** Riadok histórie z pohľadu jedného hráča (karta hráča) — suma so znamienkom a popis. */
export function playerEntryText(entry: LedgerEntry, playerId: string, currency: Currency): { amount: string; text: string; tone: 'pos' | 'neg' | 'cash' } {
  const money = (cents: number, sign = false) => formatMoney(cents, currency, { sign });
  if (isChipEntry(entry)) {
    return { amount: money(entry.amount, true), text: settlementText(entry), tone: entry.amount > 0 ? 'pos' : 'neg' };
  }
  const outgoing = entry.playerId === playerId;
  const other = outgoing ? entry.toName ?? '' : entry.playerName;
  const amount = money(entry.amount);
  switch (entry.kind) {
    case 'debt-paid':
      return outgoing ? { amount, text: `dlh splatený bankárovi ${other}`, tone: 'cash' } : { amount, text: `prijal splatený dlh od ${other}`, tone: 'cash' };
    case 'payout':
      return outgoing ? { amount, text: `poslal → ${other}`, tone: 'cash' } : { amount, text: `dostal od ${other}`, tone: 'cash' };
    case 'handover':
      return outgoing ? { amount, text: `odovzdal bank → ${other}`, tone: 'cash' } : { amount, text: `prevzal bank od ${other}`, tone: 'cash' };
    default:
      return { amount, text: outgoing ? `zrušená platba (vrátil ${other})` : `zrušená platba (dostal späť od ${other})`, tone: 'cash' };
  }
}

/** Patrí operácia hráčovi (žetóny jemu, alebo peniaze od neho / k nemu)? */
export function involvesPlayer(entry: LedgerEntry, playerId: string): boolean {
  return entry.playerId === playerId || entry.toId === playerId;
}
