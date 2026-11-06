import { describe, expect, it } from 'vitest';
import type { PlayerAction } from '../../shared/types';
import { HandEngine, isSevenDeuce } from '../poker/HandEngine';
import { parseCards } from '../poker/cards';
import { makeHand, rules, seats, stackDeck, totalChips } from './helpers';

function act(engine: HandEngine, playerId: string, action: PlayerAction) {
  const result = engine.act(playerId, action);
  if (!result.ok) {
    throw new Error(`${playerId} ${action.type}: ${result.error}`);
  }
}

describe('blinds and order', () => {
  it('heads-up: dealer posts small blind and acts first preflop, big blind acts first postflop', () => {
    const engine = makeHand({ stacks: [1000, 1000] });
    expect(engine.smallBlindSeat).toBe(0);
    expect(engine.bigBlindSeat).toBe(1);
    expect(engine.toAct?.id).toBe('p0');
    act(engine, 'p0', { type: 'call' });
    expect(engine.toAct?.id).toBe('p1');
    act(engine, 'p1', { type: 'check' });
    expect(engine.street).toBe('flop');
    expect(engine.toAct?.id).toBe('p1');
  });

  it('three players: UTG (dealer) acts first preflop, small blind first postflop', () => {
    const engine = makeHand({ stacks: [1000, 1000, 1000] });
    expect(engine.smallBlindSeat).toBe(1);
    expect(engine.bigBlindSeat).toBe(2);
    expect(engine.toAct?.id).toBe('p0');
    act(engine, 'p0', { type: 'call' });
    act(engine, 'p1', { type: 'call' });
    expect(engine.toAct?.id).toBe('p2');
    act(engine, 'p2', { type: 'check' });
    expect(engine.street).toBe('flop');
    expect(engine.toAct?.id).toBe('p1');
  });

  it('big blind gets the option to raise when limped to', () => {
    const engine = makeHand({ stacks: [1000, 1000, 1000] });
    act(engine, 'p0', { type: 'call' });
    act(engine, 'p1', { type: 'call' });
    expect(engine.legalActions('p2')).toMatchObject({ canCheck: true, canRaise: true, minRaiseTo: 40 });
  });

  it('short stack posts a partial blind all-in', () => {
    const engine = makeHand({ stacks: [1000, 1000, 15] });
    const bigBlind = engine.player('p2')!;
    expect(bigBlind.status).toBe('allin');
    expect(bigBlind.total).toBe(15);
    expect(engine.currentBet).toBe(20);
  });
});

describe('raising rules', () => {
  it('rejects a raise below the minimum', () => {
    const engine = makeHand({ stacks: [1000, 1000, 1000] });
    expect(engine.act('p0', { type: 'raise', amount: 30 }).ok).toBe(false);
    act(engine, 'p0', { type: 'raise', amount: 60 });
    expect(engine.legalActions('p1')?.minRaiseTo).toBe(100);
  });

  it('a short all-in does not reopen betting for players who already acted', () => {
    const engine = makeHand({ stacks: [1000, 1000, 130] });
    act(engine, 'p0', { type: 'raise', amount: 100 });
    act(engine, 'p1', { type: 'call' });
    act(engine, 'p2', { type: 'allin' });
    expect(engine.currentBet).toBe(130);
    const legal = engine.legalActions('p0');
    expect(legal?.canRaise).toBe(false);
    expect(legal?.callAmount).toBe(30);
    expect(engine.act('p0', { type: 'raise', amount: 400 }).ok).toBe(false);
  });

  it('a full raise reopens betting', () => {
    const engine = makeHand({ stacks: [1000, 1000, 1000] });
    act(engine, 'p0', { type: 'raise', amount: 100 });
    act(engine, 'p1', { type: 'call' });
    act(engine, 'p2', { type: 'raise', amount: 300 });
    expect(engine.legalActions('p0')?.canRaise).toBe(true);
  });

  it('pot-limit caps the raise to the pot', () => {
    const engine = makeHand({ stacks: [1000, 1000, 1000], rules: { variant: 'omaha' } });
    expect(engine.legalActions('p0')?.maxRaiseTo).toBe(70);
    expect(engine.act('p0', { type: 'raise', amount: 80 }).ok).toBe(false);
    act(engine, 'p0', { type: 'raise', amount: 70 });
    expect(engine.legalActions('p1')?.maxRaiseTo).toBe(70 + 100 + 60);
  });

  it('pot-limit all-in is capped at the pot size', () => {
    const engine = makeHand({ stacks: [1000, 1000, 1000], rules: { variant: 'omaha' } });
    act(engine, 'p0', { type: 'allin' });
    expect(engine.player('p0')!.bet).toBe(70);
  });
});

