import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { doc, serverTimestamp, updateDoc } from "firebase/firestore";
import { db } from "../../firebase";
import { useAuth } from "../../AuthContext";
import { Spinner, Toast } from "../../components";
import { AppShell } from "../../components/layout/AppShell";
import { PaymentStatusBadge } from "../../components/StatusBadge";
import { CustomerProductionProgress } from "../../components/CustomerProductionProgress";
import { WorkshopActivityBoard } from "../../components/WorkshopActivityBoard";
import { getCustomerStageLabel, getCustomerStageTone } from "../../components/CustomerStatusCard";
import { IconLayers, IconOrders, IconPvc } from "../../components/layout/icons";
import { useCustomerOrders } from "../../hooks/useOrders";
import { useToast } from "../../hooks";
import { formatMoney } from "../../lib/money";
import { formatMdfArea } from "../../lib/mdfJournal";
import { customerOrderCode } from "../../lib/orderCode";
import { dayKey, formatDateDMY, formatDayMonth } from "../../lib/dates";
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

/**
 * "Бүгін / Кеше / Күн таңдау" — a customer who orders often wants to jump straight to what they
 * placed today or yesterday, rather than scrolling past it to reach the older ones the status
 * buckets alone can leave up top (a paid, finished order from last month still outranks today's
 * brand-new one there). "Барлығы" is the one option not in the owner's mockup — dropping it would
 * have meant a customer could never see their full order list at once, so it stays as the default.
 * Independent of Bucket: the two combine, e.g. "Бүгін" + "Қарыз" together.
 */
type DatePeriod = "all" | "today" | "yesterday" | "custom";

const DATE_PERIOD_LABELS: Record<DatePeriod, string> = {
  all: "Барлығы",
  today: "Бүгін",
  yesterday: "Кеше",
  custom: "📅 Күн таңдау",
};

function inDatePeriod(
  order: Order,
  datePeriod: DatePeriod,
  todayKey: string,
  yesterdayKey: string,
  customDate: string,
): boolean {
  if (datePeriod === "all") return true;
  if (!order.createdAt) return false;
  const day = dayKey(order.createdAt);
  if (datePeriod === "today") return day === todayKey;
  if (datePeriod === "yesterday") return day === yesterdayKey;
  return !!customDate && day === customDate;
}

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
  const [datePeriod, setDatePeriod] = useState<DatePeriod>("all");
  const [customDate, setCustomDate] = useState("");
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 10;
  const [tab, setTab] = useState<Tab>("mine");

  // Computed once per render rather than per order — dayKey() does real Intl formatting work.
  const todayKey = dayKey(Date.now());
  const yesterdayKey = dayKey(Date.now() - 86_400_000);

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
    return orders.filter((o) =>
      inBucket(o, bucket) &&
      inDatePeriod(o, datePeriod, todayKey, yesterdayKey, customDate) &&
      (!q || o.orderNumber.toLowerCase().includes(q)));
  }, [orders, bucket, datePeriod, todayKey, yesterdayKey, customDate, search]);

  // Any filter change can strand the reader on a page number that no longer has that many pages —
  // back to the first page whenever what's being shown changes under them.
  useEffect(() => setPage(1), [bucket, datePeriod, customDate, search]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageSafe = Math.min(page, pageCount);
  const paged = filtered.slice((pageSafe - 1) * PAGE_SIZE, pageSafe * PAGE_SIZE);

  /**
   * "24.09.2026 · 8 заказ" above the list — only means something once the list is scoped to one
   * actual day (Бүгін/Кеше/a picked date); across "Барлығы" the orders span many days at once, so
   * no single date belongs at the top of it.
   */
  const dayHeading =
    datePeriod === "today" ? todayKey
    : datePeriod === "yesterday" ? yesterdayKey
    : datePeriod === "custom" && customDate ? customDate
    : null;

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

      {/* A customer who orders often has today's brand-new order buried under last month's — this
          scopes the list to "when" before (or together with) the status buckets below scope it to
          "what state". Plain pills, no counts — the KPI row above already has the numbers, and
          repeating them here on every pill was clutter the owner's mockup doesn't carry either. */}
      <div className="status-filter-row is-compact">
        {(Object.keys(DATE_PERIOD_LABELS) as DatePeriod[]).map((p) => (
          <button
            key={p}
            className={`status-filter-btn${datePeriod === p ? " active" : ""}`}
            onClick={() => {
              setDatePeriod(p);
              if (p === "custom" && !customDate) setCustomDate(todayKey);
            }}
          >
            <span>{DATE_PERIOD_LABELS[p]}</span>
          </button>
        ))}
        {datePeriod === "custom" && (
          <input
            type="date"
            className="form-input corder-date-picker"
            value={customDate}
            max={todayKey}
            aria-label="Күнді таңдау"
            onChange={(e) => setCustomDate(e.target.value)}
          />
        )}
      </div>

      <div className="status-filter-row is-compact">
        {(Object.keys(BUCKET_LABELS) as Bucket[]).map((b) => (
          <button
            key={b}
            className={`status-filter-btn${bucket === b ? " active" : ""}`}
            onClick={() => setBucket(b)}
          >
            <span>{BUCKET_LABELS[b]}</span>
          </button>
        ))}
      </div>

      <div className="orders-section">
        {/* "24.09.2026 · 8 заказ" — only once the list is scoped to one actual day; meaningless
            (and not shown) across "Барлығы", which spans every day at once. */}
        {dayHeading && !loading && (
          <div className="corder-day-heading">
            <strong>{formatDateDMY(new Date(`${dayHeading}T12:00:00+05:00`))}</strong>
            <span>{filtered.length} заказ</span>
          </div>
        )}
        {loading ? (
          <Spinner />
        ) : filtered.length === 0 ? (
          <div className="empty-state">
            <div className="icon">📭</div>
            <p>Заказ табылмады</p>
            <p className="empty-state-hint">
              {bucket === "all" && datePeriod === "all"
                ? "Жаңа заказ беру үшін төмендегі ➕ батырмасын басыңыз."
                : "Бұл сүзгіге сай заказ жоқ — «Барлығы» дегенді таңдап көріңіз."}
            </p>
          </div>
        ) : (
          <div className="ocards">
            {paged.map((o) => {
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
                    {/* Day and month right beside the code: scanning a list of orders, "which one
                        is this" and "when" are the same question, and a relative "2 сағат бұрын"
                        down in the footer never answered the second one. */}
                    {(o.updatedAt ?? o.createdAt) && (
                      <span className="corder-date">{formatDayMonth((o.updatedAt ?? o.createdAt)!)}</span>
                    )}
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

                  <CustomerProductionProgress order={o} />

                  <div className="corder-foot">
                    {/* The same timestamp now reads as a date up in the header, so repeating it
                        here as "2 сағат бұрын" would only say it twice. */}
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
        {!loading && filtered.length > PAGE_SIZE && (
          <div className="pagination-row">
            <button className="btn btn-outline btn-sm" disabled={pageSafe <= 1} onClick={() => setPage((p) => p - 1)}>
              ← Алдыңғы
            </button>
            <span>
              {(pageSafe - 1) * PAGE_SIZE + 1}–{Math.min(pageSafe * PAGE_SIZE, filtered.length)} / {filtered.length} заказ
            </span>
            <button className="btn btn-outline btn-sm" disabled={pageSafe >= pageCount} onClick={() => setPage((p) => p + 1)}>
              Келесі →
            </button>
          </div>
        )}
      </div>
      </>
      )}

      <Toast message={message} visible={visible} />
    </AppShell>
  );
}
