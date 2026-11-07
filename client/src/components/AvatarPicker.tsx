import { useState } from 'react';
import type { Avatar } from '../../../shared/types';
import { AVATAR_COLORS, AVATAR_EMOJIS } from '../../../shared/constants';

interface AvatarPickerProps {
  value: Avatar;
  onChange: (avatar: Avatar) => void;
}

/**
 * URL profilovej fotky, ktorá sa dá zobraziť, a callback na chybu načítania. Pamätá si URL, ktorá zlyhala — nová fotka
 * (iné `?v=`) sa tak skúsi znova, pokazená sa už nenačítava a namiesto nej je emoji.
 */
function usePhoto(avatar: Avatar): [string | null, () => void] {
  const [failed, setFailed] = useState<string | null>(null);
  const photo = avatar.photo && avatar.photo !== failed ? avatar.photo : null;
  return [photo, () => setFailed(avatar.photo ?? null)];
}

/**
 * Obsah okrúhleho avatara: profilová fotka cez celý kruh, inak emoji. Rodič drží veľkosť, tvar a farbu pozadia
 * (`seat-portrait`, `room-portrait`, `lb-avatar`, …); `emojiClassName` je trieda emoji v danom mieste.
 */
export function AvatarFace({ avatar, emojiClassName }: { avatar: Avatar; emojiClassName?: string }) {
  const [photo, onError] = usePhoto(avatar);
  if (photo) {
    return <img className="avatar-photo" src={photo} alt="" loading="lazy" decoding="async" draggable={false} onError={onError} />;
  }
  return emojiClassName ? <span className={emojiClassName}>{avatar.emoji}</span> : <>{avatar.emoji}</>;
}

/** Avatar v riadku textu (chat, transakcie, losovanie) — malá okrúhla fotka, inak emoji. */
export function AvatarInline({ avatar }: { avatar: Avatar }) {
  const [photo, onError] = usePhoto(avatar);
  if (photo) {
    return <img className="avatar-inline" src={photo} alt="" loading="lazy" decoding="async" draggable={false} onError={onError} />;
  }
  return <>{avatar.emoji}</>;
}

export function AvatarBadge({ avatar, size = 48, className, title }: { avatar: Avatar; size?: number; className?: string; title?: string }) {
  return (
    <span className={className ? `avatar-badge ${className}` : 'avatar-badge'} title={title} style={{ background: avatar.color, width: size, height: size, fontSize: size * 0.55 }}>
      <AvatarFace avatar={avatar} />
    </span>
  );
}

export function AvatarPicker({ value, onChange }: AvatarPickerProps) {
  return (
    <div className="avatar-picker">
      <div className="avatar-preview">
        <AvatarBadge avatar={value} size={72} />
      </div>
      <div className="avatar-grid" role="radiogroup" aria-label="Avatar">
        {AVATAR_EMOJIS.map((emoji) => (
          <button
            key={emoji}
            type="button"
            className={emoji === value.emoji ? 'avatar-option selected' : 'avatar-option'}
            onClick={() => onChange({ ...value, emoji })}
            aria-checked={emoji === value.emoji}
            role="radio"
          >
            {emoji}
          </button>
        ))}
      </div>
      <div className="color-row" role="radiogroup" aria-label="Farba">
        {AVATAR_COLORS.map((color) => (
          <button
            key={color}
            type="button"
            className={color === value.color ? 'color-option selected' : 'color-option'}
            style={{ background: color }}
            onClick={() => onChange({ ...value, color })}
            aria-checked={color === value.color}
            aria-label={color}
            role="radio"
          />
        ))}
      </div>
    </div>
  );
}
