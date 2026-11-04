import { useSyncExternalStore } from 'react';
import { detectInstallGuide, type InstallGuideId } from './installGuide';

/**
 * Installing Poker Night as an app (PWA) and the lobby offer for it.
 *
 * - Chrome / Edge fire `beforeinstallprompt`, which is kept here so the lobby can open the browser's install dialog.
 * - Every browser on iPhone / iPad, Safari on Mac and Android browsers without the event get an animated step-by-step
 *   guide instead (installGuide.ts, InstallGuide.tsx).
 * - Once the app is installed, a browser tab offers to open it. Desktop Chrome / Edge (139+) open an in-scope link that
 *   starts a new top-level browsing context in the installed app, so the offer is a plain `target="_blank"` link.
 *   Detection: `getInstalledRelatedApps()` (Chrome / Edge 140+), plus a flag stored whenever the app window runs or the
 *   install finishes — the installed app shares storage with the browser profile in Chrome and Edge.
 */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

interface RelatedApp {
  platform: string;
}

export type InstallOffer = { kind: 'prompt' } | { kind: 'manual'; guide: InstallGuideId } | { kind: 'open' } | null;

const INSTALLED_KEY = 'poker:appInstalled';
const PROMPT_OFFER: InstallOffer = { kind: 'prompt' };
const OPEN_OFFER: InstallOffer = { kind: 'open' };

let deferredPrompt: BeforeInstallPromptEvent | null = null;
let relatedAppInstalled = false;
let offer: InstallOffer = null;
const listeners = new Set<() => void>();

function readInstalledFlag(): boolean {
  try {
    return localStorage.getItem(INSTALLED_KEY) === '1';
  } catch {
    return false;
  }
}

function writeInstalledFlag(installed: boolean): void {
  try {
    if (installed) {
      localStorage.setItem(INSTALLED_KEY, '1');
    } else {
      localStorage.removeItem(INSTALLED_KEY);
    }
  } catch {
    return;
  }
}

function runsAsInstalledApp(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

function isMobile(userAgent: string): boolean {
  return /iPad|iPhone|iPod|Android/.test(userAgent) || (/Macintosh/.test(userAgent) && navigator.maxTouchPoints > 1);
}

function computeOffer(): InstallOffer {
  if (!window.isSecureContext || runsAsInstalledApp()) {
    return null;
  }
  if (deferredPrompt) {
    return PROMPT_OFFER;
  }
  if (relatedAppInstalled || readInstalledFlag()) {
    return isMobile(navigator.userAgent) ? null : OPEN_OFFER;
  }
  const guide = detectInstallGuide(navigator.userAgent, navigator.maxTouchPoints);
  return guide ? { kind: 'manual', guide } : null;
}

function refresh(): void {
  const next = computeOffer();
  const same = next?.kind === offer?.kind && (next?.kind !== 'manual' || (offer?.kind === 'manual' && next.guide === offer.guide));
  if (!same) {
    offer = next;
    listeners.forEach((listener) => listener());
  }
}

export function setupInstall(): void {
  if (runsAsInstalledApp()) {
    writeInstalledFlag(true);
  }
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredPrompt = event as BeforeInstallPromptEvent;
    relatedAppInstalled = false;
    writeInstalledFlag(false);
    refresh();
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    writeInstalledFlag(true);
    refresh();
  });
  const getInstalledRelatedApps = (navigator as Navigator & { getInstalledRelatedApps?: () => Promise<RelatedApp[]> }).getInstalledRelatedApps;
  if (getInstalledRelatedApps && window.isSecureContext) {
    getInstalledRelatedApps
      .call(navigator)
      .then((apps) => {
        relatedAppInstalled = apps.some((app) => app.platform === 'webapp');
        refresh();
      })
      .catch(() => undefined);
  }
  offer = computeOffer();
  if (import.meta.env.PROD && 'serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('/sw.js').catch((error: unknown) => console.warn('Service worker sa nepodarilo zaregistrovať', error));
  }
}

export async function promptInstall(): Promise<void> {
  const prompt = deferredPrompt;
  if (!prompt) {
    return;
  }
  deferredPrompt = null;
  refresh();
  await prompt.prompt();
  await prompt.userChoice;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** React: čo ponúknuť v lobby — inštaláciu, návod na ručnú inštaláciu, otvorenie nainštalovanej aplikácie, alebo nič. */
export function useInstallOffer(): InstallOffer {
  return useSyncExternalStore(
    subscribe,
    () => offer,
    () => null,
  );
}
