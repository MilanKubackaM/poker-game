import { useSyncExternalStore } from 'react';
import { APP_VERSION, type ServerVersionPayload } from '../../../shared/version';
import { socket } from '../socket';

// Server posiela verziu hneď po pripojení — poslucháč musí byť zaregistrovaný skôr, než sa vykreslí React.
let serverVersion: string | null = null;
const listeners = new Set<() => void>();
socket.on('server:version', (payload: ServerVersionPayload) => {
  if (payload && typeof payload.version === 'string' && payload.version !== serverVersion) {
    serverVersion = payload.version;
    listeners.forEach((listener) => listener());
  }
});
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const snapshot = () => serverVersion;

/**
 * Po nasadení novej verzie sa otvorené okná znova pripoja k novému serveru so starým kódom — ponúkneme obnovenie stránky.
 * Automaticky neobnovujeme: hráč môže byť práve na ťahu.
 */
export function UpdateBanner() {
  const version = useSyncExternalStore(subscribe, snapshot, snapshot);
  if (!version || version === APP_VERSION) {
    return null;
  }
  return (
    <div className="update-banner" role="status">
      <span>Je dostupná nová verzia hry ({version}).</span>
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
