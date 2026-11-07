import { useState } from 'react';
import type { ArchivedTableSummary } from '../../../shared/account';
import type { TableSummary } from '../../../shared/types';
import { formatMoney } from '../../../shared/money';

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

/** `claimingCode` počas „Prevziať všetky“. */
const CLAIM_ALL = '*';

interface MyTablesProps {
  /** Stoly môjho účtu, pri ktorých sa dá hrať ďalej. */
  active: TableSummary[];
  /** Stoly spred účtov (len na čítanie) — prevzaté do účtu aj tie, ku ktorým má tento prehliadač starý token. */
  archived: ArchivedTableSummary[];
  /** Kód stola, ku ktorému sa práve pripájam. */
  resumingCode: string | null;
  /** Chyba pri konkrétnom stole (návrat, prevzatie archívu) — ukáže sa na jeho karte. */
  tableErrors?: Record<string, string>;
  onResume: (code: string) => void;
  onOpenArchive: (code: string) => void;
  onClaim: (code: string) => void;
  onClaimAll?: () => void;
  /** Kód stola, ktorý sa práve preberá do účtu (`'*'` = všetky naraz) — kým beží, ostatné prevzatia čakajú. */
  claimingCode?: string | null;
}

/** Stoly môjho účtu a archív stolov spred účtov. Keď nie je ani jedno, nevykreslí nič. */
export function MyTables({ active, archived, resumingCode, tableErrors = {}, onResume, onOpenArchive, onClaim, onClaimAll, claimingCode = null }: MyTablesProps) {
  const unclaimed = archived.filter((table) => !table.claimed).length;
  // Archív je otvorený, keď v ňom čaká niečo na prevzatie alebo keď je to jediné, čo tu je.
  const [archiveOpen, setArchiveOpen] = useState(() => active.length === 0 || unclaimed > 0);
  if (active.length === 0 && archived.length === 0) {
    return null;
  }
  return (
    <section className="panel my-tables" aria-label="Moje stoly">
      <div className="my-tables-head">
        <h2>Moje stoly</h2>
        {active.length > 0 && <span className="muted">{active.length}</span>}
      </div>
      {active.length > 0 && (
        <div className="my-tables-grid">
          {active.map((summary) => (
            <ActiveTableCard key={summary.code} summary={summary} resumingCode={resumingCode} error={tableErrors[summary.code] ?? null} onResume={onResume} />
          ))}
        </div>
      )}
      {archived.length > 0 && (
        <div className="my-tables-archive">
          <button type="button" className="my-tables-archive-toggle" aria-expanded={archiveOpen} onClick={() => setArchiveOpen(!archiveOpen)}>
            <span className="my-tables-archive-caret" aria-hidden>
              {archiveOpen ? '▾' : '▸'}
            </span>
            <span className="my-tables-archive-title">Archív (pred účtami)</span>
            <span className="muted">{archived.length}</span>
            {unclaimed > 0 && <span className="badge badge-pending">{unclaimed} na prevzatie</span>}
          </button>
          {archiveOpen && (
            <>
              <p className="my-tables-archive-note">
                Stoly z čias pred účtami sú len na čítanie — dá sa pozrieť leaderboard, história, transakcie aj vyúčtovanie. Po prevzatí do účtu sa započítajú do tvojich štatistík a uvidíš ich na všetkých
                svojich zariadeniach.
              </p>
              {unclaimed >= 2 && onClaimAll && (
                <div className="my-tables-archive-actions">
                  <button type="button" className="btn btn-secondary btn-small" disabled={!!claimingCode} onClick={onClaimAll}>
                    {claimingCode === CLAIM_ALL ? 'Preberám všetky…' : `Prevziať všetky (${unclaimed})`}
                  </button>
                </div>
              )}
              <div className="my-tables-grid">
                {archived.map((table) => (
                  <ArchivedTableCard key={table.code} table={table} claimingCode={claimingCode} error={tableErrors[table.code] ?? null} onOpen={onOpenArchive} onClaim={onClaim} />
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}

function ActiveTableCard({ summary, resumingCode, error, onResume }: { summary: TableSummary; resumingCode: string | null; error: string | null; onResume: (code: string) => void }) {
  const phase = phaseLabel(summary);
  const busy = resumingCode === summary.code;
  const left = !!summary.left;
  const stack = formatMoney(summary.myStack, summary.currency);
  return (
    <article className={left ? 'my-table my-table-left' : 'my-table'}>
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
              Odišiel si — žetóny ostali uložené: <strong>{stack}</strong>.
            </>
          ) : (
            'Odišiel si — žetóny ti po návrate dobije bankár.'
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
        <button type="button" className="btn btn-primary" disabled={!!resumingCode} onClick={() => onResume(summary.code)}>
          {busy ? 'Pripájam…' : left ? 'Vrátiť sa' : 'Pokračovať'}
        </button>
      </div>
    </article>
  );
}

function ArchivedTableCard({ table, claimingCode, error, onOpen, onClaim }: { table: ArchivedTableSummary; claimingCode: string | null; error: string | null; onOpen: (code: string) => void; onClaim: (code: string) => void }) {
  const resultClass = table.myResult > 0 ? 'ledger-pos' : table.myResult < 0 ? 'ledger-neg' : 'muted';
  return (
    <article className="my-table my-table-archived">
      <header className="my-table-head">
        <div className="my-table-title">
          <h3 title={table.name}>{table.name}</h3>
          <span className="my-table-sub">
            <span className="table-code-chip">{table.code}</span>
            <time dateTime={new Date(table.lastActivity).toISOString()} title="Posledná aktivita">
              {dateFormat.format(table.lastActivity)}
            </time>
          </span>
        </div>
        {table.claimed ? <span className="badge badge-cohost">V účte</span> : <span className="badge badge-muted">Len v tomto prehliadači</span>}
      </header>
      <dl className="my-table-facts">
        <div>
          <dt>Môj výsledok</dt>
          <dd className={`my-table-result ${resultClass}`}>{formatMoney(table.myResult, table.currency, { sign: true })}</dd>
        </div>
        <div>
          <dt>Odohrané</dt>
          <dd>{handsLabel(table.handNumber)}</dd>
        </div>
      </dl>
      {error && (
        <div className="error my-table-error" role="alert">
          {error}
        </div>
      )}
      <div className="my-table-actions">
        <button type="button" className="btn btn-secondary" onClick={() => onOpen(table.code)}>
          Zobraziť
        </button>
        {!table.claimed && (
          <button type="button" className="btn btn-primary" disabled={!!claimingCode} onClick={() => onClaim(table.code)}>
            {claimingCode === table.code ? 'Preberám…' : 'Prevziať do účtu'}
          </button>
        )}
      </div>
    </article>
  );
}
