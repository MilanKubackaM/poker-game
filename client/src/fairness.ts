import { useEffect, useRef } from 'react';
import type { FairExport, FairHandRecord, FairProofsResponse, FairRoundRecord } from '../../shared/fairness';
import type { Card, TableStateView } from '../../shared/types';
import { emit } from './socket';

/**
 * Overiteľné miešanie na strane hráča: prehliadač vopred pošle odtlačok (SHA-256) náhodného semienka, semienko odhalí,
 * až keď vidí zmrazený zoznam odtlačkov kola, a všetko, čo videl, si zapíše lokálne. Z týchto záznamov a dôkazov
 * servera overí skript `tools/verify-fairness.ts`, že balíček nikto nenastavil.
 */

const MAX_RECORDS = 400;
/** Nepoužité semienka (odtlačok poslaný, kolo ešte nebolo) — viac ich naraz nevznikne. */
const MAX_UNREVEALED = 8;

interface FairLocal {
  /** odtlačok → semienko, kým sa neodhalí */
  seeds: Record<string, string>;
  rounds: FairRoundRecord[];
  hands: FairHandRecord[];
}

function storageKey(code: string, playerId: string): string {
  return `poker.fair.v1.${code}.${playerId}`;
}

function load(code: string, playerId: string): FairLocal {
  try {
    const raw = localStorage.getItem(storageKey(code, playerId));
    const parsed = raw ? (JSON.parse(raw) as Partial<FairLocal>) : {};
    return { seeds: parsed.seeds ?? {}, rounds: parsed.rounds ?? [], hands: parsed.hands ?? [] };
  } catch {
    return { seeds: {}, rounds: [], hands: [] };
  }
}

function save(code: string, playerId: string, data: FairLocal): void {
  try {
    localStorage.setItem(storageKey(code, playerId), JSON.stringify({ ...data, rounds: data.rounds.slice(-MAX_RECORDS), hands: data.hands.slice(-MAX_RECORDS) }));
  } catch {
    // Plné alebo zakázané úložisko: miešanie funguje ďalej, len tento prehliadač nebude mať čo overiť.
  }
}

