import { useRef, useState, type ReactNode } from 'react';
import type { SeatPlayerView, TableView } from '../../../shared/types';
import { VARIANT_LABELS } from '../../../shared/constants';
import { formatMoney } from '../../../shared/money';
import { handsLabel } from '../../../shared/plural';
import { doubleBoardLabel, handCountLabel, piggySeriesLabel } from './GameModes';
import { SoundButton, SoundMenuItems, useDismiss } from '../sound';
import { JukeboxButton } from '../jukebox/Jukebox';
import { HelpDialog } from './HelpDialog';
import { CameraIcon } from './MediaIcons';
import { MicButton } from './MicButton';
import { MicIcon } from './MicIcon';

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
  /** Demo: Vysvetlivky otvorené na tejto kapitole. */
  initialHelpChapter?: string;
  /** Obsah v strede lišty (napr. banner špeciálneho kola). */
  children?: ReactNode;
}

export function TableTopbar(props: TableTopbarProps) {
  const { view, inviteUrl, camera, microphone, me, onToggleCamera, onToggleMicrophone, onToggleChat, onOpenStats, onAway, onReturn, onLeave, leaveLabel, leaveHint, leaveDisabled, pushToTalk, onOpenHost, hostButton = 'host', initialMenuOpen, initialHelpChapter, children } = props;
  const sittingOut = !!me?.sittingOut;
  const away = !!me?.away;
  const [menuOpen, setMenuOpen] = useState(!!initialMenuOpen);
  const menuRef = useRef<HTMLDivElement>(null);
  const [helpOpen, setHelpOpen] = useState(!!initialHelpChapter);
  useDismiss(menuOpen, setMenuOpen, menuRef);
  const { copied, copy } = useCopyInvite(inviteUrl);
  const money = (cents: number) => formatMoney(cents, view.settings.currency);
  const handLive = !!view.hand && view.hand.street !== 'complete';
  const sevenDeuceActive = handLive ? view.hand!.rules.sevenDeuce : view.settings.sevenDeuceAlways;
  const sevenDeuceBounty = sevenDeuceActive ? (handLive ? view.hand!.rules.sevenDeuceBounty : view.settings.sevenDeuceBounty) : null;
  const modeChips: { key: 'variant' | 'next-variant' | 'double-board' | 'seven-deuce' | 'piggy'; label: string; title: string }[] = [];
  const liveSpecial = handLive && view.hand!.rules.variant !== view.settings.defaultVariant ? view.hand!.rules.variant : null;
  const queued = view.nextHand?.variant ? { variant: view.nextHand.variant, hands: view.nextHand.hands ?? 1, permanent: !!view.nextHand.permanent } : null;
  if (liveSpecial) {
    const continues = queued?.variant === liveSpecial;
    const left = 1 + (continues ? queued.hands : 0);
    modeChips.push({
      key: 'variant',
      label: `${VARIANT_LABELS[liveSpecial]} · ${continues && queued.permanent ? 'natrvalo' : left === 1 ? 'posledné kolo' : `ešte ${handsLabel(left)}`}`,
      title: continues && queued.permanent ? 'Špeciálne kolo natrvalo — kým ho host nevypne' : 'Špeciálne kolo — počet zahŕňa aj túto ruku',
    });
  }
  if (queued && queued.variant !== liveSpecial) {
    modeChips.push({ key: 'next-variant', label: `Ďalej ${VARIANT_LABELS[queued.variant]} · ${queued.permanent ? 'natrvalo' : handsLabel(queued.hands)}`, title: 'Špeciálne kolo od ďalšej ruky' });
  }
  // Double Board: zapnutý mód platí od najbližšej rozdanej ruky; vypnutý počas ruky ešte dobehne v tejto ruke.
  const liveDoubleBoard = handLive && !!view.hand!.rules.doubleBoard;
  const doubleBoardTitle = 'Dva samostatné boardy — bank sa delí na polovicu medzi víťazov vrchného a spodného boardu, kto vyhrá oba, berie všetko';
  if (view.doubleBoard && handLive && !liveDoubleBoard) {
    modeChips.push({ key: 'double-board', label: `Ďalej Double Board · ${view.doubleBoard.permanent ? 'natrvalo' : handCountLabel(view.doubleBoard.remaining)}`, title: doubleBoardTitle });
  } else if (view.doubleBoard || liveDoubleBoard) {
    modeChips.push({ key: 'double-board', label: `Double Board · ${doubleBoardLabel(view.doubleBoard, liveDoubleBoard)}`, title: doubleBoardTitle });
  }
  if (sevenDeuceBounty !== null) {
    modeChips.push({ key: 'seven-deuce', label: `7-2 · bonus ${money(sevenDeuceBounty)}`, title: 'Kto vyhrá ruku so 7-2, dostane bonus od každého hráča v ruke' });
  }
  if (view.piggy?.status === 'running') {
    const series = piggySeriesLabel(view.piggy);
    modeChips.push({ key: 'piggy', label: `🐷 Prasiatko ${money(view.piggy.amount)}${series ? ` · ${series}` : ''}`, title: `Prvý s ${view.piggy.target} výhrami berie celé prasiatko` });
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
        {/* Na mobile je pauza, kamera, mikrofón a zvuk v menu ☰ (`.menu-mobile`) — v lište ostáva chat, štatistiky, host a ☰. */}
        <JukeboxButton view={view} />
        {me && !sittingOut && (
          <button
            type="button"
            className={away ? 'icon-btn away-btn topbar-desk on' : 'icon-btn away-btn topbar-desk'}
            onClick={() => onAway(!away)}
            title={away ? 'Som späť — zrušiť krátku pauzu' : 'Krátka pauza (som hneď späť)'}
            aria-label={away ? 'Som späť' : 'Krátka pauza'}
            aria-pressed={away}
          >
            ☕
          </button>
        )}
        <button
          type="button"
          className={camera ? 'icon-btn mic-btn topbar-desk on' : 'icon-btn mic-btn topbar-desk'}
          onClick={onToggleCamera}
          title={camera ? 'Kamera zapnutá — vypnúť' : 'Kamera vypnutá — zapnúť'}
          aria-label="Kamera"
          aria-pressed={camera}
        >
          <CameraIcon off={!camera} />
        </button>
        <span className="topbar-desk">
          <MicButton microphone={microphone} onToggle={onToggleMicrophone} pushToTalk={pushToTalk} />
        </span>
        <span className="topbar-desk">
          <SoundButton />
        </span>
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
        <div className="menu-wrap" ref={menuRef}>
          <button type="button" className="icon-btn" onClick={() => setMenuOpen(!menuOpen)} aria-label="Menu">
            ☰
          </button>
          {menuOpen && (
            <div className="menu" onClick={() => setMenuOpen(false)}>
              <div className="menu-mobile">
                {me && !sittingOut && (
                  <button type="button" className={away ? 'menu-item menu-row menu-item-on' : 'menu-item menu-row'} onClick={() => onAway(!away)} aria-pressed={away}>
                    <span className="menu-row-icon" aria-hidden>
                      ☕
                    </span>
                    <span>{away ? 'Som späť' : 'Krátka pauza'}</span>
                  </button>
                )}
                <button type="button" className="menu-item menu-row" onClick={onToggleCamera} aria-pressed={camera}>
                  <span className="menu-row-icon">
                    <CameraIcon off={!camera} size={18} />
                  </span>
                  <span>Kamera</span>
                  <span className={camera ? 'menu-row-state on' : 'menu-row-state'}>{camera ? 'zapnutá' : 'vypnutá'}</span>
                </button>
                <button type="button" className="menu-item menu-row" onClick={onToggleMicrophone} aria-pressed={microphone}>
                  <span className="menu-row-icon">
                    <MicIcon off={!microphone} size={18} />
                  </span>
                  <span>Mikrofón</span>
                  <span className={microphone ? 'menu-row-state on' : 'menu-row-state'}>{microphone ? 'zapnutý' : 'vypnutý'}</span>
                </button>
                <SoundMenuItems />
                <div className="menu-separator" role="separator" />
              </div>
              {me && sittingOut && (
                <button type="button" className="menu-item" onClick={onReturn}>
                  <span>▶ Vrátiť sa do hry</span>
                </button>
              )}
              <button type="button" onClick={() => setHelpOpen(true)}>
                📖 Vysvetlivky
              </button>
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
      {helpOpen && <HelpDialog view={view} initialChapter={initialHelpChapter} onClose={() => setHelpOpen(false)} />}
    </header>
  );
}
