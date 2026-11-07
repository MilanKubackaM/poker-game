import { useEffect, useRef, useState } from 'react';
import type { SeatPlayerView, TableView } from '../../../shared/types';
import { MIN_PLAYERS_TO_START, VARIANT_LABELS } from '../../../shared/constants';
import { formatMoney } from '../../../shared/money';
import { isAdmin, isOwner } from '../roles';
import { PlayerActionsMenu, PlayerMoneySection, RoleBadge, playerRoles, useDebts } from './HostPlayers';
import { turnTimeLabel } from './HostPanel';
import { RulesForm } from './HostRules';
import { DeleteTableButton } from './DeleteTable';
import { SidePanel } from './SidePanel';
import { Stats, type StatsTab } from './Stats';
import { ChatToasts } from './ChatToasts';
import { TableScreen, cashoutProps, useSidePanelState, type TableScreenProps } from './TableScreen';
import { TableTopbar, tableName, useCopyInvite } from './TableTopbar';
import { PiggyDots, PiggySvg, inPiggy, piggySeriesLabel } from './GameModes';
import { owesBlinds, playerStateLabel, returnModeOf } from './PlayerPause';
import { loadRoomView, saveRoomView } from '../storage';
import { confirmDialog } from './ConfirmDialog';
import { AvatarFace } from './AvatarPicker';
import { VideoTile } from './VideoTile';
import { PendingPlayerCards } from './JoinRequests';

/**
 * Pred prvou rukou (fáza `lobby`) ukáže čakaciu miestnosť, inak hrací stôl. Počas hry sa dá od stola odísť do čakárne
 * (hráč vstane, hra beží ďalej) a z nej sa vrátiť späť; voľba sa pamätá pre túto kartu prehliadača.
 */
export function GameScreen(props: TableScreenProps) {
  const { view, handlers } = props;
  const [roomView, setRoomViewState] = useState(() => !!props.initialUi?.roomView || loadRoomView(view.code));
  const [returnOnTable, setReturnOnTable] = useState(false);
  const inLobby = view.phase === 'lobby';
  const me = view.players.find((player) => player.id === view.youId) ?? null;

  const setRoomView = (value: boolean) => {
    saveRoomView(view.code, value);
    setRoomViewState(value);
  };

  const standInRoom = roomView && view.phase === 'playing' && !!me && (!me.sittingOut || returnModeOf(me) !== null);
  useEffect(() => {
    // V čakárni počas hry hráč stojí: zruší sa automatický návrat (čakanie na BB) aj rozohraná ruka po návrate z „Moje stoly“.
    if (standInRoom) {
      handlers.onSitOut(true);
    }
  }, [standInRoom]);

  useEffect(() => {
    if (inLobby && loadRoomView(view.code)) {
      saveRoomView(view.code, false);
      setRoomViewState(false);
    }
  }, [inLobby, view.code]);

  if (inLobby || (roomView && view.phase === 'playing')) {
    const backToTable = () => {
      setRoomView(false);
      if (owesBlinds(me)) {
        setReturnOnTable(true);
      } else if (me?.sittingOut) {
        handlers.onSitOut(false);
      }
    };
    return <WaitingRoom {...props} onBackToTable={inLobby ? undefined : backToTable} />;
  }

  const openRoom = async () => {
    if (!me?.sittingOut) {
      const handLive = !!view.hand && view.hand.street !== 'complete' && me?.inHand && me.status !== 'folded';
      const handNote = !handLive ? undefined : me?.status === 'allin' ? 'Rozohraná ruka sa dohrá (si all-in).' : 'Rozohranú ruku za teba dohrá automatický ťah (check alebo fold).';
      const confirmed = await confirmDialog({
        title: 'Odísť od stola do čakárne?',
        message: handNote,
        confirmLabel: '🚪 Odísť do čakárne',
      });
      if (!confirmed) {
        return;
      }
      handlers.onSitOut(true);
    }
    setReturnOnTable(false);
    setRoomView(true);
  };
  const initialUi = returnOnTable ? { ...props.initialUi, returnOpen: true } : props.initialUi;
  return <TableScreen {...props} initialUi={initialUi} onOpenRoom={openRoom} />;
}

/** Hráč sa počíta do štartu, ak nemá pauzu a má žetóny (rovnako ako server). */
function isReady(player: SeatPlayerView): boolean {
  return !player.sittingOut && player.stack > 0;
}

