/** YouTube ID videa: presne 11 znakov z base64url abecedy. */
export const YOUTUBE_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

/** Najdlhší názov pesničky vo fronte. */
export const JUKEBOX_MAX_TITLE_LENGTH = 120;

/** Názov, keď ho prehliadač nezistil alebo po očistení nič neostalo. */
export const JUKEBOX_FALLBACK_TITLE = 'YouTube video';

const YOUTUBE_HOSTS = new Set(['youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com']);

export function isYouTubeVideoId(value: unknown): value is string {
  return typeof value === 'string' && YOUTUBE_ID_PATTERN.test(value);
}

/**
 * ID videa z odkazu na YouTube: `youtu.be/ID`, `youtube.com/watch?v=ID` (aj `m.` a `music.`), `/shorts/ID`, `/embed/ID`,
 * `/live/ID`; prijme aj samotné 11-znakové ID. Nerozpoznaný odkaz → null.
 */
export function parseYouTubeLink(input: string): string | null {
  const text = input.trim();
  if (isYouTubeVideoId(text)) {
    return text;
  }
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  let id: string | null = null;
  if (host === 'youtu.be') {
    id = url.pathname.split('/')[1] ?? null;
  } else if (YOUTUBE_HOSTS.has(host)) {
    if (url.pathname === '/watch') {
      id = url.searchParams.get('v');
    } else {
      id = url.pathname.match(/^\/(?:shorts|embed|live|v)\/([^/]+)/)?.[1] ?? null;
    }
  }
  return isYouTubeVideoId(id) ? id : null;
}

/** Očistí názov pesničky: bez riadiacich znakov, zlúčené medzery, najviac `JUKEBOX_MAX_TITLE_LENGTH` znakov. */
export function cleanTrackTitle(value: unknown): string {
  if (typeof value !== 'string') {
    return JUKEBOX_FALLBACK_TITLE;
  }
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim();
  const chars = Array.from(cleaned);
  const short = chars.length > JUKEBOX_MAX_TITLE_LENGTH ? `${chars.slice(0, JUKEBOX_MAX_TITLE_LENGTH - 1).join('').trimEnd()}…` : cleaned;
  return short || JUKEBOX_FALLBACK_TITLE;
}
