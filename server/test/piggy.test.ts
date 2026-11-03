import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Avatar, Card, TableEvent, TableSettings } from '../../shared/types';
import { DEFAULT_SETTINGS, HAND_PAUSE_MS, MODE_INTRO_TIMEOUT_SEC, PIGGY_CELEBRATION_MS, PIGGY_TARGET_WINS } from '../../shared/constants';
import { formatMoney } from '../../shared/money';
import { Table, type TableHooks, type TablePlayer, type TableSnapshot } from '../Table';
import { stackDeck, TEST_BUY_IN, buyIn, setTestBuyIn } from './helpers';

const rigged = vi.hoisted(() => ({ forcedRandomInt: [] as number[], decks: [] as Card[][] }));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    randomInt: ((...args: Parameters<typeof actual.randomInt>) => {
      const forced = rigged.forcedRandomInt.shift();
      return forced ?? (actual.randomInt as (...rest: unknown[]) => number)(...args);
    }) as typeof actual.randomInt,
  };
});

vi.mock('../poker/cards', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../poker/cards')>();
  return {
    ...actual,
    shuffle: (<T>(items: T[], random?: (max: number) => number): T[] => {
      const deck = items.length === 52 ? rigged.decks.shift() : undefined;
      return deck ? ([...deck] as T[]) : actual.shuffle(items, random);
    }) as typeof actual.shuffle,
  };
});

const avatar: Avatar = { emoji: '🦊', color: '#e76f51' };
const hooks: TableHooks = { onChange: () => undefined, onEvent: () => undefined, onRemoved: () => undefined };
const INTRO_DELAY_MS = 1500;
const money = (cents: number) => formatMoney(cents, 'EUR');

let current: Table[] = [];
let socketSeq = 0;

