import { useMemo } from "react";
import { usePaymentsForOrders } from "./usePayments";
import { netPaidTiyn } from "../lib/journal";
import type { Order, Payment } from "../types/domain";

/** An order the customer can owe on: placed (not a draft), not cancelled, and priced by the shop. */
export function isBillable(order: Order): boolean {
  return order.productionStatus !== "draft" && order.productionStatus !== "cancelled" && order.pricePublished !== false;
}

export interface CustomerDebts {
  billable: Order[];
  /** Orders with something still to pay, oldest first — the order the money is chased in. */
  owing: Order[];
  /** Every payment on the customer's billable orders, reversed ones included. */
  payments: Payment[];
  paymentsByOrder: Map<string, Payment[]>;
  paidOf: (order: Order) => number;
  /** What is left to pay on one order; 0 for an order that cannot be owed on. */
  debtOf: (order: Order) => number;
  totals: { orderedTiyn: number; paidTiyn: number; debtTiyn: number; cuttingDebtTiyn: number; mdfDebtTiyn: number };
  paymentsLoading: boolean;
}

/**
 * What a customer owes, order by order — worked out the way the journal works its own «Қарыз»:
 * the order's sum less every payment on it that was not reversed (lib/journal.ts netPaidTiyn).
 *
 * One source for the customer's home, «Заказдарым» and «Қарыз», so the three never show three
 * different debts; until the payments are in, the order's stored figures stand in for them.
 */
export function useCustomerDebts(orders: Order[]): CustomerDebts {
  const billable = useMemo(() => orders.filter(isBillable), [orders]);
  // Scoped to the customer's own order ids — an unfiltered payments query is refused for them.
  const { payments, byOrder, loading } = usePaymentsForOrders(useMemo(() => billable.map((o) => o.id), [billable]));

  return useMemo(() => {
    const billableIds = new Set(billable.map((o) => o.id));
    const paidOf = (o: Order) => (loading ? o.paidTiyn : netPaidTiyn(byOrder.get(o.id) ?? []));
    const debtOf = (o: Order) => (billableIds.has(o.id) ? o.totalTiyn - paidOf(o) : 0);
    const owing = billable
      .filter((o) => debtOf(o) > 0)
      .sort((a, b) => (a.createdAt?.seconds ?? 0) - (b.createdAt?.seconds ?? 0));
    const debtTiyn = owing.reduce((s, o) => s + debtOf(o), 0);
    const mdfDebtTiyn = owing.filter((o) => o.orderKind === "mdf_wrap").reduce((s, o) => s + debtOf(o), 0);
    return {
      billable,
      owing,
      payments,
      paymentsByOrder: byOrder,
      paidOf,
      debtOf,
      totals: {
        orderedTiyn: billable.reduce((s, o) => s + o.totalTiyn, 0),
        paidTiyn: billable.reduce((s, o) => s + paidOf(o), 0),
        debtTiyn,
        cuttingDebtTiyn: debtTiyn - mdfDebtTiyn,
        mdfDebtTiyn,
      },
      paymentsLoading: loading,
    };
  }, [billable, payments, byOrder, loading]);
}
