import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Currency, HandView, LegalActions, PlayerAction, SeatPlayerView } from '../../../shared/types';
import { formatMoney, parseMoney } from '../../../shared/money';
import { centsToText } from '../moneyRules';
import { secondsLabel, type TurnClock } from '../turnClock';
import { preActionOptions, resolvePreAction, type PreAction } from '../preActions';
import { MoneyInput } from './MoneyInput';
import { PlayingCard } from './PlayingCard';
import '../actionBar.css';

/** Ako dlho po začiatku môjho ťahu sa ignorujú kliky na akcie — ochrana pred preklikom z predvoľby. */
const TURN_CLICK_GUARD_MS = 400;

interface ActionBarProps {
  me: SeatPlayerView | null;
  hand: HandView | null;
  legal: LegalActions | null;
  waitingFor: string | null;
  onAction: (action: PlayerAction) => void;
  onDiscard: (cardIndex: number) => void;
  statusText: ReactNode;
  currency: Currency;
  /** Môj odpočet, keď som na ťahu (základný čas → timebank). */
  turnClock?: TurnClock | null;
  /** Môj timebank v sekundách (null = čas na ťah nie je obmedzený). */
  timeBankSec?: number | null;
  /** Po skončení ruky: null = nedá sa, false = môžem ukázať, true = už ukázané. */
  cardsShown?: boolean | null;
  onShowCards?: () => void;
  /** Koľko by som teraz musel dorovnať (aj keď nie som na ťahu) — pre automatické akcie. */
  toCall?: number;
}

