import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { JukeboxView, TableView } from '../../../shared/types';
import { JUKEBOX_MAX_QUEUE } from '../../../shared/constants';
import { isAdmin } from '../roles';
import { useDismiss } from '../sound';
import { useSoundPreferences } from '../sound/preferences';
import { addJukeboxLink, resumeMusic, serverNow, setJukeboxEnabled, setJukeboxPreferences, useJukebox, useJukeboxPreferences } from './store';
import './jukebox.css';

/** m:ss */
function clock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** Prekreslí komponent každú sekundu (priebeh pesničky), kým je `active`. */
function useSecondTick(active: boolean): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) {
      return;
    }
    const timer = window.setInterval(() => setTick((tick) => tick + 1), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
}

/**
 * Jukebox v hornej lište: ♪ s názvom práve hranej pesničky, klik otvorí panel s frontom, pridávaním, hlasitosťou
 * a (pre hosta) vypínačom. Samotný prehrávač je skrytý a nezávislý od lišty (`store.ts`).
 */
export function JukeboxButton({ view }: { view: TableView }) {
  const jukebox = useJukebox(view.code);
  const state = jukebox.code === view.code ? jukebox.view : null;
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  useDismiss(open, setOpen, wrapRef);
  const enabled = !!state?.enabled;
  const current = enabled ? (state?.current ?? null) : null;
  const blocked = jukebox.blocked && !!current;

  const className = ['btn', 'btn-chip', 'jukebox-btn', enabled ? '' : 'off', current ? 'playing' : '', blocked ? 'blocked' : ''].filter(Boolean).join(' ');
  const label = !state ? 'Jukebox' : !enabled ? 'Jukebox vypnutý' : current ? `Hrá: ${current.title}` : 'Jukebox — ticho, front je prázdny';

  return (
    <div className="jukebox-wrap" ref={wrapRef}>
      <button
        type="button"
        className={className}
        onClick={() => {
          if (blocked) {
            resumeMusic();
          }
          setOpen(!open);
        }}
        title={blocked ? 'Prehliadač zablokoval hudbu — klikni a zapne sa' : label}
        aria-label={label}
        aria-expanded={open}
      >
        <span className="jukebox-note" aria-hidden>
          ♪
        </span>
        {current && (
          <span className={Array.from(current.title).length > 22 ? 'jukebox-btn-title scrolling' : 'jukebox-btn-title'}>
            <span className={Array.from(current.title).length > 22 ? 'jukebox-marquee' : undefined}>{current.title}</span>
          </span>
        )}
      </button>
      {open && <JukeboxPanel view={view} state={state} offset={jukebox.offset} blocked={blocked} playError={current ? jukebox.playError : null} />}
    </div>
  );
}

interface JukeboxPanelProps {
  view: TableView;
  state: JukeboxView | null;
  offset: number;
  blocked: boolean;
  playError: string | null;
}

