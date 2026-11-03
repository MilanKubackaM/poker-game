import type { ReactNode } from 'react';
import type { MissedBlinds, ReturnMode, SeatPlayerView, TableSettings } from '../../../shared/types';
import { formatMoney } from '../../../shared/money';

/** Starší server neposiela `away` / `missedBlinds` / `returnMode` — vtedy platí „nič“. */
export function isAway(player: SeatPlayerView | null | undefined): boolean {
  return !!player?.away;
}

export function missedBlindsOf(player: SeatPlayerView | null | undefined): MissedBlinds {
  return player?.missedBlinds ?? 'none';
}

export function returnModeOf(player: SeatPlayerView | null | undefined): ReturnMode | null {
  return player?.returnMode ?? null;
}

/** Hráč stojí mimo hry a pri návrate musí zvoliť, či počká na BB alebo zaplatí. */
export function owesBlinds(player: SeatPlayerView | null | undefined): boolean {
  return !!player?.sittingOut && missedBlindsOf(player) !== 'none';
}

export interface PlayerStateLabel {
  text: string;
  className: string;
  title: string;
}

/**
 * Stav hráča pre odznak pri sedadle a v čakárni: krátka pauza, postavil sa od stola, vracia sa.
 * Hráč bez žetónov (stojí, lebo nemá stack) dostane `null` — má vlastný odznak / stav.
 */
export function playerStateLabel(player: SeatPlayerView): PlayerStateLabel | null {
  if (isAway(player)) {
    return { text: 'pauza ☕', className: 'badge badge-away', title: 'Krátka pauza — ruky sa automaticky foldnú, blindy sa platia' };
  }
  if (!player.sittingOut || player.stack <= 0) {
    return null;
  }
  const mode = returnModeOf(player);
  if (mode === 'wait-bb') {
    return { text: 'čaká na BB', className: 'badge badge-return', title: 'Vráti sa do hry, keď príde na rad s big blindom' };
  }
  if (mode === 'post') {
    return { text: 'vracia sa (doplatí BB)', className: 'badge badge-return', title: 'Vráti sa od ďalšej ruky a doplatí zmeškané blindy' };
  }
  return { text: 'mimo hry', className: 'badge badge-muted', title: 'Stojí mimo hry — nedostáva karty a neplatí blindy' };
}

/** Suma, ktorú hráč zaplatí pri návrate „hneď“: živý BB + mŕtvy SB, ak zmeškal oba. */
export function returnPostLabel(missed: MissedBlinds, settings: TableSettings): string {
  const money = (cents: number) => formatMoney(cents, settings.currency);
  return missed === 'small-and-big' ? `${money(settings.bigBlind)} + mŕtvy SB ${money(settings.smallBlind)}` : money(settings.bigBlind);
}

interface ReturnDialogProps {
  me: SeatPlayerView;
  settings: TableSettings;
  onReturn: (mode: ReturnMode) => void;
  /** Zruší zvolený návrat — hráč ostáva stáť mimo hry. */
  onStayOut: () => void;
  onClose: () => void;
}

/** Návrat po postavení sa od stola (aj pre hráča, ktorý prisadol počas hry): počkať na BB alebo zaplatiť a hrať hneď. */
export function ReturnDialog({ me, settings, onReturn, onStayOut, onClose }: ReturnDialogProps) {
  const missed = missedBlindsOf(me);
  const mode = returnModeOf(me);
  const money = (cents: number) => formatMoney(cents, settings.currency);
  const choose = (next: ReturnMode) => {
    onReturn(next);
    onClose();
  };

  const missedText: ReactNode =
    missed === 'small-and-big' ? (
      <>
        Počas tvojej neprítomnosti prešli cez tvoje miesto <strong>small blind ({money(settings.smallBlind)})</strong> aj{' '}
        <strong>big blind ({money(settings.bigBlind)})</strong>.
      </>
    ) : (
      <>
        Do rozbehnutej hry sa vstupuje cez <strong>big blind ({money(settings.bigBlind)})</strong> — buď naň počkáš, alebo ho zaplatíš a hráš hneď.
      </>
    );

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide return-dialog" role="dialog" aria-modal="true" aria-labelledby="return-title" onClick={(event) => event.stopPropagation()}>
        <h2 id="return-title">Návrat do hry</h2>
        <p className="return-missed">{missedText}</p>
        <div className="return-choices" role="radiogroup" aria-label="Spôsob návratu">
          <button type="button" role="radio" aria-checked={mode === 'wait-bb'} className={mode === 'wait-bb' ? 'choice-card active' : 'choice-card'} onClick={() => choose('wait-bb')}>
            <span className="choice-icon" aria-hidden>
              ⏳
            </span>
            <span className="choice-title">Počkať na big blind (zadarmo)</span>
            <span className="choice-text">Karty dostaneš, keď na tvoje miesto príde big blind. Nič navyše neplatíš.</span>
            {mode === 'wait-bb' && <span className="choice-flag">✓ Zvolené</span>}
          </button>
          <button type="button" role="radio" aria-checked={mode === 'post'} className={mode === 'post' ? 'choice-card active' : 'choice-card'} onClick={() => choose('post')}>
            <span className="choice-icon" aria-hidden>
              💰
            </span>
            <span className="choice-title">
              Zaplatiť {returnPostLabel(missed, settings)} a hrať hneď
            </span>
            <span className="choice-text">
              Hráš od najbližšej ruky. BB sa ráta ako tvoja stávka{missed === 'small-and-big' ? ', mŕtvy SB ide rovno do potu' : ''}.
            </span>
            {mode === 'post' && <span className="choice-flag">✓ Zvolené</span>}
          </button>
        </div>
        <div className="return-footer">
          {mode !== null ? (
            <>
              <button type="button" className="btn btn-ghost" onClick={onClose}>
                Zavrieť
              </button>
              <button
                type="button"
                className="btn btn-ghost danger"
                onClick={() => {
                  onStayOut();
                  onClose();
                }}
              >
                Zrušiť návrat — zostať mimo hry
              </button>
            </>
          ) : (
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Zostať mimo hry
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

interface StatusBannerProps {
  icon: string;
  text: ReactNode;
  action: string;
  onAction: () => void;
  tone: 'away' | 'standing';
}

/** Výrazný pás v ActionBare (krátka pauza / stojím mimo hry) s tlačidlom na návrat jedným ťuknutím. */
export function StatusBanner({ icon, text, action, onAction, tone }: StatusBannerProps) {
  return (
    <span className={tone === 'away' ? 'status-banner status-banner-away' : 'status-banner'}>
      <span className="status-banner-icon" aria-hidden>
        {icon}
      </span>
      <span className="status-banner-text">{text}</span>
      <button type="button" className={tone === 'away' ? 'btn btn-primary btn-small' : 'btn btn-secondary btn-small'} onClick={onAction}>
        {action}
      </button>
    </span>
  );
}

/** Text stavu pre hráča, ktorý stojí mimo hry (podľa zvoleného návratu). */
export function standingText(me: SeatPlayerView, settings: TableSettings): string {
  const mode = returnModeOf(me);
  if (mode === 'wait-bb') {
    return 'Vraciaš sa — karty dostaneš, keď na teba príde big blind';
  }
  if (mode === 'post') {
    return `Vraciaš sa od ďalšej ruky — zaplatíš ${returnPostLabel(missedBlindsOf(me), settings)}`;
  }
  if (missedBlindsOf(me) !== 'none') {
    return 'Stojíš mimo hry — pri návrate počkáš na big blind alebo ho zaplatíš';
  }
  return 'Stojíš mimo hry — nedostávaš karty a neplatíš blindy';
}
