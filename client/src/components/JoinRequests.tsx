import type { JoinRequestView, TableView } from '../../../shared/types';
import { isAdmin } from '../roles';

type Resolve = (requestId: string, approve: boolean) => void;

function Actions({ request, onResolve }: { request: JoinRequestView; onResolve: Resolve }) {
  return (
    <span className="join-request-actions">
      <button type="button" className="btn btn-primary btn-small" onClick={() => onResolve(request.id, true)}>
        Pustiť
      </button>
      <button type="button" className="btn btn-secondary btn-small" onClick={() => onResolve(request.id, false)}>
        Zamietnuť
      </button>
    </span>
  );
}

/** Počas hry: žiadosti o prístup svietia hore na ploche — host ich schváli alebo zamietne, ostatní vidia, že niekto čaká. */
export function JoinRequestsBanner({ view, onResolve }: { view: TableView; onResolve: Resolve }) {
  const requests = view.joinRequests ?? [];
  if (requests.length === 0) {
    return null;
  }
  const canResolve = isAdmin(view);
  return (
    <div className="join-requests-banner" role="status" aria-live="polite">
      {requests.map((request) => (
        <div key={request.id} className="join-request">
          <span className="join-request-avatar" style={{ background: request.avatar.color }} aria-hidden>
            {request.avatar.emoji}
          </span>
          <span className="join-request-text">
            <strong>{request.name}</strong> žiada o prístup ku stolu
          </span>
          {canResolve ? <Actions request={request} onResolve={onResolve} /> : <span className="join-request-wait">čaká na schválenie hostom</span>}
        </div>
      ))}
    </div>
  );
}

/** V čakárni: žiadateľ ako „pending“ karta medzi hráčmi — bez stacku, kamery a akcií. */
export function PendingPlayerCards({ view, onResolve }: { view: TableView; onResolve: Resolve }) {
  const canResolve = isAdmin(view);
  return (
    <>
      {(view.joinRequests ?? []).map((request) => (
        <article key={request.id} className="room-player pending">
          <div className="room-player-top">
            <div className="room-portrait" style={{ background: request.avatar.color }}>
              <span className="room-emoji">{request.avatar.emoji}</span>
            </div>
            <div className="room-player-info">
              <div className="room-player-name">
                <span className="room-player-name-text">{request.name}</span>
              </div>
              <div className="room-player-tags">
                <span className="badge badge-pending">čaká na schválenie</span>
              </div>
            </div>
          </div>
          {canResolve && <Actions request={request} onResolve={onResolve} />}
        </article>
      ))}
    </>
  );
}

/** Obrazovka žiadateľa: zo stola nevidí nič, len že čaká, kým ho host pustí. */
export function PendingJoinScreen({ code, onCancel }: { code: string; onCancel: () => void }) {
  return (
    <div className="pending-join-screen">
      <div className="panel pending-join-card">
        <div className="pending-join-spinner" aria-hidden />
        <h1>Čakáš na schválenie</h1>
        <p className="muted">
          Host stola <span className="room-code">{code}</span> musí tvoju žiadosť schváliť. Keď ťa pustí, stôl sa otvorí sám — stránku môžeš nechať
          otvorenú aj ju obnoviť.
        </p>
        <button type="button" className="btn btn-secondary" onClick={onCancel}>
          Zrušiť žiadosť
        </button>
      </div>
    </div>
  );
}
