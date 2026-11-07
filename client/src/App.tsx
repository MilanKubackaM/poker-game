import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  Ack,
  ClientConfig,
  DealerChoice,
  JoinClosedPayload,
  JoinResult,
  PendingJoin,
  PendingResumeResult,
  NextHandOverride,
  PlayerAction,
  ReturnMode,
  SessionReplacedPayload,
  Settlement,
  TableDeletedPayload,
  TableEvent,
  TableLeftPayload,
  TableSettings,
  TableMetaPayload,
  TableStateView,
  TableView,
} from '../../shared/types';
import type { AccountTablesResponse, AccountView, ArchiveClaimResult, ArchivedTableView, DeviceSeat, TableJoinResponse } from '../../shared/account';
import { MAX_HISTORY_HANDS } from '../../shared/constants';
import { formatMoney } from '../../shared/money';
import { computeCashout } from '../../shared/settlement';
import { Lobby, type LobbyNotice, type LobbyTables } from './components/Lobby';
import { tableName } from './components/TableTopbar';
import type { TableHandlers } from './components/TableScreen';
import { GameScreen } from './components/WaitingRoom';
import { RemoteAudio, hasLiveAudio } from './components/VideoTile';
import { ArchiveScreen } from './components/ArchiveScreen';
import { useSpeakingIds } from './voiceActivity';
import { ConfirmHost, choiceDialog, confirmDialog } from './components/ConfirmDialog';
import { DemoApp } from './demo/DemoApp';
import { useChatToasts } from './hooks/useChatToasts';
import { SIDE_PANEL_DOCKED_QUERY, useMediaQuery } from './hooks/useMediaQuery';
import { useMedia } from './hooks/useMedia';
import { useMesh, type MeshPeer } from './hooks/useMesh';
import { usePushToTalk } from './hooks/usePushToTalk';
import { useChatSound, useGameSounds } from './sound';
import { NO_RESPONSE, emit, socket } from './socket';
import { listSavedTables, loadPendingJoin, rememberInvite, savePendingJoin, saveRoomView, takeRememberedInvite } from './storage';
import { PendingJoinScreen } from './components/JoinRequests';
import { useFairShuffle } from './fairness';
import { AuthScreen } from './account/AuthScreen';
import { ProfileDialog } from './account/ProfileDialog';
import { ResetPasswordScreen, VerifyLinkScreen, readAuthLink, type AuthLink } from './account/LinkScreens';
import { VerifyEmailScreen } from './account/VerifyEmailScreen';
import { startAccount, useAccount } from './account/session';

/** Informačné oznámenie na úvodnej obrazovke po čase zmizne; varovanie (zmazaný stôl) ostáva, kým ho nezavrieš. */
const NOTICE_INFO_MS = 9000;

interface ResumeResult {
  ok: boolean;
  error: string | null;
}

/** Čo si pamätáme pri odchode od stola, kým nepríde `table:left` — text oznámenia na úvodnej obrazovke. */
interface PendingLeave {
  code: string;
  notice: string;
}

/** Otvorený historický stôl (spred účtov) — len na čítanie. */
interface OpenArchive {
  view: ArchivedTableView;
  claimed: boolean;
}

function codeFromPath(): string | null {
  const match = window.location.pathname.match(/^\/t\/([A-Za-z0-9]{4,8})\/?$/);
  return match ? match[1].toUpperCase() : null;
}

/** Pozvánka z adresy; inak pozvánka zapamätaná pred prihlásením (napr. overovací odkaz otvorený v novej karte). */
function initialInviteCode(): string | null {
  const fromPath = codeFromPath();
  const remembered = takeRememberedInvite();
  if (fromPath) {
    return fromPath;
  }
  if (remembered && window.location.pathname === '/') {
    window.history.replaceState(null, '', `/t/${remembered}`);
    return remembered;
  }
  return null;
}

/** Staré miesta pri stoloch v tomto prehliadači (dôkaz pre archív), voliteľne len pre jeden stôl. */
function deviceSeats(code?: string): DeviceSeat[] {
  const seats = listSavedTables();
  return code ? seats.filter((seat) => seat.code === code) : seats;
}

const StatsPage = lazy(() => import('./stats/StatsPage').then((module) => ({ default: module.StatsPage })));

export function App() {
  if (window.location.pathname.replace(/\/+$/, '') === '/stats') {
    return (
      <Suspense fallback={null}>
        <StatsPage />
      </Suspense>
    );
  }
  const demo = new URLSearchParams(window.location.search).get('demo');
  if (demo !== null) {
    return <DemoApp screen={demo} />;
  }
  return <AccountGate />;
}

/**
 * Bez prihlásenia sa nedá hrať: prihlásenie / registrácia → overenie e-mailu → aplikácia. Odkazy z e-mailov
 * (`/verify`, `/reset`) fungujú aj bez prihlásenia. Pozvánka `/t/<KÓD>` prežije prihlásenie aj overenie.
 */
