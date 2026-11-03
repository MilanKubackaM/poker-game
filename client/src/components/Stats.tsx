import { useMemo, useState } from 'react';
import type { Currency, HandHistoryEntry, LeaderboardRow, Variant } from '../../../shared/types';
import { formatMoney } from '../../../shared/money';
import { Cashout, type CashoutProps } from './Cashout';
import { FairnessBox } from './FairnessBox';
import { PlayingCard } from './PlayingCard';

export type StatsTab = 'leaderboard' | 'history' | 'cashout';

/** Cashout potrebuje navyše transakcie, bankára a (pre bankára) jeho akcie. */
export type StatsCashout = Omit<CashoutProps, 'leaderboard' | 'currency' | 'youId'>;

const HISTORY_PAGE = 20;
const VARIANT_SHORT: Record<Variant, string> = { holdem: "Hold'em", omaha: 'Omaha', pineapple: 'Pineapple' };
const timeFormat = new Intl.DateTimeFormat('sk-SK', { hour: '2-digit', minute: '2-digit' });
const dayFormat = new Intl.DateTimeFormat('sk-SK', { day: 'numeric', month: 'numeric' });

function signClass(value: number): string {
  return value > 0 ? 'ledger-pos' : value < 0 ? 'ledger-neg' : 'muted';
}

/** Čas ruky; staršie ako dnešný deň aj s dátumom. */
function handTime(at: number): string {
  const date = new Date(at);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return sameDay ? timeFormat.format(date) : `${dayFormat.format(date)} ${timeFormat.format(date)}`;
}

interface StatsProps {
  history: HandHistoryEntry[];
  leaderboard: LeaderboardRow[];
  currency: Currency;
  youId: string;
  tab: StatsTab;
  onTabChange: (tab: StatsTab) => void;
  cashout?: StatsCashout;
  /** Kód stola — pri histórii sa ukáže stiahnutie dôkazov overiteľného miešania. */
  tableCode?: string;
}

/** Leaderboard, história rúk a cashout pod jedným prepínačom — v čakárni aj v bočnom paneli počas hry. */
export function Stats({ history, leaderboard, currency, youId, tab: requestedTab, onTabChange, cashout, tableCode }: StatsProps) {
  const tab = requestedTab === 'cashout' && !cashout ? 'leaderboard' : requestedTab;
  return (
    <div className="stats">
      <div className="segmented" role="tablist" aria-label="Štatistiky stola">
        <button type="button" role="tab" aria-selected={tab === 'leaderboard'} className={tab === 'leaderboard' ? 'segment active' : 'segment'} onClick={() => onTabChange('leaderboard')}>
          🏆 Leaderboard
        </button>
        <button type="button" role="tab" aria-selected={tab === 'history'} className={tab === 'history' ? 'segment active' : 'segment'} onClick={() => onTabChange('history')}>
          🕘 História <span className="segment-count">{history.length}</span>
        </button>
        {cashout && (
          <button type="button" role="tab" aria-selected={tab === 'cashout'} className={tab === 'cashout' ? 'segment active' : 'segment'} onClick={() => onTabChange('cashout')}>
            💸 Cashout
          </button>
        )}
      </div>
      {tab === 'leaderboard' && <Leaderboard rows={leaderboard} currency={currency} youId={youId} />}
      {tab === 'history' && (
        <>
          {tableCode && <FairnessBox tableCode={tableCode} youId={youId} />}
          <HandHistory history={history} currency={currency} />
        </>
      )}
      {tab === 'cashout' && cashout && <Cashout {...cashout} leaderboard={leaderboard} currency={currency} youId={youId} />}
    </div>
  );
}

