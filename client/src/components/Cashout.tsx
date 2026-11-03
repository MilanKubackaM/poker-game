import { useMemo, useState } from 'react';
import type { Currency, LeaderboardRow, LedgerEntry } from '../../../shared/types';
import { formatMoney } from '../../../shared/money';
import { computeCashout, revertedIds } from '../../../shared/settlement';
import type { BankActions } from './HostPanel';

const CASH_KINDS = new Set<LedgerEntry['kind']>(['debt-paid', 'payout', 'handover']);
const timeFormat = new Intl.DateTimeFormat('sk-SK', { hour: '2-digit', minute: '2-digit' });

export interface CashoutProps {
  ledger: LedgerEntry[];
  leaderboard: LeaderboardRow[];
  currency: Currency;
  youId: string;
  bankerId: string;
  /** Len pre bankára — ostatní cashout iba vidia. */
  bank?: BankActions;
  /** Žetóny v bežiacom Prasiatku (mimo stackov) — kým tam sú, cashout nesedí do nuly. */
  piggyAmount: number;
}

/**
 * Cashout ako v Splitwise: kto vyhral/prehral, kto drží peniaze, kto ešte dlží a čo najmenej prevodov, ktorými sa všetci
 * vyrovnajú. Bankár odkliká splatené dlhy a prebehnuté prevody (omyl vráti „Zrušiť“).
 */
