import type { Order, Payment, PaymentStatus } from "../types/domain";
import { normalizePhone } from "./phone";
import { computePaymentStatus } from "./statuses";

/**
 * Money arithmetic for the Manager order journal ("ЛДСП — ТАПСЫРЫС ЖУРНАЛЫ").
 *
 * Everything here is integer tiyn (1 ₸ = 100 tiyn) and every function is pure, so the journal's
 * live per-row preview and the value actually persisted come from the same code path — a cell can
 * never display one total and save another. See src/lib/journal.test.ts.
 */

/** One material line of a journal row: sheets at a price, plus its own edge banding. */
export interface JournalLineInput {
  sheetQty: number;
  sheetPriceTiyn: number;
  pvcMeters: number;
  pvcPricePerMeterTiyn: number;
}

/**
 * A journal row is always a list of lines, never a single material.
 *
 * A plain walk-in is a one-line row; a merged order ("2 материал") is a two-line row. Before this,
 * a merged row was priced as `total sheets × the FIRST line's price`, which quietly rewrote the
 * order's real total the moment anyone touched the row. Summing per line is the only arithmetic
 * that is right for both shapes, so there is only one shape now.
 */
export interface JournalRowInput {
  lines: JournalLineInput[];
  hdfCostTiyn: number;
  cuttingCostTiyn: number;
  extraServicesTiyn: number;
  deliveryCostTiyn: number;
  discountTiyn: number;
  paidTiyn: number;
}

export interface JournalLineTotals {
  materialCostTiyn: number;
  pvcCostTiyn: number;
  /** What this one line alone is worth — order-level extras and the discount are not in here. */
  lineTotalTiyn: number;
}

export interface JournalRowTotals {
  /** Index-aligned with the input lines, so each sub-row can show its own money. */
  lineTotals: JournalLineTotals[];
  materialCostTiyn: number;
  pvcCostTiyn: number;
  totalTiyn: number;
  debtTiyn: number;
  paymentStatus: PaymentStatus;
}

/** Sheets × price and metres × rate for a single line, rounded to whole tiyn. */
export function computeLineTotals(line: JournalLineInput): JournalLineTotals {
  const materialCostTiyn = Math.round(line.sheetQty * line.sheetPriceTiyn);
  const pvcCostTiyn = Math.round(line.pvcMeters * line.pvcPricePerMeterTiyn);
  return { materialCostTiyn, pvcCostTiyn, lineTotalTiyn: materialCostTiyn + pvcCostTiyn };
}

/**
 * Every line's sheets + PVC, then + HDF + cutting + extras + delivery − discount = final total,
 * then debt = total − paid. Never clamps `debt` at zero: an overpaid order legitimately carries a
 * negative balance, which "Артық төленді" then reports rather than silently hiding.
 */
export function computeJournalRowTotals(input: JournalRowInput): JournalRowTotals {
  const lineTotals = input.lines.map(computeLineTotals);
  const materialCostTiyn = lineTotals.reduce((s, l) => s + l.materialCostTiyn, 0);
  const pvcCostTiyn = lineTotals.reduce((s, l) => s + l.pvcCostTiyn, 0);
  const totalTiyn = Math.max(
    0,
    materialCostTiyn +
      pvcCostTiyn +
      input.hdfCostTiyn +
      input.cuttingCostTiyn +
      input.extraServicesTiyn +
      input.deliveryCostTiyn -
      input.discountTiyn,
  );
  return {
    lineTotals,
    materialCostTiyn,
    pvcCostTiyn,
    totalTiyn,
    debtTiyn: totalTiyn - input.paidTiyn,
    paymentStatus: computePaymentStatus(totalTiyn, input.paidTiyn),
  };
}

/**
 * Net paid for one order = every non-reversed payment. A reversed payment stays in the ledger
 * (financial records are never deleted) but stops counting toward the total, which is what makes
 * "reversal recalculates automatically" work without a separate correcting entry.
 */
export function netPaidTiyn(payments: Payment[]): number {
  return payments.reduce((sum, p) => (p.reversed ? sum : sum + p.amountTiyn), 0);
}

/**
 * Paid amount split per payment method, for the journal's Нал/Kaspi/Pay/Нұр/Бәлім columns. A
 * "mixed" (Аралас) payment is recorded as one row per method/amount pair sharing a groupId, so
 * this needs no special case: each leg already carries its own methodId.
 */
