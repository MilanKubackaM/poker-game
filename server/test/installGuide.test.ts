import { describe, expect, it } from 'vitest';
import { INSTALL_GUIDES, detectInstallGuide, type GuideScene } from '../../client/src/installGuide';

const UA = {
  iphoneSafari26: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
  iphoneSafari18: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
  iphoneChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.7390.41 Mobile/15E148 Safari/604.1',
  iphoneFirefox: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/143.0 Mobile/15E148 Safari/605.1.15',
  iphoneEdge: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 EdgiOS/140.3485.54 Mobile/15E148 Safari/605.1.15',
  iphoneMessenger: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/MessengerForiOS;FBAV/520.0.0.38.107;FBBV/1;FBDV/iPhone16,2;FBMD/iPhone;FBSN/iOS;FBSV/18.6;FBSS/3;FBCR/;FBID/phone;FBLC/sk_SK;FBOP/5]',
  ipadDesktopMode: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
  androidChrome: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
  androidSamsung: 'Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36',
  androidFirefox: 'Mozilla/5.0 (Android 14; Mobile; rv:143.0) Gecko/143.0 Firefox/143.0',
  androidEdge: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36 EdgA/141.0.0.0',
  androidOpera: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36 OPR/91.0.0.0',
  androidWebView: 'Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.0.0 Mobile Safari/537.36',
  androidInstagram: 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.0.0 Mobile Safari/537.36 Instagram 400.0.0.0',
  macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15',
  macSafari16: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Safari/605.1.15',
  macChrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  windowsEdge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
  windowsFirefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0',
};

describe('detectInstallGuide', () => {
  it.each([
    ['iphoneSafari26', 'ios-safari', 5],
    ['iphoneSafari18', 'ios-safari-classic', 5],
    ['iphoneChrome', 'ios-chrome', 5],
    ['iphoneFirefox', 'ios-other', 5],
    ['iphoneEdge', 'ios-other', 5],
    ['iphoneMessenger', 'in-app-ios', 5],
    ['ipadDesktopMode', 'ipad-safari', 5],
    ['androidChrome', 'android-chrome', 5],
    ['androidSamsung', 'android-samsung', 5],
    ['androidFirefox', 'android-firefox', 5],
    ['androidEdge', 'android-edge', 5],
    ['androidOpera', 'android-other', 5],
    ['androidWebView', 'in-app-android', 5],
    ['androidInstagram', 'in-app-android', 5],
    ['macSafari', 'mac-safari', 0],
    ['macSafari16', null, 0],
    ['macChrome', null, 0],
    ['windowsEdge', null, 0],
    ['windowsFirefox', null, 0],
  ] as const)('%s → %s', (name, expected, touchPoints) => {
    expect(detectInstallGuide(UA[name], touchPoints)).toBe(expected);
  });
});

describe('INSTALL_GUIDES', () => {
  const targetOf = (scene: GuideScene): string | null => {
    if (scene.kind === 'bar') {
      return scene.rows.flat().some((item) => item.id === scene.target) ? scene.target : null;
    }
    if (scene.kind === 'menu') {
      return scene.items.includes(scene.target) ? scene.target : null;
    }
    return scene.kind;
  };

  it.each(Object.entries(INSTALL_GUIDES))('%s: každý krok má text a zvýraznený prvok, ktorý v obrázku naozaj je', (_id, guide) => {
    expect(guide.steps.length).toBeGreaterThanOrEqual(2);
    for (const step of guide.steps) {
      expect(step.text.length).toBeGreaterThan(10);
      expect(targetOf(step.scene)).not.toBeNull();
    }
  });
});
