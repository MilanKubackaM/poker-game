import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Avatar, Card, HandRules, TableEvent } from '../../shared/types';
import { DEFAULT_SETTINGS, HAND_PAUSE_MS, MAX_SPECIAL_HANDS, RUNOUT_STEP_MS } from '../../shared/constants';
import { expectedDeal, type FairExport } from '../../shared/fairness';
import { freshDeck, parseCards } from '../poker/cards';
import { deriveDeck } from '../poker/fairDeck';
import { verifyExport } from '../poker/fairVerify';
import { HandEngine } from '../poker/HandEngine';
import { Table, type TableHooks, type TablePlayer, type TableSnapshot } from '../Table';
import { buyIn, rules, seats } from './helpers';

/**
 * Balíček pre Double Board: karty hráčov v poradí rozdávania, potom na každej ulici pálenie, vrchný board a spodný
 * board (flop 3 + 3, turn 1 + 1, river 1 + 1).
 */
function stackDoubleDeck(holesInDealOrder: string[], top: string, bottom: string): Card[] {
  const holes = holesInDealOrder.map(parseCards);
  const topCards = parseCards(top);
  const bottomCards = parseCards(bottom);
  const used = new Set<Card>([...holes.flat(), ...topCards, ...bottomCards]);
  const filler = freshDeck().filter((card) => !used.has(card));
  const deck: Card[] = [];
  for (let round = 0; round < holes[0].length; round++) {
    for (const hole of holes) {
      deck.push(hole[round]);
    }
  }
  for (const [from, count] of [[0, 3], [3, 1], [4, 1]]) {
    deck.push(filler.shift()!);
    deck.push(...topCards.slice(from, from + count), ...bottomCards.slice(from, from + count));
  }
  deck.push(...filler);
  return deck;
}

function doubleHand(options: { stacks: number[]; holes: string[]; top: string; bottom: string; rules?: Partial<HandRules>; ante?: number; dealerSeat?: number }): HandEngine {
  const engine = new HandEngine({
    handNumber: 1,
    seats: seats(...options.stacks),
    dealerSeat: options.dealerSeat ?? 0,
    rules: rules({ doubleBoard: true, ...options.rules }),
    deck: stackDoubleDeck(options.holes, options.top, options.bottom),
    ante: options.ante,
  });
  engine.start();
  return engine;
}

/** Dohrá ruku bez stávok: check/call, v Pineapple zahodí tretiu kartu, po all-in dorozdá board. */
function checkDown(engine: HandEngine): void {
  for (let guard = 0; guard < 200 && !engine.isComplete; guard++) {
    if (engine.street === 'discard') {
      for (const player of engine.pendingDiscards()) {
        expect(engine.discard(player.id, 2).ok).toBe(true);
      }
      continue;
    }
    if (engine.awaitingRunout) {
      engine.runoutStep();
      continue;
    }
    const player = engine.toAct!;
    const legal = engine.legalActions(player.id)!;
    expect(engine.act(player.id, legal.canCheck ? { type: 'check' } : { type: 'call' }).ok).toBe(true);
  }
  expect(engine.isComplete).toBe(true);
}

const shares = (engine: HandEngine) => engine.result!.winners.map(({ playerId, amount, potIndex, board }) => ({ playerId, amount, potIndex, board }));

