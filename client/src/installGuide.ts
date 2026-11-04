/**
 * Step-by-step "add to home screen" guides for browsers that cannot install the app from a button (every browser on
 * iPhone / iPad, Android browsers until they offer `beforeinstallprompt`, Safari on Mac, in-app browsers). Pure data
 * and user-agent detection, so it is unit-tested in server/test/installGuide.test.ts; InstallGuide.tsx draws it.
 *
 * The drawings are simplified cut-outs of the browser's own controls, not screenshots, so they stay correct across
 * small UI changes; each step's text names the control the user looks for.
 */
export type InstallGuideId =
  | 'ios-safari'
  | 'ios-safari-classic'
  | 'ipad-safari'
  | 'ios-chrome'
  | 'ios-other'
  | 'android-chrome'
  | 'android-samsung'
  | 'android-firefox'
  | 'android-edge'
  | 'android-other'
  | 'mac-safari'
  | 'in-app-ios'
  | 'in-app-android';

/** One control in a drawn browser toolbar. `url` is the address field, the rest are buttons with a glyph. */
export type BarItem = { id: string; kind: 'url' } | { id: string; kind: 'button'; glyph: Glyph; label?: string };

export type Glyph = 'back' | 'forward' | 'more' | 'more-vertical' | 'menu' | 'share' | 'tabs' | 'book' | 'home' | 'star' | 'plus' | 'close' | 'sidebar' | 'apple';

export type GuideScene =
  | { kind: 'bar'; edge: 'top' | 'bottom'; rows: BarItem[][]; target: string }
  | { kind: 'menu'; edge: 'top' | 'bottom'; items: string[]; target: string }
  | { kind: 'share-sheet' }
  | { kind: 'confirm-ios'; title?: string }
  | { kind: 'confirm-android'; action: string }
  | { kind: 'mac-menu'; open: boolean };

/** Where on the real screen the first control sits, so an arrow outside the dialog can point at it. */
export type GuidePointer = 'top-right' | 'bottom-right' | 'bottom-center';

export interface GuideStep {
  text: string;
  scene: GuideScene;
  pointer?: GuidePointer;
}

export interface InstallGuide {
  title: string;
  steps: GuideStep[];
}

const url: BarItem = { id: 'url', kind: 'url' };
const button = (id: string, glyph: Glyph, label?: string): BarItem => ({ id, kind: 'button', glyph, ...(label ? { label } : {}) });

const IOS_SHARE_STEPS: GuideStep[] = [
  { text: 'V ponuke klepni na „Pridať na plochu“. Ak ju nevidíš, posuň zoznam nižšie alebo klepni na „Zobraziť viac“.', scene: { kind: 'share-sheet' } },
  { text: 'Klepni na „Pridať“ vpravo hore. Poker Night potom nájdeš na ploche ako aplikáciu.', scene: { kind: 'confirm-ios' } },
];

const ANDROID_CONFIRM: GuideStep = { text: 'Potvrď „Inštalovať“. Poker Night sa objaví na ploche ako aplikácia.', scene: { kind: 'confirm-android', action: 'Inštalovať' } };

