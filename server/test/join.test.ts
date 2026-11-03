import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Avatar } from '../../shared/types';
import { DEFAULT_SETTINGS } from '../../shared/constants';
import { LIMITS } from '../limits';
import { Table, type JoinOutcome, type JoinRequest, type TablePlayer } from '../Table';

const avatar: Avatar = { emoji: '🦊', color: '#e76f51' };
let table: Table;
let closed: { name: string; outcome: JoinOutcome; player: TablePlayer | null; byName: string | null }[];

beforeEach(() => {
  vi.useFakeTimers();
  closed = [];
  table = new Table('JOIN01', { ...DEFAULT_SETTINGS }, {
    onChange: () => undefined,
    onEvent: () => undefined,
    onRemoved: () => undefined,
    onJoinClosed: (_table, request, outcome, player, byName) => closed.push({ name: request.name, outcome, player, byName }),
  });
});

afterEach(() => {
  table.dispose();
  vi.useRealTimers();
});

function join(name: string): TablePlayer {
  const added = table.addPlayer(name, avatar);
  if (!added.ok || !added.data) {
    throw new Error(`join ${name} failed`);
  }
  return added.data;
}

function request(name: string, ip = '1.2.3.4'): JoinRequest {
  const created = table.requestJoin(name, avatar, ip);
  if (!created.ok || !created.data) {
    throw new Error(created.ok ? 'no request' : created.error);
  }
  return created.data;
}

describe('žiadosti o prístup ku stolu', () => {
  it('žiadateľ nie je členom; členovia vidia len meno a avatara, nie token ani IP', () => {
    const milan = join('Milan');
    const zuzka = request('Zuzka');
    expect(table.players.size).toBe(1);
    expect(table.hasMembership(zuzka.id, zuzka.token)).toBe(false);
    const live = table.liveView(milan.id);
    expect(live.joinRequests).toEqual([{ id: zuzka.id, name: 'Zuzka', avatar, at: zuzka.at }]);
    expect(JSON.stringify(live)).not.toContain(zuzka.token);
    expect(JSON.stringify(live)).not.toContain('1.2.3.4');
  });

  it('host pustí žiadateľa — vznikne člen bez žetónov a schválenie sa dá vyzdvihnúť tokenom žiadosti', () => {
    const milan = join('Milan');
    const zuzka = request('Zuzka');
    const outcome = table.resolveJoin(milan, zuzka.id, true);
    expect(outcome.ok).toBe(true);
    const player = outcome.ok ? outcome.data! : null;
    expect(player).toMatchObject({ name: 'Zuzka', stack: 0 });
    expect(table.joinRequests.size).toBe(0);
    expect(closed).toEqual([{ name: 'Zuzka', outcome: 'approved', player, byName: 'Milan' }]);
    expect(table.approvedJoin(zuzka.id, zuzka.token)).toBe(player);
    expect(table.approvedJoin(zuzka.id, 'zly-token')).toBeUndefined();
    expect(table.isAdmin(player!.id) || table.isBanker(player!.id)).toBe(false);
  });

  it('zamietnutie, zrušenie žiadateľom a vypršanie žiadosť zahodia', () => {
    const milan = join('Milan');
    const a = request('A', '1.1.1.1');
    const b = request('B', '2.2.2.2');
    request('C', '3.3.3.3');
    expect(table.resolveJoin(milan, a.id, false)).toEqual({ ok: true, data: null });
    expect(table.cancelJoin(b.id, 'zly-token').ok).toBe(false);
    expect(table.cancelJoin(b.id, b.token).ok).toBe(true);
    vi.advanceTimersByTime(LIMITS.joinRequestTtlMs + 31_000);
    expect(table.joinRequests.size).toBe(0);
    expect(closed.map((entry) => `${entry.name}:${entry.outcome}`)).toEqual(['A:rejected', 'B:cancelled', 'C:expired']);
    expect(table.players.size).toBe(1);
  });

  it('schvaľovať smie len sediaci host — nie bežný hráč ani bankár bez práv hosta', () => {
    const milan = join('Milan');
    const juraj = join('Juraj');
    const peto = join('Peťo');
    expect(table.hostSetBanker(milan, juraj, undefined).ok).toBe(true);
    const zuzka = request('Zuzka');
    expect(table.resolveJoin(peto, zuzka.id, true).ok).toBe(false);
    expect(table.resolveJoin(juraj, zuzka.id, true).ok).toBe(false);
    table.leave(milan);
    // bankár prevzal práva hosta, keď zakladateľ odišiel
    expect(table.resolveJoin(juraj, zuzka.id, true).ok).toBe(true);
  });

  it('limity: najviac žiadostí z jednej siete a na jeden stôl', () => {
    join('Milan');
    for (let index = 0; index < LIMITS.joinRequestsPerIp; index++) {
      request(`Ip${index}`, '9.9.9.9');
    }
    expect(table.requestJoin('Navyše', avatar, '9.9.9.9').ok).toBe(false);
    for (let index = table.joinRequests.size; index < LIMITS.joinRequestsPerTable; index++) {
      request(`Hrac${index}`, `10.0.0.${index}`);
    }
    expect(table.requestJoin('Plno', avatar, '10.0.1.1')).toEqual({ ok: false, error: 'Ku stolu už čaká priveľa žiadostí — skús to neskôr' });
  });

  it('zatvorenie všetkých žiadostí pri zmazaní stola', () => {
    join('Milan');
    request('A', '1.1.1.1');
    request('B', '2.2.2.2');
    table.closeAllJoins();
    expect(closed.map((entry) => entry.outcome)).toEqual(['deleted', 'deleted']);
    expect(table.joinRequests.size).toBe(0);
  });
});