describe('Double Board — rozdávanie', () => {
  it('na každej ulici páli jednu kartu, potom vrchný a hneď spodný board', () => {
    // Heads-up: dealer (miesto 0) dáva SB, karty dostáva najprv miesto 1.
    const engine = doubleHand({ stacks: [1000, 1000], holes: ['Kc Kd', 'Ah Ad'], top: 'As 7c 2d 9h 4s', bottom: 'Ks 8h 3c Jd 5s' });
    const deck = stackDoubleDeck(['Kc Kd', 'Ah Ad'], 'As 7c 2d 9h 4s', 'Ks 8h 3c Jd 5s');
    expect(engine.board).toEqual([]);
    expect(engine.secondBoard).toEqual([]);
    engine.act('p0', { type: 'call' });
    engine.act('p1', { type: 'check' });
    expect(engine.street).toBe('flop');
    expect(engine.board).toEqual(parseCards('As 7c 2d'));
    expect(engine.secondBoard).toEqual(parseCards('Ks 8h 3c'));
    expect(engine.drainLog().some((entry) => entry.text === 'Flop — vrchný board: As 7c 2d, spodný board: Ks 8h 3c')).toBe(true);
    checkDown(engine);
    expect(engine.board).toEqual(parseCards('As 7c 2d 9h 4s'));
    expect(engine.secondBoard).toEqual(parseCards('Ks 8h 3c Jd 5s'));
    const expected = expectedDeal(deck, seats(1000, 1000), 0, 2, { doubleBoard: true });
    expect(expected.board).toEqual(engine.board);
    expect(expected.secondBoard).toEqual(engine.secondBoard);
    // 4 karty hráčom + 3 pálenia + 10 kariet na boardoch.
    expect(expected.afterBoard).toBe(4 + 3 + 10);
  });

  it('expectedDeal sa zhoduje s enginom pre rôzne varianty a dealerov; 9 hráčov Omahy sa zmestí do balíčka', () => {
    for (const [variant, players, dealerSeat] of [['holdem', 4, 2], ['omaha', 9, 5], ['pineapple', 6, 0]] as const) {
      const deck = deriveDeck({ table: 'DB', roundId: `${variant}${players}`, serverSeed: 'ab'.repeat(32), seeds: {} });
      const handSeats = seats(...Array.from({ length: players }, () => 1000));
      const engine = new HandEngine({ handNumber: 1, seats: handSeats, dealerSeat, rules: rules({ variant, doubleBoard: true }), deck });
      engine.start();
      const expected = expectedDeal(deck, handSeats, dealerSeat, engine.players[0].hole.length, { doubleBoard: true });
      for (const player of engine.players) {
        expect(player.hole).toEqual(expected.holes[player.id]);
      }
      checkDown(engine);
      expect(engine.board).toEqual(expected.board);
      expect(engine.secondBoard).toEqual(expected.secondBoard);
      if (variant === 'omaha') {
        // 36 kariet hráčom + 3 pálenia + 10 na boardoch = 49 z 52.
        expect(expected.afterBoard).toBe(49);
      }
    }
  });

  it('bez Double Board ostáva rozdávanie aj dôkaz po starom', () => {
    const deck = deriveDeck({ table: 'DB', roundId: 'single', serverSeed: 'cd'.repeat(32), seeds: {} });
    const single = expectedDeal(deck, seats(1000, 1000, 1000), 0, 2);
    expect(single.secondBoard).toEqual([]);
    expect(single.afterBoard).toBe(6 + 3 + 5);
  });
});

