import { JUKEBOX_MAX_DURATION_SEC } from '../../../shared/constants';

/** Minimálne typy YouTube IFrame API (len to, čo jukebox používa). */
export interface YouTubePlayer {
  loadVideoById(options: { videoId: string; startSeconds?: number }): void;
  playVideo(): void;
  pauseVideo(): void;
  stopVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  mute(): void;
  unMute(): void;
  setVolume(volume: number): void;
  getPlayerState(): number;
  getCurrentTime(): number;
  getDuration(): number;
  getVideoData(): { title?: string; isLive?: boolean } | undefined;
  destroy(): void;
}

interface YouTubePlayerEvents {
  onReady?: (event: { target: YouTubePlayer }) => void;
  onStateChange?: (event: { data: number; target: YouTubePlayer }) => void;
  onError?: (event: { data: number; target: YouTubePlayer }) => void;
  onAutoplayBlocked?: (event: { target: YouTubePlayer }) => void;
}

interface YouTubeNamespace {
  Player: new (
    element: HTMLElement,
    options: { width: number; height: number; videoId?: string; host?: string; playerVars: Record<string, string | number>; events: YouTubePlayerEvents },
  ) => YouTubePlayer;
}

declare global {
  interface Window {
    YT?: YouTubeNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

/** `getPlayerState()` */
export const YT_STATE = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 } as const;

let apiPromise: Promise<YouTubeNamespace> | null = null;

/** Načíta YouTube IFrame API (raz, až keď ho jukebox naozaj potrebuje). */
export function loadYouTubeApi(): Promise<YouTubeNamespace> {
  if (window.YT?.Player) {
    return Promise.resolve(window.YT);
  }
  if (!apiPromise) {
    apiPromise = new Promise<YouTubeNamespace>((resolve, reject) => {
      const previous = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        previous?.();
        if (window.YT) {
          resolve(window.YT);
        }
      };
      const script = document.createElement('script');
      script.src = 'https://www.youtube.com/iframe_api';
      script.async = true;
      script.onerror = () => {
        apiPromise = null;
        script.remove();
        reject(new Error('YouTube sa nepodarilo načítať'));
      };
      document.head.appendChild(script);
    });
  }
  return apiPromise;
}

/** Spoločné parametre prehrávača: bez ovládania, klávesnice, celej obrazovky a odporúčaní. */
export function playerVars(): Record<string, string | number> {
  return { autoplay: 0, controls: 0, disablekb: 1, playsinline: 1, rel: 0, fs: 0, iv_load_policy: 3, modestbranding: 1, origin: window.location.origin };
}

/**
 * Kontajner prehrávača mimo obrazovky — aspoň 200×200 px a nie `display:none`, inak YouTube video nespustí.
 * Vráti element, ktorý API nahradí iframe-om.
 */
export function offscreenMount(className: string): { mount: HTMLElement; remove: () => void } {
  const wrapper = document.createElement('div');
  wrapper.className = `jukebox-offscreen ${className}`;
  wrapper.setAttribute('aria-hidden', 'true');
  // Aj inline — nesmie závisieť od načítania CSS.
  Object.assign(wrapper.style, { position: 'fixed', left: '-10000px', top: '0', width: '200px', height: '200px', overflow: 'hidden', pointerEvents: 'none' });
  const mount = document.createElement('div');
  wrapper.appendChild(mount);
  document.body.appendChild(wrapper);
  return { mount, remove: () => wrapper.remove() };
}

/** Text chyby YouTube prehrávača (kód z `onError`). */
export function youTubeErrorMessage(code: number): string {
  switch (code) {
    case 2:
      return 'Neplatný odkaz na YouTube video';
    case 5:
      return 'Video sa v tomto prehliadači nedá prehrať';
    case 100:
      return 'Video neexistuje alebo je súkromné';
    case 101:
    case 150:
    case 153:
      return 'Toto video sa nedá prehrať mimo YouTube';
    default:
      return 'Video sa nedá prehrať';
  }
}

const PROBE_TIMEOUT_MS = 15_000;

/**
 * Zistí názov a dĺžku videa v skrytom, stlmenom prehrávači (server nemá prístup na internet).
 * Odmietne video, ktoré YouTube nedovolí vložiť, živé vysielanie a pesničky dlhšie ako `JUKEBOX_MAX_DURATION_SEC`.
 */
export async function probeVideo(videoId: string): Promise<{ title: string; durationSec: number }> {
  const YT = await loadYouTubeApi();
  return new Promise((resolve, reject) => {
    const { mount, remove } = offscreenMount('jukebox-probe');
    let player: YouTubePlayer | null = null;
    let done = false;
    let poll: number | undefined;
    let titleWaitFrom: number | null = null;
    const finish = (error: string | null, result?: { title: string; durationSec: number }) => {
      if (done) {
        return;
      }
      done = true;
      window.clearInterval(poll);
      window.clearTimeout(timeout);
      try {
        player?.destroy();
      } catch {
        // Prehrávač už mohol zaniknúť.
      }
      remove();
      if (error) {
        reject(new Error(error));
      } else {
        resolve(result!);
      }
    };
    const check = () => {
      if (!player) {
        return;
      }
      const duration = player.getDuration();
      const data = player.getVideoData();
      if (data?.isLive) {
        finish('Živé vysielanie sa do jukeboxu pridať nedá');
        return;
      }
      if (!(duration > 0)) {
        return;
      }
      const durationSec = Math.ceil(duration);
      if (durationSec > JUKEBOX_MAX_DURATION_SEC) {
        finish(`Pesnička je dlhšia ako ${JUKEBOX_MAX_DURATION_SEC / 60} min`);
        return;
      }
      // Názov chodí niekedy chvíľu po dĺžke — počká naň najviac 2 s, potom stačí náhradný názov zo servera.
      titleWaitFrom ??= Date.now();
      if (!data?.title && Date.now() - titleWaitFrom < 2000) {
        return;
      }
      finish(null, { title: data?.title ?? '', durationSec });
    };
    const timeout = window.setTimeout(() => finish('Video sa nepodarilo načítať — skús iný odkaz'), PROBE_TIMEOUT_MS);
    player = new YT.Player(mount, {
      width: 200,
      height: 200,
      videoId,
      playerVars: playerVars(),
      events: {
        onReady: ({ target }) => {
          target.mute();
          // Dĺžku YouTube často pozná až po rozbehnutí — stlmené prehrávanie prehliadač dovolí aj bez kliknutia.
          target.playVideo();
          poll = window.setInterval(check, 250);
        },
        onStateChange: () => check(),
        onError: ({ data }) => finish(youTubeErrorMessage(data)),
      },
    });
  });
}
