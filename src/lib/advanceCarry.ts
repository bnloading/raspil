import { advancesFor, totalAdvancesTiyn } from "./advances";
import { shiftPeriod } from "./salaryPeriod";
import type { SalaryAdvance, SalaryEntry } from "../types/domain";

/**
 * Advances taken past a period's pay carry into the next period.
 *
 * The owner's rule (02.11): «350-ден асқанын осы айға жаз — 390 болса, 40 мың осы айға». An
 * advance over the month's salary is not lost and is not a negative payslip: the part over the pay
 * comes off the next period's pay instead, as if it had been taken then. So Сүндет's 370 000 ₸ of
 * October advances against 350 000 ₸ closes October at 350 000 and opens November 20 000 down.
 *
 * Nothing is moved or rewritten: every advance stays filed under the period it was handed over
 * in. The carry is worked out from those advances and each earlier period's salary entry — its
 * finalTiyn, the figure the Айлық page computes and stores — walking back for as long as entries
 * exist. A period with no entry ends the walk: with no salary worked out for it there is no honest
 * "over" to carry, and an old advance must never surface as a debt nobody can explain.
 */

/** How far back the walk goes at most — two years of months, or about half a year of weeks. */
const MAX_PERIODS_BACK = 24;

/** The part of the earlier periods' advances, over their pay, that comes off `periodKey`. */
export function carriedIntoPeriod({
  advances,
  entries,
  userId,
  periodKey,
}: {
  advances: SalaryAdvance[];
  entries: Pick<SalaryEntry, "userId" | "periodKey" | "finalTiyn">[];
  userId: string;
  periodKey: string;
}): number {
  const finalFor = new Map(entries.filter((e) => e.userId === userId).map((e) => [e.periodKey, e.finalTiyn]));
  const chain: string[] = [];
  let p = shiftPeriod(periodKey, -1);
  for (let i = 0; i < MAX_PERIODS_BACK && finalFor.has(p); i++) {
    chain.unshift(p);
    p = shiftPeriod(p, -1);
  }
  let carry = 0;
  for (const q of chain) {
    const taken = totalAdvancesTiyn(advancesFor(advances, userId, q)) + carry;
    carry = Math.max(0, taken - (finalFor.get(q) ?? 0));
  }
  return carry;
}

export interface CarriedAdvanceSummary {
  /** This period's own advances, newest first. */
  entries: SalaryAdvance[];
  /** Their sum. */
  ownTiyn: number;
  /** Brought from the earlier periods — what was taken there over their pay. */
  carriedInTiyn: number;
  /** Everything that comes off this period's pay: own + carried in. */
  totalTiyn: number;
  /** Earned less all of it, floored at zero — what is still to hand over. */
  remainingTiyn: number;
  /** Taken past this period's pay — it comes off the next period's. */
  carriedOutTiyn: number;
  overdrawn: boolean;
}

/** What is taken against a period, the carry from the periods before included, and what is left. */
export function summariseAdvancesWithCarry({
  advances,
  entries,
  userId,
  periodKey,
  earnedTiyn,
}: {
  advances: SalaryAdvance[];
  entries: Pick<SalaryEntry, "userId" | "periodKey" | "finalTiyn">[];
  userId: string;
  periodKey: string;
  earnedTiyn: number;
}): CarriedAdvanceSummary {
  const own = advancesFor(advances, userId, periodKey);
  const ownTiyn = totalAdvancesTiyn(own);
  const carriedInTiyn = carriedIntoPeriod({ advances, entries, userId, periodKey });
  const totalTiyn = ownTiyn + carriedInTiyn;
  return {
    entries: own,
    ownTiyn,
    carriedInTiyn,
    totalTiyn,
    remainingTiyn: Math.max(0, earnedTiyn - totalTiyn),
    carriedOutTiyn: Math.max(0, totalTiyn - earnedTiyn),
    overdrawn: totalTiyn > earnedTiyn,
  };
}
