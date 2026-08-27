import { useMemo } from "react";
import { SimpleOrderList } from "../../components/SimpleOrderList";
import { useAllOrders } from "../../hooks/useOrders";

const STATUSES = new Set(["cutting_queue", "cutting_started"]);

export default function ManagerCuttingQueue() {
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
      title="Распил кезегі"
      subtitle="Кесуге жіберілген және кесіліп жатқан заказдар"
      back="/manager"
      orders={list}
      loading={loading}
      detailPath={(o) => `/manager/order/${o.id}`}
      emptyText="Распил кезегінде заказ жоқ"
    />
  );
}
