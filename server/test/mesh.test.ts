import { describe, expect, it } from 'vitest';
import {
  DISCONNECTED_RESTART_MS,
  HEALTHY_MS,
  RECOVERY_MAX_MS,
  RECOVERY_MIN_MS,
  RecoveryLimiter,
  SIGNAL_MAX_AGE_MS,
  SILENT_MS,
  STUCK_MS,
  SignalBuffer,
  belongsToSession,
  decide,
  flowStalled,
  initialFlow,
  isHealthy,
  isOfferer,
  newSessionId,
  offerAction,
  rebaseFlow,
  resetAction,
  trackFlow,
  type LinkSnapshot,
} from '../../client/src/mesh/logic';
import { sanitizeNetSample } from '../../shared/netstats';
import type { RtcPayload } from '../../shared/types';

const offer = (session: string): RtcPayload => ({ kind: 'description', session, description: { type: 'offer', sdp: 'v=0' } });
const candidate = (session: string): RtcPayload => ({ kind: 'candidate', session, candidate: { candidate: 'candidate:1' } });

function link(patch: Partial<LinkSnapshot> = {}): LinkSnapshot {
  return {
    role: 'offerer',
    hasSession: true,
    state: 'connected',
    notConnectedSince: 0,
    disconnectedSince: null,
    iceRestartAt: null,
    inbound: initialFlow(0),
    outbound: initialFlow(0),
    hidden: false,
    ...patch,
  };
}

describe('mesh roly a relácie', () => {
  it('práve jedna strana dvojice je ponúkajúca', () => {
    expect(isOfferer('aaa', 'bbb')).toBe(true);
    expect(isOfferer('bbb', 'aaa')).toBe(false);
    for (const [left, right] of [['x1', 'X1'], ['Abc_-1', 'Abc_-2'], ['k', 'kk']]) {
      expect(isOfferer(left, right)).not.toBe(isOfferer(right, left));
    }
  });

  it('id relácie sa neopakuje', () => {
    const ids = new Set(Array.from({ length: 500 }, () => newSessionId()));
    expect(ids.size).toBe(500);
  });

  it('ponuka s inou reláciou nahradí spojenie, s rovnakou je ICE restart', () => {
    expect(offerAction(null, 's1')).toBe('replace');
    expect(offerAction('s1', 's2')).toBe('replace');
    expect(offerAction('s1', 's1')).toBe('same');
  });

  it('kandidáti a odpoveď inej relácie sa zahodia', () => {
    expect(belongsToSession('s1', 's1')).toBe(true);
    expect(belongsToSession('s1', 's0')).toBe(false);
    expect(belongsToSession(null, 's1')).toBe(false);
  });
});

describe('buffer signálov', () => {
  it('prehrá signály v poradí príchodu a len pre známych odosielateľov', () => {
    const buffer = new SignalBuffer();
    buffer.push('a', offer('s1'), 0);
    buffer.push('b', offer('t1'), 1);
    buffer.push('a', candidate('s1'), 2);
    const taken = buffer.take(3, (from) => from === 'a');
    expect(taken.map((item) => item.data.kind)).toEqual(['description', 'candidate']);
    expect(buffer.size).toBe(1);
    expect(buffer.has('b', 3)).toBe(true);
    expect(buffer.has('a', 3)).toBe(false);
    expect(buffer.has('b', SIGNAL_MAX_AGE_MS + 2)).toBe(false);
  });

  it('zahodí signály staršie ako 10 s', () => {
    const buffer = new SignalBuffer();
    buffer.push('a', offer('s1'), 0);
    buffer.push('a', candidate('s1'), 5000);
    const taken = buffer.take(SIGNAL_MAX_AGE_MS + 1, () => true);
    expect(taken).toHaveLength(1);
    expect(taken[0].data.kind).toBe('candidate');
  });

  it('pri preplnení zahodí najstaršie', () => {
    const buffer = new SignalBuffer(SIGNAL_MAX_AGE_MS, 3);
    for (let index = 0; index < 5; index++) {
      buffer.push('a', offer(`s${index}`), index);
    }
    const taken = buffer.take(10, () => true);
    expect(taken.map((item) => (item.data.kind === 'description' ? item.data.session : ''))).toEqual(['s2', 's3', 's4']);
  });
});

