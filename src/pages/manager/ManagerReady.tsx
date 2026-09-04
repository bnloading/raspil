import { useMemo } from "react";
import { useAuth } from "../../AuthContext";
import { SimpleOrderList } from "../../components/SimpleOrderList";
import { useAllOrders } from "../../hooks/useOrders";
import { departmentOf, departmentOfOrder } from "../../lib/rbac";

const STATUSES = new Set(["ready", "delivered"]);

export default function ManagerReady() {
  const { userData } = useAuth();
  const myDepartment = userData ? departmentOf(userData) : "ldsp";
  const { orders, loading } = useAllOrders();
  const list = useMemo(
    () =>
      orders
        .filter((o) => STATUSES.has(o.productionStatus) && departmentOfOrder(o) === myDepartment)
        .sort((a, b) => (b.readyAt?.seconds ?? b.createdAt?.seconds ?? 0) - (a.readyAt?.seconds ?? a.createdAt?.seconds ?? 0)),
    [orders, myDepartment],
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
      emptyHint="ПВХ бітіп, дайын болған заказдар осында жиналады."
    />
  );
}
