import { useState } from 'react';
import { exportFairness, fairSupported } from '../fairness';

const timeFormat = new Intl.DateTimeFormat('sk-SK', { hour: '2-digit', minute: '2-digit' });

/** Stiahnutie dôkazov overiteľného miešania (lokálne záznamy prehliadača + dôkazy servera) pre overovací skript. */
export function FairnessBox({ tableCode, youId }: { tableCode: string; youId: string }) {
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const download = async () => {
    setBusy(true);
    const result = await exportFairness(tableCode, youId);
    setBusy(false);
    if ('error' in result) {
      setMessage(result.error);
      return;
    }
    const blob = new Blob([JSON.stringify(result.file, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `poker-fairness-${tableCode}-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
    setMessage(
      result.revealed
        ? `Stiahnuté (${result.file.proofs.length} rúk). Over ich skriptom tools/verify-fairness.ts z GitHubu.`
        : `Semienka servera sa zverejnia po skončení hry${result.revealAt ? ` (najneskôr ${timeFormat.format(new Date(result.revealAt))})` : ''} — dovtedy sa ruky overiť nedajú, stiahni dôkazy potom.`,
    );
  };

  return (
    <div className="fairness-box">
      <div>
        <strong>Overiteľné miešanie</strong>
        <p className="muted">
          {fairSupported()
            ? 'Do každého balíčka prispieva náhodou aj tvoj prehliadač. Po hre si stiahni dôkazy a over, že balíček nikto nenastavil.'
            : 'Tento prehliadač nevie počítať SHA-256 (stránka nie je cez HTTPS) — do miešania neprispieva.'}
        </p>
        {message && <p className="fairness-message">{message}</p>}
      </div>
      <button type="button" className="btn btn-ghost" onClick={() => void download()} disabled={busy}>
        {busy ? 'Sťahujem…' : 'Stiahnuť dôkazy'}
      </button>
    </div>
  );
}
