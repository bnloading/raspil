import { useMemo } from "react";
import { SimpleOrderList } from "../../components/SimpleOrderList";
import { useAllOrders } from "../../hooks/useOrders";

const STATUSES = new Set(["ready", "delivered"]);

export default function ManagerReady() {
  const { orders, loading } = useAllOrders();
  const list = useMemo(
    () =>
      orders
        .filter((o) => STATUSES.has(o.productionStatus))
        .sort((a, b) => (b.readyAt?.seconds ?? b.createdAt?.seconds ?? 0) - (a.readyAt?.seconds ?? a.createdAt?.seconds ?? 0)),
    [orders],
  );

  return (
    <SimpleOrderList
      title="Дайын заказдар"
      subtitle="Клиентке беруге дайын және берілген заказдар"
      back="/manager"
      orders={list}
      loading={loading}
      detailPath={(o) => `/manager/order/${o.id}`}
      emptyText="Дайын заказ жоқ"
    />
  );
}
