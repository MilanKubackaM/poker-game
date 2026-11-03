import { createHash, createHmac, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../shared/constants';
import { FAIR_REVEAL_IDLE_MS, FAIR_REVEAL_MS, expectedDeal, type FairExport, type FairProof } from '../../shared/fairness';
import type { Avatar, Card, TableEvent } from '../../shared/types';
import { HandEngine } from '../poker/HandEngine';
import { commitOf, deriveDeck, seededRandom } from '../poker/fairDeck';
import { verifyExport } from '../poker/fairVerify';
import { Table, type TablePlayer } from '../Table';
import { buyIn, rules, seats } from './helpers';

const avatar: Avatar = { emoji: '🦊', color: '#e76f51' };
const hex = (byte: number) => byte.toString(16).padStart(2, '0').repeat(32);

/** Nezávislá implementácia algoritmu presne podľa README (bez kódu servera) — musí dať rovnaký balíček. */
function readmeDeck(table: string, roundId: string, serverSeed: string, seeds: Record<string, string>): string[] {
  const zero = Buffer.from([0]);
  const parts = [Buffer.from('poker-night/shuffle/v1'), zero, Buffer.from(table), zero, Buffer.from(roundId), zero, Buffer.from(serverSeed, 'hex')];
  for (const playerId of Object.keys(seeds).sort()) {
    parts.push(Buffer.from(playerId), zero, Buffer.from(seeds[playerId], 'hex'));
  }
  const key = createHash('sha256').update(Buffer.concat(parts)).digest();
  const words: number[] = [];
  let counter = 0;
  const word = () => {
    if (!words.length) {
      const block = createHmac('sha256', key).update(Buffer.from([counter >>> 24, (counter >>> 16) & 255, (counter >>> 8) & 255, counter & 255])).digest();
      counter++;
      for (let index = 0; index < 32; index += 4) {
        words.push(block.readUInt32BE(index));
      }
    }
    return words.shift()!;
  };
  const below = (n: number) => {
    const limit = 2 ** 32 - (2 ** 32 % n);
    for (;;) {
      const value = word();
      if (value < limit) {
        return value % n;
      }
    }
  };
  const deck: string[] = [];
  for (const suit of 'shdc') {
    for (const rank of '23456789TJQKA') {
      deck.push(rank + suit);
    }
  }
  for (let index = deck.length - 1; index > 0; index--) {
    const swap = below(index + 1);
    [deck[index], deck[swap]] = [deck[swap], deck[index]];
  }
  return deck;
}

describe('deriveDeck — algoritmus z README', () => {
  it('sa zhoduje s nezávislou implementáciou podľa popisu', () => {
    for (let run = 0; run < 25; run++) {
      const seeds = Object.fromEntries(Array.from({ length: run % 5 }, () => [crypto.randomUUID(), randomBytes(32).toString('hex')]));
      const input = { table: 'ABC123', roundId: randomBytes(8).toString('hex'), serverSeed: randomBytes(32).toString('hex'), seeds };
      expect(deriveDeck(input)).toEqual(readmeDeck(input.table, input.roundId, input.serverSeed, input.seeds));
    }
  });

  it('pevný testovací vektor (uvedený v README)', () => {
    const deck = deriveDeck({ table: 'ABC123', roundId: '0011223344556677', serverSeed: hex(1), seeds: { 'player-a': hex(2), 'player-b': hex(3) } });
    expect(deck.slice(0, 8)).toEqual(['3d', '2s', '9c', 'Jd', 'Kh', 'Ad', 'Kc', '2h']);
    expect(commitOf(hex(1))).toBe('72cd6e8422c407fb6d098690f1130b7ded7ec2f7f5e1d30bd9d521f015363793');
  });

  it('je permutácia 52 kariet a zmena ktoréhokoľvek vstupu zmení balíček', () => {
    const base = { table: 'ABC123', roundId: 'r1', serverSeed: hex(1), seeds: { a: hex(2), b: hex(3) } };
    const deck = deriveDeck(base);
    expect(new Set(deck).size).toBe(52);
    expect(deriveDeck(base)).toEqual(deck);
    expect(deriveDeck({ ...base, table: 'ABC124' })).not.toEqual(deck);
    expect(deriveDeck({ ...base, roundId: 'r2' })).not.toEqual(deck);
    expect(deriveDeck({ ...base, serverSeed: hex(9) })).not.toEqual(deck);
    expect(deriveDeck({ ...base, seeds: { a: hex(2), b: hex(4) } })).not.toEqual(deck);
    expect(deriveDeck({ ...base, seeds: { a: hex(2) } })).not.toEqual(deck);
  });

  it('náhoda je bez skreslenia a vždy v rozsahu', () => {
    const below = seededRandom(Buffer.alloc(32, 7));
    const counts = new Array(3).fill(0);
    for (let index = 0; index < 30_000; index++) {
      const value = below(3);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(3);
      counts[value]++;
    }
    for (const count of counts) {
      expect(Math.abs(count - 10_000)).toBeLessThan(400);
    }
  });
});

describe('expectedDeal — rovnaké rozdávanie ako HandEngine', () => {
  const allInToRiver = (engine: HandEngine, runs: number) => {
    while (!engine.awaitingRunout && !engine.isComplete) {
      const player = engine.toAct!;
      const legal = engine.legalActions(player.id)!;
      engine.act(player.id, legal.callAmount > 0 ? { type: 'call' } : { type: 'allin' });
    }
    engine.setRuns(runs);
    while (!engine.isComplete) {
      engine.runoutStep();
    }
  };

  it('karty hráčov, board aj ďalšie behy sedia pre rôzne miesta, dealerov a varianty', () => {
    for (const [variant, dealerSeat, runs] of [['holdem', 0, 1], ['holdem', 2, 2], ['omaha', 1, 3], ['pineapple', 3, 1]] as const) {
      const deck = deriveDeck({ table: 'T', roundId: `${variant}${dealerSeat}`, serverSeed: randomBytes(32).toString('hex'), seeds: {} });
      const handSeats = seats(1000, 1000, 1000, 1000);
      const engine = new HandEngine({ handNumber: 1, seats: handSeats, dealerSeat, rules: rules({ variant }), deck });
      engine.start();
      const holeCount = engine.players[0].hole.length;
      const expected = expectedDeal(deck, handSeats, dealerSeat, holeCount);
      for (const player of engine.players) {
        expect(player.hole).toEqual(expected.holes[player.id]);
      }
      if (variant === 'pineapple') {
        continue;
      }
      allInToRiver(engine, runs);
      expect(engine.board).toEqual(expected.board);
      const runBoards: Card[][] = [];
      let next = expected.afterBoard;
      for (let run = 1; run < engine.runs; run++) {
        const board = expected.board.slice(0, engine.runoutBase);
        let length = board.length;
        while (length < 5) {
          next += 1;
          const count = length === 0 ? 3 : 1;
          board.push(...deck.slice(next, next + count));
          next += count;
          length += count;
        }
        runBoards.push(board);
      }
      expect(engine.extraBoards).toEqual(runBoards);
    }
  });

  it('odkrytie zvyšku boardu (rabbit) pokračuje v hlavnom boarde', () => {
    const deck = deriveDeck({ table: 'T', roundId: 'rabbit', serverSeed: hex(5), seeds: {} });
    const handSeats = seats(1000, 1000, 1000);
    const engine = new HandEngine({ handNumber: 1, seats: handSeats, dealerSeat: 0, rules: rules(), deck });
    engine.start();
    const expected = expectedDeal(deck, handSeats, 0, 2);
    expect(engine.remainingBoard()).toEqual(expected.board);
  });
});

describe('Table — kolo miešania', () => {
  let tables: Table[] = [];
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    for (const table of tables) {
      table.dispose();
    }
    tables = [];
    vi.useRealTimers();
  });

  function setup(commit: boolean) {
    const events: TableEvent[] = [];
    const table = new Table('FAIR01', { ...DEFAULT_SETTINGS }, { onChange: () => undefined, onEvent: (_table, event) => events.push(event), onRemoved: () => undefined });
    tables.push(table);
    const seeds = new Map<string, string>();
    const players = ['Milan', 'Juraj', 'Peťo'].map((name, index) => {
      const added = table.addPlayer(name, avatar);
      if (!added.ok || !added.data) {
        throw new Error('join failed');
      }
      table.attachSocket(added.data, `socket-${name}`);
      buyIn(table, added.data);
      const seed = hex(10 + index);
      seeds.set(added.data.id, seed);
      if (commit) {
        expect(table.fairCommit(added.data, commitOf(seed)).ok).toBe(true);
      }
      return added.data;
    });
    expect(table.hostStart().ok).toBe(true);
    expect(table.hostDealerChoice('random').ok).toBe(true);
    vi.advanceTimersByTime(1500);
    return { table, events, players, seeds };
  }

  const reveal = (table: Table, player: TablePlayer, seed: string) => table.fairReveal(player, table.fair.view(player.id).round?.roundId, seed);

  it('ruka počká na semienka a rozdá balíček presne zo zaviazaných semienok', () => {
    const { table, players, seeds } = setup(true);
    expect(table.engine).toBeNull();
    const round = table.fair.view(players[0].id).round!;
    expect(Object.keys(round.commitments).sort()).toEqual(players.map((player) => player.id).sort());
    expect(table.fair.view(players[0].id).committed).toBe(false);
    for (const player of players) {
      expect(reveal(table, player, seeds.get(player.id)!).ok).toBe(true);
    }
    expect(table.engine).not.toBeNull();
    const proof = table.fair.toPersisted().proofs.at(-1)!;
    expect(proof.excluded).toEqual([]);
    const deck = deriveDeck({ table: 'FAIR01', roundId: proof.roundId, serverSeed: proof.serverSeed!, seeds: Object.fromEntries(seeds) });
    const expected = expectedDeal(deck, proof.seats, proof.dealerSeat, proof.holeCount);
    for (const player of table.engine!.players) {
      expect(player.hole).toEqual(expected.holes[player.id]);
    }
    expect(table.liveView(players[0].id).hand?.fairRoundId).toBe(proof.roundId);
  });

  it('semienko, ktoré nesedí s odtlačkom, server neprijme', () => {
    const { table, players } = setup(true);
    expect(reveal(table, players[0], hex(99))).toEqual({ ok: false, error: 'Semienko nesedí s odtlačkom' });
    expect(table.fairReveal(players[0], 'other-round', hex(10)).ok).toBe(false);
  });

  it('kto nepošle semienko do termínu, ruka sa rozdá bez neho a je to verejne zapísané', () => {
    const { table, players, seeds, events } = setup(true);
    reveal(table, players[0], seeds.get(players[0].id)!);
    reveal(table, players[1], seeds.get(players[1].id)!);
    expect(table.engine).toBeNull();
    vi.advanceTimersByTime(FAIR_REVEAL_MS);
    expect(table.engine).not.toBeNull();
    const proof = table.fair.toPersisted().proofs.at(-1)!;
    expect(proof.excluded).toEqual([players[2].id]);
    expect(events.some((event) => event.text.includes('Do miešania neprispeli') && event.text.includes(players[2].name))).toBe(true);
  });

  it('bez odtlačkov hráčov sa rozdá hneď (len so semienkom servera)', () => {
    const { table } = setup(false);
    expect(table.engine).not.toBeNull();
    expect(table.fair.toPersisted().proofs.at(-1)!.commitments).toEqual({});
  });

  it('semienko servera sa zverejní až po hre', () => {
    const { table, players, seeds } = setup(true);
    for (const player of players) {
      reveal(table, player, seeds.get(player.id)!);
    }
    expect(table.fairProofs().revealed).toBe(false);
    expect(table.fairProofs().proofs[0].serverSeed).toBeNull();
    vi.setSystemTime(Date.now() + FAIR_REVEAL_IDLE_MS + 1);
    expect(table.fairProofs().revealed).toBe(true);
    expect(table.fairProofs().proofs[0].serverSeed).toMatch(/^[0-9a-f]{64}$/);
  });

  it('dôkazy aj čakajúce kolo prežijú reštart servera', () => {
    const { table, players, seeds } = setup(true);
    reveal(table, players[0], seeds.get(players[0].id)!);
    const restored = Table.fromSnapshot(table.toSnapshot(), { onChange: () => undefined, onEvent: () => undefined, onRemoved: () => undefined });
    tables.push(restored);
    expect(restored.fair.toPersisted().round?.seeds).toEqual({ [players[0].id]: seeds.get(players[0].id) });
  });
});