function JukeboxPanel({ view, state, offset, blocked, playError }: JukeboxPanelProps) {
  const admin = isAdmin(view);
  const enabled = !!state?.enabled;
  const current = enabled ? (state?.current ?? null) : null;
  const queue = enabled ? (state?.queue ?? []) : [];
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  useSecondTick(!!current);

  const elapsed = current ? Math.min(current.durationSec, (serverNow(offset) - current.startedAt) / 1000) : 0;

  const toggle = async (next: boolean) => {
    setSwitching(true);
    setSwitchError(null);
    const response = await setJukeboxEnabled(next);
    setSwitching(false);
    if (!response.ok) {
      setSwitchError(response.error ?? 'Nepodarilo sa');
    }
  };

  return (
    <div className="jukebox-panel" role="dialog" aria-label="Jukebox">
      <div className="jukebox-head">
        <span className="jukebox-panel-title">♪ Jukebox</span>
        {state && !admin && <span className={enabled ? 'jukebox-badge on' : 'jukebox-badge'}>{enabled ? 'zapnutý' : 'vypnutý'}</span>}
      </div>

      {state && admin && (
        <label className={enabled ? 'rule-switch on jukebox-switch' : 'rule-switch jukebox-switch'}>
          <input type="checkbox" checked={enabled} disabled={switching} onChange={(event) => void toggle(event.target.checked)} />
          <span className="rule-switch-track" aria-hidden />
          <span className="rule-switch-text">
            <strong>{enabled ? 'Jukebox zapnutý' : 'Jukebox vypnutý'}</strong>
            <span>{enabled ? 'Vypnutím sa hudba zastaví a front vyprázdni.' : 'Hudba z YouTube pre celý stôl.'}</span>
          </span>
        </label>
      )}
      {switchError && <p className="jukebox-error">{switchError}</p>}

      {!state ? (
        <p className="jukebox-hint">Načítavam jukebox…</p>
      ) : !enabled ? (
        <p className="jukebox-hint">{admin ? 'Zapni ho prepínačom vyššie.' : 'Jukebox je vypnutý — zapnúť ho môže host.'}</p>
      ) : (
        <>
          <section className="jukebox-now" aria-label="Práve hrá">
            {current ? (
              <>
                <div className="jukebox-now-title">{current.title}</div>
                <div className="jukebox-meta">pridal(a) {current.addedByName}</div>
                <div className="jukebox-progress" aria-hidden>
                  <div className="jukebox-progress-fill" style={{ width: `${(elapsed / current.durationSec) * 100}%` }} />
                </div>
                <div className="jukebox-times">
                  <span>{clock(elapsed)}</span>
                  <span>{clock(current.durationSec)}</span>
                </div>
                {blocked && (
                  <button type="button" className="btn btn-gold jukebox-resume" onClick={resumeMusic}>
                    ▶ Zapnúť hudbu
                  </button>
                )}
                {playError && <p className="jukebox-error">{playError} — ďalšia pesnička začne po uplynutí jej dĺžky.</p>}
              </>
            ) : (
              <div className="jukebox-hint">Ticho — front je prázdny.</div>
            )}
          </section>

          <section className="jukebox-queue" aria-label="Front">
            <div className="jukebox-section-title">
              Vo fronte{' '}
              <span className="jukebox-count">
                {queue.length}/{JUKEBOX_MAX_QUEUE}
              </span>
            </div>
            {queue.length > 0 ? (
              <ol>
                {queue.map((track) => (
                  <li key={track.id}>
                    <span className="jukebox-queue-title">{track.title}</span>
                    <span className="jukebox-meta">
                      {track.addedByName} · {clock(track.durationSec)}
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="jukebox-hint">Nič nečaká.</p>
            )}
          </section>

          <AddForm state={state} youId={view.youId} />
        </>
      )}

      <VolumeControl />
    </div>
  );
}

function AddForm({ state, youId }: { state: JukeboxView; youId: string }) {
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState(false);
  const eligible = state.eligibleIds.includes(youId);
  const full = state.queue.length >= JUKEBOX_MAX_QUEUE;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!link.trim() || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    setAdded(false);
    const response = await addJukeboxLink(link);
    setBusy(false);
    if (response.ok) {
      setLink('');
      setAdded(true);
    } else {
      setError(response.error ?? 'Pesničku sa nepodarilo pridať');
    }
  };

  if (!eligible) {
    return (
      <p className="jukebox-hint jukebox-add-hint">
        {added ? '✓ Pesnička pridaná. ' : ''}
        {full ? `Front je plný (${JUKEBOX_MAX_QUEUE}/${JUKEBOX_MAX_QUEUE}).` : 'Pesničku pridáva víťaz poslednej ruky.'}
      </p>
    );
  }

  return (
    <form className="jukebox-add" onSubmit={submit}>
      <label className="jukebox-section-title" htmlFor="jukebox-link">
        Výhra je tvoja — pridaj pesničku
      </label>
      <div className="jukebox-add-row">
        <input
          id="jukebox-link"
          type="text"
          inputMode="url"
          spellCheck={false}
          placeholder="Odkaz na YouTube"
          value={link}
          onChange={(event) => setLink(event.target.value)}
          disabled={busy}
          autoComplete="off"
        />
        <button type="submit" className="btn btn-gold" disabled={busy || !link.trim()}>
          {busy ? '…' : 'Pridať'}
        </button>
      </div>
      {busy && <p className="jukebox-hint">Overujem video…</p>}
      {error && <p className="jukebox-error">{error}</p>}
    </form>
  );
}

function VolumeControl() {
  const prefs = useJukeboxPreferences();
  const [sound] = useSoundPreferences();
  const muted = prefs.muted || sound.muted;
  return (
    <div className="jukebox-volume">
      <button
        type="button"
        className={muted ? 'icon-btn jukebox-mute' : 'icon-btn jukebox-mute on'}
        onClick={() => setJukeboxPreferences({ muted: !prefs.muted })}
        disabled={sound.muted}
        title={sound.muted ? 'Všetky zvuky sú vypnuté (reproduktor v lište)' : prefs.muted ? 'Zapnúť hudbu u mňa' : 'Stlmiť hudbu u mňa'}
        aria-label="Stlmiť hudbu"
        aria-pressed={muted}
      >
        {muted ? '🔇' : '🔊'}
      </button>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={prefs.volume}
        onChange={(event) => setJukeboxPreferences({ volume: Number(event.target.value), muted: false })}
        aria-label="Hlasitosť hudby"
      />
      <span className="jukebox-volume-value">{prefs.volume} %</span>
    </div>
  );
}
