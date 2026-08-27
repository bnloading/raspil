import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useAuth } from "../../AuthContext";
import { Spinner } from "../../components";
import { AppShell } from "../../components/layout/AppShell";
import { ProductionStatusBadge, PaymentStatusBadge } from "../../components/StatusBadge";
import { useAllOrders } from "../../hooks/useOrders";
import { formatMoney } from "../../lib/money";
import { formatDateDMY } from "../../lib/dates";
import { exportCsv } from "../../lib/exportTable";
import { PRODUCTION_STATUS_LABELS, PRODUCTION_STATUS_ORDER } from "../../lib/statuses";
import type { Order, ProductionStatus } from "../../types/domain";

const PAGE_SIZE = 20;

// A Manager doesn't process pure drafts (never submitted by the customer yet); delivered/cancelled
// orders are hidden from the default view but still reachable via the "Барлығы" filter.
const DEFAULT_HIDDEN: ProductionStatus[] = ["draft", "delivered", "cancelled"];

export default function ManagerOrders() {
  const { userData } = useAuth();
  const { orders, loading } = useAllOrders();
  const [searchParams, setSearchParams] = useSearchParams();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "default" | ProductionStatus>("default");
  const [sortBy, setSortBy] = useState<"createdAt" | "priority" | "totalTiyn">("createdAt");
  const [page, setPage] = useState(1);

  useEffect(() => {
    const fromQuery = searchParams.get("status");
    if (fromQuery && (PRODUCTION_STATUS_ORDER as string[]).includes(fromQuery)) {
      setStatusFilter(fromQuery as ProductionStatus);
    }
  }, [searchParams]);

  const baseList = useMemo(() => {
    if (statusFilter === "all") return orders;
    if (statusFilter === "default") return orders.filter((o) => !DEFAULT_HIDDEN.includes(o.productionStatus));
    return orders.filter((o) => o.productionStatus === statusFilter);
  }, [orders, statusFilter]);

  const filtered = useMemo(() => {
    let list = baseList;
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (o) =>
          o.orderNumber.toLowerCase().includes(q) ||
          o.customerName.toLowerCase().includes(q) ||
          o.customerPhone.includes(q),
      );
    }
    return [...list].sort((a, b) => {
      if (sortBy === "priority") return (a.priority || 0) - (b.priority || 0);
      if (sortBy === "totalTiyn") return b.totalTiyn - a.totalTiyn;
      return (b.createdAt?.seconds ?? 0) - (a.createdAt?.seconds ?? 0);
    });
  }, [baseList, search, sortBy]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageItems = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const totals = useMemo(() => {
    const debt = orders.reduce((s, o) => s + (o.debtTiyn || 0), 0);
    return { total: orders.length, shown: baseList.length, debt };
  }, [orders, baseList]);

  const setFilter = (f: "all" | "default" | ProductionStatus) => {
    setStatusFilter(f);
    setPage(1);
    setSearchParams(f === "default" ? {} : { status: f });
  };

  const handleExport = () => {
    exportCsv(
      "заказдар",
      filtered.map((o) => ({
        "Заказ №": o.orderNumber,
        Клиент: o.customerName,
        Телефон: o.customerPhone,
        Сома: o.totalTiyn / 100,
        Төленді: o.paidTiyn / 100,
        Қарыз: o.debtTiyn / 100,
        Статус: PRODUCTION_STATUS_LABELS[o.productionStatus],
        Күні: o.createdAt ? formatDateDMY(o.createdAt) : "",
      })),
    );
  };

  if (!userData) return <Spinner />;

  return (
    <AppShell
      title="Заказдар"
      subtitle={`Сәлем, ${userData.name || "Менеджер"}`}
      search={{
        value: search,
        onChange: (v) => {
          setSearch(v);
          setPage(1);
        },
        placeholder: "Заказ №, аты немесе телефон бойынша іздеу...",
      }}
      actions={
        <button className="btn btn-outline btn-sm" onClick={handleExport}>
          CSV жүктеу
        </button>
      }
    >
      <div className="stats-bar">
        <div className="stat-card">
          <div className="number">{totals.total}</div>
          <div className="label">Барлығы</div>
        </div>
        <div className="stat-card">
          <div className="number">{totals.shown}</div>
          <div className="label">Көрсетілуде</div>
        </div>
        <div className="stat-card">
          <div className="number">{formatMoney(totals.debt)}</div>
          <div className="label">Жалпы қарыз</div>
        </div>
      </div>

      <div className="status-filter-row" style={{ overflowX: "auto", flexWrap: "nowrap" }}>
        <button
          className={`status-filter-btn${statusFilter === "default" ? " active" : ""}`}
          onClick={() => setFilter("default")}
        >
          <span>Белсенді</span>
          <b>{orders.filter((o) => !DEFAULT_HIDDEN.includes(o.productionStatus)).length}</b>
        </button>
        <button className={`status-filter-btn${statusFilter === "all" ? " active" : ""}`} onClick={() => setFilter("all")}>
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
              onClick={() => setFilter(s)}
            >
              <span>{PRODUCTION_STATUS_LABELS[s]}</span>
              <b>{count}</b>
            </button>
          );
        })}
      </div>

      <div className="orders-section">
        <div className="section-title-row orders-title-row">
          <div className="section-title">Заказдар тізімі</div>
          <select className="form-select-material" value={sortBy} onChange={(e) => setSortBy(e.target.value as typeof sortBy)}>
            <option value="createdAt">Күні бойынша</option>
            <option value="priority">Приоритет бойынша</option>
            <option value="totalTiyn">Сома бойынша</option>
          </select>
        </div>
        {loading ? (
          <Spinner />
        ) : pageItems.length === 0 ? (
          <div className="empty-state">
            <div className="icon">📭</div>
            <p>Заказдар жоқ</p>
          </div>
        ) : (
          pageItems.map((order) => <ManagerOrderRow key={order.id} order={order} />)
        )}
        {totalPages > 1 && (
          <div className="pagination-row">
            <button className="btn btn-outline btn-sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              ← Алдыңғы
            </button>
            <span>
              {page} / {totalPages}
            </span>
            <button className="btn btn-outline btn-sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
              Келесі →
            </button>
          </div>
        )}
      </div>
    </AppShell>
  );
}

function ManagerOrderRow({ order }: { order: Order }) {
  return (
    <Link to={`/manager/order/${order.id}`} className="track-card">
      <div className="track-card-header">
        <span className="track-card-num">{order.orderNumber}</span>
        <ProductionStatusBadge status={order.productionStatus} />
      </div>
      <div className="order-client">{order.customerName}</div>
      <div className="track-card-meta-row">
        <span>{formatMoney(order.totalTiyn)}</span>
        <PaymentStatusBadge status={order.paymentStatus} />
      </div>
      <div className="track-card-meta-row">
        <span>Төленді: {formatMoney(order.paidTiyn)}</span>
        <span>Қарыз: {formatMoney(order.debtTiyn)}</span>
      </div>
      {order.createdAt && <div className="order-date">{formatDateDMY(order.createdAt)}</div>}
    </Link>
  );
}
