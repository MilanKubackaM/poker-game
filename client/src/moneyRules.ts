import type { Currency } from '../../shared/types';
import { centsToInput, formatMoney, parseMoney } from '../../shared/money';

/** Peňažné pravidlá stola ako text z formulára (v mene stola, napr. „0,10"). */
export interface MoneyRulesDraft {
  smallBlind: string;
  bigBlind: string;
  sevenDeuceBounty: string;
}

export type MoneyRulesValues = Record<keyof MoneyRulesDraft, number>;

export interface MoneyRulesCheck {
  values: MoneyRulesValues | null;
  errors: Partial<Record<keyof MoneyRulesDraft, string>>;
}

/** Hodnota do textového poľa so slovenskou desatinnou čiarkou: 1050 → „10,50", 2000 → „20". */
export function centsToText(cents: number): string {
  return centsToInput(cents).replace('.', ',');
}

export function moneyRulesDraft(values: MoneyRulesValues): MoneyRulesDraft {
  return {
    smallBlind: centsToText(values.smallBlind),
    bigBlind: centsToText(values.bigBlind),
    sevenDeuceBounty: centsToText(values.sevenDeuceBounty),
  };
}

const FORMAT_ERROR = 'Zadaj sumu, napr. 0,10';

/** Rovnaké pravidlá ako na serveri: SB ≥ 0,01, BB ≥ SB, 7-2 bonus ≥ 0. */
export function checkMoneyRules(draft: MoneyRulesDraft, currency: Currency): MoneyRulesCheck {
  const errors: MoneyRulesCheck['errors'] = {};
  const smallBlind = parseMoney(draft.smallBlind);
  const bigBlind = parseMoney(draft.bigBlind);
  const sevenDeuceBounty = parseMoney(draft.sevenDeuceBounty);

  if (smallBlind === null) {
    errors.smallBlind = FORMAT_ERROR;
  } else if (smallBlind < 1) {
    errors.smallBlind = `Najmenej ${formatMoney(1, currency)}`;
  }
  if (bigBlind === null) {
    errors.bigBlind = FORMAT_ERROR;
  } else if (smallBlind !== null && bigBlind < Math.max(1, smallBlind)) {
    errors.bigBlind = 'Nesmie byť menší ako small blind';
  }
  if (sevenDeuceBounty === null) {
    errors.sevenDeuceBounty = FORMAT_ERROR;
  } else if (sevenDeuceBounty < 0) {
    errors.sevenDeuceBounty = 'Nesmie byť záporný';
  }

  const valid = Object.keys(errors).length === 0;
  return {
    values: valid ? { smallBlind: smallBlind!, bigBlind: bigBlind!, sevenDeuceBounty: sevenDeuceBounty! } : null,
    errors,
  };
}
