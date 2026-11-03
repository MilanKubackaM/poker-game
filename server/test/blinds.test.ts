import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Avatar, TableEvent, TableSettings } from '../../shared/types';
import { DEFAULT_SETTINGS, HAND_PAUSE_MS } from '../../shared/constants';
import { formatMoney } from '../../shared/money';
import { Table, type TableHooks, type TablePlayer, type TableSnapshot } from '../Table';
import { TEST_BUY_IN, buyIn, setTestBuyIn } from './helpers';

const crypto = vi.hoisted(() => ({ forcedRandomInt: [] as number[] }));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    randomInt: ((...args: Parameters<typeof actual.randomInt>) => {
      const forced = crypto.forcedRandomInt.shift();
      return forced ?? (actual.randomInt as (...rest: unknown[]) => number)(...args);
    }) as typeof actual.randomInt,
  };
});

const avatar: Avatar = { emoji: '🦊', color: '#e76f51' };
const hooks: TableHooks = { onChange: () => undefined, onEvent: () => undefined, onRemoved: () => undefined };

let current: Table[] = [];
let socketSeq = 0;

function createTable(testSettings: Partial<TableSettings> & { startingStack?: number } = {}): { table: Table; events: TableEvent[] } {
  const { startingStack = TEST_BUY_IN, ...settings } = testSettings;
  const events: TableEvent[] = [];
  const table = new Table('BLND01', { ...DEFAULT_SETTINGS, ...settings }, {
    onChange: () => undefined,
    onEvent: (_table, event) => events.push(event),
    onRemoved: () => undefined,
  });
  setTestBuyIn(table, startingStack);
  current.push(table);
  return { table, events };
}

function join(table: Table, name: string): TablePlayer {
  const added = table.addPlayer(name, avatar);
  if (!added.ok || !added.data) {
    throw new Error(`join ${name} failed`);
  }
  table.attachSocket(added.data, `socket-${++socketSeq}`);
  buyIn(table, added.data);
  return added.data;
}

/** Spustí hru s dealerom na mieste 0 (prvý účastník losovania). */
function startWithDealerAtSeatZero(table: Table): void {
  expect(table.hostStart().ok).toBe(true);
  crypto.forcedRandomInt.push(0);
  expect(table.hostDealerChoice('random').ok).toBe(true);
  vi.advanceTimersByTime(1500);
  ackIntros(table);
  expect(table.engine && !table.engine.isComplete).toBe(true);
}

/** Potvrdí za všetkých úvodné dialógy módov (Omaha, Pineapple, 7-2, Prasiatko) a počká na rozdanie. */
function ackIntros(table: Table): void {
  while (table.modeIntro) {
    for (const id of table.modeIntro.participants) {
      table.modeAck(table.players.get(id)!);
    }
    vi.advanceTimersByTime(1500);
  }
}

function actor(table: Table): TablePlayer {
  const id = table.engine?.toAct?.id;
  if (!id) {
    throw new Error('nobody to act');
  }
  return table.players.get(id)!;
}

function foldToEnd(table: Table): void {
  while (table.engine && !table.engine.isComplete) {
    expect(table.act(actor(table), { type: 'fold' }).ok).toBe(true);
  }
}

function nextHand(table: Table): void {
  foldToEnd(table);
  vi.advanceTimersByTime(HAND_PAUSE_MS);
  ackIntros(table);
  expect(table.engine && !table.engine.isComplete).toBe(true);
}

/** Ťah za hráča na pauze ide hneď (0 ms); falošné časovače posunú 0 ms timer vytvorený počas iného timera o 1 ms. */
function flushAway(): void {
  vi.advanceTimersByTime(1);
}

function chipsAtTable(table: Table): number {
  return [...table.players.values()].reduce((sum, player) => sum + player.stack + player.pendingChips, 0);
}

function chipsDuringHand(table: Table): number {
  const engine = table.engine!;
  return [...table.players.values()].reduce((sum, player) => {
    const enginePlayer = engine.player(player.id);
    return sum + (enginePlayer ? enginePlayer.stack + enginePlayer.total + enginePlayer.dead : player.stack);
  }, 0);
}

function seatView(table: Table, player: TablePlayer) {
  return table.view(player.id).players.find((seat) => seat.id === player.id)!;
}

