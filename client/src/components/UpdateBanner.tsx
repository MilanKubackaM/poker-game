import { useSyncExternalStore } from 'react';
import { APP_VERSION, buildFingerprint, type ServerVersionPayload } from '../../../shared/version';
import { socket } from '../socket';

/**
 * Odtlačok buildu, ktorým sa táto stránka načítala — počíta sa hneď pri načítaní modulu, kým v `<head>` nepribudnú
 * štýly lenivo načítaných častí (tie by odtlačok zmenili).
 */
const CLIENT_BUILD = buildFingerprint(Array.from(document.querySelectorAll('script[src], link[href]'), (element) => element.getAttribute('src') ?? element.getAttribute('href')));

/** Server beží s inou verziou alebo s iným buildom klienta než táto stránka; `version` je jeho číslo verzie. */
interface ServerUpdate {
  version: string;
  newVersion: boolean;
}

// Server posiela verziu hneď po pripojení — poslucháč musí byť zaregistrovaný skôr, než sa vykreslí React.
let update: ServerUpdate | null = null;
const listeners = new Set<() => void>();
socket.on('server:version', (payload: ServerVersionPayload) => {
  if (!payload || typeof payload.version !== 'string') {
    return;
  }
  const newVersion = payload.version !== APP_VERSION;
  const newBuild = typeof payload.build === 'string' && !!CLIENT_BUILD && payload.build !== CLIENT_BUILD;
  const next = newVersion || newBuild ? { version: payload.version, newVersion } : null;
  if (next?.version !== update?.version || next?.newVersion !== update?.newVersion) {
    update = next;
    listeners.forEach((listener) => listener());
  }
});
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const snapshot = () => update;

/**
 * Po nasadení (novej verzie alebo len nového buildu s rovnakým číslom verzie) sa otvorené okná znova pripoja k novému
 * serveru so starým kódom — ponúkneme obnovenie stránky. Automaticky neobnovujeme: hráč môže byť práve na ťahu.
 */
export function UpdateBanner() {
  const current = useSyncExternalStore(subscribe, snapshot, snapshot);
  if (!current) {
    return null;
  }
  return (
    <div className="update-banner" role="status">
      <span>{current.newVersion ? `Je dostupná nová verzia hry (${current.version}).` : 'Je dostupná aktualizácia hry.'}</span>
      <button type="button" className="btn btn-small" onClick={() => window.location.reload()}>
        Obnoviť
      </button>
    </div>
  );
}

/** Nenápadné číslo verzie (úvodná obrazovka, pomocník). */
export function VersionTag({ className }: { className?: string }) {
  return <span className={className ? `version-tag ${className}` : 'version-tag'}>v{APP_VERSION}</span>;
}
