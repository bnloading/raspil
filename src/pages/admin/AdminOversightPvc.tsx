import { useMemo } from "react";
import { SimpleOrderList } from "../../components/SimpleOrderList";
import { useAllOrders } from "../../hooks/useOrders";

const STATUSES = new Set(["pvc_queue", "pvc_started", "pvc_completed"]);

/** Admin oversight into the PVC stage — mirrors AdminOversightCutting.tsx for the PVC pipeline. */
export default function AdminOversightPvc() {
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
      title="ПВХ бақылауы"
      subtitle="ПВХ кезегінде және жабыстырылып жатқан заказдар"
      back="/admin"
      orders={list}
      loading={loading}
      detailPath={(o) => `/admin/order/${o.id}`}
      emptyText="ПВХ-та заказ жоқ"
      emptyHint="ПВХ шеберлері жұмыс істеп жатқан заказдар осында көрінеді."
    />
  );
}
