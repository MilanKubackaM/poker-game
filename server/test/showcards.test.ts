import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Avatar, TableEvent } from '../../shared/types';
import { DEFAULT_SETTINGS, HAND_PAUSE_MS } from '../../shared/constants';
import { Table, type TablePlayer } from '../Table';
import { buyIn } from './helpers';

const avatar: Avatar = { emoji: '🦊', color: '#e76f51' };
let current: Table[] = [];
let socketSeq = 0;

function setup(): { table: Table; events: TableEvent[]; a: TablePlayer; b: TablePlayer } {
  const events: TableEvent[] = [];
  const table = new Table('SHOW01', { ...DEFAULT_SETTINGS }, { onChange: () => undefined, onEvent: (_table, event) => events.push(event), onRemoved: () => undefined });
  current.push(table);
  const join = (name: string) => {
    const added = table.addPlayer(name, avatar);
    if (!added.ok || !added.data) {
      throw new Error(`join ${name} failed`);
    }
    table.attachSocket(added.data, `socket-${++socketSeq}`);
    buyIn(table, added.data);
    return added.data;
  };
  const a = join('Adam');
  const b = join('Bea');
  expect(table.hostStart().ok).toBe(true);
  expect(table.hostDealerChoice('random').ok).toBe(true);
  vi.advanceTimersByTime(1500);
  return { table, events, a, b };
}

/** Kto je na ťahu, zloží — ruka skončí bez showdownu. */
function foldHand(table: Table, players: TablePlayer[]): TablePlayer {
  const actor = players.find((player) => player.id === table.engine!.toAct!.id)!;
  expect(table.act(actor, { type: 'fold' }).ok).toBe(true);
  expect(table.engine!.isComplete).toBe(true);
  return actor;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const table of current.splice(0)) {
    table.dispose();
  }
  vi.useRealTimers();
});

describe('dobrovoľné ukázanie kariet', () => {
  it('počas ruky sa nedá, po skončení áno a súper karty uvidí', () => {
    const { table, events, a, b } = setup();
    expect(table.showCards(a)).toMatchObject({ ok: false });
    const folder = foldHand(table, [a, b]);
    const other = folder === a ? b : a;
    const hiddenBefore = table.view(other.id).players.find((player) => player.id === folder.id)!.cards;
    expect(hiddenBefore.every((card) => card === null)).toBe(true);
    expect(table.showCards(folder).ok).toBe(true);
    const shown = table.view(other.id).players.find((player) => player.id === folder.id)!.cards;
    expect(shown.every((card) => typeof card === 'string')).toBe(true);
    expect(events.some((event) => event.text.startsWith(`${folder.name} ukazuje karty:`))).toBe(true);
    expect(table.showCards(folder)).toMatchObject({ ok: false });
  });

  it('prvé ukázanie predĺži pauzu pred ďalšou rukou o 3 s', () => {
    const { table, a, b } = setup();
    foldHand(table, [a, b]);
    const firstHand = table.engine!.handNumber;
    const scheduled = table.view(a.id).nextHandAt!;
    expect(table.showCards(a).ok).toBe(true);
    expect(table.view(a.id).nextHandAt).toBe(scheduled + 3000);
    vi.advanceTimersByTime(HAND_PAUSE_MS + 1000);
    expect(table.engine!.handNumber).toBe(firstHand);
    vi.advanceTimersByTime(2100);
    expect(table.engine!.handNumber).toBe(firstHand + 1);
  });
});

describe('návrat z „Moje stoly“ do čakárne', () => {
  it('standing: hráč ostane stáť bez automatického čakania na BB', () => {
    const { table, a, b } = setup();
    const c = table.addPlayer('Cyril', avatar);
    if (!c.ok || !c.data) {
      throw new Error('join failed');
    }
    buyIn(table, c.data);
    foldHand(table, [a, b]);
    table.leave(c.data);
    expect(table.players.has(c.data.id)).toBe(false);
    const resumed = table.resume(c.data.id, c.data.token, true);
    expect(resumed.ok).toBe(true);
    const me = table.view(c.data.id).players.find((player) => player.id === c.data!.id)!;
    expect(me.sittingOut).toBe(true);
    expect(me.returnMode).toBeNull();
  });

  it('bez standing sa hráč vráti s čakaním na BB', () => {
    const { table, a, b } = setup();
    const c = table.addPlayer('Cyril', avatar);
    if (!c.ok || !c.data) {
      throw new Error('join failed');
    }
    buyIn(table, c.data);
    foldHand(table, [a, b]);
    table.leave(c.data);
    expect(table.resume(c.data.id, c.data.token).ok).toBe(true);
    const me = table.view(c.data.id).players.find((player) => player.id === c.data!.id)!;
    expect(me.returnMode).toBe('wait-bb');
  });
});
