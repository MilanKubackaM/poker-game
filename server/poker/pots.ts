export interface Contribution {
  playerId: string;
  amount: number;
  folded: boolean;
}

export interface Pot {
  amount: number;
  eligible: string[];
}

export function findUncalled(contributions: Contribution[]): { playerId: string; amount: number } | null {
  if (contributions.length < 2) {
    return null;
  }
  const sorted = [...contributions].sort((left, right) => right.amount - left.amount);
  const excess = sorted[0].amount - sorted[1].amount;
  return excess > 0 ? { playerId: sorted[0].playerId, amount: excess } : null;
}

export function buildPots(contributions: Contribution[]): Pot[] {
  const live = contributions.filter((entry) => !entry.folded && entry.amount > 0);
  const levels = [...new Set(live.map((entry) => entry.amount))].sort((left, right) => left - right);
  const pots: Pot[] = [];
  let previous = 0;
  for (const level of levels) {
    let amount = 0;
    for (const entry of contributions) {
      amount += Math.max(0, Math.min(entry.amount, level) - previous);
    }
    const eligible = live.filter((entry) => entry.amount >= level).map((entry) => entry.playerId);
    if (amount > 0) {
      const last = pots[pots.length - 1];
      if (last && sameMembers(last.eligible, eligible)) {
        last.amount += amount;
      } else {
        pots.push({ amount, eligible });
      }
    }
    previous = level;
  }
  const leftover = contributions.reduce((sum, entry) => sum + Math.max(0, entry.amount - previous), 0);
  if (leftover > 0) {
    if (pots.length) {
      pots[pots.length - 1].amount += leftover;
    } else {
      pots.push({ amount: leftover, eligible: live.map((entry) => entry.playerId) });
    }
  }
  return pots;
}

function sameMembers(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((id) => right.includes(id));
}

export function splitAmount(amount: number, winnersInOrder: string[]): Map<string, number> {
  const shares = new Map<string, number>();
  const base = Math.floor(amount / winnersInOrder.length);
  let remainder = amount - base * winnersInOrder.length;
  for (const id of winnersInOrder) {
    const extra = remainder > 0 ? 1 : 0;
    remainder -= extra;
    shares.set(id, base + extra);
  }
  return shares;
}
