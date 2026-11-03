/** Farby hráčov v grafoch — pevné poradie (overené pre farbosleposť na tmavom pozadí stránky). */
export const SERIES_COLORS = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];

export const STATUS = {
  good: '#0ca30c',
  warning: '#fab219',
  critical: '#d03b3b',
};

const decimal = new Intl.NumberFormat('sk-SK', { maximumFractionDigits: 1 });
const integer = new Intl.NumberFormat('sk-SK', { maximumFractionDigits: 0 });

export function formatNumber(value: number, digits = 1): string {
  return digits === 0 ? integer.format(value) : decimal.format(value);
}

export function formatKbps(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return '–';
  }
  if (value >= 1000) {
    return `${decimal.format(value / 1000)} Mb/s`;
  }
  return `${integer.format(value)} kb/s`;
}

/** Bajty v desiatkových jednotkách (ako účtuje Cloudflare: 1 GB = 10⁹ B). */
export function formatBytes(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return '–';
  }
  if (value >= 1e9) {
    return `${decimal.format(value / 1e9)} GB`;
  }
  if (value >= 1e6) {
    return `${decimal.format(value / 1e6)} MB`;
  }
  return `${integer.format(value / 1e3)} kB`;
}

export function formatMs(value: number | null | undefined): string {
  return value === null || value === undefined ? '–' : `${integer.format(value)} ms`;
}

export function formatPct(value: number | null | undefined): string {
  return value === null || value === undefined ? '–' : `${decimal.format(value)} %`;
}

export function formatTime(t: number, seconds = true): string {
  return new Date(t).toLocaleTimeString('sk-SK', { hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}) });
}

export function formatDateTime(t: number): string {
  return new Date(t).toLocaleString('sk-SK', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** Hodnota pre `<input type="datetime-local">` v miestnom čase. */
export function toLocalInput(t: number): string {
  const date = new Date(t - new Date(t).getTimezoneOffset() * 60_000);
  return date.toISOString().slice(0, 16);
}

export function fromLocalInput(value: string): number | null {
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

/** „Pekné“ horné maximum osi: 1, 2, 2.5, 5 × 10^n. */
export function niceMax(value: number): number {
  if (value <= 0) {
    return 1;
  }
  const power = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (value <= step * power) {
      return step * power;
    }
  }
  return 10 * power;
}
