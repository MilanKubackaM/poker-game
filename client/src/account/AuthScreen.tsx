import { useState, type FormEvent } from 'react';
import { EMAIL_MAX_LENGTH, PASSWORD_MAX_LENGTH, USERNAME_MAX_LENGTH, cleanEmail, cleanUsername, validateEmail, validatePassword, validateUsername, type AuthSession } from '../../../shared/account';
import { emit } from '../socket';
import { VersionTag } from '../components/UpdateBanner';
import { PasswordField, TextField, confirmError, useFieldTouch } from './fields';
import { clearAuthNotice, signIn } from './session';
import './account.css';

type AuthTab = 'login' | 'register' | 'forgot';

const TABS: { id: AuthTab; label: string }[] = [
  { id: 'login', label: 'Prihlásiť sa' },
  { id: 'register', label: 'Registrácia' },
  { id: 'forgot', label: 'Zabudnuté heslo' },
];

const STORAGE_BLOCKED = 'Prehliadač nedovolil uložiť prihlásenie — povoľ ukladanie údajov stránky (nie súkromný režim) a skús znova.';

interface AuthScreenProps {
  /** Pozvánka ku stolu, s ktorou prišiel — po prihlásení sa k nej pokračuje. */
  inviteCode: string | null;
  notice: string | null;
}

