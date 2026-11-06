import { useCallback, useState, type FormEvent } from 'react';
import type { Currency, TableSettings, TableSummary, Variant } from '../../../shared/types';
import { CURRENCIES, CURRENCY_LABELS, DEFAULT_SETTINGS, MAX_NAME_LENGTH, MAX_TABLE_NAME_LENGTH, VARIANT_LABELS } from '../../../shared/constants';
import { promptInstall, useInstallOffer } from '../install';
import type { InstallGuideId } from '../installGuide';
import { InstallGuideDialog } from './InstallGuide';
import { checkMoneyRules, moneyRulesDraft, type MoneyRulesDraft } from '../moneyRules';
import type { Profile } from '../storage';
import { AvatarPicker } from './AvatarPicker';
import { MoneyInput } from './MoneyInput';
import { MyTables } from './MyTables';
import { VersionTag } from './UpdateBanner';

/** Oznámenie na úvodnej obrazovke — napr. po odchode od stola alebo keď stôl niekto zmazal. */
export interface LobbyNotice {
  text: string;
  tone: 'info' | 'danger';
}

interface LobbyProps {
  profile: Profile;
  onProfileChange: (profile: Profile) => void;
  inviteCode: string | null;
  busy: boolean;
  error: string | null;
  onCreate: (settings: Partial<TableSettings>) => void;
  onJoin: (code: string) => void;
  onCancelInvite: () => void;
  /** Uložené stoly s prehľadom zo servera; prázdne = sekcia sa nezobrazí. */
  myTables?: TableSummary[];
  resumingCode?: string | null;
  onResumeTable?: (code: string) => void;
  onForgetTable?: (code: string) => void;
  /** Kódy stolov, od ktorých som odišiel (žetóny ostali uložené). */
  leftTables?: string[];
  /** Chyby návratu ku stolu podľa kódu (napr. plný stôl). */
  tableErrors?: Record<string, string>;
  notice?: LobbyNotice | null;
  onDismissNotice?: () => void;
}

