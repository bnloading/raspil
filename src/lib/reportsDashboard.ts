import { dayKey, startOfDayAlmaty, startOfMonthAlmaty, startOfWeekAlmaty } from "./dates";
import { computeCustomerDebts } from "./journal";
import { jobsOf } from "./orderLines";
import type { Order, Payment } from "../types/domain";

/**
 * The figures behind the Есептер dashboard.
 *
 * Everything here is pure and takes an explicit `now`, because every one of these answers depends
 * on where "today" starts — and the shop's day starts in Almaty, not in whatever timezone the
 * browser happens to be in. Money is counted from the payments, never from an order's stored
 * `paidTiyn`, for the same reason the journal does: a reversal has to disappear from the takings.
 */

/** Which stretch of time a figure covers. */
export type ReportPeriod = "today" | "week" | "month";

export const PERIOD_LABELS: Record<ReportPeriod, string> = {
  today: "Бүгін",
  week: "Апта",
  month: "Ай",
};

export function periodStart(period: ReportPeriod, now: Date): Date {
  switch (period) {
    case "today":
      return startOfDayAlmaty(now);
    case "week":
      return startOfWeekAlmaty(now);
    case "month":
      return startOfMonthAlmaty(now);
  }
}

/** The same stretch, one period earlier — what "+12% өткен аптадан" is measured against. */
export function previousPeriodRange(period: ReportPeriod, now: Date): { from: Date; to: Date } {
  const to = periodStart(period, now);
  const from = new Date(to);
  switch (period) {
    case "today":
      from.setDate(from.getDate() - 1);
      break;
    case "week":
      from.setDate(from.getDate() - 7);
      break;
    case "month":
      from.setMonth(from.getMonth() - 1);
      break;
  }
  return { from, to };
}

function paidBetween(payments: readonly Payment[], from: Date, to?: Date): number {
  let sum = 0;
  for (const p of payments) {
    if (p.reversed || !p.paymentDate) continue;
    const at = p.paymentDate.toDate();
    if (at < from) continue;
    if (to && at >= to) continue;
    sum += p.amountTiyn;
  }
  return sum;
}

export interface RevenueReading {
  currentTiyn: number;
  previousTiyn: number;
  /**
   * Percent change against the previous period, rounded — or null when there is nothing to
   * compare with. A jump from zero is not "+100%", it is the first money of its kind, and saying
   * a number there would be inventing one.
   */
  changePct: number | null;
}

export function revenueFor(
  payments: readonly Payment[],
  period: ReportPeriod,
  now: Date = new Date(),
): RevenueReading {
  const currentTiyn = paidBetween(payments, periodStart(period, now));
  const previous = previousPeriodRange(period, now);
  const previousTiyn = paidBetween(payments, previous.from, previous.to);

  return {
    currentTiyn,
    previousTiyn,
    changePct: previousTiyn > 0 ? Math.round(((currentTiyn - previousTiyn) / previousTiyn) * 100) : null,
  };
}

/** Kazakh weekday initials, Monday first — the shop's week, and the order startOfWeekAlmaty uses. */
const WEEKDAYS = ["Дс", "Сс", "Ср", "Бс", "Жм", "Сб", "Жс"];

export interface DayRevenue {
  /** "YYYY-MM-DD" in Almaty, so a bar can be matched back to its day. */
  key: string;
  label: string;
  valueTiyn: number;
}

/**
 * Money taken on each day of the current week, Monday to Sunday.
 *
 * Every day is present even when nothing came in: a bar chart with the quiet days missing reads
 * as a busy week, and the gap is the point of looking.
 */
export function weeklyRevenue(payments: readonly Payment[], now: Date = new Date()): DayRevenue[] {
  const monday = startOfWeekAlmaty(now);
  const days: DayRevenue[] = [];

  for (let i = 0; i < 7; i += 1) {
    const from = new Date(monday);
    from.setDate(from.getDate() + i);
    const to = new Date(from);
    to.setDate(to.getDate() + 1);
    days.push({ key: dayKey(from), label: WEEKDAYS[i], valueTiyn: paidBetween(payments, from, to) });
  }

  return days;
}

export interface DebtOverview {
  totalTiyn: number;
  /** How many customers owe anything at all. */
  customers: number;
  /** Of those, how many have been owing longer than `overdueDays`. */
  overdue: number;
}

/**
 * What the shop is owed, and how much of it has gone stale.
 *
 * Counted per customer rather than per order, because that is who gets chased — one person with
 * four unpaid orders is one phone call. `overdueDays` is measured from the oldest unpaid order,
 * so a customer who keeps ordering does not have their old debt reset by a new one.
 */
export function debtOverview(
  orders: readonly Order[],
  now: Date = new Date(),
  overdueDays = 30,
): DebtOverview {
  const debts = computeCustomerDebts([...orders]).filter((d) => d.debtTiyn > 0);
  const cutoff = now.getTime() - overdueDays * 86_400_000;

  // computeCustomerDebts now reports распил and МДФ debt as separate rows for the same customer
  // (CustomerDebt.orderKind) — someone owing on both lines must still count once here, since this
  // is a headcount of who gets chased, not a count of debt rows.
  const overdueRows = debts.filter((d) => d.oldestDebtAtMs !== null && d.oldestDebtAtMs < cutoff);
  return {
    totalTiyn: debts.reduce((s, d) => s + d.debtTiyn, 0),
    customers: new Set(debts.map((d) => d.customerKey)).size,
    overdue: new Set(overdueRows.map((d) => d.customerKey)).size,
  };
}

/**
 * Metres of edging finished since `from`, credited on the date the work was done.
 *
 * Per material line, like the salary engine: a merged order's two banded lines finish separately,
 * and counting the order's whole `pvcMetersTotal` when the first one lands would report work that
 * has not happened yet.
 */
export function pvcMetersSince(orders: readonly Order[], from: Date): number {
  let metres = 0;
  for (const order of orders) {
    for (const job of jobsOf(order)) {
      if (!job.pvcCompletedAt) continue;
      if (job.pvcCompletedAt.toDate() < from) continue;
      metres += job.pvcMeters ?? 0;
    }
  }
  return Math.round(metres);
}
