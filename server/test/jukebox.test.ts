import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JUKEBOX_MAX_DURATION_SEC, JUKEBOX_MAX_QUEUE } from '../../shared/constants';
import { JUKEBOX_FALLBACK_TITLE, JUKEBOX_MAX_TITLE_LENGTH, cleanTrackTitle, parseYouTubeLink } from '../../shared/jukebox';
import { JUKEBOX_GAP_MS, Jukebox, type JukeboxWinners } from '../Jukebox';

/** Platné 11-znakové ID videa podľa poradia. */
function videoId(index: number): string {
  return `video${String(index).padStart(6, '0')}`;
}

function setup(initialWinners: JukeboxWinners | null = { handNumber: 1, playerIds: ['a', 'b'] }) {
  let winners = initialWinners;
  let alive = true;
  const onChange = vi.fn();
  const jukebox = new Jukebox({ winners: () => winners, onChange, isAlive: () => alive });
  return {
    jukebox,
    onChange,
    setWinners: (next: JukeboxWinners | null) => {
      winners = next;
    },
    kill: () => {
      alive = false;
    },
  };
}

const a = { id: 'a', name: 'Anna' };
const b = { id: 'b', name: 'Boris' };
const c = { id: 'c', name: 'Cyril' };

function track(index: number, durationSec = 60) {
  return { videoId: videoId(index), title: `Pesnička ${index}`, durationSec };
}

