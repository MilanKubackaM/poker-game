import { MAX_HISTORY_HANDS } from '../../shared/constants';
import { FAIR_HEX, FAIR_VERSION, dealStreets, expectedDeal, type FairExport, type FairProof } from '../../shared/fairness';
import type { Card } from '../../shared/types';
import { commitOf, deriveDeck } from './fairDeck';

export type HandStatus = 'verified' | 'failed' | 'pending' | 'checked-without-local-record';

export interface HandReport {
  handNumber: number;
  roundId: string;
  status: HandStatus;
  problems: string[];
  notes: string[];
}

export interface VerifyReport {
  table: string;
  playerId: string;
  hands: HandReport[];
  /** Problémy mimo konkrétnej ruky (formát súboru, kolá bez ruky). */
  general: string[];
  summary: { verified: number; failed: number; pending: number; withoutRecord: number; discardedRounds: number; missingProofs: number };
}

function sameList(left: Card[], right: Card[]): boolean {
  return left.length === right.length && left.every((card, index) => card === right[index]);
}

function isSubset(cards: Card[], of: Card[]): boolean {
  return cards.every((card) => of.includes(card));
}

function sameRecord(left: Record<string, string>, right: Record<string, string>): boolean {
  const keys = Object.keys(left).sort();
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key]);
}

function seatsKey(seats: { id: string; seat: number }[]): string {
  return [...seats]
    .sort((left, right) => left.seat - right.seat)
    .map((entry) => `${entry.seat}:${entry.id}`)
    .join(',');
}

/** Overí export z prehliadača hráča: dôkazy servera proti tomu, čo hráč videl a poslal. */
export function verifyExport(data: FairExport): VerifyReport {
  const general: string[] = [];
  if (data?.format !== 'poker-night-fairness-export' || data.version !== 1) {
    throw new Error('Not a Poker Night fairness export (format/version mismatch)');
  }
  const me = data.playerId;
  const rounds = new Map(data.rounds.map((round) => [round.roundId, round]));
  const hands = new Map(data.hands.map((hand) => [hand.roundId, hand]));
  const reports: HandReport[] = [];
  const usedRounds = new Set<string>();

  for (const proof of data.proofs) {
    usedRounds.add(proof.roundId);
    reports.push(verifyProof(data.table, me, proof, rounds.get(proof.roundId), hands.get(proof.roundId)));
  }

  // Poctivý server kolo nikdy nezahodí (uloží ho a použije najbližšia ruka). Zahodené kolo po odhalení semienok
  // = server mohol miešať znova, kým sa mu balíček nepozdával — to je chyba, nie poznámka.
  const discarded: string[] = [];
  const oldestProof = Math.min(...data.proofs.map((proof) => proof.at));
  const truncated = data.proofs.length >= MAX_HISTORY_HANDS;
  for (const round of data.rounds) {
    if (round.roundId === data.pendingRoundId) {
      general.push(`Round ${round.roundId}: your seed is already committed for the next hand, which has not been dealt yet.`);
    } else if (!usedRounds.has(round.roundId)) {
      if (truncated && round.sentAt < oldestProof) {
        general.push(`Round ${round.roundId}: older than the oldest proof the server keeps (${MAX_HISTORY_HANDS} hands) — cannot be checked.`);
      } else {
        discarded.push(round.roundId);
        general.push(`DISCARDED ROUND ${round.roundId}: your browser revealed its seed, but the server never dealt a hand from this round. An honest server never discards a round.`);
      }
    }
  }
  let missingProofs = 0;
  for (const hand of data.hands) {
    if (!usedRounds.has(hand.roundId)) {
      if (truncated) {
        general.push(`Hand #${hand.handNumber} (round ${hand.roundId}): no proof, probably older than the ${MAX_HISTORY_HANDS} hands the server keeps.`);
      } else {
        missingProofs += 1;
        general.push(`MISSING PROOF: you saw hand #${hand.handNumber} (round ${hand.roundId}), but the server sent no proof for it.`);
      }
    }
  }

  const count = (status: HandStatus) => reports.filter((report) => report.status === status).length;
  return {
    table: data.table,
    playerId: me,
    hands: reports,
    general,
    summary: {
      verified: count('verified'),
      failed: count('failed'),
      pending: count('pending'),
      withoutRecord: count('checked-without-local-record'),
      discardedRounds: discarded.length,
      missingProofs,
    },
  };
}

