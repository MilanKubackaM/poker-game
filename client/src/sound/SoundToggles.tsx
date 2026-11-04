import { useEffect, useRef, useState, type RefObject } from 'react';
import { playSound, unlockAudio } from './engine';
import { useSoundPreferences } from './preferences';
import { SpeakerIcon } from '../components/MediaIcons';
import './sound.css';

function playSample(sound: 'chips' | 'turn'): void {
  unlockAudio();
  // Krátke oneskorenie — pri prvom geste sa AudioContext ešte len rozbieha.
  window.setTimeout(() => playSound(sound), 60);
}

/** Desktop s myšou a klávesnicou — tam má push-to-talk zmysel. */
const DESKTOP_QUERY = '(hover: hover) and (pointer: fine)';

/** Čitateľný názov klávesu z `KeyboardEvent.code`. */
export function keyLabel(code: string): string {
  if (code.startsWith('Key')) {
    return code.slice(3);
  }
  if (code.startsWith('Digit')) {
    return code.slice(5);
  }
  const names: Record<string, string> = {
    Space: 'Medzerník',
    ShiftLeft: 'Ľavý Shift',
    ShiftRight: 'Pravý Shift',
    ControlLeft: 'Ľavý Ctrl',
    ControlRight: 'Pravý Ctrl',
    AltLeft: 'Ľavý Alt',
    AltRight: 'Pravý Alt',
    Backquote: '`',
    CapsLock: 'Caps Lock',
    Tab: 'Tab',
  };
  return names[code] ?? code;
}

function Slider({ label, value, onChange, onCommit }: { label: string; value: number; onChange: (value: number) => void; onCommit?: () => void }) {
  const percent = Math.round(value * 100);
  return (
    <label className="sound-slider">
      <span className="sound-slider-head">
        <span>{label}</span>
        <span className="sound-slider-value">{percent} %</span>
      </span>
      <input
        type="range"
        min={0}
        max={100}
        step={5}
        value={percent}
        aria-label={label}
        onChange={(event) => onChange(Number(event.target.value) / 100)}
        onPointerUp={onCommit}
        onKeyUp={onCommit}
      />
    </label>
  );
}

/** Nastavenia zvuku: efekty, upozornenie na ťah a hlasitosti (push-to-talk je pri mikrofóne). */
export function SoundSettings() {
  const [prefs, setPrefs] = useSoundPreferences();
  return (
    <div className="sound-settings" role="group" aria-label="Nastavenia zvuku">
      <label className="toggle sound-toggle">
        <input
          type="checkbox"
          checked={prefs.effects}
          onChange={(event) => {
            const effects = event.target.checked;
            setPrefs({ effects });
            if (effects) {
              playSample('chips');
            }
          }}
        />
        <span className="sound-toggle-text">
          <span>🔊 Zvukové efekty</span>
        </span>
      </label>
      <label className="toggle sound-toggle">
        <input
          type="checkbox"
          checked={prefs.turnAlert}
          onChange={(event) => {
            const turnAlert = event.target.checked;
            setPrefs({ turnAlert });
            if (turnAlert) {
              playSample('turn');
            }
          }}
        />
        <span className="sound-toggle-text">
          <span>🔔 Upozornenie na ťah</span>
        </span>
      </label>
      <Slider label="Hlasitosť efektov" value={prefs.effectsVolume} onChange={(effectsVolume) => setPrefs({ effectsVolume })} onCommit={() => playSample('chips')} />
      <Slider label="Hlasitosť hráčov (hlas)" value={prefs.voiceVolume} onChange={(voiceVolume) => setPrefs({ voiceVolume })} />
    </div>
  );
}