describe('Double Board — showdown', () => {
  it('pot sa delí na polovicu medzi víťazov boardov, nepárny žetón ide vrchnému boardu', () => {
    const engine = doubleHand({ stacks: [1000, 1000], holes: ['Kc Kd', 'Ah Ad'], top: 'As 7c 2d 9h 4s', bottom: 'Ks 8h 3c Jd 5s', ante: 1 });
    checkDown(engine);
    // Poradie rozdávania heads-up: p1 (Kc Kd), potom p0 (Ah Ad).
    expect(shares(engine)).toEqual([
      { playerId: 'p0', amount: 21, potIndex: 0, board: 0 },
      { playerId: 'p1', amount: 20, potIndex: 0, board: 1 },
    ]);
    expect(engine.player('p0')!.stack).toBe(1001);
    expect(engine.player('p1')!.stack).toBe(1000);
    const [top, bottom] = engine.result!.winners;
    expect(top.bestCards).toEqual(expect.arrayContaining(['As', 'Ah', 'Ad']));
    expect(bottom.bestCards).toEqual(expect.arrayContaining(['Ks', 'Kc', 'Kd']));
    expect(top.handDescription).not.toBe(engine.player('p0')!.secondEvaluated!.description);
    expect(engine.result!.wonWithoutShowdown).toBe(false);
  });

  it('najlepšia ruka na oboch boardoch berie celý pot (scoop)', () => {
    const engine = doubleHand({ stacks: [1000, 1000], holes: ['Kc Kd', 'Ah Ad'], top: 'As 7c 2d 9h 4s', bottom: '2s 8h 3c Jd 5s', ante: 1 });
    checkDown(engine);
    expect(shares(engine)).toEqual([
      { playerId: 'p0', amount: 21, potIndex: 0, board: 0 },
      { playerId: 'p0', amount: 20, potIndex: 0, board: 1 },
    ]);
    expect(engine.player('p0')!.stack).toBe(1021);
  });

  it('remíza na jednom boarde delí len jeho polovicu', () => {
    const engine = doubleHand({ stacks: [1000, 1000], holes: ['Kc Kd', 'Ah Ad'], top: 'As 7c 2d 9h 4s', bottom: '9s Ts Js Qs Ks', ante: 1 });
    checkDown(engine);
    expect(shares(engine)).toEqual([
      { playerId: 'p0', amount: 21, potIndex: 0, board: 0 },
      { playerId: 'p1', amount: 10, potIndex: 0, board: 1 },
      { playerId: 'p0', amount: 10, potIndex: 0, board: 1 },
    ]);
  });

  it('side poty: každý pot sa delí zvlášť a na každom boarde môže vyhrať niekto iný', () => {
    // Traja: dealer miesto 0 (UTG), SB miesto 1, BB miesto 2; karty sa rozdávajú od miesta 1.
    const engine = doubleHand({ stacks: [100, 300, 500], holes: ['Qs Qd', '7c 6c', 'As Ad'], top: 'Ac 9h 4d 3s 2h', bottom: '8c 5c 4c Jd Kh' });
    expect(engine.act('p0', { type: 'allin' }).ok).toBe(true);
    expect(engine.act('p1', { type: 'allin' }).ok).toBe(true);
    expect(engine.act('p2', { type: 'call' }).ok).toBe(true);
    expect(engine.awaitingRunout).toBe(true);
    expect(engine.maxRuns()).toBe(1);
    checkDown(engine);
    expect(shares(engine)).toEqual([
      { playerId: 'p0', amount: 150, potIndex: 0, board: 0 },
      { playerId: 'p2', amount: 150, potIndex: 0, board: 1 },
      { playerId: 'p1', amount: 200, potIndex: 1, board: 0 },
      { playerId: 'p2', amount: 200, potIndex: 1, board: 1 },
    ]);
    expect(engine.players.map((player) => player.stack)).toEqual([150, 200, 550]);
    expect(engine.players.reduce((sum, player) => sum + player.stack, 0)).toBe(900);
  });

  it('Omaha: na každom boarde platí pravidlo 2 karty z ruky + 3 z boardu', () => {
    // Spodný board má štyri srdcia — hráč s jedným srdcom v ruke flush nemá, hráč s dvoma áno.
    const engine = doubleHand({
      stacks: [1000, 1000],
      holes: ['2h 3h 9c 9d', 'Ah Kc Qd Js'],
      top: 'Ac Kd 5s 7c 3d',
      bottom: '4h 6h 8h Th 2c',
      rules: { variant: 'omaha' },
    });
    checkDown(engine);
    // p1 = 2h 3h 9c 9d (dve srdcia), p0 = Ah Kc Qd Js (jedno srdce).
    expect(shares(engine)).toEqual([
      { playerId: 'p0', amount: 20, potIndex: 0, board: 0 },
      { playerId: 'p1', amount: 20, potIndex: 0, board: 1 },
    ]);
    expect(engine.player('p1')!.secondEvaluated!.cards.filter((card) => card.endsWith('h'))).toHaveLength(5);
    expect(engine.player('p0')!.secondEvaluated!.cards.filter((card) => card.endsWith('h')).length).toBeLessThan(5);
  });

  it('Pineapple: zahadzuje sa po preflope (pred flopmi), v showdowne majú hráči 2 karty na oba boardy', () => {
    const engine = doubleHand({ stacks: [1000, 1000], holes: ['Kc Kd 3c', 'Ah Ad 2c'], top: 'As 7c 2d 9h 4s', bottom: 'Ks 8h 3s Jd 5c', rules: { variant: 'pineapple' } });
    engine.act('p0', { type: 'call' });
    engine.act('p1', { type: 'check' });
    expect(engine.street).toBe('discard');
    expect(engine.board).toEqual([]);
    expect(engine.secondBoard).toEqual([]);
    checkDown(engine);
    expect(engine.players.every((player) => player.hole.length === 2)).toBe(true);
    expect(shares(engine)).toEqual([
      { playerId: 'p0', amount: 20, potIndex: 0, board: 0 },
      { playerId: 'p1', amount: 20, potIndex: 0, board: 1 },
    ]);
  });

  it('ruka bez showdownu (všetci zložia) dá celý pot jednému hráčovi bez delenia na boardy', () => {
    const engine = doubleHand({ stacks: [1000, 1000], holes: ['Kc Kd', 'Ah Ad'], top: 'As 7c 2d 9h 4s', bottom: 'Ks 8h 3c Jd 5s' });
    engine.act('p0', { type: 'call' });
    engine.act('p1', { type: 'check' });
    expect(engine.secondBoard).toHaveLength(3);
    expect(engine.act('p1', { type: 'bet', amount: 40 }).ok).toBe(true);
    expect(engine.act('p0', { type: 'fold' }).ok).toBe(true);
    expect(engine.result!.wonWithoutShowdown).toBe(true);
    expect(shares(engine)).toEqual([{ playerId: 'p1', amount: 40, potIndex: 0, board: undefined }]);
  });

  it('7-2 bonus: stačí vyhrať podiel hlavného potu na jednom boarde', () => {
    const won = doubleHand({ stacks: [1000, 1000], holes: ['Kc Kd', '7c 2d'], top: 'As 9h 5c Jd 8s', bottom: '7h 2h 9s 4c 3d', rules: { sevenDeuce: true, sevenDeuceBounty: 40 } });
    checkDown(won);
    // p1 = Kc Kd vyhrá vrchný board, p0 = 7c 2d spodný (dva páry).
    expect(shares(won).map((share) => [share.playerId, share.board])).toEqual([
      ['p1', 0],
      ['p0', 1],
    ]);
    expect(won.result!.bounty).toEqual({ winnerId: 'p0', total: 40, payers: [{ playerId: 'p1', amount: 40 }] });

    const lost = doubleHand({ stacks: [1000, 1000], holes: ['Kc Kd', '7c 2d'], top: 'As 9h 5c Jd 8s', bottom: 'Ah 6h 9s 4c 3d', rules: { sevenDeuce: true, sevenDeuceBounty: 40 } });
    checkDown(lost);
    expect(new Set(shares(lost).map((share) => share.playerId))).toEqual(new Set(['p1']));
    expect(lost.result!.bounty).toBeNull();
  });

  it('beh viackrát ani odkrytie boardu v Double Board nie je', () => {
    const engine = doubleHand({ stacks: [500, 500], holes: ['Kc Kd', 'Ah Ad'], top: 'As 7c 2d 9h 4s', bottom: 'Ks 8h 3c Jd 5s' });
    expect(engine.act('p0', { type: 'allin' }).ok).toBe(true);
    expect(engine.act('p1', { type: 'call' }).ok).toBe(true);
    expect(engine.maxRuns()).toBe(1);
    expect(engine.setRuns(3)).toBe(1);
    expect(engine.remainingBoard()).toEqual([]);
  });
});

