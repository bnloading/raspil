import type { Order } from "../types/domain";

/**
 * The journal's quick filters — the row of counted chips above the ledger.
 *
 * These replace the old "Барлық төлем" dropdown. A dropdown hides both the options and the size of
 * each one behind a click; the chips answer "how many are still owing?" without any interaction at
 * all, which is the question the manager actually opens this page with.
 *
 * Payment chips are judged on the money, not on `order.paymentStatus`: the stored status can be a
 * merge behind the payments ledger, and every other figure on this page is derived from the
 * payments, so these are too.
 */

export type JournalQuickFilter = "all" | "paid" | "debt" | "queued" | "cut";

export const JOURNAL_QUICK_FILTERS: { id: JournalQuickFilter; label: string }[] = [
  { id: "all", label: "Барлығы" },
  { id: "paid", label: "Төленді" },
  { id: "debt", label: "Қарыз" },
  { id: "queued", label: "Распил кезегінде" },
  { id: "cut", label: "Кесілді" },
];

/** Statuses that mean the sheets have been through the saw. */
const CUT_STATUSES: Order["productionStatus"][] = [
  "cutting_completed",
  "pvc_queue",
  "pvc_started",
  "pvc_completed",
  "ready",
  "delivered",
];

/**
 * Statuses in which the order has already been handed to the shop floor.
 *
 * Wider than CUT_STATUSES above, which asks "has it been through the saw": this asks the earlier
 * question, "has anybody been given it yet", and cutting_queue is where that becomes true.
 */
const QUEUED_OR_LATER: Order["productionStatus"][] = [
  "cutting_queue",
  "cutting_started",
  ...CUT_STATUSES,
];

/**
 * Still sitting in the journal, never sent to the saw.
 *
 * This is the row that needs a decision from the manager rather than from anyone else in the shop,
 * so the ledger marks it: at a glance, red is work that has been written down and not yet passed
 * on. A cancelled order is not waiting for anything, so it is not marked.
 */
export function awaitingCutting(order: Order): boolean {
  if (order.productionStatus === "cancelled") return false;
  return !QUEUED_OR_LATER.includes(order.productionStatus);
}

/**
 * Does one order belong under a given chip?
 *
 * `paidTiyn` is the rolled-up, non-reversed total for the order — the caller has it already, and
 * passing it in keeps this pure and testable rather than reaching for the payments collection.
 */
export function matchesQuickFilter(order: Order, paidTiyn: number, filter: JournalQuickFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "paid":
      return paidTiyn >= order.totalTiyn && order.totalTiyn > 0;
    case "debt":
      // A cancelled order owes nothing, whatever its stored figures say.
      return order.productionStatus !== "cancelled" && order.totalTiyn - paidTiyn > 0;
    case "queued":
      return order.productionStatus === "cutting_queue" || order.productionStatus === "cutting_started";
    case "cut":
      return CUT_STATUSES.includes(order.productionStatus);
  }
}

/** How many rows sit under each chip, for the counts printed on them. */
export function quickFilterCounts(
  orders: Order[],
  paidFor: (order: Order) => number,
): Record<JournalQuickFilter, number> {
  const counts: Record<JournalQuickFilter, number> = { all: 0, paid: 0, debt: 0, queued: 0, cut: 0 };
  for (const order of orders) {
    const paid = paidFor(order);
    for (const { id } of JOURNAL_QUICK_FILTERS) {
      if (matchesQuickFilter(order, paid, id)) counts[id] += 1;
    }
  }
  return counts;
}

/**
 * The three milestones the "Өндіріс барысы" column draws: money in, sheets cut, order finished.
 *
 * Sixteen production statuses are more than anyone standing at a counter needs to read at a
 * glance. Collapsed to three dots, a row says what it is waiting for without being read word by
 * word — and the one that is not yet "done" is the one the action button acts on.
 */
export type StepState = "done" | "active" | "todo" | "blocked";

export interface ProgressStep {
  key: "payment" | "cutting" | "ready";
  label: string;
  state: StepState;
}

export function journalProgress(order: Order, paidTiyn: number): ProgressStep[] {
  const s = order.productionStatus;
  const cancelled = s === "cancelled";
  const owing = order.totalTiyn - paidTiyn;

  const payment: StepState =
    cancelled ? "blocked"
    : owing <= 0 ? "done"
    : paidTiyn > 0 ? "active"
    : "blocked";

  const cutting: StepState =
    cancelled ? "blocked"
    : CUT_STATUSES.includes(s) ? "done"
    : s === "cutting_started" ? "active"
    : s === "cutting_queue" ? "active"
    : "todo";

  const ready: StepState =
    cancelled ? "blocked"
    : s === "delivered" || s === "ready" ? "done"
    : s === "pvc_started" || s === "pvc_queue" ? "active"
    : "todo";

  return [
    { key: "payment", label: "Төлем", state: payment },
    { key: "cutting", label: "Распил", state: cutting },
    { key: "ready", label: "Дайын", state: ready },
  ];
}
