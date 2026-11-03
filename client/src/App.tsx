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
  Settlement,
  TableDeletedPayload,
  TableEvent,
  TableLeftPayload,
  TableSettings,
  TableMetaPayload,
  TableStateView,
  TableSummary,
  TableView,
} from '../../shared/types';
import { MAX_HISTORY_HANDS, MAX_SUMMARY_REQUEST } from '../../shared/constants';
import { formatMoney } from '../../shared/money';
import { computeCashout } from '../../shared/settlement';
import { Lobby, type LobbyNotice } from './components/Lobby';
import { tableName } from './components/TableTopbar';
import type { TableHandlers } from './components/TableScreen';
import { GameScreen } from './components/WaitingRoom';
import { RemoteAudio } from './components/VideoTile';
import { ConfirmHost, choiceDialog, confirmDialog } from './components/ConfirmDialog';
import { DemoApp } from './demo/DemoApp';
import { useChatToasts } from './hooks/useChatToasts';
import { SIDE_PANEL_DOCKED_QUERY, useMediaQuery } from './hooks/useMediaQuery';
import { useMedia } from './hooks/useMedia';
import { useMesh, type MeshPeer } from './hooks/useMesh';
import { usePushToTalk } from './hooks/usePushToTalk';
import { useChatSound, useGameSounds } from './sound';
import { NO_RESPONSE, emit, socket } from './socket';
import { listSavedTables, loadPendingJoin, loadProfile, loadSession, markTableLeft, savePendingJoin, saveProfile, saveRoomView, saveSession, type Profile } from './storage';
import { PendingJoinScreen } from './components/JoinRequests';
import { useFairShuffle } from './fairness';

/** Chyba `table:resume`, po ktorej sa k stolu už vrátiť nedá (vyhodenie, zmazaný stôl) — vtedy ho zabudneme. */
const SESSION_EXPIRED = 'Relácia vypršala';
/** Informačné oznámenie na úvodnej obrazovke po čase zmizne; varovanie (zmazaný stôl) ostáva, kým ho nezavrieš. */
const NOTICE_INFO_MS = 9000;

interface ResumeResult {
  ok: boolean;
  /** null = nebolo čo obnoviť (žiadny uložený token). */
  error: string | null;
}

/** Čo si pamätáme pri odchode od stola, kým nepríde `table:left` — text oznámenia na úvodnej obrazovke. */
interface PendingLeave {
  code: string;
  notice: string;
}

function codeFromPath(): string | null {
  const match = window.location.pathname.match(/^\/t\/([A-Za-z0-9]{4,8})\/?$/);
  return match ? match[1].toUpperCase() : null;
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
  return <LiveApp />;
}

