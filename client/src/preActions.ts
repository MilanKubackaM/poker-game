import type { LegalActions, PlayerAction } from '../../shared/types';

/** Automatická akcia vopred, kým nie som na ťahu; vykoná sa, keď na mňa príde rad. */
export type PreAction = { kind: 'check' } | { kind: 'check-fold' } | { kind: 'call'; amount: number } | { kind: 'call-any' };

/** Čo urobiť s predvolenou akciou, keď som na ťahu; null = situácia sa zmenila, akcia sa zruší bez ťahu. */
export function resolvePreAction(pre: PreAction, legal: LegalActions): PlayerAction | null {
  switch (pre.kind) {
    case 'check':
      return legal.canCheck ? { type: 'check' } : null;
    case 'check-fold':
      return legal.canCheck ? { type: 'check' } : { type: 'fold' };
    case 'call':
      return !legal.canCheck && legal.callAmount === pre.amount ? { type: 'call' } : null;
    case 'call-any':
      return legal.canCheck ? { type: 'check' } : { type: 'call' };
  }
}

/** Pozícia tlačidla v lište akcií — predvoľby aj skutočné akcie zdieľajú tie isté tri sloty (Fold | Check/Call | Bet/Raise). */
export type ActionSlot = 'fold' | 'call' | 'raise';
/** Farba tlačidla podľa druhu akcie. */
export type ActionTone = 'fold' | 'call' | 'raise' | 'allin';

export interface PreActionOption {
  slot: ActionSlot;
  tone: ActionTone;
  label: string;
  value: PreAction;
}

/**
 * Predvoľby rozložené do slotov skutočných akcií, aby sa tlačidlo pod prstom nepohlo, keď na mňa príde rad:
 * Fold-slot = Check / Fold, stredný slot = Check alebo Call X (podľa toho, či treba dorovnať), tretí slot = Call any.
 */
export function preActionOptions(toCall: number, stack: number, money: (cents: number) => string): PreActionOption[] {
  const allIn = toCall > 0 && toCall >= stack;
  return [
    { slot: 'fold', tone: 'fold', label: toCall > 0 ? 'Fold' : 'Check / Fold', value: { kind: 'check-fold' } },
    toCall > 0
      ? { slot: 'call', tone: allIn ? 'allin' : 'call', label: `${allIn ? 'All-in' : 'Call'} ${money(toCall)}`, value: { kind: 'call', amount: toCall } }
      : { slot: 'call', tone: 'call', label: 'Check', value: { kind: 'check' } },
    { slot: 'raise', tone: 'call', label: 'Call any', value: { kind: 'call-any' } },
  ];
}
