import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Card, PlayerAction, ReturnMode, RunVoteView, SeatPlayerView, TableEvent, TableView } from '../../../shared/types';
import { MAX_SEATS, VARIANT_LABELS } from '../../../shared/constants';
import { formatMoney } from '../../../shared/money';
import { handsLabel } from '../../../shared/plural';
import type { ChatToastItem } from '../hooks/useChatToasts';
import { SIDE_PANEL_DOCKED_QUERY, useMediaQuery } from '../hooks/useMediaQuery';
import type { LinkInfo } from '../hooks/useMesh';
import { useNow } from '../hooks/useNow';
import { bankerIdOf, isAdmin, isBanker } from '../roles';
import { turnClock } from '../turnClock';
import { ActionBar } from './ActionBar';
import { ChatToasts } from './ChatToasts';
import { DealerChoiceModal, DrawBanner, DrawExplainModal, DrawField, cardLabel } from './DrawLayer';
import { HostPanel, type BankActions, type HostActions } from './HostPanel';
import { playerRoles } from './HostPlayers';
import { PlayingCard } from './PlayingCard';
import { Confetti, ModeIntroModal, PiggyBank, PiggyFlight, PiggyWonDialog, inPiggy, usePiggySounds } from './GameModes';
import { ReturnDialog, StatusBanner, owesBlinds, returnModeOf, standingText } from './PlayerPause';
import { EmptySeat, Seat, type SeatPosition } from './Seat';
import { SidePanel, type SideTab } from './SidePanel';
import type { StatsCashout, StatsTab } from './Stats';
import { TableTopbar } from './TableTopbar';
import { JoinRequestsBanner } from './JoinRequests';

export interface TableHandlers {
  onAction: (action: PlayerAction) => void;
  onDiscard: (cardIndex: number) => void;
  /** Vráti chybu servera alebo null — pri chybe ostane text v poli chatu. */
  onChat: (text: string) => Promise<string | null>;
  onToggleCamera: () => void;
  onToggleMicrophone: () => void;
  /** Postaviť sa od stola (`true`) / sadnúť si späť, ak nič nedlžím (`false`). */
  onSitOut: (value: boolean) => void;
  /** Krátka pauza „som hneď späť“. */
  onAway: (value: boolean) => void;
  /** Návrat po postavení sa: počkať na BB alebo zaplatiť a hrať hneď. */
  onReturn: (mode: ReturnMode) => void;
  /** Potvrdenie pravidiel nového módu („Rozumiem“). */
  onModeAck: () => void;
  onSeat: (seat: number) => void;
  onLeave: () => void;
  onDrawAck: () => void;
  onDrawPick: (index: number) => void;
  /** Dobrovoľne ukázať svoje karty po skončení ruky. */
  onShowCards: () => void;
  /** Zaplatiť 1 BB za odkrytie zvyšku boardu po ruke, ktorá skončila pred riverom. */
  onRabbit: () => void;
  /** Po all-in: koľkokrát chcem ísť (1×–3×); platí najmenšia voľba. */
  onRuns: (runs: number) => void;
  host: HostActions;
  bank: BankActions;
}

export interface TableUiState {
  hostOpen?: boolean;
  hostTab?: 'game' | 'rules' | 'players';
  chatOpen?: boolean;
  sideTab?: SideTab;
  /** Leaderboard / história — v bočnom paneli počas hry aj v čakárni. */
  statsTab?: StatsTab;
  menuOpen?: boolean;
  /** Demo: otvorené Vysvetlivky na kapitole. */
  helpChapter?: string;
  /** Otvorený dialóg návratu do hry (demo). */
  returnOpen?: boolean;
  /** Demo: otvorený dialóg zmazania stola (v pravidlách hosta / čakárne). */
  deleteOpen?: boolean;
  /** Demo: čakáreň počas bežiacej hry (hráč odišiel od stola). */
  roomView?: boolean;
}

