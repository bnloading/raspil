import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { doc, serverTimestamp, updateDoc } from "firebase/firestore";
import { db } from "../../firebase";
import { useAuth } from "../../AuthContext";
import { Spinner, Toast } from "../../components";
import { AppShell } from "../../components/layout/AppShell";
import { PaymentStatusBadge } from "../../components/StatusBadge";
import { OrderProgress } from "../../components/OrderProgress";
import { WorkshopActivityBoard } from "../../components/WorkshopActivityBoard";
import { getCustomerStageLabel, getCustomerStageTone } from "../../components/CustomerStatusCard";
import { IconLayers, IconOrders, IconPvc } from "../../components/layout/icons";
import { useCustomerOrders } from "../../hooks/useOrders";
import { useToast } from "../../hooks";
import { formatMoney } from "../../lib/money";
import { formatMdfArea } from "../../lib/mdfJournal";
import { customerOrderCode } from "../../lib/orderCode";
import { formatRelativeDateTime } from "../../lib/dates";
import { orderTiles } from "../../lib/orderTiles";
import { isCancellable } from "../../lib/statuses";
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

/**
 * The stage, in the customer's words, with the queue position when there is one.
 *
 * "Распил кезегінде" on its own leaves the obvious question unanswered, and the position is the
 * whole reason a customer opens this page while they are waiting.
 */
function stageLine(order: Order): string {
  const label = getCustomerStageLabel(order.productionStatus, order.pvcMetersTotal > 0, order.mdfStage);
  const queued = order.productionStatus === "cutting_queue" || order.productionStatus === "pvc_queue";
  return queued ? `${label} · №${(order.priority ?? 0) + 1}` : label;
}

/** Which half of the page is showing: this customer's own orders, or the shop's live board. */
type Tab = "mine" | "shop";

export default function CustomerOrders() {
  const { user, userData } = useAuth();
  const navigate = useNavigate();
  const { orders, loading } = useCustomerOrders(user?.uid);
  const { message, visible, showToast } = useToast();
  const [search, setSearch] = useState("");
  const [bucket, setBucket] = useState<Bucket>("all");
  const [tab, setTab] = useState<Tab>("mine");

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
      {/* Two halves of the same question — "where is mine" and "what is the shop doing" — kept
          apart so neither is scrolled past to reach the other. */}
      <div className="customer-tabs" role="tablist">
        <button role="tab" aria-selected={tab === "mine"}
          className={`customer-tab${tab === "mine" ? " is-active" : ""}`}
          onClick={() => setTab("mine")}>
          Менің заказдарым
        </button>
        <button role="tab" aria-selected={tab === "shop"}
          className={`customer-tab${tab === "shop" ? " is-active" : ""}`}
          onClick={() => setTab("shop")}>
          Цех барысы
        </button>
      </div>

      {tab === "shop" ? (
        <WorkshopActivityBoard myOrders={orders} />
      ) : (
      <>
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

      {/* Exactly four fixed buckets — always shown in full, never a scrolling row (unlike the
          open-ended per-status filter on the staff order lists). */}
      <div className="status-filter-row is-compact">
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
            {filtered.map((o) => {
              const tiles = orderTiles(o);
              return (
              <div key={o.id} className="ocard is-static corder-card">
                {/* The whole summary is one link; the action buttons live outside it, since a
                    button nested inside an anchor is neither valid nor reliably clickable. */}
                <Link to={`/order/${o.id}`} className="ocard-link">
                  <div className="corder-head">
                    <span className="otable-num">
                      {customerOrderCode(o.orderNumber)}
                      {o.orderKind === "mdf_wrap" && <span className="jt-pill jt-tone-muted"> МДФ</span>}
                    </span>
                    <span className="corder-name">{o.customerName}</span>
                    <span className={`corder-stage is-${getCustomerStageTone(o.productionStatus)}`}>
                      {stageLine(o)}
                    </span>
                  </div>

                  {o.orderKind === "mdf_wrap" ? (
                    <div className="corder-tiles">
                      <span className="corder-tile">
                        <IconLayers className="corder-tile-icon" />
                        <b>{formatMdfArea(o.mdfAreaM2)}</b>
                        <small>{o.mdfFilmColor || "пленка көрсетілмеген"}</small>
                      </span>
                    </div>
                  ) : (
                    // Sheets, edging and ХДФ as three figures rather than one run-on line: they are
                    // counted separately in the shop, and ХДФ takes no edging at all.
                    <div className="corder-tiles">
                      <span className="corder-tile">
                        <IconOrders className="corder-tile-icon" />
                        <b>{tiles.sheets}</b>
                        <small>лист</small>
                      </span>
                      <span className="corder-tile">
                        <IconPvc className="corder-tile-icon" />
                        <b>{tiles.pvcMeters} м</b>
                        <small>ПВХ</small>
                      </span>
                      <span className="corder-tile">
                        <IconLayers className="corder-tile-icon" />
                        <b>{tiles.hdfSheets}</b>
                        <small>ХДФ</small>
                      </span>
                    </div>
                  )}

                  <OrderProgress order={o} />

                  <div className="corder-foot">
                    {(o.updatedAt ?? o.createdAt) && (
                      <span className="corder-updated">
                        🕐 Жаңартылды: {formatRelativeDateTime((o.updatedAt ?? o.createdAt)!)}
                      </span>
                    )}
                    <span className="corder-money">
                      {formatMoney(o.totalTiyn)}
                      <PaymentStatusBadge status={o.paymentStatus} />
                    </span>
                  </div>
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
              );
            })}
          </div>
        )}
      </div>
      </>
      )}

      <Toast message={message} visible={visible} />
    </AppShell>
  );
}
