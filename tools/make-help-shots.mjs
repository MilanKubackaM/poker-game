/**
 * Screenshots for the in-game help (menu ☰ → Vysvetlivky) in client/public/help/*.webp.
 * They are taken from the demo screens (`/?demo=<screen>`) at desktop size, so they always show the real UI.
 *
 *   npm run dev:client                                   # Vite on :5173 (or set HELP_URL)
 *   PLAYWRIGHT=/path/to/playwright/index.mjs node tools/make-help-shots.mjs
 *
 * Needs Playwright with Chromium and `cwebp` (brew install webp).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { chromium } = await import(process.env.PLAYWRIGHT ?? 'playwright');
const base = (process.env.HELP_URL ?? 'http://localhost:5173').replace(/\/+$/, '');
const outDir = path.resolve('client/public/help');

/** [file name, demo screen, optional element to crop to] */
const SHOTS = [
  ['room', 'room'],
  ['table', 'table'],
  ['omaha', 'omaha'],
  ['pineapple', 'pineapple'],
  ['mode-intro-omaha', 'mode-intro-omaha'],
  ['host-game', 'host-game'],
  ['showdown', 'showdown'],
  ['piggy', 'piggy'],
  ['piggy-won', 'piggy-won'],
  ['timebank', 'timebank'],
  ['pre-actions', 'pre-actions'],
  ['run-vote', 'run-vote'],
  ['run-twice', 'run-twice'],
  ['rabbit', 'rabbit'],
  ['away', 'away'],
  ['return-dialog', 'return-dialog'],
  ['room-playing', 'room-playing'],
  ['host-players', 'host-players'],
  ['cashout', 'cashout'],
  ['transactions', 'transactions'],
  ['chat-toasts', 'chat-toasts'],
  ['leaderboard', 'leaderboard'],
  ['history', 'history'],
  ['draw-pick', 'draw-pick'],
  ['table-roles', 'table-roles', '.table-area-wrap'],
  ['speaking', 'speaking', '.table-area-wrap'],
];

const work = mkdtempSync(path.join(tmpdir(), 'help-shots-'));
const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  for (const [name, screen, selector] of SHOTS) {
    const page = await context.newPage();
    await page.goto(`${base}/?demo=${screen}`);
    // Animácie (prílet prasiatka, karty) nech dobehnú.
    await page.waitForTimeout(name === 'piggy-won' ? 2600 : 1600);
    const png = path.join(work, `${name}.png`);
    await (selector ? page.locator(selector).first().screenshot({ path: png }) : page.screenshot({ path: png }));
    await page.close();
    const result = spawnSync('cwebp', ['-quiet', '-q', '78', '-m', '6', png, '-o', path.join(outDir, `${name}.webp`)], { stdio: 'inherit' });
    if (result.status !== 0) {
      throw new Error(`cwebp failed for ${name}`);
    }
    console.log(`client/public/help/${name}.webp`);
  }
} finally {
  await browser.close();
  rmSync(work, { recursive: true, force: true });
}