function LiveApp() {
  const [profile, setProfile] = useState<Profile>(loadProfile);
  const [inviteCode, setInviteCode] = useState<string | null>(codeFromPath);
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
  const [myTables, setMyTables] = useState<TableSummary[]>([]);
  const [leftTables, setLeftTables] = useState<string[]>([]);
  const [tableErrors, setTableErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<LobbyNotice | null>(null);
  const [resumingCode, setResumingCode] = useState<string | null>(null);
  const [resuming, setResuming] = useState(() => {
    const code = codeFromPath();
    return !!code && (!!loadSession(code) || !!loadPendingJoin(code));
  });
  /** Moja žiadosť o prístup, kým ju host neschváli — vtedy zo stola nevidím nič. */
  const [pending, setPending] = useState<PendingJoin | null>(null);
  const pendingRef = useRef<PendingJoin | null>(null);
  pendingRef.current = pending;
  const joinedRef = useRef<JoinResult | null>(null);
  const viewRef = useRef<TableView | null>(null);
  const pendingLeave = useRef<PendingLeave | null>(null);
  const deletingCode = useRef<string | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);
  const noticeTimer = useRef<number | undefined>(undefined);
  const media = useMedia();
  useFairShuffle(joined ? liveView : null, connected);

  joinedRef.current = joined;
  viewRef.current = view;

  const showNotice = useCallback((next: LobbyNotice | null) => {
    setNotice(next);
    window.clearTimeout(noticeTimer.current);
    if (next?.tone === 'info') {
      noticeTimer.current = window.setTimeout(() => setNotice(null), NOTICE_INFO_MS);
    }
  }, []);

  const showToast = useCallback((text: string) => {
    setToast(text);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 3500);
  }, []);

  const updateProfile = (next: Profile) => {
    setProfile(next);
    saveProfile(next);
  };

  const enterTable = useCallback((result: JoinResult) => {
    saveSession(result.code, { playerId: result.playerId, token: result.token });
    setJoined(result);
    setInviteCode(result.code);
    if (codeFromPath() !== result.code) {
      window.history.pushState(null, '', `/t/${result.code}`);
    }
  }, []);

  /**
   * Návrat k stolu s uloženým tokenom (aj po odchode — server ma znova posadí so stackom). Token zabudneme len pri
   * „Relácia vypršala“; pri plnom stole alebo výpadku spojenia ostáva, aby sa dalo skúsiť znova.
   */
  const resume = useCallback(
    async (code: string, standing = false): Promise<ResumeResult> => {
      const stored = loadSession(code);
      if (!stored) {
        return { ok: false, error: null };
      }
      const response = await emit<JoinResult>('table:resume', { code, ...stored, ...(standing ? { standing: true } : {}) });
      if (response.ok && response.data) {
        enterTable(response.data);
        return { ok: true, error: null };
      }
      const error = response.error ?? NO_RESPONSE;
      if (error === SESSION_EXPIRED) {
        saveSession(code, null);
      }
      return { ok: false, error };
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

  /** Zatvorí stôl na klientovi a vráti sa na úvodnú obrazovku (token ostáva, ak ho volajúci nezabudol). */
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

  const loadMyTables = useCallback(async () => {
    const saved = listSavedTables().slice(0, MAX_SUMMARY_REQUEST);
    setLeftTables(saved.filter((table) => table.leftAt !== null).map((table) => table.code));
    if (saved.length === 0) {
      setMyTables([]);
      return;
    }
    const response = await emit<{ summaries: TableSummary[]; missing: string[] }>('table:summaries', {
      items: saved.map(({ code, playerId, token }) => ({ code, playerId, token })),
    });
    if (!response.ok || !response.data) {
      setMyTables([]);
      return;
    }
    for (const code of response.data.missing ?? []) {
      saveSession(code, null);
    }
    const order = new Map(saved.map((table, index) => [table.code, index]));
    setMyTables([...(response.data.summaries ?? [])].sort((left, right) => (order.get(left.code) ?? 0) - (order.get(right.code) ?? 0)));
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
      if (kicked) {
        if (current) {
          saveSession(current.code, null);
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
      if (code) {
        markTableLeft(code);
      }
      setError(null);
      closeTable();
      const name = viewRef.current ? `„${tableName(viewRef.current)}“` : (code ?? '');
      showNotice({ text: leaving?.notice ?? `Už nie si pri stole ${name} — žetóny ostávajú uložené, vrátiš sa cez „Moje stoly“.`, tone: 'info' });
    };
    const onDeleted = ({ code, byName }: TableDeletedPayload) => {
      saveSession(code, null);
      const atTable = joinedRef.current?.code === code;
      const mine = deletingCode.current === code;
      deletingCode.current = null;
      const name = atTable && viewRef.current ? `„${tableName(viewRef.current)}“ (${code})` : code;
      setMyTables((tables) => tables.filter((table) => table.code !== code));
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
      setConnected(true);
      setSelfRtcId(socket.id ?? null);
      if (!joinedRef.current && pendingRef.current) {
        void resumePending(pendingRef.current.code);
      }
      const current = joinedRef.current;
      if (current) {
        resume(current.code).then(({ ok }) => {
          if (!ok) {
            setJoined(null);
            setView(null);
            setError('Spojenie so stolom sa stratilo');
          }
        });
      }
    };
    const onDisconnect = () => setConnected(false);
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
    return () => {
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
    if (code && loadSession(code)) {
      resume(code)
        .then(({ ok, error: failure }) => {
          if (!ok && failure && failure !== SESSION_EXPIRED) {
            setError(failure);
          }
        })
        .finally(() => setResuming(false));
    } else if (code && loadPendingJoin(code)) {
      void resumePending(code).finally(() => setResuming(false));
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

  const resumeSaved = async (code: string) => {
    setResumingCode(code);
    setError(null);
    clearTableError(code);
    // „Pokračovať“ z Moje stoly otvorí čakáreň stola; ku stolu si hráč sadne sám tlačidlom „Späť ku stolu“.
    saveRoomView(code, true);
    const result = await resume(code, true);
    setResumingCode(null);
    if (result.ok) {
      showNotice(null);
      return;
    }
    saveRoomView(code, false);
    if (result.error && result.error !== SESSION_EXPIRED) {
      setTableErrors((errors) => ({ ...errors, [code]: result.error! }));
      return;
    }
    const name = myTables.find((table) => table.code === code)?.name;
    showNotice({ text: `K stolu ${name ? `„${name}“` : code} sa už nedá vrátiť — stôl bol zmazaný alebo ťa host vyhodil.`, tone: 'danger' });
    void loadMyTables();
  };

  const forgetSaved = (code: string) => {
    saveSession(code, null);
    clearTableError(code);
    setMyTables((tables) => tables.filter((table) => table.code !== code));
  };

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
    const response = await emit<JoinResult>('table:create', { name: profile.name, avatar: profile.avatar, settings });
    setBusy(false);
    if (response.ok && response.data) {
      enterTable(response.data);
    } else {
      setError(response.error ?? 'Nepodarilo sa založiť stôl');
    }
  };

  const join = async (code: string) => {
    setBusy(true);
    setError(null);
    const hadSession = !!loadSession(code);
    const resumed = await resume(code);
    if (resumed.ok) {
      setBusy(false);
      return;
    }
    if (hadSession && resumed.error !== SESSION_EXPIRED) {
      // Som členom stola (napr. po odchode) — nový hráč by vznikol navyše a o uložené žetóny by som prišiel.
      setBusy(false);
      setError(resumed.error ?? 'Nepodarilo sa vrátiť ku stolu');
      return;
    }
    const response = await emit<PendingJoin>('table:join', { code, name: profile.name, avatar: profile.avatar });
    setBusy(false);
    if (response.ok && response.data) {
      const request = response.data;
      savePendingJoin(request.code, { requestId: request.requestId, token: request.token });
      setPending(request);
      setInviteCode(request.code);
      if (codeFromPath() !== request.code) {
        window.history.pushState(null, '', `/t/${request.code}`);
      }
    } else {
      setError(response.error ?? 'Nepodarilo sa pripojiť');
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
      markTableLeft(leaving.code);
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
      kick: async (playerId: string) => {
        const name = view?.players.find((player) => player.id === playerId)?.name ?? 'hráča';
        if (await confirmDialog({ title: `Vyhodiť ${name} od stola?`, message: 'Hráč príde o miesto aj účet pri tomto stole.', confirmLabel: 'Vyhodiť', danger: true })) {
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
      piggy: async (action: 'start' | 'cancel') => {
        if (action === 'cancel') {
          const piggy = view?.piggy;
          const amount = piggy ? formatMoney(piggy.amount, view!.settings.currency) : null;
          if (
            !(await confirmDialog({
              title: 'Zrušiť Prasiatko?',
              message: amount ? `Vstupy (spolu ${amount}) sa vrátia hráčom.` : 'Vstupy sa vrátia hráčom.',
              confirmLabel: 'Zrušiť Prasiatko',
              cancelLabel: 'Nechať',
              danger: true,
            }))
          ) {
            return;
          }
        }
        void call('host:piggy', { action });
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
    () => (view?.players ?? []).filter((player) => player.id !== view?.youId && player.connected && player.rtcId).map((player) => ({ playerId: player.id, rtcId: player.rtcId! })),
    [view],
  );
  const pushToTalk = usePushToTalk(media.stream, media.microphone, media.version);
  const { streams, links } = useMesh(!!joined && !!view, selfRtcId, peers, media.stream, media.version, config.iceServers);

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
          links={links}
          localStream={media.stream}
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
          {[...streams.entries()].map(([playerId, stream]) => {
            const player = view.players.find((candidate) => candidate.id === playerId);
            return player?.microphone ? <RemoteAudio key={playerId} stream={stream} /> : null;
          })}
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

  return (
    <>
      <ConfirmHost />
      <Lobby
        profile={profile}
        onProfileChange={updateProfile}
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
        leftTables={leftTables}
        tableErrors={tableErrors}
        myTables={myTables}
        resumingCode={resumingCode}
        onResumeTable={(code) => void resumeSaved(code)}
        onForgetTable={forgetSaved}
      />
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
