import { useEffect, useMemo, useState } from "react";
import { collection, getDocs } from "firebase/firestore";
import { db } from "../firebase";
import { useAllPayments } from "./useReports";
import { useExpenses } from "./useExpenses";
import { useAppSettings } from "./useAppSettings";
import { computeCashbox } from "../lib/cashbox";
import type { CashboxSummary } from "../lib/cashbox";
import { dayKey } from "../lib/dates";
import { departmentOfOrder } from "../lib/rbac";
import type { CashAccount, Department, Order, PaymentMethodDef } from "../types/domain";

/**
 * One line's Касса, for pages that show a balance without being the Касса page: what is in each
 * account now (all time, opening balance included, from the accounting restart), and the current
 * month's own flow beside it. The same computeCashbox the Касса page runs, on the same inputs.
 *
 * Takes the orders rather than listening to them again — every caller already has them loaded,
 * and they are only needed to tell which line each payment belongs to.
 */
export function useDepartmentCashbox({ orders, department }: { orders: Order[]; department: Department }): {
  now: CashboxSummary;
  thisMonth: CashboxSummary;
  monthKey: string;
  openingBalanceTiyn: Partial<Record<CashAccount, number>>;
  startDate: string | null;
  loading: boolean;
} {
  const { payments: allPayments, loading: paymentsLoading } = useAllPayments();
  const { expenses: allExpenses, loading: expensesLoading } = useExpenses();
  const { settings, loading: settingsLoading } = useAppSettings();
  // Which account a payment lands in is read off its method, so the balances wait for the methods
  // rather than show a first guess that then changes under the reader.
  const [methods, setMethods] = useState<PaymentMethodDef[] | null>(null);
  useEffect(() => {
    getDocs(collection(db, "paymentMethods"))
      .then((snap) => setMethods(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<PaymentMethodDef, "id">) }))))
      .catch(() => setMethods([]));
  }, []);

  const orderDeptById = useMemo(() => new Map(orders.map((o) => [o.id, departmentOfOrder(o)])), [orders]);
  const payments = useMemo(
    () => allPayments.filter((p) => (orderDeptById.get(p.orderId) ?? "ldsp") === department),
    [allPayments, orderDeptById, department],
  );
  const expenses = useMemo(
    () => allExpenses.filter((e) => (e.department ?? "ldsp") === department),
    [allExpenses, department],
  );
  const openingBalanceTiyn = useMemo(
    () => settings.cashOpeningBalanceTiyn?.[department] ?? {},
    [settings.cashOpeningBalanceTiyn, department],
  );
  const startDate = settings.cashStartDate ?? null;
  const monthKey = dayKey(new Date()).slice(0, 7);

  const now = useMemo(
    () => computeCashbox({ payments, expenses, methods: methods ?? [], period: null, openingBalanceTiyn, startDate }),
    [payments, expenses, methods, openingBalanceTiyn, startDate],
  );
  const thisMonth = useMemo(
    () => computeCashbox({ payments, expenses, methods: methods ?? [], period: monthKey, openingBalanceTiyn, startDate }),
    [payments, expenses, methods, monthKey, openingBalanceTiyn, startDate],
  );

  return {
    now,
    thisMonth,
    monthKey,
    openingBalanceTiyn,
    startDate,
    loading: paymentsLoading || expensesLoading || settingsLoading || methods === null,
  };
}
