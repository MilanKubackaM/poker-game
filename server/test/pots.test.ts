import { describe, expect, it } from 'vitest';
import { buildPots, findUncalled, splitAmount } from '../poker/pots';

describe('buildPots', () => {
  it('creates a single pot when all contributed equally', () => {
    const pots = buildPots([
      { playerId: 'a', amount: 100, folded: false },
      { playerId: 'b', amount: 100, folded: false },
    ]);
    expect(pots).toEqual([{ amount: 200, eligible: ['a', 'b'] }]);
  });

  it('creates side pots for different all-in amounts', () => {
    const pots = buildPots([
      { playerId: 'a', amount: 50, folded: false },
      { playerId: 'b', amount: 200, folded: false },
      { playerId: 'c', amount: 200, folded: false },
      { playerId: 'd', amount: 30, folded: true },
    ]);
    expect(pots).toEqual([
      { amount: 50 * 3 + 30, eligible: ['a', 'b', 'c'] },
      { amount: 300, eligible: ['b', 'c'] },
    ]);
  });

  it('keeps folded money as dead money', () => {
    const pots = buildPots([
      { playerId: 'a', amount: 100, folded: true },
      { playerId: 'b', amount: 100, folded: false },
      { playerId: 'c', amount: 100, folded: false },
    ]);
    expect(pots).toEqual([{ amount: 300, eligible: ['b', 'c'] }]);
  });
});

describe('findUncalled', () => {
  it('returns the excess of the highest contributor', () => {
    expect(findUncalled([
      { playerId: 'a', amount: 500, folded: false },
      { playerId: 'b', amount: 200, folded: false },
      { playerId: 'c', amount: 20, folded: true },
    ])).toEqual({ playerId: 'a', amount: 300 });
  });

  it('returns null when matched', () => {
    expect(findUncalled([
      { playerId: 'a', amount: 200, folded: false },
      { playerId: 'b', amount: 200, folded: false },
    ])).toBeNull();
  });
});

describe('splitAmount', () => {
  it('gives the odd chip to the first winner', () => {
    expect([...splitAmount(101, ['x', 'y'])]).toEqual([['x', 51], ['y', 50]]);
  });
});
