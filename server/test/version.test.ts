import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { APP_VERSION, buildFingerprint, htmlAssetUrls } from '../../shared/version';

describe('version', () => {
  it('shared APP_VERSION matches package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(APP_VERSION).toBe(pkg.version);
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('buildFingerprint', () => {
  const html = [
    '<link rel="icon" href="/favicon.svg" type="image/svg+xml" />',
    '<link rel="manifest" href="/manifest.webmanifest" />',
    '<script type="module" crossorigin src="/assets/index-DxJX6Y02.js"></script>',
    '<link rel="modulepreload" crossorigin href="/assets/vendor-AbC123.js">',
    '<link rel="stylesheet" crossorigin href="/assets/index-D68EvYZX.css">',
  ].join('\n');

  it('z index.html berie len hashované súbory /assets, zoradené', () => {
    expect(buildFingerprint(htmlAssetUrls(html))).toBe('/assets/index-D68EvYZX.css /assets/index-DxJX6Y02.js /assets/vendor-AbC123.js');
  });

  it('server (z HTML) a klient (z DOM v inom poradí) dajú rovnaký odtlačok', () => {
    const fromDom = ['/favicon.svg', '/assets/vendor-AbC123.js', '/assets/index-D68EvYZX.css', null, '/assets/index-DxJX6Y02.js'];
    expect(buildFingerprint(fromDom)).toBe(buildFingerprint(htmlAssetUrls(html)));
  });

  it('zmena štýlov bez zmeny skriptu zmení odtlačok', () => {
    expect(buildFingerprint(htmlAssetUrls(html.replace('index-D68EvYZX.css', 'index-Zz99Yy88.css')))).not.toBe(buildFingerprint(htmlAssetUrls(html)));
  });

  it('vývoj cez Vite (bez /assets) nemá odtlačok', () => {
    expect(buildFingerprint(htmlAssetUrls('<script type="module" src="/src/main.tsx"></script>'))).toBeNull();
  });
});
