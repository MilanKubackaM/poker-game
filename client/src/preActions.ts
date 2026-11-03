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
