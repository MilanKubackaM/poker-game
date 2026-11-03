import type { Currency } from './types';

const formatters = new Map<string, Intl.NumberFormat>();

function formatter(currency: Currency, fractionDigits: number): Intl.NumberFormat {
  const key = `${currency}:${fractionDigits}`;
  let cached = formatters.get(key);
  if (!cached) {
    cached = new Intl.NumberFormat('sk-SK', {
      style: 'currency',
      currency,
      currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    });
    formatters.set(key, cached);
  }
  return cached;
}

/** 1050 (centy) → „10,50 €"; celé sumy bez desatinných miest: 2000 → „20 €". */
export function formatMoney(cents: number, currency: Currency, options: { sign?: boolean } = {}): string {
  const text = formatter(currency, cents % 100 === 0 ? 0 : 2).format(Math.abs(cents) / 100);
  if (cents < 0) {
    return `−${text}`;
  }
  return options.sign && cents > 0 ? `+${text}` : text;
}

/** Hodnota pre `<input>`: 1050 → „10.50", 2000 → „20". */
export function centsToInput(cents: number): string {
  return cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);
}

/** Parsuje „0,10", „0.1", „20", „1 000,50" na centy; null pri neplatnom vstupe alebo viac ako 2 desatinných miestach. */
export function parseMoney(input: string): number | null {
  const normalized = input.replace(/[\s ]/g, '').replace(',', '.');
  if (!/^-?\d+(\.\d{0,2})?$/.test(normalized)) {
    return null;
  }
  const cents = Math.round(Number(normalized) * 100);
  return Number.isSafeInteger(cents) ? cents : null;
}
