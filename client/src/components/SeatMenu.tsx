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

/** Všetci členovia stola — sediaci aj tí, čo odišli. Starší server `departed` neposiela. */
export function tableMembers(view: TableView): Member[] {
  return [...view.players, ...(view.departed ?? [])];
}

/** Vyhodiť sa dá každý člen okrem mňa a zakladateľa stola. */
export function canKick(view: TableView, memberId: string): boolean {
  return memberId !== view.youId && memberId !== view.hostId;
}

/** Do koho sa dá člen zlúčiť: ktokoľvek iný zo stola (aj ja, aj ten, kto odišiel). */
export function mergeTargets(view: TableView, fromId: string): Member[] {
  return tableMembers(view).filter((member) => member.id !== fromId);
}

/**
 * Prečo sa člen teraz nedá zlúčiť (null = dá sa). Zlúčiť sa dá len offline hráča, ktorý nie je v rozohranej ruke,
 * a nie počas losovania o dealer button — rovnako kontroluje server.
 */
export function mergeBlockReason(view: TableView, memberId: string): string | null {
  if (view.phase === 'draw') {
    return 'Počas losovania o dealer button sa zlúčiť nedá';
  }
  const seated = view.players.find((player) => player.id === memberId);
  if (seated?.connected) {
    return 'Hráč je online — zlúčiť sa dá len offline hráča';
  }
  if (seated?.inHand && !!view.hand && view.hand.street !== 'complete') {
    return 'Hráč je v rozohranej ruke — počkaj na jej koniec';
  }
  if (mergeTargets(view, memberId).length === 0) {
    return 'Pri stole nie je nikto, do koho by sa dal zlúčiť';
  }
  return null;
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
  /** „Zlúčiť do…“ — otvorí výber cieľového hráča. */
  onMerge: (playerId: string) => void;
  onClose: () => void;
}

/**
 * Menu po kliknutí na iného hráča pri stole: hlasitosť a stlmenie (len u mňa) a pre hosta vyhodenie / zlúčenie.
 * Je nad sedadlom alebo pod ním a vždy celé na obrazovke; zavrie sa ťuknutím mimo alebo Escape.
 */
export function SeatMenu({ view, player, actions, onMerge, onClose }: SeatMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<CSSProperties>({ left: EDGE, top: EDGE, visibility: 'hidden' });
  const [audio, setAudio] = usePlayerAudio(player.id);
  const admin = isAdmin(view);
  const mergeReason = mergeBlockReason(view, player.id);
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

      {admin && (
        <div className="seat-menu-host">
          <button
            type="button"
            className="seat-menu-item"
            disabled={!!mergeReason}
            onClick={() => {
              onClose();
              onMerge(player.id);
            }}
          >
            <span>🔀 Zlúčiť do…</span>
            <small>{mergeReason ?? 'Všetko od hráča presunie na iného člena stola'}</small>
          </button>
          {kickable && (
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
          )}
        </div>
      )}
    </div>,
    document.body,
  );
}

function memberState(view: TableView, member: Member): { text: string; className: string } {
  if (member.id === view.youId) {
    return { text: 'ty', className: 'badge badge-cohost' };
  }
  if (!isSeated(member)) {
    return { text: 'mimo stola', className: 'badge badge-left' };
  }
  return member.connected ? { text: 'online', className: 'badge badge-online' } : { text: 'offline', className: 'badge badge-muted' };
}

interface MergeDialogProps {
  view: TableView;
  /** Kto sa zlučuje (zmizne). */
  fromId: string;
  /** Vybraný cieľ — potvrdenie a odoslanie rieši `HostActions.merge`. */
  onMerge: (fromId: string, toId: string) => void;
  onClose: () => void;
}

/** Výber hráča, do ktorého sa `fromId` zlúči: sediaci hráči aj tí, čo odišli od stola. */
export function MergeDialog({ view, fromId, onMerge, onClose }: MergeDialogProps) {
  const from = tableMembers(view).find((member) => member.id === fromId) ?? null;
  const targets = mergeTargets(view, fromId);
  const money = (cents: number) => formatMoney(cents, view.settings.currency);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    // Hráč medzitým zmizol (zlúčil / vyhodil ho iný host) — niet čo zlučovať.
    if (!from) {
      onClose();
    }
  }, [from, onClose]);

  if (!from) {
    return null;
  }

  return createPortal(
    <div className="modal-backdrop merge-backdrop" onClick={onClose}>
      <div className="modal modal-wide merge-dialog" role="dialog" aria-modal="true" aria-labelledby="merge-title" onClick={(event) => event.stopPropagation()}>
        <h2 id="merge-title">Zlúčiť {from.name} do…</h2>
        <p className="merge-lead">
          Vyber hráča, na ktorého sa presunie všetko od <strong>{from.name}</strong> — žetóny {money(from.stack)}, transakcie, štatistiky aj história. {from.name} potom zo stola zmizne.
        </p>
        <p className="hint">Použi, keď sa niekto pripojil z iného zariadenia ako nový hráč: vyber jeho nový účet.</p>
        {targets.length === 0 ? (
          <p className="hint">Pri stole nie je nikto iný.</p>
        ) : (
          <ul className="merge-list">
            {targets.map((member) => {
              const state = memberState(view, member);
              return (
                <li key={member.id}>
                  <button
                    type="button"
                    className="merge-target"
                    onClick={() => {
                      onClose();
                      onMerge(fromId, member.id);
                    }}
                  >
                    <AvatarBadge avatar={member.avatar} size={36} />
                    <span className="merge-target-info">
                      <strong>{member.name}</strong>
                      <small>{money(member.stack)}</small>
                    </span>
                    <span className={state.className}>{state.text}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          Zrušiť
        </button>
      </div>
    </div>,
    document.body,
  );
}