// ——— Stôl: mód, udalosti, história, overenie ———

const avatar: Avatar = { emoji: '🦊', color: '#e76f51' };
let current: Table[] = [];
let socketSeq = 0;

function createTable(): { table: Table; events: TableEvent[]; hooks: TableHooks } {
  const events: TableEvent[] = [];
  const hooks: TableHooks = { onChange: () => undefined, onEvent: (_table, event) => events.push(event), onRemoved: () => undefined };
  const table = new Table('DOUB01', { ...DEFAULT_SETTINGS }, hooks);
  current.push(table);
  return { table, events, hooks };
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

const inHand = (table: Table) => !!table.engine && !table.engine.isComplete;

/** Potvrdí všetky úvody módov; vráti módy, ktorých úvod sa ukázal. */
function ackIntros(table: Table): string[] {
  const shown: string[] = [];
  while (table.modeIntro) {
    shown.push(table.modeIntro.mode);
    for (const id of [...table.modeIntro.participants]) {
      table.modeAck(table.players.get(id)!);
    }
    vi.advanceTimersByTime(2000);
  }
  return shown;
}

function startGame(table: Table): string[] {
  expect(table.hostStart().ok).toBe(true);
  expect(table.hostDealerChoice('random').ok).toBe(true);
  vi.advanceTimersByTime(1500);
  const intros = ackIntros(table);
  expect(inHand(table)).toBe(true);
  return intros;
}

function foldHand(table: Table): void {
  while (inHand(table)) {
    const actor = table.players.get(table.engine!.toAct!.id)!;
    expect(table.act(actor, { type: 'fold' }).ok).toBe(true);
  }
}

function playNext(table: Table): string[] {
  foldHand(table);
  vi.advanceTimersByTime(HAND_PAUSE_MS + 100);
  const intros = ackIntros(table);
  expect(inHand(table)).toBe(true);
  return intros;
}

const actor = (table: Table) => table.players.get(table.engine!.toAct!.id)!;
const modeTexts = (events: TableEvent[]) => events.filter((event) => event.kind === 'mode').map((event) => event.text);
const isDouble = (table: Table) => !!table.engine!.rules.doubleBoard;

/** Traja hráči: prvý zloží, druhý all-in, tretí dorovná → dorozdanie oboch boardov. */
function allIn(table: Table): { folder: TablePlayer; shover: TablePlayer; caller: TablePlayer } {
  const folder = actor(table);
  expect(table.act(folder, { type: 'fold' }).ok).toBe(true);
  const shover = actor(table);
  expect(table.act(shover, { type: 'allin' }).ok).toBe(true);
  const caller = actor(table);
  expect(table.act(caller, { type: 'call' }).ok).toBe(true);
  return { folder, shover, caller };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const table of current) {
    table.dispose();
  }
  current = [];
  vi.useRealTimers();
});

