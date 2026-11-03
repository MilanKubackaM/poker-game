import { describe, expect, it } from 'vitest';
import type { LegalActions } from '../../shared/types';
import { resolvePreAction } from '../../client/src/preActions';

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
