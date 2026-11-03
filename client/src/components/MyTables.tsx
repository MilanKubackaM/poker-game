import type { TableSummary } from '../../../shared/types';
import { formatMoney } from '../../../shared/money';
import { confirmDialog } from './ConfirmDialog';

const relativeFormat = new Intl.RelativeTimeFormat('sk', { numeric: 'auto' });
const dateFormat = new Intl.DateTimeFormat('sk-SK', { day: 'numeric', month: 'numeric', year: 'numeric' });

/** „pred 5 minútami“, „včera“, … ; staršie ako mesiac ako dátum. */
export function relativeTime(at: number, now = Date.now()): string {
  const seconds = Math.round((at - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) {
    return 'práve teraz';
  }
  if (abs < 3600) {
    return relativeFormat.format(Math.round(seconds / 60), 'minute');
  }
  if (abs < 86_400) {
    return relativeFormat.format(Math.round(seconds / 3600), 'hour');
  }
  if (abs < 30 * 86_400) {
    return relativeFormat.format(Math.round(seconds / 86_400), 'day');
  }
  return dateFormat.format(at);
}

function phaseLabel(summary: TableSummary): { text: string; className: string } {
  if (summary.phase === 'lobby') {
    return { text: 'Čakáreň', className: 'phase-pill phase-lobby' };
  }
  if (summary.phase === 'draw') {
    return { text: 'Losovanie', className: 'phase-pill phase-live' };
  }
  return summary.paused ? { text: 'Pozastavené', className: 'phase-pill phase-paused' } : { text: 'Hrá sa', className: 'phase-pill phase-live' };
}

function handsLabel(count: number): string {
  if (count === 0) {
    return 'zatiaľ bez rúk';
  }
  if (count === 1) {
    return '1 ruka';
  }
  return count < 5 ? `${count} ruky` : `${count} rúk`;
}

interface MyTablesProps {
  summaries: TableSummary[];
  /** Kódy stolov, od ktorých som odišiel cez „Odísť od stola“ (žetóny mi tam ostali uložené). */
  leftCodes?: string[];
  /** Chyba návratu ku konkrétnemu stolu (napr. plný stôl) — ukáže sa na jeho karte. */
  errors?: Record<string, string>;
  busyCode: string | null;
  onResume: (code: string) => void;
  onForget: (code: string) => void;
}

/** Stoly, ktoré som v tomto prehliadači založil alebo ku ktorým som si prisadol. */
export function MyTables({ summaries, leftCodes = [], errors = {}, busyCode, onResume, onForget }: MyTablesProps) {
  if (summaries.length === 0) {
    return null;
  }
  const forget = async (summary: TableSummary) => {
    const kept = leftCodes.includes(summary.code) && summary.myStack > 0
      ? ` Tvoje uložené žetóny ${formatMoney(summary.myStack, summary.currency)} ostanú pri stole, ale bez tohto prehliadača sa k nim už nevrátiš.`
      : ' Stôl ostane na serveri, len sa k nemu odtiaľto už nevrátiš bez pozvánky.';
    if (await confirmDialog({ title: `Zabudnúť stôl „${summary.name}“ v tomto prehliadači?`, message: kept.trim(), confirmLabel: 'Zabudnúť', danger: true })) {
      onForget(summary.code);
    }
  };
  return (
    <section className="panel my-tables" aria-label="Moje stoly">
      <div className="my-tables-head">
        <h2>Moje stoly</h2>
        <span className="muted">{summaries.length}</span>
      </div>
      <div className="my-tables-grid">
        {summaries.map((summary) => {
          const phase = phaseLabel(summary);
          const busy = busyCode === summary.code;
          const left = leftCodes.includes(summary.code);
          const error = errors[summary.code] ?? null;
          const stack = formatMoney(summary.myStack, summary.currency);
          return (
            <article key={summary.code} className={left ? 'my-table my-table-left' : 'my-table'}>
              <header className="my-table-head">
                <div className="my-table-title">
                  <h3 title={summary.name}>{summary.name}</h3>
                  <span className="my-table-sub">
                    <span className="table-code-chip">{summary.code}</span>
                    <time dateTime={new Date(summary.lastActivity).toISOString()} title="Posledná aktivita">
                      {relativeTime(summary.lastActivity)}
                    </time>
                  </span>
                </div>
                {left ? <span className="badge badge-left">Mimo stola</span> : summary.myIsAdmin && <span className="badge badge-host">Si host</span>}
              </header>
              <div className="my-table-status">
                <span className={phase.className}>{phase.text}</span>
                <span>{handsLabel(summary.handNumber)}</span>
                <span>
                  <span className={summary.onlineCount > 0 ? 'dot dot-live dot-small' : 'dot dot-small'} /> {summary.onlineCount}/{summary.playerCount} online
                </span>
              </div>
              {left && (
                <p className="my-table-note">
                  {summary.myStack > 0 ? (
                    <>
                      Nie si pri stole — tvoje žetóny <strong>{stack}</strong> sú uložené a čakajú na teba.
                    </>
                  ) : (
                    'Nie si pri stole — žetóny ti po návrate dobije bankár.'
                  )}
                </p>
              )}
              <dl className="my-table-facts">
                <div>
                  <dt>{left ? 'Uložené žetóny' : 'Môj stack'}</dt>
                  <dd className="my-table-stack">{stack}</dd>
                </div>
                <div>
                  <dt>Host</dt>
                  <dd>{summary.hostName}</dd>
                </div>
              </dl>
              {error && (
                <div className="error my-table-error" role="alert">
                  {error}
                </div>
              )}
              <div className="my-table-actions">
                <button type="button" className="btn btn-primary" disabled={!!busyCode} onClick={() => onResume(summary.code)}>
                  {busy ? 'Pripájam…' : 'Pokračovať'}
                </button>
                <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => forget(summary)}>
                  Zabudnúť
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
