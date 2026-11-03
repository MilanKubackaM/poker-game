import type { Card } from '../../shared/types';
import { rankValue, suitOf } from './cards';

export enum HandCategory {
  HighCard = 0,
  OnePair = 1,
  TwoPair = 2,
  Trips = 3,
  Straight = 4,
  Flush = 5,
  FullHouse = 6,
  Quads = 7,
  StraightFlush = 8,
}

export interface EvaluatedHand {
  score: number;
  category: HandCategory;
  cards: Card[];
  description: string;
}

const RANK_NAMES: Record<number, [string, string, string]> = {
  2: ['dvojka', 'dvojky', 'dvojky'],
  3: ['trojka', 'trojky', 'trojky'],
  4: ['štvorka', 'štvorky', 'štvorky'],
  5: ['päťka', 'päťky', 'päťky'],
  6: ['šestka', 'šestky', 'šestky'],
  7: ['sedmička', 'sedmičky', 'sedmičky'],
  8: ['osmička', 'osmičky', 'osmičky'],
  9: ['deviatka', 'deviatky', 'deviatky'],
  10: ['desiatka', 'desiatky', 'desiatky'],
  11: ['dolník', 'dolníky', 'dolníka'],
  12: ['dáma', 'dámy', 'dámy'],
  13: ['kráľ', 'kráľe', 'kráľa'],
  14: ['eso', 'esá', 'esa'],
};

function single(rank: number): string {
  return RANK_NAMES[rank][0];
}

function plural(rank: number): string {
  return RANK_NAMES[rank][1];
}

function genitive(rank: number): string {
  return RANK_NAMES[rank][2];
}

function encode(category: HandCategory, kickers: number[]): number {
  let score = category;
  for (let index = 0; index < 5; index++) {
    score = score * 15 + (kickers[index] ?? 0);
  }
  return score;
}

function describe(category: HandCategory, kickers: number[]): string {
  switch (category) {
    case HandCategory.StraightFlush:
      return kickers[0] === 14 ? 'Royal flush' : `Straight flush do ${genitive(kickers[0])}`;
    case HandCategory.Quads:
      return `Poker — ${plural(kickers[0])}`;
    case HandCategory.FullHouse:
      return `Full house — ${plural(kickers[0])} a ${plural(kickers[1])}`;
    case HandCategory.Flush:
      return `Farba — ${single(kickers[0])} navrchu`;
    case HandCategory.Straight:
      return `Postupka do ${genitive(kickers[0])}`;
    case HandCategory.Trips:
      return `Trojica — ${plural(kickers[0])}`;
    case HandCategory.TwoPair:
      return `Dva páry — ${plural(kickers[0])} a ${plural(kickers[1])}`;
    case HandCategory.OnePair:
      return `Pár — ${plural(kickers[0])}`;
    default:
      return `Vysoká karta — ${single(kickers[0])}`;
  }
}

export function evaluateFive(cards: Card[]): EvaluatedHand {
  if (cards.length !== 5) {
    throw new Error('evaluateFive needs exactly 5 cards');
  }
  const values = cards.map(rankValue).sort((left, right) => right - left);
  const isFlush = cards.every((card) => suitOf(card) === suitOf(cards[0]));
  const unique = [...new Set(values)];
  let straightHigh = 0;
  if (unique.length === 5) {
    if (values[0] - values[4] === 4) {
      straightHigh = values[0];
    } else if (values[0] === 14 && values[1] === 5 && values[4] === 2) {
      straightHigh = 5;
    }
  }

  const counts = new Map<number, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  const groups = [...counts.entries()].sort((left, right) => right[1] - left[1] || right[0] - left[0]);
  const groupRanks = groups.map(([rank]) => rank);

  let category: HandCategory;
  let kickers: number[];
  if (straightHigh && isFlush) {
    category = HandCategory.StraightFlush;
    kickers = [straightHigh];
  } else if (groups[0][1] === 4) {
    category = HandCategory.Quads;
    kickers = groupRanks;
  } else if (groups[0][1] === 3 && groups[1][1] === 2) {
    category = HandCategory.FullHouse;
    kickers = groupRanks;
  } else if (isFlush) {
    category = HandCategory.Flush;
    kickers = values;
  } else if (straightHigh) {
    category = HandCategory.Straight;
    kickers = [straightHigh];
  } else if (groups[0][1] === 3) {
    category = HandCategory.Trips;
    kickers = groupRanks;
  } else if (groups[0][1] === 2 && groups[1][1] === 2) {
    category = HandCategory.TwoPair;
    kickers = groupRanks;
  } else if (groups[0][1] === 2) {
    category = HandCategory.OnePair;
    kickers = groupRanks;
  } else {
    category = HandCategory.HighCard;
    kickers = values;
  }

  return { score: encode(category, kickers), category, cards: [...cards], description: describe(category, kickers) };
}

function combinations<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  const current: T[] = [];
  const walk = (start: number) => {
    if (current.length === size) {
      result.push([...current]);
      return;
    }
    for (let index = start; index <= items.length - (size - current.length); index++) {
      current.push(items[index]);
      walk(index + 1);
      current.pop();
    }
  };
  walk(0);
  return result;
}

function best(candidates: Card[][]): EvaluatedHand {
  let top: EvaluatedHand | null = null;
  for (const candidate of candidates) {
    const evaluated = evaluateFive(candidate);
    if (!top || evaluated.score > top.score) {
      top = evaluated;
    }
  }
  if (!top) {
    throw new Error('No candidate hands');
  }
  return top;
}

export function evaluateHoldem(hole: Card[], board: Card[]): EvaluatedHand {
  const all = [...hole, ...board];
  if (all.length < 5) {
    throw new Error('Need at least 5 cards');
  }
  return best(combinations(all, 5));
}

export function evaluateOmaha(hole: Card[], board: Card[]): EvaluatedHand {
  if (hole.length < 2 || board.length < 3) {
    throw new Error('Omaha needs 2+ hole cards and 3+ board cards');
  }
  const candidates: Card[][] = [];
  for (const holePair of combinations(hole, 2)) {
    for (const boardTriple of combinations(board, 3)) {
      candidates.push([...holePair, ...boardTriple]);
    }
  }
  return best(candidates);
}
