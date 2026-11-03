import { describe, expect, it } from 'vitest';
import { parseCards } from '../poker/cards';
import { HandCategory, evaluateFive, evaluateHoldem, evaluateOmaha } from '../poker/evaluator';

const five = (text: string) => evaluateFive(parseCards(text));

describe('evaluateFive', () => {
  it('recognises every category', () => {
    expect(five('Ah Kh Qh Jh Th').category).toBe(HandCategory.StraightFlush);
    expect(five('9c 9d 9h 9s 2c').category).toBe(HandCategory.Quads);
    expect(five('9c 9d 9h 2s 2c').category).toBe(HandCategory.FullHouse);
    expect(five('2h 7h 9h Jh Kh').category).toBe(HandCategory.Flush);
    expect(five('5c 6d 7h 8s 9c').category).toBe(HandCategory.Straight);
    expect(five('9c 9d 9h 3s 2c').category).toBe(HandCategory.Trips);
    expect(five('9c 9d 3h 3s 2c').category).toBe(HandCategory.TwoPair);
    expect(five('9c 9d 4h 3s 2c').category).toBe(HandCategory.OnePair);
    expect(five('Kc 9d 4h 3s 2c').category).toBe(HandCategory.HighCard);
  });

  it('treats the wheel as a five-high straight', () => {
    const wheel = five('Ac 2d 3h 4s 5c');
    expect(wheel.category).toBe(HandCategory.Straight);
    expect(wheel.score).toBeLessThan(five('2c 3d 4h 5s 6c').score);
    expect(wheel.description).toBe('Postupka do päťky');
  });

  it('orders by kickers', () => {
    expect(five('Ac Ad Kh 4s 2c').score).toBeGreaterThan(five('Ac Ad Qh Js Tc').score);
    expect(five('Kc Kd 5h 5s Ac').score).toBeGreaterThan(five('Kc Kd 5h 5s Qc').score);
    expect(five('Ac Kd 9h 5s 3c').score).toBe(five('Ad Kc 9s 5h 3d').score);
  });

  it('describes royal flush', () => {
    expect(five('Ah Kh Qh Jh Th').description).toBe('Royal flush');
  });
});

describe('evaluateHoldem', () => {
  it('finds the best five out of seven', () => {
    const result = evaluateHoldem(parseCards('Ah Kh'), parseCards('Qh Jh Th 2c 3d'));
    expect(result.description).toBe('Royal flush');
  });

  it('plays the board when it is best', () => {
    const left = evaluateHoldem(parseCards('2c 3d'), parseCards('Ah Kh Qh Jh Th'));
    const right = evaluateHoldem(parseCards('4c 5d'), parseCards('Ah Kh Qh Jh Th'));
    expect(left.score).toBe(right.score);
  });
});

describe('evaluateOmaha', () => {
  it('requires exactly two hole cards — no flush with a single suited hole card', () => {
    const result = evaluateOmaha(parseCards('Th 3s 4d 5c'), parseCards('Ah Kh Qh Jh 2c'));
    expect(result.category).not.toBe(HandCategory.Flush);
    expect(result.category).not.toBe(HandCategory.StraightFlush);
    expect(result.category).not.toBe(HandCategory.Straight);
  });

  it('cannot play four board cards', () => {
    const result = evaluateOmaha(parseCards('2c 3d 4h 5s'), parseCards('Ah Ad Ac As Kd'));
    expect(result.category).toBe(HandCategory.Trips);
  });

  it('finds a flush with two suited hole cards', () => {
    const result = evaluateOmaha(parseCards('9h 8h 2c 2d'), parseCards('Ah Kh 3h 7s Jd'));
    expect(result.category).toBe(HandCategory.Flush);
  });
});
