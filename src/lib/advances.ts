import { monthKey } from "./dates";
import type { SalaryAdvance } from "../types/domain";

/**
 * Advances against a month's pay.
 *
 * The rule the shop actually runs on: an advance is money already handed over, so it reduces what
 * is still owed on payday — never what was earned. Keeping those two numbers apart matters,
 * because a worker who took 200 000 ₸ of a 350 000 ₸ salary has still earned the full 350 000 and
 * their payslip has to say so.
 */

export interface AdvanceSummary {
  /** Live advances for the period, newest first. */
  entries: SalaryAdvance[];
  /** Sum of those, in tiyn. Reversed ones are excluded. */
  totalTiyn: number;
  /** Earned less advances, floored at zero. */
  remainingTiyn: number;
  /** True when the worker has drawn more than the month earned. */
  overdrawn: boolean;
}

/** A reversed advance is a correction, not a payment — it never counts. */
export function isLive(advance: SalaryAdvance): boolean {
  return !advance.reversed;
}

/** The advances belonging to one worker and one YYYY-MM period. */
export function advancesFor(
  advances: SalaryAdvance[],
  userId: string,
  periodKey: string,
): SalaryAdvance[] {
  return advances
    .filter((a) => a.userId === userId && a.periodKey === periodKey && isLive(a))
    .sort((a, b) => (b.paidAt?.seconds ?? 0) - (a.paidAt?.seconds ?? 0));
}

export function totalAdvancesTiyn(advances: SalaryAdvance[]): number {
  return advances.filter(isLive).reduce((s, a) => s + Math.max(0, a.amountTiyn), 0);
}

/**
 * What the worker has drawn and what is left of a month's pay.
 *
 * `earnedTiyn` is the finished salary figure (base ± adjustments), so this only ever subtracts.
 */
export function summariseAdvances({
  advances,
  userId,
  periodKey,
  earnedTiyn,
}: {
  advances: SalaryAdvance[];
  userId: string;
  periodKey: string;
  earnedTiyn: number;
}): AdvanceSummary {
  const entries = advancesFor(advances, userId, periodKey);
  const totalTiyn = totalAdvancesTiyn(entries);
  return {
    entries,
    totalTiyn,
    // Floored: the shop does not carry a negative payslip. Overdrawing is surfaced by the flag
    // instead, so it is visible rather than hidden inside a zero.
    remainingTiyn: Math.max(0, earnedTiyn - totalTiyn),
    overdrawn: totalTiyn > earnedTiyn,
  };
}

/** The period an advance recorded now belongs to. */
export function currentPeriodKey(now: Date = new Date()): string {
  return monthKey(now);
}
