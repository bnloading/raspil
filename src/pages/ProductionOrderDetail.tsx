import { useParams } from "react-router-dom";
import { useAuth } from "../AuthContext";
import { Spinner, Toast } from "../components";
import { AppShell } from "../components/layout/AppShell";
import { OrderView } from "../components/OrderView";
import { CuttingActionsPanel } from "../components/CuttingActionsPanel";
import { PvcActionsPanel } from "../components/PvcActionsPanel";
import { useOrderDetail } from "../hooks/useOrderDetail";
import { useToast } from "../hooks";
import { EDGE_KEYS } from "../types/domain";

/** Shared "full cutting/PVC specification" view for cutter and PVC roles — no prices, no
 *  payments (spec: cutters/PVC workers cannot see/edit prices or payments). Also exposes the
 *  same start/complete actions as the dashboard cards (CuttingActionsPanel/PvcActionsPanel) so a
 *  worker can act from here, not just from the list. */
export default function ProductionOrderDetail() {
  const { id } = useParams<{ id: string }>();
  const { user, userData } = useAuth();
  const { order, parts, statusHistory, payments, loading } = useOrderDetail(id);
  const { message, visible, showToast } = useToast();

  // Shared route (mounted under both /cutting/order/:id and /pvc/order/:id) — pick the
  // role-appropriate list to go back to rather than relying on the current pathname.
  const backPath = userData?.role === "pvh" ? "/pvc" : "/cutting";

  if (loading || !userData) return <Spinner />;
  if (!order) {
    return (
      <AppShell title="Заказ табылмады" back={backPath} contentWidth="narrow">
        <div className="empty-state">
          <div className="icon">😔</div>
          <p>Заказ табылмады</p>
        </div>
      </AppShell>
    );
  }

  const needsPvc = parts.some((p) => EDGE_KEYS.some((e) => p.edges[e]?.pvc));
  const actor = user ? { user, userData } : null;
  const showCuttingActions =
    actor && userData.role === "raspil" && (order.productionStatus === "cutting_queue" || order.productionStatus === "cutting_started");
  const showPvcActions =
    actor && userData.role === "pvh" && (order.productionStatus === "pvc_queue" || order.productionStatus === "pvc_started");

  return (
    <AppShell title={`Заказ №${order.orderNumber}`} back={backPath} contentWidth="narrow">
      <OrderView
        order={order}
        parts={parts}
        statusHistory={statusHistory}
        payments={payments}
        showFinancials={false}
      />

      {(showCuttingActions || showPvcActions) && actor && (
        <section className="panel-card no-print">
          <div className="panel-head">
            <h3>Әрекеттер</h3>
          </div>
          {showCuttingActions && <CuttingActionsPanel order={order} actor={actor} needsPvc={needsPvc} onToast={showToast} />}
          {showPvcActions && <PvcActionsPanel order={order} actor={actor} onToast={showToast} />}
        </section>
      )}

      <Toast message={message} visible={visible} />
    </AppShell>
  );
}