function AccountGate() {
  const { status, account, notice, offline } = useAccount();
  const [link, setLink] = useState<AuthLink | null>(readAuthLink);
  const inviteCode = link ? null : codeFromPath();

  useEffect(() => {
    startAccount();
  }, []);

  useEffect(() => {
    // Overovací token je jednorazový — adresu vyčistíme hneď, aby obnovenie stránky neskúšalo použitý odkaz znova.
    if (link?.kind === 'verify' && window.location.pathname !== '/') {
      window.history.replaceState(null, '', '/');
    }
  }, [link]);

  useEffect(() => {
    if (status !== 'ready' && inviteCode) {
      rememberInvite(inviteCode);
    }
  }, [status, inviteCode]);

  const finishLink = useCallback(() => {
    if (window.location.pathname !== '/') {
      window.history.replaceState(null, '', '/');
    }
    setLink(null);
  }, []);

  if (link?.kind === 'verify') {
    return <VerifyLinkScreen token={link.token} signedIn={status !== 'signed-out'} onDone={finishLink} />;
  }
  if (link?.kind === 'reset') {
    return <ResetPasswordScreen token={link.token} onDone={finishLink} />;
  }
  if (status === 'loading') {
    return <div className="loading-screen">{offline ? 'Server neodpovedá — skúšam sa pripojiť znova…' : 'Prihlasujem…'}</div>;
  }
  if (status === 'signed-out' || !account) {
    return <AuthScreen inviteCode={inviteCode} notice={notice} />;
  }
  if (status === 'unverified') {
    return <VerifyEmailScreen account={account} inviteCode={inviteCode} />;
  }
  return <LiveApp account={account} />;
}

