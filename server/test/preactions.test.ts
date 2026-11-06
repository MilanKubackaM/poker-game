import { describe, expect, it } from 'vitest';
import type { LegalActions } from '../../shared/types';
import { preActionOptions, resolvePreAction } from '../../client/src/preActions';

function legal(callAmount: number): LegalActions {
  return { canFold: true, canCheck: callAmount === 0, callAmount, canBet: callAmount === 0, canRaise: callAmount > 0, minRaiseTo: 40, maxRaiseTo: 2000, currentBet: callAmount };
}

describe('automatické akcie', () => {
  it('Check: checkne, ale pri stávke sa zruší bez ťahu', () => {
    expect(resolvePreAction({ kind: 'check' }, legal(0))).toEqual({ type: 'check' });
    expect(resolvePreAction({ kind: 'check' }, legal(20))).toBeNull();
  });

  it('Check / Fold: checkne, inak zloží', () => {
    expect(resolvePreAction({ kind: 'check-fold' }, legal(0))).toEqual({ type: 'check' });
    expect(resolvePreAction({ kind: 'check-fold' }, legal(20))).toEqual({ type: 'fold' });
  });

  it('Call X: dorovná len presne zvolenú sumu', () => {
    expect(resolvePreAction({ kind: 'call', amount: 20 }, legal(20))).toEqual({ type: 'call' });
    expect(resolvePreAction({ kind: 'call', amount: 20 }, legal(60))).toBeNull();
    expect(resolvePreAction({ kind: 'call', amount: 20 }, legal(0))).toBeNull();
  });

  it('Call any: dorovná čokoľvek, bez stávky checkne', () => {
    expect(resolvePreAction({ kind: 'call-any' }, legal(500))).toEqual({ type: 'call' });
    expect(resolvePreAction({ kind: 'call-any' }, legal(0))).toEqual({ type: 'check' });
  });
});

describe('sloty predvolieb', () => {
  const money = (cents: number) => `${cents}`;

  it('bez stávky: Check / Fold | Check | Call any — rovnaké poradie ako Fold | Check | Bet', () => {
    const options = preActionOptions(0, 1000, money);
    expect(options.map((option) => option.slot)).toEqual(['fold', 'call', 'raise']);
    expect(options.map((option) => option.label)).toEqual(['Check / Fold', 'Check', 'Call any']);
    expect(options[1].value).toEqual({ kind: 'check' });
  });

  it('pri stávke: Fold | Call X | Call any', () => {
    const options = preActionOptions(40, 1000, money);
    expect(options.map((option) => option.label)).toEqual(['Fold', 'Call 40', 'Call any']);
    expect(options[1]).toMatchObject({ tone: 'call', value: { kind: 'call', amount: 40 } });
  });

  it('dorovnanie celého stacku je All-in', () => {
    expect(preActionOptions(1000, 1000, money)[1]).toMatchObject({ tone: 'allin', label: 'All-in 1000' });
  });
});
