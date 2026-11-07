import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Currency, HandHistoryEntry, LeaderboardRow, LedgerEntry, SeatPlayerView, TableEvent } from '../../../shared/types';
import { MAX_CHAT_LENGTH } from '../../../shared/constants';
import { AvatarInline } from './AvatarPicker';
import { Cashout } from './Cashout';
import { HistoryPanel, Leaderboard, type StatsCashout } from './Stats';
import { TransactionsTab } from './TransactionsTab';
import '../sidePanel.css';

/** Záložky bočného panela — jedna úroveň, bez podzáložiek. */
export type SideTab = 'chat' | 'log' | 'ledger' | 'leaderboard' | 'history' | 'cashout';

/** Leaderboard, história a cashout ako záložky panela pri stole; v čakárni sa nezobrazujú (sú priamo na stránke). */
export interface SideStats {
  history: HandHistoryEntry[];
  leaderboard: LeaderboardRow[];
  youId: string;
  /** Bez neho záložka Cashout chýba. */
  cashout?: StatsCashout;
  tableCode?: string;
}

interface SidePanelProps {
  events: TableEvent[];
  players: SeatPlayerView[];
  ledger: LedgerEntry[];
  currency: Currency;
  /** Pošle správu; vráti chybu servera (napr. „Pomalšie :)“) alebo null, keď prešla. */
  onSend: (text: string) => Promise<string | null> | void;
  onClose?: () => void;
  /** Aktívnu záložku drží rodič — podľa nej vie, či je chat na obrazovke (chat toasty). */
  tab: SideTab;
  onTabChange: (tab: SideTab) => void;
  stats?: SideStats;
}

export function SidePanel({ events, players, ledger, currency, onSend, onClose, tab: requestedTab, onTabChange: setTab, stats }: SidePanelProps) {
  // Záložka, ktorá tu práve nie je (štatistiky v čakárni, cashout bez bankára), spadne na najbližšiu dostupnú.
  const tab: SideTab = !stats && (requestedTab === 'leaderboard' || requestedTab === 'history' || requestedTab === 'cashout') ? 'chat' : requestedTab === 'cashout' && !stats?.cashout ? 'leaderboard' : requestedTab;
  const [text, setText] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const shown = events.filter((event) => (tab === 'chat' ? event.kind === 'chat' || event.kind === 'bounty' || event.kind === 'host' || event.kind === 'mode' : event.kind !== 'chat'));

  useEffect(() => {
    const list = listRef.current;
    if (list) {
      list.scrollTop = list.scrollHeight;
    }
  }, [shown.length, tab]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const message = text.trim();
    if (!message || sending) {
      return;
    }
    setSending(true);
    const error = await onSend(message);
    setSending(false);
    if (error) {
      // Text ostáva v poli — správa sa nestratí, hráč ju pošle znova.
      setSendError(error);
      return;
    }
    setSendError(null);
    setText((current) => (current.trim() === message ? '' : current));
  };

  const nameOf = (id?: string) => players.find((player) => player.id === id);
  const tabButton = (key: SideTab, label: string) => (
    <button type="button" className={tab === key ? 'tab active' : 'tab'} onClick={() => setTab(key)} aria-pressed={tab === key}>
      {label}
    </button>
  );

  return (
    <aside className="side-panel">
      <nav className="tabs side-tabs">
        <div className="side-tab-list">
          {tabButton('chat', 'Chat')}
          {tabButton('log', 'Priebeh')}
          {tabButton('ledger', 'Transakcie')}
          {stats && tabButton('leaderboard', 'Leaderboard')}
          {stats && tabButton('history', 'História')}
          {stats?.cashout && tabButton('cashout', 'Cashout')}
        </div>
        {onClose && (
          <button type="button" className="icon-btn tab-close" onClick={onClose} aria-label="Zavrieť">
            ✕
          </button>
        )}
      </nav>
      {stats && (tab === 'leaderboard' || tab === 'history' || tab === 'cashout') ? (
        <div className="side-scroll">
          <div className="stats">
            {tab === 'leaderboard' && <Leaderboard rows={stats.leaderboard} currency={currency} youId={stats.youId} />}
            {tab === 'history' && <HistoryPanel history={stats.history} currency={currency} youId={stats.youId} tableCode={stats.tableCode} />}
            {tab === 'cashout' && stats.cashout && <Cashout {...stats.cashout} leaderboard={stats.leaderboard} currency={currency} youId={stats.youId} />}
          </div>
        </div>
      ) : tab === 'ledger' ? (
        <TransactionsTab ledger={ledger} players={players} currency={currency} />
      ) : (
        <>
          <div className="event-list" ref={listRef}>
            {shown.length === 0 && <div className="muted empty-note">{tab === 'chat' ? 'Zatiaľ ticho… napíš niečo.' : 'Zatiaľ sa nič nestalo.'}</div>}
            {shown.map((event) => {
              const author = nameOf(event.playerId);
              if (event.kind === 'chat') {
                return (
                  <div key={event.id} className="chat-line">
                    <span className="chat-author" style={{ color: author?.avatar.color }}>
                      {author && <AvatarInline avatar={author.avatar} />} {author?.name ?? 'Hráč'}
                    </span>
                    <span className="chat-text">{event.text}</span>
                  </div>
                );
              }
              return (
                <div key={event.id} className={`log-line log-${event.kind}`}>
                  {event.text}
                </div>
              );
            })}
          </div>
          <form className="chat-form" onSubmit={submit}>
            <input
              value={text}
              maxLength={MAX_CHAT_LENGTH}
              placeholder="Napíš správu…"
              aria-invalid={!!sendError || undefined}
              onChange={(event) => {
                setText(event.target.value);
                setSendError(null);
              }}
            />
            <button className="btn btn-secondary" disabled={!text.trim() || sending}>
              Poslať
            </button>
            {sendError && (
              <div className="chat-send-error" role="alert">
                {sendError} — správa ostala v poli, skús ju poslať znova
              </div>
            )}
          </form>
        </>
      )}
    </aside>
  );
}
