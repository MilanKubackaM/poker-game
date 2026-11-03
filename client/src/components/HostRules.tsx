import { useEffect, useState } from 'react';
import type { Currency, TableSettings, TableView, Variant } from '../../../shared/types';
import { CURRENCIES, CURRENCY_LABELS, DEFAULT_SETTINGS, MAX_TABLE_NAME_LENGTH, TIME_BANK_MAX_SEC, TIME_BANK_MIN_SEC, VARIANT_LABELS } from '../../../shared/constants';
import { checkMoneyRules, moneyRulesDraft, type MoneyRulesDraft } from '../moneyRules';
import type { HostActions } from './HostPanel';
import { MoneyInput } from './MoneyInput';

interface RulesFormProps {
  view: TableView;
  actions: Pick<HostActions, 'saveSettings'>;
}

/** Formulár pravidiel stola (mena, blindy, variant, 7-2, čas na ťah). */
export function RulesForm({ view, actions }: RulesFormProps) {
  const [draft, setDraft] = useState<TableSettings>(view.settings);
  const [money, setMoney] = useState<MoneyRulesDraft>(() => moneyRulesDraft(view.settings));
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [timeBankText, setTimeBankText] = useState(String(view.settings.timeBankSec ?? DEFAULT_SETTINGS.timeBankSec));
  const settingsKey = JSON.stringify(view.settings);
  useEffect(() => {
    setDraft(view.settings);
    setMoney(moneyRulesDraft(view.settings));
    setTimeBankText(String(view.settings.timeBankSec ?? DEFAULT_SETTINGS.timeBankSec));
  }, [settingsKey]);
  const timeBankSec = Number(timeBankText);
  const timeBankValid = /^\d+$/.test(timeBankText.trim()) && timeBankSec >= TIME_BANK_MIN_SEC && timeBankSec <= TIME_BANK_MAX_SEC;

  const { values, errors } = checkMoneyRules(money, draft.currency);
  const name = (draft.name ?? '').replace(/\s+/g, ' ').trim();
  const setMoneyField = (key: keyof MoneyRulesDraft) => (text: string) => {
    setMoney((current) => ({ ...current, [key]: text }));
    setMessage(null);
  };

  const save = async () => {
    if (!values || !name || !timeBankValid) {
      return;
    }
    const error = await actions.saveSettings({ ...draft, ...values, name, timeBankSec });
    setMessage(error ? { ok: false, text: error } : { ok: true, text: view.phase === 'playing' ? 'Uložené — platí od ďalšej ruky' : 'Uložené' });
  };

  const moneyField = (key: keyof MoneyRulesDraft, label: string, hint?: string) => (
    <label className="field">
      <span>{label}</span>
      <MoneyInput value={money[key]} onChange={setMoneyField(key)} currency={draft.currency} invalid={!!errors[key]} />
      {errors[key] ? <small className="field-error">{errors[key]}</small> : hint && <small className="field-hint">{hint}</small>}
    </label>
  );

  return (
    <div className="stack-gap">
      <section className="host-section">
        <h3>Stôl</h3>
        <label className="field">
          <span>Názov stola</span>
          <input
            value={draft.name ?? ''}
            maxLength={MAX_TABLE_NAME_LENGTH}
            placeholder="napr. Piatkový poker"
            aria-invalid={!name || undefined}
            className={name ? undefined : 'invalid'}
            onChange={(event) => {
              setDraft({ ...draft, name: event.target.value });
              setMessage(null);
            }}
          />
          {!name && <small className="field-error">Zadaj názov stola</small>}
        </label>
      </section>
      <section className="host-section">
        <h3>Mena a blindy</h3>
        <label className="field">
          <span>Mena</span>
          <select value={draft.currency} onChange={(event) => setDraft({ ...draft, currency: event.target.value as Currency })}>
            {CURRENCIES.map((key) => (
              <option key={key} value={key}>
                {CURRENCY_LABELS[key]}
              </option>
            ))}
          </select>
        </label>
        <div className="field-row">
          {moneyField('smallBlind', 'Small blind')}
          {moneyField('bigBlind', 'Big blind')}
        </div>
      </section>
      <section className="host-section">
        <h3>Variant a pravidlá</h3>
        <label className="field">
          <span>Predvolený variant</span>
          <select value={draft.defaultVariant} onChange={(event) => setDraft({ ...draft, defaultVariant: event.target.value as Variant })}>
            {(Object.keys(VARIANT_LABELS) as Variant[]).map((key) => (
              <option key={key} value={key}>
                {VARIANT_LABELS[key]}
              </option>
            ))}
          </select>
        </label>
        <label className="toggle">
          <input type="checkbox" checked={draft.omahaPotLimit} onChange={(event) => setDraft({ ...draft, omahaPotLimit: event.target.checked })} />
          <span>Omaha ako pot-limit</span>
        </label>
        <label className="toggle">
          <input type="checkbox" checked={draft.sevenDeuceAlways} onChange={(event) => setDraft({ ...draft, sevenDeuceAlways: event.target.checked })} />
          <span>Pravidlo 7-2 vždy zapnuté</span>
        </label>
        {moneyField('sevenDeuceBounty', '7-2 bonus od každého hráča')}
        <label className="field">
          <span>
            Timebank na začiatku ({TIME_BANK_MIN_SEC}–{TIME_BANK_MAX_SEC} s)
          </span>
          <input
            type="number"
            min={TIME_BANK_MIN_SEC}
            max={TIME_BANK_MAX_SEC}
            step={1}
            inputMode="numeric"
            value={timeBankText}
            aria-invalid={!timeBankValid || undefined}
            className={timeBankValid ? undefined : 'invalid'}
            onChange={(event) => {
              setTimeBankText(event.target.value);
              setMessage(null);
            }}
          />
          {!timeBankValid && (
            <small className="field-error">
              Timebank musí byť {TIME_BANK_MIN_SEC}–{TIME_BANK_MAX_SEC} s
            </small>
          )}
        </label>
      </section>
      {message && <div className={message.ok ? 'success' : 'error'}>{message.text}</div>}
      <button type="button" className="btn btn-primary btn-block" onClick={save} disabled={!values || !name || !timeBankValid}>
        Uložiť pravidlá
      </button>
    </div>
  );
}
