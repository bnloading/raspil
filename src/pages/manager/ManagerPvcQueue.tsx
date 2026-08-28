import { useMemo } from "react";
import { SimpleOrderList } from "../../components/SimpleOrderList";
import { useAllOrders } from "../../hooks/useOrders";

const STATUSES = new Set(["pvc_queue", "pvc_started"]);

export default function ManagerPvcQueue() {
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
      title="ПВХ кезегі"
      subtitle="ПВХ кезегіндегі және жасалып жатқан заказдар"
      back="/manager"
      orders={list}
      loading={loading}
      detailPath={(o) => `/manager/order/${o.id}`}
      emptyText="ПВХ кезегінде заказ жоқ"
      emptyHint="Распил аяқталған, ПВХ керек заказдар осында көрінеді."
    />
  );
}