export interface TableScreenProps {
  view: TableView;
  events: TableEvent[];
  streams: Map<string, MediaStream>;
  /** Kvalita spojenia s ostatnými hráčmi (priamo / relay, RTT, straty). */
  links?: Map<string, LinkInfo>;
  localStream: MediaStream | null;
  /** Hráči, ktorí práve hovoria (meranie hlasitosti mikrofónu) — zvýraznia sa pri stole aj v čakárni. */
  speaking?: ReadonlySet<string>;
  camera: boolean;
  microphone: boolean;
  mediaError: string | null;
  clockOffset: number;
  handlers: TableHandlers;
  inviteUrl: string;
  initialUi?: TableUiState;
  toast: string | null;
  /** Nové chat správy od ostatných (počíta ich LiveApp, aby prežili prepnutie čakáreň ↔ stôl). */
  chatToasts?: ChatToastItem[];
  onClearChatToasts?: () => void;
  /** Stôl: „Odísť od stola“ → vstanem a prejdem do čakárne (hra beží ďalej). Bez neho (demo) sa volá `handlers.onLeave`. */
  onOpenRoom?: () => void;
  /** Push-to-talk (desktop): kláves a či práve hovorím; null = vypnutý. */
  pushToTalk?: { key: string; talking: boolean } | null;
  /** Čakáreň počas hry: „Späť ku stolu“. */
  onBackToTable?: () => void;
}

/** O koľko px sa stávka dolného hráča odsunie navyše nahor, aby neprekrývala odpočet času nad avatarom. */
const CLOCK_CLEARANCE = 36;
const CLOCK_CLEARANCE_PORTRAIT = 26;
/** O koľko px je väčší avatar hráča so zapnutou kamerou (musí sedieť s `.seat-has-video` v CSS). */
const VIDEO_GROW = 28;
const VIDEO_GROW_PORTRAIT = 20;
const noChatToasts: ChatToastItem[] = [];
const noop = () => undefined;

/** Bočný panel (chat, priebeh, transakcie, štatistiky) a či je chat práve na obrazovke. */
export function useSidePanelState(initialUi: TableUiState | undefined) {
  const [chatOpen, setChatOpen] = useState(!!initialUi?.chatOpen);
  const [sideTab, setSideTab] = useState<SideTab>(initialUi?.sideTab ?? 'chat');
  const docked = useMediaQuery(SIDE_PANEL_DOCKED_QUERY);
  const chatVisible = sideTab === 'chat' && (docked || chatOpen);
  const openChat = () => {
    setSideTab('chat');
    setChatOpen(true);
  };
  return { chatOpen, setChatOpen, sideTab, setSideTab, chatVisible, openChat, docked };
}

export function usePortrait(): boolean {
  const query = '(max-aspect-ratio: 4/5), (max-width: 700px)';
  const [portrait, setPortrait] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const listener = () => setPortrait(media.matches);
    media.addEventListener('change', listener);
    return () => media.removeEventListener('change', listener);
  }, []);
  return portrait;
}

/** `piggyRow` = pod menom sú krúžky prasiatka (vyšší štítok) — stávky horných hráčov sa odsunú ďalej. */
function seatPosition(relative: number, portrait: boolean, piggyRow = false, video = false): SeatPosition {
  const angle = ((90 + (relative * 360) / MAX_SEATS) * Math.PI) / 180;
  const radiusX = portrait ? 41 : 45;
  const radiusY = portrait ? 43 : 41;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const grow = video ? (portrait ? VIDEO_GROW_PORTRAIT : VIDEO_GROW) : 0;
  const pull = (portrait ? 46 : 70) + grow / 2;
  const plateClearance = sin < -0.2 ? -sin * ((portrait ? 36 : 62) + (piggyRow ? 14 : 0) + grow / 2) : 0;
  // Dolní hráči majú stávku nad avatarom — odsunieme ju nad odpočet času na ťah (vždy, aby stávky neskákali so zmenou ťahu).
  const clockClearance = sin > 0.2 ? sin * ((portrait ? CLOCK_CLEARANCE_PORTRAIT : CLOCK_CLEARANCE) + grow / 2) : 0;
  return { x: 50 + radiusX * cos, y: 50 + radiusY * sin, betX: -cos * pull, betY: -sin * pull * (portrait ? 1 : 0.85) + plateClearance - clockClearance };
}