/** Štyria hráči na miestach 0–3, dealer prvej ruky na mieste 0 → ruka 1: SB = B, BB = C; ďalej sa button posúva. */
function fourHanded(): { table: Table; events: TableEvent[]; a: TablePlayer; b: TablePlayer; c: TablePlayer; d: TablePlayer } {
  const { table, events } = createTable();
  const a = join(table, 'Adam');
  const b = join(table, 'Bea');
  const c = join(table, 'Cyril');
  const d = join(table, 'Dana');
  startWithDealerAtSeatZero(table);
  expect(table.engine!.dealerSeat).toBe(a.seat);
  expect(table.engine!.bigBlindSeat).toBe(c.seat);
  return { table, events, a, b, c, d };
}

beforeEach(() => {
  vi.useFakeTimers();
  crypto.forcedRandomInt.length = 0;
});

afterEach(() => {
  for (const table of current.splice(0)) {
    table.dispose();
  }
  vi.useRealTimers();
});

describe('short break (away)', () => {
  it('keeps the player dealt in, posts their blinds and acts for them instantly', () => {
    const { table, events } = createTable({ actionTimeoutSec: 60 });
    const a = join(table, 'Adam');
    const b = join(table, 'Bea');
    const c = join(table, 'Cyril');
    expect(table.setAway(c, true)).toEqual({ ok: true });
    expect(events.at(-1)!.text).toBe('Cyril si dáva krátku pauzu');
    expect(seatView(table, c)).toMatchObject({ away: true, sittingOut: false, missedBlinds: 'none', returnMode: null });
    startWithDealerAtSeatZero(table);
    const positions = new Set<string>();
    for (let hand = 0; hand < 3; hand++) {
      const engine = table.engine!;
      const enginePlayer = engine.player(c.id)!;
      expect(enginePlayer).toBeDefined();
      if (engine.smallBlindSeat === c.seat) {
        positions.add('SB');
        expect(enginePlayer.total).toBe(10);
      }
      if (engine.bigBlindSeat === c.seat) {
        positions.add('BB');
        expect(enginePlayer.total).toBe(20);
      }
      while (!engine.isComplete) {
        if (engine.toAct?.id === c.id) {
          const free = engine.currentBet === enginePlayer.bet;
          flushAway();
          expect(engine.toAct?.id).not.toBe(c.id);
          expect(events.filter((event) => event.playerId === c.id).at(-1)!.text).toBe(free ? 'Cyril: check' : 'Cyril: fold');
          continue;
        }
        const player = actor(table);
        const legal = engine.legalActions(player.id)!;
        expect(table.act(player, legal.callAmount > 0 ? { type: 'call' } : { type: 'check' }).ok).toBe(true);
      }
      vi.advanceTimersByTime(HAND_PAUSE_MS);
    }
    expect(positions).toEqual(new Set(['SB', 'BB']));
    expect(events.some((event) => event.text.includes('čas na ťah vypršal'))).toBe(false);
    expect(chipsAtTable(table)).toBe(6000);
    expect(table.setAway(c, false)).toEqual({ ok: true });
    expect(events.at(-1)!.text).toBe('Cyril je späť');
    expect([a, b].every((player) => !player.away)).toBe(true);
  });

  it('acts immediately when a player goes away during their own turn', () => {
    const { table } = createTable({ actionTimeoutSec: 60 });
    join(table, 'Adam');
    join(table, 'Bea');
    join(table, 'Cyril');
    startWithDealerAtSeatZero(table);
    const first = actor(table);
    table.setAway(first, true);
    flushAway();
    expect(table.engine!.player(first.id)!.lastAction).toBe('Fold');
    expect(table.engine!.toAct?.id).not.toBe(first.id);
  });

  it('auto-discards for an away player in Pineapple right away', () => {
    const { table } = createTable({ defaultVariant: 'pineapple' });
    join(table, 'Adam');
    join(table, 'Bea');
    const c = join(table, 'Cyril');
    startWithDealerAtSeatZero(table);
    while (table.engine!.street === 'preflop') {
      const player = actor(table);
      const legal = table.engine!.legalActions(player.id)!;
      table.act(player, legal.callAmount > 0 ? { type: 'call' } : { type: 'check' });
    }
    expect(table.engine!.street).toBe('discard');
    table.setAway(c, true);
    flushAway();
    expect(table.engine!.player(c.id)!.discarded).toBe(true);
    expect(table.engine!.pendingDiscards()).toHaveLength(2);
  });
});

