import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type { Card, DealerChoice, DrawView, SeatPlayerView } from '../../../shared/types';
import { DRAW_PICK_TIMEOUT_SEC, DRAW_SUIT_ORDER, SUIT_SYMBOLS } from '../../../shared/constants';
import { AvatarBadge, AvatarInline } from './AvatarPicker';
import { PlayingCard } from './PlayingCard';

const SLOT_COUNT = 52;
const RANK_ORDER = ['A', 'K', 'Q', 'J', '10', '9', '8', '7', '6', '5', '4', '3', '2'];
/** Rozptyl kariet v rámci elipsy plsti (v % jej šírky / výšky od stredu). */
const SPREAD_X = 40;
const SPREAD_Y = 35;

/** „A♠", „10♥" — rovnaký zápis ako v udalostiach servera. */
export function cardLabel(card: Card): string {
  return `${card[0] === 'T' ? '10' : card[0]}${SUIT_SYMBOLS[card[1] as 's' | 'h' | 'd' | 'c']}`;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

interface SlotPlacement {
  /** Stred karty v % šírky / výšky plsti. */
  x: number;
  y: number;
  rotation: number;
}

/**
 * Deterministické „rozhádzanie" 52 kariet po plsti: rovnomerná Vogelova špirála v elipse + pevný (seedovaný) posun,
 * natočenie a premiešanie poradia. Každý klient tak vidí rovnaké rozloženie a karty medzi rendermi neskáču.
 */
const PLACEMENTS: SlotPlacement[] = (() => {
  const random = mulberry32(0x5eed52);
  const order = Array.from({ length: SLOT_COUNT }, (_, index) => index);
  for (let index = order.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [order[index], order[swap]] = [order[swap], order[index]];
  }
  const golden = Math.PI * (3 - Math.sqrt(5));
  const points = order.map((_, point) => {
    const radius = Math.sqrt((point + 0.5) / SLOT_COUNT) * 0.97;
    const angle = point * golden + 0.6;
    const jitterX = (random() - 0.5) * 5;
    const jitterY = (random() - 0.5) * 5;
    return {
      x: 50 + SPREAD_X * radius * Math.cos(angle) + jitterX,
      y: 50 + SPREAD_Y * radius * Math.sin(angle) + jitterY,
      rotation: Math.round((random() - 0.5) * 80),
    };
  });
  return order.map((point) => points[point]);
})();

interface DrawFieldProps {
  draw: DrawView;
  players: SeatPlayerView[];
  /** Môžem práve ťahať (som účastník, ešte nemám kartu, fáza `drawing`). */
  canPick: boolean;
  onPick: (index: number) => void;
}

/** 52 kariet rubom nahor rozhádzaných po plsti; vytiahnuté sa otočia na mieste s menom hráča. */
export function DrawField({ draw, players, canPick, onPick }: DrawFieldProps) {
  const fieldRef = useRef<HTMLDivElement>(null);
  const [cardWidth, setCardWidth] = useState(40);
  const [pending, setPending] = useState<number | null>(null);

  useLayoutEffect(() => {
    const field = fieldRef.current;
    if (!field) {
      return;
    }
    const measure = () => {
      const { width, height } = field.getBoundingClientRect();
      // Plocha elipsy, ktorú karty pokrývajú, rozdelená na 52 kariet; s natočením a posunom sa karty jemne prekrývajú.
      const cell = (Math.PI * (width * SPREAD_X) / 100 * (height * SPREAD_Y) / 100) / SLOT_COUNT;
      setCardWidth(Math.round(Math.max(24, Math.min(58, Math.sqrt(cell / 1.4) * 0.98))));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(field);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!canPick) {
      setPending(null);
    }
  }, [canPick]);

  const nameOf = (id: string | null) => players.find((player) => player.id === id) ?? null;
  const done = draw.stage === 'done';
  const style = { '--draw-w': `${cardWidth}px`, '--draw-h': `${Math.round(cardWidth * 1.42)}px` } as CSSProperties;

  return (
    <div ref={fieldRef} className={['draw-field', done ? 'done' : '', canPick ? 'picking' : ''].join(' ')} style={style}>
      {draw.slots.map((slot) => {
        const placement = PLACEMENTS[slot.index];
        const drawer = nameOf(slot.drawnBy);
        const winner = done && !!slot.drawnBy && slot.drawnBy === draw.winnerId;
        const classes = ['draw-slot'];
        if (slot.card) {
          classes.push('revealed');
        }
        if (winner) {
          classes.push('winner');
        }
        const slotStyle = {
          left: `${placement.x}%`,
          top: `${placement.y}%`,
          '--rot': `${slot.card ? Math.round(placement.rotation / 4) : placement.rotation}deg`,
          '--i': slot.index,
        } as CSSProperties;
        const selectable = canPick && !slot.card && pending === null;
        return (
          <div key={slot.index} className={classes.join(' ')} style={slotStyle}>
            <PlayingCard
              card={slot.card}
              highlight={winner}
              selectable={selectable}
              label={selectable ? `Vytiahnuť kartu ${slot.index + 1}` : undefined}
              onClick={
                selectable
                  ? () => {
                      setPending(slot.index);
                      onPick(slot.index);
                      window.setTimeout(() => setPending((current) => (current === slot.index ? null : current)), 3000);
                    }
                  : undefined
              }
            />
            {slot.card && drawer && (
              <span className="draw-tag" style={{ borderColor: drawer.avatar.color }}>
                <AvatarInline avatar={drawer.avatar} /> {drawer.name}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function SuitOrder() {
  return (
    <span className="draw-suits">
      {DRAW_SUIT_ORDER.map((suit, index) => (
        <span key={suit}>
          {index > 0 && <span className="draw-gt"> &gt; </span>}
          <span className={suit === 'h' || suit === 'd' ? 'suit-red' : 'suit-black'}>{SUIT_SYMBOLS[suit]}</span>
        </span>
      ))}
    </span>
  );
}

function names(ids: string[], players: SeatPlayerView[]): string {
  return ids.map((id) => players.find((player) => player.id === id)?.name ?? 'Hráč').join(', ');
}

export function DealerChoiceModal({ draw, players, onChoose }: { draw: DrawView; players: SeatPlayerView[]; onChoose: (mode: DealerChoice) => void }) {
  const [sent, setSent] = useState(false);
  const choose = (mode: DealerChoice) => {
    setSent(true);
    onChoose(mode);
    window.setTimeout(() => setSent(false), 3000);
  };
  return (
    <div className="modal-backdrop">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="dealer-choice-title">
        <div className="modal-icon" aria-hidden>
          D
        </div>
        <h2 id="dealer-choice-title">Začať losovaním o dealer button alebo rozhodnúť náhodne?</h2>
        <p className="muted">Hrajú: {names(draw.participants, players)}</p>
        <div className="choice-grid">
          <button type="button" className="choice-card primary" disabled={sent} onClick={() => choose('draw')}>
            <span className="choice-icon" aria-hidden>
              🃏
            </span>
            <span className="choice-title">Losovanie</span>
            <span className="choice-text">Každý si potiahne kartu, najvyššia vyhráva button</span>
          </button>
          <button type="button" className="choice-card" disabled={sent} onClick={() => choose('random')}>
            <span className="choice-icon" aria-hidden>
              🎲
            </span>
            <span className="choice-title">Náhodne</span>
            <span className="choice-text">Button dostane náhodný hráč a hneď sa rozdáva</span>
          </button>
        </div>
      </div>
    </div>
  );
}

interface DrawExplainModalProps {
  draw: DrawView;
  players: SeatPlayerView[];
  youId: string;
  secondsLeft: number | null;
  onAck: () => void;
}

export function DrawExplainModal({ draw, players, youId, secondsLeft, onAck }: DrawExplainModalProps) {
  const participant = draw.participants.includes(youId);
  const acknowledged = draw.acknowledged.includes(youId);
  const [sent, setSent] = useState(false);
  const waiting = draw.participants.filter((id) => !draw.acknowledged.includes(id));

  return (
    <div className="modal-backdrop">
      <div className="modal modal-wide" role="dialog" aria-modal="true" aria-labelledby="draw-explain-title">
        <h2 id="draw-explain-title">Losovanie o dealer button</h2>
        <ol className="draw-rules">
          <li>
            Na stole je <strong>52 kariet</strong> rubom nahor, rozhádzaných po plsti. Každý hráč si potiahne <strong>jednu</strong> — klikni alebo ťukni na
            ľubovoľnú.
          </li>
          <li>
            <strong>Najvyššia karta</strong> vyhráva dealer button na prvú ruku.
          </li>
          <li>
            Poradie hodnôt od najvyššej:
            <span className="draw-ranks">
              {RANK_ORDER.map((rank) => (
                <span key={rank} className="draw-rank">
                  {rank}
                </span>
              ))}
            </span>
          </li>
          <li>
            Každá hodnota je v balíčku štyrikrát (napr. štyri esá). Pri rovnakej hodnote rozhoduje farba: <SuitOrder />
          </li>
          <li>Kto do {DRAW_PICK_TIMEOUT_SEC} s nepotiahne, tomu sa vytiahne náhodná karta automaticky.</li>
        </ol>
        {participant && !acknowledged ? (
          <button
            type="button"
            className="btn btn-primary btn-block btn-big"
            disabled={sent}
            onClick={() => {
              setSent(true);
              onAck();
              window.setTimeout(() => setSent(false), 3000);
            }}
          >
            Rozumiem
          </button>
        ) : (
          <div className="draw-waiting">
            <span className="dot dot-live" />
            <span>
              {waiting.length > 0 ? (
                <>
                  Čaká sa na: <strong>{names(waiting, players)}</strong>
                </>
              ) : (
                'Všetci potvrdili — začína sa ťahať'
              )}
            </span>
          </div>
        )}
        {secondsLeft !== null && (
          <p className="hint draw-deadline">
            Ťahanie sa začne, keď všetci potvrdia, najneskôr o <strong>{secondsLeft} s</strong>
          </p>
        )}
      </div>
    </div>
  );
}

/** Informačný pás uprostred plsti (rozhodovanie hosta, výsledok losovania). */
export function DrawBanner({ draw, players }: { draw: DrawView; players: SeatPlayerView[] }) {
  if (draw.stage === 'choose') {
    return (
      <div className="draw-banner">
        <span className="draw-banner-dot" />
        Host rozhoduje o dealer buttone…
      </div>
    );
  }
  if (draw.stage === 'done' && draw.winnerId) {
    const winner = players.find((player) => player.id === draw.winnerId);
    const card = draw.slots.find((slot) => slot.drawnBy === draw.winnerId)?.card ?? null;
    return (
      <div className="draw-banner draw-result">
        {winner && <AvatarBadge avatar={winner.avatar} size={36} />}
        {card && <PlayingCard card={card} size="sm" highlight />}
        <span>
          <strong>{winner?.name ?? 'Hráč'}</strong> vyhral losovanie{card ? ` s ${cardLabel(card)}` : ''} — dostáva dealer button
        </span>
      </div>
    );
  }
  return null;
}
