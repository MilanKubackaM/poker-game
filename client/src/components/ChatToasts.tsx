import { useEffect } from 'react';
import type { SeatPlayerView } from '../../../shared/types';
import type { ChatToastItem } from '../hooks/useChatToasts';
import { AvatarFace } from './AvatarPicker';

interface ChatToastsProps {
  toasts: ChatToastItem[];
  players: SeatPlayerView[];
  /** Chat je práve na obrazovke — toasty sa nezobrazujú a zahodia sa. */
  chatVisible: boolean;
  onOpenChat: () => void;
  onClear: () => void;
  /** Desktop s bočným panelom: toasty vľavo hore stále (aj pri otvorenom chate), história ostáva v paneli. */
  docked?: boolean;
}

/** Nové správy (aj vlastné) a upozornenia na módy ako overlay (mobil vpravo hore, desktop vľavo hore); klik otvorí chat. */
export function ChatToasts({ toasts, players, chatVisible, onOpenChat, onClear, docked = false }: ChatToastsProps) {
  useEffect(() => {
    if (!docked && chatVisible && toasts.length > 0) {
      onClear();
    }
  }, [docked, chatVisible, toasts.length, onClear]);

  if ((!docked && chatVisible) || toasts.length === 0) {
    return null;
  }
  return (
    <div className={docked ? 'chat-toasts docked' : 'chat-toasts'} aria-live="polite">
      {toasts.map((toast) => {
        const isMode = toast.kind === 'mode';
        const author = isMode ? undefined : players.find((player) => player.id === toast.playerId);
        const color = isMode ? '#b8913f' : (author?.avatar.color ?? '#264653');
        const name = isMode ? 'Mód hry' : (author?.name ?? 'Hráč');
        return (
          <button
            key={toast.id}
            type="button"
            className={[toast.leaving ? 'chat-toast leaving' : 'chat-toast', isMode ? 'chat-toast-mode' : ''].filter(Boolean).join(' ')}
            onClick={() => {
              if (!docked) {
                onClear();
              }
              onOpenChat();
            }}
            aria-label={`${isMode ? 'Mód hry' : `Správa od ${author?.name ?? 'hráča'}`}: ${toast.text} — otvoriť chat`}
          >
            <span className="chat-toast-avatar" style={{ background: color }} aria-hidden>
              {isMode ? '📢' : author ? <AvatarFace avatar={author.avatar} /> : '🃏'}
            </span>
            <span className="chat-toast-body">
              <strong className="chat-toast-name">{name}</strong>
              <span className="chat-toast-text">{toast.text}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