export function Leaderboard({ rows, currency, youId }: { rows: LeaderboardRow[]; currency: Currency; youId: string }) {
  const money = (cents: number, sign = false) => formatMoney(cents, currency, { sign });
  if (rows.length === 0) {
    return <div className="muted empty-note">Leaderboard sa naplní, keď si hráči prisadnú.</div>;
  }
  return (
    <>
      <div className="table-scroll">
        <table className="ledger-table leaderboard-table">
          <thead>
            <tr>
              <th scope="col" className="lb-rank">#</th>
              <th scope="col" className="lb-player">Hráč</th>
              <th scope="col">Výsledok</th>
              <th scope="col">Stack</th>
              <th scope="col">Vklady</th>
              <th scope="col">Výbery</th>
              <th scope="col" title="Odohrané / vyhrané ruky">Ruky</th>
              <th scope="col">Najväčší pot</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => {
              const classes = [row.present ? '' : 'lb-left', row.playerId === youId ? 'lb-me' : ''].filter(Boolean).join(' ');
              return (
                <tr key={row.playerId} className={classes || undefined}>
                  <td className="lb-rank">{index + 1}</td>
                  <th scope="row" className="lb-player">
                    <span className="lb-player-inner">
                      <span className="lb-avatar" style={{ background: row.avatar.color }} aria-hidden>
                        {row.avatar.emoji}
                      </span>
                      <span className="lb-name">{row.playerName}</span>
                      {!row.present && (
                        <span className="lb-gone" title="Nesedí pri stole — žetóny mu ostávajú uložené, kým sa nevráti">
                          mimo stola
                        </span>
                      )}
                    </span>
                  </th>
                  <td className={`ledger-result ${signClass(row.result)}`}>{money(row.result, true)}</td>
                  <td className={row.present ? undefined : 'lb-kept'}>{row.present || row.stack > 0 ? money(row.stack) : '—'}</td>
                  <td>{money(row.deposited)}</td>
                  <td>{money(row.withdrawn)}</td>
                  <td>
                    {row.handsPlayed} / <strong>{row.handsWon}</strong>
                  </td>
                  <td>{row.biggestPot > 0 ? money(row.biggestPot) : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function HandHistory({ history, currency }: { history: HandHistoryEntry[]; currency: Currency }) {
  const [limit, setLimit] = useState(HISTORY_PAGE);
  const newestFirst = useMemo(() => [...history].reverse(), [history]);
  const money = (cents: number) => formatMoney(cents, currency);
  if (history.length === 0) {
    return <div className="muted empty-note">Zatiaľ sa neodohrala žiadna ruka.</div>;
  }
  const shown = newestFirst.slice(0, limit);
  return (
    <div className="history">
      <ol className="history-list">
        {shown.map((entry) => (
          <li key={`${entry.handNumber}-${entry.at}`} className={entry.bounty ? 'history-hand history-bounty' : 'history-hand'}>
            <div className="history-head">
              <span className="history-number">#{entry.handNumber}</span>
              <time className="history-time" dateTime={new Date(entry.at).toISOString()}>
                {handTime(entry.at)}
              </time>
              <span className={entry.variant === 'holdem' ? 'variant-badge' : 'variant-badge special'}>{VARIANT_SHORT[entry.variant]}</span>
              {entry.sevenDeuce && <span className="variant-badge seven">7-2</span>}
              <span className="history-pot">Pot {money(entry.totalPot)}</span>
            </div>
            <div className="history-meta">
              {entry.dealerName && <span>Dealer: {entry.dealerName}</span>}
              {entry.wonWithoutShowdown && <span>bez showdownu</span>}
            </div>
            {entry.board.length > 0 && (
              <div className="history-board" aria-label="Karty na stole">
                {entry.board.map((card) => (
                  <PlayingCard key={card} card={card} size="sm" />
                ))}
              </div>
            )}
            {entry.extraBoards?.map((board, run) => (
              <div key={run} className="history-board" aria-label={`${run + 2}. beh`}>
                <span className="muted">{run + 2}. beh</span>
                {board.map((card) => (
                  <PlayingCard key={card} card={card} size="sm" />
                ))}
              </div>
            ))}
            <ul className="history-winners">
              {entry.winners.map((winner) => (
                <li key={winner.playerId} className="history-winner">
                  <span className="history-winner-line">
                    <span className="history-trophy" aria-hidden>
                      🏆
                    </span>
                    <strong className="history-winner-name">{winner.playerName}</strong>
                    <span className="ledger-pos history-winner-amount">+{money(winner.amount)}</span>
                  </span>
                  {(winner.handDescription || winner.cards.length > 0) && (
                    <span className="history-winner-hand">
                      {winner.cards.length > 0 && (
                        <span className="history-winner-cards">
                          {winner.cards.map((card) => (
                            <PlayingCard key={card} card={card} size="sm" />
                          ))}
                        </span>
                      )}
                      {winner.handDescription && <span className="muted">{winner.handDescription}</span>}
                    </span>
                  )}
                </li>
              ))}
              {entry.winners.length === 0 && <li className="muted">Ruka bola zrušená</li>}
            </ul>
            {entry.bounty && (
              <div className="history-bounty-line">
                7-2! {entry.bounty.winnerName} inkasuje bonus {money(entry.bounty.total)}
              </div>
            )}
          </li>
        ))}
      </ol>
      {newestFirst.length > limit && (
        <button type="button" className="btn btn-ghost btn-block" onClick={() => setLimit(limit + HISTORY_PAGE)}>
          Zobraziť ďalšie ({Math.min(HISTORY_PAGE, newestFirst.length - limit)} z {newestFirst.length - limit})
        </button>
      )}
    </div>
  );
}
