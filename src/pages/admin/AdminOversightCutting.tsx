import { useMemo } from "react";
import { SimpleOrderList } from "../../components/SimpleOrderList";
import { useAllOrders } from "../../hooks/useOrders";

const STATUSES = new Set(["cutting_queue", "cutting_started", "cutting_completed"]);

/** Admin oversight into the cutting stage — same underlying orders the Cutter's own dashboard
 *  shows, but from the Admin's all-orders view rather than the worker's own-assignment-shaped UI. */
export default function AdminOversightCutting() {
  const { orders, loading } = useAllOrders();
  const list = useMemo(
    () =>
      orders
        .filter((o) => STATUSES.has(o.productionStatus))
        .sort((a, b) => (a.priority || 0) - (b.priority || 0)),
    [orders],
  );

  return (
    <SimpleOrderList
      title="Распил бақылауы"
      subtitle="Распил кезегінде және кесіліп жатқан заказдар"
      back="/admin"
      orders={list}
      loading={loading}
      detailPath={(o) => `/admin/order/${o.id}`}
      emptyText="Распилде заказ жоқ"
    />
  );
}