describe('standing up and missed blinds', () => {
  it('records a missed big blind when the BB passes, then small-and-big when the SB passes', () => {
    const { table, events, a, b, c, d } = fourHanded();
    foldToEnd(table);
    expect(table.setSittingOut(d, true)).toEqual({ ok: true });
    expect(events.at(-1)!.text).toBe('Dana vstáva od stola');
    vi.advanceTimersByTime(HAND_PAUSE_MS);
    // Ruka 2: dealer B, SB C, BB A — BB prešiel cez miesto D.
    expect(table.engine!.player(d.id)).toBeUndefined();
    expect([table.engine!.dealerSeat, table.engine!.smallBlindSeat, table.engine!.bigBlindSeat]).toEqual([b.seat, c.seat, a.seat]);
    expect(d.missedBlinds).toBe('big');
    nextHand(table);
    // Ruka 3: dealer C, SB A, BB B — SB prešiel cez miesto D.
    expect([table.engine!.dealerSeat, table.engine!.smallBlindSeat, table.engine!.bigBlindSeat]).toEqual([c.seat, a.seat, b.seat]);
    expect(d.missedBlinds).toBe('small-and-big');
    expect(seatView(table, d)).toMatchObject({ sittingOut: true, missedBlinds: 'small-and-big', returnMode: null, inHand: false });
  });

  it('lets a player sit back in freely before any blind passes, refuses otherwise', () => {
    const { table, b, d } = fourHanded();
    expect(table.setSittingOut(b, true).ok).toBe(true);
    expect(table.setSittingOut(b, false)).toEqual({ ok: true });
    expect(b.sittingOut).toBe(false);
    foldToEnd(table);
    table.setSittingOut(d, true);
    vi.advanceTimersByTime(HAND_PAUSE_MS);
    expect(d.missedBlinds).toBe('big');
    expect(table.setSittingOut(d, false)).toEqual({ ok: false, error: 'Najprv si vyber, či počkáš na big blind alebo zaplatíš' });
    expect(d.sittingOut).toBe(true);
  });

  it('post: in the SB position the return waits one hand, then pays a live BB and a dead SB with chips conserved', () => {
    const { table, events, a, b, c, d } = fourHanded();
    foldToEnd(table);
    table.setSittingOut(d, true);
    vi.advanceTimersByTime(HAND_PAUSE_MS);
    expect(d.missedBlinds).toBe('big');
    expect(table.returnToGame(d, 'post')).toEqual({ ok: true });
    expect(events.at(-1)!.text).toBe('Dana dopláca zmeškané blindy a vracia sa od ďalšej ruky');
    expect(seatView(table, d)).toMatchObject({ sittingOut: true, returnMode: 'post', missedBlinds: 'big' });
    // Ruka 3: dealer C → D by bol SB, z pozície SB sa doplácať nedá → čaká; SB ho minul.
    nextHand(table);
    expect(table.engine!.dealerSeat).toBe(c.seat);
    expect(table.engine!.player(d.id)).toBeUndefined();
    expect(d.missedBlinds).toBe('small-and-big');
    expect(d.returnMode).toBe('post');
    // Ruka 4: dealer A, SB B, BB C → D je UTG a dopláca BB živý + SB mŕtvy.
    nextHand(table);
    const engine = table.engine!;
    expect([engine.dealerSeat, engine.smallBlindSeat, engine.bigBlindSeat]).toEqual([a.seat, b.seat, c.seat]);
    const poster = engine.player(d.id)!;
    expect(poster).toMatchObject({ bet: 20, total: 20, dead: 10 });
    expect(engine.totalPot).toBe(60);
    expect(d).toMatchObject({ sittingOut: false, missedBlinds: 'none', returnMode: null });
    expect(chipsDuringHand(table)).toBe(8000);
    expect(events.some((event) => event.text === `Dana dopláca zmeškané blindy: BB ${formatMoney(20, 'EUR')} + mŕtvy SB ${formatMoney(10, 'EUR')}`)).toBe(true);
    expect(engine.toAct?.id).toBe(d.id);
    expect(engine.legalActions(d.id)).toMatchObject({ canCheck: true, minRaiseTo: 40 });
    foldToEnd(table);
    expect(chipsAtTable(table)).toBe(8000);
  });

  it('wait-bb: dealt in exactly when the player is in the BB position', () => {
    const { table, events, b, d } = fourHanded();
    foldToEnd(table);
    table.setSittingOut(d, true);
    vi.advanceTimersByTime(HAND_PAUSE_MS);
    expect(table.returnToGame(d, 'wait-bb')).toEqual({ ok: true });
    expect(events.at(-1)!.text).toBe('Dana čaká na big blind');
    nextHand(table);
    expect(table.engine!.player(d.id)).toBeUndefined();
    nextHand(table);
    expect(table.engine!.player(d.id)).toBeUndefined();
    expect(seatView(table, d)).toMatchObject({ sittingOut: true, returnMode: 'wait-bb' });
    // Ruka 5: dealer B → D je BB.
    nextHand(table);
    const engine = table.engine!;
    expect(engine.dealerSeat).toBe(b.seat);
    expect(engine.bigBlindSeat).toBe(d.seat);
    expect(engine.player(d.id)).toMatchObject({ bet: 20, total: 20, dead: 0 });
    expect(d).toMatchObject({ sittingOut: false, missedBlinds: 'none', returnMode: null });
  });

  it('post from the BB position pays just the normal big blind', () => {
    const { table, events } = createTable();
    join(table, 'Adam');
    join(table, 'Bea');
    const c = join(table, 'Cyril');
    startWithDealerAtSeatZero(table);
    const late = join(table, 'Dana');
    expect(late).toMatchObject({ sittingOut: true, missedBlinds: 'big', returnMode: 'wait-bb' });
    expect(events.some((event) => event.text === 'Dana čaká na big blind (alebo ho môže zaplatiť hneď)')).toBe(true);
    expect(table.returnToGame(late, 'post').ok).toBe(true);
    // Ruka 2: dealer B, SB C, BB Dana.
    nextHand(table);
    expect(table.engine!.smallBlindSeat).toBe(c.seat);
    expect(table.engine!.player(late.id)).toMatchObject({ bet: 20, total: 20, dead: 0 });
  });

  it('a new player mid-game must wait for the BB or post it; with post and a normal position they pay a live BB only', () => {
    const { table, a, b, c, d } = fourHanded();
    table.leave(d);
    nextHand(table);
    nextHand(table);
    // Ruky 1–3 odohrané (dealer A, B, C); Eva príde pred rukou 4 s dealerom A.
    foldToEnd(table);
    const eva = join(table, 'Eva');
    expect(eva.seat).toBe(3);
    expect(seatView(table, eva)).toMatchObject({ sittingOut: true, missedBlinds: 'big', returnMode: 'wait-bb' });
    expect(table.setSittingOut(eva, false)).toEqual({ ok: false, error: 'Najprv si vyber, či počkáš na big blind alebo zaplatíš' });
    expect(table.returnToGame(eva, 'post').ok).toBe(true);
    vi.advanceTimersByTime(HAND_PAUSE_MS);
    const engine = table.engine!;
    expect([engine.dealerSeat, engine.smallBlindSeat, engine.bigBlindSeat]).toEqual([a.seat, b.seat, c.seat]);
    expect(engine.player(eva.id)).toMatchObject({ bet: 20, total: 20, dead: 0 });
  });

  it('heads-up: a returning player is dealt in right away without posting', () => {
    const { table } = createTable();
    const a = join(table, 'Adam');
    const b = join(table, 'Bea');
    startWithDealerAtSeatZero(table);
    foldToEnd(table);
    table.setSittingOut(b, true);
    const c = join(table, 'Cyril');
    expect(c.missedBlinds).toBe('big');
    vi.advanceTimersByTime(HAND_PAUSE_MS);
    // A je jediný bežný hráč → Cyril (wait-bb) sa vracia hneď a nič nedopláca.
    expect(table.engine!.players.map((player) => player.id).sort()).toEqual([a.id, c.id].sort());
    expect(table.engine!.totalPot).toBe(30);
    expect(c).toMatchObject({ sittingOut: false, missedBlinds: 'none', returnMode: null });
  });

  it('a busted player credited before the blinds pass plays on; standing up still owes after a BB pass', () => {
    const { table } = createTable({ startingStack: 2000 });
    const a = join(table, 'Adam');
    const b = join(table, 'Bea');
    const c = join(table, 'Cyril');
    startWithDealerAtSeatZero(table);
    foldToEnd(table);
    expect(table.bankChips(c, -c.stack, '', 'Adam').ok).toBe(true);
    expect(c.sittingOut).toBe(true);
    expect(table.bankChips(c, 1000, '', 'Adam').ok).toBe(true);
    expect(c).toMatchObject({ sittingOut: false, missedBlinds: 'none' });
    vi.advanceTimersByTime(HAND_PAUSE_MS);
    expect(table.engine!.player(c.id)).toBeDefined();
    expect([a, b].every((player) => table.engine!.player(player.id))).toBe(true);
  });

  it('a credit for a player who owes blinds keeps them waiting for the BB', () => {
    const { table, d } = fourHanded();
    foldToEnd(table);
    expect(table.bankChips(d, -d.stack, '', 'Adam').ok).toBe(true);
    vi.advanceTimersByTime(HAND_PAUSE_MS);
    expect(d.missedBlinds).toBe('big');
    foldToEnd(table);
    expect(table.bankChips(d, 500, '', 'Adam').ok).toBe(true);
    expect(d).toMatchObject({ sittingOut: true, missedBlinds: 'big', returnMode: 'wait-bb' });
  });

  it('nobody owes anything in the lobby', () => {
    const { table, d } = fourHanded();
    foldToEnd(table);
    table.setSittingOut(d, true);
    vi.advanceTimersByTime(HAND_PAUSE_MS);
    table.returnToGame(d, 'post');
    expect(d.missedBlinds).toBe('big');
    expect(table.hostToLobby().ok).toBe(true);
    foldToEnd(table);
    expect(table.phase).toBe('lobby');
    expect(d).toMatchObject({ sittingOut: false, missedBlinds: 'none', returnMode: null });
    expect(table.setSittingOut(d, true).ok).toBe(true);
    expect(table.returnToGame(d, 'wait-bb')).toEqual({ ok: true });
    expect(d.sittingOut).toBe(false);
    const late = join(table, 'Eva');
    expect(late).toMatchObject({ sittingOut: false, missedBlinds: 'none', returnMode: null });
  });
});

