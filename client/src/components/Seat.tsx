import type { CSSProperties } from 'react';
import type { Card, Currency, SeatPlayerView } from '../../../shared/types';
import { formatMoney } from '../../../shared/money';
import type { TurnClock } from '../turnClock';
import { PiggyDots } from './GameModes';
import { RoleBadge, type PlayerRoles } from './HostPlayers';
import { MicIcon } from './MicIcon';
import { playerStateLabel } from './PlayerPause';
import { PlayingCard } from './PlayingCard';
import type { LinkInfo } from '../hooks/useMesh';
import { VideoTile } from './VideoTile';

export interface SeatPosition {
  x: number;
  y: number;
  betX: number;
  betY: number;
}

interface SeatProps {
  player: SeatPlayerView;
  position: SeatPosition;
  isMe: boolean;
  isTurn: boolean;
  /** Odpočet hráča na ťahu (základný čas → timebank). */
  turnClock: TurnClock | null;
  /** Ukázať timebank hráča v tooltipe (len keď je čas na ťah obmedzený). */
  showTimeBank?: boolean;
  isDealer: boolean;
  blind: 'SB' | 'BB' | null;
  stream: MediaStream | null;
  /** Kvalita spojenia s týmto hráčom; ikonka sa ukáže len pri relay alebo zlom spojení. */
  link?: LinkInfo | null;
  winAmount: number;
  bestCards: Card[];
  showdown: boolean;
  currency: Currency;
  /** Karta vytiahnutá pri losovaní o dealer button (zobrazí sa pri hráčovi namiesto kariet v ruke). */
  drawnCard?: Card | null;
  drawWinner?: boolean;
  /** Prasiatko: počet zelených krúžkov a cieľ; null = hráč o prasiatko nehrá. */
  piggy?: { wins: number; target: number } | null;
  /** Hráč práve vyhral prasiatko (zelená žiara). */
  piggyWinner?: boolean;
  /** Kto je host, spoluhost a bankár — odznaky pred menom rovnaké ako v čakárni. */
  roles: Pick<PlayerRoles, 'ownerId' | 'bankerId' | 'isAdmin'>;
  /** Hráč práve hovorí — zelený pulzujúci okraj a mikrofón pri avatare. */
  speaking?: boolean;
}