export function TableScreen(props: TableScreenProps) {
  const { view, events, streams, localStream, camera, microphone, mediaError, clockOffset, handlers, inviteUrl, initialUi, toast } = props;
  const [hostOpen, setHostOpen] = useState(!!initialUi?.hostOpen);
  const { chatOpen, setChatOpen, sideTab, setSideTab, chatVisible, openChat, docked } = useSidePanelState(initialUi);
  const portrait = usePortrait();
  const hand = view.hand;
  const draw = view.phase === 'draw' ? view.draw : null;
  const me = view.players.find((player) => player.id === view.youId) ?? null;
  const isHost = isAdmin(view);
  const youAreBanker = isBanker(view);
  const roles = playerRoles(view);
  const modeIntro = draw ? null : view.modeIntro ?? null;
  const piggy = view.piggy ?? null;
  const rabbit = view.rabbit && hand && view.rabbit.handNumber === hand.handNumber ? view.rabbit : null;
  const runVote = view.runVote && hand && view.runVote.handNumber === hand.handNumber ? view.runVote : null;
  const ticking = !!hand?.turnDeadline || !!hand?.discardDeadline || !!view.nextHandAt || !!draw?.deadline || !!modeIntro || !!rabbit || !!runVote;
  const now = useNow(ticking) + clockOffset;
  const handComplete = hand?.street === 'complete';
  const rabbitShown = !!rabbit && now < rabbit.until;
  const canRabbit = handComplete && !!hand && hand.board.length < 5 && !rabbit && !!me && !me.sittingOut && me.stack >= view.settings.bigBlind;
  const showdown = handComplete || hand?.street === 'showdown';
  /** All-in dorozdávanie: nikto nie je na ťahu a karty súperov sú odkryté — ukážu sa aj ich kombinácie. */
  const runout = !!hand && !showdown && hand.street !== 'discard' && !hand.toActId && view.players.some((player) => player.id !== view.youId && player.cards.some(Boolean));
  const result = handComplete ? view.lastResult : null;
  const currency = view.settings.currency;
  const money = (cents: number) => formatMoney(cents, currency);
  usePiggySounds(piggy);
  const [returnOpen, setReturnOpen] = useState(!!initialUi?.returnOpen);
  const returnAutoShown = useRef(false);
  const [piggyClosedAt, setPiggyClosedAt] = useState<number | null>(null);
  const meStanding = !!me?.sittingOut;
  const meReturning = returnModeOf(me) !== null;

  useEffect(() => {
    // Hráč, ktorý prisadol počas hry (server mu nastaví čakanie na BB), hneď vidí, ako sa vrátiť.
    if (!meStanding) {
      returnAutoShown.current = false;
      return;
    }
    if (!returnAutoShown.current && meReturning && owesBlinds(me) && view.phase === 'playing') {
      returnAutoShown.current = true;
      setReturnOpen(true);
    }
  }, [meStanding, meReturning, view.phase]);

  const requestReturn = () => {
    returnAutoShown.current = true;
    if (owesBlinds(me)) {
      setReturnOpen(true);
    } else {
      handlers.onSitOut(false);
    }
  };

  const winAmounts = useMemo(() => {
    const amounts = new Map<string, number>();
    for (const winner of result?.winners ?? []) {
      amounts.set(winner.playerId, (amounts.get(winner.playerId) ?? 0) + winner.amount);
    }
    if (result?.bounty) {
      amounts.set(result.bounty.winnerId, (amounts.get(result.bounty.winnerId) ?? 0) + result.bounty.total);
    }
    return amounts;
  }, [result]);

  const bestCards = useMemo(() => {
    const cards = new Map<string, Card[]>();
    for (const winner of result?.winners ?? []) {
      cards.set(winner.playerId, winner.bestCards);
    }
    return cards;
  }, [result]);

  const mySeat = me?.seat ?? 0;
  const occupied = new Set(view.players.map((player) => player.seat));
  const canMove = (!!me && !me.inHand) || handComplete;

  const clock = turnClock(hand, view.settings, now);
  const timerOn = view.settings.actionTimeoutSec > 0;

  const toActName = hand?.toActId ? view.players.find((player) => player.id === hand.toActId)?.name ?? null : null;

  const drawSeconds = draw?.deadline ? Math.max(0, Math.ceil((draw.deadline - now) / 1000)) : null;
  const drawParticipant = !!draw && draw.participants.includes(view.youId);
  const myDrawSlot = draw?.slots.find((slot) => slot.drawnBy === view.youId) ?? null;
  const drawnCards = useMemo(() => {
    const cards = new Map<string, Card>();
    for (const slot of draw?.slots ?? []) {
      if (slot.drawnBy && slot.card) {
        cards.set(slot.drawnBy, slot.card);
      }
    }
    return cards;
  }, [draw]);
  const canPick = draw?.stage === 'drawing' && drawParticipant && !myDrawSlot;

  let statusText: ReactNode = null;
  /** Pauza / stojím mimo hry — veľký banner priamo nad boardom, nech ho hráč nemôže prehliadnuť. */
  let feltStatus: ReactNode = null;
  if (me?.away) {
    feltStatus = <StatusBanner tone="away" icon="☕" text="Máš pauzu — ruky sa ti automaticky foldnú" action="Som späť" onAction={() => handlers.onAway(false)} />;
  } else if (view.phase === 'lobby') {
    statusText = 'Čaká sa, kým host spustí hru';
  } else if (draw) {
    statusText = drawStatus();
  } else if (me?.sittingOut) {
    statusText =
      me.stack <= 0 ? 'Nemáš žetóny — host ti ich môže pridať' : null;
    if (me.stack > 0) {
      feltStatus = <StatusBanner tone="standing" icon="🚶" text={standingText(me, view.settings)} action={meReturning ? 'Zmeniť' : 'Vrátiť sa do hry'} onAction={requestReturn} />;
    }
  } else if (view.paused && (!hand || handComplete)) {
    statusText = isHost ? (
      <span className="paused-status">
        <span>Hra je pozastavená</span>
        <button type="button" className="btn btn-primary btn-small" onClick={handlers.host.start}>
          ▶ Pokračovať v hre
        </button>
      </span>
    ) : (
      'Hra je pozastavená — čaká sa, kým ju host spustí'
    );
  } else if (view.nextHandAt) {
    statusText = `Ďalšia ruka o ${Math.max(0, Math.ceil((view.nextHandAt - now) / 1000))} s`;
  } else if (hand && !me?.inHand) {
    statusText = 'Pridáš sa od ďalšej ruky';
  } else if (!hand && view.players.filter((player) => !player.sittingOut && player.stack > 0).length < 2) {
    statusText = 'Čakáme na ďalšieho hráča s žetónmi';
  }

  function drawStatus(): ReactNode {
    if (!draw) {
      return null;
    }
    if (draw.stage === 'choose') {
      return isHost ? 'Rozhodni, ako sa určí dealer button' : 'Host rozhoduje o dealer buttone…';
    }
    if (draw.stage === 'explain') {
      return 'Losovanie o dealer button — prečítajte si pravidlá';
    }
    if (draw.stage === 'done') {
      return 'Prvá ruka sa rozdáva…';
    }
    const missing = draw.participants.filter((id) => !draw.slots.some((slot) => slot.drawnBy === id));
    const missingNames = missing.map((id) => view.players.find((player) => player.id === id)?.name ?? 'Hráč').join(', ');
    return (
      <span className="draw-status">
        {canPick ? (
          <strong className="draw-status-cta">Ťahaj kartu — vyber si ľubovoľnú kartu na stole</strong>
        ) : myDrawSlot?.card ? (
          <span>
            Tvoja karta: <strong className="draw-status-card">{cardLabel(myDrawSlot.card)}</strong>
          </span>
        ) : (
          <span>Hráči ťahajú karty o dealer button</span>
        )}
        <span className="draw-status-meta">
          {missing.length > 0 && !canPick && <span>Čaká sa na: {missingNames}</span>}
          {drawSeconds !== null && <span className="draw-countdown">{drawSeconds} s</span>}
        </span>
      </span>
    );
  }

  const handLive = !!hand && !handComplete;

  const piggyFinished = piggy?.status === 'finished';
  const piggyWinnerIds = new Set((piggy?.winners ?? []).map((winner) => winner.playerId));
  const piggyParticipants = piggy ? view.players.filter((player) => inPiggy(piggy, player.id)).length : 0;

  const discardSeconds = hand?.discardDeadline ? Math.max(0, Math.ceil((hand.discardDeadline - now) / 1000)) : null;
  const winnerNames = result?.winners.map((winner) => view.players.find((player) => player.id === winner.playerId)?.name ?? '?') ?? [];
  const uniqueWinnerNames = [...new Set(winnerNames)];
  const runWinners: string[][] = [];
  for (const winner of result?.winners ?? []) {
    if (winner.run === undefined) {
      continue;
    }
    const name = view.players.find((player) => player.id === winner.playerId)?.name ?? '?';
    runWinners[winner.run] ??= [];
    if (!runWinners[winner.run].includes(name)) {
      runWinners[winner.run].push(name);
    }
  }
  const bountyWinner = result?.bounty ? view.players.find((player) => player.id === result.bounty!.winnerId) : null;

  return (
    <div className="table-screen">
      <JoinRequestsBanner view={view} onResolve={handlers.host.resolveJoin} />
      <TableTopbar
        view={view}
        inviteUrl={inviteUrl}
        camera={camera}
        microphone={microphone}
        me={me}
        onToggleCamera={handlers.onToggleCamera}
        onToggleMicrophone={handlers.onToggleMicrophone}
        onToggleChat={() => setChatOpen(!chatOpen)}
        onOpenStats={
          docked
            ? undefined
            : () => {
                setSideTab('stats');
                setChatOpen(true);
              }
        }
        onSitOut={handlers.onSitOut}
        onAway={handlers.onAway}
        onReturn={requestReturn}
        onLeave={props.onOpenRoom ?? handlers.onLeave}
        leaveLabel="Odísť od stola"
        leaveHint={draw ? 'Počas losovania o dealer button sa odísť nedá' : 'Vstaneš a prejdeš do čakárne — neplatíš blindy, žetóny a štatistiky ostávajú'}
        pushToTalk={props.pushToTalk}
        leaveDisabled={!!draw}
        onOpenHost={isHost || youAreBanker ? () => setHostOpen(true) : undefined}
        hostButton={isHost ? 'host' : 'bank'}
        initialMenuOpen={initialUi?.menuOpen}
        initialHelpChapter={initialUi?.helpChapter}
      >
        {view.returnToLobbyPending ? (
          <div className="next-hand-banner lobby-pending-banner">
            ⏹ <strong>Návrat do čakárne</strong> <span className="hide-sm">po dohraní ruky</span>
          </div>
        ) : view.paused && view.phase === 'playing' ? (
          <div className="next-hand-banner paused-banner">
            ⏸ <strong>{handLive ? 'Pauza po tejto ruke' : 'Hra je pozastavená'}</strong>
          </div>
        ) : (
          view.nextHand && (
            <div className="next-hand-banner">
              Ďalšia ruka: <strong>{[view.nextHand.variant ? VARIANT_LABELS[view.nextHand.variant] : null, view.nextHand.sevenDeuce ? '7-2' : null].filter(Boolean).join(' + ')}</strong>
              {view.nextHand.variant && (view.nextHand.hands ?? 1) > 1 && ` · ${handsLabel(view.nextHand.hands ?? 1)}`}
            </div>
          )
        )}
      </TableTopbar>

      <div className="table-layout">
        <main className="table-area-wrap">
          <div className={portrait ? 'table-area portrait' : 'table-area'}>
            <div className="felt">
              <div className={draw && (draw.stage === 'drawing' || draw.stage === 'done') ? 'felt-inner felt-drawing' : 'felt-inner'}>
                {draw && (draw.stage === 'drawing' || draw.stage === 'done') && <DrawField draw={draw} players={view.players} canPick={canPick} onPick={handlers.onDrawPick} />}
                {draw && <DrawBanner draw={draw} players={view.players} />}
                <div className="felt-logo">POKER NIGHT</div>
                {feltStatus && <div className="felt-status">{feltStatus}</div>}
                <div className={draw ? 'board board-hidden' : 'board'}>
                  {Array.from({ length: 5 }, (_, index) => {
                    const card = hand?.board[index];
                    const highlighted = !!card && [...bestCards.values()].some((cards) => cards.includes(card));
                    const rabbitCard = !card && rabbitShown && hand ? rabbit!.cards[index - hand.board.length] : undefined;
                    if (card) {
                      return <PlayingCard key={index} card={card} size="md" highlight={highlighted} />;
                    }
                    return rabbitCard ? (
                      <div key={index} className="rabbit-card">
                        <PlayingCard card={rabbitCard} size="md" />
                      </div>
                    ) : (
                      <div key={index} className="card-slot" />
                    );
                  })}
                </div>
                {hand?.extraBoards?.map((board, run) => (
                  <div key={run} className="board board-run" aria-label={`${run + 2}. beh`}>
                    <span className="board-run-label">{run + 2}.</span>
                    {Array.from({ length: 5 }, (_, index) => {
                      const card = board[index];
                      if (index < (hand.runoutBase ?? 0)) {
                        return <div key={index} className="card-slot card-slot-shared" />;
                      }
                      const highlighted = !!card && [...bestCards.values()].some((cards) => cards.includes(card));
                      return card ? <PlayingCard key={index} card={card} size="md" highlight={highlighted} /> : <div key={index} className="card-slot" />;
                    })}
                  </div>
                ))}
                {runVote && <RunVotePanel vote={runVote} players={view.players} youId={view.youId} secondsLeft={Math.max(0, Math.ceil((runVote.deadline - now) / 1000))} onChoose={handlers.onRuns} />}
                {rabbitShown && <div className="rabbit-note">👀 Board odkryl {rabbit!.playerName} · {money(view.settings.bigBlind)} ide do ďalšej ruky</div>}
                {canRabbit && (
                  <button type="button" className="btn btn-chip rabbit-btn" onClick={handlers.onRabbit}>
                    👀 Odkryť board · {money(view.settings.bigBlind)}
                  </button>
                )}
                {hand && !handComplete && hand.totalPot > 0 && (
                  <div className="pot">
                    <span className="chip-icon" /> Pot {money(hand.totalPot)}
                    {hand.pots.length > 1 && <span className="side-pots"> ({hand.pots.map((pot) => money(pot.amount)).join(' + ')})</span>}
                  </div>
                )}
                {hand?.street === 'discard' && discardSeconds !== null && <div className="pot">Zahadzovanie… {discardSeconds} s</div>}
                {piggy && !draw && <PiggyBank piggy={piggy} currency={currency} participants={piggyParticipants} />}
                {result && (
                  <div className="result-banner">
                    <div className="result-title">
                      {uniqueWinnerNames.join(' & ')} {uniqueWinnerNames.length > 1 ? 'delia pot' : 'vyhráva'}
                    </div>
                    {runWinners.length > 1 && (
                      <div className="result-hand">
                        {runWinners.map((names, run) => `${run + 1}. beh: ${names.join(' & ')}`).join(' · ')}
                      </div>
                    )}
                    {result.winners[0]?.handDescription && <div className="result-hand">{result.winners[0].handDescription}</div>}
                    {result.wonWithoutShowdown && <div className="result-hand">ostatní zložili karty</div>}
                    {bountyWinner && (
                      <div className="result-bounty">
                        7-2! {bountyWinner.name} inkasuje bonus {money(result.bounty!.total)}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            {Array.from({ length: MAX_SEATS }, (_, seat) => {
              if (occupied.has(seat)) {
                return null;
              }
              const position = seatPosition((seat - mySeat + MAX_SEATS) % MAX_SEATS, portrait);
              return <EmptySeat key={`empty-${seat}`} position={position} onClick={canMove ? () => handlers.onSeat(seat) : undefined} />;
            })}

            {view.players.map((player) => {
              const piggyRow = !!piggy && inPiggy(piggy, player.id);
              const isMe = player.id === view.youId;
              const stream = isMe ? localStream : streams.get(player.id) ?? null;
              const position = seatPosition((player.seat - mySeat + MAX_SEATS) % MAX_SEATS, portrait, piggyRow, !!stream && player.camera);
              return (
                <Seat
                  key={player.id}
                  player={player}
                  link={isMe ? null : props.links?.get(player.id) ?? null}
                  position={position}
                  isMe={isMe}
                  isTurn={hand?.toActId === player.id}
                  turnClock={hand?.toActId === player.id ? clock : null}
                  showTimeBank={timerOn}
                  isDealer={(!!hand && hand.dealerSeat === player.seat && player.inHand) || (draw?.stage === 'done' && draw.winnerId === player.id)}
                  blind={hand && !handComplete && player.inHand ? (hand.smallBlindSeat === player.seat ? 'SB' : hand.bigBlindSeat === player.seat ? 'BB' : null) : null}
                  stream={stream}
                  winAmount={winAmounts.get(player.id) ?? 0}
                  bestCards={bestCards.get(player.id) ?? []}
                  showdown={!!showdown || runout}
                  currency={currency}
                  drawnCard={drawnCards.get(player.id) ?? null}
                  drawWinner={draw?.stage === 'done' && draw.winnerId === player.id}
                  piggy={piggy && piggyRow ? { wins: piggy.wins?.[player.id] ?? 0, target: piggy.target } : null}
                  piggyWinner={piggyFinished && piggyWinnerIds.has(player.id)}
                  roles={roles}
                  speaking={!!props.speaking?.has(player.id)}
                />
              );
            })}

            {piggyFinished &&
              piggy!.winners.map((winner) => {
                const seat = view.players.find((player) => player.id === winner.playerId)?.seat;
                if (seat === undefined) {
                  return null;
                }
                const position = seatPosition((seat - mySeat + MAX_SEATS) % MAX_SEATS, portrait);
                return <PiggyFlight key={`${piggy!.startedAtHand}-${winner.playerId}`} x={position.x} y={position.y} />;
              })}
          </div>
          {mediaError && <div className="media-error">{mediaError}</div>}
          {toast && <div className="toast">{toast}</div>}
        </main>

        <ChatToasts
          toasts={props.chatToasts ?? noChatToasts}
          players={view.players}
          chatVisible={chatVisible}
          docked={docked}
          onOpenChat={openChat}
          onClear={props.onClearChatToasts ?? noop}
        />

        <div className={chatOpen ? 'side-wrap open' : 'side-wrap'}>
          <SidePanel
            events={events}
            players={view.players}
            ledger={view.ledger}
            currency={currency}
            onSend={handlers.onChat}
            onClose={() => setChatOpen(false)}
            tab={sideTab}
            onTabChange={setSideTab}
            stats={{
              history: view.history ?? [],
              leaderboard: view.leaderboard ?? [],
              youId: view.youId,
              tableCode: view.code,
              initialTab: initialUi?.statsTab,
              cashout: cashoutProps(view, youAreBanker ? handlers.bank : undefined),
            }}
          />
        </div>
      </div>

      <ActionBar
        me={me}
        hand={hand}
        legal={view.legal}
        waitingFor={hand && !handComplete ? toActName : null}
        onAction={handlers.onAction}
        onDiscard={handlers.onDiscard}
        statusText={statusText}
        currency={currency}
        turnClock={hand?.toActId === view.youId && view.legal ? clock : null}
        timeBankSec={timerOn && me && typeof me.timeBankMs === 'number' ? Math.round(me.timeBankMs / 1000) : null}
        cardsShown={handComplete && me && me.cards.length > 0 && view.lastResult?.handNumber === hand?.handNumber ? !!view.lastResult?.revealed[me.id] : null}
        onShowCards={handlers.onShowCards}
        toCall={me && hand ? Math.min(Math.max(0, ...view.players.map((player) => player.bet)) - me.bet, me.stack) : 0}
      />

      {draw?.stage === 'choose' && isHost && <DealerChoiceModal draw={draw} players={view.players} onChoose={handlers.host.dealerChoice} />}
      {draw?.stage === 'explain' && <DrawExplainModal draw={draw} players={view.players} youId={view.youId} secondsLeft={drawSeconds} onAck={handlers.onDrawAck} />}

      {modeIntro && (
        <ModeIntroModal
          key={`${modeIntro.mode}-${modeIntro.deadline}`}
          intro={modeIntro}
          settings={view.settings}
          piggy={piggy}
          players={view.players}
          youId={view.youId}
          secondsLeft={Math.max(0, Math.ceil((modeIntro.deadline - now) / 1000))}
          onAck={handlers.onModeAck}
        />
      )}
      {returnOpen && me?.sittingOut && (
        <ReturnDialog
          me={me}
          settings={view.settings}
          onReturn={handlers.onReturn}
          onStayOut={() => handlers.onSitOut(true)}
          onClose={() => setReturnOpen(false)}
        />
      )}
      {piggyFinished && <Confetti key={`confetti-${piggy!.startedAtHand}`} />}
      {piggyFinished && piggyClosedAt !== piggy!.startedAtHand && (
        <PiggyWonDialog key={`won-${piggy!.startedAtHand}`} piggy={piggy!} currency={currency} youId={view.youId} onClose={() => setPiggyClosedAt(piggy!.startedAtHand)} />
      )}

      {hostOpen && (isHost || youAreBanker) && (
        <HostPanel view={view} actions={handlers.host} bank={handlers.bank} onClose={() => setHostOpen(false)} initialTab={initialUi?.hostTab} />
      )}
    </div>
  );
}

/** Vstup pre záložku Cashout (v čakárni aj v bočnom paneli) — akcie bankára dostane len bankár. */
export function cashoutProps(view: TableView, bank: BankActions | undefined): StatsCashout {
  return {
    ledger: view.ledger ?? [],
    bankerId: bankerIdOf(view),
    bank,
    piggyAmount: (view.piggy?.status === 'running' ? view.piggy.amount : 0) + (view.anteAmount ?? 0),
  };
}

/** Po all-in: hráči v ruke volia 1×/2×/3×; ostatní vidia priebeh. Platí najmenšia voľba. */
function RunVotePanel({ vote, players, youId, secondsLeft, onChoose }: { vote: RunVoteView; players: SeatPlayerView[]; youId: string; secondsLeft: number; onChoose: (runs: number) => void }) {
  const participant = vote.participants.includes(youId);
  const mine = vote.choices[youId];
  const nameOf = (id: string) => players.find((player) => player.id === id)?.name ?? 'Hráč';
  return (
    <div className="run-vote" role="group" aria-label="Koľkokrát ideme">
      <div className="run-vote-title">
        All-in — koľkokrát ideme? <span className="run-vote-time">{secondsLeft} s</span>
      </div>
      {participant && (
        <div className="run-vote-options">
          {Array.from({ length: vote.maxRuns }, (_, index) => index + 1).map((runs) => (
            <button key={runs} type="button" className={mine === runs ? 'btn btn-chip run-vote-option active' : 'btn btn-chip run-vote-option'} onClick={() => onChoose(runs)}>
              {runs}×
            </button>
          ))}
        </div>
      )}
      <div className="run-vote-choices">
        {vote.participants.map((id) => (
          <span key={id} className={vote.choices[id] ? 'run-vote-choice chosen' : 'run-vote-choice'}>
            {nameOf(id)}: {vote.choices[id] ? `${vote.choices[id]}×` : '…'}
          </span>
        ))}
      </div>
    </div>
  );
}