describe('persistence of break / stand-up state', () => {
  function roundTrip(table: Table): Table {
    const snapshot = JSON.parse(JSON.stringify(table.toSnapshot())) as TableSnapshot;
    const restored = Table.fromSnapshot(snapshot, hooks);
    current.push(restored);
    return restored;
  }

  it('restores away, missedBlinds, returnMode and the blind markers', () => {
    const { table, a, d } = fourHanded();
    foldToEnd(table);
    table.setAway(a, true);
    table.setSittingOut(d, true);
    vi.advanceTimersByTime(HAND_PAUSE_MS);
    table.returnToGame(d, 'wait-bb');
    foldToEnd(table);
    const snapshot = table.toSnapshot();
    expect(snapshot.lastBigBlindSeat).toBe(a.seat);
    const restored = roundTrip(table);
    expect(restored.players.get(a.id)).toMatchObject({ away: true, sittingOut: false });
    expect(restored.players.get(d.id)).toMatchObject({ away: false, sittingOut: true, missedBlinds: 'big', returnMode: 'wait-bb' });
    expect(restored.toSnapshot()).toMatchObject({ lastSmallBlindSeat: snapshot.lastSmallBlindSeat, lastBigBlindSeat: a.seat });
  });

  it('a voided hand also voids the blind debt changes made when it was dealt', () => {
    const { table, d } = fourHanded();
    foldToEnd(table);
    table.setSittingOut(d, true);
    vi.advanceTimersByTime(HAND_PAUSE_MS);
    table.returnToGame(d, 'post');
    nextHand(table);
    nextHand(table);
    expect(table.engine!.player(d.id)!.dead).toBe(10);
    const restored = roundTrip(table);
    expect(restored.players.get(d.id)).toMatchObject({ sittingOut: true, missedBlinds: 'small-and-big', returnMode: 'post', stack: 2000 });
  });

  it('loads older files without the new fields with defaults', () => {
    const { table, d } = fourHanded();
    foldToEnd(table);
    const snapshot = JSON.parse(JSON.stringify(table.toSnapshot())) as TableSnapshot;
    for (const player of snapshot.players) {
      delete player.away;
      delete player.missedBlinds;
      delete player.returnMode;
    }
    delete snapshot.lastSmallBlindSeat;
    delete snapshot.lastBigBlindSeat;
    snapshot.nextHand = { sevenDeuce: true };
    const restored = Table.fromSnapshot(snapshot, hooks);
    current.push(restored);
    expect(restored.players.get(d.id)).toMatchObject({ away: false, missedBlinds: 'none', returnMode: null });
    expect(restored.nextHand).toBeNull();
    expect(restored.toSnapshot()).toMatchObject({ lastSmallBlindSeat: -1, lastBigBlindSeat: -1 });
  });
});

