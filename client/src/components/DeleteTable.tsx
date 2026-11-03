import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { TableView } from '../../../shared/types';
import { formatMoney } from '../../../shared/money';
import { tableName } from './TableTopbar';

interface DangerZoneProps {
  view: TableView;
  /** Zmaže stôl (`host:deleteTable`); vráti chybu servera alebo null. Pri úspechu klienta presmeruje `table:deleted`. */
  onDelete: (code: string) => Promise<string | null>;
  initialOpen?: boolean;
}

/** Tlačidlo „Zmazať stôl“ v spodnej lište čakárne vedľa „Opustiť hru“ — vidí ho len zakladateľ stola. */
export function DeleteTableButton({ view, onDelete, initialOpen = false }: DangerZoneProps) {
  const [open, setOpen] = useState(initialOpen);
  return (
    <>
      <button type="button" className="btn btn-secondary room-exit-btn" onClick={() => setOpen(true)}>
        🗑 Zmazať stôl
      </button>
      {open && <DeleteTableDialog view={view} onDelete={onDelete} onClose={() => setOpen(false)} />}
    </>
  );
}

interface DeleteTableDialogProps {
  view: TableView;
  onDelete: (code: string) => Promise<string | null>;
  onClose: () => void;
}

function DeleteTableDialog({ view, onDelete, onClose }: DeleteTableDialogProps) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const matches = typed.trim().toUpperCase() === view.code;
  const leaderboard = view.leaderboard ?? [];
  const chipsAtTable = leaderboard.length > 0 ? leaderboard.reduce((sum, row) => sum + row.stack, 0) : view.players.reduce((sum, player) => sum + player.stack, 0);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const submit = async () => {
    if (!matches || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    const failure = await onDelete(view.code);
    setBusy(false);
    if (failure) {
      setError(failure);
    }
  };

  return createPortal(
    <div className="modal-backdrop delete-backdrop" onClick={() => !busy && onClose()}>
      <div className="modal modal-wide delete-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-title" onClick={(event) => event.stopPropagation()}>
        <div className="delete-icon" aria-hidden>
          🗑
        </div>
        <h2 id="delete-title">Natrvalo zmazať stôl „{tableName(view)}“?</h2>
        <p>Zmaže sa celý stôl aj s históriou rúk, leaderboardom a transakciami všetkých hráčov. Nedá sa to vrátiť späť.</p>
        <ul className="delete-consequences">
          <li>Každého pri stole to hneď odpojí a stôl zmizne z „Moje stoly“ všetkým — aj tým, čo práve nie sú pri stole.</li>
          {chipsAtTable > 0 && (
            <li>
              Pri stole je spolu <strong>{formatMoney(chipsAtTable, view.settings.currency)}</strong> v žetónoch — vyrovnajte sa ešte pred zmazaním.
            </li>
          )}
          <li>Odkaz na pozvánku prestane fungovať.</li>
        </ul>
        <label className="field delete-confirm">
          <span>
            Na potvrdenie napíš kód stola <strong className="delete-code">{view.code}</strong>
          </span>
          <input
            value={typed}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            maxLength={8}
            placeholder={view.code}
            aria-invalid={typed.length > 0 && !matches ? true : undefined}
            onChange={(event) => {
              setTyped(event.target.value.toUpperCase());
              setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                void submit();
              }
            }}
          />
        </label>
        {error && <div className="error">{error}</div>}
        <div className="delete-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Zrušiť
          </button>
          <button type="button" className="btn btn-danger" disabled={!matches || busy} onClick={() => void submit()}>
            {busy ? 'Mažem…' : 'Natrvalo zmazať'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