export function Cashout({ ledger, leaderboard, currency, youId, bankerId, bank, piggyAmount }: CashoutProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const money = (cents: number, sign = false) => formatMoney(cents, currency, { sign });
  const cashout = useMemo(
    () => computeCashout(ledger, leaderboard.map((row) => ({ playerId: row.playerId, playerName: row.playerName, stack: row.stack }))),
    [ledger, leaderboard],
  );
  const reverted = useMemo(() => revertedIds(ledger), [ledger]);
  const payments = useMemo(() => ledger.filter((entry) => CASH_KINDS.has(entry.kind)).reverse(), [ledger]);
  const avatarOf = (playerId: string) => leaderboard.find((row) => row.playerId === playerId)?.avatar ?? null;
  const debtors = cashout.rows.filter((row) => row.debt > 0);
  const active = cashout.rows.filter((row) => row.result !== 0 || row.balance !== 0 || row.holds !== 0 || row.stack !== 0);
  const piggyBlocks = piggyAmount > 0;

  const run = async (key: string, action: () => Promise<string | null>) => {
    if (busy) {
      return;
    }
    setBusy(key);
    setError(null);
    const failure = await action();
    setBusy(null);
    setError(failure);
  };

  const name = (playerId: string, fallback: string) => {
    const avatar = avatarOf(playerId);
    return (
      <span className="cashout-name">
        {avatar && (
          <span className="lb-avatar" style={{ background: avatar.color }} aria-hidden>
            {avatar.emoji}
          </span>
        )}
        <span>{fallback}</span>
        {playerId === youId && <span className="room-you">ty</span>}
        {playerId === bankerId && (
          <span className="banker-badge" title="Bankár">
            🏦
          </span>
        )}
      </span>
    );
  };

  if (ledger.length === 0) {
    return <div className="muted empty-note">Cashout sa naplní, keď bankár dobije prvé žetóny.</div>;
  }

  return (
    <div className="cashout">
      {piggyBlocks && (
        <p className="cashout-warning" role="status">
          🐷 Mimo stackov je {money(piggyAmount)} (Prasiatko alebo ante z odkrytia boardu) — kým sa nerozohrá, cashout nesedí do nuly a výplaty sa nedajú potvrdiť.
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <section className="cashout-section" aria-label="Kto komu pošle">
        <h3 className="ledger-heading">💸 Kto komu pošle</h3>
        {cashout.transfers.length === 0 ? (
          <p className="cashout-done">✓ Všetko je vyrovnané</p>
        ) : (
          <ul className="cashout-transfers">
            {cashout.transfers.map((transfer) => {
              const key = `payout:${transfer.fromId}:${transfer.toId}`;
              return (
                <li key={key} className="cashout-transfer">
                  <span className="cashout-route">
                    {name(transfer.fromId, transfer.fromName)}
                    <span className="cashout-arrow" aria-label="pošle">
                      →
                    </span>
                    {name(transfer.toId, transfer.toName)}
                  </span>
                  <strong className="cashout-amount">{money(transfer.amount)}</strong>
                  {bank && (
                    <button
                      type="button"
                      className="btn btn-chip chip-add"
                      disabled={!!busy || piggyBlocks}
                      title={piggyBlocks ? 'Najprv dohrajte Prasiatko alebo ruku s ante' : 'Peniaze prišli — označiť ako zaplatené'}
                      onClick={() => void run(key, () => bank.settle('payout', transfer.fromId, transfer.toId, transfer.amount))}
                    >
                      {busy === key ? '…' : '✓ Zaplatené'}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {debtors.length > 0 && (
        <section className="cashout-section" aria-label="Dlžnosti">
          <h3 className="ledger-heading">📝 Dlžnosti</h3>
          <ul className="cashout-transfers">
            {debtors.map((row) => {
              const key = `debt:${row.playerId}`;
              const canClear = !!bank && row.playerId !== bankerId;
              return (
                <li key={key} className="cashout-transfer">
                  <span className="cashout-route">
                    {name(row.playerId, row.playerName)}
                    <span className="muted">{row.debtNetted ? 'dlží za dobitie · započíta sa do vyrovnania' : 'dlží za dobitie'}</span>
                  </span>
                  <strong className="cashout-amount ledger-neg">{money(row.debt)}</strong>
                  {canClear && (
                    <button
                      type="button"
                      className="btn btn-chip"
                      disabled={!!busy}
                      title="Hráč ti dlh zaplatil — odmazať"
                      onClick={() => void run(key, () => bank.settle('debt', row.playerId, bankerId, row.debt))}
                    >
                      {busy === key ? '…' : '✓ Splatil bankárovi'}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section className="cashout-section" aria-label="Prehľad">
        <h3 className="ledger-heading">Prehľad</h3>
        <div className="table-scroll">
          <table className="ledger-table cashout-table">
            <thead>
              <tr>
                <th scope="col">Hráč</th>
                <th scope="col">Výsledok</th>
                <th scope="col" title="Hotovosť z hry, ktorú má u seba (typicky bankár)">
                  Drží
                </th>
                <th scope="col">Dlh</th>
                <th scope="col">Vyrovnanie</th>
              </tr>
            </thead>
            <tbody>
              {active.map((row) => (
                <tr key={row.playerId} className={row.playerId === youId ? 'lb-me' : undefined}>
                  <th scope="row" className="ledger-name">
                    {name(row.playerId, row.playerName)}
                  </th>
                  <td className={`ledger-result ${row.result > 0 ? 'ledger-pos' : row.result < 0 ? 'ledger-neg' : 'muted'}`}>{money(row.result, true)}</td>
                  <td>{row.holds > 0 ? money(row.holds) : '—'}</td>
                  <td className={row.debt > 0 ? 'ledger-neg' : 'muted'} title={row.debtNetted ? 'Dlh pokrývajú hráčove žetóny — vo vyrovnaní je už odpočítaný' : undefined}>
                    {row.debt > 0 ? money(row.debt) : '—'}
                    {row.debtNetted && <span className="cashout-netted"> započítaný</span>}
                  </td>
                  <td className={row.balance > 0 ? 'ledger-pos' : row.balance < 0 ? 'ledger-neg' : 'muted'}>
                    {row.balance > 0 ? `dostane ${money(row.balance)}` : row.balance < 0 ? `pošle ${money(-row.balance)}` : '✓ vyrovnaný'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {payments.length > 0 && (
        <section className="cashout-section" aria-label="Potvrdené platby">
          <h3 className="ledger-heading">Potvrdené platby</h3>
          <ol className="ledger-entries">
            {payments.map((entry) => {
              const isReverted = reverted.has(entry.id);
              const key = `undo:${entry.id}`;
              const label = entry.kind === 'debt-paid' ? 'splatený dlh' : entry.kind === 'handover' ? 'odovzdanie banku' : 'výplata';
              return (
                <li key={entry.id} className={isReverted ? 'ledger-entry cashout-reverted' : 'ledger-entry'}>
                  <div className="ledger-entry-head">
                    <time className="ledger-time" dateTime={new Date(entry.at).toISOString()}>
                      {timeFormat.format(entry.at)}
                    </time>
                    <span className="ledger-entry-player">
                      {entry.playerName} → {entry.toName}
                    </span>
                    <span className="ledger-amount">{money(entry.amount)}</span>
                  </div>
                  <div className="ledger-entry-meta">
                    <span className="ledger-kind">{label}</span>
                    {isReverted && <span className="ledger-deferred">zrušené</span>}
                    {entry.byName && <span>zadal {entry.byName}</span>}
                    {bank && !isReverted && entry.kind !== 'handover' && (
                      <button type="button" className="btn btn-ghost btn-small" disabled={!!busy} onClick={() => void run(key, () => bank.undo(entry.id))}>
                        {busy === key ? '…' : 'Zrušiť'}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
      )}
    </div>
  );
}