export function paidByMethod(payments: Payment[]): Map<string, number> {
  const byMethod = new Map<string, number>();
  for (const p of payments) {
    if (p.reversed) continue;
    byMethod.set(p.methodId, (byMethod.get(p.methodId) ?? 0) + p.amountTiyn);
  }
  return byMethod;
}

/** Groups every payment by its order, so one journal render needs one payments query, not one per row. */
export function groupPaymentsByOrder(payments: Payment[]): Map<string, Payment[]> {
  const byOrder = new Map<string, Payment[]>();
  for (const p of payments) {
    const list = byOrder.get(p.orderId);
    if (list) list.push(p);
    else byOrder.set(p.orderId, [p]);
  }
  return byOrder;
}

/** Statuses whose debt is not real money owed — a cancelled order can't be "collected". */
export const NON_DEBT_STATUSES: Order["productionStatus"][] = ["draft", "cancelled"];

export interface CustomerDebt {
  customerKey: string;
  customerName: string;
  customerPhone: string;
  orderTotalTiyn: number;
  paidTiyn: number;
  debtTiyn: number;
  unpaidOrderCount: number;
  oldestDebtAtMs: number | null;
}

/**
 * Which customer an order belongs to, for rolling money up.
 *
 * The account when there is one, then the phone, then the NAME — and that last step is the one
 * that matters. The rule used to end at the phone, so every walk-in typed into the journal
 * without a number shared the key "phone:" and the debt ledger folded eight different people into
 * a single row carrying the sum of all of them, under whichever name happened to be read first.
 *
 * The phone is normalised so "+7 701…" and "87 01…" are one customer rather than two. This is the
 * same rule orderMerge.ts checks before allowing a merge and customerSuggest.ts groups the name
 * completions by — the three have to agree, or the ledger will show a debt for somebody the shop
 * is not allowed to merge and cannot look up.
 */
export function customerDebtKey(order: Pick<Order, "customerId" | "customerName" | "customerPhone">): string {
  if (order.customerId) return order.customerId;
  const digits = normalizePhone(order.customerPhone ?? "");
  if (digits) return `phone:${digits}`;
  return `name:${(order.customerName ?? "").trim().toLowerCase()}`;
}

/**
 * Debt per customer, derived from orders rather than stored — the spec's "do not manually type a
 * debt value that can become inconsistent". Keyed by customerDebtKey, so a walk-in order typed
 * straight into the journal lands on the same customer card as that customer's online orders.
 */
export function computeCustomerDebts(orders: Order[]): CustomerDebt[] {
  const byCustomer = new Map<string, CustomerDebt>();

  for (const order of orders) {
    if (NON_DEBT_STATUSES.includes(order.productionStatus)) continue;
    const customerKey = customerDebtKey(order);
    const existing = byCustomer.get(customerKey);
    const entry: CustomerDebt = existing ?? {
      customerKey,
      customerName: order.customerName,
      customerPhone: order.customerPhone,
      orderTotalTiyn: 0,
      paidTiyn: 0,
      debtTiyn: 0,
      unpaidOrderCount: 0,
      oldestDebtAtMs: null,
    };

    entry.orderTotalTiyn += order.totalTiyn;
    entry.paidTiyn += order.paidTiyn;
    // Only positive balances add to debt — an overpaid order must not silently offset a different
    // order's genuine outstanding balance.
    const orderDebt = Math.max(0, order.totalTiyn - order.paidTiyn);
    entry.debtTiyn += orderDebt;
    if (orderDebt > 0) {
      entry.unpaidOrderCount += 1;
      const createdMs = order.createdAt ? order.createdAt.toMillis() : null;
      if (createdMs !== null && (entry.oldestDebtAtMs === null || createdMs < entry.oldestDebtAtMs)) {
        entry.oldestDebtAtMs = createdMs;
      }
    }

    if (!existing) byCustomer.set(customerKey, entry);
  }

  return [...byCustomer.values()].sort((a, b) => b.debtTiyn - a.debtTiyn);
}

/** One compact material summary line for a journal row, e.g. "6 лист · 89 м ПВХ". */
export function materialSummary(order: Order): string {
  const parts: string[] = [];
  const sheets = order.confirmedSheets ?? order.estimatedSheets;
  if (sheets > 0) parts.push(`${sheets} лист`);
  if (order.pvcMetersTotal > 0) parts.push(`${Math.round(order.pvcMetersTotal)} м ПВХ`);
  return parts.join(" · ") || "—";
}
