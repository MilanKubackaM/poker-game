import type { Avatar } from '../../../shared/types';
import { AVATAR_COLORS, AVATAR_EMOJIS } from '../../../shared/constants';

interface AvatarPickerProps {
  value: Avatar;
  onChange: (avatar: Avatar) => void;
}

export function AvatarBadge({ avatar, size = 48 }: { avatar: Avatar; size?: number }) {
  return (
    <span className="avatar-badge" style={{ background: avatar.color, width: size, height: size, fontSize: size * 0.55 }}>
      {avatar.emoji}
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