/** Úvodná obrazovka bez prihlásenia: prihlásenie, registrácia a zabudnuté heslo. */
export function AuthScreen({ inviteCode, notice }: AuthScreenProps) {
  const [tab, setTab] = useState<AuthTab>('login');
  /** Prihlasovacie meno sa prenáša medzi kartami (napr. z prihlásenia do „Zabudnuté heslo“). */
  const [login, setLogin] = useState('');

  const select = (next: AuthTab) => {
    clearAuthNotice();
    setTab(next);
  };

  return (
    <div className="auth-screen">
      <header className="lobby-hero">
        <div className="brand-chip" aria-hidden>
          ♠
        </div>
        <h1>Poker Night</h1>
        <p>Súkromný poker stôl pre partiu kamarátov — s kamerami, žetónmi a pravidlami podľa vás.</p>
      </header>

      {inviteCode && (
        <div className="lobby-notice" role="status">
          <span className="lobby-notice-text">
            Pozvánka ku stolu <strong>{inviteCode}</strong> — po prihlásení alebo registrácii pokračuješ rovno ku stolu.
          </span>
        </div>
      )}
      {notice && (
        <div className="lobby-notice lobby-notice-danger" role="alert">
          <span className="lobby-notice-text">{notice}</span>
        </div>
      )}

      <section className="panel auth-panel">
        <div className="auth-tabs" role="tablist" aria-label="Účet">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              id={`auth-tab-${item.id}`}
              aria-selected={tab === item.id}
              aria-controls="auth-tab-panel"
              className={tab === item.id ? 'auth-tab active' : 'auth-tab'}
              onClick={() => select(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div id="auth-tab-panel" role="tabpanel" aria-labelledby={`auth-tab-${tab}`}>
          {tab === 'login' && <LoginForm login={login} onLoginChange={setLogin} onForgot={() => select('forgot')} />}
          {tab === 'register' && <RegisterForm />}
          {tab === 'forgot' && <ForgotForm login={login} onLoginChange={setLogin} onBack={() => select('login')} />}
        </div>
      </section>

      <footer className="lobby-footer">
        <VersionTag />
      </footer>
    </div>
  );
}

function LoginForm({ login, onLoginChange, onForgot }: { login: string; onLoginChange: (value: string) => void; onForgot: () => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fields = useFieldTouch<'login' | 'password'>();
  const loginError = login.trim() ? null : 'Zadaj e-mail alebo hráčske meno';
  const passwordError = password ? null : 'Zadaj heslo';

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    fields.submit();
    if (busy || loginError || passwordError) {
      return;
    }
    setBusy(true);
    setError(null);
    const response = await emit<AuthSession>('auth:login', { login: login.trim(), password });
    setBusy(false);
    if (response.ok && response.data) {
      if (!signIn(response.data)) {
        setError(STORAGE_BLOCKED);
      }
      return;
    }
    setError(response.error ?? 'Prihlásenie sa nepodarilo');
  };

  return (
    <form className="auth-form" onSubmit={submit} noValidate>
      <TextField
        label="E-mail alebo hráčske meno"
        value={login}
        onChange={onLoginChange}
        onBlur={() => fields.touch('login')}
        error={fields.visible('login') ? loginError : null}
        autoComplete="username"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        maxLength={EMAIL_MAX_LENGTH}
        autoFocus
      />
      <PasswordField
        label="Heslo"
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
      <button className="btn btn-primary btn-block" disabled={busy}>
        {busy ? 'Prihlasujem…' : 'Prihlásiť sa'}
      </button>
      <button type="button" className="auth-link" onClick={onForgot}>
        Zabudol som heslo
      </button>
    </form>
  );
}

function RegisterForm() {
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fields = useFieldTouch<'email' | 'username' | 'password' | 'confirm'>();
  const emailError = validateEmail(email);
  const usernameError = validateUsername(username);
  const passwordError = validatePassword(password, password);
  const passwordConfirmError = confirmError(password, passwordConfirm);
  const invalid = !!(emailError || usernameError || passwordError || passwordConfirmError);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    fields.submit();
    if (busy || invalid || validatePassword(password, passwordConfirm)) {
      return;
    }
    setBusy(true);
    setError(null);
    const response = await emit<AuthSession>('auth:register', {
      email: cleanEmail(email),
      username: cleanUsername(username),
      password,
      passwordConfirm,
    });
    setBusy(false);
    if (response.ok && response.data) {
      if (!signIn(response.data)) {
        setError(STORAGE_BLOCKED);
      }
      return;
    }
    setError(response.error ?? 'Registrácia sa nepodarila');
  };

  return (
    <form className="auth-form" onSubmit={submit} noValidate>
      <TextField
        label="E-mail"
        type="email"
        inputMode="email"
        value={email}
        onChange={setEmail}
        onBlur={() => fields.touch('email')}
        error={fields.visible('email') ? emailError : null}
        hint="Pošleme naň odkaz na overenie — bez neho sa nedá hrať."
        autoComplete="email"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        maxLength={EMAIL_MAX_LENGTH}
        autoFocus
      />
      <TextField
        label="Hráčske meno"
        value={username}
        onChange={setUsername}
        onBlur={() => fields.touch('username')}
        error={fields.visible('username') ? usernameError : null}
        hint="Pod týmto menom ťa uvidia pri každom stole. Prihlásiš sa ním aj e-mailom."
        autoComplete="username"
        autoCorrect="off"
        spellCheck={false}
        maxLength={USERNAME_MAX_LENGTH + 10}
      />
      <PasswordField
        label="Heslo"
        value={password}
        onChange={setPassword}
        onBlur={() => fields.touch('password')}
        error={fields.visible('password') ? passwordError : null}
        hint="Aspoň 8 znakov."
        autoComplete="new-password"
        maxLength={PASSWORD_MAX_LENGTH}
      />
      <PasswordField
        label="Heslo znova"
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
      <button className="btn btn-primary btn-block" disabled={busy}>
        {busy ? 'Registrujem…' : 'Vytvoriť účet'}
      </button>
    </form>
  );
}

function ForgotForm({ login, onLoginChange, onBack }: { login: string; onLoginChange: (value: string) => void; onBack: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const fields = useFieldTouch<'login'>();
  const loginError = login.trim() ? null : 'Zadaj e-mail alebo hráčske meno';

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    fields.submit();
    if (busy || loginError) {
      return;
    }
    setBusy(true);
    setError(null);
    const response = await emit('auth:forgotPassword', { login: login.trim() });
    setBusy(false);
    if (response.ok) {
      setSent(true);
    } else {
      setError(response.error ?? 'Žiadosť sa nepodarilo odoslať');
    }
  };

  if (sent) {
    return (
      <div className="auth-form">
        <div className="success" role="status">
          Ak účet existuje a má overený e-mail, poslali sme naň odkaz na nastavenie nového hesla. Platí 1 hodinu — pozri aj priečinok so spamom.
        </div>
        <button type="button" className="btn btn-secondary btn-block" onClick={onBack}>
          Späť na prihlásenie
        </button>
      </div>
    );
  }

  return (
    <form className="auth-form" onSubmit={submit} noValidate>
      <p className="hint">Zadaj e-mail alebo hráčske meno. Pošleme ti odkaz, cez ktorý si nastavíš nové heslo.</p>
      <TextField
        label="E-mail alebo hráčske meno"
        value={login}
        onChange={onLoginChange}
        onBlur={() => fields.touch('login')}
        error={fields.visible('login') ? loginError : null}
        autoComplete="username"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        maxLength={EMAIL_MAX_LENGTH}
        autoFocus
      />
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      <button className="btn btn-primary btn-block" disabled={busy}>
        {busy ? 'Odosielam…' : 'Poslať odkaz na nové heslo'}
      </button>
      <button type="button" className="auth-link" onClick={onBack}>
        Späť na prihlásenie
      </button>
    </form>
  );
}
