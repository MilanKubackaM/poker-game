import type { CoachHand, CoachPiggy, CoachPlayer, CoachResult, CoachState } from '../../shared/coach';
import type { TableStateView } from '../../shared/types';

/**
 * Priemet `TableStateView` (pohľad jedného hráča, `Table.liveView`) pre coach API. Karty prichádzajú výhradne z `liveView`,
 * takže viditeľnosť kariet rieši jedno miesto — tu sa len vyberajú polia a ID hráčov menia na stále `pid`.
 * Nové pole sa do coach API nedostane, kým ho sem niekto výslovne nepridá.
 */
export function projectCoachState(view: TableStateView, pidOf: (playerId: string) => string): CoachState {
  const players: CoachPlayer[] = view.players.map((player) => ({
    pid: pidOf(player.id),
    name: player.name,
    seat: player.seat,
    stack: player.stack,
    connected: player.connected,
    sittingOut: player.sittingOut,
    away: player.away,
    inHand: player.inHand,
    status: player.status,
    bet: player.bet,
    totalContributed: player.totalContributed,
    cards: [...player.cards],
    cardCount: player.cardCount,
    hasDiscarded: player.hasDiscarded,
    lastAction: player.lastAction,
    handDescription: player.handDescription,
    isYou: player.id === view.youId,
  }));

  const hand: CoachHand | null = view.hand && {
    handNumber: view.hand.handNumber,
    rules: { ...view.hand.rules },
    street: view.hand.street,
    board: [...view.hand.board],
    ...(view.hand.secondBoard ? { secondBoard: [...view.hand.secondBoard] } : {}),
    ...(view.hand.extraBoards ? { extraBoards: view.hand.extraBoards.map((board) => [...board]) } : {}),
    ...(view.hand.runs !== undefined ? { runs: view.hand.runs } : {}),
    ...(view.hand.runoutBase !== undefined ? { runoutBase: view.hand.runoutBase } : {}),
    pots: view.hand.pots.map((pot) => ({ amount: pot.amount, eligible: pot.eligible.map(pidOf) })),
    totalPot: view.hand.totalPot,
    dealerSeat: view.hand.dealerSeat,
    smallBlindSeat: view.hand.smallBlindSeat,
    bigBlindSeat: view.hand.bigBlindSeat,
    toAct: view.hand.toActId ? pidOf(view.hand.toActId) : null,
    turnDeadline: view.hand.turnDeadline,
    discardDeadline: view.hand.discardDeadline,
  };

  const lastResult: CoachResult | null = view.lastResult && {
    handNumber: view.lastResult.handNumber,
    winners: view.lastResult.winners.map((winner) => ({
      pid: pidOf(winner.playerId),
      amount: winner.amount,
      potIndex: winner.potIndex,
      handDescription: winner.handDescription,
      bestCards: [...winner.bestCards],
      ...(winner.run !== undefined ? { run: winner.run } : {}),
      ...(winner.board !== undefined ? { board: winner.board } : {}),
    })),
    bounty: view.lastResult.bounty && {
      winner: pidOf(view.lastResult.bounty.winnerId),
      total: view.lastResult.bounty.total,
      payers: view.lastResult.bounty.payers.map((payer) => ({ pid: pidOf(payer.playerId), amount: payer.amount })),
    },
    revealed: mapKeys(view.lastResult.revealed, pidOf, (cards) => [...cards]),
    wonWithoutShowdown: view.lastResult.wonWithoutShowdown,
  };

  const piggy: CoachPiggy | null = view.piggy && {
    status: view.piggy.status,
    amount: view.piggy.amount,
    entry: view.piggy.entry,
    target: view.piggy.target,
    rings: mapKeys(view.piggy.wins, pidOf, (count) => count),
    contributed: mapKeys(view.piggy.contributed, pidOf, (amount) => amount),
    startedAtHand: view.piggy.startedAtHand,
    winners: view.piggy.winners.map((winner) => ({ pid: pidOf(winner.playerId), amount: winner.amount })),
    series: { ...view.piggy.series },
  };

  return {
    code: view.code,
    you: pidOf(view.youId),
    phase: view.phase,
    running: view.running,
    paused: view.paused,
    handNumber: view.hand?.handNumber ?? view.lastResult?.handNumber ?? 0,
    settings: {
      name: view.settings.name,
      currency: view.settings.currency,
      smallBlind: view.settings.smallBlind,
      bigBlind: view.settings.bigBlind,
      defaultVariant: view.settings.defaultVariant,
      sevenDeuceAlways: view.settings.sevenDeuceAlways,
      sevenDeuceBounty: view.settings.sevenDeuceBounty,
      actionTimeoutSec: view.settings.actionTimeoutSec,
      omahaPotLimit: view.settings.omahaPotLimit,
    },
    players,
    hand,
    legal: view.legal && { ...view.legal },
    lastResult,
    nextHand: view.nextHand && { ...view.nextHand },
    doubleBoard: view.doubleBoard && { ...view.doubleBoard },
    piggy,
    modeIntro: view.modeIntro && {
      mode: view.modeIntro.mode,
      participants: view.modeIntro.participants.map(pidOf),
      acknowledged: view.modeIntro.acknowledged.map(pidOf),
      deadline: view.modeIntro.deadline,
    },
    runVote: view.runVote && {
      handNumber: view.runVote.handNumber,
      participants: view.runVote.participants.map(pidOf),
      choices: mapKeys(view.runVote.choices, pidOf, (runs) => runs),
      maxRuns: view.runVote.maxRuns,
      deadline: view.runVote.deadline,
    },
    rabbit: view.rabbit && { handNumber: view.rabbit.handNumber, cards: [...view.rabbit.cards], pid: pidOf(view.rabbit.playerId), until: view.rabbit.until },
    anteAmount: view.anteAmount,
    serverTime: view.serverTime,
  };
}

function mapKeys<V, R>(source: Record<string, V>, key: (id: string) => string, value: (item: V) => R): Record<string, R> {
  const result: Record<string, R> = {};
  for (const [id, item] of Object.entries(source)) {
    result[key(id)] = value(item);
  }
  return result;
}
