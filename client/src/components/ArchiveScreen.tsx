import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ArchivedTableView } from '../../../shared/account';
import type { MyHandRecord } from '../../../shared/types';
import { formatMoney } from '../../../shared/money';
import { MyHandsContext } from '../myHands';
import { Cashout } from './Cashout';
import { HandHistory, Leaderboard, MyHandRow } from './Stats';
import { TransactionsTab, type TransactionsPlayer } from './TransactionsTab';
import '../sidePanel.css';

type ArchiveTab = 'leaderboard' | 'history' | 'ledger' | 'cashout' | 'mine';

const TABS: { key: ArchiveTab; label: string }[] = [
  { key: 'leaderboard', label: 'Leaderboard' },
  { key: 'history', label: 'História rúk' },
  { key: 'ledger', label: 'Transakcie' },
  { key: 'cashout', label: 'Vyúčtovanie' },
  { key: 'mine', label: 'Moje ruky' },
];

const MY_HANDS_PAGE = 20;
const dateFormat = new Intl.DateTimeFormat('sk-SK', { day: 'numeric', month: 'numeric', year: 'numeric' });
const timeFormat = new Intl.DateTimeFormat('sk-SK', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });

function signClass(value: number): string {
  return value > 0 ? 'ledger-pos' : value < 0 ? 'ledger-neg' : 'muted';
}

function handsLabel(count: number): string {
  if (count === 1) {
    return '1 ruka';
  }
  return count > 1 && count < 5 ? `${count} ruky` : `${count} rúk`;
}

interface ArchiveScreenProps {
  view: ArchivedTableView;
  /** Stôl je už v mojom účte — bez neho sa ukáže výzva na prevzatie. */
  claimed: boolean;
  onClaim?: () => void;
  claiming?: boolean;
  onClose: () => void;
}

/**
 * Historický stôl spred účtov len na čítanie: leaderboard, história rúk, transakcie, vyúčtovanie a moje ruky.
 * Používa tie isté zobrazenia ako živý stôl, len bez akcií (žiadny bankár, žiadne dôkazy miešania zo servera stola).
 */
