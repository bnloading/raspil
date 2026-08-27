import { useNavigate } from "react-router-dom";
import { Spinner } from "../components";
import { AppShell } from "./layout/AppShell";
import { ProductionStatusBadge, PaymentStatusBadge } from "./StatusBadge";
import { formatMoney } from "../lib/money";
import { formatDateDMY } from "../lib/dates";
import type { Order } from "../types/domain";

/**
 * Thin, reusable read-mostly order list — backs the Manager's queue/ready pages and the Admin's
 * oversight pages. Deliberately not as featured as AdminOrders/ManagerOrders (no search, sort,
 * pagination or reorder) — those pages are the ones the spec asks to be full-featured.
 */
export function SimpleOrderList({
  title,
  subtitle,
  back,
  orders,
  loading,
  detailPath,
  emptyText = "Заказдар жоқ",
}: {
  title: string;
  subtitle?: string;
  back?: string;
  orders: Order[];
  loading: boolean;
  detailPath: (order: Order) => string;
  emptyText?: string;
}) {
  const navigate = useNavigate();

  return (
    <AppShell title={title} subtitle={subtitle} back={back}>
      {loading ? (
        <Spinner />
      ) : orders.length === 0 ? (
        <div className="empty-state">
          <div className="icon">📭</div>
          <p>{emptyText}</p>
        </div>
      ) : (
        <div className="data-table-wrap">
          <table className="data-table stack-mobile">
            <thead>
              <tr>
                <th>№</th>
                <th>Клиент</th>
                <th className="num">Сома</th>
                <th>Өндіріс</th>
                <th>Төлем</th>
                <th>Күні</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id} className="clickable" onClick={() => navigate(detailPath(o))}>
                  <td data-label="№">{o.orderNumber}</td>
                  <td data-label="Клиент">{o.customerName}</td>
                  <td className="num" data-label="Сома">
                    {formatMoney(o.totalTiyn)}
                  </td>
                  <td data-label="Өндіріс">
                    <ProductionStatusBadge status={o.productionStatus} />
                  </td>
                  <td data-label="Төлем">
                    <PaymentStatusBadge status={o.paymentStatus} />
                  </td>
                  <td data-label="Күні">{o.createdAt ? formatDateDMY(o.createdAt) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AppShell>
  );
}
