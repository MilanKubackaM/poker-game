import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { DepartedMemberView, SeatPlayerView, TableView } from '../../../shared/types';
import { formatMoney } from '../../../shared/money';
import { PLAYER_VOLUME_MAX, usePlayerAudio } from '../playerAudio';
import { isAdmin } from '../roles';
import { AvatarBadge } from './AvatarPicker';
import type { HostActions } from './HostPanel';
import '../seatMenu.css';

/** Člen stola: sedí pri stole, alebo odišiel (žetóny má uložené). */
export type Member = SeatPlayerView | DepartedMemberView;

export function isSeated(member: Member): member is SeatPlayerView {
  return 'seat' in member;
}

/** Vyhodiť sa dá každý člen okrem mňa a zakladateľa stola. */
export function canKick(view: TableView, memberId: string): boolean {
  return memberId !== view.youId && memberId !== view.hostId;
}

/** Zavrie sa pri ťuknutí mimo (okrem `ignore` — napr. sedadla, ktoré menu otvorilo) a pri Escape. */
function useOutsideClose(ref: RefObject<HTMLElement | null>, onClose: () => void, ignore?: (target: Element) => boolean) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const ignoreRef = useRef(ignore);
  ignoreRef.current = ignore;
  useEffect(() => {
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (!target || ref.current?.contains(target) || ignoreRef.current?.(target)) {
        return;
      }
      closeRef.current();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeRef.current();
      }
    };
    const onResize = () => closeRef.current();
    window.addEventListener('pointerdown', onPointer);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
    };
  }, [ref]);
}

/** Okraj od hrany obrazovky a medzera od sedadla (px). */
const EDGE = 8;
const GAP = 6;

/** Sedadlo hráča v DOM-e (kotva menu). */
function seatElement(playerId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.seat[data-player-id="${CSS.escape(playerId)}"]`);
}

interface SeatMenuProps {
  view: TableView;
  player: SeatPlayerView;
  actions: Pick<HostActions, 'kick'>;
  onClose: () => void;
}

/**
 * Menu po kliknutí na iného hráča pri stole: hlasitosť a stlmenie (len u mňa) a pre hosta vyhodenie.
 * Je nad sedadlom alebo pod ním a vždy celé na obrazovke; zavrie sa ťuknutím mimo alebo Escape.
 */
export function SeatMenu({ view, player, actions, onClose }: SeatMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<CSSProperties>({ left: EDGE, top: EDGE, visibility: 'hidden' });
  const [audio, setAudio] = usePlayerAudio(player.id);
  const admin = isAdmin(view);
  const kickable = canKick(view, player.id);
  const percent = Math.round(audio.volume * 100);
  useOutsideClose(ref, onClose, (target) => !!target.closest(`.seat[data-player-id="${CSS.escape(player.id)}"]`));

  useLayoutEffect(() => {
    const menu = ref.current;
    const anchor = seatElement(player.id);
    if (!menu || !anchor) {
      return;
    }
    const rect = anchor.getBoundingClientRect();
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const maxLeft = window.innerWidth - width - EDGE;
    const left = Math.max(EDGE, Math.min(maxLeft, rect.left + rect.width / 2 - width / 2));
    const below = rect.bottom + GAP;
    const above = rect.top - height - GAP;
    const top = below + height <= window.innerHeight - EDGE ? below : above >= EDGE ? above : Math.max(EDGE, window.innerHeight - height - EDGE);
    setPosition({ left, top });
  }, [player.id, admin]);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  return createPortal(
    <div ref={ref} className="seat-menu" style={position} role="dialog" aria-label={`Hráč ${player.name}`} tabIndex={-1}>
      <div className="seat-menu-head">
        <AvatarBadge avatar={player.avatar} size={32} />
        <span className="seat-menu-name">
          <strong>{player.name}</strong>
          <small>
            {formatMoney(player.stack, view.settings.currency)} · {player.connected ? 'online' : 'offline'}
          </small>
        </span>
        <button type="button" className="icon-btn seat-menu-close" onClick={onClose} aria-label="Zavrieť">
          ✕
        </button>
      </div>

      <div className="seat-menu-audio">
        <label className="seat-menu-volume">
          <span>{audio.muted ? '🔇' : audio.volume === 0 ? '🔈' : '🔊'} Hlasitosť</span>
          <output>{audio.muted ? 'stlmený' : `${percent} %`}</output>
          <input
            type="range"
            min={0}
            max={Math.round(PLAYER_VOLUME_MAX * 100)}
            step={5}
            value={percent}
            onChange={(event) => setAudio({ volume: Number(event.target.value) / 100, muted: false })}
            aria-label={`Hlasitosť hráča ${player.name}`}
          />
        </label>
        <div className="seat-menu-row">
          <button type="button" className={audio.muted ? 'btn btn-primary btn-small' : 'btn btn-secondary btn-small'} onClick={() => setAudio({ muted: !audio.muted })}>
            {audio.muted ? '🔊 Zrušiť stlmenie' : '🔇 Stlmiť'}
          </button>
          {audio.volume !== 1 && (
            <button type="button" className="btn btn-ghost btn-small" onClick={() => setAudio({ volume: 1 })}>
              100 %
            </button>
          )}
        </div>
        <small className="seat-menu-hint">Platí len u teba — ostatní nič nevidia.</small>
      </div>

      {admin && kickable && (
        <div className="seat-menu-host">
          <button
            type="button"
            className="seat-menu-item danger"
            onClick={() => {
              onClose();
              actions.kick(player.id);
            }}
          >
            <span>🚪 Vyhodiť zo stola</span>
            <small>Žetóny ostanú v transakciách, návrat len so súhlasom hosta</small>
          </button>
        </div>
      )}
    </div>,
    document.body,
  );
}
