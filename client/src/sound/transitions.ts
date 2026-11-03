import type { SeatPlayerView, TableView } from '../../../shared/types';
import { DISCARD_TIMEOUT_SEC } from '../../../shared/constants';
import type { SoundName } from './names';
import type { SoundPreferences } from './preferences';

export interface SoundCue {
  sound: SoundName;
  delayMs: number;
  volume?: number;
}

/** Strop zvukov na jednu zmenu stavu — ani masívna aktualizácia nespustí kakofóniu. */
export const MAX_CUES_PER_TRANSITION = 10;
const DEAL_STAGGER_MS = 85;
const ACTION_STAGGER_MS = 90;
const FLIP_STAGGER_MS = 120;
const TIME_WARNING_MS = 10_000;
/** Zvuk „chips“ (viac žetónov) od tejto sumy v násobkoch big blindu, menej je „chip“. */
const CHIPS_FROM_BB = 3;

/**
 * Identita môjho ťahu: null, ak nie som na ťahu. Mení sa s každým novým ťahom (aj keď sa akcia vráti ku mne
 * v tej istej ulici po navýšení), ale nie pri skrátení termínu počas toho istého ťahu.
 */
export function myTurnKey(view: TableView, youId: string): string | null {
  const hand = view.hand;
  if (!hand || hand.street === 'complete' || hand.street === 'showdown') {
    return null;
  }
  const me = view.players.find((player) => player.id === youId);
  if (!me || !me.inHand || me.sittingOut || me.status === 'folded') {
    return null;
  }
  if (hand.street === 'discard') {
    return me.hasDiscarded ? null : `${hand.handNumber}:discard`;
  }
  if (hand.toActId !== youId) {
    return null;
  }
  const contributed = view.players.reduce((sum, player) => sum + player.totalContributed, 0);
  return `${hand.handNumber}:${hand.street}:${hand.board.length}:${contributed}`;
}

/** Termín, ktorý je pre môj ťah práve „aktuálny“: pri zahadzovaní jeho limit, pri ťahu koniec základného času (bez timebanku). */
function myDeadline(view: TableView): { deadline: number; total: number } | null {
  const hand = view.hand;
  if (!hand) {
    return null;
  }
  if (hand.street === 'discard') {
    return hand.discardDeadline ? { deadline: hand.discardDeadline, total: DISCARD_TIMEOUT_SEC * 1000 } : null;
  }
  const deadline = hand.turnBaseDeadline ?? hand.turnDeadline;
  return deadline ? { deadline, total: view.settings.actionTimeoutSec * 1000 } : null;
}

export interface TimerCue {
  /** Identita zvuku v rámci ťahu — každý zaznie najviac raz. */
  id: string;
  sound: SoundName;
  /** Za koľko ms má zaznieť. */
  delayMs: number;
  volume?: number;
}

export interface TimeWarningPlan {
  /** Identita ťahu. */
  key: string;
  cues: TimerCue[];
}

/** Posledné upozornenie pred koncom celého času (základ + timebank). */
const FINAL_WARNING_MS = 5_000;

/**
 * Časované zvuky môjho ťahu (`now` = odhad času servera):
 * - „cink“ (`turn`) presne vtedy, keď skončí základný čas a začne sa míňať timebank,
 * - `timeWarning`, keď zo všetkého času ostáva ≤ 5 s.
 * Bez `turnBaseDeadline` (starší server) a pri zahadzovaní ostáva pôvodné jedno tiknutie (10 s, najviac 40 % limitu).
 */
export function timeWarningPlan(view: TableView, youId: string, now: number): TimeWarningPlan | null {
  if (view.paused) {
    return null;
  }
  const key = myTurnKey(view, youId);
  const hand = view.hand;
  if (!key || !hand) {
    return null;
  }
  const cues: TimerCue[] = [];
  const base = hand.street === 'discard' ? null : hand.turnBaseDeadline ?? null;
  const end = hand.street === 'discard' ? hand.discardDeadline : hand.turnDeadline;
  if (base && end) {
    if (base - now > 0 && end > base) {
      cues.push({ id: 'base-end', sound: 'turn', delayMs: base - now, volume: 1 });
    }
    const finalAt = end - FINAL_WARNING_MS;
    if (finalAt - now > 0 && finalAt > base + 1000) {
      cues.push({ id: 'final', sound: 'timeWarning', delayMs: finalAt - now });
    }
    return cues.length ? { key, cues } : null;
  }
  const timing = myDeadline(view);
  if (!timing) {
    return null;
  }
  const remaining = timing.deadline - now;
  const threshold = timing.total > 0 ? Math.min(TIME_WARNING_MS, timing.total * 0.4) : TIME_WARNING_MS;
  if (remaining <= 500) {
    return null;
  }
  return { key, cues: [{ id: 'warning', sound: 'timeWarning', delayMs: Math.max(0, remaining - threshold) }] };
}

function hiddenCardCount(player: SeatPlayerView): number {
  return player.cards.filter((card) => card === null).length;
}