describe('7-2 for the whole game', () => {
  it('ignores sevenDeuce in the next-hand override', () => {
    const { table } = createTable();
    join(table, 'Adam');
    expect(table.hostNextHand({ sevenDeuce: true }).ok).toBe(true);
    expect(table.nextHand).toBeNull();
    expect(table.hostNextHand({ variant: 'pineapple', sevenDeuce: true }).ok).toBe(true);
    expect(table.nextHand).toEqual({ variant: 'pineapple', hands: 1 });
  });

  it('switches on from the next hand until switched off', () => {
    const { table, events } = createTable();
    join(table, 'Adam');
    join(table, 'Bea');
    startWithDealerAtSeatZero(table);
    expect(table.engine!.rules.sevenDeuce).toBe(false);
    expect(table.hostSettings({ sevenDeuceAlways: true }).ok).toBe(true);
    expect(events.at(-1)!.text).toBe('Pravidlo 7-2 je zapnuté (od ďalšej ruky)');
    expect(events.some((event) => event.text.startsWith('Nové pravidlá'))).toBe(false);
    expect(table.engine!.rules.sevenDeuce).toBe(false);
    nextHand(table);
    expect(table.engine!.rules.sevenDeuce).toBe(true);
    nextHand(table);
    expect(table.engine!.rules.sevenDeuce).toBe(true);
    foldToEnd(table);
    expect(table.hostSettings({ sevenDeuceAlways: false }).ok).toBe(true);
    expect(events.at(-1)!.text).toBe('Pravidlo 7-2 je vypnuté');
    vi.advanceTimersByTime(HAND_PAUSE_MS);
    expect(table.engine!.rules.sevenDeuce).toBe(false);
  });
});

