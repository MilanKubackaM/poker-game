import { useRef, useState } from 'react';
import { PushToTalkSettings, isDesktopPointer, keyLabel, useDismiss } from '../sound';
import { MicIcon } from './MicIcon';

interface MicButtonProps {
  microphone: boolean;
  onToggle: () => void;
  /** Push-to-talk beží: kláves a či práve hovorím. */
  pushToTalk?: { key: string; talking: boolean } | null;
}

/** Mikrofón zap/vyp; na desktope vedľa šípka s nastavením push-to-talk. */
export function MicButton({ microphone, onToggle, pushToTalk }: MicButtonProps) {
  const [open, setOpen] = useState(false);
  const [desktop] = useState(isDesktopPointer);
  const wrapRef = useRef<HTMLSpanElement>(null);
  useDismiss(open, setOpen, wrapRef);
  const classes = ['icon-btn', 'mic-btn', microphone ? 'on' : '', pushToTalk ? 'ptt' : '', pushToTalk?.talking ? 'talking' : ''].filter(Boolean).join(' ');

  return (
    <span className="mic-button-wrap" ref={wrapRef}>
      <button
        type="button"
        className={classes}
        onClick={onToggle}
        title={!microphone ? 'Mikrofón vypnutý — zapnúť' : pushToTalk ? `Mikrofón — push-to-talk: drž ${keyLabel(pushToTalk.key)}` : 'Mikrofón zapnutý — vypnúť'}
        aria-label="Mikrofón"
        aria-pressed={microphone}
      >
        <MicIcon off={!microphone} />
        {pushToTalk && <span className="ptt-badge">{keyLabel(pushToTalk.key)}</span>}
      </button>
      {desktop && (
        <button
          type="button"
          className={open ? 'mic-caret open' : 'mic-caret'}
          onClick={() => setOpen(!open)}
          title="Nastavenia mikrofónu — push-to-talk"
          aria-label="Nastavenia mikrofónu"
          aria-expanded={open}
        >
          ▾
        </button>
      )}
      {open && (
        <div className="sound-popover mic-popover">
          <div className="sound-popover-title">Mikrofón</div>
          <PushToTalkSettings />
        </div>
      )}
    </span>
  );
}
