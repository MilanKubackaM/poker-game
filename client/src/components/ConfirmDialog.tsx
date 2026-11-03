import { useEffect, useRef, useState } from 'react';

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Nebezpečná akcia (odchod, vyhodenie) — potvrdzovacie tlačidlo je červené. */
  danger?: boolean;
}

export interface DialogChoice<T extends string> {
  value: T;
  label: string;
}

export interface ChoiceOptions<T extends string> {
  title: string;
  message?: string;
  /** Tlačidlá volieb zľava doprava; posledná je zvýraznená. */
  choices: DialogChoice<T>[];
  cancelLabel?: string;
}

interface Pending {
  title: string;
  message?: string;
  cancelLabel?: string;
  danger?: boolean;
  choices: DialogChoice<string>[];
  /** null = zrušené (Zrušiť, Escape, klik mimo). */
  resolve: (value: string | null) => void;
}

let show: ((pending: Pending) => void) | null = null;

/** Vlastné potvrdenie namiesto `window.confirm` (systémový dialóg prehliadača). Bez `ConfirmHost` sa použije systémový. */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  if (!show) {
    return Promise.resolve(window.confirm([options.title, options.message].filter(Boolean).join('\n\n')));
  }
  const open = show;
  return new Promise((resolve) =>
    open({
      title: options.title,
      message: options.message,
      cancelLabel: options.cancelLabel,
      danger: options.danger,
      choices: [{ value: 'confirm', label: options.confirmLabel ?? 'Potvrdiť' }],
      resolve: (value) => resolve(value === 'confirm'),
    }),
  );
}

/** Dialóg s viacerými voľbami; vráti zvolenú hodnotu alebo null pri zrušení. Bez `ConfirmHost` potvrdí poslednú voľbu. */
export function choiceDialog<T extends string>(options: ChoiceOptions<T>): Promise<T | null> {
  if (!show) {
    const last = options.choices.at(-1);
    return Promise.resolve(last && window.confirm([options.title, options.message, last.label].filter(Boolean).join('\n\n')) ? last.value : null);
  }
  const open = show;
  return new Promise((resolve) => open({ ...options, choices: options.choices, resolve: (value) => resolve(value as T | null) }));
}

/** Jediná inštancia dialógu — patrí do koreňa aplikácie. */
export function ConfirmHost() {
  const [pending, setPending] = useState<Pending | null>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    show = (next) => {
      setPending((current) => {
        current?.resolve(null);
        return next;
      });
    };
    return () => {
      show = null;
    };
  }, []);

  useEffect(() => {
    if (!pending) {
      return;
    }
    confirmRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        close(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!pending) {
    return null;
  }

  function close(value: string | null) {
    pending?.resolve(value);
    setPending(null);
  }

  return (
    <div className="modal-backdrop confirm-backdrop" onClick={() => close(null)}>
      <div className="modal confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" onClick={(event) => event.stopPropagation()}>
        <h2 id="confirm-title">{pending.title}</h2>
        {pending.message && <p className="confirm-message">{pending.message}</p>}
        <div className="confirm-actions">
          <button type="button" className="btn btn-secondary" onClick={() => close(null)}>
            {pending.cancelLabel ?? 'Zrušiť'}
          </button>
          {pending.choices.map((choice, index) => {
            const last = index === pending.choices.length - 1;
            return (
              <button
                key={choice.value}
                type="button"
                ref={last ? confirmRef : undefined}
                className={last ? (pending.danger ? 'btn btn-danger' : 'btn btn-primary') : 'btn btn-secondary'}
                onClick={() => close(choice.value)}
              >
                {choice.label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
