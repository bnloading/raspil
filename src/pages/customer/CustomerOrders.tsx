import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { doc, serverTimestamp, updateDoc } from "firebase/firestore";
import { db } from "../../firebase";
import { useAuth } from "../../AuthContext";
import { Spinner, Toast } from "../../components";
import { AppShell } from "../../components/layout/AppShell";
import { PaymentStatusBadge } from "../../components/StatusBadge";
import { OrderProgress } from "../../components/OrderProgress";
import { useCustomerOrders } from "../../hooks/useOrders";
import { useToast } from "../../hooks";
import { formatMoney } from "../../lib/money";
import { customerOrderCode } from "../../lib/orderCode";
import { formatDateDMY } from "../../lib/dates";
import { isCancellable } from "../../lib/statuses";
import { progressSummary } from "../../lib/orderProgress";
import type { Order } from "../../types/domain";

/**
 * Four plain-language buckets instead of the 16 internal ProductionStatus values. A customer
 * thinks "which of mine are still being made" and "which do I still owe on", not in terms of
 * pvc_queue versus pvc_started.
 */
type Bucket = "all" | "active" | "ready" | "debt";

const BUCKET_LABELS: Record<Bucket, string> = {
  all: "Барлығы",
  active: "Жұмыста",
  ready: "Дайын",
  debt: "Қарыз",
};

function inBucket(order: Order, bucket: Bucket): boolean {
  switch (bucket) {
    case "active":
      // "ready" belongs to Дайын, not Жұмыста — the work on it is finished even though the
      // customer has not collected it yet, so counting it in both would overstate the workload.
      return !["draft", "ready", "delivered", "cancelled"].includes(order.productionStatus);
    case "ready":
      return order.productionStatus === "ready" || order.productionStatus === "delivered";
    case "debt":
      return order.debtTiyn > 0 && order.productionStatus !== "cancelled";
    default:
      return true;
  }
}

/** "6 лист · 89 м ПВХ" — what the order is made of. */
function materialLine(order: Order): string {
  const sheets = order.confirmedSheets ?? order.estimatedSheets ?? 0;
  const bits = [`${sheets} лист`];
  // Metres are summed from per-edge millimetre divisions, so round before showing.
  if (order.pvcMetersTotal > 0) bits.push(`${Number(order.pvcMetersTotal.toFixed(2))} м ПВХ`);
  return bits.join(" · ");
}