export function Seat(props: SeatProps) {
  const { player, position, isMe, isTurn, turnClock, showTimeBank, isDealer, blind, stream, link, winAmount, bestCards, showdown, currency, drawnCard, drawWinner, piggy, piggyWinner, roles, speaking } = props;
  const stateLabel = playerStateLabel(player);
  const classes = ['seat'];
  if (isMe) {
    classes.push('seat-me');
  }
  if (isTurn) {
    classes.push('seat-turn');
  }
  if (player.status === 'folded') {
    classes.push('seat-folded');
  }
  if (!player.connected) {
    classes.push('seat-offline');
  }
  if (winAmount > 0) {
    classes.push('seat-winner');
  }
  if (player.sittingOut && !player.inHand) {
    classes.push('seat-away');
  }
  if (drawWinner) {
    classes.push('seat-winner');
  }
  if (piggyWinner) {
    classes.push('seat-piggy-winner');
  }
  if (speaking) {
    classes.push('seat-speaking');
  }
  const showVideo = !!stream && player.camera;
  if (showVideo) {
    classes.push('seat-has-video');
  }
  const ringStyle = { '--progress': turnClock?.progress ?? 0 } as CSSProperties;
  const bankSec = showTimeBank && typeof player.timeBankMs === 'number' ? Math.round(player.timeBankMs / 1000) : null;
  const visibleCards = player.cards.length > 0 && (!isMe || showdown);

  return (
    <div className={classes.join(' ')} style={{ left: `${position.x}%`, top: `${position.y}%` }}>
      <div className="seat-portrait-wrap">
        {isTurn && turnClock && <div className={turnClock.phase === 'bank' ? 'turn-ring timebank' : 'turn-ring'} style={ringStyle} />}
        {isTurn && turnClock && (
          <span className={turnClock.phase === 'bank' ? 'turn-clock-chip timebank' : 'turn-clock-chip'} title={turnClock.phase === 'bank' ? 'Míňa sa timebank' : 'Základný čas na ťah'}>
            {turnClock.phase === 'bank' ? `⏱ ${turnClock.secondsLeft} s` : `${turnClock.secondsLeft} s`}
          </span>
        )}
        <div className="seat-portrait" style={{ background: player.avatar.color }}>
          {showVideo ? <VideoTile stream={stream} mirrored={isMe} /> : <span className="seat-emoji">{player.avatar.emoji}</span>}
        </div>
        {speaking ? (
          <span className="seat-speaking-mic" title="Práve hovorí">
            <MicIcon size={14} />
          </span>
        ) : (
          player.camera && !player.microphone && showVideo && <span className="seat-muted" title="Mikrofón vypnutý"><MicIcon off size={14} /></span>
        )}
        {link && (link.relayed || link.lossPct >= 3 || (link.rttMs ?? 0) >= 300) && (
          <span
            className={link.lossPct >= 3 || (link.rttMs ?? 0) >= 300 ? 'seat-link bad' : 'seat-link'}
            title={`${link.relayed ? 'Cez relay (server), nie priamo' : 'Priame spojenie'} · ${link.path} · odozva ${link.rttMs ?? '?'} ms · straty ${link.lossPct} %`}
          >
            {link.relayed ? 'relay' : '📶'} {link.rttMs ?? '?'} ms{link.lossPct >= 1 ? ` · ${link.lossPct} %` : ''}
          </span>
        )}
        {isDealer && <span className="dealer-button">D</span>}
        {blind && <span className={blind === 'SB' ? 'blind-tag blind-sb' : 'blind-tag blind-bb'}>{blind}</span>}
      </div>
      <div className="seat-plate" title={bankSec !== null ? `Timebank ${bankSec} s` : undefined}>
        <div className="seat-name">
          <RoleBadge playerId={player.id} roles={roles} />
          {player.name}
        </div>
        <div className="seat-stack">{formatMoney(player.stack, currency)}</div>
        {piggy && <PiggyDots wins={piggy.wins} target={piggy.target} />}
      </div>
      {visibleCards && (
        <div className={['seat-cards', player.cards.length > 2 ? 'seat-cards-many' : '', player.cards.some(Boolean) ? 'seat-cards-open' : '', position.x > 62 ? 'seat-cards-left' : '', Math.abs(position.x - 50) > 35 ? 'seat-cards-high' : ''].filter(Boolean).join(' ')}>
          {player.cards.map((card, index) => (
            <PlayingCard key={index} card={card} size="sm" highlight={!!card && bestCards.includes(card)} dimmed={player.status === 'folded'} />
          ))}
        </div>
      )}
      {!visibleCards && drawnCard && (
        <div className="seat-cards seat-draw-card">
          <PlayingCard card={drawnCard} size="sm" highlight={drawWinner} />
        </div>
      )}
      <div className="seat-status">
        {winAmount > 0 ? (
          <span className="badge badge-win">{formatMoney(winAmount, currency, { sign: true })}</span>
        ) : player.status === 'allin' ? (
          <span className="badge badge-allin">ALL-IN</span>
        ) : !player.connected ? (
          <span className="badge badge-muted">offline</span>
        ) : stateLabel && (player.away || !player.inHand) ? (
          <span className={stateLabel.className} title={stateLabel.title}>
            {stateLabel.text}
          </span>
        ) : player.sittingOut && !player.inHand ? (
          <span className="badge badge-muted">bez žetónov</span>
        ) : player.lastAction ? (
          <span className="badge">{player.lastAction}</span>
        ) : null}
        {showdown && player.handDescription && !isMe && <HandDescription text={player.handDescription} />}
      </div>
      {player.bet > 0 && (
        <div className="seat-bet" style={{ '--bx': `${position.betX}px`, '--by': `${position.betY}px` } as CSSProperties}>
          <span className="chip-icon" />
          {formatMoney(player.bet, currency)}
        </div>
      )}
    </div>
  );
}

function HandDescription({ text }: { text: string }) {
  const separator = text.indexOf(' — ');
  if (separator < 0) {
    return <span className="hand-desc">{text}</span>;
  }
  return (
    <span className="hand-desc" title={text}>
      {text.slice(0, separator)}
      <span className="hand-desc-detail">{text.slice(separator)}</span>
    </span>
  );
}

export function EmptySeat({ position, onClick }: { position: SeatPosition; onClick?: () => void }) {
  return (
    <button type="button" className="seat-empty" style={{ left: `${position.x}%`, top: `${position.y}%` }} onClick={onClick} disabled={!onClick}>
      <span>voľné</span>
    </button>
  );
}
