import type { SeatPlayerView, WinnerView } from '../../shared/types';

/** Víťaz jedného boardu / behu: spolu vyhraté na ňom (všetky poty) a popis jeho kombinácie. */
export interface BoardWinner {
  id: string;
  name: string;
  amount: number;
  handDescription: string | null;
}

/**
 * Rozdelí víťazov ruky podľa boardu — Double Board (`winner.board`) alebo behu all-inu (`winner.run`). Víťazi bez
 * indexu (ruka bez showdownu) sa nerátajú; ten istý hráč z viacerých potov toho boardu je jeden riadok so súčtom.
 */
export function boardWinners(winners: WinnerView[], players: SeatPlayerView[], boardOf: (winner: WinnerView) => number | undefined, count: number): BoardWinner[][] {
  const boards: BoardWinner[][] = Array.from({ length: count }, () => []);
  for (const winner of winners) {
    const index = boardOf(winner);
    if (index === undefined || !boards[index]) {
      continue;
    }
    const existing = boards[index].find((entry) => entry.id === winner.playerId);
    if (existing) {
      existing.amount += winner.amount;
      existing.handDescription ??= winner.handDescription;
      continue;
    }
    const name = players.find((player) => player.id === winner.playerId)?.name ?? '?';
    boards[index].push({ id: winner.playerId, name, amount: winner.amount, handDescription: winner.handDescription });
  }
  return boards;
}