describe('hand completion', () => {
  it('everyone folds to a raise: winner takes blinds and uncalled bet is returned', () => {
    const engine = makeHand({ stacks: [1000, 1000, 1000] });
    act(engine, 'p0', { type: 'raise', amount: 200 });
    act(engine, 'p1', { type: 'fold' });
    act(engine, 'p2', { type: 'fold' });
    expect(engine.isComplete).toBe(true);
    expect(engine.result?.wonWithoutShowdown).toBe(true);
    expect(engine.player('p0')!.stack).toBe(1030);
  });

  it('plays to showdown and pays the best hand', () => {
    const engine = makeHand({ stacks: [1000, 1000], holes: ['Kc Kd', 'Ac Ad'], board: '2c 7d 9h Js 3c' });
    act(engine, 'p0', { type: 'call' });
    act(engine, 'p1', { type: 'check' });
    for (let street = 0; street < 3; street++) {
      act(engine, 'p1', { type: 'check' });
      act(engine, 'p0', { type: 'check' });
    }
    expect(engine.isComplete).toBe(true);
    expect(engine.player('p0')!.stack).toBe(1020);
    expect(engine.player('p1')!.stack).toBe(980);
    expect(engine.result?.winners[0].handDescription).toBe('Pár — esá');
  });

  it('splits a tied pot', () => {
    const engine = makeHand({ stacks: [1000, 1000], holes: ['2c 3d', '4c 5d'], board: 'Ah Kh Qh Jh Th' });
    act(engine, 'p0', { type: 'call' });
    act(engine, 'p1', { type: 'check' });
    for (let street = 0; street < 3; street++) {
      act(engine, 'p1', { type: 'check' });
      act(engine, 'p0', { type: 'check' });
    }
    expect(engine.player('p0')!.stack).toBe(1000);
    expect(engine.player('p1')!.stack).toBe(1000);
  });

  it('runs out the board when everyone is all-in and builds side pots', () => {
    const engine = makeHand({
      stacks: [1000, 100, 500],
      holes: ['Ac Ad', 'Kc Kd', 'Qc Qd'],
      board: '2c 7d 9h Js 3s',
    });
    act(engine, 'p0', { type: 'allin' });
    act(engine, 'p1', { type: 'call' });
    act(engine, 'p2', { type: 'call' });
    expect(engine.awaitingRunout).toBe(true);
    expect(engine.player('p0')!.stack).toBe(500);
    engine.runoutStep();
    engine.runoutStep();
    engine.runoutStep();
    expect(engine.isComplete).toBe(true);
    expect(engine.board).toHaveLength(5);
    expect(engine.player('p1')!.stack).toBe(300);
    expect(engine.player('p2')!.stack).toBe(800);
    expect(engine.player('p0')!.stack).toBe(500);
  });

  it('heads-up both all-in from the blinds runs out immediately', () => {
    const engine = makeHand({ stacks: [10, 20] });
    expect(engine.awaitingRunout).toBe(true);
  });
});

describe('pineapple', () => {
  it('requires every live player to discard one card before the flop', () => {
    const engine = makeHand({ stacks: [1000, 1000], rules: { variant: 'pineapple' } });
    expect(engine.player('p0')!.hole).toHaveLength(3);
    act(engine, 'p0', { type: 'call' });
    act(engine, 'p1', { type: 'check' });
    expect(engine.street).toBe('discard');
    expect(engine.board).toHaveLength(0);
    expect(engine.act('p1', { type: 'check' }).ok).toBe(false);
    expect(engine.discard('p0', 0).ok).toBe(true);
    expect(engine.discard('p0', 0).ok).toBe(false);
    expect(engine.street).toBe('discard');
    engine.autoDiscardRemaining();
    expect(engine.street).toBe('flop');
    expect(engine.player('p1')!.hole).toHaveLength(2);
  });

  it('auto-discards a random card using the injected random source', () => {
    const engine = makeHand({ stacks: [1000, 1000, 1000], rules: { variant: 'pineapple' } });
    while (engine.street === 'preflop') {
      const player = engine.toAct!;
      act(engine, player.id, engine.legalActions(player.id)!.callAmount > 0 ? { type: 'call' } : { type: 'check' });
    }
    expect(engine.street).toBe('discard');
    const holes = engine.players.map((player) => [...player.hole]);
    expect(engine.autoDiscard('p0', () => 0).ok).toBe(true);
    expect(engine.autoDiscard('p0', () => 0).ok).toBe(false);
    const picks = [2, 1];
    const ranges: number[] = [];
    engine.autoDiscardRemaining((max) => {
      ranges.push(max);
      return picks.shift()!;
    });
    expect(ranges).toEqual([3, 3]);
    expect(engine.street).toBe('flop');
    expect(engine.players.map((player) => player.hole)).toEqual([holes[0].slice(1), [holes[1][0], holes[1][1]], [holes[2][0], holes[2][2]]]);
  });
});

