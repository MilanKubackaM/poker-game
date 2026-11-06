import type { Ack, JukeboxTrack, JukeboxView } from '../shared/types';
import { JUKEBOX_MAX_DURATION_SEC, JUKEBOX_MAX_QUEUE } from '../shared/constants';
import { cleanTrackTitle, isYouTubeVideoId } from '../shared/jukebox';

/** Rezerva po konci pesničky, kým začne ďalšia — aby ju dohrali aj prehliadače, ktoré sa načítali neskôr. */
export const JUKEBOX_GAP_MS = 1500;

export interface JukeboxWinners {
  handNumber: number;
  playerIds: string[];
}

export interface JukeboxOptions {
  /** Víťazi poslednej dohranej ruky (len tí, ktorí sú ešte pri stole), alebo null. */
  winners: () => JukeboxWinners | null;
  /** Stav sa zmenil — rozposlať stolu. */
  onChange: () => void;
  /** Stôl ešte existuje? Keď nie (expirácia), jukebox sa pri najbližšom časovači sám uprace. */
  isAlive?: () => boolean;
}

type CurrentTrack = JukeboxTrack & { startedAt: number };

/**
 * Jukebox jedného stola — len v pamäti (po reštarte servera je prázdny a vypnutý).
 * Server je hodiny: pesnička hrá od `startedAt`, po jej dĺžke (+ rezerva) časovač pustí ďalšiu z frontu.
 * Preskočiť, pretočiť ani pozastaviť sa nedá — host môže len vypnúť celý jukebox (front sa vyprázdni).
 */
export class Jukebox {
  private enabled = false;
  private current: CurrentTrack | null = null;
  private readonly queue: JukeboxTrack[] = [];
  /** Spotrebované práva „víťaz ruky pridá pesničku“: `číslo ruky:id hráča` (len pre poslednú dohranú ruku). */
  private readonly used = new Set<string>();
  private usedHand = 0;
  private timer: NodeJS.Timeout | null = null;
  private nextId = 1;
  private disposed = false;

  constructor(private readonly options: JukeboxOptions) {}

  view(): JukeboxView {
    return {
      enabled: this.enabled,
      current: this.current ? { ...this.current } : null,
      queue: this.queue.map((track) => ({ ...track })),
      eligibleIds: this.eligibleIds(),
      serverTime: Date.now(),
    };
  }

  setEnabled(enabled: unknown): Ack {
    if (typeof enabled !== 'boolean') {
      return { ok: false, error: 'Neplatná hodnota' };
    }
    if (enabled === this.enabled) {
      return { ok: true };
    }
    this.enabled = enabled;
    if (!enabled) {
      this.clearTimer();
      this.current = null;
      this.queue.length = 0;
    }
    this.options.onChange();
    return { ok: true };
  }

  add(player: { id: string; name: string }, input: { videoId?: unknown; title?: unknown; durationSec?: unknown }): Ack {
    if (!this.enabled) {
      return { ok: false, error: 'Jukebox je vypnutý' };
    }
    const winners = this.winners();
    if (!winners || !winners.playerIds.includes(player.id)) {
      return { ok: false, error: 'Pesničku pridáva víťaz poslednej ruky' };
    }
    if (this.used.has(`${winners.handNumber}:${player.id}`)) {
      return { ok: false, error: 'Za túto výhru si už pesničku pridal' };
    }
    if (this.queue.length >= JUKEBOX_MAX_QUEUE) {
      return { ok: false, error: `Front je plný (${JUKEBOX_MAX_QUEUE}/${JUKEBOX_MAX_QUEUE})` };
    }
    if (!isYouTubeVideoId(input.videoId)) {
      return { ok: false, error: 'Neplatný odkaz na YouTube video' };
    }
    const durationSec = input.durationSec;
    if (typeof durationSec !== 'number' || !Number.isInteger(durationSec) || durationSec < 1) {
      return { ok: false, error: 'Neplatná dĺžka pesničky' };
    }
    if (durationSec > JUKEBOX_MAX_DURATION_SEC) {
      return { ok: false, error: `Pesnička môže mať najviac ${JUKEBOX_MAX_DURATION_SEC / 60} min` };
    }
    const videoId = input.videoId;
    if (this.current?.videoId === videoId || this.queue.some((track) => track.videoId === videoId)) {
      return { ok: false, error: 'Táto pesnička už hrá alebo je vo fronte' };
    }
    this.used.add(`${winners.handNumber}:${player.id}`);
    const track: JukeboxTrack = {
      id: `t${this.nextId++}`,
      videoId,
      title: cleanTrackTitle(input.title),
      durationSec,
      addedById: player.id,
      addedByName: player.name,
    };
    if (this.current) {
      this.queue.push(track);
    } else {
      this.play(track);
    }
    this.options.onChange();
    return { ok: true };
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
  }

  /** Víťazi poslednej ruky; pri novej dohranej ruke zabudne spotrebované práva z predošlej (právo vyprší). */
  private winners(): JukeboxWinners | null {
    const winners = this.options.winners();
    if (winners && winners.handNumber !== this.usedHand) {
      this.usedHand = winners.handNumber;
      this.used.clear();
    }
    return winners;
  }

  private eligibleIds(): string[] {
    const winners = this.winners();
    if (!this.enabled || !winners || this.queue.length >= JUKEBOX_MAX_QUEUE) {
      return [];
    }
    return winners.playerIds.filter((id) => !this.used.has(`${winners.handNumber}:${id}`));
  }

  private play(track: JukeboxTrack): void {
    this.clearTimer();
    const startedAt = Date.now();
    this.current = { ...track, startedAt };
    this.timer = setTimeout(() => this.advance(), track.durationSec * 1000 + JUKEBOX_GAP_MS);
    this.timer.unref?.();
  }

  private advance(): void {
    this.timer = null;
    if (this.disposed) {
      return;
    }
    if (this.options.isAlive && !this.options.isAlive()) {
      this.dispose();
      return;
    }
    const next = this.queue.shift();
    if (next) {
      this.play(next);
    } else {
      this.current = null;
    }
    this.options.onChange();
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