export function Lobby(props: LobbyProps) {
  const { profile, onProfileChange, inviteCode, busy, error, onCreate, onJoin, onCancelInvite, myTables = [], resumingCode = null, onResumeTable, onForgetTable, leftTables, tableErrors, notice = null, onDismissNotice } = props;
  const installOffer = useInstallOffer();
  const [installGuide, setInstallGuide] = useState<InstallGuideId | null>(null);
  const closeInstallGuide = useCallback(() => setInstallGuide(null), []);
  const [code, setCode] = useState('');
  const [tableName, setTableName] = useState('');
  const [currency, setCurrency] = useState<Currency>(DEFAULT_SETTINGS.currency);
  const [money, setMoney] = useState<MoneyRulesDraft>(() => moneyRulesDraft(DEFAULT_SETTINGS));
  const [variant, setVariant] = useState<Variant>(DEFAULT_SETTINGS.defaultVariant);
  const nameMissing = !profile.name.trim();
  const { values, errors } = checkMoneyRules(money, currency);
  const setMoneyField = (key: keyof MoneyRulesDraft) => (text: string) => setMoney((current) => ({ ...current, [key]: text }));

  const submitCreate = (event: FormEvent) => {
    event.preventDefault();
    if (!values) {
      return;
    }
    const { smallBlind, bigBlind } = values;
    const name = tableName.replace(/\s+/g, ' ').trim();
    onCreate({ ...(name ? { name } : {}), currency, smallBlind, bigBlind, defaultVariant: variant, sevenDeuceBounty: bigBlind * 2 });
  };

  const submitJoin = (event: FormEvent) => {
    event.preventDefault();
    onJoin(inviteCode ?? code.trim().toUpperCase());
  };

  return (
    <div className="lobby">
      <header className="lobby-hero">
        <div className="brand-chip" aria-hidden>♠</div>
        <h1>Poker Night</h1>
        <p>Súkromný poker stôl pre partiu kamarátov — s kamerami, žetónmi a pravidlami podľa vás.</p>
      </header>

      {installOffer?.kind === 'open' && (
        <a className="lobby-install" href={window.location.href} target="_blank" rel="noopener">
          <img className="lobby-install-icon" src="/icons/icon-192.png" alt="" width={48} height={48} />
          <span>Otvor v aplikácii</span>
        </a>
      )}
      {(installOffer?.kind === 'prompt' || installOffer?.kind === 'manual') && (
        <button
          type="button"
          className="lobby-install"
          aria-haspopup={installOffer.kind === 'manual' ? 'dialog' : undefined}
          onClick={() => (installOffer.kind === 'prompt' ? void promptInstall() : setInstallGuide(installOffer.guide))}
        >
          <img className="lobby-install-icon" src="/icons/icon-192.png" alt="" width={48} height={48} />
          <span>Nainštalovať ako aplikáciu</span>
        </button>
      )}
      {installGuide && <InstallGuideDialog guide={installGuide} onClose={closeInstallGuide} />}

      {notice && (
        <div className={notice.tone === 'danger' ? 'lobby-notice lobby-notice-danger' : 'lobby-notice'} role="status">
          <span className="lobby-notice-text">{notice.text}</span>
          {onDismissNotice && (
            <button type="button" className="icon-btn" onClick={onDismissNotice} aria-label="Zavrieť oznámenie">
              ✕
            </button>
          )}
        </div>
      )}

      <section className="panel lobby-profile">
        <h2>Kto si?</h2>
        <label className="field">
          <span>Prezývka</span>
          <input
            value={profile.name}
            maxLength={MAX_NAME_LENGTH}
            placeholder="napr. Milan"
            onChange={(event) => onProfileChange({ ...profile, name: event.target.value })}
            autoFocus
          />
        </label>
        <AvatarPicker value={profile.avatar} onChange={(avatar) => onProfileChange({ ...profile, avatar })} />
      </section>

      {inviteCode ? (
        <section className="panel lobby-invite">
          <h2>Pozvánka ku stolu</h2>
          <div className="table-code-big">{inviteCode}</div>
          {error && <div className="error">{error}</div>}
          <form onSubmit={submitJoin}>
            <button className="btn btn-primary btn-block" disabled={busy || nameMissing}>
              {busy ? 'Odosielam žiadosť…' : 'Požiadať o prístup ku stolu'}
            </button>
          </form>
          <button type="button" className="btn btn-ghost btn-block" onClick={onCancelInvite}>
            Založiť vlastný stôl
          </button>
        </section>
      ) : (
        <>
        {onResumeTable && onForgetTable && (
          <MyTables summaries={myTables} leftCodes={leftTables} errors={tableErrors} busyCode={resumingCode} onResume={onResumeTable} onForget={onForgetTable} />
        )}
        <div className="lobby-actions">
          <form className="panel" onSubmit={submitCreate}>
            <h2>Založiť stôl</h2>
            <label className="field">
              <span>Názov stola</span>
              <input
                value={tableName}
                maxLength={MAX_TABLE_NAME_LENGTH}
                placeholder="napr. Piatkový poker"
                onChange={(event) => setTableName(event.target.value)}
              />
            </label>
            <label className="field">
              <span>Mena</span>
              <select value={currency} onChange={(event) => setCurrency(event.target.value as Currency)}>
                {CURRENCIES.map((key) => (
                  <option key={key} value={key}>
                    {CURRENCY_LABELS[key]}
                  </option>
                ))}
              </select>
            </label>
            <div className="field-row">
              <label className="field">
                <span>Small blind</span>
                <MoneyInput value={money.smallBlind} onChange={setMoneyField('smallBlind')} currency={currency} invalid={!!errors.smallBlind} />
                {errors.smallBlind && <small className="field-error">{errors.smallBlind}</small>}
              </label>
              <label className="field">
                <span>Big blind</span>
                <MoneyInput value={money.bigBlind} onChange={setMoneyField('bigBlind')} currency={currency} invalid={!!errors.bigBlind} />
                {errors.bigBlind && <small className="field-error">{errors.bigBlind}</small>}
              </label>
            </div>
            <label className="field">
              <span>Predvolený variant</span>
              <select value={variant} onChange={(event) => setVariant(event.target.value as Variant)}>
                {(Object.keys(VARIANT_LABELS) as Variant[]).map((key) => (
                  <option key={key} value={key}>
                    {VARIANT_LABELS[key]}
                  </option>
                ))}
              </select>
            </label>
            {error && <div className="error">{error}</div>}
            <button className="btn btn-primary btn-block" disabled={busy || nameMissing || !values}>
              {busy ? 'Zakladám…' : 'Založiť stôl a pozvať kamarátov'}
            </button>
          </form>

          <form className="panel" onSubmit={submitJoin}>
            <h2>Pripojiť sa</h2>
            <label className="field">
              <span>Kód stola</span>
              <input
                className="code-input"
                value={code}
                maxLength={6}
                placeholder="ABC123"
                onChange={(event) => setCode(event.target.value.toUpperCase())}
              />
            </label>
            <button className="btn btn-secondary btn-block" disabled={busy || nameMissing || code.trim().length < 4}>
              Pripojiť sa ku stolu
            </button>
          </form>
        </div>
        </>
      )}
      <footer className="lobby-footer">
        <VersionTag />
      </footer>
    </div>
  );
}
