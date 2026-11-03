import type { Currency } from '../../../shared/types';

export const CURRENCY_SYMBOLS: Record<Currency, string> = {
  EUR: '€',
  CZK: 'Kč',
};

interface MoneyInputProps {
  value: string;
  onChange: (text: string) => void;
  currency: Currency;
  invalid?: boolean;
  placeholder?: string;
  className?: string;
  ariaLabel?: string;
  onBlur?: () => void;
}

/** Textové pole na sumu v mene stola (desatinná čiarka aj bodka) — žiadny natívny validátor neblokuje platnú sumu. */
export function MoneyInput({ value, onChange, currency, invalid, placeholder, className, ariaLabel, onBlur }: MoneyInputProps) {
  return (
    <span className={['money-input', className].filter(Boolean).join(' ')}>
      <input
        type="text"
        inputMode="decimal"
        autoComplete="off"
        value={value}
        placeholder={placeholder}
        aria-invalid={invalid || undefined}
        aria-label={ariaLabel}
        className={invalid ? 'invalid' : undefined}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
      />
      <span className="money-suffix" aria-hidden>
        {CURRENCY_SYMBOLS[currency]}
      </span>
    </span>
  );
}
