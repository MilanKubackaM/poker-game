import { useCallback, useId, useState, type InputHTMLAttributes } from 'react';

/**
 * Chyby polí formulára sa ukazujú až po opustení poľa (blur) alebo po pokuse o odoslanie — nie pri prvom písmene.
 * Potom sa už prepočítavajú živo pri písaní.
 */
export function useFieldTouch<K extends string>() {
  const [touched, setTouched] = useState<Partial<Record<K, boolean>>>({});
  const [submitted, setSubmitted] = useState(false);
  const touch = useCallback((key: K) => setTouched((current) => (current[key] ? current : { ...current, [key]: true })), []);
  const visible = useCallback((key: K) => submitted || !!touched[key], [submitted, touched]);
  const reset = useCallback(() => {
    setTouched({});
    setSubmitted(false);
  }, []);
  return { touch, visible, submit: () => setSubmitted(true), reset };
}

interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'> {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** Chyba, ktorá sa má ukázať (null = bez chyby alebo ešte neukazovať). */
  error?: string | null;
  hint?: string;
}

export function TextField({ label, value, onChange, error, hint, ...input }: TextFieldProps) {
  const id = useId();
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  // Popis je samostatný <label> (nie obal celého poľa), aby nápoveda a chyba neboli súčasťou názvu poľa pre čítačku.
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        {...input}
        id={id}
        value={value}
        className={error ? 'invalid' : undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        onChange={(event) => onChange(event.target.value)}
      />
      {error ? (
        <small className="field-error" id={`${id}-error`}>
          {error}
        </small>
      ) : (
        hint && (
          <small className="field-hint" id={`${id}-hint`}>
            {hint}
          </small>
        )
      )}
    </div>
  );
}

interface PasswordFieldProps extends Omit<TextFieldProps, 'type'> {
  autoComplete: 'current-password' | 'new-password';
}

/** Heslo s prepínačom „Ukázať / Skryť“. */
export function PasswordField({ label, value, onChange, error, hint, ...input }: PasswordFieldProps) {
  const id = useId();
  const [shown, setShown] = useState(false);
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="password-input">
        <input
          {...input}
          id={id}
          type={shown ? 'text' : 'password'}
          value={value}
          className={error ? 'invalid' : undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
        />
        <button
          type="button"
          className="password-toggle"
          onClick={() => setShown((value) => !value)}
          aria-label={shown ? 'Skryť heslo' : 'Ukázať heslo'}
          aria-pressed={shown}
        >
          {shown ? 'Skryť' : 'Ukázať'}
        </button>
      </div>
      {error ? (
        <small className="field-error" id={`${id}-error`}>
          {error}
        </small>
      ) : (
        hint && (
          <small className="field-hint" id={`${id}-hint`}>
            {hint}
          </small>
        )
      )}
    </div>
  );
}

/** Chyba zopakovaného hesla (dĺžku a ostatné pravidlá hlási pole s heslom). */
export function confirmError(password: string, confirm: string): string | null {
  if (!confirm) {
    return 'Zopakuj heslo';
  }
  return password === confirm ? null : 'Heslá sa nezhodujú';
}
