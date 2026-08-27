import { useMemo } from "react";
import { SimpleOrderList } from "../../components/SimpleOrderList";
import { useAllOrders } from "../../hooks/useOrders";

const STATUSES = new Set(["waiting_payment", "partially_paid"]);

/** Manager's payments inbox — orders that still need a payment recorded against them. Full payment
 *  history/reversal lives on the order detail page and in AdminReports; this is deliberately a thin
 *  triage list, not a duplicate of the reports payments tab. */
export default function ManagerPayments() {
  const { orders, loading } = useAllOrders();
  const list = useMemo(
    () => orders.filter((o) => STATUSES.has(o.productionStatus)).sort((a, b) => b.debtTiyn - a.debtTiyn),
    [orders],
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
    />
  );
}