describe('verifyExport — overenie z pohľadu hráča', () => {
  const me = 'player-me';
  const others = ['player-x', 'player-y'];
  const mySeed = hex(21);

  function honest(): FairExport {
    const serverSeed = hex(20);
    const seeds: Record<string, string> = { [me]: mySeed, [others[0]]: hex(22), [others[1]]: hex(23) };
    const commitments = Object.fromEntries(Object.entries(seeds).map(([id, seed]) => [id, commitOf(seed)]));
    const handSeats = [
      { id: me, seat: 0 },
      { id: others[0], seat: 2 },
      { id: others[1], seat: 5 },
    ];
    const deck = deriveDeck({ table: 'VER001', roundId: 'round1', serverSeed, seeds });
    const expected = expectedDeal(deck, handSeats, 2, 2);
    const proof: FairProof = {
      v: 'poker-night/shuffle/v1',
      table: 'VER001',
      roundId: 'round1',
      handNumber: 7,
      at: 0,
      serverCommit: commitOf(serverSeed),
      serverSeed,
      commitments,
      seeds,
      excluded: [],
      dealerSeat: 2,
      seats: handSeats,
      holeCount: 2,
    };
    return {
      format: 'poker-night-fairness-export',
      version: 1,
      table: 'VER001',
      playerId: me,
      exportedAt: 0,
      rounds: [{ roundId: 'round1', serverCommit: proof.serverCommit, commitments: { ...commitments }, seed: mySeed, sentAt: 0 }],
      hands: [
        {
          handNumber: 7,
          roundId: 'round1',
          dealerSeat: 2,
          seats: handSeats,
          hole: expected.holes[me],
          board: expected.board.slice(0, 4),
          extraBoards: [],
          runoutBase: 0,
          shown: { [others[1]]: expected.holes[others[1]] },
          rabbit: [expected.board[4]],
        },
      ],
      proofs: [proof],
    };
  }

  it('poctivá ruka prejde', () => {
    const report = verifyExport(honest());
    expect(report.hands[0].problems).toEqual([]);
    expect(report.summary).toEqual({ verified: 1, failed: 0, pending: 0, withoutRecord: 0, discardedRounds: 0, missingProofs: 0 });
  });

  it('zahodené kolo po odhalení semienka a ruka bez dôkazu sú chyba, čakajúce kolo nie', () => {
    const discarded = honest();
    discarded.rounds.push({ roundId: 'round2', serverCommit: commitOf(hex(40)), commitments: { [me]: commitOf(hex(41)) }, seed: hex(41), sentAt: 1 });
    expect(verifyExport(discarded).summary.discardedRounds).toBe(1);
    discarded.pendingRoundId = 'round2';
    expect(verifyExport(discarded).summary.discardedRounds).toBe(0);
    const hidden = honest();
    hidden.proofs = [];
    expect(verifyExport(hidden).summary.missingProofs).toBe(1);
  });

  it('odhalí podvrhnutý board, cudzie karty, iný zoznam odtlačkov, vynechané semienko aj zlé semienko servera', () => {
    const tamper = (change: (data: FairExport) => void) => {
      const data = honest();
      change(data);
      return verifyExport(data).summary.failed;
    };
    expect(tamper((data) => (data.hands[0].board = ['As', 'Ks', 'Qs', 'Js']))).toBe(1);
    expect(tamper((data) => (data.hands[0].shown[others[0]] = ['As', 'Ad']))).toBe(1);
    expect(tamper((data) => (data.proofs[0].commitments[others[0]] = commitOf(hex(30))))).toBe(1);
    expect(
      tamper((data) => {
        delete data.proofs[0].seeds[me];
        data.proofs[0].excluded = [me];
      }),
    ).toBe(1);
    expect(tamper((data) => (data.proofs[0].serverSeed = hex(31)))).toBe(1);
    expect(tamper((data) => (data.proofs[0].dealerSeat = 5))).toBe(1);
    expect(tamper((data) => (data.hands[0].rabbit = ['2c']))).toBe(1);
  });

  it('bez zverejneného semienka servera je ruka len čakajúca', () => {
    const data = honest();
    data.proofs[0].serverSeed = null;
    expect(verifyExport(data).summary.pending).toBe(1);
  });
});
