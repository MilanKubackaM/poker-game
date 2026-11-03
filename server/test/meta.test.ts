import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Avatar } from '../../shared/types';
import { DEFAULT_SETTINGS } from '../../shared/constants';
import { Table, type TablePlayer } from '../Table';
import { buyIn } from './helpers';

const avatar: Avatar = { emoji: '🦊', color: '#e76f51' };
let table: Table;

beforeEach(() => {
  vi.useFakeTimers();
  table = new Table('META01', { ...DEFAULT_SETTINGS }, { onChange: () => undefined, onEvent: () => undefined, onRemoved: () => undefined });
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
  buyIn(table, added.data);
  return added.data;
}

function playHand(): void {
  while (table.engine && !table.engine.isComplete) {
    const actor = table.players.get(table.engine.toAct!.id)!;
    expect(table.act(actor, { type: 'fold' }).ok).toBe(true);
  }
  vi.advanceTimersByTime(10_000);
}

describe('table:state bez ledgeru/histórie + table:meta', () => {
  it('liveView neobsahuje ledger, históriu ani leaderboard; view ich skladá', () => {
    const host = join('Milan');
    const live = table.liveView(host.id) as Record<string, unknown>;
    expect(live.ledger).toBeUndefined();
    expect(live.history).toBeUndefined();
    expect(live.leaderboard).toBeUndefined();
    const full = table.view(host.id);
    expect(full.ledger).toEqual(table.ledger);
    expect(full.leaderboard.length).toBe(1);
  });

  it('metaSince vráti len nové položky ledgeru a histórie', () => {
    const host = join('Milan');
    const guest = join('Juraj');
    host.sockets.add('a');
    guest.sockets.add('b');
    const cursor = table.metaCursor();
    expect(table.metaSince(cursor)).toEqual({ ledger: [], history: [] });

    table.bankChips(guest, 500, '', 'Milan');
    const afterChips = table.metaSince(cursor);
    expect(afterChips.ledger.map((entry) => entry.playerId)).toEqual([guest.id]);
    expect(afterChips.history).toEqual([]);

    expect(table.hostStart().ok).toBe(true);
    expect(table.hostDealerChoice('random').ok).toBe(true);
    vi.advanceTimersByTime(1500);
    const beforeHand = table.metaCursor();
    playHand();
    const afterHand = table.metaSince(beforeHand);
    expect(afterHand.history.length).toBe(1);
    expect(afterHand.history[0].handNumber).toBe(beforeHand.handNumber + 1);
    expect(table.metaSince().history.length).toBe(table.history.length);
  });
});
