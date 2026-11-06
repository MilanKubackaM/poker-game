/**
 * Čistá logika mesh siete (bez DOM a WebRTC) — roly, relácie, buffer signálov a rozhodnutia watchdogu.
 * Testuje sa v `server/test/mesh.test.ts` (node), preto tu nesmú byť žiadne typy z DOM.
 */
import type { RtcPayload } from '../../../shared/types';

/** Ako často watchdog kontroluje spojenia. */
export const WATCHDOG_MS = 3000;
/** Spojenie, ktoré nie je `connected` dlhšie ako toto, sa nadviaže znova (nová relácia). */
export const STUCK_MS = 12_000;
/** `disconnected` dlhšie ako toto → ICE restart (prehliadač sám čaká až ~30 s na `failed`). */
export const DISCONNECTED_RESTART_MS = 5000;
/** Zvuk netečie, hoci by mal (mikrofón je zapnutý), dlhšie ako toto → nová relácia. */
export const SILENT_MS = 10_000;
/** Najkratší odstup dvoch obnov spojenia s tým istým hráčom. */
export const RECOVERY_MIN_MS = 5000;
/** Strop odstupu pri opakovaných neúspešných obnovách (exponenciálne čakanie). */
export const RECOVERY_MAX_MS = 60_000;
/** Spojenie, ktoré je takto dlho v poriadku, vynuluje počítadlo neúspešných obnov. */
export const HEALTHY_MS = 20_000;
/** Signál čaká v bufferi najviac takto dlho (potom je zastaraný — ponuku aj tak zopakuje watchdog). */
export const SIGNAL_MAX_AGE_MS = 10_000;
/** Najviac signálov v bufferi (kandidáti chodia v dávkach, 8 hráčov × ~10 kandidátov). */
export const SIGNAL_BUFFER_CAP = 300;

/** Ponuku posiela vždy strana s menším socket id — obe strany to vypočítajú rovnako, ponuky sa nikdy nezrazia. */
export function isOfferer(selfId: string, peerId: string): boolean {
  return selfId < peerId;
}

let sessionCounter = 0;

