import { describe, expect, it } from 'vitest';
import { boardWinners } from '../../client/src/boardWinners';
import type { SeatPlayerView, WinnerView } from '../../shared/types';

const players = [
  { id: 'a', name: 'Zuzka' },
  { id: 'b', name: 'Juraj' },
] as SeatPlayerView[];

const win = (playerId: string, amount: number, extra: Partial<WinnerView> = {}): WinnerView => ({ playerId, amount, potIndex: 0, handDescription: null, bestCards: [], ...extra });

describe('boardWinners', () => {
  it('Double Board: víťazi podľa boardu, ten istý hráč z viacerých potov je jeden riadok so súčtom', () => {
    const rows = boardWinners(
      [win('a', 500, { board: 0, handDescription: 'Farba' }), win('a', 200, { board: 0, potIndex: 1 }), win('b', 700, { board: 1, handDescription: 'Trojica' })],
      players,
      (winner) => winner.board,
      2,
    );
    expect(rows).toEqual([[{ id: 'a', name: 'Zuzka', amount: 700, handDescription: 'Farba' }], [{ id: 'b', name: 'Juraj', amount: 700, handDescription: 'Trojica' }]]);
  });

  it('beh all-inu: remíza na jednom behu ukáže oboch, behy bez víťaza ostanú prázdne', () => {
    const rows = boardWinners([win('a', 300, { run: 0 }), win('b', 300, { run: 0 }), win('b', 600, { run: 1 })], players, (winner) => winner.run, 3);
    expect(rows.map((row) => row.map((entry) => `${entry.name}:${entry.amount}`))).toEqual([['Zuzka:300', 'Juraj:300'], ['Juraj:600'], []]);
  });

  it('víťaz bez indexu (ruka bez showdownu) ani mimo rozsahu sa nezapočíta', () => {
    expect(boardWinners([win('a', 100), win('b', 100, { run: 5 })], players, (winner) => winner.run, 2)).toEqual([[], []]);
  });
});
