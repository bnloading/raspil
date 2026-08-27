import type { Order, Payment, PaymentStatus } from "../types/domain";
import { computePaymentStatus } from "./statuses";

/**
 * Money arithmetic for the Manager order journal ("ЛДСП — ТАПСЫРЫС ЖУРНАЛЫ").
 *
 * Everything here is integer tiyn (1 ₸ = 100 tiyn) and every function is pure, so the journal's
 * live per-row preview and the value actually persisted come from the same code path — a cell can
 * never display one total and save another. See src/lib/journal.test.ts.
 */

export interface JournalRowInput {
  sheetQty: number;
  sheetPriceTiyn: number;
  pvcMeters: number;
  pvcPricePerMeterTiyn: number;
  hdfCostTiyn: number;
  cuttingCostTiyn: number;
  extraServicesTiyn: number;
  deliveryCostTiyn: number;
  discountTiyn: number;
  paidTiyn: number;
}

export interface JournalRowTotals {
  materialCostTiyn: number;
  pvcCostTiyn: number;
  totalTiyn: number;
  debtTiyn: number;
  paymentStatus: PaymentStatus;
}

/**
 * Sheet total + PVC total + HDF + cutting + extras + delivery − discount = final total, then
 * debt = total − paid. Never clamps `debt` at zero: an overpaid order legitimately carries a
 * negative balance, which "Артық төленді" then reports rather than silently hiding.
 */
export function computeJournalRowTotals(input: JournalRowInput): JournalRowTotals {
  const materialCostTiyn = Math.round(input.sheetQty * input.sheetPriceTiyn);
  const pvcCostTiyn = Math.round(input.pvcMeters * input.pvcPricePerMeterTiyn);
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
const NON_DEBT_STATUSES: Order["productionStatus"][] = ["draft", "cancelled"];

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
 * Debt per customer, derived from orders rather than stored — the spec's "do not manually type a
 * debt value that can become inconsistent". Orders are keyed by customerId when the customer has
 * an account and by normalized phone otherwise, so a walk-in order typed straight into the journal
 * still lands on the same customer card as their online orders.
 */
export function computeCustomerDebts(orders: Order[]): CustomerDebt[] {
  const byCustomer = new Map<string, CustomerDebt>();

  for (const order of orders) {
    if (NON_DEBT_STATUSES.includes(order.productionStatus)) continue;
    const customerKey = order.customerId || `phone:${order.customerPhone}`;
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
