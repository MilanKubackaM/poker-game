import { randomBytes } from 'node:crypto';
import { FAIR_REVEAL_MS, FAIR_VERSION, type FairProof, type FairStateView } from '../shared/fairness';
import { MAX_HISTORY_HANDS } from '../shared/constants';
import type { Card } from '../shared/types';
import { commitOf, deriveDeck, isFairHex, newSeed } from './poker/fairDeck';

const RESTORE_GRACE_MS = 15_000;

/** Kolo miešania: server sa zaviazal k `serverSeed`, zoznam odtlačkov hráčov je zmrazený, zbierajú sa semienka. */
export interface FairRound {
  roundId: string;
  serverSeed: string;
  serverCommit: string;
  commitments: Record<string, string>;
  seeds: Record<string, string>;
  createdAt: number;
  deadline: number;
}

export interface PersistedFair {
  round: FairRound | null;
  /** Dôkazy vrátane semienka servera (to sa hráčom ukáže až po hre). */
  proofs: FairProof[];
}

export interface DealtHand {
  handNumber: number;
  dealerSeat: number;
  seats: { id: string; seat: number }[];
  holeCount: number;
  /** Double Board — dôkaz to musí niesť, inak by overenie rozdávalo boardy po starom. */
  doubleBoard?: boolean;
}

/**
 * Overiteľné miešanie pre jeden stôl. Hráči posielajú odtlačok semienka vopred (`commit`); pri zmrazení kola sa
 * odtlačky presunú do kola a hráč musí pre ďalšie kolo poslať nový. Semienko, ktoré nepríde do `deadline` alebo nesedí
 * s odtlačkom, do miešania nevstúpi a v dôkaze je verejne uvedené v `excluded`.
 */
export class FairDealer {
  private readonly commits = new Map<string, string>();
  private round: FairRound | null = null;
  private readonly proofs: FairProof[] = [];

  constructor(
    private readonly table: string,
    private readonly now: () => number = Date.now,
  ) {}

  commit(playerId: string, commitment: unknown): { ok: true } | { ok: false; error: string } {
    if (!isFairHex(commitment)) {
      return { ok: false, error: 'Neplatný odtlačok semienka' };
    }
    this.commits.set(playerId, commitment);
    return { ok: true };
  }

  forget(playerId: string): void {
    this.commits.delete(playerId);
  }

  /** Zmrazí kolo, ak ešte nie je: prispievajú pripojení hráči, ktorí môžu dostať karty a majú poslaný odtlačok. */
  ensureRound(contributors: string[]): FairRound {
    if (this.round) {
      return this.round;
    }
    const commitments: Record<string, string> = {};
    for (const playerId of contributors) {
      const commitment = this.commits.get(playerId);
      if (commitment) {
        commitments[playerId] = commitment;
        this.commits.delete(playerId);
      }
    }
    const serverSeed = newSeed();
    const createdAt = this.now();
    this.round = {
      roundId: randomBytes(8).toString('hex'),
      serverSeed,
      serverCommit: commitOf(serverSeed),
      commitments,
      seeds: {},
      createdAt,
      deadline: createdAt + FAIR_REVEAL_MS,
    };
    return this.round;
  }

  reveal(playerId: string, roundId: unknown, seed: unknown): { ok: true } | { ok: false; error: string } {
    const round = this.round;
    if (!round || round.roundId !== roundId) {
      return { ok: false, error: 'Toto kolo miešania už neplatí' };
    }
    const commitment = round.commitments[playerId];
    if (!commitment) {
      return { ok: false, error: 'V tomto kole miešania nemáš odtlačok' };
    }
    if (round.seeds[playerId]) {
      return { ok: true };
    }
    if (!isFairHex(seed) || commitOf(seed) !== commitment) {
      return { ok: false, error: 'Semienko nesedí s odtlačkom' };
    }
    round.seeds[playerId] = seed;
    return { ok: true };
  }

  /** null = kolo nie je; inak či sa už dá rozdať (všetci poslali semienko alebo vypršal čas) a dokedy čakať. */
  readiness(): { ready: boolean; deadline: number } | null {
    const round = this.round;
    if (!round) {
      return null;
    }
    const complete = Object.keys(round.commitments).every((playerId) => round.seeds[playerId]);
    return { ready: complete || this.now() >= round.deadline, deadline: round.deadline };
  }

  /** Použije kolo na rozdanú ruku: vráti balíček a zapíše dôkaz. */
  deal(hand: DealtHand): { deck: Card[]; proof: FairProof } {
    const round = this.round ?? this.ensureRound([]);
    this.round = null;
    const deck = deriveDeck({ table: this.table, roundId: round.roundId, serverSeed: round.serverSeed, seeds: round.seeds });
    const proof: FairProof = {
      v: FAIR_VERSION,
      table: this.table,
      roundId: round.roundId,
      handNumber: hand.handNumber,
      at: this.now(),
      serverCommit: round.serverCommit,
      serverSeed: round.serverSeed,
      commitments: { ...round.commitments },
      seeds: { ...round.seeds },
      excluded: Object.keys(round.commitments).filter((playerId) => !round.seeds[playerId]),
      dealerSeat: hand.dealerSeat,
      seats: hand.seats.map(({ id, seat }) => ({ id, seat })),
      holeCount: hand.holeCount,
      ...(hand.doubleBoard ? { doubleBoard: true as const } : {}),
    };
    this.proofs.push(proof);
    if (this.proofs.length > MAX_HISTORY_HANDS) {
      this.proofs.splice(0, this.proofs.length - MAX_HISTORY_HANDS);
    }
    return { deck, proof };
  }

  view(viewerId: string): FairStateView {
    const round = this.round;
    return {
      committed: this.commits.has(viewerId),
      round: round
        ? { roundId: round.roundId, serverCommit: round.serverCommit, commitments: { ...round.commitments }, revealed: Object.keys(round.seeds), deadline: round.deadline }
        : null,
    };
  }

  /** Dôkazy pre hráčov; semienko servera len keď `revealSeeds` (hra skončila). */
  publicProofs(revealSeeds: boolean): FairProof[] {
    return this.proofs.map((proof) => ({ ...proof, serverSeed: revealSeeds ? proof.serverSeed : null }));
  }

  /** Zmrazené kolo, ktoré ešte nepoužila žiadna ruka (použije ho najbližšia). */
  pendingRoundId(): string | null {
    return this.round?.roundId ?? null;
  }

  lastDealtAt(): number | null {
    return this.proofs.at(-1)?.at ?? null;
  }

  toPersisted(): PersistedFair {
    return { round: this.round ? { ...this.round } : null, proofs: this.proofs.map((proof) => ({ ...proof })) };
  }

  restore(persisted: PersistedFair | undefined): void {
    if (!persisted) {
      return;
    }
    // Po reštarte servera sa hráči pripájajú niekoľko sekúnd — dostanú čas poslať semienko do obnoveného kola.
    this.round = persisted.round ? { ...persisted.round, deadline: Math.max(persisted.round.deadline, this.now() + RESTORE_GRACE_MS) } : null;
    this.proofs.splice(0, this.proofs.length, ...(persisted.proofs ?? []).slice(-MAX_HISTORY_HANDS));
  }
}
