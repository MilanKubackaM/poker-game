import type { Avatar, Currency, LedgerEntry, LedgerKind, SeatPlayerView } from '../../../shared/types';
import { formatMoney } from '../../../shared/money';
import { isChipEntry, revertedIds } from '../../../shared/settlement';
import { settlementText } from '../ledgerText';

const KIND_LABELS: Record<LedgerKind, string> = {
  buyin: 'Štartovací vklad',
  credit: 'Dobitie',
  debit: 'Výber',
  leave: 'Odchod',
  'debt-paid': 'Splatený dlh',
  payout: 'Výplata z cashoutu',
  handover: 'Odovzdanie banku',
  reversal: 'Zrušená platba',
};

interface PlayerSummary {
  playerId: string;
  name: string;
  avatar: Avatar | null;
  present: boolean;
  deposits: number;
  withdrawals: number;
  current: number;
  result: number;
}

function summarize(ledger: LedgerEntry[], players: SeatPlayerView[]): PlayerSummary[] {
  const rows = new Map<string, PlayerSummary>();
  for (const player of [...players].sort((left, right) => left.seat - right.seat)) {
    rows.set(player.id, { playerId: player.id, name: player.name, avatar: player.avatar, present: true, deposits: 0, withdrawals: 0, current: player.stack, result: 0 });
  }
  for (const entry of ledger) {
    if (!isChipEntry(entry)) {
      continue;
    }
    let row = rows.get(entry.playerId);
    if (!row) {
      row = { playerId: entry.playerId, name: entry.playerName, avatar: null, present: false, deposits: 0, withdrawals: 0, current: 0, result: 0 };
      rows.set(entry.playerId, row);
    }
    if (entry.amount > 0) {
      row.deposits += entry.amount;
    } else {
      row.withdrawals -= entry.amount;
    }
  }
  return [...rows.values()].map((row) => ({ ...row, result: row.current + row.withdrawals - row.deposits }));
}

function signClass(value: number): string {
  return value > 0 ? 'ledger-pos' : value < 0 ? 'ledger-neg' : 'muted';
}

const timeFormat = new Intl.DateTimeFormat('sk-SK', { hour: '2-digit', minute: '2-digit' });

interface TransactionsTabProps {
  ledger: LedgerEntry[];
  players: SeatPlayerView[];
  currency: Currency;
}

export function TransactionsTab({ ledger, players, currency }: TransactionsTabProps) {
  const money = (cents: number, sign = false) => formatMoney(cents, currency, { sign });
  const summary = summarize(ledger, players);
  const avatarOf = (playerId: string) => players.find((player) => player.id === playerId)?.avatar ?? null;
  const reverted = revertedIds(ledger);

  return (
    <div className="ledger">
      <section className="ledger-section">
        <h3 className="ledger-heading">Súhrn hráčov</h3>
        <table className="ledger-table">
          <thead>
            <tr>
              <th scope="col">Hráč</th>
              <th scope="col">Vklady</th>
              <th scope="col">Výbery</th>
              <th scope="col">Aktuálne</th>
              <th scope="col">Výsledok</th>
            </tr>
          </thead>
          <tbody>
            {summary.map((row) => (
              <tr key={row.playerId} className={row.present ? undefined : 'ledger-left'}>
                <th scope="row" className="ledger-name" title={row.present ? row.name : `${row.name} (odišiel)`}>
                  <span className="ledger-name-text">
                    {row.avatar?.emoji ?? '🚪'} {row.name}
                  </span>
                </th>
                <td>{money(row.deposits)}</td>
                <td>{money(row.withdrawals)}</td>
                <td>{money(row.current)}</td>
                <td className={`ledger-result ${signClass(row.result)}`}>{money(row.result, true)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="ledger-section">
        <h3 className="ledger-heading">Pohyby</h3>
        {ledger.length === 0 && <div className="muted empty-note">Zatiaľ žiadne transakcie.</div>}
        <ol className="ledger-entries">
          {ledger.map((entry) => {
            const avatar = avatarOf(entry.playerId);
            const chip = isChipEntry(entry);
            return (
              <li key={entry.id} className={reverted.has(entry.id) ? 'ledger-entry cashout-reverted' : 'ledger-entry'}>
                <div className="ledger-entry-head">
                  <time className="ledger-time" dateTime={new Date(entry.at).toISOString()}>
                    {timeFormat.format(entry.at)}
                  </time>
                  <span className="ledger-entry-player">
                    {avatar?.emoji ?? '🚪'} {entry.playerName}
                    {!chip && ` → ${entry.toName ?? ''}`}
                  </span>
                  <span className={chip ? `ledger-amount ${signClass(entry.amount)}` : 'ledger-amount'}>{chip ? money(entry.amount, true) : money(entry.amount)}</span>
                </div>
                <div className="ledger-entry-meta">
                  <span className="ledger-kind">{KIND_LABELS[entry.kind]}</span>
                  {chip && <span className="ledger-settlement">{settlementText(entry)}</span>}
                  {reverted.has(entry.id) && <span className="ledger-deferred">zrušené</span>}
                  {entry.deferred && <span className="ledger-deferred">po ruke</span>}
                  {entry.stackAfter !== null && <span>zostatok {money(entry.stackAfter)}</span>}
                  {entry.byName && <span>zadal {entry.byName}</span>}
                </div>
                {entry.note && <div className="ledger-note">„{entry.note}“</div>}
              </li>
            );
          })}
        </ol>
      </section>
    </div>
  );
}
