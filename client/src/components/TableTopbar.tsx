import { useState, type ReactNode } from 'react';
import type { SeatPlayerView, TableView } from '../../../shared/types';
import { VARIANT_LABELS } from '../../../shared/constants';
import { formatMoney } from '../../../shared/money';
import { handsLabel } from '../../../shared/plural';
import { SoundButton } from '../sound';
import { CameraIcon } from './MediaIcons';
import { MicButton } from './MicButton';

/** Skopíruje odkaz na pozvánku do schránky (alebo ho ukáže na ručné skopírovanie); `copied` svieti 2 s. */
export function useCopyInvite(inviteUrl: string): { copied: boolean; copy: () => Promise<void> } {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(inviteUrl);
    } catch {
      window.prompt('Skopíruj odkaz:', inviteUrl);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return { copied, copy };
}

/** Názov stola; starší server ho neposiela → „Stôl KÓD“. */
export function tableName(view: TableView): string {
  return view.settings.name?.trim() || `Stôl ${view.code}`;
}

interface TableTopbarProps {
  view: TableView;
  inviteUrl: string;
  camera: boolean;
  microphone: boolean;
  /** Ja pri stole — podľa stavu (pauza / stojím) sa menia položky menu. */
  me: SeatPlayerView | null;
  onToggleCamera: () => void;
  onToggleMicrophone: () => void;
  onToggleChat: () => void;
  /** Leaderboard a história rúk; bez neho tlačidlo chýba (pri stole na desktope je to záložka v bočnom paneli). */
  onOpenStats?: () => void;
  /** Postaviť sa od stola (`true`). */
  onSitOut: (value: boolean) => void;
  /** Krátka pauza „som hneď späť“ zap/vyp. */
  onAway: (value: boolean) => void;
  /** Návrat do hry po postavení sa — sadne si hneď alebo otvorí voľbu BB / zaplatiť. */
  onReturn: () => void;
  onLeave: () => void;
  /** Push-to-talk je zapnutý a mikrofón beží: kláves a či práve hovorím. */
  pushToTalk?: { key: string; talking: boolean } | null;
  /** Text položky odchodu: pri stole „Odísť od stola“ (do čakárne), v čakárni „Opustiť hru“. */
  leaveLabel: string;
  leaveHint: string;
  /** Odchod je dočasne nemožný (napr. losovanie o dealer button) — `leaveHint` vysvetlí prečo. */
  leaveDisabled?: boolean;
  /** Tlačidlo ♛ Host — len pre hosta a len ak je k dispozícii panel hosta. */
  onOpenHost?: () => void;
  /** Tlačidlo panelu: host (♛ Host) alebo bankár bez práv hosta (🏦 Bank). */
  hostButton?: 'host' | 'bank';
  initialMenuOpen?: boolean;
  /** Obsah v strede lišty (napr. banner špeciálneho kola). */
  children?: ReactNode;
}

