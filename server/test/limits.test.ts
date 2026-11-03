import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../shared/constants';
import { LIMITS, TokenBucket, WindowCounter, clientKey, normalizeAddress, originAllowed, trustProxyFromEnv } from '../limits';
import { SessionManager } from '../SessionManager';
import { Table } from '../Table';

const hooks = { onChange: () => undefined, onEvent: () => undefined, onRemoved: () => undefined };
const avatar = { emoji: '🦊', color: '#e76f51' };

describe('WindowCounter', () => {
  it('pustí presne limit v okne a po uplynutí okna znova', () => {
    const counter = new WindowCounter(3, 1000);
    expect([counter.hit('a', 0), counter.hit('a', 10), counter.hit('a', 20), counter.hit('a', 30)]).toEqual([true, true, true, false]);
    expect(counter.hit('b', 30)).toBe(true);
    expect(counter.hit('a', 999)).toBe(false);
    expect(counter.hit('a', 1000)).toBe(true);
  });

  it('allows nič nezapočíta', () => {
    const counter = new WindowCounter(1, 1000);
    expect(counter.allows('a', 0)).toBe(true);
    expect(counter.allows('a', 0)).toBe(true);
    counter.add('a', 0);
    expect(counter.allows('a', 1)).toBe(false);
  });

  it('pri priveľa kľúčoch zahodí staré a pamäť nerastie', () => {
    const counter = new WindowCounter(1, 10, 3);
    for (let index = 0; index < 100; index += 1) {
      counter.hit(`k${index}`, index * 20);
    }
    expect(counter.hit('k99', 99 * 20 + 1)).toBe(false);
  });
});

describe('TokenBucket', () => {
  it('dovolí burst a potom len rate za sekundu', () => {
    const bucket = new TokenBucket(2, 4, 0);
    expect([1, 2, 3, 4, 5].map(() => bucket.take(0))).toEqual([true, true, true, true, false]);
    expect(bucket.take(499)).toBe(false);
    expect(bucket.take(500)).toBe(true);
    expect(bucket.take(500)).toBe(false);
  });
});

describe('clientKey', () => {
  const headers = { 'x-forwarded-for': '6.6.6.6, 203.0.113.9', 'cf-connecting-ip': '198.51.100.7' };

  it('bez dôveryhodnej proxy ignoruje hlavičky (podvrh nepomôže)', () => {
    expect(clientKey('::ffff:10.0.0.2', headers, 'off')).toBe('10.0.0.2');
  });

  it('xff berie poslednú položku — tú pridala naša proxy', () => {
    expect(clientKey('100.64.0.1', headers, 'xff')).toBe('203.0.113.9');
    expect(clientKey('100.64.0.1', { 'x-forwarded-for': '203.0.113.9' }, 'xff')).toBe('203.0.113.9');
  });

  it('cloudflare berie CF-Connecting-IP, bez nej adresu spojenia', () => {
    expect(clientKey('172.17.0.1', headers, 'cloudflare')).toBe('198.51.100.7');
    expect(clientKey('172.17.0.1', {}, 'cloudflare')).toBe('172.17.0.1');
  });

  it('IPv6 zoskupí podľa /64', () => {
    expect(normalizeAddress('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2::/64');
    expect(normalizeAddress('2001:0db8:0001:0002:ffff:1:2:3')).toBe('2001:db8:1:2::/64');
    expect(normalizeAddress('[2001:db8::5]')).toBe('2001:db8:0:0::/64');
    expect(normalizeAddress('203.0.113.9:4567')).toBe('203.0.113.9');
  });

  it('TRUST_PROXY hodnoty', () => {
    expect(trustProxyFromEnv('tailscale')).toBe('xff');
    expect(trustProxyFromEnv('Cloudflare')).toBe('cloudflare');
    expect(trustProxyFromEnv('')).toBe('off');
    expect(trustProxyFromEnv('nonsense')).toBe('off');
  });
});

describe('originAllowed', () => {
  it('povolí rovnaký pôvod, bez Origin aj zoznam, cudziu stránku nie', () => {
    expect(originAllowed(undefined, 'poker.example', [])).toBe(true);
    expect(originAllowed('https://poker.example', 'poker.example', [])).toBe(true);
    expect(originAllowed('http://localhost:5173', 'localhost:5173', [])).toBe(true);
    expect(originAllowed('https://evil.example', 'poker.example', [])).toBe(false);
    expect(originAllowed('https://friend.example', 'poker.example', ['https://friend.example'])).toBe(true);
    expect(originAllowed('not a url', 'poker.example', [])).toBe(false);
  });
});

describe('limity stola', () => {
  it('stôl prijme najviac maxMembersPerTable členov vrátane odídených', () => {
    const table = new Table('LIMIT1', { ...DEFAULT_SETTINGS }, hooks);
    let added = 0;
    for (let index = 0; index < LIMITS.maxMembersPerTable + 5; index += 1) {
      const result = table.addPlayer(`P${index}`, avatar);
      if (!result.ok || !result.data) {
        break;
      }
      added += 1;
      table.leave(result.data);
    }
    expect(added).toBe(LIMITS.maxMembersPerTable);
    expect(table.addPlayer('Navyše', avatar)).toMatchObject({ ok: false });
    table.dispose();
  });

  it('nepoužitý stôl sa zmaže po dni, stôl s hosťami ostáva', () => {
    const manager = new SessionManager(hooks);
    const lonely = manager.create({ ...DEFAULT_SETTINGS });
    lonely.addPlayer('Sám', avatar);
    const party = manager.create({ ...DEFAULT_SETTINGS });
    party.addPlayer('A', avatar);
    party.addPlayer('B', avatar);
    const later = Date.now() + LIMITS.unusedTableRetentionMs + 1000;
    manager.cleanup(later);
    expect(manager.get(lonely.code)).toBeUndefined();
    expect(manager.get(party.code)).toBeDefined();
    manager.dispose();
  });
});