export function ArchiveScreen({ view, claimed, onClaim, claiming = false, onClose }: ArchiveScreenProps) {
  const [tab, setTab] = useState<ArchiveTab>('leaderboard');
  const youId = view.myPlayerIds[0] ?? '';
  const myHistory = view.myHistory;
  // Moje ruky sú v archíve celé hneď — HandHistory si ich vezme z kontextu namiesto `history:mine` zo živého stola.
  const loadMyHands = useCallback(async (): Promise<MyHandRecord[]> => myHistory, [myHistory]);
  const players = useMemo<TransactionsPlayer[]>(
    () => view.leaderboard.map((row) => ({ id: row.playerId, name: row.playerName, avatar: row.avatar, stack: row.stack, present: row.present })),
    [view.leaderboard],
  );
  const myResult = view.leaderboard.filter((row) => view.myPlayerIds.includes(row.playerId)).reduce((sum, row) => sum + row.result, 0);
  const money = (cents: number, sign = false) => formatMoney(cents, view.currency, { sign });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <MyHandsContext.Provider value={loadMyHands}>
      <div className="archive-screen" role="dialog" aria-modal="true" aria-labelledby="archive-title">
        <div className="archive-inner">
          <header className="panel archive-head">
            <div className="archive-head-top">
              <div className="archive-title">
                <span className="archive-badge">Archív — len na čítanie</span>
                <h1 id="archive-title" title={view.name}>
                  {view.name}
                </h1>
                <span className="my-table-sub">
                  <span className="table-code-chip">{view.code}</span>
                  <span>
                    {dateFormat.format(view.createdAt)} – {dateFormat.format(view.lastActivity)}
                  </span>
                </span>
              </div>
              <button type="button" className="btn btn-secondary" onClick={onClose}>
                Zavrieť
              </button>
            </div>
            <dl className="my-table-facts archive-facts">
              <div>
                <dt>Odohrané</dt>
                <dd>{handsLabel(view.handNumber)}</dd>
              </div>
              <div>
                <dt>Hráči</dt>
                <dd>{view.leaderboard.length}</dd>
              </div>
              {view.myPlayerIds.length > 0 && (
                <div>
                  <dt>Môj výsledok</dt>
                  <dd className={`my-table-result ${signClass(myResult)}`}>{money(myResult, true)}</dd>
                </div>
              )}
            </dl>
          </header>

          {!claimed && (
            <div className="archive-claim" role="note">
              <p>
                Tento stôl je z čias pred účtami a vidíš ho len vďaka údajom v tomto prehliadači. Po prevzatí do účtu sa započíta do tvojich štatistík a uvidíš ho na všetkých svojich
                zariadeniach.
              </p>
              {onClaim && (
                <button type="button" className="btn btn-primary" disabled={claiming} onClick={onClaim}>
                  {claiming ? 'Preberám…' : 'Prevziať do účtu'}
                </button>
              )}
            </div>
          )}

          <section className="panel archive-body" aria-label="Výsledky stola">
            <div className="tabs archive-tabs" role="tablist" aria-label="Výsledky stola">
              {TABS.map((item) => (
                <button key={item.key} type="button" role="tab" aria-selected={tab === item.key} className={tab === item.key ? 'tab active' : 'tab'} onClick={() => setTab(item.key)}>
                  {item.label}
                </button>
              ))}
            </div>
            <div className="stats archive-content">
              {tab === 'leaderboard' && <Leaderboard rows={view.leaderboard} currency={view.currency} youId={youId} highlightIds={view.myPlayerIds} />}
              {tab === 'history' && <HandHistory history={view.history} currency={view.currency} />}
              {tab === 'ledger' && <TransactionsTab ledger={view.ledger} players={players} currency={view.currency} highlightIds={view.myPlayerIds} />}
              {tab === 'cashout' && <Cashout ledger={view.ledger} leaderboard={view.leaderboard} currency={view.currency} youId={youId} highlightIds={view.myPlayerIds} bankerId="" piggyAmount={0} />}
              {tab === 'mine' && <MyHands view={view} />}
            </div>
          </section>
        </div>
      </div>
    </MyHandsContext.Provider>
  );
}

/** Záložka „Moje ruky“: súčet a zoznam mojich rúk (najnovšie prvé) s kartami a výsledkom. */
function MyHands({ view }: { view: ArchivedTableView }) {
  const [limit, setLimit] = useState(MY_HANDS_PAGE);
  const newestFirst = useMemo(() => [...view.myHistory].sort((left, right) => right.handNumber - left.handNumber), [view.myHistory]);
  const playedAt = useMemo(() => new Map(view.history.map((entry) => [entry.handNumber, entry.at])), [view.history]);
  if (newestFirst.length === 0) {
    return <div className="muted empty-note">Pri tomto stole nemáš uložené žiadne vlastné ruky.</div>;
  }
  const total = newestFirst.reduce((sum, record) => sum + record.net, 0);
  const won = newestFirst.filter((record) => record.net > 0).length;
  const shown = newestFirst.slice(0, limit);
  return (
    <div className="history">
      <p className="archive-mine-summary">
        {handsLabel(newestFirst.length)} · {won} v pluse · spolu <strong className={signClass(total)}>{formatMoney(total, view.currency, { sign: true })}</strong>
      </p>
      <ol className="history-list">
        {shown.map((record) => {
          const at = playedAt.get(record.handNumber);
          return (
            <li key={record.handNumber} className="history-hand">
              <div className="history-head">
                <span className="history-number">#{record.handNumber}</span>
                {at !== undefined && (
                  <time className="history-time" dateTime={new Date(at).toISOString()}>
                    {timeFormat.format(at)}
                  </time>
                )}
              </div>
              <MyHandRow record={record} currency={view.currency} />
            </li>
          );
        })}
      </ol>
      {newestFirst.length > limit && (
        <button type="button" className="btn btn-ghost btn-block" onClick={() => setLimit(limit + MY_HANDS_PAGE)}>
          Zobraziť ďalšie ({Math.min(MY_HANDS_PAGE, newestFirst.length - limit)} z {newestFirst.length - limit})
        </button>
      )}
    </div>
  );
}
