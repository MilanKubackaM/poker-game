import { randomInt } from 'node:crypto';
import type { Card, Rank, Suit } from '../../shared/types';

export const RANKS: Rank[] = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
export const SUITS: Suit[] = ['s', 'h', 'd', 'c'];

export function rankValue(card: Card): number {
  return RANKS.indexOf(card[0] as Rank) + 2;
}

export function suitOf(card: Card): Suit {
  return card[1] as Suit;
}

export function freshDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push(`${rank}${suit}`);
    }
  }
  return deck;
}

export function shuffle<T>(items: T[], random: (max: number) => number = randomInt): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index--) {
    const swapIndex = random(index + 1);
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

export function parseCards(text: string): Card[] {
  return text.trim().split(/\s+/).filter(Boolean) as Card[];
}