export function ActionBar({
  me,
  hand,
  legal,
  waitingFor,
  onAction,
  onDiscard,
  statusText,
  currency,
  turnClock,
  timeBankSec = null,
  cardsShown = null,
  onShowCards,
  toCall = 0,
}: ActionBarProps) {
  const [preAction, setPreAction] = useState<PreAction | null>(null);
  const [raiseTo, setRaiseToState] = useState(0);
  const [raiseText, setRaiseText] = useState('');
  const [discardIndex, setDiscardIndex] = useState<number | null>(null);
  const money = (cents: number) => formatMoney(cents, currency);

  const setRaiseTo = (cents: number) => {
    setRaiseToState(cents);
    setRaiseText(centsToText(cents));
  };

  useEffect(() => {
    if (legal) {
      setRaiseTo(legal.minRaiseTo);
    }
  }, [legal?.minRaiseTo, legal?.currentBet, hand?.street]);

  useEffect(() => {
    setDiscardIndex(null);
  }, [hand?.handNumber, hand?.street]);

  // Predvolená akcia platí len pre aktuálnu ulicu tejto ruky.
  useEffect(() => {
    setPreAction(null);
  }, [hand?.handNumber, hand?.street]);

  // Niekto vsadil / navýšil: „Check“ už nejde a „Call X“ má inú sumu — voľba sa zruší, hráč sa rozhodne znova.
  useEffect(() => {
    setPreAction((current) => {
      if (current?.kind === 'check' && toCall > 0) {
        return null;
      }
      if (current?.kind === 'call' && current.amount !== toCall) {
        return null;
      }
      return current;
    });
  }, [toCall]);

  useEffect(() => {
    if (!legal || !preAction) {
      return;
    }
    const action = resolvePreAction(preAction, legal);
    setPreAction(null);
    if (action) {
      onAction(action);
    }
  }, [legal]);

  // Ochrana pred preklikom: keď prídem na ťah, tlačidlá sa ~400 ms nedajú stlačiť (prst ešte mieri na predvoľbu).
  // Kľúč ťahu sa mení len pri novom ťahu, nie pri posúvaní stávky; automatickú predvoľbu ochrana nebrzdí.
  const turnKey = legal ? `${hand?.handNumber}:${hand?.street}:${legal.currentBet}:${legal.callAmount}` : null;
  const turnStartRef = useRef(-Infinity);
  const [guarded, setGuarded] = useState(false);
  useLayoutEffect(() => {
    if (turnKey === null) {
      setGuarded(false);
      return;
    }
    turnStartRef.current = performance.now();
    setGuarded(true);
    const timer = window.setTimeout(() => setGuarded(false), TURN_CLICK_GUARD_MS);
    return () => window.clearTimeout(timer);
  }, [turnKey]);
  const act = (action: PlayerAction) => {
    if (performance.now() - turnStartRef.current < TURN_CLICK_GUARD_MS) {
      return;
    }
    onAction(action);
  };

  const inHand = !!me?.inHand && me.status !== null;
  const discarding = hand?.street === 'discard' && inHand && me?.status !== 'folded' && !me?.hasDiscarded;
  const myCards = inHand && me ? me.cards : [];
  const pot = hand ? hand.totalPot : 0;

  const presets: { label: string; value: number }[] = [];
  if (legal && (legal.canBet || legal.canRaise)) {
    const toCall = legal.callAmount;
    const potAfterCall = pot + toCall;
    const clamp = (value: number) => Math.max(legal.minRaiseTo, Math.min(legal.maxRaiseTo, Math.round(value)));
    presets.push({ label: 'Min', value: legal.minRaiseTo });
    presets.push({
      label: '½ pot',
      value: clamp(legal.currentBet + potAfterCall / 2),
    });
    presets.push({
      label: '¾ pot',
      value: clamp(legal.currentBet + (potAfterCall * 3) / 4),
    });
    presets.push({
      label: 'Pot',
      value: clamp(legal.currentBet + potAfterCall),
    });
    presets.push({
      label: hand?.rules.structure === 'pot-limit' ? 'Max' : 'All-in',
      value: legal.maxRaiseTo,
    });
  }

  const canPreAct =
    !!hand && !!me && me.inHand && me.status === 'active' && hand.toActId !== me.id && hand.street !== 'complete' && hand.street !== 'showdown' && hand.street !== 'discard';
  const raiseAmount = legal ? Math.max(legal.minRaiseTo, Math.min(legal.maxRaiseTo, raiseTo)) : raiseTo;
  const raiseTextValid = parseMoney(raiseText) !== null;
  const activePreset = presets.findIndex((preset) => preset.value === raiseAmount);
  const myStackTotal = (me?.stack ?? 0) + (me?.bet ?? 0);
  const raiseIsAllIn = legal ? raiseAmount >= myStackTotal : false;

  const bigBlind = hand?.rules.bigBlind ?? 1;
  const stepRaise = (direction: 1 | -1) => {
    if (legal) {
      setRaiseTo(Math.max(legal.minRaiseTo, Math.min(legal.maxRaiseTo, raiseAmount + direction * bigBlind)));
    }
  };

  const typeRaise = (text: string) => {
    setRaiseText(text);
    const cents = parseMoney(text);
    if (cents !== null) {
      setRaiseToState(cents);
    }
  };

  return (
    <div className="action-bar">
      <div className="my-hand">
        {myCards.length > 0 && (
          <div className="my-cards-wrap">
            <div className={discarding ? 'my-cards discarding' : 'my-cards'}>
              {myCards.map((card, index) => (
                <PlayingCard
                  key={`${card}-${index}`}
                  card={card}
                  size="lg"
                  dimmed={me?.status === 'folded' || (discarding && discardIndex === index)}
                  selectable={discarding}
                  onClick={discarding ? () => setDiscardIndex(index) : undefined}
                />
              ))}
            </div>
            {cardsShown === false && onShowCards && (
              <button type="button" className="btn btn-chip show-cards-btn" onClick={onShowCards} title="Ostatní uvidia tvoje karty a výsledok ostane na stole o 3 s dlhšie">
                👁 Ukázať karty
              </button>
            )}
            {cardsShown === true && <div className="cards-shown-note">Tvoje karty vidia všetci</div>}
          </div>
        )}
        <div className="my-hand-info">
          {me?.handDescription && me.status !== 'folded' && (
            <div className="my-hand-desc">
              {me.secondHandDescription !== undefined && (
                <span className="hand-desc-board top" aria-label="Vrchný board:">
                  1
                </span>
              )}
              {me.handDescription}
            </div>
          )}
          {me?.secondHandDescription && me.status !== 'folded' && (
            <div className="my-hand-desc">
              <span className="hand-desc-board bottom" aria-label="Spodný board:">
                2
              </span>
              {me.secondHandDescription}
            </div>
          )}
          {statusText && <div className="my-status">{statusText}</div>}
          {turnClock ? (
            <div className={turnClock.phase === 'bank' ? 'turn-clock timebank' : 'turn-clock'} role="timer" aria-live="off">
              {turnClock.phase === 'bank' ? (
                <>
                  ⏱ <strong>Timebank {turnClock.secondsLeft} s</strong>
                </>
              ) : (
                <>
                  ⏳ Na ťah <strong>{turnClock.secondsLeft} s</strong>
                  {timeBankSec !== null && <span className="turn-clock-bank"> + timebank {secondsLabel(timeBankSec)}</span>}
                </>
              )}
            </div>
          ) : (
            timeBankSec !== null && !!me && !me.sittingOut && <div className="turn-clock idle">⏱ Timebank {secondsLabel(timeBankSec)}</div>
          )}
          {!legal && !discarding && waitingFor && <div className="my-status muted">Na ťahu: {waitingFor}</div>}
        </div>
      </div>

      {discarding && (
        <div className="discard-box">
          <div className="discard-title">Pineapple — vyber kartu, ktorú zahodíš</div>
          <button type="button" className="btn btn-danger" disabled={discardIndex === null} onClick={() => discardIndex !== null && onDiscard(discardIndex)}>
            Zahodiť označenú kartu
          </button>
        </div>
      )}
      {hand?.street === 'discard' && me?.hasDiscarded && <div className="discard-box muted">Čakáme, kým ostatní zahodia kartu…</div>}

      {!legal && canPreAct && (
        <div className="actions">
          {/* Predvoľby sú v tých istých slotoch ako skutočné akcie (Fold | Check/Call | Bet/Raise) — po prepnutí na môj ťah sa nič nepohne. */}
          <div className="action-buttons pre-actions" role="group" aria-label="Automatická akcia, keď prídeš na rad">
            {preActionOptions(toCall, me?.stack ?? 0, money).map((option) => {
              const active = preAction?.kind === option.value.kind;
              return (
                <label key={option.slot} className={`pre-action action-${option.tone}${active ? ' active' : ''}`}>
                  <input type="checkbox" checked={active} onChange={(event) => setPreAction(event.target.checked ? option.value : null)} />
                  <span>{option.label}</span>
                </label>
              );
            })}
          </div>
        </div>
      )}
      {legal && (
        <div className="actions">
          {(legal.canBet || legal.canRaise) && (
            <div className="raise-controls">
              <div className="presets">
                {presets.map((preset, index) => (
                  <button
                    key={preset.label}
                    type="button"
                    className={index === activePreset ? 'btn btn-chip preset active' : 'btn btn-chip preset'}
                    onClick={() => setRaiseTo(preset.value)}
                    title={money(preset.value)}
                  >
                    <span className="preset-label">{preset.label}</span>
                    <span className="preset-amount">{money(preset.value)}</span>
                  </button>
                ))}
              </div>
              <div className="raise-slider">
                <button
                  type="button"
                  className="btn btn-chip raise-step"
                  onClick={() => stepRaise(-1)}
                  disabled={raiseAmount <= legal.minRaiseTo}
                  aria-label={`Znížiť stávku o ${money(bigBlind)}`}
                  title={`− ${money(bigBlind)} (1 BB)`}
                >
                  −
                </button>
                <input
                  type="range"
                  min={legal.minRaiseTo}
                  max={legal.maxRaiseTo}
                  step={1}
                  value={raiseAmount}
                  onChange={(event) => setRaiseTo(Number(event.target.value))}
                  aria-label="Výška stávky"
                  aria-valuetext={money(raiseAmount)}
                />
                <button
                  type="button"
                  className="btn btn-chip raise-step"
                  onClick={() => stepRaise(1)}
                  disabled={raiseAmount >= legal.maxRaiseTo}
                  aria-label={`Zvýšiť stávku o ${money(bigBlind)}`}
                  title={`+ ${money(bigBlind)} (1 BB)`}
                >
                  +
                </button>
                <MoneyInput
                  className="raise-input"
                  value={raiseText}
                  onChange={typeRaise}
                  onBlur={() => setRaiseTo(raiseAmount)}
                  currency={currency}
                  invalid={!raiseTextValid}
                  ariaLabel="Výška stávky"
                />
              </div>
            </div>
          )}
          <div className={guarded ? 'action-buttons guarded' : 'action-buttons'} aria-busy={guarded || undefined}>
            <button type="button" className="btn btn-fold action-fold" onClick={() => act({ type: 'fold' })}>
              Fold
            </button>
            {legal.canCheck ? (
              <button type="button" className="btn btn-call action-call" onClick={() => act({ type: 'check' })}>
                Check
              </button>
            ) : (
              <button type="button" className={legal.callAmount >= (me?.stack ?? 0) ? 'btn btn-call action-allin' : 'btn btn-call action-call'} onClick={() => act({ type: 'call' })}>
                {legal.callAmount >= (me?.stack ?? 0) ? 'All-in' : 'Call'} {money(legal.callAmount)}
              </button>
            )}
            {(legal.canBet || legal.canRaise) && (
              <button
                type="button"
                className={raiseIsAllIn ? 'btn btn-raise action-allin' : 'btn btn-raise action-raise'}
                disabled={!raiseTextValid}
                onClick={() =>
                  act(
                    raiseIsAllIn
                      ? { type: 'allin' }
                      : {
                          type: legal.canBet ? 'bet' : 'raise',
                          amount: raiseAmount,
                        },
                  )
                }
              >
                {raiseIsAllIn ? 'All-in' : legal.canBet ? 'Bet' : 'Raise na'} {money(raiseAmount)}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
