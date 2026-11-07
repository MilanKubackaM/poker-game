import { useEffect, useState, type FormEvent } from 'react';
import { EMAIL_MAX_LENGTH, PASSWORD_MAX_LENGTH, cleanEmail, validateEmail, type AccountView } from '../../../shared/account';
import { emit } from '../socket';
import { PasswordField, TextField, useFieldTouch } from './fields';
import { applyAccount, refreshAccount, signOut } from './session';
import './account.css';

/** Ako dlho po odoslaní nejde poslať ďalší overovací e-mail (server má vlastný limit, toto len šetrí zbytočné klikanie). */
const RESEND_COOLDOWN_S = 60;

/**
 * Účet bez overeného e-mailu — hrať sa nedá. Keď hráč klikne na odkaz (aj na inom zariadení), server pošle
 * `account:updated` s `emailVerified` a aplikácia pokračuje sama.
 */
export function VerifyEmailScreen({ account, inviteCode }: { account: AccountView; inviteCode: string | null }) {
  const [cooldown, setCooldown] = useState(0);
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState<{ text: string; tone: 'success' | 'error' } | null>(null);
  const [editing, setEditing] = useState(false);
  const [checking, setChecking] = useState(false);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (cooldown <= 0) {
      return;
    }
    const timer = window.setTimeout(() => setCooldown((value) => value - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);

  // Po návrate do karty (napr. po kliknutí na odkaz v mobile) sa stav overí hneď, nečaká sa na push zo servera.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void refreshAccount();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  const resend = async () => {
    setSending(true);
    setMessage(null);
    const response = await emit('auth:resendVerification');
    setSending(false);
    if (response.ok) {
      setCooldown(RESEND_COOLDOWN_S);
      setMessage({ text: `Nový overovací e-mail je na ceste na ${account.email}.`, tone: 'success' });
    } else {
      setMessage({ text: response.error ?? 'E-mail sa nepodarilo poslať', tone: 'error' });
    }
  };

  const check = async () => {
    setChecking(true);
    await refreshAccount();
    setChecking(false);
    setMessage({ text: 'E-mail ešte nie je overený — klikni na odkaz v e-maile.', tone: 'error' });
  };

  const logout = async () => {
    setLeaving(true);
    await signOut();
  };

  return (
    <div className="pending-join-screen">
      <div className="panel pending-join-card verify-card">
        <div className="verify-icon" aria-hidden>
          ✉️
        </div>
        <h1>Over svoj e-mail</h1>
        <p>
          Poslali sme odkaz na <strong className="verify-email">{account.email}</strong>. Klikni naň — aj v mobile — a hneď pokračuješ
          {inviteCode ? ` ku stolu ${inviteCode}` : ''}. Odkaz platí 48 hodín.
        </p>
        <p className="hint">Nevidíš ho? Pozri priečinok so spamom alebo „Promo akcie“.</p>
        {message && (
          <div className={message.tone === 'success' ? 'success' : 'error'} role="status">
            {message.text}
          </div>
        )}
        {editing ? (
          <ChangeEmailForm
            account={account}
            onDone={(text) => {
              setEditing(false);
              setCooldown(RESEND_COOLDOWN_S);
              setMessage({ text, tone: 'success' });
            }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <div className="verify-actions">
            <button type="button" className="btn btn-primary btn-block" disabled={checking} onClick={() => void check()}>
              {checking ? 'Kontrolujem…' : 'Už som klikol na odkaz'}
            </button>
            <button type="button" className="btn btn-secondary btn-block" disabled={sending || cooldown > 0} onClick={() => void resend()}>
              {sending ? 'Posielam…' : cooldown > 0 ? `Poslať znova (o ${cooldown} s)` : 'Poslať znova'}
            </button>
            <button type="button" className="btn btn-ghost btn-block" onClick={() => setEditing(true)}>
              Opraviť e-mail
            </button>
          </div>
        )}
        <button type="button" className="auth-link" disabled={leaving} onClick={() => void logout()}>
          {leaving ? 'Odhlasujem…' : `Odhlásiť sa (${account.username})`}
        </button>
      </div>
    </div>
  );
}

/** Zmena e-mailu (s heslom) — nový e-mail je neoverený a odíde naň overovací odkaz. Použité aj v profile. */
export function ChangeEmailForm({ account, onDone, onCancel }: { account: AccountView; onDone: (message: string) => void; onCancel?: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fields = useFieldTouch<'email' | 'password'>();
  const same = cleanEmail(email) === account.email;
  const emailError = validateEmail(email) ?? (same ? 'Toto je tvoj súčasný e-mail' : null);
  const passwordError = password ? null : 'Zadaj heslo';

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    fields.submit();
    if (busy || emailError || passwordError) {
      return;
    }
    setBusy(true);
    setError(null);
    const response = await emit<AccountView>('auth:changeEmail', { email: cleanEmail(email), password });
    setBusy(false);
    if (response.ok && response.data) {
      const next = response.data;
      onDone(`E-mail je zmenený — overovací odkaz sme poslali na ${next.email}.`);
      applyAccount(next);
      return;
    }
    setError(response.error ?? 'E-mail sa nepodarilo zmeniť');
  };

  return (
    <form className="auth-form" onSubmit={submit} noValidate>
      <TextField
        label="Nový e-mail"
        type="email"
        inputMode="email"
        value={email}
        onChange={setEmail}
        onBlur={() => fields.touch('email')}
        error={fields.visible('email') ? emailError : null}
        autoComplete="email"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        maxLength={EMAIL_MAX_LENGTH}
      />
      <PasswordField
        label="Heslo k účtu"
        value={password}
        onChange={setPassword}
        onBlur={() => fields.touch('password')}
        error={fields.visible('password') ? passwordError : null}
        autoComplete="current-password"
        maxLength={PASSWORD_MAX_LENGTH}
      />
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      <div className="auth-form-actions">
        {onCancel && (
          <button type="button" className="btn btn-secondary" onClick={onCancel}>
            Zrušiť
          </button>
        )}
        <button className="btn btn-primary" disabled={busy}>
          {busy ? 'Ukladám…' : 'Zmeniť e-mail'}
        </button>
      </div>
    </form>
  );
}
