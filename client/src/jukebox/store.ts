import { useEffect, useSyncExternalStore } from 'react';
import type { Ack, JukeboxStatePayload, JukeboxView } from '../../../shared/types';
import { parseYouTubeLink } from '../../../shared/jukebox';
import { emit, socket } from '../socket';
import { getSoundPreferences, subscribeSoundPreferences } from '../sound/preferences';
import { YT_STATE, loadYouTubeApi, offscreenMount, playerVars, probeVideo, youTubeErrorMessage, type YouTubePlayer } from './youtube';

/**
 * Jukebox stola na klientovi: stav zo servera, hodiny (posun voči serveru) a jediný skrytý YouTube prehrávač.
 * Žije mimo Reactu, aby hudba nezastala pri prechode čakáreň ↔ stôl (horná lišta sa vtedy pripojí nanovo).
 */
export interface JukeboxSnapshot {
  code: string | null;
  view: JukeboxView | null;
  /** `serverTime − Date.now()` pri poslednom stave — čas servera = `Date.now() + offset`. */
  offset: number;
  /** Prehliadač zablokoval automatické prehrávanie — treba kliknúť na „Zapnúť hudbu“. */
  blocked: boolean;
  /** Práve hranú pesničku YouTube odmietol prehrať. */
  playError: string | null;
}

let snapshot: JukeboxSnapshot = { code: null, view: null, offset: 0, blocked: false, playError: null };
const listeners = new Set<() => void>();

function update(patch: Partial<JukeboxSnapshot>): void {
  snapshot = { ...snapshot, ...patch };
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): JukeboxSnapshot {
  return snapshot;
}

/* ===== Lokálna hlasitosť (každý hráč vlastná, pamätá sa v prehliadači) ===== */

const PREFS_KEY = 'poker-night:jukebox-volume';

export interface JukeboxPreferences {
  /** 0–100 */
  volume: number;
  muted: boolean;
}

const DEFAULT_PREFS: JukeboxPreferences = { volume: 40, muted: false };
/** Jukebox hrá najviac na polovicu hlasitosti YouTube — posuvník 100 % = 50 % prehrávača (hudba nemá prehlušiť hlasy pri stole). */
export const JUKEBOX_MAX_PLAYER_VOLUME = 0.5;

function loadPrefs(): JukeboxPreferences {
  try {
    const stored = JSON.parse(localStorage.getItem(PREFS_KEY) ?? 'null') as Partial<JukeboxPreferences> | null;
    const volume = typeof stored?.volume === 'number' && Number.isFinite(stored.volume) ? Math.round(Math.max(0, Math.min(100, stored.volume))) : DEFAULT_PREFS.volume;
    return { volume, muted: typeof stored?.muted === 'boolean' ? stored.muted : DEFAULT_PREFS.muted };
  } catch {
    return DEFAULT_PREFS;
  }
}

let prefs = loadPrefs();
const prefsListeners = new Set<() => void>();

export function setJukeboxPreferences(patch: Partial<JukeboxPreferences>): void {
  prefs = { ...prefs, ...patch };
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Súkromný režim — nastavenie platí aspoň do zatvorenia stránky.
  }
  for (const listener of prefsListeners) {
    listener();
  }
  applyVolume();
}

function subscribePrefs(listener: () => void): () => void {
  prefsListeners.add(listener);
  return () => prefsListeners.delete(listener);
}

export function useJukeboxPreferences(): JukeboxPreferences {
  return useSyncExternalStore(subscribePrefs, () => prefs, () => prefs);
}

/* ===== Prehrávač ===== */

/** Ako často sa kontroluje, či hudba hrá a nerozišla sa s hodinami servera. */
const SYNC_INTERVAL_MS = 3000;
/** Väčší rozdiel voči serveru sa dorovná pretočením. */
const MAX_DRIFT_SEC = 3;
/** Po takom čase bez rozbehnutia sa ukáže „Zapnúť hudbu“. */
const AUTOPLAY_GRACE_MS = 2500;

let player: YouTubePlayer | null = null;
let removeMount: (() => void) | null = null;
let playerReady = false;
let creating = false;
/** `JukeboxTrack.id` pesničky načítanej v prehrávači. */
let loadedTrackId: string | null = null;
let loadRequestedAt = 0;
let syncTimer: number | undefined;
let gestureListening = false;