function verifyProof(table: string, me: string, proof: FairProof, round: FairExport['rounds'][number] | undefined, hand: FairExport['hands'][number] | undefined): HandReport {
  const problems: string[] = [];
  const notes: string[] = [];
  const report = (status: HandStatus): HandReport => ({ handNumber: proof.handNumber, roundId: proof.roundId, status: problems.length ? 'failed' : status, problems, notes });

  if (proof.v !== FAIR_VERSION || proof.table !== table) {
    problems.push(`Proof belongs to ${proof.table} / ${proof.v}, expected ${table} / ${FAIR_VERSION}.`);
  }
  if (round) {
    if (round.serverCommit !== proof.serverCommit) {
      problems.push('The server commitment in the proof differs from the one your browser saw before revealing its seed.');
    }
    if (!sameRecord(round.commitments, proof.commitments)) {
      problems.push('The list of player commitments in the proof differs from the list your browser saw before revealing its seed.');
    }
    if (proof.seeds[me] !== round.seed) {
      problems.push(
        proof.excluded.includes(me)
          ? 'Your browser sent its seed, but the server left it out of the shuffle (listed as excluded).'
          : 'The seed recorded for you in the proof is not the seed your browser sent.',
      );
    }
  } else if (proof.commitments[me]) {
    notes.push('Your commitment is in this round, but this browser has no record of revealing it (another device or cleared storage).');
  }
  for (const [playerId, seed] of Object.entries(proof.seeds)) {
    if (!proof.commitments[playerId] || !FAIR_HEX.test(seed) || commitOf(seed) !== proof.commitments[playerId]) {
      problems.push(`Seed of player ${playerId} does not match their commitment.`);
    }
  }
  const missing = Object.keys(proof.commitments).filter((playerId) => !proof.seeds[playerId]);
  if (missing.sort().join(',') !== [...proof.excluded].sort().join(',')) {
    problems.push('The excluded list does not match the commitments without a seed.');
  }
  if (proof.excluded.length) {
    notes.push(`Excluded from the shuffle (seed not received in time): ${proof.excluded.join(', ')}.`);
  }
  if (Object.keys(proof.seeds).length === 0) {
    notes.push('No player contributed a seed — this deck depends only on the server seed.');
  }

  if (!proof.serverSeed) {
    return report('pending');
  }
  if (!FAIR_HEX.test(proof.serverSeed) || commitOf(proof.serverSeed) !== proof.serverCommit) {
    problems.push('The revealed server seed does not match the server commitment published before the hand.');
    return report('failed');
  }

  const deck = deriveDeck({ table: proof.table, roundId: proof.roundId, serverSeed: proof.serverSeed, seeds: proof.seeds });
  let expected;
  try {
    expected = expectedDeal(deck, proof.seats, proof.dealerSeat, proof.holeCount);
  } catch (error) {
    problems.push(`Dealing order cannot be reconstructed: ${(error as Error).message}.`);
    return report('failed');
  }
  if (!hand) {
    return report('checked-without-local-record');
  }
  if (hand.dealerSeat !== proof.dealerSeat) {
    problems.push(`Dealer seat in the proof (${proof.dealerSeat}) differs from the one you saw (${hand.dealerSeat}).`);
  }
  if (seatsKey(hand.seats) !== seatsKey(proof.seats)) {
    problems.push('Players and seats in the proof differ from the ones you saw in the hand.');
  }
  const myHole = expected.holes[me];
  if (hand.hole.length && (!myHole || !isSubset(hand.hole, myHole))) {
    problems.push(`Your cards ${hand.hole.join(' ')} are not the cards the deck deals to your seat (${myHole?.join(' ') ?? 'none'}).`);
  }
  if (!sameList(hand.board, expected.board.slice(0, hand.board.length))) {
    problems.push(`Board ${hand.board.join(' ')} differs from the deck (${expected.board.slice(0, hand.board.length).join(' ')}).`);
  }
  let next = expected.afterBoard;
  hand.extraBoards.forEach((board, index) => {
    const run = expected.board.slice(0, hand.runoutBase);
    next = dealStreets(deck, next, run, hand.runoutBase);
    if (!sameList(board, run.slice(0, board.length))) {
      problems.push(`Run ${index + 2} board ${board.join(' ')} differs from the deck (${run.join(' ')}).`);
    }
  });
  for (const [playerId, cards] of Object.entries(hand.shown)) {
    const dealt = expected.holes[playerId];
    if (!dealt || !isSubset(cards, dealt)) {
      problems.push(`Cards shown by ${playerId} (${cards.join(' ')}) are not the cards the deck dealt to that seat.`);
    }
  }
  if (hand.rabbit.length) {
    const rabbit = expected.board.slice(hand.board.length, hand.board.length + hand.rabbit.length);
    if (!sameList(hand.rabbit, rabbit)) {
      problems.push(`Rabbit-hunt cards ${hand.rabbit.join(' ')} differ from the deck (${rabbit.join(' ')}).`);
    }
  }
  if (!proof.commitments[me] && proof.seats.some((entry) => entry.id === me)) {
    notes.push('Your browser did not contribute a seed to this hand (it had not committed yet).');
  }
  return report('verified');
}
