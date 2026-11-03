import { useState } from 'react';
import type { DealerChoice, NextHandOverride, Settlement, TableSettings, TableView, Variant } from '../../../shared/types';
import { MAX_SPECIAL_HANDS } from '../../../shared/constants';
import { formatMoney } from '../../../shared/money';
import { handsLabel } from '../../../shared/plural';
import { isAdmin, isOwner } from '../roles';
import { HostPlayersList } from './HostPlayers';
import { RulesForm } from './HostRules';

export interface HostActions {
  start: () => void;
  pause: () => void;
  dealerChoice: (mode: DealerChoice) => void;
  saveSettings: (settings: Partial<TableSettings>) => Promise<string | null>;
  nextHand: (override: NextHandOverride | null) => void;
  kick: (playerId: string) => void;
  /** Pridelí rolu bankára; keď doterajší bankár drží peniaze, opýta sa, či ich odovzdá. */
  setBanker: (playerId: string) => void;
  setAdmin: (playerId: string, admin: boolean) => void;
  /** Mód Prasiatko: spustiť / zrušiť (pri zrušení sa vstupy vrátia). */
  piggy: (action: 'start' | 'cancel') => void;
  toLobby: () => void;
  /** Len zakladateľ: zmaže stôl po zadaní jeho kódu; vráti chybu servera alebo null. */
  deleteTable: (code: string) => Promise<string | null>;
  /** Pustí ku stolu (`true`) alebo zamietne čakajúcu žiadosť o prístup. */
  resolveJoin: (requestId: string, approve: boolean) => void;
}

/** Akcie bankára — server ich prijme len od aktuálneho bankára. Všetky vrátia chybu servera alebo null. */
export interface BankActions {
  /** Dobije (kladná suma) alebo vyberie (záporná) žetóny; `paid` = peniaze prešli hneď, `owed` = vyrovná sa v cashoute. */
  chips: (playerId: string, amount: number, settlement: Settlement, note: string) => Promise<string | null>;
  /** `debt` = hráč splatil dlh bankárovi, `payout` = prevod z cashoutu prebehol. */
  settle: (kind: 'debt' | 'payout', fromId: string, toId: string, amount: number) => Promise<string | null>;
  /** Zruší omylom potvrdenú platbu. */
  undo: (entryId: number) => Promise<string | null>;
}

type Tab = 'game' | 'rules' | 'players';

interface HostPanelProps {
  view: TableView;
  actions: HostActions;
  bank: BankActions;
  onClose: () => void;
  initialTab?: Tab;
}

/** Ovládanie hosta; bankár bez práv hosta tu vidí len záložku s hráčmi a žetónmi. */
export function HostPanel({ view, actions, bank, onClose, initialTab = 'game' }: HostPanelProps) {
  const admin = isAdmin(view);
  const [chosenTab, setTab] = useState<Tab>(initialTab);
  const tab = admin ? chosenTab : 'players';
  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" onClick={(event) => event.stopPropagation()} aria-label={admin ? 'Ovládanie hosta' : 'Bank'}>
        <header className="drawer-header">
          <h2>{admin ? `${isOwner(view) ? '♛' : '★'} Ovládanie hosta` : '🏦 Bank'}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Zavrieť">
            ✕
          </button>
        </header>
        {admin && (
        <nav className="tabs">
          <button type="button" className={tab === 'game' ? 'tab active' : 'tab'} onClick={() => setTab('game')}>
            Hra
          </button>
          <button type="button" className={tab === 'rules' ? 'tab active' : 'tab'} onClick={() => setTab('rules')}>
            Pravidlá
          </button>
          <button type="button" className={tab === 'players' ? 'tab active' : 'tab'} onClick={() => setTab('players')}>
            Hráči a žetóny
          </button>
        </nav>
        )}
        <div className="drawer-body">
          {tab === 'game' && <GameTab view={view} actions={actions} />}
          {tab === 'rules' && <RulesForm view={view} actions={actions} />}
          {tab === 'players' && <HostPlayersList view={view} actions={actions} bank={bank} />}
        </div>
      </aside>
    </div>
  );
}

