import { useState } from 'react';
import type { Currency, LedgerEntry } from '../../../shared/types';
import { formatMoney } from '../../../shared/money';
import { revertedIds } from '../../../shared/settlement';
import { involvesPlayer, playerEntryText } from '../ledgerText';

const SHOWN = 4;

interface PlayerMoneyHistoryProps {
  ledger: LedgerEntry[];
  playerId: string;
  currency: Currency;
  /** Nesplatený dlh z cashoutu (0 = nič nedlží). */
  debt: number;
}

/** Verejná história peňazí na karte hráča: „+20 € · zaplatené bankárovi“, „+20 € · na dlh“, platby v cashoute. */
export function PlayerMoneyHistory({ ledger, playerId, currency, debt }: PlayerMoneyHistoryProps) {
  const [expanded, setExpanded] = useState(false);
  const entries = ledger.filter((entry) => involvesPlayer(entry, playerId)).reverse();
  if (entries.length === 0) {
    return null;
  }
  const reverted = revertedIds(ledger);
  const shown = expanded ? entries : entries.slice(0, SHOWN);
  return (
    <div className="money-history">
      {debt > 0 && <div className="money-history-debt">Dlží {formatMoney(debt, currency)}</div>}
      <ul className="money-history-list" aria-label="História peňazí">
        {shown.map((entry) => {
          const { amount, text, tone } = playerEntryText(entry, playerId, currency);
          return (
            <li key={entry.id} className={reverted.has(entry.id) ? 'money-history-item reverted' : 'money-history-item'}>
              <span className={tone === 'pos' ? 'ledger-pos' : tone === 'neg' ? 'ledger-neg' : 'money-history-cash'}>{amount}</span>
              <span className="money-history-text">{text}</span>
            </li>
          );
        })}
      </ul>
      {entries.length > SHOWN && (
        <button type="button" className="btn btn-ghost btn-small money-history-more" onClick={() => setExpanded(!expanded)}>
          {expanded ? 'Menej' : `Všetky (${entries.length})`}
        </button>
      )}
    </div>
  );
}
