import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { doc, serverTimestamp, updateDoc } from "firebase/firestore";
import { db } from "../../firebase";
import { useAuth } from "../../AuthContext";
import { Spinner, Toast } from "../../components";
import { AppShell } from "../../components/layout/AppShell";
import { ProductionStatusBadge, PaymentStatusBadge } from "../../components/StatusBadge";
import { useCustomerOrders } from "../../hooks/useOrders";
import { useToast } from "../../hooks";
import { formatMoney } from "../../lib/money";
import { formatDateDMY } from "../../lib/dates";
import { isCancellable, PRODUCTION_STATUS_LABELS, PRODUCTION_STATUS_ORDER } from "../../lib/statuses";
import type { ProductionStatus } from "../../types/domain";

export default function CustomerOrders() {
  const { user, userData } = useAuth();
  const navigate = useNavigate();
  const { orders, loading } = useCustomerOrders(user?.uid);
  const { message, visible, showToast } = useToast();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | ProductionStatus>("all");

  const filtered = useMemo(() => {
    let list = orders;
    if (statusFilter !== "all") list = list.filter((o) => o.productionStatus === statusFilter);
    const q = search.trim().toLowerCase();
    if (q) list = list.filter((o) => o.orderNumber.toLowerCase().includes(q));
    return list;
  }, [orders, statusFilter, search]);

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
      <div className="status-filter-row" style={{ overflowX: "auto", flexWrap: "nowrap" }}>
        <button
          className={`status-filter-btn${statusFilter === "all" ? " active" : ""}`}
          onClick={() => setStatusFilter("all")}
        >
          <span>Барлығы</span>
          <b>{orders.length}</b>
        </button>
        {PRODUCTION_STATUS_ORDER.map((s) => {
          const count = orders.filter((o) => o.productionStatus === s).length;
          if (count === 0) return null;
          return (
            <button
              key={s}
              className={`status-filter-btn${statusFilter === s ? " active" : ""}`}
              onClick={() => setStatusFilter(s)}
            >
              <span>{PRODUCTION_STATUS_LABELS[s]}</span>
              <b>{count}</b>
            </button>
          );
        })}
      </div>

      <div className="orders-section">
        {loading ? (
          <Spinner />
        ) : filtered.length === 0 ? (
          <div className="empty-state">
            <div className="icon">📭</div>
            <p>Заказ табылмады</p>
          </div>
        ) : (
          filtered.map((o) => (
            <div key={o.id} className="track-card">
              <Link to={`/order/${o.id}`} style={{ textDecoration: "none", color: "inherit" }}>
                <div className="track-card-header">
                  <span className="track-card-num">{o.orderNumber}</span>
                  <ProductionStatusBadge status={o.productionStatus} />
                </div>
                <div className="track-card-meta-row">
                  <span>{formatMoney(o.totalTiyn)}</span>
                  <PaymentStatusBadge status={o.paymentStatus} />
                  {o.createdAt && <span>{formatDateDMY(o.createdAt)}</span>}
                </div>
              </Link>
              <div className="track-card-actions">
                <button
                  type="button"
                  className="btn btn-outline btn-sm"
                  onClick={() => navigate(`/order/new?duplicate=${o.id}`)}
                >
                  ⧉ Қайталау
                </button>
                {isCancellable(o.productionStatus) && (
                  <button type="button" className="btn btn-danger-outline btn-sm" onClick={() => handleCancel(o.id)}>
                    ✕ Бас тарту
                  </button>
                )}
                {o.productionStatus === "draft" && (
                  <button
                    type="button"
                    className="btn btn-outline btn-sm"
                    onClick={() => navigate(`/order/new?edit=${o.id}`)}
                  >
                    ✎ Жалғастыру
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      <Toast message={message} visible={visible} />
    </AppShell>
  );
}
