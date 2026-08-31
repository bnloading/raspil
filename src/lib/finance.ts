import { monthKey } from "./dates";
import { monthlyExpensesTotal } from "./expenses";
import { linesOf } from "./orderMerge";
import type { Expense, ExpenseCategory, Order, Payment } from "../types/domain";

/**
 * The shop's standing rule: 5% of each month's gross profit is set aside for the machine and for
 * waste/offcuts. It lives here as the fallback only — the real rate is an ExpenseCategory row an
 * Admin can change, so this constant is what the summary falls back to before anyone has
 * configured one (and what scripts/seed-expense-categories.mjs writes).
 */
export const MACHINE_WASTE_PCT = 5;
export const MACHINE_WASTE_NAME = "Станок / мусор";

export interface Allocation {
  name: string;
  percentage: number;
  amountTiyn: number;
}

export interface FinanceSummary {
  /** YYYY-MM in Asia/Almaty, or null for the all-time figures. */
  monthKey: string | null;
  /** Sum of every order billed in the period (draft and cancelled excluded). */
  billedTiyn: number;
  /** Money actually received in the period — non-reversed payments only. */
  receivedTiyn: number;
  /** Still owed on orders billed in the period. */
  debtTiyn: number;
  /** What the materials on those orders cost us. */
  costTiyn: number;
  /** billedTiyn − costTiyn. Never negative in practice, but not clamped: a loss should show. */
  grossProfitTiyn: number;
  /** One row per active expense category, including the machine/waste set-aside. */
  allocations: Allocation[];
  /** Sum of the period's hand-logged one-off expenses (Мусор, жөндеу, …) — see lib/expenses.ts. */
  fixedExpensesTiyn: number;
  /** Gross profit less every allocation above, and less fixedExpensesTiyn. */
  netProfitTiyn: number;
  orderCount: number;
}

/** Orders that represent real money: a draft was never submitted and a cancellation was undone. */
function isBillable(order: Order): boolean {
  return order.productionStatus !== "draft" && order.productionStatus !== "cancelled";
}

/**
 * What an order's materials cost us, as opposed to what we charged for them.
 *
 * `materialCostTiyn` on the order is the *customer-facing* material line (sheets × selling price),
 * so subtracting it from the total would always yield zero material margin. The real cost is the
 * sheet count times the material's own purchase price, which lives on the Material record — hence
 * `purchaseByMaterialId`. A material that has been deleted, or one whose purchase price was never
 * entered, contributes 0 cost rather than guessing: overstating profit is the safer failure here
 * only because the alternative — inventing a cost — would be untraceable.
 */
function orderCostTiyn(order: Order, purchaseByMaterialId: Map<string, number>): number {
  // Line by line: a merged order carries several materials at several purchase prices, and
  // costing all of its sheets at the first material's rate is how a 7 500 ₸ ХДФ sheet used to be
  // booked as an ЛДСП one. linesOf() returns the single material for an unmerged order, so this
  // is the same arithmetic as before wherever there is only one.
  return linesOf(order).reduce(
    (sum, line) => sum + line.sheetQty * (purchaseByMaterialId.get(line.materialId) ?? 0),
    0,
  );
}

/**
 * Money summary for one month, or for all time when `period` is null.
 *
 * Billed and received are deliberately two different numbers rather than one "revenue": an order
 * invoiced in March and paid in April belongs to March's profit and April's cash. Profit is
 * computed from *billed*, because that is when the work and its cost happened.
 */
export function computeFinanceSummary({
  orders,
  payments,
  purchaseByMaterialId,
  categories,
  expenses = [],
  period,
}: {
  orders: Order[];
  payments: Payment[];
  purchaseByMaterialId: Map<string, number>;
  categories: ExpenseCategory[];
  /** Hand-logged one-off expenses (see lib/expenses.ts) — defaults to none for callers that don't
   *  have them loaded, so the percentage-only summary still works everywhere it used to. */
  expenses?: Expense[];
  /** YYYY-MM in Asia/Almaty, or null for all time. */
  period: string | null;
}): FinanceSummary {
  const inPeriod = (ts: { seconds: number } | undefined): boolean => {
    if (period === null) return true;
    if (!ts) return false;
    return monthKey(ts) === period;
  };

  const billedOrders = orders.filter((o) => isBillable(o) && inPeriod(o.createdAt));

  const billedTiyn = billedOrders.reduce((s, o) => s + o.totalTiyn, 0);
  const debtTiyn = billedOrders.reduce((s, o) => s + Math.max(0, o.debtTiyn), 0);
  const costTiyn = billedOrders.reduce((s, o) => s + orderCostTiyn(o, purchaseByMaterialId), 0);

  const receivedTiyn = payments
    .filter((p) => !p.reversed && inPeriod(p.paymentDate))
    .reduce((s, p) => s + p.amountTiyn, 0);

  const grossProfitTiyn = billedTiyn - costTiyn;

  // No configured categories at all still has to show the machine/waste rule the shop actually
  // runs on, so the constant stands in until an Admin creates the row.
  const active = categories.filter((c) => c.active);
  const rows = active.length > 0
    ? active
    : [{ name: MACHINE_WASTE_NAME, percentage: MACHINE_WASTE_PCT } as ExpenseCategory];

  const allocations: Allocation[] = rows.map((c) => ({
    name: c.name,
    percentage: c.percentage,
    // Round to whole tiyn so the allocations always re-sum to a displayable figure.
    amountTiyn: Math.round((grossProfitTiyn * c.percentage) / 100),
  }));

  const fixedExpensesTiyn = monthlyExpensesTotal(expenses, period);

  return {
    monthKey: period,
    billedTiyn,
    receivedTiyn,
    debtTiyn,
    costTiyn,
    grossProfitTiyn,
    allocations,
    fixedExpensesTiyn,
    netProfitTiyn: grossProfitTiyn - allocations.reduce((s, a) => s + a.amountTiyn, 0) - fixedExpensesTiyn,
    orderCount: billedOrders.length,
  };
}

/** The months that actually have billable orders, newest first, for the period picker. */
export function availableMonths(orders: Order[]): string[] {
  const set = new Set<string>();
  for (const o of orders) {
    if (isBillable(o) && o.createdAt) set.add(monthKey(o.createdAt));
  }
  return [...set].sort().reverse();
}
