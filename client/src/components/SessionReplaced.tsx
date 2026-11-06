import { useState } from 'react';

/**
 * Celá obrazovka v starom okne, keď ten istý hráč otvoril stôl inde (iné okno / zariadenie). Toto okno nemá hlas, video
 * ani štatistiky; „Pokračovať tu“ hráča znova naviaže sem a server odstaví to druhé okno.
 */
export function SessionReplacedScreen({ onContinue }: { onContinue: () => Promise<string | null> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const continueHere = async () => {
    setBusy(true);
    setError(null);
    const failure = await onContinue().catch(() => 'Nepodarilo sa vrátiť ku stolu');
    setBusy(false);
    setError(failure);
  };
  return (
    <div className="pending-join-screen" role="alertdialog" aria-labelledby="session-replaced-title">
      <div className="panel pending-join-card">
        <h1 id="session-replaced-title">Stôl je otvorený v inom okne alebo zariadení</h1>
        <p className="muted">Hráš teraz tam — toto okno je odstavené, aby sa hlas a video nezdvojovali.</p>
        {error && <div className="error">{error}</div>}
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void continueHere()}>
          {busy ? 'Pripájam…' : 'Pokračovať tu'}
        </button>
      </div>
    </div>
  );
}