/** „15 s + timebank 50 s“ / „bez limitu“ */
export function turnTimeLabel(settings: Pick<TableSettings, 'actionTimeoutSec' | 'timeBankSec'>): string {
  if (!settings.actionTimeoutSec) {
    return 'bez limitu';
  }
  return typeof settings.timeBankSec === 'number' ? `${timeoutLabel(settings.actionTimeoutSec)} + timebank ${settings.timeBankSec} s` : timeoutLabel(settings.actionTimeoutSec);
}


export function timeoutLabel(seconds: number): string {
  return seconds >= 120 && seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds} s`;
}

function PiggyHostCard({ view, actions }: { view: TableView; actions: HostActions }) {
  const piggy = view.piggy ?? null;
  const money = (cents: number) => formatMoney(cents, view.settings.currency);
  const entry = piggy?.entry ?? view.settings.bigBlind;
  const text = `Hrá sa niekoľko rúk: pred každou rukou dá každý vstup 1 BB (${money(entry)}) do prasiatka mimo potu. Víťaz ruky dostane zelený krúžok, prvý s 3 krúžkami berie celé prasiatko.`;
  if (!piggy) {
    return (
      <>
        <div className="special-grid">
          <button type="button" className="special-card" onClick={() => actions.piggy('start')}>
            <span className="special-icon">🐷</span>
            <span className="special-title">Prasiatko</span>
            <span className="special-text">{text}</span>
            <span className="special-flag">Spustiť</span>
          </button>
        </div>
      </>
    );
  }
  const leaders = view.players
    .filter((player) => (piggy.wins?.[player.id] ?? 0) > 0)
    .sort((left, right) => (piggy.wins[right.id] ?? 0) - (piggy.wins[left.id] ?? 0))
    .map((player) => `${player.name} ${piggy.wins[player.id]}×`);
  return (
    <>
      <div className="special-card active piggy-host-card">
        <span className="special-icon">🐷</span>
        <span className="special-title">Prasiatko {piggy.status === 'finished' ? 'skončilo' : 'beží'}</span>
        <span className="special-text">
          V prasiatku {money(piggy.amount)} · vstup {money(piggy.entry)}
          {leaders.length > 0 ? ` · krúžky: ${leaders.join(', ')}` : ' · zatiaľ bez krúžkov'}
        </span>
        <span className="special-flag">{piggy.status === 'finished' ? 'Vyhraté 🎉' : 'Beží ✓'}</span>
      </div>
      {piggy.status === 'running' && (
        <button type="button" className="btn btn-ghost danger" onClick={() => actions.piggy('cancel')}>
          Zrušiť Prasiatko (vrátiť vstupy)
        </button>
      )}
    </>
  );
}

function GameTab({ view, actions }: { view: TableView; actions: HostActions }) {
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [sevenDeuceDraft, setSevenDeuceDraft] = useState<boolean | null>(null);
  const { settings } = view;
  const sevenDeuceOn = sevenDeuceDraft ?? settings.sevenDeuceAlways;
  const override = view.nextHand;
  const handRunning = !!view.hand && view.hand.street !== 'complete';
  const [handsDraft, setHandsDraft] = useState(1);
  const hands = override?.variant ? (override.hands ?? 1) : handsDraft;
  const liveSpecial = handRunning && view.hand!.rules.variant === override?.variant && view.hand!.rules.variant !== settings.defaultVariant;
  const specialLeft = hands + (liveSpecial ? 1 : 0);
  const changeHands = (delta: number) => {
    const next = Math.max(1, Math.min(MAX_SPECIAL_HANDS, hands + delta));
    setHandsDraft(next);
    if (override?.variant) {
      actions.nextHand({ variant: override.variant, hands: next });
    }
  };
  const playing = view.phase === 'playing';
  const bounty = formatMoney(settings.sevenDeuceBounty, settings.currency);

  const save = async (patch: Partial<TableSettings>) => {
    if (saving) {
      return;
    }
    setSaving(true);
    setMessage(await actions.saveSettings(patch));
    setSaving(false);
    setSevenDeuceDraft(null);
  };

  const specials: { variant: Variant; title: string; text: string; icon: string }[] = [
    { variant: 'omaha', title: 'Kolo Omahy', text: '4 karty, hráš presne 2 z ruky + 3 zo stola', icon: '🃏' },
    { variant: 'pineapple', title: 'Kolo Pineapple', text: '3 karty, po preflope jednu zahodíš', icon: '🍍' },
  ];

  return (
    <div className="stack-gap">
      <section className="host-section">
        <h3>Priebeh hry</h3>
        <div className="host-status">
          <span className={playing && !view.paused ? 'dot dot-live' : 'dot'} />
          {view.phase === 'lobby' ? 'Hra ešte nezačala' : view.phase === 'draw' ? 'Rozhoduje sa o dealer buttone' : view.paused ? 'Pozastavené' : 'Hra beží'}
        </div>
        {playing && view.returnToLobbyPending && (
          <div className="host-pending-box">
            <span className="host-pending">⏹ Návrat do čakárne po dohraní ruky</span>
            <button type="button" className="btn btn-secondary" onClick={actions.start}>
              Zrušiť návrat — hrať ďalej
            </button>
          </div>
        )}
        {playing && !view.returnToLobbyPending && (
          <>
            <div className="button-row">
              {view.paused ? (
                <button type="button" className="btn btn-primary" onClick={actions.start}>
                  ▶ Pokračovať
                </button>
              ) : (
                <button type="button" className="btn btn-secondary" onClick={actions.pause}>
                  ⏸ Pozastaviť po tejto ruke
                </button>
              )}
              <button type="button" className="btn btn-ghost danger" onClick={actions.toLobby}>
                ⏹ Ukončiť hru → čakáreň
              </button>
            </div>
          </>
        )}
      </section>

      <section className="host-section">
        <h3>Pravidlo 7-2</h3>
        <label className={sevenDeuceOn ? 'rule-switch on' : 'rule-switch'}>
          <input
            type="checkbox"
            role="switch"
            checked={sevenDeuceOn}
            disabled={saving}
            onChange={(event) => {
              setSevenDeuceDraft(event.target.checked);
              void save({ sevenDeuceAlways: event.target.checked });
            }}
          />
          <span className="rule-switch-track" aria-hidden />
          <span className="rule-switch-text">
            <strong>{sevenDeuceOn ? '7-2 je zapnuté' : '7-2 je vypnuté'}</strong>
            <span>Kto vyhrá ruku so 7-2, dostane bonus {bounty} od každého hráča v ruke.</span>
          </span>
        </label>
      </section>

      {message && <div className="error">{message}</div>}

      <section className="host-section">
        <h3>Špeciálne kolo</h3>
        <div className="special-hands">
          <span>Počet kôl</span>
          <button type="button" className="btn btn-chip raise-step" onClick={() => changeHands(-1)} disabled={hands <= 1} aria-label="Menej kôl">
            −
          </button>
          <strong className="special-hands-value">{hands}</strong>
          <button type="button" className="btn btn-chip raise-step" onClick={() => changeHands(1)} disabled={hands >= MAX_SPECIAL_HANDS} aria-label="Viac kôl">
            +
          </button>
          {override?.variant && <span className="special-hands-left">zostáva {handsLabel(specialLeft)}</span>}
        </div>
        <div className="special-grid">
          {specials.map((special) => {
            const active = override?.variant === special.variant;
            return (
              <button
                key={special.variant}
                type="button"
                className={active ? 'special-card active' : 'special-card'}
                onClick={() => actions.nextHand(active ? null : { variant: special.variant, hands })}
              >
                <span className="special-icon">{special.icon}</span>
                <span className="special-title">{special.title}</span>
                <span className="special-text">{special.text}</span>
                {active && <span className="special-flag">Vyhlásené ✓</span>}
              </button>
            );
          })}
        </div>
        {override && (
          <button type="button" className="btn btn-ghost" onClick={() => actions.nextHand(null)}>
            Zrušiť špeciálne kolo
          </button>
        )}
      </section>

      <section className="host-section">
        <h3>Mód na viac rúk</h3>
        <PiggyHostCard view={view} actions={actions} />
      </section>
    </div>
  );
}
