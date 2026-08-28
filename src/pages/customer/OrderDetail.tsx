import { useNavigate, useParams } from "react-router-dom";
import { doc, serverTimestamp, updateDoc } from "firebase/firestore";
import { db } from "../../firebase";
import { useAuth } from "../../AuthContext";
import { Spinner, Toast } from "../../components";
import { AppShell } from "../../components/layout/AppShell";
import { OrderView } from "../../components/OrderView";
import { CustomerStatusCard } from "../../components/CustomerStatusCard";
import { WorkshopActivityBoard } from "../../components/WorkshopActivityBoard";
import { useOrderDetail } from "../../hooks/useOrderDetail";
import { useToast } from "../../hooks";
import { isCancellable } from "../../lib/statuses";

export default function OrderDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { order, parts, statusHistory, payments, loading } = useOrderDetail(id);
  const { message, visible, showToast } = useToast();

  if (loading) return <Spinner />;
  if (!order || !user || order.customerId !== user.uid) {
    return (
      <AppShell title="Заказ табылмады" back="/orders">
        <div className="empty-state">
          <div className="icon">😔</div>
          <p>Заказ табылмады</p>
        </div>
      </AppShell>
    );
  }

  const handleCancel = async () => {
    if (!confirm("Заказды бас тартуды қалайсыз ба?")) return;
    try {
      await updateDoc(doc(db, "orders", order.id), {
        productionStatus: "cancelled",
        cancelledAt: serverTimestamp(),
        cancelReason: "Клиент бас тартты",
      });
      showToast("✅ Заказ бас тартылды");
    } catch (err: unknown) {
      showToast("Қате: " + (err as Error).message);
    }
  };

  return (
    <AppShell title={`Заказ №${order.orderNumber}`} back="/orders" contentWidth="wide">
      <div className="detail-layout">
        <div>
          <CustomerStatusCard order={order} />
          <div style={{ marginTop: 20 }}>
            {/* Highlights this order's own row on the shared board. */}
            <WorkshopActivityBoard myOrders={[order]} />
          </div>
          <div style={{ marginTop: 20 }}>
            <OrderView
              order={order}
              parts={parts}
              statusHistory={statusHistory}
              payments={payments}
              showQueueInfo={false}
            />
          </div>
        </div>

        <div className="detail-side no-print">
          <div className="panel-card">
            <button className="btn btn-outline btn-full" onClick={() => navigate(`/invoice/${order.id}`)}>
              🧾 Накладной
            </button>
          </div>
          <div className="panel-card">
            <button className="btn btn-outline btn-full" onClick={() => window.print()}>
              🖨 Басып шығару
            </button>
          </div>
          <div className="panel-card">
            <button
              className="btn btn-outline btn-full"
              onClick={() => navigate(`/order/new?duplicate=${order.id}`)}
            >
              ⧉ Қайталау
            </button>
          </div>
          {order.productionStatus === "draft" && (
            <div className="panel-card">
              <button className="btn btn-outline btn-full" onClick={() => navigate(`/order/new?edit=${order.id}`)}>
                ✎ Жалғастыру
              </button>
            </div>
          )}
          {isCancellable(order.productionStatus) && (
            <div className="panel-card">
              <button className="btn btn-danger-outline btn-full" onClick={handleCancel}>
                ✕ Бас тарту
              </button>
            </div>
          )}
        </div>
      </div>

      <Toast message={message} visible={visible} />
    </AppShell>
  );
}
