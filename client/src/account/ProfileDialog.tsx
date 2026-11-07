import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { PASSWORD_MAX_LENGTH, USERNAME_MAX_LENGTH, cleanUsername, validatePassword, validateUsername, type AccountStats, type AccountView } from '../../../shared/account';
import type { Avatar, Currency } from '../../../shared/types';
import { CURRENCIES } from '../../../shared/constants';
import { formatMoney } from '../../../shared/money';
import { AvatarBadge, AvatarPicker } from '../components/AvatarPicker';
import { confirmDialog } from '../components/ConfirmDialog';
import { emit } from '../socket';
import { PasswordField, TextField, confirmError, useFieldTouch } from './fields';
import { compressPhoto, uploadPhoto } from './photo';
import { applyAccount, signOut } from './session';
import { ChangeEmailForm } from './VerifyEmailScreen';
import './account.css';

type ProfileTab = 'profile' | 'security' | 'stats';

const TABS: { id: ProfileTab; label: string }[] = [
  { id: 'profile', label: 'Profil' },
  { id: 'security', label: 'Zabezpečenie' },
  { id: 'stats', label: 'Štatistiky' },
];

interface ProfileDialogProps {
  account: AccountView;
  onClose: () => void;
  initialTab?: ProfileTab;
}

/** Nastavenia účtu: meno, fotka, avatar, heslo, e-mail, odhlásenie a globálne štatistiky. */
export function ProfileDialog({ account, onClose, initialTab = 'profile' }: ProfileDialogProps) {
  const [tab, setTab] = useState<ProfileTab>(initialTab);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Portál do <body> — rovnako ako pomocník, aby fixed modal neuzavrel rodič s backdrop-filter.
  return createPortal(
    <div className="modal-backdrop profile-backdrop" onClick={onClose}>
      <div className="modal modal-wide profile-dialog" role="dialog" aria-modal="true" aria-labelledby="profile-title" onClick={(event) => event.stopPropagation()}>
        <header className="profile-head">
          <AvatarBadge avatar={account.avatar} size={44} />
          <div className="profile-head-text">
            <h2 id="profile-title">{account.username}</h2>
            <span className="muted">{account.email}</span>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Zavrieť">
            ✕
          </button>
        </header>
        <div className="auth-tabs" role="tablist" aria-label="Nastavenia účtu">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              id={`profile-tab-${item.id}`}
              aria-selected={tab === item.id}
              aria-controls="profile-tab-panel"
              className={tab === item.id ? 'auth-tab active' : 'auth-tab'}
              onClick={() => setTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="profile-body" id="profile-tab-panel" role="tabpanel" aria-labelledby={`profile-tab-${tab}`}>
          {tab === 'profile' && <ProfileTabPanel account={account} />}
          {tab === 'security' && <SecurityTabPanel account={account} />}
          {tab === 'stats' && <StatsTabPanel />}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* ===== Profil: fotka, avatar, hráčske meno ===== */

function ProfileTabPanel({ account }: { account: AccountView }) {
  return (
    <div className="profile-sections">
      <PhotoSection account={account} />
      <UsernameSection account={account} />
      <AvatarSection account={account} />
    </div>
  );
}

function PhotoSection({ account }: { account: AccountView }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<'upload' | 'delete' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hasPhoto = !!account.avatar.photo;

  const pick = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) {
      return;
    }
    setBusy('upload');
    setError(null);
    try {
      const photo = await compressPhoto(file);
      const response = await uploadPhoto(photo);
      if (response.ok && response.data) {
        applyAccount(response.data);
      } else {
        setError(response.error ?? 'Fotku sa nepodarilo nahrať');
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Fotku sa nepodarilo spracovať');
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!(await confirmDialog({ title: 'Zmazať profilovú fotku?', message: 'Namiesto nej sa zobrazí tvoj emoji avatar.', confirmLabel: 'Zmazať', danger: true }))) {
      return;
    }
    setBusy('delete');
    setError(null);
    const response = await emit<AccountView>('account:deletePhoto');
    setBusy(null);
    if (response.ok && response.data) {
      applyAccount(response.data);
    } else {
      setError(response.error ?? 'Fotku sa nepodarilo zmazať');
    }
  };

  return (
    <section className="profile-section">
      <h3>Profilová fotka</h3>
      <div className="profile-photo">
        <AvatarBadge avatar={account.avatar} size={96} />
        <div className="profile-photo-actions">
          <p className="hint">Uvidia ju ostatní pri stole namiesto emoji. Zmenšíme ju na štvorec priamo v prehliadači.</p>
          <div className="profile-row-actions">
            <button type="button" className="btn btn-secondary btn-small" disabled={!!busy} onClick={() => inputRef.current?.click()}>
              {busy === 'upload' ? 'Nahrávam…' : hasPhoto ? 'Zmeniť fotku' : 'Nahrať fotku'}
            </button>
            {hasPhoto && (
              <button type="button" className="btn btn-ghost btn-small danger" disabled={!!busy} onClick={() => void remove()}>
                {busy === 'delete' ? 'Mažem…' : 'Zmazať fotku'}
              </button>
            )}
          </div>
          <input ref={inputRef} type="file" accept="image/*" hidden onChange={(event) => void pick(event)} />
        </div>
      </div>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
    </section>
  );
}

function UsernameSection({ account }: { account: AccountView }) {
  const [username, setUsername] = useState(account.username);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const changed = cleanUsername(username) !== account.username;
  const usernameError = changed ? validateUsername(username) : null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !changed || usernameError) {
      return;
    }
    setBusy(true);
    setError(null);
    setSaved(false);
    const response = await emit<AccountView>('account:update', { username: cleanUsername(username) });
    setBusy(false);
    if (response.ok && response.data) {
      applyAccount(response.data);
      setUsername(response.data.username);
      setSaved(true);
    } else {
      setError(response.error ?? 'Meno sa nepodarilo zmeniť');
    }
  };

  return (
    <form className="profile-section" onSubmit={submit} noValidate>
      <h3>Hráčske meno</h3>
      <TextField
        label="Meno pri všetkých stoloch"
        value={username}
        onChange={(value) => {
          setUsername(value);
          setSaved(false);
        }}
        error={usernameError}
        hint={saved ? 'Uložené — zmena sa prejaví pri všetkých tvojich stoloch.' : 'Prihlásiť sa ním môžeš aj namiesto e-mailu.'}
        autoComplete="username"
        autoCorrect="off"
        spellCheck={false}
        maxLength={USERNAME_MAX_LENGTH + 10}
      />
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      <div className="auth-form-actions">
        <button className="btn btn-primary btn-small" disabled={busy || !changed || !!usernameError}>
          {busy ? 'Ukladám…' : 'Uložiť meno'}
        </button>
      </div>
    </form>
  );
}