function desiredTrack(): NonNullable<JukeboxView['current']> | null {
  const view = snapshot.view;
  return view?.enabled && view.current ? view.current : null;
}

/** Čas servera v ms. */
export function serverNow(offset = snapshot.offset): number {
  return Date.now() + offset;
}

function applyVolume(): void {
  if (!player || !playerReady) {
    return;
  }
  if (prefs.muted || getSoundPreferences().muted) {
    player.mute();
  } else {
    player.unMute();
  }
  player.setVolume(Math.round(prefs.volume * JUKEBOX_MAX_PLAYER_VOLUME));
}

function setBlocked(blocked: boolean): void {
  if (snapshot.blocked !== blocked) {
    update({ blocked });
  }
  if (blocked && !gestureListening) {
    gestureListening = true;
    window.addEventListener('pointerdown', onGesture, true);
    window.addEventListener('keydown', onGesture, true);
  } else if (!blocked && gestureListening) {
    gestureListening = false;
    window.removeEventListener('pointerdown', onGesture, true);
    window.removeEventListener('keydown', onGesture, true);
  }
}

/** Prvé kliknutie / kláves kdekoľvek na stránke skúsi zablokovanú hudbu rozbehnúť. */
function onGesture(): void {
  resumeMusic();
}

/** „Zapnúť hudbu“ — volať priamo z kliknutia (gesto používateľa). */
export function resumeMusic(): void {
  const track = desiredTrack();
  if (!player || !playerReady || !track) {
    return;
  }
  applyVolume();
  player.seekTo(Math.max(0, (serverNow() - track.startedAt) / 1000), true);
  player.playVideo();
  loadRequestedAt = Date.now();
}

function stopPlayback(): void {
  window.clearInterval(syncTimer);
  syncTimer = undefined;
  if (player && playerReady && loadedTrackId) {
    player.stopVideo();
  }
  loadedTrackId = null;
  setBlocked(false);
  if (snapshot.playError) {
    update({ playError: null });
  }
}

function destroyPlayer(): void {
  stopPlayback();
  try {
    player?.destroy();
  } catch {
    // Prehrávač už mohol zaniknúť.
  }
  removeMount?.();
  removeMount = null;
  player = null;
  playerReady = false;
}

function createPlayer(): void {
  creating = true;
  loadYouTubeApi()
    .then((YT) => {
      creating = false;
      if (player || !desiredTrack()) {
        return;
      }
      const { mount, remove } = offscreenMount('jukebox-player');
      removeMount = remove;
      player = new YT.Player(mount, {
        width: 200,
        height: 200,
        playerVars: playerVars(),
        events: {
          onReady: () => {
            playerReady = true;
            syncPlayer();
          },
          onStateChange: ({ data }) => {
            if (data === YT_STATE.PLAYING) {
              setBlocked(false);
            } else if (data === YT_STATE.PAUSED && desiredTrack()) {
              // Pozastaviť sa nedá — napr. prehliadač v pozadí: rozbehne ju znova.
              window.setTimeout(syncPlayer, 300);
            }
          },
          onError: ({ data }) => update({ playError: youTubeErrorMessage(data) }),
          onAutoplayBlocked: () => setBlocked(true),
        },
      });
    })
    .catch(() => {
      creating = false;
      update({ playError: 'YouTube sa nepodarilo načítať' });
    });
}