describe('7-2 rule', () => {
  it('detects 7-2 in any order', () => {
    expect(isSevenDeuce(parseCards('7c 2d'))).toBe(true);
    expect(isSevenDeuce(parseCards('2h 7h'))).toBe(true);
    expect(isSevenDeuce(parseCards('7c 3d'))).toBe(false);
  });

  it('pays the bounty from every other player when 7-2 wins without showdown', () => {
    const engine = makeHand({
      stacks: [1000, 1000, 1000],
      rules: { sevenDeuce: true, sevenDeuceBounty: 50 },
      holes: ['Ac Ad', 'Kc Kd', '7h 2s'],
    });
    act(engine, 'p0', { type: 'raise', amount: 200 });
    act(engine, 'p1', { type: 'fold' });
    act(engine, 'p2', { type: 'fold' });
    expect(engine.result?.bounty?.total).toBe(100);
    expect(engine.result?.revealed.p0).toEqual(['7h', '2s']);
    expect(engine.player('p0')!.stack).toBe(1030 + 100);
    expect(engine.player('p1')!.stack).toBe(1000 - 10 - 50);
  });

  it('pays no bounty when the rule is off', () => {
    const engine = makeHand({ stacks: [1000, 1000, 1000], holes: ['Ac Ad', 'Kc Kd', '7h 2s'] });
    act(engine, 'p0', { type: 'raise', amount: 200 });
    act(engine, 'p1', { type: 'fold' });
    act(engine, 'p2', { type: 'fold' });
    expect(engine.result?.bounty).toBeNull();
  });
});

describe('chip conservation (randomised)', () => {
  it('never creates or destroys chips across many random hands', () => {
    let seed = 42;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const variants = ['holdem', 'omaha', 'pineapple'] as const;
    for (let hand = 0; hand < 1500; hand++) {
      const playerCount = 2 + Math.floor(random() * 8);
      const stacks = Array.from({ length: playerCount }, () => 5 + Math.floor(random() * 2000));
      const variant = variants[hand % 3];
      const engine = new HandEngine({
        handNumber: hand,
        seats: seats(...stacks),
        dealerSeat: Math.floor(random() * playerCount),
        rules: rules({ variant, sevenDeuce: random() < 0.5 }),
      });
      const before = stacks.reduce((sum, stack) => sum + stack, 0);
      engine.start();
      let guard = 0;
      while (!engine.isComplete && guard++ < 500) {
        if (engine.street === 'discard') {
          for (const player of engine.pendingDiscards()) {
            engine.discard(player.id, Math.floor(random() * player.hole.length));
          }
          continue;
        }
        if (engine.awaitingRunout) {
          engine.runoutStep();
          continue;
        }
        const actor = engine.toAct;
        expect(actor).not.toBeNull();
        const legal = engine.legalActions(actor!.id)!;
        const roll = random();
        let action: PlayerAction;
        if (roll < 0.15) {
          action = { type: 'fold' };
        } else if (roll < 0.55) {
          action = legal.canCheck ? { type: 'check' } : { type: 'call' };
        } else if (roll < 0.9 && (legal.canBet || legal.canRaise)) {
          const span = legal.maxRaiseTo - legal.minRaiseTo;
          action = { type: legal.canBet ? 'bet' : 'raise', amount: legal.minRaiseTo + Math.floor(random() * (span + 1)) };
        } else if (legal.canBet || legal.canRaise) {
          action = { type: 'allin' };
        } else {
          action = legal.canCheck ? { type: 'check' } : { type: 'call' };
        }
        const result = engine.act(actor!.id, action);
        expect(result, JSON.stringify({ action, legal })).toEqual({ ok: true });
        if (!engine.isComplete) {
          expect(totalChips(engine)).toBe(before);
        }
      }
      expect(engine.isComplete).toBe(true);
      const after = engine.players.reduce((sum, player) => sum + player.stack, 0);
      expect(after).toBe(before);
      expect(engine.players.every((player) => player.stack >= 0)).toBe(true);
      const won = engine.result!.winners.reduce((sum, winner) => sum + winner.amount, 0);
      expect(won).toBe(engine.totalPot);
    }
  });
});

