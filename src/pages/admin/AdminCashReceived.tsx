import { useEffect, useMemo, useState } from "react";
import { collection, getDocs } from "firebase/firestore";
import { db } from "../../firebase";
import { useAuth } from "../../AuthContext";
import { Spinner } from "../../components";
import { AppShell } from "../../components/layout/AppShell";
import { CashReceivedCard } from "../../components/CashReceivedCard";
import { useAllOrders } from "../../hooks/useOrders";
import { useAllPayments } from "../../hooks/usePayments";
import { DEPARTMENT_LABELS, departmentOf, departmentOfOrder } from "../../lib/rbac";
import type { PaymentMethodDef } from "../../types/domain";

/**
 * «Нал ақша алдым» as a page of its own, on the Admin's phone bar (the owner, 07.11: «mobile view-ден
 * шықпай тұр, navbar-ға қос»). It used to sit at the foot of the phone home, under the money, and
 * only below 768px — so a wider phone, or one turned sideways, never showed it at all.
 *
 * The line is the one the Admin is viewing: ЛДСП cash is checked against the ЛДСП journal, МДФ
 * against МДФ's, and neither sees the other's entries (lib/rbac.ts departmentOfOrder).
 */
export default function AdminCashReceived() {
  const { userData } = useAuth();
  const department = userData ? departmentOf(userData) : "ldsp";
  const { orders: allOrders, loading: ordersLoading } = useAllOrders();
  const { payments: allPayments, loading: paymentsLoading } = useAllPayments();
  const [methods, setMethods] = useState<PaymentMethodDef[] | null>(null);
  useEffect(() => {
    getDocs(collection(db, "paymentMethods"))
      .then((snap) => setMethods(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<PaymentMethodDef, "id">) }))))
      .catch(() => setMethods([]));
  }, []);

  const orders = useMemo(() => allOrders.filter((o) => departmentOfOrder(o) === department), [allOrders, department]);
  const payments = useMemo(() => {
    const ids = new Set(orders.map((o) => o.id));
    return allPayments.filter((p) => ids.has(p.orderId));
  }, [allPayments, orders]);

  const loading = ordersLoading || paymentsLoading || methods === null;

  return (
    <AppShell title="Нал ақша алдым" subtitle={`${DEPARTMENT_LABELS[department]} — журналмен салыстыру`}>
      {loading ? (
        <Spinner />
      ) : (
        <div className="aps">
          <CashReceivedCard orders={orders} payments={payments} methods={methods ?? []} department={department} />
        </div>
      )}
    </AppShell>
  );
}