/** Push-to-talk (desktop): zapnutie a výber klávesu — v popoveri pri tlačidle mikrofónu. */
export function PushToTalkSettings() {
  const [prefs, setPrefs] = useSoundPreferences();
  const [capturing, setCapturing] = useState(false);

  useEffect(() => {
    if (!capturing) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.code !== 'Escape' && event.code) {
        setPrefs({ pushToTalkKey: event.code });
      }
      setCapturing(false);
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [capturing, setPrefs]);

  return (
    <div className="sound-settings sound-ptt-settings">
      <label className="toggle sound-toggle">
        <input type="checkbox" checked={prefs.pushToTalk} onChange={(event) => setPrefs({ pushToTalk: event.target.checked })} />
        <span className="sound-toggle-text">
          <span>Push-to-talk</span>
        </span>
      </label>
      {prefs.pushToTalk && (
        <button type="button" className={capturing ? 'btn btn-chip ptt-key capturing' : 'btn btn-chip ptt-key'} onClick={() => setCapturing(!capturing)}>
          {capturing ? 'Stlač kláves… (Esc zruší)' : `Kláves: ${keyLabel(prefs.pushToTalkKey)} — zmeniť`}
        </button>
      )}
    </div>
  );
}

/** Desktop s myšou a klávesnicou — len tam sa ponúka push-to-talk. */
export function isDesktopPointer(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(DESKTOP_QUERY).matches;
}

/** Zatvorí popover pri kliku mimo neho alebo Esc. */
export function useDismiss(open: boolean, setOpen: (open: boolean) => void, ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointer = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false);
    window.addEventListener('pointerdown', onPointer);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, setOpen, ref]);
}

/** Reproduktor v hornej lište: klik stlmí / zapne všetky zvuky, šípka otvorí nastavenia zvuku. */
export function SoundButton() {
  const [prefs, setPrefs] = useSoundPreferences();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const muted = prefs.muted;

  useDismiss(open, setOpen, wrapRef);

  return (
    <span className="sound-button-wrap" ref={wrapRef}>
      <button
        type="button"
        className={muted ? 'icon-btn mic-btn' : 'icon-btn mic-btn on'}
        onClick={() => {
          setPrefs({ muted: !muted });
          if (muted) {
            playSample('chips');
          }
        }}
        title={muted ? 'Zvuk vypnutý — zapnúť' : 'Zvuk zapnutý — vypnúť všetky zvuky'}
        aria-label="Zvuk"
        aria-pressed={!muted}
      >
        <SpeakerIcon off={muted} />
      </button>
      <button type="button" className={open ? 'mic-caret open' : 'mic-caret'} onClick={() => setOpen(!open)} title="Nastavenia zvuku" aria-label="Nastavenia zvuku" aria-expanded={open}>
        ▾
      </button>
      {open && (
        <div className="sound-popover">
          <div className="sound-popover-title">Zvuk</div>
          <SoundSettings />
        </div>
      )}
    </span>
  );
}

/**
 * Zvuk v menu ☰ na mobile, kde reproduktor v lište chýba: stlmenie (zatvorí menu ako ostatné položky)
 * a rozbaľovacie nastavenia zvuku, ktoré menu nechajú otvorené.
 */
export function SoundMenuItems() {
  const [prefs, setPrefs] = useSoundPreferences();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const muted = prefs.muted;

  return (
    <>
      <button
        type="button"
        className="menu-item menu-row"
        onClick={() => {
          setPrefs({ muted: !muted });
          if (muted) {
            playSample('chips');
          }
        }}
        aria-pressed={!muted}
      >
        <span className="menu-row-icon">
          <SpeakerIcon off={muted} size={18} />
        </span>
        <span>Zvuk</span>
        <span className={muted ? 'menu-row-state' : 'menu-row-state on'}>{muted ? 'vypnutý' : 'zapnutý'}</span>
      </button>
      <button
        type="button"
        className={settingsOpen ? 'menu-item menu-row menu-item-on' : 'menu-item menu-row'}
        onClick={(event) => {
          event.stopPropagation();
          setSettingsOpen(!settingsOpen);
        }}
        aria-expanded={settingsOpen}
      >
        <span className="menu-row-icon" aria-hidden>
          🎚
        </span>
        <span>Nastavenia zvuku</span>
        <span className="menu-row-caret" aria-hidden>
          {settingsOpen ? '▴' : '▾'}
        </span>
      </button>
      {settingsOpen && (
        <div className="menu-sound-settings" onClick={(event) => event.stopPropagation()}>
          <SoundSettings />
        </div>
      )}
    </>
  );
}
