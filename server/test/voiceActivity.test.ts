import { describe, expect, it } from 'vitest';
import { SPEAK_HOLD_MS, SPEAK_OFF_LEVEL, SPEAK_ON_LEVEL, nextSpeakState, rmsLevel } from '../../client/src/voiceLevel';

const quiet = { speaking: false, lastLoudAt: 0 };

describe('rmsLevel', () => {
  it('is zero for silence and for an empty buffer', () => {
    expect(rmsLevel(new Uint8Array(512).fill(128))).toBe(0);
    expect(rmsLevel(new Uint8Array(0))).toBe(0);
  });

  it('measures a full-scale square wave as 1', () => {
    const samples = Uint8Array.from({ length: 512 }, (_, index) => (index % 2 ? 0 : 255));
    expect(rmsLevel(samples)).toBeCloseTo(1, 1);
  });
});

describe('nextSpeakState', () => {
  it('starts speaking only above the upper threshold', () => {
    expect(nextSpeakState(quiet, SPEAK_ON_LEVEL - 0.001, 1000).speaking).toBe(false);
    expect(nextSpeakState(quiet, SPEAK_ON_LEVEL, 1000)).toEqual({ speaking: true, lastLoudAt: 1000 });
  });

  it('keeps speaking between the thresholds (no flicker)', () => {
    const speaking = { speaking: true, lastLoudAt: 1000 };
    expect(nextSpeakState(speaking, SPEAK_OFF_LEVEL, 5000)).toEqual({ speaking: true, lastLoudAt: 5000 });
  });

  it('holds through a short pause and stops after the hold time', () => {
    const speaking = { speaking: true, lastLoudAt: 1000 };
    expect(nextSpeakState(speaking, 0, 1000 + SPEAK_HOLD_MS - 1).speaking).toBe(true);
    expect(nextSpeakState(speaking, 0, 1000 + SPEAK_HOLD_MS).speaking).toBe(false);
  });
});