describe('Double Board — mód stola', () => {
  it('na N rúk: úvod pred prvou rukou, odpočítavanie po rozdaných rukách a ohlásenie konca', () => {
    const { table, events } = createTable();
    join(table, 'Milan');
    join(table, 'Juraj');
    expect(table.hostDoubleBoard({ action: 'start', hands: 2 })).toEqual({ ok: true });
    expect(modeTexts(events)).toEqual(['Double Board na 2 ruky od ďalšej ruky — dva boardy, každý pot sa delí na polovicu']);
    expect(table.view(table.hostId).doubleBoard).toEqual({ remaining: 2, permanent: false });
    expect(startGame(table)).toEqual(['double-board']);
    expect(isDouble(table)).toBe(true);
    expect(table.view(table.hostId).hand?.rules.doubleBoard).toBe(true);
    expect(table.view(table.hostId).hand?.secondBoard).toEqual([]);
    expect(table.doubleBoard).toEqual({ remaining: 1, permanent: false });
    expect(events.some((event) => event.text === 'Double Board — po tejto ruke ešte 1 ruka')).toBe(true);
    expect(playNext(table)).toEqual([]);
    expect(isDouble(table)).toBe(true);
    expect(table.doubleBoard).toBeNull();
    expect(table.view(table.hostId).doubleBoard).toBeNull();
    expect(events.some((event) => event.text === 'Double Board — posledná ruka')).toBe(true);
    playNext(table);
    expect(isDouble(table)).toBe(false);
    expect(table.view(table.hostId).hand?.secondBoard).toBeUndefined();
    expect(events.filter((event) => event.text === 'Double Board skončil — znova sa hrá s jedným boardom')).toHaveLength(1);
  });

  it('predvolene platí na jednu ruku', () => {
    const { table, events } = createTable();
    join(table, 'Milan');
    join(table, 'Juraj');
    expect(table.hostDoubleBoard({ action: 'start' }).ok).toBe(true);
    expect(modeTexts(events)).toEqual(['Double Board na 1 ruku od ďalšej ruky — dva boardy, každý pot sa delí na polovicu']);
    startGame(table);
    expect(isDouble(table)).toBe(true);
    expect(table.doubleBoard).toBeNull();
    playNext(table);
    expect(isDouble(table)).toBe(false);
  });

  it('natrvalo beží, kým ho host nevypne; úvod sa ukáže len raz; zmeny sa ohlásia', () => {
    const { table, events } = createTable();
    join(table, 'Milan');
    join(table, 'Juraj');
    expect(table.hostDoubleBoard({ action: 'start', permanent: true }).ok).toBe(true);
    expect(modeTexts(events).at(-1)).toBe('Double Board natrvalo od ďalšej ruky — dva boardy, každý pot sa delí na polovicu');
    expect(startGame(table)).toEqual(['double-board']);
    for (let hand = 0; hand < 3; hand++) {
      expect(playNext(table)).toEqual([]);
      expect(isDouble(table)).toBe(true);
      expect(table.doubleBoard).toEqual({ remaining: 0, permanent: true });
    }
    expect(events.filter((event) => event.text === 'Double Board — natrvalo, kým ho host nevypne')).toHaveLength(1);
    expect(table.hostDoubleBoard({ action: 'start', hands: 3 }).ok).toBe(true);
    expect(modeTexts(events).at(-1)).toBe('Host mení Double Board: ešte 3 ruky po tejto ruke');
    expect(table.hostDoubleBoard({ action: 'start', permanent: true }).ok).toBe(true);
    expect(modeTexts(events).at(-1)).toBe('Host mení Double Board: natrvalo — do vypnutia hostom');
    expect(table.hostDoubleBoard({ action: 'stop' })).toEqual({ ok: true });
    expect(modeTexts(events).at(-1)).toBe('Double Board vypnutý — po tejto ruke sa hrá s jedným boardom');
    expect(isDouble(table)).toBe(true);
    playNext(table);
    expect(isDouble(table)).toBe(false);
    expect(table.hostDoubleBoard({ action: 'stop' })).toEqual({ ok: false, error: 'Double Board nie je zapnutý' });
  });

  it('kombinuje sa so špeciálnym kolom aj 7-2: úvody idú po sebe, počty sa odpočítavajú nezávisle', () => {
    const { table } = createTable();
    join(table, 'Milan');
    join(table, 'Juraj');
    expect(table.hostNextHand({ variant: 'pineapple', hands: 1 }).ok).toBe(true);
    expect(table.hostDoubleBoard({ action: 'start', hands: 2 }).ok).toBe(true);
    expect(table.hostSettings({ ...table.settings, sevenDeuceAlways: true }).ok).toBe(true);
    expect(startGame(table)).toEqual(['pineapple', 'double-board', 'seven-deuce']);
    expect(table.engine!.rules).toMatchObject({ variant: 'pineapple', doubleBoard: true, sevenDeuce: true });
    expect(playNext(table)).toEqual([]);
    expect(table.engine!.rules).toMatchObject({ variant: 'holdem', doubleBoard: true, sevenDeuce: true });
    playNext(table);
    expect(table.engine!.rules.variant).toBe('holdem');
    expect(isDouble(table)).toBe(false);
  });

  it('vypnutie počas úvodu Double Board úvod zavrie a rozdá sa bez neho', () => {
    const { table } = createTable();
    join(table, 'Milan');
    join(table, 'Juraj');
    expect(table.hostDoubleBoard({ action: 'start', hands: 2 }).ok).toBe(true);
    expect(table.hostStart().ok).toBe(true);
    expect(table.hostDealerChoice('random').ok).toBe(true);
    vi.advanceTimersByTime(1500);
    expect(table.modeIntro?.mode).toBe('double-board');
    expect(table.hostDoubleBoard({ action: 'stop' }).ok).toBe(true);
    expect(table.modeIntro).toBeNull();
    vi.advanceTimersByTime(2000);
    expect(inHand(table)).toBe(true);
    expect(isDouble(table)).toBe(false);
  });

  it('odmietne neplatný počet rúk aj neznámu voľbu', () => {
    const { table } = createTable();
    join(table, 'Milan');
    expect(table.hostDoubleBoard({ action: 'start', hands: 0 }).ok).toBe(false);
    expect(table.hostDoubleBoard({ action: 'start', hands: 2.5 }).ok).toBe(false);
    expect(table.hostDoubleBoard({ action: 'start', hands: MAX_SPECIAL_HANDS + 1 })).toEqual({ ok: false, error: `Počet rúk musí byť 1 až ${MAX_SPECIAL_HANDS}` });
    expect(table.hostDoubleBoard({ action: 'start', hands: '3' as unknown as number }).ok).toBe(false);
    expect(table.hostDoubleBoard({ action: 'start', permanent: 'yes' as unknown as boolean }).ok).toBe(false);
    expect(table.hostDoubleBoard({ action: 'nope' } as unknown as { action: 'stop' }).ok).toBe(false);
    expect(table.doubleBoard).toBeNull();
    expect(table.hostDoubleBoard({ action: 'start', hands: MAX_SPECIAL_HANDS }).ok).toBe(true);
  });

  it('stav prežije reštart servera; staré a poškodené súbory mód vypnú', () => {
    const { table, hooks } = createTable();
    join(table, 'Milan');
    join(table, 'Juraj');
    expect(table.hostDoubleBoard({ action: 'start', hands: 4 }).ok).toBe(true);
    const snapshot = JSON.parse(JSON.stringify(table.toSnapshot())) as TableSnapshot;
    expect(snapshot.doubleBoard).toEqual({ remaining: 4, permanent: false });
    const restored = Table.fromSnapshot(snapshot, hooks);
    current.push(restored);
    expect(restored.doubleBoard).toEqual({ remaining: 4, permanent: false });

    const permanent = Table.fromSnapshot({ ...snapshot, doubleBoard: { remaining: 0, permanent: true } }, hooks);
    current.push(permanent);
    expect(permanent.view(permanent.hostId).doubleBoard).toEqual({ remaining: 0, permanent: true });

    for (const broken of [undefined, null, { remaining: -2, permanent: false }, { remaining: 1.5, permanent: false }, { remaining: MAX_SPECIAL_HANDS + 1, permanent: false }]) {
      const legacy = { ...snapshot } as TableSnapshot;
      if (broken === undefined) {
        delete legacy.doubleBoard;
      } else {
        legacy.doubleBoard = broken;
      }
      const loaded = Table.fromSnapshot(legacy, hooks);
      current.push(loaded);
      expect(loaded.doubleBoard).toBeNull();
    }
  });

  it('úvod Double Board sa po reštarte nezopakuje, keď posledná ruka už bola Double Board', () => {
    const { table, hooks } = createTable();
    join(table, 'Milan');
    join(table, 'Juraj');
    expect(table.hostDoubleBoard({ action: 'start', permanent: true }).ok).toBe(true);
    startGame(table);
    foldHand(table);
    const restored = Table.fromSnapshot(JSON.parse(JSON.stringify(table.toSnapshot())) as TableSnapshot, hooks);
    current.push(restored);
    for (const player of restored.players.values()) {
      restored.attachSocket(player, `socket-${++socketSeq}`);
    }
    expect(restored.paused).toBe(true);
    expect(restored.hostStart().ok).toBe(true);
    vi.advanceTimersByTime(2000);
    expect(ackIntros(restored)).toEqual([]);
    expect(inHand(restored)).toBe(true);
    expect(restored.engine!.rules.doubleBoard).toBe(true);
  });
});