export default function CustomerOrders() {
  const { user, userData } = useAuth();
  const navigate = useNavigate();
  const { orders, loading } = useCustomerOrders(user?.uid);
  const { message, visible, showToast } = useToast();
  const [search, setSearch] = useState("");
  const [bucket, setBucket] = useState<Bucket>("all");

  const counts = useMemo(
    () => ({
      all: orders.length,
      active: orders.filter((o) => inBucket(o, "active")).length,
      ready: orders.filter((o) => inBucket(o, "ready")).length,
      debt: orders.filter((o) => inBucket(o, "debt")).length,
    }),
    [orders],
  );

  // The customer's own outstanding balance — never the shop's total.
  const myDebt = useMemo(
    () =>
      orders
        .filter((o) => o.productionStatus !== "cancelled")
        .reduce((s, o) => s + Math.max(0, o.debtTiyn), 0),
    [orders],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return orders.filter((o) => inBucket(o, bucket) && (!q || o.orderNumber.toLowerCase().includes(q)));
  }, [orders, bucket, search]);

  const handleCancel = async (orderId: string) => {
    if (!confirm("Заказды бас тартуды қалайсыз ба?")) return;
    try {
      await updateDoc(doc(db, "orders", orderId), {
        productionStatus: "cancelled",
        cancelledAt: serverTimestamp(),
        cancelReason: "Клиент бас тартты",
      });
      showToast("✅ Заказ бас тартылды");
    } catch (err: unknown) {
      showToast("Қате: " + (err as Error).message);
    }
  };

  if (!user || !userData) return <Spinner />;

  return (
    <AppShell
      title="Заказдарым"
      search={{
        value: search,
        onChange: setSearch,
        placeholder: "Заказ нөмірі бойынша іздеу...",
      }}
      fab={{ to: "/order/new", label: "Жаңа заказ" }}
    >
      <div className="kpi-row">
        <div className="kpi-card">
          <div className="kpi-text">
            <div className="kpi-label">Барлығы</div>
            <div className="kpi-value">{counts.all}</div>
          </div>
          <span className="kpi-icon is-indigo">📋</span>
        </div>
        <div className="kpi-card">
          <div className="kpi-text">
            <div className="kpi-label">Жұмыста</div>
            <div className="kpi-value">{counts.active}</div>
          </div>
          <span className="kpi-icon is-blue">⚙</span>
        </div>
        <div className="kpi-card">
          <div className="kpi-text">
            <div className="kpi-label">Дайын</div>
            <div className="kpi-value">{counts.ready}</div>
          </div>
          <span className="kpi-icon is-green">✓</span>
        </div>
        <div className="kpi-card">
          <div className="kpi-text">
            <div className="kpi-label">Қарыз</div>
            <div className={`kpi-value${myDebt > 0 ? " is-danger" : ""}`}>{formatMoney(myDebt)}</div>
          </div>
          <span className="kpi-icon is-red">💼</span>
        </div>
      </div>

      <div className="status-filter-row" style={{ overflowX: "auto", flexWrap: "nowrap" }}>
        {(Object.keys(BUCKET_LABELS) as Bucket[]).map((b) => (
          <button
            key={b}
            className={`status-filter-btn${bucket === b ? " active" : ""}`}
            onClick={() => setBucket(b)}
          >
            <span>{BUCKET_LABELS[b]}</span>
            <b>{counts[b]}</b>
          </button>
        ))}
      </div>

      <div className="orders-section">
        {loading ? (
          <Spinner />
        ) : filtered.length === 0 ? (
          <div className="empty-state">
            <div className="icon">📭</div>
            <p>Заказ табылмады</p>
            <p className="empty-state-hint">
              {bucket === "all"
                ? "Жаңа заказ беру үшін төмендегі ➕ батырмасын басыңыз."
                : "Бұл сүзгіге сай заказ жоқ — «Барлығы» дегенді таңдап көріңіз."}
            </p>
          </div>
        ) : (
          <div className="ocards">
            {filtered.map((o) => (
              <div key={o.id} className="ocard is-static">
                {/* The whole summary is one link; the action buttons live outside it, since a
                    button nested inside an anchor is neither valid nor reliably clickable. */}
                <Link to={`/order/${o.id}`} className="ocard-link">
                  <div className="ocard-top">
                    <span className="otable-num">{customerOrderCode(o.orderNumber)}</span>
                    <span className="otable-sub">{o.createdAt ? formatDateDMY(o.createdAt) : "—"}</span>
                  </div>
                  <div className="ocard-mid">
                    <span className="otable-strong">{materialLine(o)}</span>
                    <span className="otable-money">{formatMoney(o.totalTiyn)}</span>
                  </div>
                  <div className="ocard-meta">
                    <span className="otable-sub">{progressSummary(o)}</span>
                    <PaymentStatusBadge status={o.paymentStatus} />
                  </div>
                  <OrderProgress order={o} />
                  <span className="ocard-chev" aria-hidden="true">›</span>
                </Link>

                {(isCancellable(o.productionStatus) || o.productionStatus === "draft") && (
                  <div className="track-card-actions">
                    <button
                      type="button"
                      className="btn btn-outline btn-sm"
                      onClick={() => navigate(`/order/new?duplicate=${o.id}`)}
                    >
                      ⧉ Қайталау
                    </button>
                    {o.productionStatus === "draft" && (
                      <button
                        type="button"
                        className="btn btn-outline btn-sm"
                        onClick={() => navigate(`/order/new?edit=${o.id}`)}
                      >
                        ✎ Жалғастыру
                      </button>
                    )}
                    {isCancellable(o.productionStatus) && (
                      <button
                        type="button"
                        className="btn btn-danger-outline btn-sm"
                        onClick={() => handleCancel(o.id)}
                      >
                        ✕ Бас тарту
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <Toast message={message} visible={visible} />
    </AppShell>
  );
}