describe('obmedzenie obnov', () => {
  it('dodrží minimálny odstup a exponenciálne čakanie so stropom', () => {
    const limiter = new RecoveryLimiter();
    expect(limiter.tryAttempt(0)).toBe(true);
    expect(limiter.tryAttempt(RECOVERY_MIN_MS - 1)).toBe(false);
    let at = 0;
    const gaps: number[] = [];
    for (let attempt = 0; attempt < 7; attempt++) {
      const next = limiter.nextAllowedAt();
      gaps.push(next - at);
      at = next;
      expect(limiter.tryAttempt(at)).toBe(true);
    }
    expect(gaps).toEqual([5000, 10_000, 20_000, 40_000, RECOVERY_MAX_MS, RECOVERY_MAX_MS, RECOVERY_MAX_MS]);
  });

  it('zdravé spojenie vynuluje čakanie, minimálny odstup ostáva', () => {
    const limiter = new RecoveryLimiter();
    limiter.tryAttempt(0);
    limiter.tryAttempt(5000);
    limiter.tryAttempt(15_000);
    limiter.markHealthy();
    expect(limiter.nextAllowedAt()).toBe(15_000 + RECOVERY_MIN_MS);
  });

  it('bežný začiatok spojenia nezvyšuje čakanie', () => {
    const limiter = new RecoveryLimiter();
    limiter.noteStart(1000);
    expect(limiter.canAttempt(1000 + RECOVERY_MIN_MS - 1)).toBe(false);
    expect(limiter.canAttempt(1000 + RECOVERY_MIN_MS)).toBe(true);
    expect(limiter.attempts).toBe(0);
  });

  it('reset od odpovedajúceho: mladú reláciu ignoruje (ponuka môže byť na ceste), inak hneď alebo neskôr', () => {
    const limiter = new RecoveryLimiter();
    expect(resetAction(10_000, limiter, 12_000)).toBe('ignore');
    expect(resetAction(10_000, limiter, 20_000)).toBe('now');
    expect(resetAction(null, limiter, 0)).toBe('now');
    limiter.tryAttempt(20_000);
    limiter.tryAttempt(25_000);
    expect(resetAction(0, limiter, 30_000)).toBe('later');
  });
});

describe('tok zvuku', () => {
  it('meria ticho až od začiatku očakávania (zapnutý mikrofón)', () => {
    let flow = initialFlow(0);
    flow = trackFlow(flow, 0, false, 1000);
    flow = trackFlow(flow, 0, true, 60_000);
    expect(flowStalled(flow, 60_000 + SILENT_MS)).toBe(false);
    flow = trackFlow(flow, 0, true, 60_000 + SILENT_MS + 1);
    expect(flowStalled(flow, 60_000 + SILENT_MS + 1)).toBe(true);
  });

  it('rast počítadla ticho ruší, chýbajúca štatistika nie', () => {
    let flow = trackFlow(initialFlow(0), null, true, 0);
    flow = trackFlow(flow, null, true, 6000);
    flow = trackFlow(flow, null, true, 11_000);
    expect(flowStalled(flow, 11_000)).toBe(true);
    flow = trackFlow(flow, 50, true, 12_000);
    expect(flowStalled(flow, 12_000)).toBe(false);
    flow = trackFlow(flow, 50, true, 21_000);
    expect(flowStalled(flow, 21_000)).toBe(false);
    flow = trackFlow(flow, 50, true, 23_000);
    expect(flowStalled(flow, 23_000)).toBe(true);
  });

  it('vypnutý mikrofón (alebo push-to-talk bez klávesu) sa za ticho nepovažuje', () => {
    let flow = trackFlow(initialFlow(0), 10, true, 0);
    flow = trackFlow(flow, 10, false, 30_000);
    expect(flowStalled(flow, 60_000)).toBe(false);
  });

  it('po zamrznutí karty sa ticho meria odznova', () => {
    let flow = trackFlow(initialFlow(0), 10, true, 0);
    flow = rebaseFlow(flow, 120_000);
    expect(flowStalled(flow, 125_000)).toBe(false);
  });
});