function createTable(testSettings: Partial<TableSettings> & { startingStack?: number } = {}): { table: Table; events: TableEvent[] } {
  const { startingStack = TEST_BUY_IN, ...settings } = testSettings;
  const events: TableEvent[] = [];
  const table = new Table('PIGY01', { ...DEFAULT_SETTINGS, ...settings }, {
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

function inHand(table: Table): boolean {
  return !!table.engine && !table.engine.isComplete;
}

/** Losovanie preskočí — dealer prvej ruky je hráč na mieste 0; úvody módov sa NEpotvrdzujú. */
function startGame(table: Table): void {
  expect(table.hostStart().ok).toBe(true);
  rigged.forcedRandomInt.push(0);
  expect(table.hostDealerChoice('random').ok).toBe(true);
  vi.advanceTimersByTime(1500);
}

function ackAll(table: Table): void {
  const intro = table.modeIntro!;
  for (const id of [...intro.participants]) {
    table.modeAck(table.players.get(id)!);
  }
}

/** Potvrdí všetky úvody a počká na rozdanie ruky. */
function ackIntros(table: Table): void {
  while (table.modeIntro) {
    ackAll(table);
    vi.advanceTimersByTime(INTRO_DELAY_MS);
  }
  expect(inHand(table)).toBe(true);
}

function actor(table: Table): TablePlayer {
  const id = table.engine?.toAct?.id;
  if (!id) {
    throw new Error('nobody to act');
  }
  return table.players.get(id)!;
}

/** Všetci okrem `winner` foldujú; `winner` dorovná / checkuje. */
function winHand(table: Table, winner: TablePlayer): void {
  while (inHand(table)) {
    const player = actor(table);
    if (player === winner) {
      const legal = table.engine!.legalActions(player.id)!;
      expect(table.act(player, legal.callAmount > 0 ? { type: 'call' } : { type: 'check' }).ok).toBe(true);
    } else {
      expect(table.act(player, { type: 'fold' }).ok).toBe(true);
    }
  }
}

/** Všetci dorovnávajú/checkujú až do showdownu. */
function checkDown(table: Table): void {
  while (inHand(table)) {
    const player = actor(table);
    const legal = table.engine!.legalActions(player.id)!;
    expect(table.act(player, legal.callAmount > 0 ? { type: 'call' } : { type: 'check' }).ok).toBe(true);
  }
}

function nextHand(table: Table): void {
  vi.advanceTimersByTime(Math.max(HAND_PAUSE_MS, PIGGY_CELEBRATION_MS));
  if (table.modeIntro) {
    ackIntros(table);
  }
  expect(inHand(table)).toBe(true);
}

/** Všetky žetóny pri stole: stacky (počas ruky z enginu vrátane stávok), čakajúce žetóny a prasiatko. */
function totalChips(table: Table): number {
  const engine = inHand(table) ? table.engine! : null;
  const players = [...table.players.values()].reduce((sum, player) => {
    const enginePlayer = engine?.player(player.id);
    const stack = enginePlayer ? enginePlayer.stack + enginePlayer.total + enginePlayer.dead : player.stack;
    return sum + stack + player.pendingChips;
  }, 0);
  return players + (table.piggy?.status === 'running' ? table.piggy.amount : 0);
}

/** Traja hráči na miestach 0–2, dealer prvej ruky na mieste 0, Prasiatko spustené v čakárni a úvod potvrdený. */
function piggyGame(settings: Partial<TableSettings> = {}): { table: Table; events: TableEvent[]; a: TablePlayer; b: TablePlayer; c: TablePlayer } {
  const { table, events } = createTable(settings);
  const a = join(table, 'Adam');
  const b = join(table, 'Bea');
  const c = join(table, 'Cyril');
  expect(table.hostPiggy('start').ok).toBe(true);
  startGame(table);
  expect(table.modeIntro?.mode).toBe('piggy');
  ackIntros(table);
  return { table, events, a, b, c };
}

beforeEach(() => {
  vi.useFakeTimers();
  rigged.forcedRandomInt.length = 0;
  rigged.decks.length = 0;
});

afterEach(() => {
  for (const table of current.splice(0)) {
    table.dispose();
  }
  vi.useRealTimers();
});

describe('piggy entries', () => {
  it('takes 1 BB from every dealt player into the piggy, not into the pot, before the blinds', () => {
    const { table, events, a, b, c } = piggyGame();
    const engine = table.engine!;
    expect(table.piggy).toMatchObject({ status: 'running', amount: 60, entry: 20, target: PIGGY_TARGET_WINS, startedAtHand: 1 });
    expect(table.piggy!.contributed).toEqual({ [a.id]: 20, [b.id]: 20, [c.id]: 20 });
    expect(table.piggy!.wins).toEqual({ [a.id]: 0, [b.id]: 0, [c.id]: 0 });
    expect(engine.totalPot).toBe(30);
    expect(engine.player(a.id)!.startStack).toBe(1980);
    expect(engine.player(b.id)!.stack).toBe(1970);
    expect(engine.player(c.id)!.stack).toBe(1960);
    expect(events.map((event) => event.text)).toContain(`Do prasiatka ide 3 × ${money(20)} (spolu ${money(60)})`);
    expect(totalChips(table)).toBe(6000);
    const view = table.view(a.id);
    expect(view.piggy).toMatchObject({ status: 'running', amount: 60, winners: [] });
    expect(view.players.find((seat) => seat.id === a.id)!.stack).toBe(1980);
  });

  it('keeps the entry fixed at the BB of the start and conserves chips over several hands', () => {
    const { table, a, b, c } = piggyGame();
    winHand(table, c);
    expect(table.hostSettings({ smallBlind: 20, bigBlind: 40 }).ok).toBe(true);
    nextHand(table);
    expect(table.piggy!.amount).toBe(120);
    expect(totalChips(table)).toBe(6000);
    winHand(table, a);
    nextHand(table);
    expect(table.piggy!.amount).toBe(180);
    expect(table.piggy!.contributed[b.id]).toBe(60);
    expect(totalChips(table)).toBe(6000);
  });

  it('does not deal in a player who cannot cover more than the entry; they keep their chips and return when credited', () => {
    const { table, events, a, b, c } = piggyGame();
    winHand(table, b);
    vi.advanceTimersByTime(0);
    expect(table.bankChips(c, -(c.stack - 20)).ok).toBe(true);
    expect(c.stack).toBe(20);
    nextHand(table);
    expect(table.engine!.player(c.id)).toBeUndefined();
    expect(c).toMatchObject({ stack: 20, sittingOut: true });
    expect(events.map((event) => event.text)).toContain('Cyril nemá dosť žetónov na vstup do prasiatka — čaká na dobitie od bankára');
    expect(table.setSittingOut(c, false)).toEqual({ ok: false, error: 'Nemáš dosť žetónov na vstup do prasiatka — požiadaj bankára o dobitie' });
    expect(table.piggy!.contributed[c.id]).toBe(20);
    winHand(table, a);
    expect(table.bankChips(c, 500).ok).toBe(true);
    expect(c).toMatchObject({ stack: 520, sittingOut: false, missedBlinds: 'none' });
    nextHand(table);
    expect(table.engine!.player(c.id)!.startStack).toBe(500);
    expect(table.piggy!.contributed[c.id]).toBe(40);
  });
});

describe('piggy wins and payout', () => {
  it('gives a circle to every hand winner and pays the whole piggy at the third win', () => {
    const { table, events, a, b, c } = piggyGame();
    winHand(table, a);
    expect(table.piggy!.wins[a.id]).toBe(1);
    expect(events.map((event) => event.text)).toContain(`Adam získava krúžok v Prasiatku (1/${PIGGY_TARGET_WINS})`);
    nextHand(table);
    winHand(table, a);
    nextHand(table);
    winHand(table, b);
    expect(table.piggy!.wins).toEqual({ [a.id]: 2, [b.id]: 1, [c.id]: 0 });
    nextHand(table);
    expect(table.piggy!.amount).toBe(240);
    expect(totalChips(table)).toBe(6000);
    winHand(table, a);
    expect(table.piggy).toMatchObject({ status: 'finished', amount: 240, winners: [{ playerId: a.id, playerName: 'Adam', amount: 240 }] });
    expect(table.piggy!.wins[a.id]).toBe(3);
    expect(events.map((event) => event.text)).toContain(`Adam vyhráva Prasiatko — ${money(240)}!`);
    expect(events.find((event) => event.text.startsWith('Adam vyhráva Prasiatko'))!.kind).toBe('result');
    expect(totalChips(table)).toBe(6000);
    expect([a, b, c].reduce((sum, player) => sum + player.stack, 0)).toBe(6000);
    expect(table.view(b.id).piggy?.status).toBe('finished');

    vi.advanceTimersByTime(HAND_PAUSE_MS);
    expect(inHand(table)).toBe(false);
    expect(table.piggy?.status).toBe('finished');
    vi.advanceTimersByTime(PIGGY_CELEBRATION_MS - HAND_PAUSE_MS);
    expect(table.piggy).toBeNull();
    expect(inHand(table)).toBe(true);
    expect(table.engine!.totalPot).toBe(30);
    expect(totalChips(table)).toBe(6000);
  });

  it('counts a split pot as a win for every player sharing it and splits a simultaneous piggy win', () => {
    const { table, events, a, b, c } = piggyGame();
    winHand(table, a);
    table.piggy!.wins[b.id] = 2;
    table.piggy!.wins[c.id] = 2;
    table.piggy!.wins[a.id] = 1;
    vi.advanceTimersByTime(HAND_PAUSE_MS - 1);
    rigged.decks.push(stackDeck(['2c 3d', '2d 3c', '2h 4c'], 'As Ks Qs Js Ts'));
    vi.advanceTimersByTime(1);
    expect(table.engine!.dealerSeat).toBe(b.seat);
    expect(table.piggy!.amount).toBe(120);
    checkDown(table);
    expect(new Set(table.engine!.result!.winners.map((winner) => winner.playerId))).toEqual(new Set([a.id, b.id, c.id]));
    expect(table.piggy!.status).toBe('finished');
    expect(table.piggy!.wins).toEqual({ [a.id]: 2, [b.id]: 3, [c.id]: 3 });
    expect(table.piggy!.winners).toEqual([
      { playerId: c.id, playerName: 'Cyril', amount: 60 },
      { playerId: b.id, playerName: 'Bea', amount: 60 },
    ]);
    expect(events.map((event) => event.text)).toContain(`Prasiatko si delia Cyril (${money(60)}) a Bea (${money(60)})!`);
    expect([a, b, c].reduce((sum, player) => sum + player.stack, 0)).toBe(6000);
  });

  it('gives the odd cent to the first winner left of the button', () => {
    const { table, a, b, c } = piggyGame();
    winHand(table, a);
    table.piggy!.amount += 1;
    a.stack -= 1;
    table.piggy!.wins[b.id] = 2;
    table.piggy!.wins[c.id] = 2;
    vi.advanceTimersByTime(HAND_PAUSE_MS - 1);
    rigged.decks.push(stackDeck(['2c 3d', '2d 3c', '2h 4c'], 'As Ks Qs Js Ts'));
    vi.advanceTimersByTime(1);
    checkDown(table);
    expect(table.piggy!.winners.map((winner) => [winner.playerId, winner.amount])).toEqual([[c.id, 61], [b.id, 60]]);
  });
});

describe('piggy cancel, joiners and leavers', () => {
  it('refunds own contributions and splits a departed player’s entries among the present contributors', () => {
    const { table, events, a, b, c } = piggyGame();
    winHand(table, a);
    table.leave(c);
    const before = { a: a.stack, b: b.stack };
    expect(table.piggy!.amount).toBe(60);
    expect(table.hostPiggy('cancel').ok).toBe(true);
    expect(table.piggy).toBeNull();
    expect(a.stack).toBe(before.a + 30);
    expect(b.stack).toBe(before.b + 30);
    expect(events.map((event) => event.text)).toContain('Host ruší Prasiatko — vstupy sa vracajú');
    expect(table.hostPiggy('cancel')).toEqual({ ok: false, error: 'Prasiatko nebeží' });
  });

  it('refunds as pending chips during a hand and keeps chips conserved', () => {
    const { table, a, b } = piggyGame();
    const total = totalChips(table);
    expect(table.hostPiggy('cancel').ok).toBe(true);
    expect(a.pendingChips).toBe(20);
    expect(totalChips(table)).toBe(total);
    winHand(table, b);
    expect(a.pendingChips).toBe(0);
    expect([...table.players.values()].reduce((sum, player) => sum + player.stack, 0)).toBe(6000);
    vi.advanceTimersByTime(HAND_PAUSE_MS);
    expect(table.engine!.totalPot).toBe(30);
  });

  it('refuses a second start and starting during the dealer draw; validates the action', () => {
    const { table } = createTable();
    join(table, 'Adam');
    join(table, 'Bea');
    expect(table.hostPiggy('start').ok).toBe(true);
    expect(table.hostPiggy('start')).toEqual({ ok: false, error: 'Prasiatko už beží' });
    expect(table.hostPiggy('cancel').ok).toBe(true);
    expect(table.hostStart().ok).toBe(true);
    expect(table.hostPiggy('start')).toEqual({ ok: false, error: 'Počas rozhodovania o dealer buttone sa Prasiatko nedá spustiť' });
    expect(table.hostPiggy('nope' as 'start')).toEqual({ ok: false, error: 'Neplatná voľba' });
  });

  it('starts mid-game from the next hand; a joiner gets 0 wins from their first dealt hand, a leaver’s wins drop', () => {
    const { table, events } = createTable();
    const a = join(table, 'Adam');
    const b = join(table, 'Bea');
    const c = join(table, 'Cyril');
    startGame(table);
    expect(inHand(table)).toBe(true);
    expect(table.hostPiggy('start').ok).toBe(true);
    expect(table.piggy!.startedAtHand).toBe(2);
    expect(events.map((event) => event.text)).toContain(`Host spúšťa Prasiatko — vstup ${money(20)} do prasiatka pred každou rukou, prvý s 3 výhrami berie všetko`);
    winHand(table, a);
    expect(table.piggy!.wins[a.id]).toBe(0);
    vi.advanceTimersByTime(HAND_PAUSE_MS);
    expect(table.modeIntro?.mode).toBe('piggy');
    ackIntros(table);
    winHand(table, c);
    expect(table.piggy!.wins[c.id]).toBe(1);
    const d = join(table, 'Dana');
    expect(table.piggy!.wins[d.id]).toBeUndefined();
    expect(table.returnToGame(d, 'post').ok).toBe(true);
    table.leave(c);
    expect(table.piggy!.wins[c.id]).toBeUndefined();
    expect(table.piggy!.contributed[c.id]).toBe(20);
    nextHand(table);
    expect(table.engine!.player(d.id)).toBeDefined();
    expect(table.piggy!.wins[d.id]).toBe(0);
    expect(table.piggy!.contributed[d.id]).toBe(20);
    expect(b.stack).toBeGreaterThan(0);
  });

  it('keeps running through the lobby and continues after the restart of the game', () => {
    const { table, a } = piggyGame();
    winHand(table, a);
    expect(table.hostToLobby().ok).toBe(true);
    expect(table.phase).toBe('lobby');
    expect(table.piggy).toMatchObject({ status: 'running', amount: 60 });
    startGame(table);
    expect(table.modeIntro?.mode).toBe('piggy');
    ackIntros(table);
    expect(table.piggy).toMatchObject({ amount: 120 });
    expect(table.piggy!.wins[a.id]).toBe(1);
  });
});

describe('piggy persistence', () => {
  function roundTrip(table: Table): Table {
    const snapshot = JSON.parse(JSON.stringify(table.toSnapshot())) as TableSnapshot;
    const restored = Table.fromSnapshot(snapshot, hooks);
    current.push(restored);
    return restored;
  }

  it('restores a running piggy between hands', () => {
    const { table, a, b } = piggyGame();
    winHand(table, a);
    const restored = roundTrip(table);
    expect(restored.piggy).toMatchObject({ status: 'running', amount: 60, entry: 20, wins: { [a.id]: 1 }, contributed: { [b.id]: 20 } });
    expect(restored.view(a.id).piggy?.amount).toBe(60);
  });

  it('a voided hand rolls back the entries paid when it was dealt', () => {
    const { table, a, b, c } = piggyGame();
    winHand(table, a);
    nextHand(table);
    expect(table.piggy!.amount).toBe(120);
    const restored = roundTrip(table);
    expect(restored.piggy).toMatchObject({ amount: 60, contributed: { [a.id]: 20, [b.id]: 20, [c.id]: 20 } });
    const stacks = [a, b, c].map((player) => restored.players.get(player.id)!.stack);
    expect(stacks.reduce((sum, stack) => sum + stack, 0) + restored.piggy!.amount).toBe(6000);
    expect(restored.players.get(a.id)!.stack).toBe(a.stack + 20);
  });

  it('does not persist a finished piggy and loads older files without the field', () => {
    const { table, a } = piggyGame();
    table.piggy!.wins[a.id] = 2;
    winHand(table, a);
    expect(table.piggy?.status).toBe('finished');
    expect(table.toSnapshot().piggy).toBeNull();
    const snapshot = JSON.parse(JSON.stringify(table.toSnapshot())) as TableSnapshot;
    delete snapshot.piggy;
    delete snapshot.dealtModes;
    const restored = Table.fromSnapshot(snapshot, hooks);
    current.push(restored);
    expect(restored.piggy).toBeNull();
    expect(restored.view(a.id).modeIntro).toBeNull();
  });
});

describe('mode intro', () => {
  it('gates the first piggy hand until every participant acknowledges', () => {
    const { table } = createTable();
    const a = join(table, 'Adam');
    const b = join(table, 'Bea');
    const c = join(table, 'Cyril');
    expect(table.hostPiggy('start').ok).toBe(true);
    startGame(table);
    expect(inHand(table)).toBe(false);
    const intro = table.view(a.id).modeIntro!;
    expect(intro).toMatchObject({ mode: 'piggy', acknowledged: [] });
    expect(new Set(intro.participants)).toEqual(new Set([a.id, b.id, c.id]));
    expect(intro.deadline).toBe(Date.now() + MODE_INTRO_TIMEOUT_SEC * 1000);
    expect(table.view(a.id).nextHandAt).toBeNull();
    expect(table.modeAck(a).ok).toBe(true);
    expect(table.modeAck(b).ok).toBe(true);
    vi.advanceTimersByTime(10_000);
    expect(inHand(table)).toBe(false);
    expect(table.modeAck(c).ok).toBe(true);
    expect(table.modeIntro).toBeNull();
    expect(table.modeAck(c)).toEqual({ ok: false, error: 'Pravidlá módu sa teraz nepotvrdzujú' });
    vi.advanceTimersByTime(INTRO_DELAY_MS);
    expect(inHand(table)).toBe(true);
    expect(table.engine!.dealerSeat).toBe(a.seat);
    winHand(table, a);
    vi.advanceTimersByTime(HAND_PAUSE_MS);
    expect(table.modeIntro).toBeNull();
    expect(inHand(table)).toBe(true);
  });

  it('auto-acknowledges disconnected and away participants and refuses a spectator', () => {
    const { table } = createTable();
    const a = join(table, 'Adam');
    const b = join(table, 'Bea');
    const c = join(table, 'Cyril');
    expect(table.hostPiggy('start').ok).toBe(true);
    startGame(table);
    const late = join(table, 'Dana');
    expect(table.modeAck(late)).toEqual({ ok: false, error: 'Nie si účastníkom tejto ruky' });
    table.detachSocket(b, [...b.sockets][0]);
    expect(table.modeIntro!.acknowledged).toEqual([b.id]);
    table.setAway(c, true);
    expect(table.modeIntro!.acknowledged).toContain(c.id);
    expect(table.modeAck(a).ok).toBe(true);
    expect(table.modeIntro).toBeNull();
    vi.advanceTimersByTime(INTRO_DELAY_MS);
    expect(inHand(table)).toBe(true);
  });

  it('deals after the deadline without the missing acknowledgements', () => {
    const { table, events } = createTable({ defaultVariant: 'omaha' });
    join(table, 'Adam');
    join(table, 'Bea');
    startGame(table);
    expect(table.modeIntro?.mode).toBe('omaha');
    vi.advanceTimersByTime(MODE_INTRO_TIMEOUT_SEC * 1000);
    expect(table.modeIntro).toBeNull();
    expect(events.map((event) => event.text)).toContain('Čas na potvrdenie pravidiel vypršal — rozdáva sa');
    vi.advanceTimersByTime(INTRO_DELAY_MS);
    expect(table.engine!.rules.variant).toBe('omaha');
  });

  it('shows Hold’em without an intro, an Omaha special round once, and again after Hold’em in between', () => {
    const { table } = createTable();
    const a = join(table, 'Adam');
    join(table, 'Bea');
    startGame(table);
    expect(table.modeIntro).toBeNull();
    expect(inHand(table)).toBe(true);
    table.hostNextHand({ variant: 'omaha' });
    winHand(table, a);
    vi.advanceTimersByTime(HAND_PAUSE_MS);
    expect(table.modeIntro?.mode).toBe('omaha');
    ackIntros(table);
    expect(table.engine!.rules.variant).toBe('omaha');
    winHand(table, a);
    table.hostSettings({ defaultVariant: 'omaha' });
    vi.advanceTimersByTime(HAND_PAUSE_MS);
    expect(table.modeIntro).toBeNull();
    expect(table.engine!.rules.variant).toBe('omaha');
    winHand(table, a);
    table.hostSettings({ defaultVariant: 'holdem' });
    vi.advanceTimersByTime(HAND_PAUSE_MS);
    expect(table.engine!.rules.variant).toBe('holdem');
    winHand(table, a);
    table.hostNextHand({ variant: 'omaha' });
    vi.advanceTimersByTime(HAND_PAUSE_MS);
    expect(table.modeIntro?.mode).toBe('omaha');
  });

  it('queues several new modes one after another (Pineapple, then 7-2) and repeats none on the next hand', () => {
    const { table } = createTable({ defaultVariant: 'pineapple', sevenDeuceAlways: true });
    const a = join(table, 'Adam');
    join(table, 'Bea');
    startGame(table);
    expect(table.modeIntro?.mode).toBe('pineapple');
    ackAll(table);
    expect(table.modeIntro).toBeNull();
    vi.advanceTimersByTime(INTRO_DELAY_MS);
    expect(table.modeIntro?.mode).toBe('seven-deuce');
    ackAll(table);
    vi.advanceTimersByTime(INTRO_DELAY_MS);
    expect(table.engine!.rules).toMatchObject({ variant: 'pineapple', sevenDeuce: true });
    expect(table.engine!.dealerSeat).toBe(a.seat);
    winHand(table, a);
    vi.advanceTimersByTime(HAND_PAUSE_MS);
    expect(table.modeIntro).toBeNull();
    expect(inHand(table)).toBe(true);
  });

  it('shows 7-2 when it is switched on mid-game, and not again after an Omaha round in between', () => {
    const { table } = createTable();
    const a = join(table, 'Adam');
    join(table, 'Bea');
    startGame(table);
    table.hostSettings({ sevenDeuceAlways: true });
    winHand(table, a);
    vi.advanceTimersByTime(HAND_PAUSE_MS);
    expect(table.modeIntro?.mode).toBe('seven-deuce');
    ackIntros(table);
    table.hostNextHand({ variant: 'omaha' });
    winHand(table, a);
    vi.advanceTimersByTime(HAND_PAUSE_MS);
    expect(table.modeIntro?.mode).toBe('omaha');
    ackIntros(table);
    winHand(table, a);
    vi.advanceTimersByTime(HAND_PAUSE_MS);
    expect(table.modeIntro).toBeNull();
    expect(table.engine!.rules).toMatchObject({ variant: 'holdem', sevenDeuce: true });
  });

  it('a pause cancels the intro and it shows again when the game resumes; a cancelled special round closes it', () => {
    const { table } = createTable();
    const a = join(table, 'Adam');
    join(table, 'Bea');
    startGame(table);
    table.hostNextHand({ variant: 'pineapple' });
    winHand(table, a);
    vi.advanceTimersByTime(HAND_PAUSE_MS);
    expect(table.modeIntro?.mode).toBe('pineapple');
    expect(table.hostPause().ok).toBe(true);
    expect(table.modeIntro).toBeNull();
    expect(table.hostStart().ok).toBe(true);
    vi.advanceTimersByTime(1500);
    expect(table.modeIntro?.mode).toBe('pineapple');
    table.hostNextHand(null);
    expect(table.modeIntro).toBeNull();
    vi.advanceTimersByTime(INTRO_DELAY_MS);
    expect(table.engine!.rules.variant).toBe('holdem');
  });
});

describe('seat change while owing blinds', () => {
  it('a playing player who moves seats mid-game waits for the BB; a standing player keeps owing; heads-up is free', () => {
    const { table, events } = createTable();
    const a = join(table, 'Adam');
    const b = join(table, 'Bea');
    const c = join(table, 'Cyril');
    const d = join(table, 'Dana');
    startGame(table);
    winHand(table, a);
    expect(table.changeSeat(d, 7).ok).toBe(true);
    expect(d).toMatchObject({ seat: 7, sittingOut: true, missedBlinds: 'big', returnMode: 'wait-bb' });
    expect(events.map((event) => event.text)).toContain('Dana mení miesto — čaká na big blind (alebo ho môže zaplatiť hneď)');
    table.setSittingOut(c, true);
    expect(table.changeSeat(c, 5).ok).toBe(true);
    expect(c).toMatchObject({ seat: 5, sittingOut: true, missedBlinds: 'big', returnMode: null });
    expect(table.setSittingOut(c, false)).toEqual({ ok: false, error: 'Najprv si vyber, či počkáš na big blind alebo zaplatíš' });
    table.leave(c);
    table.leave(d);
    expect(table.changeSeat(b, 4).ok).toBe(true);
    expect(b).toMatchObject({ seat: 4, sittingOut: false, missedBlinds: 'none' });
  });

  it('changes nothing in the lobby or before the first hand', () => {
    const { table } = createTable();
    const a = join(table, 'Adam');
    join(table, 'Bea');
    join(table, 'Cyril');
    expect(table.changeSeat(a, 6).ok).toBe(true);
    expect(a).toMatchObject({ seat: 6, sittingOut: false, missedBlinds: 'none' });
  });
});
