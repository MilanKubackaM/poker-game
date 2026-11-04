import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolveManifest } from '../../shared/manifest';

const built = readFileSync(new URL('../../client/public/manifest.webmanifest', import.meta.url), 'utf8');

describe('resolveManifest', () => {
  it('doplní k vlastnej aplikácii absolútne id a url podľa hostiteľa', () => {
    const manifest = JSON.parse(resolveManifest(built, 'https://poker.example.ts.net'));
    expect(manifest.related_applications).toEqual([{ platform: 'webapp', url: 'https://poker.example.ts.net/manifest.webmanifest', id: 'https://poker.example.ts.net/' }]);
  });

  it('id sedí s id aplikácie, ktoré si prehliadač vypočíta z manifestu', () => {
    const origin = 'http://192.168.1.88:3000';
    const manifest = JSON.parse(resolveManifest(built, origin));
    expect(manifest.related_applications[0].id).toBe(new URL(manifest.id, new URL(manifest.start_url, origin)).href);
  });

  it('ostatné polia a iné platformy nechá bez zmeny', () => {
    const raw = JSON.stringify({ name: 'X', related_applications: [{ platform: 'play', id: 'com.example' }, { platform: 'webapp', id: '/' }] });
    const manifest = JSON.parse(resolveManifest(raw, 'https://a.example'));
    expect(manifest.name).toBe('X');
    expect(manifest.related_applications).toEqual([{ platform: 'play', id: 'com.example' }, { platform: 'webapp', id: 'https://a.example/' }]);
  });
});