export const INSTALL_GUIDES: Record<InstallGuideId, InstallGuide> = {
  'ios-safari': {
    title: 'Pridanie na plochu v Safari',
    steps: [
      { text: 'Klepni na tlačidlo ••• vpravo dole, vedľa adresy stránky.', pointer: 'bottom-right', scene: { kind: 'bar', edge: 'bottom', rows: [[button('back', 'back'), url, button('more', 'more')]], target: 'more' } },
      { text: 'Klepni na „Zdieľať“.', scene: { kind: 'menu', edge: 'bottom', items: ['Zdieľať', 'Pridať do záložiek', 'Pridať do obľúbených', 'Nová karta'], target: 'Zdieľať' } },
      ...IOS_SHARE_STEPS,
    ],
  },
  'ios-safari-classic': {
    title: 'Pridanie na plochu v Safari',
    steps: [
      {
        text: 'Klepni na „Zdieľať“ (štvorec so šípkou hore) v dolnej lište.',
        pointer: 'bottom-center',
        scene: { kind: 'bar', edge: 'bottom', rows: [[url], [button('back', 'back'), button('forward', 'forward'), button('share', 'share'), button('book', 'book'), button('tabs', 'tabs')]], target: 'share' },
      },
      ...IOS_SHARE_STEPS,
    ],
  },
  'ipad-safari': {
    title: 'Pridanie na plochu v Safari',
    steps: [
      { text: 'Klepni na „Zdieľať“ (štvorec so šípkou hore) vpravo hore.', pointer: 'top-right', scene: { kind: 'bar', edge: 'top', rows: [[button('sidebar', 'sidebar'), url, button('share', 'share'), button('plus', 'plus'), button('tabs', 'tabs')]], target: 'share' } },
      ...IOS_SHARE_STEPS,
    ],
  },
  'ios-chrome': {
    title: 'Pridanie na plochu v Chrome',
    steps: [
      { text: 'Klepni na „Zdieľať“ (štvorec so šípkou hore) vpravo v adresnom riadku.', pointer: 'top-right', scene: { kind: 'bar', edge: 'top', rows: [[url, button('share', 'share')]], target: 'share' } },
      ...IOS_SHARE_STEPS,
    ],
  },
  'ios-other': {
    title: 'Pridanie na plochu',
    steps: [
      { text: 'Otvor ponuku prehliadača (••• alebo ≡).', scene: { kind: 'bar', edge: 'bottom', rows: [[button('back', 'back'), button('forward', 'forward'), url, button('menu', 'menu')]], target: 'menu' } },
      { text: 'Klepni na „Zdieľať“.', scene: { kind: 'menu', edge: 'bottom', items: ['Nová karta', 'Zdieľať', 'Záložky', 'Nastavenia'], target: 'Zdieľať' } },
      ...IOS_SHARE_STEPS,
    ],
  },
  'android-chrome': {
    title: 'Inštalácia v Chrome',
    steps: [
      { text: 'Klepni na ⋮ vpravo hore pri adrese stránky.', pointer: 'top-right', scene: { kind: 'bar', edge: 'top', rows: [[button('home', 'home'), url, button('tabs', 'tabs', '1'), button('more', 'more-vertical')]], target: 'more' } },
      { text: 'Vyber „Pridať na plochu“ alebo „Inštalovať aplikáciu“.', scene: { kind: 'menu', edge: 'top', items: ['Nová karta', 'História', 'Stiahnuté súbory', 'Pridať na plochu', 'Nastavenia'], target: 'Pridať na plochu' } },
      ANDROID_CONFIRM,
    ],
  },
  'android-samsung': {
    title: 'Inštalácia v Samsung Internet',
    steps: [
      {
        text: 'Klepni na ≡ vpravo dole.',
        pointer: 'bottom-right',
        scene: { kind: 'bar', edge: 'bottom', rows: [[button('back', 'back'), button('forward', 'forward'), button('home', 'home'), button('star', 'star'), button('tabs', 'tabs'), button('menu', 'menu')]], target: 'menu' },
      },
      { text: 'Klepni na „Pridať stránku do“.', scene: { kind: 'menu', edge: 'bottom', items: ['Záložky', 'Pridať stránku do', 'História', 'Nastavenia'], target: 'Pridať stránku do' } },
      { text: 'Vyber „Domovská obrazovka“.', scene: { kind: 'menu', edge: 'bottom', items: ['Záložky', 'Rýchly prístup', 'Domovská obrazovka'], target: 'Domovská obrazovka' } },
      { text: 'Potvrď „Pridať“. Poker Night sa objaví na ploche.', scene: { kind: 'confirm-android', action: 'Pridať' } },
    ],
  },
  'android-firefox': {
    title: 'Inštalácia vo Firefoxe',
    steps: [
      { text: 'Klepni na ⋮ pri adresnom riadku (hore alebo dole, podľa nastavenia).', scene: { kind: 'bar', edge: 'bottom', rows: [[button('home', 'home'), url, button('tabs', 'tabs', '1'), button('more', 'more-vertical')]], target: 'more' } },
      { text: 'Vyber „Pridať na plochu“ alebo „Inštalovať“.', scene: { kind: 'menu', edge: 'bottom', items: ['Záložky', 'História', 'Pridať na plochu', 'Nastavenia'], target: 'Pridať na plochu' } },
      { text: 'Potvrď „Pridať“. Poker Night sa objaví na ploche.', scene: { kind: 'confirm-android', action: 'Pridať' } },
    ],
  },
  'android-edge': {
    title: 'Inštalácia v Edge',
    steps: [
      { text: 'Klepni na ••• v dolnej lište.', pointer: 'bottom-center', scene: { kind: 'bar', edge: 'bottom', rows: [[button('back', 'back'), button('forward', 'forward'), button('more', 'more'), button('tabs', 'tabs'), button('home', 'home')]], target: 'more' } },
      { text: 'Vyber „Pridať do telefónu“ alebo „Inštalovať aplikáciu“.', scene: { kind: 'menu', edge: 'bottom', items: ['Obľúbené', 'História', 'Pridať do telefónu', 'Nastavenia'], target: 'Pridať do telefónu' } },
      ANDROID_CONFIRM,
    ],
  },
  'android-other': {
    title: 'Inštalácia',
    steps: [
      { text: 'Otvor ponuku prehliadača (⋮ alebo ≡) pri adresnom riadku.', scene: { kind: 'bar', edge: 'top', rows: [[url, button('more', 'more-vertical')]], target: 'more' } },
      { text: 'Vyber „Pridať na plochu“ alebo „Inštalovať aplikáciu“.', scene: { kind: 'menu', edge: 'top', items: ['Nová karta', 'Záložky', 'Pridať na plochu', 'Nastavenia'], target: 'Pridať na plochu' } },
      ANDROID_CONFIRM,
    ],
  },
  'mac-safari': {
    title: 'Pridanie do Docku v Safari',
    steps: [
      { text: 'V hornej lište Macu klikni na menu „Súbor“.', scene: { kind: 'mac-menu', open: false } },
      { text: 'Vyber „Pridať do Docku…“.', scene: { kind: 'mac-menu', open: true } },
      { text: 'Klikni na „Pridať“. Poker Night sa otvorí vo vlastnom okne z Docku.', scene: { kind: 'confirm-ios', title: 'Pridať do Docku' } },
    ],
  },
  'in-app-ios': {
    title: 'Najprv otvor stránku v Safari',
    steps: [
      { text: 'Tento prehliadač v aplikácii (Messenger, Instagram…) nevie pridať stránku na plochu. Klepni na ••• vpravo hore.', pointer: 'top-right', scene: { kind: 'bar', edge: 'top', rows: [[button('close', 'close'), url, button('more', 'more')]], target: 'more' } },
      { text: 'Vyber „Otvoriť v Safari“ (alebo „Otvoriť v prehliadači“) a tam klepni znova na „Nainštalovať ako aplikáciu“.', scene: { kind: 'menu', edge: 'top', items: ['Kopírovať odkaz', 'Otvoriť v Safari', 'Obnoviť'], target: 'Otvoriť v Safari' } },
    ],
  },
  'in-app-android': {
    title: 'Najprv otvor stránku v prehliadači',
    steps: [
      { text: 'Tento prehliadač v aplikácii (Messenger, Instagram…) nevie inštalovať. Klepni na ⋮ alebo ••• vpravo hore.', pointer: 'top-right', scene: { kind: 'bar', edge: 'top', rows: [[button('close', 'close'), url, button('more', 'more-vertical')]], target: 'more' } },
      { text: 'Vyber „Otvoriť v Chrome“ (alebo „Otvoriť v prehliadači“) a tam klepni znova na „Nainštalovať ako aplikáciu“.', scene: { kind: 'menu', edge: 'top', items: ['Kopírovať odkaz', 'Otvoriť v Chrome', 'Obnoviť'], target: 'Otvoriť v Chrome' } },
    ],
  },
};

