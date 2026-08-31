import { useState } from "react";
import { useParams } from "react-router-dom";
import { doc, updateDoc } from "firebase/firestore";
import { db } from "../firebase";
import { useAuth } from "../AuthContext";
import { Spinner, Toast } from "../components";
import { AppShell } from "../components/layout/AppShell";
import { OrderView } from "../components/OrderView";
import { CuttingActionsPanel } from "../components/CuttingActionsPanel";
import { PvcActionsPanel } from "../components/PvcActionsPanel";
import { useOrderDetail } from "../hooks/useOrderDetail";
import { useToast } from "../hooks";
import type { Order } from "../types/domain";

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

      {order.adminNote && <div className="worker-manager-note">📋 Менеджер: {order.adminNote}</div>}

      {(showCuttingActions || showPvcActions) && actor && (
        <section className="panel-card no-print">
          <div className="panel-head">
            <h3>Әрекеттер</h3>
          </div>
          {/* One shared note field — cutting and PVC both read/write the same order.productionNote,
              so whichever stage is live here is exactly where it belongs. */}
          <ProductionNoteField order={order} onToast={showToast} />
          {showCuttingActions && <CuttingActionsPanel order={order} actor={actor} onToast={showToast} />}
          {showPvcActions && <PvcActionsPanel order={order} actor={actor} onToast={showToast} />}
        </section>
      )}

      <Toast message={message} visible={visible} />
    </AppShell>
  );
}

/** A worker's free-text note for the order, shared between cutting and PVC. Used to live on the
 *  dashboard's spotlighted "current order" card; moved here once that card was folded into a
 *  plain list, so a note is still one tap away via "Размерлер" without cluttering every card. */
function ProductionNoteField({ order, onToast }: { order: Order; onToast: (msg: string) => void }) {
  const [note, setNote] = useState(order.productionNote ?? "");

  const saveNote = async () => {
    if (note === (order.productionNote ?? "")) return;
    try {
      await updateDoc(doc(db, "orders", order.id), { productionNote: note });
      onToast("✅ Ескертпе сақталды");
    } catch (err: unknown) {
      onToast("Қате: " + (err as Error).message);
    }
  };

  return (
    <div className="form-group">
      <input
        className="form-input"
        placeholder="Өндіріс ескертпесі..."
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onBlur={saveNote}
      />
    </div>
  );
}