export function fairSupported(): boolean {
  return typeof crypto !== 'undefined' && !!crypto.subtle && typeof crypto.getRandomValues === 'function';
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function newSeed(): Promise<{ seed: string; commitment: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return { seed: toHex(bytes), commitment: toHex(digest) };
}

function commitMatches(record: FairRoundRecord, playerId: string, commitment: string): boolean {
  return record.commitments[playerId] === commitment;
}

function sameCards(left: Card[], right: Card[]): boolean {
  return left.length === right.length && left.every((card, index) => card === right[index]);
}

/** Zapíše, čo hráč vidí z rozdanej ruky; prvý záznam (miesta, dealer, celé karty) sa už neprepisuje. */
function recordHand(data: FairLocal, view: TableStateView): boolean {
  const hand = view.hand;
  if (!hand?.fairRoundId) {
    return false;
  }
  const me = view.players.find((player) => player.id === view.youId);
  const shown: Record<string, Card[]> = {};
  for (const player of view.players) {
    if (player.id !== view.youId && player.cards.length > 0 && player.cards.every((card) => card !== null)) {
      shown[player.id] = player.cards as Card[];
    }
  }
  if (view.lastResult?.handNumber === hand.handNumber) {
    Object.assign(shown, view.lastResult.revealed);
    delete shown[view.youId];
  }
  const rabbit = view.rabbit?.handNumber === hand.handNumber ? view.rabbit.cards : [];
  let record = data.hands.find((entry) => entry.roundId === hand.fairRoundId);
  if (!record) {
    record = {
      handNumber: hand.handNumber,
      roundId: hand.fairRoundId,
      dealerSeat: hand.dealerSeat,
      seats: view.players.filter((player) => player.cards.length > 0).map((player) => ({ id: player.id, seat: player.seat })),
      hole: (me?.cards ?? []).filter((card): card is Card => card !== null),
      board: [],
      extraBoards: [],
      runoutBase: 0,
      secondBoard: [],
      shown: {},
      rabbit: [],
    };
    data.hands.push(record);
  }
  const before = JSON.stringify(record);
  if (hand.board.length > record.board.length) {
    record.board = [...hand.board];
  }
  // Double Board: spodný board sa zapisuje rovnako ako vrchný (staršie záznamy pole nemajú).
  if (hand.secondBoard && hand.secondBoard.length > (record.secondBoard?.length ?? 0)) {
    record.secondBoard = [...hand.secondBoard];
  }
  if (hand.extraBoards?.length) {
    record.extraBoards = hand.extraBoards.map((board) => [...board]);
    record.runoutBase = hand.runoutBase ?? 0;
  }
  for (const [playerId, cards] of Object.entries(shown)) {
    if (!record.shown[playerId] || !sameCards(record.shown[playerId], cards)) {
      record.shown[playerId] = [...cards];
    }
  }
  if (rabbit.length > record.rabbit.length) {
    record.rabbit = [...rabbit];
  }
  return JSON.stringify(record) !== before;
}

/** Posiela odtlačky a semienka a zapisuje lokálne záznamy pre overenie. */
export function useFairShuffle(view: TableStateView | null, connected: boolean): void {
  const busy = useRef(new Set<string>());
  /** Kolá, ktoré server potvrdil; po novom pripojení (server mohol reštartovať) sa zabudnú. */
  const revealed = useRef(new Set<string>());
  useEffect(() => {
    revealed.current.clear();
  }, [connected]);
  useEffect(() => {
    if (!view || !connected || !fairSupported()) {
      return;
    }
    const { code, youId } = view;
    const data = load(code, youId);
    let dirty = recordHand(data, view);
    const round = view.fair.round;
    const mine = round?.commitments[youId];
    const revealKey = `reveal:${round?.roundId}`;
    // Po reštarte servera môže v obnovenom kole chýbať už poslané semienko — pošle sa znova zo záznamu kola.
    const seed = mine ? (data.seeds[mine] ?? data.rounds.find((entry) => entry.roundId === round?.roundId && commitMatches(entry, youId, mine))?.seed) : undefined;
    if (round && mine && seed && !round.revealed.includes(youId) && !busy.current.has(revealKey) && !revealed.current.has(round.roundId)) {
      if (!data.rounds.some((entry) => entry.roundId === round.roundId)) {
        // Zápis pred odoslaním: dôkaz o tom, aký zoznam odtlačkov prehliadač videl pred odhalením semienka.
        data.rounds.push({ roundId: round.roundId, serverCommit: round.serverCommit, commitments: { ...round.commitments }, seed, sentAt: Date.now() });
        save(code, youId, data);
      }
      busy.current.add(revealKey);
      void emit('fair:reveal', { roundId: round.roundId, seed }).then((response) => {
        busy.current.delete(revealKey);
        if (response.ok) {
          revealed.current.add(round.roundId);
          const latest = load(code, youId);
          delete latest.seeds[mine];
          save(code, youId, latest);
        }
      });
    }
    if (!view.fair.committed && !busy.current.has('commit')) {
      busy.current.add('commit');
      void newSeed().then(async ({ seed, commitment }) => {
        const latest = load(code, youId);
        latest.seeds[commitment] = seed;
        const keys = Object.keys(latest.seeds);
        for (const stale of keys.slice(0, Math.max(0, keys.length - MAX_UNREVEALED))) {
          delete latest.seeds[stale];
        }
        save(code, youId, latest);
        await emit('fair:commit', { commitment });
        busy.current.delete('commit');
      });
    }
    if (dirty) {
      save(code, youId, data);
    }
  }, [view, connected]);
}

/** Lokálne záznamy + dôkazy servera v jednom súbore pre `tools/verify-fairness.ts`. */
export async function exportFairness(code: string, playerId: string): Promise<{ file: FairExport; revealed: boolean; revealAt: number | null } | { error: string }> {
  const response = await emit<FairProofsResponse>('fair:proofs');
  if (!response.ok || !response.data) {
    return { error: response.error ?? 'Dôkazy sa nepodarilo stiahnuť' };
  }
  const local = load(code, playerId);
  return {
    file: {
      format: 'poker-night-fairness-export',
      version: 1,
      table: code,
      playerId,
      exportedAt: Date.now(),
      rounds: local.rounds,
      hands: local.hands,
      proofs: response.data.proofs,
      pendingRoundId: response.data.pendingRoundId,
    },
    revealed: response.data.revealed,
    revealAt: response.data.revealAt,
  };
}
