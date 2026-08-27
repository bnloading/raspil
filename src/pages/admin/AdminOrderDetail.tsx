import { useParams } from "react-router-dom";
import { db } from "../../firebase";
import { useAuth } from "../../AuthContext";
import { Spinner, Toast } from "../../components";
import { AppShell } from "../../components/layout/AppShell";
import { OrderView } from "../../components/OrderView";
import { OrderActionPanels } from "../../components/OrderActionPanels";
import { useOrderDetail } from "../../hooks/useOrderDetail";
import { useAllOrders } from "../../hooks/useOrders";
import { useToast } from "../../hooks";
import { overrideStatus } from "../../lib/orderStatus";
import { PRODUCTION_STATUS_LABELS, PRODUCTION_STATUS_ORDER } from "../../lib/statuses";
import type { ProductionStatus } from "../../types/domain";

export default function AdminOrderDetail() {
  const { id } = useParams<{ id: string }>();
  const auth = useAuth();
  const { order, parts, statusHistory, payments, loading } = useOrderDetail(id);
  const { orders: allOrders } = useAllOrders();
  const { message, visible, showToast } = useToast();

  if (loading) return <Spinner />;
  if (!order || !auth.user || !auth.userData) {
    return (
      <AppShell title="Заказ табылмады" back="/admin/orders">
        <div className="empty-state">
          <div className="icon">😔</div>
          <p>Заказ табылмады</p>
        </div>
      </AppShell>
    );
  }

  const actor = { user: auth.user, userData: auth.userData };

  const handleStatusOverride = async (newStatus: ProductionStatus) => {
    if (newStatus === order.productionStatus) return;
    const comment = prompt("Түсініктеме (міндетті емес, бірақ түзету себебін жазу ұсынылады):") ?? undefined;
    try {
      await overrideStatus(db, actor, order, newStatus, comment);
      showToast("✅ Мәртебе өзгертілді");
    } catch (err: unknown) {
      showToast("Қате: " + (err as Error).message);
    }
  };

  return (
    <AppShell title={`Заказ №${order.orderNumber}`} back="/admin/orders" contentWidth="wide">
      <div className="detail-layout">
        <div>
          <OrderView
            order={order}
            parts={parts}
            statusHistory={statusHistory}
            payments={payments}
            actions={
              <button className="btn btn-outline btn-sm" onClick={() => window.print()}>
                🖨 Басып шығару
              </button>
            }
          />
        </div>

        <div className="detail-side no-print">
          <OrderActionPanels
            order={order}
            parts={parts}
            payments={payments}
            actor={actor}
            isAdmin
            allOrders={allOrders}
            showToast={showToast}
          />

          <section className="panel-card">
            <div className="panel-head">
              <h3>Мәртебені қолмен өзгерту (түзету)</h3>
            </div>
            <div className="form-group">
              <select
                className="form-input"
                value={order.productionStatus}
                onChange={(e) => handleStatusOverride(e.target.value as ProductionStatus)}
              >
                {PRODUCTION_STATUS_ORDER.map((s) => (
                  <option key={s} value={s}>
                    {PRODUCTION_STATUS_LABELS[s]}
                  </option>
                ))}
              </select>
            </div>
          </section>
        </div>
      </div>

      <Toast message={message} visible={visible} />
    </AppShell>
  );
}
