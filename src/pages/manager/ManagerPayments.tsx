import { useMemo } from "react";
import { useAuth } from "../../AuthContext";
import { SimpleOrderList } from "../../components/SimpleOrderList";
import { useAllOrders } from "../../hooks/useOrders";
import { departmentOf, departmentOfOrder } from "../../lib/rbac";

/**
 * Filtered on `paymentStatus`, not `productionStatus`.
 *
 * The two are independent by design (see the Order type): production advances to cut / ready /
 * delivered while payment stays unpaid. Keying this list off the payment-shaped *production*
 * stages therefore hid every order that owed money but had already moved on — which was most of
 * the debt in the shop. Drafts and cancellations are excluded because neither owes anything.
 */
const OWES = new Set(["unpaid", "partial"]);
const NOT_BILLABLE = new Set(["draft", "cancelled"]);

/** Manager's payments inbox — orders that still need a payment recorded against them. Full payment
 *  history/reversal lives on the order detail page and in AdminReports; this is deliberately a thin
 *  triage list, not a duplicate of the reports payments tab. */
export default function ManagerPayments() {
  const { userData } = useAuth();
  const myDepartment = userData ? departmentOf(userData) : "ldsp";
  const { orders, loading } = useAllOrders();
  const list = useMemo(
    () =>
      orders
        .filter(
          (o) =>
            OWES.has(o.paymentStatus) &&
            !NOT_BILLABLE.has(o.productionStatus) &&
            departmentOfOrder(o) === myDepartment,
        )
        .sort((a, b) => b.debtTiyn - a.debtTiyn),
    [orders, myDepartment],
  );

  return (
    <SimpleOrderList
      title="Төлемдер"
      subtitle="Төлем күтіп тұрған заказдар"
      back="/manager"
      orders={list}
      loading={loading}
      detailPath={(o) => `/manager/order/${o.id}`}
      emptyText="Төлем күтетін заказ жоқ"
      emptyHint="Толық төленбеген заказдар осында тізіледі."
    />
  );
}