function AvatarSection({ account }: { account: AccountView }) {
  const [draft, setDraft] = useState<Avatar>({ emoji: account.avatar.emoji, color: account.avatar.color });
  const [error, setError] = useState<string | null>(null);
  /** Poradie požiadaviek — pri rýchlom klikaní platí len odpoveď na posledný výber. */
  const requestRef = useRef(0);

  const change = async (avatar: Avatar) => {
    const next = { emoji: avatar.emoji, color: avatar.color };
    setDraft(next);
    setError(null);
    const request = ++requestRef.current;
    const response = await emit<AccountView>('account:update', { avatar: next });
    if (request !== requestRef.current) {
      return;
    }
    if (response.ok && response.data) {
      applyAccount(response.data);
    } else {
      setError(response.error ?? 'Avatar sa nepodarilo uložiť');
      setDraft({ emoji: account.avatar.emoji, color: account.avatar.color });
    }
  };

  return (
    <section className="profile-section">
      <h3>Emoji avatar</h3>
      <p className="hint">{account.avatar.photo ? 'Zobrazí sa, keď fotku zmažeš.' : 'Zobrazuje sa pri stole, kým nemáš fotku.'}</p>
      <AvatarPicker value={draft} onChange={(avatar) => void change(avatar)} />
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
    </section>
  );
}