function LiveApp({ account }: { account: AccountView }) {
  const [inviteCode, setInviteCode] = useState<string | null>(initialInviteCode);
  const [joined, setJoined] = useState<JoinResult | null>(null);
  const [liveView, setView] = useState<TableStateView | null>(null);
  const [meta, setMeta] = useState<TableMeta | null>(null);
  const view = useMemo<TableView | null>(() => {
    if (!liveView) {
      return null;
    }
    const current = meta?.code === liveView.code ? meta : null;
    return { ...liveView, ledger: current?.ledger ?? [], history: current?.history ?? [], leaderboard: current?.leaderboard ?? [] };
  }, [liveView, meta]);
  const [events, setEvents] = useState<TableEvent[]>([]);
  const [historyKey, setHistoryKey] = useState(0);
  useGameSounds(view);
  useChatSound(events, joined?.playerId);
  const sidePanelDocked = useMediaQuery(SIDE_PANEL_DOCKED_QUERY);
  const chatToasts = useChatToasts(events, joined?.playerId, historyKey, sidePanelDocked);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [connected, setConnected] = useState(socket.connected);
  const [selfRtcId, setSelfRtcId] = useState<string | null>(socket.id ?? null);
  const [clockOffset, setClockOffset] = useState(0);
  const [config, setConfig] = useState<ClientConfig>({ iceServers: [], httpsPort: null, publicHost: null });
  const [tables, setTables] = useState<LobbyTables | null>(null);
  const tablesRequest = useRef(0);
  const [tableErrors, setTableErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<LobbyNotice | null>(null);
  const [resumingCode, setResumingCode] = useState<string | null>(null);
  const [claimingCode, setClaimingCode] = useState<string | null>(null);
  const [archive, setArchive] = useState<OpenArchive | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const closeProfile = useCallback(() => setProfileOpen(false), []);
  /** Odkaz `/t/<KÓD>` pri načítaní: najprv skúsime návrat (som členom stola), inak sa ukáže pozvánka. */
  const [resuming, setResuming] = useState(() => !!codeFromPath());
  /** Moja žiadosť o prístup, kým ju host neschváli — vtedy zo stola nevidím nič. */
  const [pending, setPending] = useState<PendingJoin | null>(null);
  const pendingRef = useRef<PendingJoin | null>(null);
  pendingRef.current = pending;
  const joinedRef = useRef<JoinResult | null>(null);
  /** Id spojenia, ktorým som sa naposledy naviazal na stôl — server podľa neho pri návrate po výpadku pozná, či stôl medzitým neprevzalo iné zariadenie. */
  const socketIdRef = useRef<string | null>(socket.id ?? null);
  const viewRef = useRef<TableView | null>(null);
  const pendingLeave = useRef<PendingLeave | null>(null);
  const deletingCode = useRef<string | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);
  const noticeTimer = useRef<number | undefined>(undefined);
  const media = useMedia();
  /** Skutočný stav mikrofónu/kamery v tomto okne — po naviazaní na stôl sa pošle serveru (pozri `enterTable`). */
  const mediaFlagsRef = useRef({ camera: media.camera, microphone: media.microphone });
  mediaFlagsRef.current = { camera: media.camera, microphone: media.microphone };
  useFairShuffle(joined ? liveView : null, connected);

  joinedRef.current = joined;
  viewRef.current = view;

  const showNotice = useCallback((next: LobbyNotice | null) => {
    setNotice(next);
    window.clearTimeout(noticeTimer.current);
    if (next?.tone === 'info' && !next.persistent) {
      noticeTimer.current = window.setTimeout(() => setNotice(null), NOTICE_INFO_MS);
    }
  }, []);

  const showToast = useCallback((text: string) => {
    setToast(text);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 3500);
  }, []);

  const enterTable = useCallback((result: JoinResult) => {
    // Server môže mať príznaky z iného okna (alebo ich zhodil pri výpadku spojenia) — podľa nich ostatní púšťajú zvuk
    // a watchdog mesh siete čaká, či tečie. Pošleme skutočný stav tohto okna (meno a avatar idú z účtu).
    void emit('player:update', { ...mediaFlagsRef.current });
    socketIdRef.current = socket.id ?? null;
    setJoined(result);
    setInviteCode(result.code);
    setArchive(null);
    if (codeFromPath() !== result.code) {
      window.history.pushState(null, '', `/t/${result.code}`);
    }
  }, []);

  /**
   * Návrat k stolu podľa účtu (aj po odchode — server ma znova posadí so stackom). `standing` = otvoriť čakáreň,
   * `reconnect` = automatický návrat po výpadku spojenia (server ho odmietne, ak stôl medzitým prevzalo iné zariadenie).
   */
  const resume = useCallback(
    async (code: string, options: { standing?: boolean; reconnect?: { previousSocketId: string | null } } = {}): Promise<ResumeResult> => {
      const response = await emit<JoinResult>('table:resume', {
        code,
        ...(options.standing ? { standing: true } : {}),
        ...(options.reconnect ? { reconnect: true, ...(options.reconnect.previousSocketId ? { previousSocketId: options.reconnect.previousSocketId } : {}) } : {}),
      });
      if (response.ok && response.data) {
        enterTable(response.data);
        return { ok: true, error: null };
      }
      return { ok: false, error: response.error ?? NO_RESPONSE };
    },
    [enterTable],
  );

  /** Návrat k čakajúcej žiadosti o prístup (po obnovení stránky / výpadku); ak ju host medzitým schválil, otvorí stôl. */
  const resumePending = useCallback(
    async (code: string): Promise<void> => {
      const stored = loadPendingJoin(code);
      if (!stored) {
        return;
      }
      const response = await emit<PendingResumeResult>('table:pendingResume', { code, ...stored });
      if (response.ok && response.data) {
        if ('approved' in response.data) {
          savePendingJoin(code, null);
          setPending(null);
          enterTable(response.data.approved);
        } else {
          setPending(response.data.pending);
          setInviteCode(code);
        }
        return;
      }
      if (response.error === NO_RESPONSE) {
        return;
      }
      savePendingJoin(code, null);
      setPending(null);
      setInviteCode(code);
      setError(response.error ?? 'Žiadosť o prístup už neplatí');
    },
    [enterTable],
  );

  /** Zatvorí stôl na klientovi a vráti sa na úvodnú obrazovku. */
  const stopMedia = media.stopAll;
  const closeTable = useCallback(() => {
    const code = joinedRef.current?.code;
    if (code) {
      saveRoomView(code, false);
    }
    joinedRef.current = null;
    stopMedia();
    setJoined(null);
    setView(null);
    setInviteCode(null);
    if (window.location.pathname !== '/') {
      window.history.pushState(null, '', '/');
    }
  }, [stopMedia]);

  /** „Moje stoly“ zo servera; staré miesta z tohto prehliadača idú ako dôkaz pre archív. Platí len posledná odpoveď. */
  const loadMyTables = useCallback(async () => {
    const request = ++tablesRequest.current;
    const response = await emit<AccountTablesResponse>('account:tables', { deviceSeats: deviceSeats() });
    if (request !== tablesRequest.current || !response.ok || !response.data) {
      return;
    }
    setTables({ active: response.data.active ?? [], archived: response.data.archived ?? [] });
  }, []);

  useEffect(() => {
    fetch('/api/config')
      .then((response) => response.json() as Promise<ClientConfig>)
      .then((loaded) => {
        setConfig(loaded);
        (window as unknown as { __HTTPS_PORT__?: number | null }).__HTTPS_PORT__ = loaded.httpsPort;
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const onMeta = (payload: TableMetaPayload) => setMeta((previous) => mergeMeta(previous, payload));
    const onState = (next: TableStateView) => {
      setView(next);
      setClockOffset(next.serverTime - Date.now());
    };
    const onEvent = (event: TableEvent) => setEvents((previous) => [...previous.slice(-199), event]);
    const onHistory = (history: TableEvent[]) => {
      setEvents(history);
      setHistoryKey((key) => key + 1);
    };
    const onLeft = ({ kicked }: TableLeftPayload) => {
      const current = joinedRef.current;
      const leaving = pendingLeave.current;
      pendingLeave.current = null;
      if (!current && !leaving) {
        // Stôl už je zatvorený (napr. po `session:replaced`) — oznámenie o prevzatí neprepíšeme.
        return;
      }
      if (kicked) {
        if (current) {
          saveRoomView(current.code, false);
        }
        joinedRef.current = null;
        setJoined(null);
        setView(null);
        media.stopAll();
        setError('Host ťa vyhodil zo stola');
        return;
      }
      const code = current?.code ?? leaving?.code;
      setError(null);
      closeTable();
      const name = viewRef.current ? `„${tableName(viewRef.current)}“` : (code ?? '');
      showNotice({ text: leaving?.notice ?? `Už nie si pri stole ${name} — žetóny ostávajú uložené, vrátiš sa cez „Moje stoly“.`, tone: 'info' });
    };
    const onDeleted = ({ code, byName }: TableDeletedPayload) => {
      const atTable = joinedRef.current?.code === code;
      const mine = deletingCode.current === code;
      deletingCode.current = null;
      const name = atTable && viewRef.current ? `„${tableName(viewRef.current)}“ (${code})` : code;
      setTables((current) => (current ? { ...current, active: current.active.filter((table) => table.code !== code) } : current));
      if (atTable) {
        pendingLeave.current = null;
        setError(null);
        closeTable();
      }
      if (atTable || mine) {
        showNotice(mine ? { text: `Stôl ${name} bol zmazaný.`, tone: 'info' } : { text: `Stôl ${name} zmazal ${byName}.`, tone: 'danger' });
      }
    };
    const onApproved = (result: JoinResult) => {
      savePendingJoin(result.code, null);
      setPending(null);
      setError(null);
      enterTable(result);
    };
    const onJoinClosed = ({ code, requestId, outcome, byName }: JoinClosedPayload) => {
      if (pendingRef.current?.requestId !== requestId) {
        return;
      }
      savePendingJoin(code, null);
      setPending(null);
      if (outcome === 'cancelled') {
        return;
      }
      setInviteCode(outcome === 'deleted' ? null : code);
      setError(
        outcome === 'rejected'
          ? `${byName ?? 'Host'} tvoju žiadosť o prístup ku stolu zamietol`
          : outcome === 'expired'
            ? 'Žiadosť vypršala — host ju nestihol schváliť. Môžeš požiadať znova.'
            : 'Stôl medzitým zmazali',
      );
    };
    const onConnect = () => {
      const previousSocketId = socketIdRef.current;
      setConnected(true);
      setSelfRtcId(socket.id ?? null);
      if (!joinedRef.current && pendingRef.current) {
        void resumePending(pendingRef.current.code);
      }
      const current = joinedRef.current;
      if (current) {
        // Automatický návrat — ak stôl počas výpadku otvorilo iné zariadenie, server ho odmietne (žiadne preberanie späť).
        resume(current.code, { reconnect: { previousSocketId } }).then(({ ok, error: failure }) => {
          if (ok || joinedRef.current?.code !== current.code) {
            return;
          }
          const name = viewRef.current ? `„${tableName(viewRef.current)}“ (${current.code})` : current.code;
          closeTable();
          showNotice({ text: `Spojenie so stolom ${name} sa stratilo${failure ? ` — ${failure}` : ''}. Vrátiš sa cez „Moje stoly“.`, tone: 'info', persistent: true });
        });
      }
    };
    const onDisconnect = () => setConnected(false);
    /** Ten istý účet otvoril tento stôl na inom zariadení — server nás od stola odpojil. Späť len ručne z „Moje stoly“. */
    const onReplaced = ({ code }: SessionReplacedPayload) => {
      if (!joinedRef.current && pendingRef.current?.code === code) {
        // Tú istú žiadosť o prístup otvorilo iné zariadenie — čaká tam; odtiaľto ju už späť nepreberáme.
        savePendingJoin(code, null);
        setPending(null);
        setInviteCode(null);
        setError(null);
        if (window.location.pathname !== '/') {
          window.history.pushState(null, '', '/');
        }
        showNotice({ text: `Žiadosť o prístup ku stolu ${code} čaká na inom zariadení.`, tone: 'info', persistent: true });
        return;
      }
      if (joinedRef.current?.code !== code) {
        return;
      }
      const name = viewRef.current ? `„${tableName(viewRef.current)}“ (${code})` : code;
      pendingLeave.current = null;
      setError(null);
      // Mikrofón a kameru používa nové zariadenie; closeTable ich tu vypne (bez player:update — stav patrí novému zariadeniu).
      closeTable();
      showNotice({
        text: `Pri stole ${name} hráš na inom zariadení. Ak chceš hrať tu, otvor ho v „Moje stoly“ — to druhé zariadenie sa odpojí.`,
        tone: 'info',
        persistent: true,
      });
    };
    const onIce = ({ iceServers }: Pick<ClientConfig, 'iceServers'>) => {
      if (Array.isArray(iceServers)) {
        setConfig((current) => ({ ...current, iceServers }));
      }
    };
    socket.on('table:state', onState);
    socket.on('table:meta', onMeta);
    socket.on('table:event', onEvent);
    socket.on('table:history', onHistory);
    socket.on('table:left', onLeft);
    socket.on('table:deleted', onDeleted);
    socket.on('table:approved', onApproved);
    socket.on('table:joinClosed', onJoinClosed);
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('rtc:ice', onIce);
    socket.on('session:replaced', onReplaced);
    return () => {
      socket.off('session:replaced', onReplaced);
      socket.off('rtc:ice', onIce);
      socket.off('table:state', onState);
      socket.off('table:meta', onMeta);
      socket.off('table:event', onEvent);
      socket.off('table:history', onHistory);
      socket.off('table:left', onLeft);
      socket.off('table:deleted', onDeleted);
      socket.off('table:approved', onApproved);
      socket.off('table:joinClosed', onJoinClosed);
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
    };
  }, [resume, resumePending, enterTable, closeTable, showNotice]);

  useEffect(() => {
    const code = codeFromPath();
    if (code && loadPendingJoin(code)) {
      void resumePending(code).finally(() => setResuming(false));
    } else if (code) {
      // Člen stola sa vráti rovno (aj po obnovení stránky); inak ostane pozvánka s tlačidlom „Pripojiť sa“.
      resume(code)
        .then(({ ok, error: failure }) => {
          if (!ok && failure === NO_RESPONSE) {
            setError(failure);
          }
        })
        .finally(() => setResuming(false));
    }
    const onPop = () => {
      setInviteCode(codeFromPath());
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [resume, resumePending]);

  const onLobby = !joined && !resuming;
  useEffect(() => {
    if (onLobby) {
      void loadMyTables();
    }
  }, [onLobby, loadMyTables]);

  const clearTableError = (code: string) => {
    setTableErrors((errors) => {
      if (!(code in errors)) {
        return errors;
      }
      const next = { ...errors };
      delete next[code];
      return next;
    });
  };

  const setTableError = (code: string, message: string) => setTableErrors((errors) => ({ ...errors, [code]: message }));

  /** „Pokračovať“ z Moje stoly — otvorí čakáreň stola; ak stôl beží na inom zariadení, server ho tam odpojí. */
  const resumeSaved = async (code: string) => {
    setResumingCode(code);
    setError(null);
    clearTableError(code);
    // Ku stolu si hráč sadne sám tlačidlom „Späť ku stolu“.
    saveRoomView(code, true);
    const result = await resume(code, { standing: true });
    setResumingCode(null);
    if (result.ok) {
      showNotice(null);
      return;
    }
    saveRoomView(code, false);
    setTableError(code, result.error ?? 'K stolu sa nepodarilo vrátiť');
    void loadMyTables();
  };

  const openArchive = async (code: string) => {
    setResumingCode(code);
    clearTableError(code);
    const response = await emit<ArchivedTableView>('archive:view', { code, deviceSeats: deviceSeats(code) });
    setResumingCode(null);
    if (response.ok && response.data) {
      const claimed = tables?.archived.find((table) => table.code === code)?.claimed ?? false;
      setArchive({ view: response.data, claimed });
    } else {
      setTableError(code, response.error ?? 'Archív stola sa nepodarilo otvoriť');
    }
  };

  /** Prevezme staré miesta (z tohto prehliadača) do účtu — jeden stôl alebo všetky neprevzaté. */
  const claimSeats = async (codes: string[], busyCode: string) => {
    const seats = deviceSeats().filter((seat) => codes.includes(seat.code));
    if (seats.length === 0 || claimingCode) {
      return;
    }
    setClaimingCode(busyCode);
    codes.forEach(clearTableError);
    const response = await emit<ArchiveClaimResult>('archive:claim', { seats });
    setClaimingCode(null);
    if (!response.ok || !response.data) {
      const message = response.error ?? 'Stôl sa nepodarilo prevziať';
      codes.forEach((code) => setTableError(code, message));
      return;
    }
    const { claimed, failed } = response.data;
    for (const failure of failed ?? []) {
      setTableError(failure.code, failure.error);
    }
    setArchive((current) => (current && claimed.includes(current.view.code) ? { ...current, claimed: true } : current));
    void loadMyTables();
  };

  const unclaimedCodes = useMemo(() => {
    const withSeat = new Set(deviceSeats().map((seat) => seat.code));
    return (tables?.archived ?? []).filter((table) => !table.claimed && withSeat.has(table.code)).map((table) => table.code);
  }, [tables]);

  const call = useCallback(
    async <T,>(event: string, payload?: unknown): Promise<Ack<T>> => {
      const response = await emit<T>(event, payload);
      if (!response.ok && response.error) {
        showToast(response.error);
      }
      return response;
    },
    [showToast],
  );

  const create = async (settings: Partial<TableSettings>) => {
    setBusy(true);
    setError(null);
    const response = await emit<JoinResult>('table:create', { settings });
    setBusy(false);
    if (response.ok && response.data) {
      enterTable(response.data);
    } else {
      setError(response.error ?? 'Nepodarilo sa založiť stôl');
    }
  };

  /** Pripojenie kódom / pozvánkou: člen stola je hneď pri ňom, inak vznikne žiadosť, ktorú schvaľuje host. */
  const join = async (code: string) => {
    if (busy) {
      return;
    }
    setBusy(true);
    setError(null);
    const response = await emit<TableJoinResponse>('table:join', { code });
    setBusy(false);
    if (!response.ok || !response.data) {
      setError(response.error ?? 'Nepodarilo sa pripojiť');
      return;
    }
    if ('joined' in response.data) {
      enterTable(response.data.joined);
      return;
    }
    const request = response.data.pending;
    savePendingJoin(request.code, { requestId: request.requestId, token: request.token });
    setPending(request);
    setInviteCode(request.code);
    if (codeFromPath() !== request.code) {
      window.history.pushState(null, '', `/t/${request.code}`);
    }
  };

  const cancelPending = async () => {
    const current = pendingRef.current;
    if (!current) {
      return;
    }
    await emit('table:cancelJoin');
    savePendingJoin(current.code, null);
    setPending(null);
    setInviteCode(null);
    if (window.location.pathname !== '/') {
      window.history.pushState(null, '', '/');
    }
  };

  const leave = async () => {
    const current = view;
    if (!current) {
      return;
    }
    const me = current.players.find((player) => player.id === current.youId) ?? null;
    const chips = formatMoney(me?.stack ?? 0, current.settings.currency);
    const handLive = !!current.hand && current.hand.street !== 'complete' && !!me?.inHand && me.status !== 'folded';
    const handNote = !handLive ? '' : me?.status === 'allin' ? ' Rozdaná ruka sa ešte dohrá (si all-in) a výhra sa ti pripíše.' : ' Z rozdanej ruky zložíš karty.';
    const confirmed = await confirmDialog({
      title: 'Opustiť hru?',
      message: `${handNote.trim() ? `${handNote.trim()}\n` : ''}Tvoje žetóny ${chips}, štatistiky aj timebank ostanú pri stole uložené, kým ho host nezmaže — vrátiš sa cez „Moje stoly“ alebo odkaz.`,
      confirmLabel: '🚪 Opustiť hru',
      danger: true,
    });
    if (!confirmed) {
      return;
    }
    const name = `„${tableName(current)}“`;
    pendingLeave.current = {
      code: current.code,
      notice: handLive ? `Žetóny ostávajú uložené pri stole ${name} — sumu uvidíš po dohraní ruky v „Moje stoly“.` : `Žetóny ${chips} ostávajú uložené pri stole ${name}.`,
    };
    const response = await emit('player:leave');
    if (!response.ok) {
      pendingLeave.current = null;
      showToast(response.error ?? 'Od stola sa nepodarilo odísť');
      return;
    }
    const leaving = pendingLeave.current;
    if (leaving) {
      pendingLeave.current = null;
      closeTable();
      showNotice({ text: leaving.notice, tone: 'info' });
    }
  };

  const handlers: TableHandlers = {
    onAction: (action: PlayerAction) => void call('game:action', action),
    onDiscard: (cardIndex: number) => void call('game:discard', { cardIndex }),
    onChat: async (text: string) => {
      const response = await emit('chat:send', { text });
      return response.ok ? null : (response.error ?? 'Správu sa nepodarilo poslať');
    },
    onToggleCamera: async () => {
      const on = await media.toggleCamera();
      void call('player:update', { camera: on });
    },
    onToggleMicrophone: async () => {
      const on = await media.toggleMicrophone();
      void call('player:update', { microphone: on });
    },
    onSitOut: (value: boolean) => void call('player:sitout', { value }),
    onAway: (value: boolean) => void call('player:away', { value }),
    onReturn: (mode: ReturnMode) => void call('player:return', { mode }),
    onModeAck: () => void call('mode:ack', {}),
    onSeat: (seat: number) => void call('seat:take', { seat }),
    onLeave: leave,
    onDrawAck: () => void call('draw:ack'),
    onDrawPick: (index: number) => void call('draw:pick', { index }),
    onShowCards: () => void call('hand:show'),
    onRabbit: () => void call('hand:rabbit'),
    onRuns: (runs: number) => void call('hand:runs', { runs }),
    host: {
      start: () => void call('host:start'),
      pause: () => void call('host:pause'),
      dealerChoice: (mode: DealerChoice) => void call('host:dealerChoice', { mode }),
      saveSettings: async (settings: Partial<TableSettings>) => {
        const response = await emit('host:settings', settings);
        return response.ok ? null : (response.error ?? 'Chyba');
      },
      nextHand: (override: NextHandOverride | null) => void call('host:nextHand', { override }),
      setBanker: async (playerId: string) => {
        if (!view) {
          return;
        }
        const name = view.players.find((player) => player.id === playerId)?.name ?? 'hráča';
        const currentId = view.bankerId || view.hostId;
        const current = view.players.find((player) => player.id === currentId)?.name ?? 'Doterajší bankár';
        const held = cashHeldBy(view, currentId);
        if (held <= 0) {
          if (
            await confirmDialog({
              title: `Spraviť bankárom hráča ${name}?`,
              message: 'Iba bankár dobíja a vyberá žetóny a potvrdzuje platby v cashoute.',
              confirmLabel: '🏦 Spraviť bankárom',
            })
          ) {
            void call('host:setBanker', { playerId });
          }
          return;
        }
        const amount = formatMoney(held, view.settings.currency);
        const choice = await choiceDialog({
          title: `${current} drží ${amount}`,
          message: `Bankár už drží peniaze za dobitia. Odovzdá ich novému bankárovi (${name}), alebo si ich ponechá a v cashoute ich rozdá sám?`,
          choices: [
            { value: 'keep', label: `Nechať u ${current}` },
            { value: 'move', label: `Odovzdať ${amount} → ${name}` },
          ],
        });
        if (choice) {
          void call('host:setBanker', { playerId, moveCash: choice === 'move' });
        }
      },
      kick: async (playerId) => {
        const seated = view?.players.find((player) => player.id === playerId);
        const member = seated ?? view?.departed?.find((departed) => departed.id === playerId);
        const name = member?.name ?? 'hráča';
        const handLive = !!view?.hand && view.hand.street !== 'complete' && !!seated?.inHand && seated.status !== 'folded';
        const chips = member && view ? formatMoney(member.stack, view.settings.currency) : null;
        if (
          await confirmDialog({
            title: `Vyhodiť ${name} od stola?`,
            message: [
              handLive ? 'Z rozohranej ruky hneď zloží karty.' : null,
              `${chips ? `Žetóny (${chips}) ostanú` : 'Žetóny ostanú'} v transakciách ako odchod a vyrovnajú sa v cashoute.`,
              'Späť ku stolu sa dostane len so súhlasom hosta.',
            ]
              .filter(Boolean)
              .join('\n'),
            confirmLabel: 'Vyhodiť',
            danger: true,
          })
        ) {
          void call('host:kick', { playerId });
        }
      },
      setAdmin: async (playerId: string, admin: boolean) => {
        const name = view?.players.find((player) => player.id === playerId)?.name ?? 'hráčovi';
        const prompt = admin
          ? {
              title: `Dať hráčovi ${name} práva hosta?`,
              message: 'Bude môcť spúšťať a pozastavovať hru, meniť pravidlá a vyhadzovať hráčov.',
              confirmLabel: '★ Dať práva',
            }
          : playerId === view?.youId
            ? { title: 'Vzdať sa práv hosta?', message: 'Vrátiť ti ich môže iný host.', confirmLabel: 'Vzdať sa' }
            : null;
        if (!prompt || (await confirmDialog(prompt))) {
          void call('host:setAdmin', { playerId, admin });
        }
      },
      piggy: async (command) => {
        if (command.action === 'cancel') {
          const piggy = view?.piggy;
          const amount = piggy ? formatMoney(piggy.amount, view!.settings.currency) : null;
          if (
            !(await confirmDialog({
              title: 'Zrušiť Prasiatko hneď?',
              message: `${amount ? `Vstupy (spolu ${amount}) sa vrátia hráčom.` : 'Vstupy sa vrátia hráčom.'}${piggy?.series && (piggy.series.permanent || piggy.series.remaining > 1) ? ' Ďalšie hry série sa už nespustia.' : ''}`,
              confirmLabel: 'Zrušiť Prasiatko',
              cancelLabel: 'Nechať',
              danger: true,
            }))
          ) {
            return;
          }
        }
        void call('host:piggy', command);
      },
      toLobby: async () => {
        const handRunning = !!view?.hand && view.hand.street !== 'complete';
        if (
          await confirmDialog({
            title: 'Ukončiť hru a vrátiť stôl do čakárne?',
            message: handRunning ? 'Rozdaná ruka sa ešte dohrá, potom sa hra zastaví.' : undefined,
            confirmLabel: 'Ukončiť hru',
          })
        ) {
          void call('host:toLobby');
        }
      },
      resolveJoin: (requestId: string, approve: boolean) => void call('host:joinRequest', { requestId, approve }),
      deleteTable: async (code: string) => {
        deletingCode.current = code;
        const response = await emit('host:deleteTable', { code });
        if (!response.ok) {
          deletingCode.current = null;
          return response.error ?? 'Stôl sa nepodarilo zmazať';
        }
        return null;
      },
    },
    bank: {
      chips: async (playerId: string, amount: number, settlement: Settlement, note: string) => {
        const response = await emit('bank:chips', { playerId, amount, settlement, note });
        return response.ok ? null : (response.error ?? 'Žetóny sa nepodarilo zmeniť');
      },
      settle: async (kind: 'debt' | 'payout', fromId: string, toId: string, amount: number) => {
        const response = await emit('bank:settle', { kind, fromId, toId, amount });
        return response.ok ? null : (response.error ?? 'Platbu sa nepodarilo uložiť');
      },
      undo: async (entryId: number) => {
        const response = await emit('bank:undo', { entryId });
        return response.ok ? null : (response.error ?? 'Platbu sa nepodarilo zrušiť');
      },
    },
  };

  const peers: MeshPeer[] = useMemo(
    () =>
      (view?.players ?? [])
        .filter((player) => player.id !== view?.youId && player.connected && player.rtcId)
        .map((player) => ({ playerId: player.id, rtcId: player.rtcId!, microphone: player.microphone })),
    [view],
  );
  const pushToTalk = usePushToTalk(media.stream, media.microphone, media.version);
  const { streams } = useMesh(!!joined && !!view, selfRtcId, peers, media.stream, media.version, config.iceServers);
  const voiceSources = useMemo(() => {
    const sources = new Map<string, MediaStream>();
    if (!view) {
      return sources;
    }
    for (const [playerId, stream] of streams) {
      if (view.players.find((player) => player.id === playerId)?.microphone) {
        sources.set(playerId, stream);
      }
    }
    if (media.microphone && media.stream) {
      sources.set(view.youId, media.stream);
    }
    return sources;
  }, [view, streams, media.microphone, media.stream, media.version]);
  const speaking = useSpeakingIds(voiceSources);

  if (joined && view) {
    const isLocalhost = ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname);
    const inviteOrigin =
      isLocalhost && config.publicHost
        ? config.httpsPort
          ? `https://${config.publicHost}:${config.httpsPort}`
          : `http://${config.publicHost}:${window.location.port || 80}`
        : window.location.origin;
    const inviteUrl = `${inviteOrigin}/t/${view.code}`;
    return (
      <>
        <ConfirmHost />
        {!connected && <div className="connection-banner">Spojenie prerušené — pripájam sa znova…</div>}
        <GameScreen
          view={view}
          events={events}
          streams={streams}
          localStream={media.stream}
          speaking={speaking}
          camera={media.camera}
          microphone={media.microphone}
          mediaError={media.error}
          clockOffset={clockOffset}
          handlers={handlers}
          inviteUrl={inviteUrl}
          toast={toast}
          chatToasts={chatToasts.toasts}
          onClearChatToasts={chatToasts.clear}
          pushToTalk={pushToTalk}
        />
        <div className="remote-audio" aria-hidden>
          {[...streams.entries()].map(([playerId, stream]) => (hasLiveAudio(stream) ? <RemoteAudio key={playerId} stream={stream} playerId={playerId} /> : null))}
        </div>
      </>
    );
  }

  if (pending && !joined) {
    return <PendingJoinScreen code={pending.code} onCancel={() => void cancelPending()} />;
  }

  if (resuming || (joined && !view)) {
    return <div className="loading-screen">Pripájam sa ku stolu…</div>;
  }

  if (archive) {
    const archiveCode = archive.view.code;
    const canClaim = !archive.claimed && unclaimedCodes.includes(archiveCode);
    return (
      <>
        <ConfirmHost />
        <ArchiveScreen
          view={archive.view}
          claimed={archive.claimed}
          onClaim={canClaim ? () => void claimSeats([archiveCode], archiveCode) : undefined}
          claiming={claimingCode === archiveCode}
          onClose={() => setArchive(null)}
        />
      </>
    );
  }

  return (
    <>
      <ConfirmHost />
      <Lobby
        account={account}
        onOpenProfile={() => setProfileOpen(true)}
        inviteCode={inviteCode}
        busy={busy}
        error={error}
        onCreate={create}
        onJoin={join}
        onCancelInvite={() => {
          setInviteCode(null);
          setError(null);
          window.history.pushState(null, '', '/');
        }}
        notice={notice}
        onDismissNotice={() => showNotice(null)}
        tables={tables}
        tableErrors={tableErrors}
        resumingCode={resumingCode}
        claimingCode={claimingCode}
        onResumeTable={(code) => void resumeSaved(code)}
        onOpenArchive={(code) => void openArchive(code)}
        onClaim={(code) => void claimSeats([code], code)}
        onClaimAll={unclaimedCodes.length > 1 ? () => void claimSeats(unclaimedCodes, '*') : undefined}
      />
      {profileOpen && <ProfileDialog account={account} onClose={closeProfile} />}
    </>
  );
}

interface TableMeta {
  code: string;
  ledger: TableView['ledger'];
  history: TableView['history'];
  leaderboard: TableView['leaderboard'];
}

/** `table:meta`: `full` nahradí všetko, inak sa pripoja len nové položky (server ich môže poslať aj duplicitne). */
function mergeMeta(previous: TableMeta | null, payload: TableMetaPayload): TableMeta {
  if (payload.full || !previous || previous.code !== payload.code) {
    return { code: payload.code, ledger: payload.ledger, history: payload.history, leaderboard: payload.leaderboard ?? previous?.leaderboard ?? [] };
  }
  const lastLedgerId = previous.ledger.at(-1)?.id ?? 0;
  const newLedger = payload.ledger.filter((entry) => entry.id > lastLedgerId);
  const lastHand = previous.history.at(-1)?.handNumber ?? 0;
  const newHistory = payload.history.filter((entry) => entry.handNumber > lastHand);
  return {
    code: payload.code,
    ledger: newLedger.length ? [...previous.ledger, ...newLedger] : previous.ledger,
    history: newHistory.length ? [...previous.history, ...newHistory].slice(-MAX_HISTORY_HANDS) : previous.history,
    leaderboard: payload.leaderboard ?? previous.leaderboard,
  };
}

/** Hotovosť, ktorú člen drží z hry (bankár) — z rovnakého výpočtu ako cashout na serveri. */
function cashHeldBy(view: TableView, playerId: string): number {
  const members = (view.leaderboard ?? []).map((row) => ({ playerId: row.playerId, playerName: row.playerName, stack: row.stack }));
  return computeCashout(view.ledger ?? [], members).rows.find((row) => row.playerId === playerId)?.holds ?? 0;
}