/**
 * Ktoré zvuky prehrať pri prechode zo stavu `prev` do `next`. Čistá funkcia — žiadne audio, žiadne časovače.
 * `prev === null` (prvý stav po pripojení) nevracia nič, aby pripojenie/reconnect nespustil salvu zvukov.
 * Upozornenie na dochádzajúci čas tu nie je — rieši ho časovač v hooku cez `timeWarningPlan`.
 */
export function soundsForTransition(prev: TableView | null, next: TableView, youId: string, prefs: SoundPreferences, now: number): SoundCue[] {
  if (!prev || prev === next) {
    return [];
  }
  const effects: SoundCue[] = [];
  let cursor = 0;
  const push = (sound: SoundName, gapMs: number, volume?: number) => {
    effects.push(volume === undefined ? { sound, delayMs: cursor } : { sound, delayMs: cursor, volume });
    cursor += gapMs;
  };

  if (next.phase === 'draw' && next.draw) {
    const revealedBefore = new Set((prev.draw?.slots ?? []).filter((slot) => slot.card !== null).map((slot) => slot.index));
    const revealed = next.draw.slots.filter((slot) => slot.card !== null && !revealedBefore.has(slot.index));
    for (const slot of revealed.slice(0, 4)) {
      push('draw', FLIP_STAGGER_MS, slot.drawnBy === youId ? 1 : 0.75);
    }
  }

  const prevHand = prev.hand;
  const nextHand = next.hand;
  const newHand = !!nextHand && (!prevHand || prevHand.handNumber !== nextHand.handNumber);

  if (nextHand && newHand) {
    const dealt = next.players.filter((player) => player.inHand).length;
    const deals = Math.max(2, Math.min(6, dealt));
    for (let index = 0; index < deals; index++) {
      push('deal', DEAL_STAGGER_MS, 0.8 + 0.2 * ((index + 1) % 2));
    }
  } else if (nextHand && prevHand) {
    const before = new Map(prev.players.map((player) => [player.id, player]));
    const bigBlind = Math.max(1, nextHand.rules.bigBlind);
    const acted = new Set<string>();

    for (const player of next.players) {
      const previous = before.get(player.id);
      if (!previous || !previous.inHand) {
        continue;
      }
      const added = player.totalContributed - previous.totalContributed;
      if (player.status === 'folded' && previous.status !== 'folded') {
        push('fold', ACTION_STAGGER_MS);
      } else if (player.status === 'allin' && previous.status !== 'allin') {
        push('allin', ACTION_STAGGER_MS * 2);
      } else if (added > 0) {
        push(added >= CHIPS_FROM_BB * bigBlind ? 'chips' : 'chip', ACTION_STAGGER_MS);
      } else if (player.lastAction === 'Check' && previous.lastAction !== 'Check') {
        push('check', ACTION_STAGGER_MS);
      } else {
        continue;
      }
      acted.add(player.id);
    }

    // Posledný check v kole: server hneď otvorí ďalšiu ulicu a vynuluje lastAction, takže „Check“ sa nikdy neukáže.
    const actorId = prevHand.toActId;
    if (actorId && !acted.has(actorId) && prevHand.street !== 'discard' && (nextHand.street !== prevHand.street || nextHand.toActId !== actorId)) {
      const actorBefore = before.get(actorId);
      const actorAfter = next.players.find((player) => player.id === actorId);
      if (actorBefore && actorAfter && actorBefore.status === 'active' && actorAfter.status === 'active' && actorAfter.totalContributed === actorBefore.totalContributed) {
        push('check', ACTION_STAGGER_MS);
      }
    }

    const newCards = Math.max(0, nextHand.board.length - prevHand.board.length);
    for (let index = 0; index < newCards; index++) {
      push('flip', FLIP_STAGGER_MS);
    }

    if (nextHand.street === 'showdown' || nextHand.street === 'complete') {
      const revealed = next.players.some((player) => {
        const previous = before.get(player.id);
        return player.id !== youId && !!previous && hiddenCardCount(previous) > 0 && hiddenCardCount(player) < hiddenCardCount(previous);
      });
      if (revealed) {
        push('flip', FLIP_STAGGER_MS, 0.8);
      }
    }
  }

  const result = next.lastResult;
  if (result && result.handNumber !== prev.lastResult?.handNumber) {
    cursor += 150;
    const iWon = result.winners.some((winner) => winner.playerId === youId);
    if (result.bounty) {
      push('bounty', 0, iWon || result.bounty.winnerId === youId ? 1 : 0.75);
    } else if (iWon) {
      push('win', 0);
    } else {
      push('chips', 0, 0.7);
    }
  }

  const cues = prefs.effects ? effects.slice(0, MAX_CUES_PER_TRANSITION - 1) : [];

  if (prefs.turnAlert) {
    const key = myTurnKey(next, youId);
    const timing = myDeadline(next);
    const expired = !!timing && timing.deadline <= now;
    if (key && key !== myTurnKey(prev, youId) && !expired && !next.paused) {
      cues.push({ sound: 'turn', delayMs: newHand ? cursor + 150 : Math.min(cursor, 400) });
    }
  }

  return cues;
}