/* ===== Zabezpečenie: heslo, e-mail, odhlásenie ===== */

function SecurityTabPanel({ account }: { account: AccountView }) {
  const [emailMessage, setEmailMessage] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);

  const logout = async () => {
    if (!(await confirmDialog({ title: 'Odhlásiť sa z tohto zariadenia?', confirmLabel: 'Odhlásiť sa' }))) {
      return;
    }
    setLeaving(true);
    await signOut();
  };

  return (
    <div className="profile-sections">
      <ChangePasswordSection />
      <section className="profile-section">
        <h3>E-mail</h3>
        <p className="profile-email">
          <strong>{account.email}</strong> <span className={account.emailVerified ? 'badge badge-verified' : 'badge badge-unverified'}>{account.emailVerified ? 'overený' : 'neoverený'}</span>
        </p>
        <p className="hint">Po zmene treba nový e-mail overiť — dovtedy sa nedá hrať.</p>
        {emailMessage && (
          <div className="success" role="status">
            {emailMessage}
          </div>
        )}
        <ChangeEmailForm account={account} onDone={setEmailMessage} />
      </section>
      <section className="profile-section">
        <h3>Odhlásenie</h3>
        <p className="hint">Odhlási len toto zariadenie. Stoly a štatistiky ostávajú v účte.</p>
        <div className="auth-form-actions">
          <button type="button" className="btn btn-danger btn-small" disabled={leaving} onClick={() => void logout()}>
            {leaving ? 'Odhlasujem…' : 'Odhlásiť sa'}
          </button>
        </div>
      </section>
    </div>
  );
}

function ChangePasswordSection() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const fields = useFieldTouch<'current' | 'password' | 'confirm'>();
  const currentError = currentPassword ? null : 'Zadaj súčasné heslo';
  const passwordError = validatePassword(password, password) ?? (password && password === currentPassword ? 'Nové heslo je rovnaké ako súčasné' : null);
  const passwordConfirmError = confirmError(password, passwordConfirm);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    fields.submit();
    if (busy || currentError || passwordError || passwordConfirmError) {
      return;
    }
    setBusy(true);
    setError(null);
    setDone(false);
    const response = await emit('account:changePassword', { currentPassword, password, passwordConfirm });
    setBusy(false);
    if (response.ok) {
      setCurrentPassword('');
      setPassword('');
      setPasswordConfirm('');
      fields.reset();
      setDone(true);
    } else {
      setError(response.error ?? 'Heslo sa nepodarilo zmeniť');
    }
  };

  return (
    <form className="profile-section" onSubmit={submit} noValidate>
      <h3>Zmena hesla</h3>
      <PasswordField
        label="Súčasné heslo"
        value={currentPassword}
        onChange={setCurrentPassword}
        onBlur={() => fields.touch('current')}
        error={fields.visible('current') ? currentError : null}
        autoComplete="current-password"
        maxLength={PASSWORD_MAX_LENGTH}
      />
      <PasswordField
        label="Nové heslo"
        value={password}
        onChange={setPassword}
        onBlur={() => fields.touch('password')}
        error={fields.visible('password') ? passwordError : null}
        hint="Aspoň 8 znakov."
        autoComplete="new-password"
        maxLength={PASSWORD_MAX_LENGTH}
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
      {done && (
        <div className="success" role="status">
          Heslo je zmenené. Ostatné zariadenia boli odhlásené.
        </div>
      )}
      <div className="auth-form-actions">
        <button className="btn btn-primary btn-small" disabled={busy}>
          {busy ? 'Ukladám…' : 'Zmeniť heslo'}
        </button>
      </div>
    </form>
  );
}

/* ===== Štatistiky ===== */

const dateFormat = new Intl.DateTimeFormat('sk-SK', { day: 'numeric', month: 'numeric', year: 'numeric' });
const numberFormat = new Intl.NumberFormat('sk-SK');
const percentFormat = new Intl.NumberFormat('sk-SK', { maximumFractionDigits: 1 });

