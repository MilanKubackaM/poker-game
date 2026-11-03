import type { Card } from '../../../shared/types';

const SUIT_SYMBOLS: Record<string, string> = { s: '♠', h: '♥', d: '♦', c: '♣' };
const RANK_LABELS: Record<string, string> = { T: '10' };

interface PlayingCardProps {
  card: Card | null;
  size?: 'sm' | 'md' | 'lg';
  highlight?: boolean;
  dimmed?: boolean;
  selectable?: boolean;
  onClick?: () => void;
  /** Prístupný popis klikateľnej karty (napr. karta rubom pri losovaní). */
  label?: string;
}

export function PlayingCard({ card, size = 'md', highlight, dimmed, selectable, onClick, label: ariaLabel }: PlayingCardProps) {
  const classes = ['card', `card-${size}`];
  if (highlight) {
    classes.push('card-highlight');
  }
  if (dimmed) {
    classes.push('card-dimmed');
  }
  if (selectable) {
    classes.push('card-selectable');
  }
  if (!card) {
    classes.push('card-back');
    if (onClick) {
      return <button type="button" className={classes.join(' ')} onClick={onClick} aria-label={ariaLabel ?? 'skrytá karta'} />;
    }
    return <div className={classes.join(' ')} aria-label="skrytá karta" />;
  }
  const rank = card[0];
  const suit = card[1];
  const red = suit === 'h' || suit === 'd';
  classes.push(red ? 'card-red' : 'card-black');
  const label = RANK_LABELS[rank] ?? rank;
  const content = (
    <>
      <span className="card-rank">{label}</span>
      <span className="card-suit">{SUIT_SYMBOLS[suit]}</span>
      <span className="card-pip">{SUIT_SYMBOLS[suit]}</span>
    </>
  );
  if (onClick) {
    return (
      <button type="button" className={classes.join(' ')} onClick={onClick} aria-label={`${label}${SUIT_SYMBOLS[suit]}`}>
        {content}
      </button>
    );
  }
  return (
    <div className={classes.join(' ')} aria-label={`${label}${SUIT_SYMBOLS[suit]}`}>
      {content}
    </div>
  );
}
