import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { Currency, GameMode, ModeIntroView, NextHandOverride, PiggyView, SeatPlayerView, TableSettings } from '../../../shared/types';
import { DISCARD_TIMEOUT_SEC } from '../../../shared/constants';
import { formatMoney } from '../../../shared/money';
import { handsLabel } from '../../../shared/plural';
import { getSoundPreferences, playSound } from '../sound';

function names(ids: string[], players: SeatPlayerView[]): string {
  return ids.map((id) => players.find((player) => player.id === id)?.name ?? 'Hráč').join(', ');
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

/** Hrá hráč v prasiatku? (vložil vstup alebo má krúžok) */
export function inPiggy(piggy: PiggyView, playerId: string): boolean {
  return playerId in (piggy.contributed ?? {}) || playerId in (piggy.wins ?? {});
}

/* ---------- Popisy bežiacich módov ---------- */

/** „1 hra“, „3 hry“, „5 hier“ */
export function gamesLabel(count: number): string {
  return `${count} ${count === 1 ? 'hra' : count >= 2 && count <= 4 ? 'hry' : 'hier'}`;
}

/** Dĺžka naplánovaného špeciálneho kola: „natrvalo“ alebo „3 kolá“. */
export function specialRoundLabel(override: NextHandOverride): string {
  return override.permanent ? 'natrvalo' : handsLabel(override.hands ?? 1);
}

/** Séria Prasiatka pokračuje ďalšou hrou (po dohraní tejto sa sama spustí ďalšia). Starší server `series` neposiela. */
export function piggyContinues(piggy: PiggyView): boolean {
  const series = piggy.series;
  return !!series && !series.stopping && (series.permanent || series.remaining > 1);
}

/** Počet hier série pri spustení; null = natrvalo alebo starší server bez `series`. */
export function piggySeriesTotal(piggy: PiggyView): number | null {
  const total = piggy.series?.total;
  return typeof total === 'number' && total > 0 ? total : null;
}

/**
 * Popis série Prasiatka („hra 2 z 5“, „natrvalo“, „hra 3 z 5 · končí po tejto hre“); null = jediná hra.
 * Bežiaca hra = `total - remaining + 1` (počas oslavy ešte ukazuje práve dohranú hru).
 */
export function piggySeriesLabel(piggy: PiggyView): string | null {
  const series = piggy.series;
  if (!series) {
    return null;
  }
  const total = piggySeriesTotal(piggy);
  const game = !series.permanent && total && total > 1 ? `hra ${Math.max(1, total - series.remaining + 1)} z ${total}` : null;
  if (series.stopping) {
    return game ? `${game} · končí po tejto hre` : 'končí po tejto hre';
  }
  if (series.permanent) {
    return 'natrvalo';
  }
  if (game) {
    return game;
  }
  return series.remaining > 1 ? `ešte ${gamesLabel(series.remaining)} vrátane tejto` : null;
}

/* ---------- Prasiatko: grafika ---------- */

/** Sklenené prasiatko; `fill` (0–1) = koľko je naplnené mincami. */
export function PiggySvg({ fill, className }: { fill: number; className?: string }) {
  const clipId = useId();
  const gradientId = useId();
  const level = Math.max(0, Math.min(1, fill));
  const top = 9;
  const bottom = 42;
  const fillY = bottom - (bottom - top) * level;
  return (
    <svg className={className} viewBox="0 0 70 52" aria-hidden focusable="false">
      <defs>
        <clipPath id={clipId}>
          <ellipse cx="31" cy="27" rx="23" ry="16" />
          <circle cx="51" cy="23" r="11.5" />
        </clipPath>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffe48a" />
          <stop offset="1" stopColor="#d9a12c" />
        </linearGradient>
      </defs>
      <path d="M9 24 q-7 -1 -5 -7 q2 -4 5 -1" fill="none" stroke="#f3a5ba" strokeWidth="2.4" strokeLinecap="round" />
      <rect x="15" y="36" width="7" height="11" rx="2.5" fill="#e98aa3" />
      <rect x="25" y="38" width="7" height="10" rx="2.5" fill="#d9778f" />
      <rect x="36" y="38" width="7" height="10" rx="2.5" fill="#d9778f" />
      <rect x="45" y="35" width="7" height="12" rx="2.5" fill="#e98aa3" />
      <path d="M43 15 L46 3 L54 13 Z" fill="#f3a5ba" />
      <ellipse cx="31" cy="27" rx="23" ry="16" fill="#f7b6c7" stroke="#e98aa3" strokeWidth="3" />
      <circle cx="51" cy="23" r="11.5" fill="#f7b6c7" stroke="#e98aa3" strokeWidth="3" />
      <ellipse cx="31" cy="27" rx="23" ry="16" fill="#f7b6c7" />
      <circle cx="51" cy="23" r="11.5" fill="#f7b6c7" />
      <g clipPath={`url(#${clipId})`}>
        <rect x="0" y={fillY} width="70" height={52 - fillY} fill={`url(#${gradientId})`} />
        {level > 0.02 && <path d={`M0 ${fillY} q6 -2.4 12 0 t12 0 t12 0 t12 0 t12 0 t12 0`} fill="none" stroke="#fff3c4" strokeWidth="1.4" opacity="0.8" />}
      </g>
      <ellipse cx="61" cy="25.5" rx="5.5" ry="6.5" fill="#f9c6d3" stroke="#e98aa3" strokeWidth="1.5" />
      <circle cx="60" cy="23.6" r="1.1" fill="#8c3a50" />
      <circle cx="62.4" cy="27" r="1.1" fill="#8c3a50" />
      <circle cx="52" cy="19" r="1.8" fill="#2a1a1f" />
      <rect x="24" y="10" width="13" height="3" rx="1.5" fill="#5a2a38" />
      <ellipse cx="22" cy="20" rx="7" ry="3.2" fill="rgba(255, 255, 255, 0.35)" transform="rotate(-18 22 20)" />
    </svg>
  );
}

interface PiggyBankProps {
  piggy: PiggyView;
  currency: Currency;
  /** Koľko hráčov hrá o prasiatko — určuje, kedy je „plné“. */
  participants: number;
}

/** Prasiatko pri pote: suma, vstup a hladina mincí; pri každom vklade do neho padne minca. */
export function PiggyBank({ piggy, currency, participants }: PiggyBankProps) {
  const money = (cents: number) => formatMoney(cents, currency);
  const capacity = Math.max(1, piggy.entry * Math.max(2, participants) * piggy.target * 2);
  const fill = piggy.amount <= 0 ? 0 : Math.max(0.1, Math.min(1, piggy.amount / capacity));
  const previous = useRef(piggy.amount);
  const [drops, setDrops] = useState(0);
  const finished = piggy.status === 'finished';

  useEffect(() => {
    if (piggy.amount > previous.current && !finished) {
      setDrops((count) => count + 1);
    }
    previous.current = piggy.amount;
  }, [piggy.amount, finished]);

  const series = piggySeriesLabel(piggy);
  return (
    <div className={finished ? 'piggy-bank finished' : 'piggy-bank'} title={`Prasiatko: ${money(piggy.amount)} · vstup ${money(piggy.entry)} na ruku · prvý s ${piggy.target} krúžkami berie všetko${series ? ` · ${series}` : ''}`}>
      <span className="piggy-visual">
        <PiggySvg fill={finished ? 1 : fill} className="piggy-svg" />
        {drops > 0 && <span key={drops} className="piggy-coin" aria-hidden />}
      </span>
      <span className="piggy-info">
        <strong className="piggy-amount">{money(piggy.amount)}</strong>
        <span className="piggy-entry">{finished ? (piggyContinues(piggy) ? 'vyhraté! ďalšie sa spúšťa' : 'prasiatko vyhraté!') : `vstup ${money(piggy.entry)}${series ? ` · ${series}` : ''}`}</span>
      </span>
    </div>
  );
}

/** Krúžky výhier pri hráčovi (zelené = vyhraté ruky). */
export function PiggyDots({ wins, target }: { wins: number; target: number }) {
  return (
    <span className="piggy-dots" role="img" aria-label={`Prasiatko: ${wins} z ${target}`} title={`Prasiatko: ${wins} z ${target} výhier`}>
      {Array.from({ length: target }, (_, index) => (
        <span key={index} className={index < wins ? 'piggy-dot won' : 'piggy-dot'} />
      ))}
    </span>
  );
}

/** Zvuky prasiatka: minca pri vklade, výhra pri konci. Prvý stav (pripojenie) je len východisko. */
export function usePiggySounds(piggy: PiggyView | null): void {
  const previous = useRef<PiggyView | null | undefined>(undefined);
  useEffect(() => {
    const before = previous.current;
    previous.current = piggy;
    if (before === undefined || !piggy || !getSoundPreferences().effects) {
      return;
    }
    if (piggy.status === 'finished' && before?.status === 'running') {
      playSound('win');
      playSound('bounty', { delayMs: 450 });
      return;
    }
    if (piggy.status === 'running' && before?.status === 'running' && piggy.amount > before.amount) {
      playSound('chips');
    }
  }, [piggy]);
}

/* ---------- Prasiatko: oslava ---------- */

const CONFETTI_COLORS = ['#ffd76a', '#3ee08f', '#ff7aa2', '#7ab8ff', '#ffffff', '#f4a261'];
const CONFETTI = Array.from({ length: 44 }, (_, index) => {
  const seed = Math.sin(index * 91.7) * 10_000;
  const random = seed - Math.floor(seed);
  const random2 = Math.sin(index * 12.9) * 0.5 + 0.5;
  return {
    left: (index * 37 + random * 23) % 100,
    delay: Math.round(random * 900),
    duration: 2200 + Math.round(random2 * 1600),
    drift: Math.round((random2 - 0.5) * 160),
    spin: Math.round(360 + random * 720),
    color: CONFETTI_COLORS[index % CONFETTI_COLORS.length],
    coin: index % 4 === 0,
  };
});

export function Confetti() {
  return (
    <div className="confetti" aria-hidden>
      {CONFETTI.map((piece, index) => (
        <span
          key={index}
          className={piece.coin ? 'confetti-piece coin' : 'confetti-piece'}
          style={{ left: `${piece.left}%`, background: piece.coin ? undefined : piece.color, animationDelay: `${piece.delay}ms`, animationDuration: `${piece.duration}ms`, '--drift': `${piece.drift}px`, '--spin': `${piece.spin}deg` } as CSSProperties}
        />
      ))}
    </div>
  );
}

/** Prasiatko odletí zo stredu stola k víťazovi (pozícia sedadla v % plochy stola). */
export function PiggyFlight({ x, y }: { x: number; y: number }) {
  return (
    <div className="piggy-flight" style={{ '--to-x': `${x}%`, '--to-y': `${y}%` } as CSSProperties} aria-hidden>
      <PiggySvg fill={1} className="piggy-svg" />
    </div>
  );
}

interface PiggyWonDialogProps {
  piggy: PiggyView;
  currency: Currency;
  youId: string;
  onClose: () => void;
}

/** Dialóg pre všetkých po skončení prasiatka; ukáže sa až po prelete prasiatka k víťazovi. */
export function PiggyWonDialog({ piggy, currency, youId, onClose }: PiggyWonDialogProps) {
  const [visible, setVisible] = useState(prefersReducedMotion);
  useEffect(() => {
    if (visible) {
      return;
    }
    const timer = window.setTimeout(() => setVisible(true), 1700);
    return () => window.clearTimeout(timer);
  }, [visible]);
  if (!visible) {
    return null;
  }
  const money = (cents: number) => formatMoney(cents, currency);
  const winners = piggy.winners ?? [];
  const total = winners.reduce((sum, winner) => sum + winner.amount, 0);
  const iWon = winners.some((winner) => winner.playerId === youId);
  return (
    <div className="modal-backdrop modal-backdrop-soft">
      <div className="modal piggy-won" role="dialog" aria-modal="true" aria-labelledby="piggy-won-title">
        <PiggySvg fill={1} className="piggy-won-svg" />
        <h2 id="piggy-won-title">Prasiatko skončilo!</h2>
        {winners.length === 1 ? (
          <p className="piggy-won-line">
            {iWon ? 'Vyhrávaš ty' : (
              <>
                Vyhráva <strong>{winners[0].playerName}</strong>
              </>
            )}{' '}
            — <strong className="piggy-won-amount">{money(winners[0].amount)}</strong>
          </p>
        ) : winners.length > 1 ? (
          <>
            <p className="piggy-won-line">
              Prasiatko {money(total)} si delia:
            </p>
            <ul className="piggy-won-list">
              {winners.map((winner) => (
                <li key={winner.playerId}>
                  <span>{winner.playerName}</span>
                  <strong>{money(winner.amount)}</strong>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="piggy-won-line">Prasiatko {money(piggy.amount)} je rozdelené.</p>
        )}
        {iWon && <p className="hint">Gratulujeme — výhra ide do tvojho stacku 🎉</p>}
        <button type="button" className="btn btn-primary btn-block btn-big" onClick={onClose}>
          Super
        </button>
      </div>
    </div>
  );
}

/* ---------- Dialóg s pravidlami módu ---------- */

export interface ModeInfo {
  icon: string;
  title: string;
  lead: string;
  rules: ReactNode[];
}

/** `nextHand` = naplánované špeciálne kolo (pri intre Omahy / Pineapple povie, či beží natrvalo). */
export function modeInfo(mode: GameMode, settings: TableSettings, piggy: PiggyView | null, nextHand?: NextHandOverride | null): ModeInfo {
  const money = (cents: number) => formatMoney(cents, settings.currency);
  const permanentVariant = !!nextHand?.permanent && nextHand.variant === mode;
  switch (mode) {
    case 'omaha':
      return {
        icon: '🃏',
        title: 'Omaha',
        lead: permanentVariant ? 'Od ďalšej ruky sa hrá Omaha natrvalo — kým ju host nevypne.' : 'Ďalšia ruka sa hrá ako Omaha.',
        rules: [
          <>
            Každý dostane <strong>4 karty</strong>.
          </>,
          <>
            Kombináciu skladáš z <strong>presne 2 kariet z ruky</strong> a <strong>3 zo stola</strong> — ani viac, ani menej (napr. štyri srdcia v ruke ešte nie sú farba).
          </>,
          settings.omahaPotLimit ? (
            <>
              Stávky sú <strong>pot-limit</strong>: najviac toľko, koľko je v pote — tlačidlo „Max“ namiesto all-in.
            </>
          ) : (
            <>
              Stávky sú <strong>no-limit</strong> — all-in môžeš dať kedykoľvek.
            </>
          ),
          ...(settings.sevenDeuceAlways ? [<>Bonus 7-2 sa v Omahe nepočíta.</>] : []),
        ],
      };
    case 'pineapple':
      return {
        icon: '🍍',
        title: 'Pineapple',
        lead: permanentVariant ? 'Od ďalšej ruky sa hrá Pineapple natrvalo — kým ho host nevypne.' : 'Ďalšia ruka sa hrá ako Pineapple.',
        rules: [
          <>
            Každý dostane <strong>3 karty</strong>.
          </>,
          <>
            Po preflope (pred flopom) <strong>jednu kartu zahodíš</strong> — ťukni na ňu a potvrď.
          </>,
          <>
            Na zahodenie máš <strong>{DISCARD_TIMEOUT_SEC} s</strong> — keď nestihneš, zahodí sa za teba <strong>náhodná</strong> karta.
          </>,
          <>Ďalej sa hrá ako Texas Hold'em s 2 kartami v ruke.</>,
        ],
      };
    case 'seven-deuce':
      return {
        icon: '7·2',
        title: 'Pravidlo 7-2',
        lead: 'Host zapol bonus za výhru so 7-2.',
        rules: [
          <>
            Kto vyhrá ruku so <strong>7 a 2</strong> v ruke (farba nerozhoduje), dostane bonus <strong>{money(settings.sevenDeuceBounty)}</strong> od každého hráča, ktorý dostal karty.
          </>,
          <>Platí pre každú ruku, kým ho host nevypne.</>,
          <>V kolách Omahy sa nepočíta.</>,
        ],
      };
    case 'piggy': {
      const entry = piggy?.entry ?? settings.bigBlind;
      const target = piggy?.target ?? 3;
      const series = piggy?.series;
      return {
        icon: '🐷',
        title: 'Prasiatko',
        lead: series?.permanent
          ? 'Host spustil Prasiatko natrvalo — po každej vyhratej hre sa hneď spustí ďalšia, kým ho host nevypne.'
          : series && (piggySeriesTotal(piggy!) ?? series.remaining) > 1
            ? `Host spustil Prasiatko na ${gamesLabel(piggySeriesTotal(piggy!) ?? series.remaining)} za sebou — po vyhratej hre sa hneď spustí ďalšia.`
            : 'Host spustil Prasiatko — hrá sa niekoľko rúk, kým ho niekto nevyhrá.',
        rules: [
          <>
            Pred každou rukou dá každý, kto dostane karty, <strong>vstup 1 BB = {money(entry)}</strong> do prasiatka. Vstup ide <strong>mimo potu</strong>.
          </>,
          <>Potom sa hrá normálne — small blind, big blind, stávky.</>,
          <>
            Kto vyhrá ruku (aj časť potu), dostane{' '}
            <span className="nowrap">
              <span className="piggy-dot won inline" aria-hidden /> <strong>zelený krúžok</strong>.
            </span>
          </>,
          <>
            Prvý s <strong>{target} krúžkami</strong> berie celé prasiatko. Pri remíze sa delí.
          </>,
          <>
            Host môže Prasiatko spustiť aj na <strong>viac hier za sebou</strong> alebo <strong>natrvalo</strong> — pravidlá sa ukážu len pri prvej hre.
          </>,
          <>Host môže sériu ukončiť po dohraní hry, alebo Prasiatko zrušiť hneď — vtedy sa vstupy vrátia.</>,
        ],
      };
    }
  }
}

interface ModeIntroModalProps {
  intro: ModeIntroView;
  settings: TableSettings;
  piggy: PiggyView | null;
  /** Naplánované špeciálne kolo — pri Omahe / Pineapple natrvalo sa to povie v úvode. */
  nextHand?: NextHandOverride | null;
  players: SeatPlayerView[];
  youId: string;
  secondsLeft: number;
  onAck: () => void;
}

export function ModeIntroModal({ intro, settings, piggy, nextHand, players, youId, secondsLeft, onAck }: ModeIntroModalProps) {
  const [sent, setSent] = useState(false);
  const [closed, setClosed] = useState(false);
  const participant = intro.participants.includes(youId);
  const acknowledged = intro.acknowledged.includes(youId);
  const waiting = intro.participants.filter((id) => !intro.acknowledged.includes(id));
  const info = modeInfo(intro.mode, settings, piggy, nextHand);
  if (closed) {
    return null;
  }
  return (
    <div className="modal-backdrop">
      <div className="modal modal-wide mode-intro" role="dialog" aria-modal="true" aria-labelledby="mode-intro-title">
        <div className="mode-intro-head">
          <span className={intro.mode === 'piggy' ? 'mode-intro-icon piggy' : intro.mode === 'seven-deuce' ? 'mode-intro-icon text' : 'mode-intro-icon'} aria-hidden>
            {intro.mode === 'piggy' ? <PiggySvg fill={0.45} className="piggy-svg" /> : info.icon}
          </span>
          <span>
            <span className="mode-intro-kicker">{intro.mode === 'omaha' || intro.mode === 'pineapple' ? 'Špeciálne kolo' : 'Nový mód'}</span>
            <h2 id="mode-intro-title">{info.title}</h2>
          </span>
        </div>
        <p className="mode-intro-lead">{info.lead}</p>
        <ol className="draw-rules">
          {info.rules.map((rule, index) => (
            <li key={index}>{rule}</li>
          ))}
        </ol>
        {participant && !acknowledged ? (
          <button
            type="button"
            className="btn btn-primary btn-block btn-big"
            disabled={sent}
            onClick={() => {
              setSent(true);
              onAck();
              window.setTimeout(() => setSent(false), 3000);
            }}
          >
            Rozumiem
          </button>
        ) : (
          <div className="draw-waiting">
            <span className="dot dot-live" />
            <span>
              {waiting.length > 0 ? (
                <>
                  Čaká sa na: <strong>{names(waiting, players)}</strong>
                </>
              ) : (
                'Všetci potvrdili — rozdáva sa'
              )}
            </span>
          </div>
        )}
        <p className="hint draw-deadline">
          Ruka sa rozdá, keď všetci potvrdia, najneskôr o <strong className="nowrap">{secondsLeft} s</strong>
        </p>
        {!participant && (
          <button type="button" className="btn btn-ghost" onClick={() => setClosed(true)}>
            Zavrieť
          </button>
        )}
      </div>
    </div>
  );
}
