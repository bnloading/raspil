import { useMemo } from "react";
import { SimpleOrderList } from "../../components/SimpleOrderList";
import { useAllOrders } from "../../hooks/useOrders";

// Everything the Manager role is responsible for, up to (but not including) the cutting queue.
const STATUSES = new Set([
  "submitted",
  "manager_review",
  "price_calculated",
  "waiting_payment",
  "partially_paid",
  "paid",
]);

/** Admin oversight into what Manager(s) are currently processing — read-mostly; drilling into a
 *  row lands on the full Admin order detail page, which has every action a Manager page has. */
export default function AdminOversightManager() {
  const { orders, loading } = useAllOrders();
  const list = useMemo(
    () =>
      orders
        .filter((o) => STATUSES.has(o.productionStatus))
        .sort((a, b) => (b.createdAt?.seconds ?? 0) - (a.createdAt?.seconds ?? 0)),
    [orders],
  );

  return (
    <SimpleOrderList
      title="Менеджер бақылауы"
      subtitle="Менеджерлер қазір қарап жатқан заказдар (қабылдаудан төлемге дейін)"
      back="/admin"
      orders={list}
      loading={loading}
      detailPath={(o) => `/admin/order/${o.id}`}
      emptyText="Менеджер жұмысындағы заказ жоқ"
    />
  );
}