export function WaitingRoom(props: TableScreenProps) {
  const { view, events, streams, localStream, camera, microphone, mediaError, handlers, inviteUrl, initialUi, toast } = props;
  const { chatOpen, setChatOpen, sideTab, setSideTab, chatVisible, openChat, docked } = useSidePanelState(initialUi);
  const { copied, copy } = useCopyInvite(inviteUrl);
  const [statsTab, setStatsTab] = useState<StatsTab>(initialUi?.statsTab ?? 'leaderboard');
  const statsRef = useRef<HTMLElement>(null);
  const isHost = isAdmin(view);
  const roles = playerRoles(view);
  const history = view.history ?? [];
  const leaderboard = view.leaderboard ?? [];
  const me = view.players.find((player) => player.id === view.youId) ?? null;
  const currency = view.settings.currency;
  const money = (cents: number) => formatMoney(cents, currency);
  const readyCount = view.players.filter(isReady).length;
  const canStart = readyCount >= MIN_PLAYERS_TO_START;
  const gameRunning = view.phase !== 'lobby';
  const handRunning = gameRunning && !!view.hand && view.hand.street !== 'complete';
  const backToTable = props.onBackToTable;
  const players = [...view.players].sort((left, right) => Number(right.id === view.youId) - Number(left.id === view.youId) || left.seat - right.seat);
  const ledger = view.ledger ?? [];
  const debts = useDebts(view);
  const cashout = cashoutProps(view, roles.youAreBanker ? handlers.bank : undefined);

  useEffect(() => {
    if (initialUi?.statsTab) {
      statsRef.current?.scrollIntoView({ block: 'start' });
    }
  }, [initialUi?.statsTab]);

  return (
    <div className="table-screen room-screen">
      <TableTopbar
        view={view}
        inviteUrl={inviteUrl}
        camera={camera}
        microphone={microphone}
        me={me}
        onToggleCamera={handlers.onToggleCamera}
        onToggleMicrophone={handlers.onToggleMicrophone}
        onToggleChat={() => setChatOpen(!chatOpen)}
        onOpenStats={() => statsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
        onSitOut={handlers.onSitOut}
        onAway={handlers.onAway}
        onReturn={backToTable ?? (() => (owesBlinds(me) ? handlers.onReturn('wait-bb') : handlers.onSitOut(false)))}
        onLeave={handlers.onLeave}
        pushToTalk={props.pushToTalk}
        leaveLabel="Opustiť hru"
        leaveHint="Žetóny aj štatistiky ostanú pri stole, kým ho host nezmaže"
        initialMenuOpen={initialUi?.menuOpen}
        initialHelpChapter={initialUi?.helpChapter}
      />

      <div className="table-layout">
        <main className="room-main">
          <div className="room">
            <section className="panel room-hero">
              <div className="room-intro">
                <span className="room-kicker">
                  Čakacia miestnosť · kód <span className="room-code">{view.code}</span>
                </span>
                <h1>{tableName(view)}</h1>
                <p className="muted">
                  {VARIANT_LABELS[view.settings.defaultVariant]} · blindy {money(view.settings.smallBlind)}/{money(view.settings.bigBlind)}
                </p>
              </div>
              <div className="room-invite">
                <span className="room-label">Pozvi kamarátov — pošli im odkaz alebo kód</span>
                <div className="room-link">
                  <input readOnly value={inviteUrl} aria-label="Odkaz na pozvánku" onFocus={(event) => event.target.select()} />
                  <button type="button" className="btn btn-secondary" onClick={copy}>
                    {copied ? '✓ Skopírované' : '🔗 Kopírovať'}
                  </button>
                </div>
              </div>
              <div className="room-start">
                {gameRunning ? (
                  <div className="room-running">
                    <span className="room-waiting">
                      <span className="dot dot-live" />
                      <span>
                        <strong>Hra prebieha — si mimo hry</strong>
                      </span>
                    </span>
                    {backToTable && (
                      <button type="button" className="btn btn-primary btn-big room-start-btn" onClick={backToTable}>
                        🎲 Späť ku stolu
                      </button>
                    )}
                  </div>
                ) : isHost ? (
                  <>
                    <button type="button" className="btn btn-primary btn-big room-start-btn" disabled={!canStart} onClick={handlers.host.start}>
                      ▶ Spustiť hru
                    </button>
                    <span className={canStart ? 'room-start-hint ready' : 'room-start-hint'}>
                      {canStart
                        ? `Pripravení hráči so žetónmi: ${readyCount}`
                        : `Čaká sa na aspoň ${MIN_PLAYERS_TO_START} hráčov so žetónmi (zatiaľ ${readyCount})`}
                    </span>
                  </>
                ) : (
                  <div className="room-waiting">
                    <span className="dot dot-live" />
                    <span>
                      <strong>Čaká sa, kým host spustí hru</strong>
                      <span className="room-start-hint">
                        {canStart ? `Pripravení hráči so žetónmi: ${readyCount}` : `Na štart treba aspoň ${MIN_PLAYERS_TO_START} hráčov so žetónmi (zatiaľ ${readyCount})`}
                      </span>
                    </span>
                  </div>
                )}
              </div>
            </section>

            <PiggySummary view={view} />

            <section className="room-players" aria-label="Hráči">
              <div className="room-section-head">
                <h2>Hráči pri stole</h2>
                <span className="muted">
                  {view.players.length}
                  {(view.joinRequests ?? []).length > 0 && ` · ${view.joinRequests.length} čaká na schválenie`}
                </span>
              </div>
              <div className="room-player-grid">
                {players.map((player) => {
                  const isMe = player.id === view.youId;
                  const stream = isMe ? localStream : streams.get(player.id) ?? null;
                  const showVideo = !!stream && player.camera;
                  const classes = ['room-player'];
                  if (!player.connected) {
                    classes.push('offline');
                  }
                  if (isMe) {
                    classes.push('me');
                  }
                  return (
                    <article key={player.id} className={classes.join(' ')}>
                      <div className="room-player-top">
                        <div className={props.speaking?.has(player.id) ? 'room-portrait speaking' : 'room-portrait'} style={{ background: player.avatar.color }} title={props.speaking?.has(player.id) ? 'Práve hovorí' : undefined}>
                          {showVideo ? <VideoTile stream={stream} mirrored={isMe} /> : <AvatarFace avatar={player.avatar} emojiClassName="room-emoji" />}
                          <span className={player.connected ? 'presence online' : 'presence'} title={player.connected ? 'online' : 'offline'} />
                        </div>
                        <div className="room-player-info">
                          <div className="room-player-name">
                            <RoleBadge playerId={player.id} roles={roles} />
                            <span className="room-player-name-text">{player.name}</span>
                            {isMe && <span className="room-you">ty</span>}
                          </div>
                          <div className="room-player-stack">
                            <span>{money(player.stack)}</span>
                            {player.stack <= 0 && <span className="badge badge-empty">bez žetónov</span>}
                          </div>
                          <div className="room-player-tags">
                            <span className={player.connected ? 'presence-text online' : 'presence-text'}>{player.connected ? 'online' : 'offline'}</span>
                            {player.id === roles.ownerId && <span className="badge badge-host badge-role">host</span>}
                            {player.id !== roles.ownerId && roles.isAdmin(player.id) && <span className="badge badge-cohost">spoluhost</span>}
                            {player.id === roles.bankerId && <span className="badge badge-banker">bankár</span>}
                            {stateLabel(player)}
                            {player.camera && <span className="room-cam" title="Kamera zapnutá">📹</span>}
                          </div>
                        </div>
                        {isHost && <PlayerActionsMenu player={player} view={view} actions={handlers.host} roles={roles} />}
                      </div>
                      <PlayerMoneySection player={player} view={view} ledger={ledger} debt={debts.get(player.id) ?? 0} bank={handlers.bank} handRunning={handRunning} />
                    </article>
                  );
                })}
                <PendingPlayerCards view={view} onResolve={handlers.host.resolveJoin} />
              </div>
            </section>

            {isHost && (view.departed ?? []).length > 0 && (
              <section className="room-players departed-section" aria-label="Odišli od stola">
                <div className="room-section-head">
                  <h2>Odišli od stola</h2>
                  <span className="muted">{view.departed.length}</span>
                </div>
                <p className="departed-note">Žetóny majú uložené — keď sa vráti, sadne si na svoje miesto aj z iného zariadenia.</p>
                <div className="room-player-grid">
                  {view.departed.map((member) => (
                    <article key={member.id} className="room-player offline departed">
                      <div className="room-player-top">
                        <div className="room-portrait" style={{ background: member.avatar.color }}>
                          <AvatarFace avatar={member.avatar} emojiClassName="room-emoji" />
                        </div>
                        <div className="room-player-info">
                          <div className="room-player-name">
                            <RoleBadge playerId={member.id} roles={roles} />
                            <span className="room-player-name-text">{member.name}</span>
                          </div>
                          <div className="room-player-stack">
                            <span>uložené {money(member.stack)}</span>
                          </div>
                          <div className="room-player-tags">
                            <span className="badge badge-left">mimo stola</span>
                          </div>
                        </div>
                        <PlayerActionsMenu player={member} view={view} actions={handlers.host} roles={roles} />
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            )}

            <section className="panel room-rules">
              <h2>Pravidlá stola</h2>
              {isHost ? <RulesForm view={view} actions={handlers.host} /> : <RulesSummary view={view} />}
            </section>

            <section className={history.length > 0 ? 'panel room-stats room-stats-top' : 'panel room-stats'} ref={statsRef} aria-label="Štatistiky stola">
              <div className="room-section-head">
                <h2>Výsledky stola</h2>
                {history.length > 0 && <span className="muted">{history.length === 1 ? '1 odohraná ruka' : history.length < 5 ? `${history.length} odohrané ruky` : `${history.length} odohraných rúk`}</span>}
              </div>
              <Stats history={history} leaderboard={leaderboard} currency={currency} youId={view.youId} tab={statsTab} onTabChange={setStatsTab} cashout={cashout} tableCode={view.code} />
            </section>

            <section className="panel room-exit" aria-label="Opustiť hru">
              <div>
                <h2>Opustiť hru</h2>
              </div>
              <div className="room-exit-actions">
                {isOwner(view) && <DeleteTableButton view={view} onDelete={handlers.host.deleteTable} initialOpen={initialUi?.deleteOpen} />}
                <button type="button" className="btn btn-secondary room-exit-btn" onClick={handlers.onLeave}>
                  🚪 Opustiť hru
                </button>
              </div>
            </section>
          </div>
          {mediaError && <div className="media-error">{mediaError}</div>}
          {toast && <div className="toast">{toast}</div>}
        </main>

        <ChatToasts
          toasts={props.chatToasts ?? []}
          players={view.players}
          chatVisible={chatVisible}
          docked={docked}
          onOpenChat={openChat}
          onClear={props.onClearChatToasts ?? (() => undefined)}
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
          />
        </div>
      </div>
    </div>
  );
}

function stateLabel(player: SeatPlayerView) {
  const label = playerStateLabel(player);
  return label ? (
    <span className={label.className} title={label.title}>
      {label.text}
    </span>
  ) : null;
}

/** Bežiace prasiatko — suma a krúžky hráčov (zachová sa aj pri návrate do čakárne). */
function PiggySummary({ view }: { view: TableView }) {
  const piggy = view.piggy;
  if (!piggy) {
    return null;
  }
  const money = (cents: number) => formatMoney(cents, view.settings.currency);
  const players = view.players.filter((player) => inPiggy(piggy, player.id)).sort((left, right) => (piggy.wins?.[right.id] ?? 0) - (piggy.wins?.[left.id] ?? 0));
  return (
    <section className="panel room-piggy" aria-label="Prasiatko">
      <PiggySvg fill={0.6} className="room-piggy-svg" />
      <div className="room-piggy-body">
        <div className="room-piggy-head">
          <h2>Prasiatko</h2>
          <strong className="room-piggy-amount">{money(piggy.amount)}</strong>
          <span className="muted">
            vstup {money(piggy.entry)} na ruku · prvý s {piggy.target} krúžkami berie všetko
            {piggySeriesLabel(piggy) && ` · ${piggySeriesLabel(piggy)}`}
          </span>
        </div>
        {players.length > 0 && (
          <ul className="room-piggy-list">
            {players.map((player) => (
              <li key={player.id}>
                <span>{player.name}</span>
                <PiggyDots wins={piggy.wins?.[player.id] ?? 0} target={piggy.target} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function RulesSummary({ view }: { view: TableView }) {
  const { settings } = view;
  const money = (cents: number) => formatMoney(cents, settings.currency);
  const rows: [string, string][] = [
    ['Variant', VARIANT_LABELS[settings.defaultVariant]],
    ['Blindy', `${money(settings.smallBlind)} / ${money(settings.bigBlind)}`],
    ['Omaha', settings.omahaPotLimit ? 'pot-limit' : 'no-limit'],
    ['Pravidlo 7-2', `${settings.sevenDeuceAlways ? 'zapnuté' : 'vypnuté'} · bonus ${money(settings.sevenDeuceBounty)}`],
    ['Čas na ťah', turnTimeLabel(settings)],
  ];
  return (
    <dl className="rules-summary">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
