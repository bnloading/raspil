import { Link, useParams } from "react-router-dom";
import { useAuth } from "../../AuthContext";
import { Spinner, Toast } from "../../components";
import { AppShell } from "../../components/layout/AppShell";
import { OrderView } from "../../components/OrderView";
import { OrderActionPanels } from "../../components/OrderActionPanels";
import { CuttingExportPanel } from "../../components/CuttingExportPanel";
import { useOrderDetail } from "../../hooks/useOrderDetail";
import { useAllOrders } from "../../hooks/useOrders";
import { useToast } from "../../hooks";

export default function ManagerOrderDetail() {
  const { id } = useParams<{ id: string }>();
  const auth = useAuth();
  const { order, parts, statusHistory, payments, loading } = useOrderDetail(id);
  const { orders: allOrders } = useAllOrders();
  const { message, visible, showToast } = useToast();

  if (loading) return <Spinner />;
  if (!order || !auth.user || !auth.userData) {
    return (
      <AppShell title="Заказ табылмады" back="/manager/orders">
        <div className="empty-state">
          <div className="icon">😔</div>
          <p>Заказ табылмады</p>
        </div>
      </AppShell>
    );
  }

  const actor = { user: auth.user, userData: auth.userData };
  const isAdmin = auth.userData.role === "admin";

  return (
    <AppShell title={`Заказ №${order.orderNumber}`} back="/manager/orders" contentWidth="wide">
      <div className="detail-layout">
        <div>
          <OrderView
            order={order}
            parts={parts}
            statusHistory={statusHistory}
            payments={payments}
            actions={
              <>
                <Link className="btn btn-outline btn-sm" to={`/invoice/${order.id}`}>
                  🧾 Накладной
                </Link>
                <button className="btn btn-outline btn-sm" onClick={() => window.print()}>
                  🖨 Басып шығару
                </button>
              </>
            }
          />
        </div>

        <div className="detail-side no-print">
          <CuttingExportPanel order={order} parts={parts} onToast={showToast} />
          <OrderActionPanels
            order={order}
            parts={parts}
            payments={payments}
            actor={actor}
            isAdmin={isAdmin}
            // Owner's call: a Manager may send an unpaid order to cutting on credit too, same as
            // Admin — every override still needs a typed reason and lands in the audit log.
            canOverrideCuttingGate
            allOrders={allOrders}
            showToast={showToast}
          />
        </div>
      </div>

      <Toast message={message} visible={visible} />
    </AppShell>
  );
}
