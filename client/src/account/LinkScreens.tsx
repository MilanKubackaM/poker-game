import { useEffect, useState, type FormEvent } from 'react';
import { PASSWORD_MAX_LENGTH, validatePassword, type AccountView, type AuthSession } from '../../../shared/account';
import type { Ack } from '../../../shared/types';
import { emit } from '../socket';
import { PasswordField, confirmError, useFieldTouch } from './fields';
import { applyAccount, getAccount, signIn } from './session';
import './account.css';

/** Odkaz z e-mailu: `/verify?token=…` (overenie e-mailu) alebo `/reset?token=…` (nové heslo). */
export type AuthLink = { kind: 'verify' | 'reset'; token: string };

export function readAuthLink(): AuthLink | null {
  const path = window.location.pathname.replace(/\/+$/, '');
  if (path !== '/verify' && path !== '/reset') {
    return null;
  }
  const token = new URLSearchParams(window.location.search).get('token')?.trim();
  return { kind: path === '/verify' ? 'verify' : 'reset', token: token ?? '' };
}

/**
 * Overovací token je jednorazový — StrictMode spustí efekt dvakrát a druhé volanie by vrátilo „neplatný odkaz“.
 * Jedna požiadavka na token, výsledok zdieľaný.
 */
const verifications = new Map<string, Promise<Ack<AccountView | undefined>>>();

function verifyOnce(token: string): Promise<Ack<AccountView | undefined>> {
  let pending = verifications.get(token);
  if (!pending) {
    pending = emit<AccountView | undefined>('auth:verifyEmail', { token });
    verifications.set(token, pending);
  }
  return pending;
}

/** `signedIn` = v tomto prehliadači je niekto prihlásený (aj keď sa účet ešte načítava). */
export function VerifyLinkScreen({ token, signedIn, onDone }: { token: string; signedIn: boolean; onDone: () => void }) {
  const [state, setState] = useState<{ status: 'working' } | { status: 'done' } | { status: 'failed'; error: string }>(() =>
    token ? { status: 'working' } : { status: 'failed', error: 'Odkaz je neúplný — skopíruj ho z e-mailu celý.' },
  );

  useEffect(() => {
    if (!token) {
      return;
    }
    let active = true;
    void verifyOnce(token).then((response) => {
      if (!active) {
        return;
      }
      if (response.ok) {
        const account = response.data;
        // Overený účet patrí tomuto prihláseniu → hneď pustí ďalej (server pošle aj `account:updated`).
        if (account && getAccount()?.id === account.id) {
          applyAccount(account);
        }
        setState({ status: 'done' });
      } else {
        setState({ status: 'failed', error: response.error ?? 'Odkaz je neplatný alebo vypršal' });
      }
    });
    return () => {
      active = false;
    };
  }, [token]);

  return (
    <div className="pending-join-screen">
      <div className="panel pending-join-card verify-card" role="status">
        {state.status === 'working' && (
          <>
            <div className="pending-join-spinner" aria-hidden />
            <h1>Overujem e-mail…</h1>
          </>
        )}
        {state.status === 'done' && (
          <>
            <div className="verify-icon" aria-hidden>
              ✅
            </div>
            <h1>E-mail je overený</h1>
            <p className="muted">{signedIn ? 'Môžeš hrať.' : 'Prihlás sa a môžeš hrať. Ak máš aplikáciu otvorenú v inom okne, pokračuje sama.'}</p>
            <button type="button" className="btn btn-primary btn-block" onClick={onDone}>
              {signedIn ? 'Pokračovať' : 'Prihlásiť sa'}
            </button>
          </>
        )}
        {state.status === 'failed' && (
          <>
            <div className="verify-icon" aria-hidden>
              ⚠️
            </div>
            <h1>E-mail sa nepodarilo overiť</h1>
            <div className="error">{state.error}</div>
            <p className="muted">Po prihlásení si môžeš dať poslať nový overovací odkaz.</p>
            <button type="button" className="btn btn-primary btn-block" onClick={onDone}>
              Pokračovať
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export function ResetPasswordScreen({ token, onDone }: { token: string; onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(token ? null : 'Odkaz je neúplný — skopíruj ho z e-mailu celý.');
  const fields = useFieldTouch<'password' | 'confirm'>();
  const passwordError = validatePassword(password, password);
  const passwordConfirmError = confirmError(password, passwordConfirm);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    fields.submit();
    if (busy || !token || passwordError || passwordConfirmError) {
      return;
    }
    setBusy(true);
    setError(null);
    const response = await emit<AuthSession>('auth:resetPassword', { token, password, passwordConfirm });
    setBusy(false);
    if (response.ok && response.data) {
      if (signIn(response.data)) {
        onDone();
      } else {
        setError('Heslo je zmenené, ale prehliadač nedovolil uložiť prihlásenie — prihlás sa novým heslom.');
      }
      return;
    }
    setError(response.error ?? 'Heslo sa nepodarilo zmeniť — odkaz je neplatný alebo vypršal');
  };

  return (
    <div className="pending-join-screen">
      <div className="panel pending-join-card verify-card">
        <h1>Nové heslo</h1>
        <p className="muted">Po zmene hesla sa odhlásia všetky ostatné zariadenia.</p>
        <form className="auth-form" onSubmit={submit} noValidate>
          <PasswordField
            label="Nové heslo"
            value={password}
            onChange={setPassword}
            onBlur={() => fields.touch('password')}
            error={fields.visible('password') ? passwordError : null}
            hint="Aspoň 8 znakov."
            autoComplete="new-password"
            maxLength={PASSWORD_MAX_LENGTH}
            autoFocus
          />
          <PasswordField
            label="Nové heslo znova"
            value={passwordConfirm}
            onChange={setPasswordConfirm}
            onBlur={() => fields.touch('confirm')}
            error={fields.visible('confirm') ? passwordConfirmError : null}
            autoComplete="new-password"
            maxLength={PASSWORD_MAX_LENGTH}
          />
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
          <button className="btn btn-primary btn-block" disabled={busy || !token}>
            {busy ? 'Ukladám…' : 'Nastaviť heslo a prihlásiť sa'}
          </button>
        </form>
        <button type="button" className="auth-link" onClick={onDone}>
          Späť na prihlásenie
        </button>
      </div>
    </div>
  );
}