describe('gender-neutral event texts', () => {
  const PAST_TENSE = /\b(prisadol|odpojil|premenoval|dal pauzu|vrátil|odišiel|vyhodený|vytiahol|vyhral|nestihol|pridelil|odobral|pridal|spustil|pozastavil|zvolil|zrušil|ukončil|prišiel|zahodil|potvrdili)\b/;

  it('uses present tense for players and the host across a whole session', () => {
    const { table, events } = createTable({ defaultVariant: 'pineapple', sevenDeuceAlways: true });
    const a = join(table, 'Zuzka');
    const b = join(table, 'Peťo');
    const c = join(table, 'Juraj');
    table.hostSetAdmin(a, b, true);
    table.hostSetAdmin(b, b, false);
    table.updateProfile(c, { name: 'Jurko' });
    startWithDealerAtSeatZero(table);
    table.bankChips(b, 500, '', 'Zuzka');
    table.setAway(c, true);
    flushAway();
    foldToEnd(table);
    table.bankChips(b, -100, '', 'Zuzka');
    table.setSittingOut(b, true);
    table.hostPause();
    table.hostStart();
    table.detachSocket(c, [...c.sockets][0]);
    table.leave(b, true, 'Zuzka');
    table.hostToLobby();
    const texts = events.map((event) => event.text);
    expect(texts).toContain('Zuzka prisadá ku stolu — čaká na dobitie od bankára');
    expect(texts).toContain('Juraj mení meno na Jurko');
    expect(texts).toContain('Zuzka prideľuje práva hosta hráčovi Peťo');
    expect(texts).toContain('Host spúšťa hru — rozhoduje sa o dealer buttone');
    expect(texts).toContain('Dealer button náhodne dostáva Zuzka');
    expect(texts.some((text) => text.startsWith(`Bankár dobíja ${formatMoney(500, 'EUR')} hráčovi Peťo (na dlh)`))).toBe(true);
    expect(texts).toContain(`Bankár vyberá ${formatMoney(100, 'EUR')} hráčovi Peťo (bank dlží)`);
    expect(texts).toContain('Peťo vstáva od stola');
    expect(texts).toContain('Host pozastavuje hru');
    expect(texts).toContain('Jurko je offline');
    expect(texts).toContain('Zuzka vyhadzuje zo stola hráča Peťo');
    expect(texts.some((text) => / vyhráva /.test(text))).toBe(true);
    for (const text of texts) {
      expect(text).not.toMatch(PAST_TENSE);
    }
  });
});
