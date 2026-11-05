import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { doc, serverTimestamp, updateDoc } from "firebase/firestore";
import { db } from "../../firebase";
import { useAuth } from "../../AuthContext";
import { Spinner, Toast } from "../../components";
import { AppShell } from "../../components/layout/AppShell";
import { CustomerOrderCard } from "../../components/CustomerOrderCard";
import { WorkshopActivityBoard } from "../../components/WorkshopActivityBoard";
import { useCustomerOrders } from "../../hooks/useOrders";
import { useCustomerDebts } from "../../hooks/useCustomerDebts";
import { useToast } from "../../hooks";
import { formatMoney } from "../../lib/money";
import { dayKey, formatDateDMY } from "../../lib/dates";
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

function isBucket(value: string | null): value is Bucket {
  return value !== null && value in BUCKET_LABELS;
}

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

function inBucket(order: Order, bucket: Bucket, debtOf: (o: Order) => number): boolean {
  switch (bucket) {
    case "active":
      // "ready" belongs to Дайын, not Жұмыста — the work on it is finished even though the
      // customer has not collected it yet, so counting it in both would overstate the workload.
      return !["draft", "ready", "delivered", "cancelled"].includes(order.productionStatus);
    case "ready":
      // Waiting to be collected — the same count the home page shows under «Дайын», so tapping
      // it opens exactly those. Orders already handed over are under «Барлығы».
      return order.productionStatus === "ready";
    case "debt":
      return debtOf(order) > 0;
    default:
      return true;
  }
}

/** Which half of the page is showing: this customer's own orders, or the shop's live board. */
type Tab = "mine" | "shop";

export default function CustomerOrders() {
  const { user, userData } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { orders, loading } = useCustomerOrders(user?.uid);
  const { debtOf, totals } = useCustomerDebts(orders);
  const { message, visible, showToast } = useToast();
  const [search, setSearch] = useState("");
  // The home page's counts open this list already filtered (/orders?bucket=ready).
  const [bucket, setBucket] = useState<Bucket>(() => {
    const asked = params.get("bucket");
    return isBucket(asked) ? asked : "all";
  });
  const [datePeriod, setDatePeriod] = useState<DatePeriod>("all");
  const [customDate, setCustomDate] = useState("");
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 10;
  const [tab, setTab] = useState<Tab>("mine");

  // Read once, when the page opens — the clock is not something to call on every render.
  const [{ todayKey, yesterdayKey }] = useState(() => ({
    todayKey: dayKey(Date.now()),
    yesterdayKey: dayKey(Date.now() - 86_400_000),
  }));

  const counts = useMemo(
    () => ({
      all: orders.length,
      active: orders.filter((o) => inBucket(o, "active", debtOf)).length,
      ready: orders.filter((o) => inBucket(o, "ready", debtOf)).length,
      debt: orders.filter((o) => inBucket(o, "debt", debtOf)).length,
    }),
    [orders, debtOf],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return orders.filter((o) =>
      inBucket(o, bucket, debtOf) &&
      inDatePeriod(o, datePeriod, todayKey, yesterdayKey, customDate) &&
      (!q || o.orderNumber.toLowerCase().includes(q)));
  }, [orders, bucket, debtOf, datePeriod, todayKey, yesterdayKey, customDate, search]);

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

  /** A count that is also its filter: tapping it shows those orders — and tapping again, all. */
  const kpi = (b: Exclude<Bucket, "debt">, icon: string, tone: string) => (
    <button
      type="button"
      className={`kpi-card${bucket === b ? " is-active" : ""}`}
      aria-pressed={bucket === b}
      onClick={() => setBucket(bucket === b && b !== "all" ? "all" : b)}
    >
      <div className="kpi-text">
        <div className="kpi-label">{BUCKET_LABELS[b]}</div>
        <div className="kpi-value">{counts[b]}</div>
      </div>
      <span className={`kpi-icon ${tone}`}>{icon}</span>
    </button>
  );

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
        {kpi("all", "📋", "is-indigo")}
        {kpi("active", "⚙", "is-blue")}
        {kpi("ready", "✓", "is-green")}
        {/* The money opens the «Қарыз» page — each owing order with its lines and payments. */}
        <Link to="/debt" className="kpi-card">
          <div className="kpi-text">
            <div className="kpi-label">Қарыз</div>
            <div className={`kpi-value${totals.debtTiyn > 0 ? " is-danger" : ""}`}>{formatMoney(totals.debtTiyn)}</div>
          </div>
          <span className="kpi-icon is-red">💼</span>
        </Link>
      </div>

      {/* A customer who orders often has today's brand-new order buried under last month's — this
          scopes the list to "when" before (or together with) the status buckets below scope it to
          "what state". Plain pills, no counts — the KPI row above already has the numbers. */}
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
              {orders.length === 0
                ? "Цехта сіздің телефон нөміріңізбен жазылған заказдар осында өзі шығады. Онлайн тапсырыс беру үшін ➕ батырмасын басыңыз."
                : "Бұл сүзгіге сай заказ жоқ — «Барлығы» дегенді таңдап көріңіз."}
            </p>
          </div>
        ) : (
          <div className="ocards">
            {paged.map((o) => {
              const canCancel = isCancellable(o.productionStatus);
              const isDraft = o.productionStatus === "draft";
              return (
                <CustomerOrderCard
                  key={o.id}
                  order={o}
                  debtTiyn={debtOf(o)}
                  actions={(canCancel || isDraft) && (
                    <>
                      <button type="button" className="btn btn-outline btn-sm"
                        onClick={() => navigate(`/order/new?duplicate=${o.id}`)}>
                        ⧉ Қайталау
                      </button>
                      {isDraft && (
                        <button type="button" className="btn btn-outline btn-sm"
                          onClick={() => navigate(`/order/new?edit=${o.id}`)}>
                          ✎ Жалғастыру
                        </button>
                      )}
                      {canCancel && (
                        <button type="button" className="btn btn-danger-outline btn-sm"
                          onClick={() => handleCancel(o.id)}>
                          ✕ Бас тарту
                        </button>
                      )}
                    </>
                  )}
                />
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
