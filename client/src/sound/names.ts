/** Všetky zvuky, ktoré vie engine prehrať. */
export const SOUND_NAMES = ['deal', 'flip', 'chip', 'chips', 'check', 'fold', 'allin', 'win', 'bounty', 'turn', 'timeWarning', 'draw', 'message'] as const;

export type SoundName = (typeof SOUND_NAMES)[number];

/** Zvuky ovládané prepínačom „Upozornenie na ťah“ — ostatné patria pod „Zvukové efekty“. */
export const TURN_ALERT_SOUNDS: readonly SoundName[] = ['turn', 'timeWarning'];
