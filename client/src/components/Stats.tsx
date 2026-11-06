import { useMemo, useState } from 'react';
import type { Currency, HandHistoryEntry, LeaderboardRow, MyHandRecord, Variant } from '../../../shared/types';
import { formatMoney } from '../../../shared/money';
import { useMyHands } from '../myHands';
import { Cashout, type CashoutProps } from './Cashout';
import { FairnessBox } from './FairnessBox';
import { PlayingCard } from './PlayingCard';
import '../sidePanel.css';

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

/**
 * Výsledky stola na stránke čakárne — jedna úroveň záložiek (rovnaké ako v bočnom paneli pri stole).
 * Pri stole sa Leaderboard / História / Cashout ukazujú priamo ako záložky bočného panela (`SidePanel`).
 */
export function Stats({ history, leaderboard, currency, youId, tab: requestedTab, onTabChange, cashout, tableCode }: StatsProps) {
  const tab = requestedTab === 'cashout' && !cashout ? 'leaderboard' : requestedTab;
  const tabButton = (key: StatsTab, label: string) => (
    <button type="button" role="tab" aria-selected={tab === key} className={tab === key ? 'tab active' : 'tab'} onClick={() => onTabChange(key)}>
      {label}
    </button>
  );
  return (
    <div className="stats">
      <div className="tabs stats-tabs" role="tablist" aria-label="Výsledky stola">
        {tabButton('leaderboard', 'Leaderboard')}
        {tabButton('history', 'História')}
        {cashout && tabButton('cashout', 'Cashout')}
      </div>
      {tab === 'leaderboard' && <Leaderboard rows={leaderboard} currency={currency} youId={youId} />}
      {tab === 'history' && <HistoryPanel history={history} currency={currency} youId={youId} tableCode={tableCode} />}
      {tab === 'cashout' && cashout && <Cashout {...cashout} leaderboard={leaderboard} currency={currency} youId={youId} />}
    </div>
  );
}

/** Záložka História: dôkazy overiteľného miešania + odohrané ruky (aj s mojimi kartami a výsledkom). */
export function HistoryPanel({ history, currency, youId, tableCode }: { history: HandHistoryEntry[]; currency: Currency; youId: string; tableCode?: string }) {
  return (
    <>
      {tableCode && <FairnessBox tableCode={tableCode} youId={youId} />}
      <HandHistory history={history} currency={currency} />
    </>
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
  const myHands = useMyHands(history.length > 0 ? history[history.length - 1].handNumber : null);
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
            <MyHandRow record={myHands.get(entry.handNumber)} currency={currency} />
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
            {entry.piggy?.winners.map((winner) => (
              <div key={winner.playerId} className="history-piggy-line">
                🐷 Prasiatko: {winner.playerName} <span className="ledger-pos">+{money(winner.amount)}</span>
              </div>
            ))}
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

/** Moje karty a môj výsledok v ruke (len z `history:mine` — cudzie skryté karty sa sem nikdy nedostanú). */
function MyHandRow({ record, currency }: { record: MyHandRecord | undefined; currency: Currency }) {
  if (!record) {
    return null;
  }
  return (
    <div className={record.folded ? 'history-mine history-mine-folded' : 'history-mine'} aria-label="Moja ruka">
      <span className="history-mine-label">Ty</span>
      {record.cards.length > 0 && (
        <span className="history-winner-cards">
          {record.cards.map((card, index) => (
            <PlayingCard key={`${card}-${index}`} card={card} size="sm" dimmed={record.folded} />
          ))}
        </span>
      )}
      {record.folded && <span className="history-mine-fold">fold</span>}
      {(!record.folded || record.net !== 0) && <strong className={`history-mine-net ${signClass(record.net)}`}>{formatMoney(record.net, currency, { sign: true })}</strong>}
      {record.handDescription && <span className="muted history-mine-desc">{record.handDescription}</span>}
    </div>
  );
}