describe('returning player posts (live BB + dead SB)', () => {
  function postHand(stacks: number[], post: { live: number; dead: number }, holes?: string[], board?: string): HandEngine {
    const handSeats = seats(...stacks);
    handSeats[3] = { ...handSeats[3], post };
    const engine = new HandEngine({ handNumber: 1, seats: handSeats, dealerSeat: 0, rules: rules(), deck: holes ? stackDeck(holes, board ?? '2c 3d 8h 9s Kd') : undefined });
    engine.start();
    return engine;
  }

  it('posts a live BB that counts as the bet and a dead SB that only goes to the pot', () => {
    const engine = postHand([1000, 1000, 1000, 1000], { live: 20, dead: 10 });
    const poster = engine.player('p3')!;
    expect(engine.smallBlindSeat).toBe(1);
    expect(engine.bigBlindSeat).toBe(2);
    expect(poster).toMatchObject({ bet: 20, total: 20, dead: 10, stack: 970, lastAction: 'BB 20 + mŕtvy SB 10' });
    expect(engine.currentBet).toBe(20);
    expect(engine.totalPot).toBe(60);
    expect(totalChips(engine)).toBe(4000);
  });

  it('lets the poster check when unraised and keeps the min-raise at one BB', () => {
    const engine = postHand([1000, 1000, 1000, 1000], { live: 20, dead: 10 });
    expect(engine.toAct?.id).toBe('p3');
    expect(engine.legalActions('p3')).toMatchObject({ canCheck: true, callAmount: 0, canRaise: true, minRaiseTo: 40 });
    act(engine, 'p3', { type: 'check' });
    expect(engine.legalActions('p0')).toMatchObject({ canCheck: false, callAmount: 20, minRaiseTo: 40 });
    act(engine, 'p0', { type: 'call' });
    act(engine, 'p1', { type: 'call' });
    expect(engine.legalActions('p2')).toMatchObject({ canCheck: true, minRaiseTo: 40 });
    act(engine, 'p2', { type: 'check' });
    expect(engine.street).toBe('flop');
    expect(engine.pots()).toEqual([{ amount: 90, eligible: ['p0', 'p1', 'p2', 'p3'] }]);
    expect(totalChips(engine)).toBe(4000);
  });

  it('pays the dead money to the fold winner', () => {
    const engine = postHand([1000, 1000, 1000, 1000], { live: 20, dead: 10 });
    act(engine, 'p3', { type: 'fold' });
    act(engine, 'p0', { type: 'fold' });
    act(engine, 'p1', { type: 'fold' });
    expect(engine.isComplete).toBe(true);
    expect(engine.result!.winners).toEqual([expect.objectContaining({ playerId: 'p2', amount: 60 })]);
    expect(engine.player('p2')!.stack).toBe(1040);
    expect(engine.players.reduce((sum, player) => sum + player.stack, 0)).toBe(4000);
  });

  it('puts the dead SB into the main pot when side pots form', () => {
    const engine = postHand([50, 1000, 1000, 1000], { live: 20, dead: 10 }, ['Kh Kd', '7c 2d', '9h 4s', 'Ah As'], '2h 5c 8d Jc Qs');
    act(engine, 'p3', { type: 'raise', amount: 100 });
    act(engine, 'p0', { type: 'allin' });
    act(engine, 'p1', { type: 'call' });
    act(engine, 'p2', { type: 'call' });
    expect(engine.pots()).toEqual([
      { amount: 210, eligible: ['p0', 'p1', 'p2', 'p3'] },
      { amount: 150, eligible: ['p1', 'p2', 'p3'] },
    ]);
    while (!engine.isComplete) {
      act(engine, engine.toAct!.id, { type: 'check' });
    }
    expect(engine.player('p0')!.stack).toBe(210);
    expect(engine.player('p1')!.stack).toBe(900 + 150);
    expect(engine.players.reduce((sum, player) => sum + player.stack, 0)).toBe(3050);
  });

  it('posts all-in when short: live part first, then the dead part', () => {
    const engine = postHand([1000, 1000, 1000, 25], { live: 20, dead: 10 });
    expect(engine.player('p3')).toMatchObject({ bet: 20, total: 20, dead: 5, stack: 0, status: 'allin' });
    expect(totalChips(engine)).toBe(3025);
  });

  it('ignores a post for a player in the blinds', () => {
    const handSeats = seats(1000, 1000, 1000);
    handSeats[2] = { ...handSeats[2], post: { live: 20, dead: 10 } };
    const engine = new HandEngine({ handNumber: 1, seats: handSeats, dealerSeat: 0, rules: rules() });
    engine.start();
    expect(engine.player('p2')).toMatchObject({ bet: 20, total: 20, dead: 0 });
  });
});