const IN_APP_BROWSER = /FBAN|FBAV|FB_IAB|FBIOS|Instagram|Messenger|MessengerForiOS|Line\/|TikTok|musical_ly|BytedanceWebview|LinkedInApp|Snapchat|Twitter|Pinterest/i;

/** Which guide fits this browser, or null where the app cannot be installed (desktop Chrome / Edge use their own dialog). */
export function detectInstallGuide(userAgent: string, maxTouchPoints = 0): InstallGuideId | null {
  const ipad = /iPad/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);
  const ios = ipad || /iPhone|iPod/.test(userAgent);
  const android = /Android/.test(userAgent);
  if (IN_APP_BROWSER.test(userAgent) || (android && /; wv\)/.test(userAgent))) {
    return ios ? 'in-app-ios' : android ? 'in-app-android' : null;
  }
  if (ios) {
    if (/CriOS/.test(userAgent)) {
      return 'ios-chrome';
    }
    if (/FxiOS|EdgiOS|OPiOS|OPT\/|YaBrowser|DuckDuckGo|Brave/.test(userAgent)) {
      return 'ios-other';
    }
    if (ipad) {
      return 'ipad-safari';
    }
    return safariVersion(userAgent) >= 26 ? 'ios-safari' : 'ios-safari-classic';
  }
  if (android) {
    if (/SamsungBrowser/.test(userAgent)) {
      return 'android-samsung';
    }
    if (/Firefox/.test(userAgent)) {
      return 'android-firefox';
    }
    if (/EdgA/.test(userAgent)) {
      return 'android-edge';
    }
    if (/OPR|Opera|YaBrowser|UCBrowser|MiuiBrowser|HuaweiBrowser|DuckDuckGo/.test(userAgent)) {
      return 'android-other';
    }
    return /Chrome\//.test(userAgent) ? 'android-chrome' : 'android-other';
  }
  const macSafari = /Macintosh/.test(userAgent) && /Safari\//.test(userAgent) && !/Chrome|Chromium|Edg|Firefox|OPR/.test(userAgent);
  return macSafari && safariVersion(userAgent) >= 17 ? 'mac-safari' : null;
}

function safariVersion(userAgent: string): number {
  return Number(userAgent.match(/Version\/(\d+)/)?.[1] ?? 0);
}