export function TableTopbar(props: TableTopbarProps) {
  const { view, inviteUrl, camera, microphone, me, onToggleCamera, onToggleMicrophone, onToggleChat, onOpenStats, onAway, onReturn, onLeave, leaveLabel, leaveHint, leaveDisabled, pushToTalk, onOpenHost, hostButton = 'host', initialMenuOpen, children } = props;
  const sittingOut = !!me?.sittingOut;
  const away = !!me?.away;
  const [menuOpen, setMenuOpen] = useState(!!initialMenuOpen);
  const { copied, copy } = useCopyInvite(inviteUrl);
  const money = (cents: number) => formatMoney(cents, view.settings.currency);
  const handLive = !!view.hand && view.hand.street !== 'complete';
  const sevenDeuceActive = handLive ? view.hand!.rules.sevenDeuce : view.settings.sevenDeuceAlways;
  const sevenDeuceBounty = sevenDeuceActive ? (handLive ? view.hand!.rules.sevenDeuceBounty : view.settings.sevenDeuceBounty) : null;
  const modeChips: { key: 'variant' | 'next-variant' | 'seven-deuce' | 'piggy'; label: string; title: string }[] = [];
  const liveSpecial = handLive && view.hand!.rules.variant !== view.settings.defaultVariant ? view.hand!.rules.variant : null;
  const queued = view.nextHand?.variant ? { variant: view.nextHand.variant, hands: view.nextHand.hands ?? 1 } : null;
  if (liveSpecial) {
    const left = 1 + (queued?.variant === liveSpecial ? queued.hands : 0);
    modeChips.push({
      key: 'variant',
      label: `${VARIANT_LABELS[liveSpecial]} · ${left === 1 ? 'posledné kolo' : `ešte ${handsLabel(left)}`}`,
      title: 'Špeciálne kolo — počet zahŕňa aj túto ruku',
    });
  }
  if (queued && queued.variant !== liveSpecial) {
    modeChips.push({ key: 'next-variant', label: `Ďalej ${VARIANT_LABELS[queued.variant]} · ${handsLabel(queued.hands)}`, title: 'Špeciálne kolo od ďalšej ruky' });
  }
  if (sevenDeuceBounty !== null) {
    modeChips.push({ key: 'seven-deuce', label: `7-2 · bonus ${money(sevenDeuceBounty)}`, title: 'Kto vyhrá ruku so 7-2, dostane bonus od každého hráča v ruke' });
  }
  if (view.piggy?.status === 'running') {
    modeChips.push({ key: 'piggy', label: `🐷 Prasiatko ${money(view.piggy.amount)}`, title: `Prvý s ${view.piggy.target} výhrami berie celé prasiatko` });
  }

  return (
    <header className="topbar">
      <div className="topbar-left">
        <span className="brand-chip small" aria-hidden>
          ♠
        </span>
        <div className="table-meta">
          <div className="table-title">
            <span className="table-name" title={tableName(view)}>
              {tableName(view)}
            </span>
            <span className="table-code-chip" title="Kód stola">
              {view.code}
            </span>
          </div>
          <div className="table-sub">
            {VARIANT_LABELS[view.settings.defaultVariant]} · {money(view.settings.smallBlind)}/{money(view.settings.bigBlind)}
            {modeChips.map((chip) => (
              <span key={chip.key} className="mode-chip" title={chip.title}>
                {chip.label}
              </span>
            ))}
          </div>
        </div>
        <button type="button" className="btn btn-chip invite-btn" onClick={copy}>
          {copied ? '✓' : '🔗'} <span className="hide-sm">{copied ? 'Skopírované' : 'Pozvať'}</span>
        </button>
      </div>
      {children}
      <div className="topbar-right">
        {me && !sittingOut && (
          <button
            type="button"
            className={away ? 'icon-btn away-btn on' : 'icon-btn away-btn'}
            onClick={() => onAway(!away)}
            title={away ? 'Som späť — zrušiť krátku pauzu' : 'Krátka pauza (som hneď späť)'}
            aria-label={away ? 'Som späť' : 'Krátka pauza'}
            aria-pressed={away}
          >
            ☕
          </button>
        )}
        <button type="button" className={camera ? 'icon-btn mic-btn on' : 'icon-btn mic-btn'} onClick={onToggleCamera} title={camera ? 'Kamera zapnutá — vypnúť' : 'Kamera vypnutá — zapnúť'} aria-label="Kamera" aria-pressed={camera}>
          <CameraIcon off={!camera} />
        </button>
        <MicButton microphone={microphone} onToggle={onToggleMicrophone} pushToTalk={pushToTalk} />
        <SoundButton />
        <button type="button" className="icon-btn chat-toggle" onClick={onToggleChat} title="Chat">
          💬
        </button>
        {onOpenStats && (
          <button type="button" className="btn btn-chip stats-btn" onClick={onOpenStats} title="Štatistiky — leaderboard a história rúk">
            📊 <span className="hide-sm">Štatistiky</span>
          </button>
        )}
        {onOpenHost && (
          <button type="button" className="btn btn-gold" onClick={onOpenHost}>
            {hostButton === 'bank' ? '🏦' : '♛'} <span className="hide-sm">{hostButton === 'bank' ? 'Bank' : 'Host'}</span>
          </button>
        )}
        <div className="menu-wrap">
          <button type="button" className="icon-btn" onClick={() => setMenuOpen(!menuOpen)} aria-label="Menu">
            ☰
          </button>
          {menuOpen && (
            <div className="menu" onClick={() => setMenuOpen(false)}>
              {me && sittingOut && (
                <button type="button" className="menu-item" onClick={onReturn}>
                  <span>▶ Vrátiť sa do hry</span>
                </button>
              )}
              <button type="button" onClick={copy}>
                🔗 Kopírovať pozvánku
              </button>
              <button type="button" className="menu-item danger" onClick={onLeave} disabled={leaveDisabled}>
                <span>🚪 {leaveLabel}</span>
                {leaveDisabled && <small>{leaveHint}</small>}
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