/** Jednoznačné id relácie (jedno `RTCPeerConnection`); nie je tajné, stačí aby sa neopakovalo. */
export function newSessionId(): string {
  sessionCounter = (sessionCounter + 1) % 1_000_000;
  return `${Date.now().toString(36)}${sessionCounter.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Buffer signálov
// ---------------------------------------------------------------------------------------------------------------------

export interface BufferedSignal {
  from: string;
  data: RtcPayload;
  at: number;
}

/**
 * Signály, ktoré prišli skôr, než ich vie mesh spracovať (stôl sa ešte nevykreslil, hráč ešte nie je v stave stola).
 * Drží sa poradie príchodu; staré a nadpočetné sa zahodia.
 */
export class SignalBuffer {
  private items: BufferedSignal[] = [];

  constructor(
    private readonly maxAgeMs = SIGNAL_MAX_AGE_MS,
    private readonly cap = SIGNAL_BUFFER_CAP,
  ) {}

  get size(): number {
    return this.items.length;
  }

  push(from: string, data: RtcPayload, now: number): void {
    this.prune(now);
    this.items.push({ from, data, at: now });
    if (this.items.length > this.cap) {
      this.items.splice(0, this.items.length - this.cap);
    }
  }

  has(from: string, now: number): boolean {
    this.prune(now);
    return this.items.some((item) => item.from === from);
  }

  /** Vyberie (a odstráni) čerstvé signály, ktoré vyhovujú podmienke, v poradí príchodu. */
  take(now: number, accept: (from: string) => boolean): BufferedSignal[] {
    this.prune(now);
    const taken: BufferedSignal[] = [];
    const kept: BufferedSignal[] = [];
    for (const item of this.items) {
      (accept(item.from) ? taken : kept).push(item);
    }
    this.items = kept;
    return taken;
  }

  clear(): void {
    this.items = [];
  }

  private prune(now: number): void {
    const firstFresh = this.items.findIndex((item) => now - item.at <= this.maxAgeMs);
    if (firstFresh === -1) {
      this.items = [];
    } else if (firstFresh > 0) {
      this.items.splice(0, firstFresh);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Relácie
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Čo spraví odpovedajúci s prichádzajúcou ponukou: rovnaká relácia = ICE restart na existujúcom spojení,
 * iná relácia = zahodiť staré spojenie a vytvoriť čisté.
 */
export function offerAction(currentSession: string | null, incomingSession: string): 'same' | 'replace' {
  return currentSession === incomingSession ? 'same' : 'replace';
}

/** Odpoveď a kandidáti sa prijmú len pre aktuálnu reláciu — staršie sú zvyšky po zahodenom spojení. */
export function belongsToSession(currentSession: string | null, incomingSession: string): boolean {
  return currentSession !== null && currentSession === incomingSession;
}

// ---------------------------------------------------------------------------------------------------------------------
// Obmedzenie obnov (rate-limit + exponenciálne čakanie)
// ---------------------------------------------------------------------------------------------------------------------

export class RecoveryLimiter {
  private lastAt = Number.NEGATIVE_INFINITY;
  private failures = 0;

  constructor(
    private readonly minMs = RECOVERY_MIN_MS,
    private readonly maxMs = RECOVERY_MAX_MS,
  ) {}

  /** Počet obnov po sebe bez toho, aby spojenie medzitým bolo dlhšie v poriadku. */
  get attempts(): number {
    return this.failures;
  }

  /** Najskorší čas ďalšej obnovy: 5 s, po opakovaných zlyhaniach 10, 20, 40, 60 s. */
  nextAllowedAt(): number {
    const wait = this.failures <= 1 ? this.minMs : Math.min(this.maxMs, this.minMs * 2 ** (this.failures - 1));
    return this.lastAt + wait;
  }

  canAttempt(now: number): boolean {
    return now >= this.nextAllowedAt();
  }

  /** Zaznamená obnovu, ak je povolená; vráti, či sa smie spraviť. */
  tryAttempt(now: number): boolean {
    if (!this.canAttempt(now)) {
      return false;
    }
    this.lastAt = now;
    this.failures += 1;
    return true;
  }

  /** Bežný začiatok spojenia (nie obnova) — tiež dodrží minimálny odstup, ale nezvyšuje čakanie. */
  noteStart(now: number): void {
    this.lastAt = Math.max(this.lastAt, now);
  }

  /** Spojenie je dlhšie v poriadku — ďalšia obnova už nebude čakať dlhšie. */
  markHealthy(): void {
    this.failures = 0;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Tok zvuku (počítadlá paketov z getStats)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Sleduje, či rastie počítadlo paketov zvuku, keď by malo (mikrofón zapnutý). `since` = odkedy čakáme na rast —
 * posunie sa pri každom raste aj pri začiatku očakávania (zapnutie mikrofónu, nové spojenie), takže sa nemerá ticho
 * pred tým, než mohol zvuk vôbec začať tiecť.
 */
export interface FlowState {
  expected: boolean;
  packets: number | null;
  since: number;
}

export function initialFlow(now: number): FlowState {
  return { expected: false, packets: null, since: now };
}

export function trackFlow(previous: FlowState, packets: number | null, expected: boolean, now: number): FlowState {
  if (!expected) {
    return { expected: false, packets, since: now };
  }
  if (!previous.expected) {
    return { expected: true, packets, since: now };
  }
  const grew = packets !== null && (previous.packets === null || packets > previous.packets);
  // Pokles počítadla = nový prijímač/odosielač (napr. iná relácia) — berieme ako nový začiatok.
  const restarted = packets !== null && previous.packets !== null && packets < previous.packets;
  return { expected: true, packets, since: grew || restarted ? now : previous.since };
}

/** Zvuk mal tiecť, ale počítadlo nerástlo dlhšie ako `SILENT_MS`. */
export function flowStalled(flow: FlowState, now: number): boolean {
  return flow.expected && now - flow.since > SILENT_MS;
}

/** Posunie všetky časové značky na `now` — po zamrznutí karty (telefón na pozadí) by inak hneď všetko vyzeralo zaseknuté. */
export function rebaseFlow(flow: FlowState, now: number): FlowState {
  return { ...flow, since: now };
}

// ---------------------------------------------------------------------------------------------------------------------
// Watchdog
// ---------------------------------------------------------------------------------------------------------------------

export type MeshRole = 'offerer' | 'answerer';
export type LinkConnectionState = 'new' | 'connecting' | 'connected' | 'disconnected' | 'failed' | 'closed';

export interface LinkSnapshot {
  role: MeshRole;
  /** Existuje spojenie (relácia)? Odpovedajúci ho nemá, kým nepríde ponuka. */
  hasSession: boolean;
  state: LinkConnectionState;
  /** Odkedy spojenie nie je `connected` (začiatok relácie / čakania na ponuku, alebo strata spojenia). */
  notConnectedSince: number;
  /** Odkedy je ICE `disconnected` (null = nie je). */
  disconnectedSince: number | null;
  /** Kedy bol v tejto relácii posledný ICE restart (null = nebol). */
  iceRestartAt: number | null;
  inbound: FlowState;
  outbound: FlowState;
  /** Karta je na pozadí — ticho zvuku sa nevyhodnocuje (mobil uspí mikrofón aj prehrávanie). */
  hidden: boolean;
}

export type RecoveryReason = 'stuck' | 'failed' | 'silent' | 'silent-out';
export type WatchdogDecision = { kind: 'none' } | { kind: 'ice-restart' } | { kind: 'recover'; reason: RecoveryReason };

const NONE: WatchdogDecision = { kind: 'none' };

/**
 * Čo treba so spojením spraviť. `recover` = ponúkajúci začne novú reláciu, odpovedajúci pošle `reset`
 * (obmedzenie počtu obnov rieši volajúci cez `RecoveryLimiter`).
 */
export function decide(link: LinkSnapshot, now: number): WatchdogDecision {
  if (link.state === 'failed') {
    return { kind: 'recover', reason: 'failed' };
  }
  if (link.state !== 'connected') {
    if (now - link.notConnectedSince > STUCK_MS) {
      return { kind: 'recover', reason: 'stuck' };
    }
    if (
      link.role === 'offerer' &&
      link.hasSession &&
      link.state === 'disconnected' &&
      link.disconnectedSince !== null &&
      now - link.disconnectedSince > DISCONNECTED_RESTART_MS &&
      (link.iceRestartAt === null || link.iceRestartAt < link.disconnectedSince)
    ) {
      return { kind: 'ice-restart' };
    }
    return NONE;
  }
  if (link.hidden) {
    return NONE;
  }
  if (flowStalled(link.inbound, now)) {
    return { kind: 'recover', reason: 'silent' };
  }
  if (flowStalled(link.outbound, now)) {
    return { kind: 'recover', reason: 'silent-out' };
  }
  return NONE;
}

/** Spojenie je teraz v poriadku (pripojené a zvuk tečie, kde má). */
export function isHealthy(link: LinkSnapshot, now: number): boolean {
  return link.state === 'connected' && !flowStalled(link.inbound, now) && !flowStalled(link.outbound, now);
}

/**
 * Ponúkajúci dostal `reset` (žiadosť o novú ponuku). Relácia mladšia ako minimálny odstup sa ignoruje — ponuka môže byť
 * práve na ceste (kríženie s `reset` po zapnutí mesh). Inak sa obnova spraví hneď, alebo keď to dovolí obmedzenie.
 */
export function resetAction(sessionStartedAt: number | null, limiter: RecoveryLimiter, now: number): 'ignore' | 'now' | 'later' {
  if (sessionStartedAt !== null && now - sessionStartedAt < RECOVERY_MIN_MS) {
    return 'ignore';
  }
  return limiter.canAttempt(now) ? 'now' : 'later';
}