describe('watchdog', () => {
  it('pripojené spojenie bez problémov nechá tak', () => {
    expect(decide(link(), 100_000)).toEqual({ kind: 'none' });
  });

  it('zlyhané spojenie obnoví hneď', () => {
    expect(decide(link({ state: 'failed', notConnectedSince: 99_000 }), 100_000)).toEqual({ kind: 'recover', reason: 'failed' });
  });

  it('nepripojené viac ako 12 s = zaseknuté (aj odpovedajúci bez ponuky)', () => {
    expect(decide(link({ state: 'new', notConnectedSince: 0 }), STUCK_MS)).toEqual({ kind: 'none' });
    expect(decide(link({ state: 'new', notConnectedSince: 0 }), STUCK_MS + 1)).toEqual({ kind: 'recover', reason: 'stuck' });
    expect(decide(link({ role: 'answerer', hasSession: false, state: 'new', notConnectedSince: 0 }), STUCK_MS + 1)).toEqual({ kind: 'recover', reason: 'stuck' });
  });

  it('disconnected > 5 s → ICE restart len u ponúkajúceho a len raz za výpadok', () => {
    const disconnected = link({ state: 'disconnected', notConnectedSince: 0, disconnectedSince: 0 });
    expect(decide(disconnected, DISCONNECTED_RESTART_MS)).toEqual({ kind: 'none' });
    expect(decide(disconnected, DISCONNECTED_RESTART_MS + 1)).toEqual({ kind: 'ice-restart' });
    expect(decide({ ...disconnected, role: 'answerer' }, DISCONNECTED_RESTART_MS + 1)).toEqual({ kind: 'none' });
    expect(decide({ ...disconnected, iceRestartAt: 6000 }, 8000)).toEqual({ kind: 'none' });
    expect(decide({ ...disconnected, iceRestartAt: 6000 }, STUCK_MS + 1)).toEqual({ kind: 'recover', reason: 'stuck' });
  });

  it('pripojené, ale zvuk od hráča so zapnutým mikrofónom netečie > 10 s → obnova', () => {
    const inbound = { expected: true, packets: 100, since: 0 };
    expect(decide(link({ inbound }), SILENT_MS)).toEqual({ kind: 'none' });
    expect(decide(link({ inbound }), SILENT_MS + 1)).toEqual({ kind: 'recover', reason: 'silent' });
    expect(decide(link({ outbound: inbound }), SILENT_MS + 1)).toEqual({ kind: 'recover', reason: 'silent-out' });
  });

  it('na pozadí (skrytá karta) sa ticho nevyhodnocuje, zaseknutie áno', () => {
    const inbound = { expected: true, packets: 100, since: 0 };
    expect(decide(link({ inbound, hidden: true }), 60_000)).toEqual({ kind: 'none' });
    expect(decide(link({ state: 'connecting', notConnectedSince: 0, hidden: true }), 60_000)).toEqual({ kind: 'recover', reason: 'stuck' });
  });

  it('zdravé = pripojené a zvuk tečie', () => {
    expect(isHealthy(link(), HEALTHY_MS)).toBe(true);
    expect(isHealthy(link({ state: 'connecting' }), HEALTHY_MS)).toBe(false);
    expect(isHealthy(link({ inbound: { expected: true, packets: 1, since: 0 } }), SILENT_MS + 1)).toBe(false);
  });
});

describe('net:stats udalosti obnovy', () => {
  it('sanitizer prepustí nové druhy udalostí a neznáme zahodí', () => {
    const sample = sanitizeNetSample({
      links: [
        {
          to: 'p1',
          events: [
            { ageMs: 100, kind: 'session' },
            { ageMs: 200, kind: 'reset' },
            { ageMs: 300, kind: 'stuck' },
            { ageMs: 400, kind: 'silent' },
            { ageMs: 500, kind: 'silent-out' },
            { ageMs: 600, kind: 'signal-error' },
            { ageMs: 700, kind: 'nonsense' },
          ],
        },
      ],
    });
    expect(sample?.links[0].events?.map((event) => event.kind)).toEqual(['session', 'reset', 'stuck', 'silent', 'silent-out', 'signal-error']);
  });
});