describe('Double Board — ruka pri stole', () => {
  function threePlayers(): { table: Table; events: TableEvent[] } {
    const { table, events } = createTable();
    for (const name of ['Milan', 'Juraj', 'Peťo']) {
      join(table, name);
    }
    expect(table.hostDoubleBoard({ action: 'start', permanent: true }).ok).toBe(true);
    startGame(table);
    return { table, events };
  }

  it('all-in: bez hlasovania o behoch sa oba boardy dorozdajú po uliciach s pauzami', () => {
    const { table } = threePlayers();
    const { folder } = allIn(table);
    const engine = table.engine!;
    expect(engine.awaitingRunout).toBe(true);
    expect(table.runVote).toBeNull();
    expect(table.view(folder.id).runVote).toBeNull();
    for (const length of [3, 4, 5]) {
      vi.advanceTimersByTime(RUNOUT_STEP_MS - 200);
      expect(engine.secondBoard).toHaveLength(length === 3 ? 0 : length - 1);
      vi.advanceTimersByTime(200);
      expect(engine.board).toHaveLength(length);
      expect(engine.secondBoard).toHaveLength(length);
      if (length < 5) {
        expect(table.view(folder.id).hand?.secondBoard).toHaveLength(length);
      }
    }
    expect(engine.isComplete).toBe(true);
    expect(engine.result!.winners.every((winner) => winner.board === 0 || winner.board === 1)).toBe(true);
  });

  it('popis ruky vidí hráč pre oba boardy', () => {
    const { table } = threePlayers();
    const { shover, folder } = allIn(table);
    vi.advanceTimersByTime(RUNOUT_STEP_MS);
    const seat = table.view(folder.id).players.find((player) => player.id === shover.id)!;
    expect(seat.handDescription).not.toBeNull();
    expect(seat.secondHandDescription).not.toBeNull();
    expect(table.view(folder.id).players.find((player) => player.id === folder.id)!.secondHandDescription).toBeNull();
  });

  it('história, štatistiky a moje ruky: riadok víťaza na board, súčty sedia', () => {
    const { table } = threePlayers();
    const { shover, caller } = allIn(table);
    vi.advanceTimersByTime(RUNOUT_STEP_MS * 3);
    const engine = table.engine!;
    expect(engine.isComplete).toBe(true);
    const entry = table.history.at(-1)!;
    expect(entry.secondBoard).toEqual(engine.secondBoard);
    expect(entry.board).toEqual(engine.board);
    expect(entry.winners.every((winner) => winner.board === 0 || winner.board === 1)).toBe(true);
    const boards = entry.winners.map((winner) => winner.board).sort();
    expect(boards[0]).toBe(0);
    expect(boards.at(-1)).toBe(1);
    expect(entry.totalPot).toBe(engine.result!.winners.reduce((sum, winner) => sum + winner.amount, 0));
    const nets = [shover, caller].map((player) => table.myHistory(player.id).at(-1)!);
    const contributed = engine.players.reduce((sum, player) => sum + player.total + player.dead, 0);
    expect(entry.totalPot).toBe(contributed);
    const allNets = [...table.players.values()].map((player) => table.myHistory(player.id).at(-1)!.net);
    expect(allNets.reduce((sum, net) => sum + net, 0)).toBe(0);
    for (const mine of nets) {
      expect(mine.handDescription).toMatch(/ \/ /);
    }
    const winnerIds = new Set(entry.winners.map((winner) => winner.playerId));
    const leaderboard = table.leaderboard();
    for (const row of leaderboard) {
      const won = entry.winners.filter((winner) => winner.playerId === row.playerId).reduce((sum, winner) => sum + winner.amount, 0);
      expect(row.handsWon).toBe(winnerIds.has(row.playerId) ? 1 : 0);
      expect(row.biggestPot).toBe(won);
    }
  });

  it('odkrytie boardu (rabbit hunt) je v Double Board vypnuté', () => {
    const { table } = threePlayers();
    foldHand(table);
    const someone = [...table.players.values()][0];
    expect(table.rabbitHunt(someone)).toEqual({ ok: false, error: 'V Double Board sa board neodkrýva' });
  });

  it('dôkaz ruky nesie Double Board a overenie skontroluje oba boardy', () => {
    const { table } = threePlayers();
    const { shover } = allIn(table);
    vi.advanceTimersByTime(RUNOUT_STEP_MS * 3);
    const engine = table.engine!;
    const proof = table.fair.toPersisted().proofs.at(-1)!;
    expect(proof.doubleBoard).toBe(true);
    const exported = (secondBoard: Card[], rabbit: Card[] = []): FairExport => ({
      format: 'poker-night-fairness-export',
      version: 1,
      table: table.code,
      playerId: shover.id,
      exportedAt: 0,
      rounds: [],
      hands: [
        {
          handNumber: engine.handNumber,
          roundId: proof.roundId,
          dealerSeat: engine.dealerSeat,
          seats: proof.seats,
          hole: [...engine.player(shover.id)!.hole],
          board: [...engine.board],
          secondBoard,
          extraBoards: [],
          runoutBase: 0,
          shown: {},
          rabbit,
        },
      ],
      proofs: [proof],
    });
    const honest = verifyExport(exported([...engine.secondBoard]));
    expect(honest.hands[0].problems).toEqual([]);
    expect(honest.summary.verified).toBe(1);

    const swapped = [...engine.secondBoard];
    [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
    expect(verifyExport(exported(swapped)).summary.failed).toBe(1);
    expect(verifyExport(exported([...engine.board])).summary.failed).toBe(1);
    expect(verifyExport(exported([...engine.secondBoard], [engine.secondBoard[0]])).summary.failed).toBe(1);

    // Starý záznam bez spodného boardu (iný prehliadač / staršia verzia) prejde — kontroluje sa, čo hráč videl.
    const legacy = exported([]);
    delete legacy.hands[0].secondBoard;
    expect(verifyExport(legacy).summary.verified).toBe(1);

    // Dôkaz bez Double Board pri zázname so spodným boardom je chyba.
    const single = exported([...engine.secondBoard]);
    delete single.proofs[0].doubleBoard;
    expect(verifyExport(single).summary.failed).toBe(1);
  });

  it('zlúčenie hráčov zachová riadky víťazov po boardoch', () => {
    const { table } = createTable();
    const milan = join(table, 'Milan');
    const juraj = join(table, 'Juraj');
    const peto = join(table, 'Peťo');
    table.history.push({
      handNumber: 1,
      at: 0,
      variant: 'holdem',
      sevenDeuce: false,
      dealerName: 'Milan',
      board: parseCards('As 7c 2d 9h 4s'),
      secondBoard: parseCards('Ks 8h 3c Jd 5s'),
      totalPot: 41,
      wonWithoutShowdown: false,
      winners: [
        { playerId: juraj.id, playerName: 'Juraj', amount: 21, handDescription: 'Trojica', cards: [], board: 0 },
        { playerId: peto.id, playerName: 'Peťo', amount: 20, handDescription: 'Trojica', cards: [], board: 1 },
      ],
      bounty: null,
    });
    table.detachSocket(juraj, [...juraj.sockets][0]);
    expect(table.mergeMember(milan, juraj.id, peto.id)).toEqual({ ok: true });
    expect(table.history[0].winners.map(({ playerId, amount, board }) => ({ playerId, amount, board }))).toEqual([
      { playerId: peto.id, amount: 21, board: 0 },
      { playerId: peto.id, amount: 20, board: 1 },
    ]);
  });
});
