import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isSlowRelay } from '../../shared/netstats';
import { CLOUDFLARE_MAX_AGE_MS, CloudflareIceFile, parseCloudflareIce } from '../cloudflareTurn';

/** Tvar odpovede Cloudflare `generate-ice-servers` (z dokumentácie). */
const RESPONSE = {
  iceServers: [
    { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53'] },
    {
      urls: [
        'turn:turn.cloudflare.com:3478?transport=udp',
        'turn:turn.cloudflare.com:3478?transport=tcp',
        'turns:turn.cloudflare.com:5349?transport=tcp',
        'turn:turn.cloudflare.com:53?transport=udp',
        'turn:turn.cloudflare.com:80?transport=tcp',
        'turns:turn.cloudflare.com:443?transport=tcp',
      ],
      username: 'g0a1b2c3',
      credential: 'secret-credential',
    },
  ],
};

describe('parseCloudflareIce', () => {
  it('vyhodí port 53 a nechá STUN aj TURN s heslom', () => {
    expect(parseCloudflareIce(RESPONSE)).toEqual([
      { urls: ['stun:stun.cloudflare.com:3478'] },
      {
        urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:3478?transport=tcp', 'turns:turn.cloudflare.com:5349?transport=tcp', 'turn:turn.cloudflare.com:80?transport=tcp', 'turns:turn.cloudflare.com:443?transport=tcp'],
        username: 'g0a1b2c3',
        credential: 'secret-credential',
      },
    ]);
  });

  it('bez TURN s heslom alebo s neplatnými adresami vráti null', () => {
    expect(parseCloudflareIce({ iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }] })).toBeNull();
    expect(parseCloudflareIce({ iceServers: [{ urls: ['turn:turn.cloudflare.com:3478'] }] })).toBeNull();
    expect(parseCloudflareIce({ iceServers: [{ urls: ['javascript:alert(1)', 'turn:bad host:1'], username: 'a', credential: 'b' }] })).toBeNull();
    expect(parseCloudflareIce({ error: 'unauthorized' })).toBeNull();
    expect(parseCloudflareIce(null)).toBeNull();
  });

  it('zvládne aj jeden objekt namiesto poľa', () => {
    expect(parseCloudflareIce({ iceServers: { urls: 'turn:turn.cloudflare.com:3478?transport=udp', username: 'u', credential: 'c' } })).toEqual([
      { urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: 'u', credential: 'c' },
    ]);
  });
});

describe('CloudflareIceFile', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('číta súbor zo sidecaru, staré alebo chýbajúce údaje nerozdáva', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'turn-'));
    dirs.push(dir);
    const file = path.join(dir, 'ice.json');
    let now = Date.now();
    const ice = new CloudflareIceFile(file, () => now);
    expect(ice.servers()).toBeNull();
    writeFileSync(file, JSON.stringify(RESPONSE));
    expect(ice.servers()?.[1].username).toBe('g0a1b2c3');
    now += CLOUDFLARE_MAX_AGE_MS + 1000;
    expect(ice.servers()).toBeNull();
    writeFileSync(file, '{broken');
    utimesSync(file, new Date(now), new Date(now));
    expect(ice.servers()).toBeNull();
    expect(new CloudflareIceFile('').servers()).toBeNull();
  });
});

describe('isSlowRelay — strop videa len pre relay po TCP', () => {
  const coturn = [{ urls: ['stun:stun.l.google.com:19302'] }, { urls: ['turns:poker.example.ts.net:8443?transport=tcp'] }];
  const cloudflare = [{ urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'] }];

  it('vlastný relay podľa protokolu, relay protihráča podľa toho, aký relay dáva server', () => {
    expect(isSlowRelay('relay/tls→relay', cloudflare)).toBe(true);
    expect(isSlowRelay('relay/udp→srflx', coturn)).toBe(false);
    expect(isSlowRelay('host/udp→relay', coturn)).toBe(true);
    expect(isSlowRelay('host/udp→relay', cloudflare)).toBe(false);
    expect(isSlowRelay('srflx/udp→srflx', coturn)).toBe(false);
  });
});