/** Zosúladí prehrávač so stavom servera: načíta pesničku, dorovná posun, rozbehne pozastavenú, zastaví vypnutý jukebox. */
function syncPlayer(): void {
  const track = desiredTrack();
  const position = track ? (serverNow() - track.startedAt) / 1000 : 0;
  if (!track || position >= track.durationSec) {
    stopPlayback();
    return;
  }
  if (syncTimer === undefined) {
    syncTimer = window.setInterval(syncPlayer, SYNC_INTERVAL_MS);
  }
  if (!player) {
    if (!creating) {
      createPlayer();
    }
    return;
  }
  if (!playerReady) {
    return;
  }
  const startSeconds = Math.max(0, position);
  if (loadedTrackId !== track.id) {
    loadedTrackId = track.id;
    loadRequestedAt = Date.now();
    if (snapshot.playError) {
      update({ playError: null });
    }
    applyVolume();
    player.loadVideoById({ videoId: track.videoId, startSeconds });
    return;
  }
  if (snapshot.playError) {
    return;
  }
  const state = player.getPlayerState();
  if (state === YT_STATE.PLAYING) {
    setBlocked(false);
    if (Math.abs(player.getCurrentTime() - startSeconds) > MAX_DRIFT_SEC) {
      player.seekTo(startSeconds, true);
    }
    return;
  }
  if (state === YT_STATE.BUFFERING || state === YT_STATE.ENDED) {
    return;
  }
  if (state === YT_STATE.PAUSED) {
    player.seekTo(startSeconds, true);
    player.playVideo();
    return;
  }
  // Nerozbehla sa (UNSTARTED / CUED) — prehliadač pravdepodobne blokuje zvuk bez kliknutia.
  if (Date.now() - loadRequestedAt > AUTOPLAY_GRACE_MS) {
    setBlocked(true);
  }
}

subscribeSoundPreferences(applyVolume);

/* ===== Spojenie so serverom ===== */

/** Koľko komponentov sleduje jukebox aktívneho stola. */
let retainCount = 0;
let releaseTimer: number | undefined;
let socketListening = false;
let fetchTimer: number | undefined;

function applyView(view: JukeboxView): void {
  update({ view, offset: view.serverTime - Date.now() });
  syncPlayer();
}

function onState(payload: JukeboxStatePayload): void {
  if (payload?.code === snapshot.code && payload.jukebox) {
    applyView(payload.jukebox);
  }
}

/** Stav zo servera; po obnovení spojenia sa stôl pripojí až o chvíľu — vtedy to skúsi ešte párkrát. */
function fetchState(attempt = 0): void {
  window.clearTimeout(fetchTimer);
  const code = snapshot.code;
  if (!code || !socket.connected) {
    return;
  }
  void emit<JukeboxView>('jukebox:get').then((response) => {
    if (snapshot.code !== code) {
      return;
    }
    if (response.ok && response.data) {
      applyView(response.data);
    } else if (attempt < 3) {
      fetchTimer = window.setTimeout(() => fetchState(attempt + 1), 1500);
    }
  });
}

function listenSocket(): void {
  if (socketListening) {
    return;
  }
  socketListening = true;
  socket.on('jukebox:state', onState);
  socket.on('connect', () => fetchState());
}

function activate(code: string | null): void {
  if (snapshot.code === code) {
    return;
  }
  window.clearTimeout(fetchTimer);
  destroyPlayer();
  update({ code, view: null, offset: 0, blocked: false, playError: null });
  fetchState();
}

/** Sleduje jukebox stola `code`, kým je komponent pripojený (prechod medzi obrazovkami hudbu nepreruší). */
function retain(code: string): () => void {
  listenSocket();
  window.clearTimeout(releaseTimer);
  if (snapshot.code !== code) {
    retainCount = 0;
    activate(code);
  }
  retainCount += 1;
  return () => {
    retainCount -= 1;
    if (retainCount <= 0) {
      retainCount = 0;
      window.clearTimeout(releaseTimer);
      releaseTimer = window.setTimeout(() => {
        if (retainCount === 0) {
          activate(null);
        }
      }, 1000);
    }
  };
}

export function useJukebox(code: string): JukeboxSnapshot {
  useEffect(() => retain(code), [code]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/* ===== Akcie ===== */

/** Host zapne / vypne jukebox pre celý stôl (vypnutie zastaví hudbu a vyprázdni front). */
export function setJukeboxEnabled(enabled: boolean): Promise<Ack> {
  return emit('host:jukebox', { enabled });
}

/** Pridá pesničku z odkazu: overí ho, v skrytom prehrávači zistí názov a dĺžku a pošle ju serveru. */
export async function addJukeboxLink(link: string): Promise<Ack> {
  const videoId = parseYouTubeLink(link);
  if (!videoId) {
    return { ok: false, error: 'Toto nie je odkaz na YouTube video' };
  }
  try {
    const { title, durationSec } = await probeVideo(videoId);
    return await emit('jukebox:add', { videoId, title, durationSec });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Video sa nepodarilo overiť' };
  }
}