function perCurrency(values: Partial<Record<Currency, number>>, sign: boolean): string {
  const parts = CURRENCIES.filter((currency) => values[currency] !== undefined).map((currency) => formatMoney(values[currency]!, currency, { sign }));
  return parts.length ? parts.join(' · ') : '—';
}

/** Slovenské tvary podľa počtu: 1 ruka, 2–4 ruky, 0 / 5+ rúk. */
function plural(count: number, one: string, few: string, many: string): string {
  const word = count === 1 ? one : count >= 2 && count <= 4 ? few : many;
  return `${numberFormat.format(count)} ${word}`;
}

function resultClass(value: number): string {
  return value > 0 ? 'stat-positive' : value < 0 ? 'stat-negative' : '';
}

function StatsTabPanel() {
  const [stats, setStats] = useState<AccountStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setError(null);
    void emit<AccountStats>('account:stats').then((response) => {
      if (!active) {
        return;
      }
      if (response.ok && response.data) {
        setStats(response.data);
      } else {
        setError(response.error ?? 'Štatistiky sa nepodarilo načítať');
      }
    });
    return () => {
      active = false;
    };
  }, [attempt]);

  if (error) {
    return (
      <div className="profile-sections">
        <div className="error" role="alert">
          {error}
        </div>
        <button type="button" className="btn btn-secondary btn-small" onClick={() => setAttempt((value) => value + 1)}>
          Skúsiť znova
        </button>
      </div>
    );
  }
  if (!stats) {
    return <p className="muted profile-loading">Načítavam štatistiky…</p>;
  }

  const { global, tables } = stats;
  const resultCurrencies = CURRENCIES.filter((currency) => global.result[currency] !== undefined);
  return (
    <div className="profile-sections">
      <dl className="profile-stats-grid">
        <div>
          <dt>Stoly</dt>
          <dd>{numberFormat.format(global.tables)}</dd>
        </div>
        <div>
          <dt>Odohrané ruky</dt>
          <dd>{numberFormat.format(global.handsPlayed)}</dd>
        </div>
        <div>
          <dt>Vyhrané ruky</dt>
          <dd>{numberFormat.format(global.handsWon)}</dd>
        </div>
        <div>
          <dt>Úspešnosť</dt>
          <dd>{percentFormat.format(global.winRate)} %</dd>
        </div>
        <div>
          <dt>Najväčší pot</dt>
          <dd>{perCurrency(global.biggestPot, false)}</dd>
        </div>
        <div>
          <dt>Celkový výsledok</dt>
          <dd>
            {resultCurrencies.length === 0
              ? '—'
              : resultCurrencies.map((currency, index) => (
                  <span key={currency} className={resultClass(global.result[currency]!)}>
                    {index > 0 && ' · '}
                    {formatMoney(global.result[currency]!, currency, { sign: true })}
                  </span>
                ))}
          </dd>
        </div>
      </dl>

      <section className="profile-section">
        <h3>Podľa stolov</h3>
        {tables.length === 0 ? (
          <p className="muted">Zatiaľ si nehral pri žiadnom stole.</p>
        ) : (
          <ul className="profile-table-list">
            {tables.map((table) => (
              <li key={table.code} className="profile-table-row">
                <div className="profile-table-main">
                  <span className="profile-table-name" title={table.tableName}>
                    {table.tableName}
                  </span>
                  <span className="profile-table-meta">
                    <span className="table-code-chip">{table.code}</span>
                    {table.archived && <span className="badge">archív</span>}
                    {table.deleted && <span className="badge badge-deleted">zmazaný</span>}
                    {table.lastPlayed > 0 && <time dateTime={new Date(table.lastPlayed).toISOString()}>{dateFormat.format(table.lastPlayed)}</time>}
                  </span>
                </div>
                <div className="profile-table-numbers">
                  <span className={`profile-table-result ${resultClass(table.result)}`}>{formatMoney(table.result, table.currency, { sign: true })}</span>
                  <span className="muted">
                    {plural(table.handsPlayed, 'ruka', 'ruky', 'rúk')} · {plural(table.handsWon, 'výhra', 'výhry', 'výhier')}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
