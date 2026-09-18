import { monthKey, monthLabel, weekKey, weekLabel } from "./dates";
import type { UserRole } from "../types/domain";

/**
 * How long one pay period is, per role.
 *
 * Распил is paid every week — the cutter takes his money each Monday for the week just worked,
 * which is how the shop has always run — while every other station settles up once a month. Both
 * go through the same salaryEntries ledger and the same rule engine; the only thing that differs
 * is the shape of `periodKey`, so this module is the single place that knows which is which.
 *
 * The two key shapes are told apart by length, never by a stored flag:
 *   month → "2026-09"      (7 chars, see dates.ts monthKey)
 *   week  → "2026-09-14"   (10 chars — the Monday that opens the week, see dates.ts weekKey)
 * That means an entry written months ago still reads correctly from its id alone, and a period
 * key can travel through the app (urls, document ids, props) without a second field tagging along
 * to say what it is.
 */

export type SalaryPeriodKind = "week" | "month";

/** Roles settled weekly. Everything not listed here is monthly. */
export const WEEKLY_SALARY_ROLES: readonly UserRole[] = ["raspil"];

export function salaryPeriodKind(role: UserRole | undefined): SalaryPeriodKind {
  return role && WEEKLY_SALARY_ROLES.includes(role) ? "week" : "month";
}

/** Reads the shape of an existing key, so old entries keep working without a stored marker. */
export function periodKindOf(periodKey: string): SalaryPeriodKind {
  return periodKey.length > 7 ? "week" : "month";
}

/** The period a given moment falls in, for a role that is paid weekly or monthly. */
export function currentPeriodKey(kind: SalaryPeriodKind, now: Date = new Date()): string {
  return kind === "week" ? weekKey(now) : monthKey(now);
}

/** "14–20 қыр" for a week, "Қыркүйек 2026" for a month. */
export function periodLabel(periodKey: string): string {
  return periodKindOf(periodKey) === "week" ? weekLabel(periodKey) : monthLabel(periodKey);
}

/** Whether a moment belongs to this period — the one test every salary measurement runs on. */
export function periodContains(periodKey: string, date: Date): boolean {
  return periodKindOf(periodKey) === "week"
    ? weekKey(date) === periodKey
    : monthKey(date) === periodKey;
}

/**
 * Same test for an already-keyed calendar day ("YYYY-MM-DD", as attendance records store it).
 * Compared as text rather than parsed back into a Date: the string is already Almaty-local, and
 * re-parsing it only reintroduces the timezone question the key exists to settle.
 */
export function periodContainsDay(periodKey: string, day: string): boolean {
  if (periodKindOf(periodKey) === "month") return day.startsWith(periodKey);
  return day >= periodKey && day <= addDays(periodKey, 6);
}

/** Moves one period forward or back — a week or a month, whichever this key is. */
export function shiftPeriod(periodKey: string, delta: number): string {
  if (periodKindOf(periodKey) === "week") return addDays(periodKey, delta * 7);
  const [y, m] = periodKey.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Day arithmetic on a "YYYY-MM-DD" key, in UTC so a DST-free shift can never slip a day. */
function addDays(day: string, delta: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}