describe('Jukebox', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-06T20:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('is off by default and the host can switch it on', () => {
    const { jukebox, onChange } = setup();
    expect(jukebox.view().enabled).toBe(false);
    expect(jukebox.view().eligibleIds).toEqual([]);
    expect(jukebox.add(a, track(1)).ok).toBe(false);
    expect(jukebox.setEnabled(true).ok).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(jukebox.view().eligibleIds).toEqual(['a', 'b']);
    expect(jukebox.setEnabled('yes').ok).toBe(false);
  });

  it('lets only winners of the last finished hand add a song', () => {
    const { jukebox, setWinners } = setup();
    jukebox.setEnabled(true);
    expect(jukebox.add(c, track(1))).toEqual({ ok: false, error: 'Pesničku pridáva víťaz poslednej ruky' });
    setWinners(null);
    expect(jukebox.add(a, track(1)).ok).toBe(false);
    expect(jukebox.view().eligibleIds).toEqual([]);
  });

  it('starts a song added to an empty jukebox immediately', () => {
    const { jukebox, onChange } = setup();
    jukebox.setEnabled(true);
    onChange.mockClear();
    expect(jukebox.add(a, track(1, 200)).ok).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(1);
    const view = jukebox.view();
    expect(view.current).toMatchObject({ videoId: videoId(1), title: 'Pesnička 1', durationSec: 200, addedById: 'a', addedByName: 'Anna', startedAt: Date.now() });
    expect(view.queue).toEqual([]);
    expect(view.serverTime).toBe(Date.now());
  });

  it('allows one song per won hand and the right expires with the next finished hand', () => {
    const { jukebox, setWinners } = setup();
    jukebox.setEnabled(true);
    expect(jukebox.add(a, track(1)).ok).toBe(true);
    expect(jukebox.add(a, track(2))).toEqual({ ok: false, error: 'Za túto výhru si už pesničku pridal' });
    expect(jukebox.view().eligibleIds).toEqual(['b']);
    // Ďalšia ruka: vyhral len Cyril — Boris už nepridá, Anna (vyhrala znova) áno.
    setWinners({ handNumber: 2, playerIds: ['c', 'a'] });
    expect(jukebox.view().eligibleIds).toEqual(['c', 'a']);
    expect(jukebox.add(b, track(3)).ok).toBe(false);
    expect(jukebox.add(a, track(2)).ok).toBe(true);
    expect(jukebox.add(c, track(3)).ok).toBe(true);
    expect(jukebox.view().queue.map((item) => item.addedById)).toEqual(['a', 'c']);
  });

  it('limits the waiting queue to JUKEBOX_MAX_QUEUE songs (the playing one not counted)', () => {
    const { jukebox, setWinners } = setup({ handNumber: 1, playerIds: ['p0'] });
    jukebox.setEnabled(true);
    for (let index = 0; index <= JUKEBOX_MAX_QUEUE; index++) {
      setWinners({ handNumber: index + 1, playerIds: [`p${index}`] });
      expect(jukebox.add({ id: `p${index}`, name: `P${index}` }, track(index)).ok).toBe(true);
    }
    expect(jukebox.view().queue).toHaveLength(JUKEBOX_MAX_QUEUE);
    setWinners({ handNumber: 99, playerIds: ['late'] });
    expect(jukebox.view().eligibleIds).toEqual([]);
    expect(jukebox.add({ id: 'late', name: 'Late' }, track(50))).toEqual({ ok: false, error: `Front je plný (${JUKEBOX_MAX_QUEUE}/${JUKEBOX_MAX_QUEUE})` });
  });

  it('advances to the next song after the duration plus a gap and stops when the queue is empty', () => {
    const { jukebox, onChange } = setup();
    jukebox.setEnabled(true);
    jukebox.add(a, track(1, 10));
    jukebox.add(b, track(2, 20));
    onChange.mockClear();
    vi.advanceTimersByTime(10_000 + JUKEBOX_GAP_MS - 1);
    expect(jukebox.view().current?.videoId).toBe(videoId(1));
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    const view = jukebox.view();
    expect(view.current).toMatchObject({ videoId: videoId(2), startedAt: Date.now() });
    expect(view.queue).toEqual([]);
    expect(onChange).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(20_000 + JUKEBOX_GAP_MS);
    expect(jukebox.view().current).toBeNull();
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('switching off stops playback and clears the queue', () => {
    const { jukebox, onChange } = setup();
    jukebox.setEnabled(true);
    jukebox.add(a, track(1));
    jukebox.add(b, track(2));
    expect(jukebox.setEnabled(false).ok).toBe(true);
    const view = jukebox.view();
    expect(view).toMatchObject({ enabled: false, current: null, queue: [], eligibleIds: [] });
    onChange.mockClear();
    vi.advanceTimersByTime(10 * 60_000);
    expect(onChange).not.toHaveBeenCalled();
    // Po znovuzapnutí je prázdny; spotrebované právo za ruku ostáva spotrebované.
    jukebox.setEnabled(true);
    expect(jukebox.view().current).toBeNull();
    expect(jukebox.view().eligibleIds).toEqual([]);
  });

  it('validates the video id, duration and duplicates without consuming the right', () => {
    const { jukebox } = setup();
    jukebox.setEnabled(true);
    expect(jukebox.add(a, { videoId: 'short', title: 'x', durationSec: 60 }).ok).toBe(false);
    expect(jukebox.add(a, { videoId: 'abc def ghi', title: 'x', durationSec: 60 }).ok).toBe(false);
    expect(jukebox.add(a, { videoId: videoId(1), title: 'x', durationSec: 0 }).ok).toBe(false);
    expect(jukebox.add(a, { videoId: videoId(1), title: 'x', durationSec: 12.5 }).ok).toBe(false);
    expect(jukebox.add(a, { videoId: videoId(1), title: 'x', durationSec: '60' }).ok).toBe(false);
    expect(jukebox.add(a, { videoId: videoId(1), title: 'x', durationSec: JUKEBOX_MAX_DURATION_SEC + 1 }).ok).toBe(false);
    expect(jukebox.add(a, { videoId: videoId(1), title: 'x', durationSec: JUKEBOX_MAX_DURATION_SEC }).ok).toBe(true);
    expect(jukebox.add(b, { videoId: videoId(1), title: 'y', durationSec: 60 })).toEqual({ ok: false, error: 'Táto pesnička už hrá alebo je vo fronte' });
    expect(jukebox.view().eligibleIds).toEqual(['b']);
  });

  it('cleans the title', () => {
    const { jukebox } = setup();
    jukebox.setEnabled(true);
    jukebox.add(a, { videoId: videoId(1), title: '  Song\u0000\n  name‮ ', durationSec: 60 });
    expect(jukebox.view().current?.title).toBe('Song name');
    jukebox.add(b, { videoId: videoId(2), title: 42, durationSec: 60 });
    expect(jukebox.view().queue[0].title).toBe(JUKEBOX_FALLBACK_TITLE);
    expect(Array.from(cleanTrackTitle('é'.repeat(500)))).toHaveLength(JUKEBOX_MAX_TITLE_LENGTH);
    expect(cleanTrackTitle('   ')).toBe(JUKEBOX_FALLBACK_TITLE);
  });

  it('stops its timer after dispose or when the table no longer exists', () => {
    const first = setup();
    first.jukebox.setEnabled(true);
    first.jukebox.add(a, track(1, 5));
    first.jukebox.add(b, track(2, 5));
    first.jukebox.dispose();
    first.onChange.mockClear();
    vi.advanceTimersByTime(60_000);
    expect(first.onChange).not.toHaveBeenCalled();

    const second = setup();
    second.jukebox.setEnabled(true);
    second.jukebox.add(a, track(1, 5));
    second.jukebox.add(b, track(2, 5));
    second.kill();
    second.onChange.mockClear();
    vi.advanceTimersByTime(60_000);
    expect(second.onChange).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('parseYouTubeLink', () => {
  const id = 'dQw4w9WgXcQ';

  it.each([
    id,
    `https://www.youtube.com/watch?v=${id}`,
    `https://youtube.com/watch?v=${id}&t=42s&list=PL123`,
    `youtube.com/watch?feature=share&v=${id}`,
    `https://m.youtube.com/watch?v=${id}`,
    `https://music.youtube.com/watch?v=${id}&si=abc`,
    `https://youtu.be/${id}`,
    `https://youtu.be/${id}?si=xyz&t=10`,
    `https://www.youtube.com/shorts/${id}`,
    `https://www.youtube.com/embed/${id}?autoplay=1`,
    `https://www.youtube-nocookie.com/embed/${id}`,
    `https://www.youtube.com/live/${id}?feature=share`,
    `  https://youtu.be/${id}  `,
  ])('parses %s', (link) => {
    expect(parseYouTubeLink(link)).toBe(id);
  });

  it.each(['', 'hello', `https://vimeo.com/${id}`, `https://evil.example/watch?v=${id}`, 'https://www.youtube.com/watch?v=short', `javascript:alert('${id}')`, `https://youtube.com.evil.example/watch?v=${id}`])(
    'rejects %s',
    (link) => {
      expect(parseYouTubeLink(link)).toBeNull();
    },
  );
});
