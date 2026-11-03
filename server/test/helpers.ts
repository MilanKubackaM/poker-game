import type { Card, HandRules, Variant } from '../../shared/types';
import { freshDeck, parseCards } from '../poker/cards';
import { HandEngine, type HandSeat } from '../poker/HandEngine';
import type { Table, TablePlayer } from '../Table';

export function stackDeck(holesInDealOrder: string[], board: string): Card[] {
  const holes = holesInDealOrder.map(parseCards);
  const boardCards = parseCards(board);
  const used = new Set<Card>([...holes.flat(), ...boardCards]);
  const filler = freshDeck().filter((card) => !used.has(card));
  const deck: Card[] = [];
  const holeCount = holes[0].length;
  for (let round = 0; round < holeCount; round++) {
    for (const hole of holes) {
      deck.push(hole[round]);
    }
  }
  const burn = () => deck.push(filler.shift()!);
  burn();
  deck.push(boardCards[0], boardCards[1], boardCards[2]);
  burn();
  deck.push(boardCards[3]);
  burn();
  deck.push(boardCards[4]);
  deck.push(...filler);
  return deck;
}

export function rules(overrides: Partial<HandRules> = {}): HandRules {
  const variant: Variant = overrides.variant ?? 'holdem';
  return {
    variant,
    structure: variant === 'omaha' ? 'pot-limit' : 'no-limit',
    sevenDeuce: false,
    sevenDeuceBounty: 40,
    smallBlind: 10,
    bigBlind: 20,
    ...overrides,
  };
}

export function seats(...stacks: number[]): HandSeat[] {
  return stacks.map((stack, index) => ({ id: `p${index}`, name: `P${index}`, seat: index, stack }));
}

export function makeHand(options: { stacks: number[]; dealerSeat?: number; rules?: Partial<HandRules>; holes?: string[]; board?: string }): HandEngine {
  const engine = new HandEngine({
    handNumber: 1,
    seats: seats(...options.stacks),
    dealerSeat: options.dealerSeat ?? 0,
    rules: rules(options.rules),
    deck: options.holes ? stackDeck(options.holes, options.board ?? '2c 3d 8h 9s Kd') : undefined,
  });
  engine.start();
  return engine;
}

export function totalChips(engine: HandEngine): number {
  return engine.players.reduce((sum, player) => sum + player.stack + player.total + player.dead, 0);
}

/** Predvolené dobitie testovacích hráčov hneď po príchode (náhrada za zrušený automatický štartovací vklad). */
export const TEST_BUY_IN = 2000;
const testBuyIns = new WeakMap<Table, number>();

/** Nastaví, koľko žetónov dostane každý ďalší hráč stola v testoch (0 = nič). */
export function setTestBuyIn(table: Table, amount: number): void {
  testBuyIns.set(table, amount);
}

/** Bankár dobije práve prisadnutého hráča na dlh — ako to v reálnej hre spraví bankár v čakárni. */
export function buyIn(table: Table, player: TablePlayer): void {
  const amount = testBuyIns.get(table) ?? TEST_BUY_IN;
  if (amount <= 0) {
    return;
  }
  const outcome = table.bankChips(player, amount, '', null, 'owed');
  if (!outcome.ok) {
    throw new Error(`buy-in ${player.name} failed: ${outcome.error}`);
  }
}
