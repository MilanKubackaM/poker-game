import { describe, expect, it } from 'vitest';
import type { HandRules } from '../../shared/types';
import { HandEngine } from '../poker/HandEngine';
import { rules, seats } from './helpers';

/** Deterministické pseudonáhodné čísla — zlyhanie sa dá zopakovať. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function playRandomHand(variantRules: Partial<HandRules>, stacks: number[], random: () => number, ante = 0): HandEngine {
  const engine = new HandEngine({ handNumber: 1, seats: seats(...stacks), dealerSeat: 0, rules: rules(variantRules), ante });
  engine.start();
  assertInvariants(engine);
  let guard = 0;
  while (!engine.isComplete && guard++ < 500) {
    if (engine.street === 'discard') {
      engine.autoDiscardRemaining();
    } else if (engine.awaitingRunout) {
      engine.runoutStep();
    } else {
      const actor = engine.toAct!;
      const legal = engine.legalActions(actor.id)!;
      const roll = random();
      if (roll < 0.15 && legal.canFold && legal.callAmount > 0) {
        engine.act(actor.id, { type: 'fold' });
      } else if (roll < 0.55) {
        engine.act(actor.id, legal.canCheck ? { type: 'check' } : { type: 'call' });
      } else if (roll < 0.9 && (legal.canBet || legal.canRaise)) {
        const span = legal.maxRaiseTo - legal.minRaiseTo;
        const amount = legal.minRaiseTo + Math.floor(random() * (span + 1));
        engine.act(actor.id, { type: legal.canBet ? 'bet' : 'raise', amount });
      } else if (legal.canBet || legal.canRaise) {
        engine.act(actor.id, { type: 'allin' });
      } else {
        engine.act(actor.id, legal.canCheck ? { type: 'check' } : { type: 'call' });
      }
    }
    assertInvariants(engine);
  }
  expect(engine.isComplete).toBe(true);
  return engine;
}

/**
 * Úplnosť záznamu: pot, príspevky a stávky sa dajú zložiť výhradne zo záznamu akcií (to je to, čo dostane coach),
 * a poradie je súvislé. Čo sa takto zložiť nedá, v coach API chýba.
 */
function assertInvariants(engine: HandEngine): void {
  const actions = engine.actions;
  actions.forEach((action, index) => expect(action.seq).toBe(index + 1));

  let running = engine.ante;
  for (const action of actions) {
    expect(action.potBefore).toBe(running);
    running += action.type === 'uncalled' ? -action.amount : action.amount;
  }
  expect(running).toBe(engine.totalPot - engine.players.reduce((sum, player) => sum + player.dead, 0));

  for (const player of engine.players) {
    const own = actions.filter((action) => action.playerId === player.id);
    expect(own.reduce((sum, action) => sum + (action.type === 'uncalled' ? -action.amount : action.amount), 0)).toBe(player.total);
    if (!engine.isComplete && !engine.awaitingRunout && engine.street !== 'discard') {
      const street = own.filter((action) => action.street === engine.street && action.type !== 'discard');
      const expected = street.length > 0 ? street[street.length - 1].toAmount : 0;
      expect(player.bet).toBe(expected);
    }
  }

  for (const action of actions) {
    expect(Object.keys(action).sort()).toEqual(['allin', 'amount', 'auto', 'playerId', 'potBefore', 'seq', 'street', 'toAmount', 'type']);
  }
}

describe('záznam akcií ruky pre coach API', () => {
  it('zaznamená blindy, akcie a príznak all-in v poradí', () => {
    const engine = new HandEngine({ handNumber: 1, seats: seats(1000, 1000, 1000), dealerSeat: 0, rules: rules() });
    engine.start();
    const types = engine.actions.map((action) => action.type);
    expect(types).toEqual(['sb', 'bb']);
    expect(engine.actions[0]).toMatchObject({ seq: 1, amount: 10, toAmount: 10, potBefore: 0, street: 'preflop', auto: false, allin: false });
    expect(engine.actions[1]).toMatchObject({ seq: 2, amount: 20, toAmount: 20, potBefore: 10 });

    const first = engine.toAct!;
    engine.act(first.id, { type: 'raise', amount: 60 });
    engine.act(engine.toAct!.id, { type: 'allin' });
    const last = engine.actions[engine.actions.length - 1];
    expect(engine.actions[2]).toMatchObject({ type: 'raise', amount: 60, toAmount: 60, potBefore: 30 });
    expect(last).toMatchObject({ allin: true, auto: false });
  });

  it('označí akcie za hráča ako automatické', () => {
    const engine = new HandEngine({ handNumber: 1, seats: seats(1000, 1000, 1000), dealerSeat: 0, rules: rules() });
    engine.start();
    engine.autoAct();
    expect(engine.actions[engine.actions.length - 1]).toMatchObject({ type: 'fold', auto: true });
    engine.act(engine.toAct!.id, { type: 'call' });
    expect(engine.actions[engine.actions.length - 1].auto).toBe(false);
  });

  it('akcia vyhodeného hráča mimo poradia je automatická', () => {
    const engine = new HandEngine({ handNumber: 1, seats: seats(1000, 1000, 1000), dealerSeat: 0, rules: rules() });
    engine.start();
    const notToAct = engine.players.find((player) => player !== engine.toAct && player.status === 'active')!;
    engine.foldOut(notToAct.id);
    expect(engine.actions[engine.actions.length - 1]).toMatchObject({ playerId: notToAct.id, type: 'fold', auto: true });
  });

  it('zahodenie v Pineapple je v zázname bez karty', () => {
    const engine = new HandEngine({ handNumber: 1, seats: seats(1000, 1000), dealerSeat: 0, rules: rules({ variant: 'pineapple' }) });
    engine.start();
    engine.act(engine.toAct!.id, { type: 'call' });
    engine.act(engine.toAct!.id, { type: 'check' });
    expect(engine.street).toBe('discard');
    engine.discard(engine.players[0].id, 1);
    const discard = engine.actions[engine.actions.length - 1];
    expect(discard).toMatchObject({ type: 'discard', amount: 0, auto: false });
    expect(JSON.stringify(discard)).not.toMatch(/[2-9TJQKA][shdc]/);
    engine.autoDiscardRemaining();
    expect(engine.actions[engine.actions.length - 1]).toMatchObject({ type: 'discard', auto: true });
  });

  const variants: [string, Partial<HandRules>][] = [
    ['Hold\'em', {}],
    ['Omaha', { variant: 'omaha' }],
    ['Pineapple', { variant: 'pineapple' }],
    ['Double Board', { doubleBoard: true }],
    ['Omaha Double Board', { variant: 'omaha', doubleBoard: true }],
    ['7-2', { sevenDeuce: true }],
  ];

  for (const [label, variantRules] of variants) {
    it(`záznam je úplný v náhodných rukách: ${label}`, () => {
      const random = lcg(variantRules.variant === 'omaha' ? 7 : 11);
      for (let game = 0; game < 120; game++) {
        const count = 2 + Math.floor(random() * 6);
        const stacks = Array.from({ length: count }, () => 40 + Math.floor(random() * 2000));
        playRandomHand(variantRules, stacks, random, game % 5 === 0 ? 30 : 0);
      }
    });
  }
});
