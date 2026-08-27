import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { writeBatch, doc } from "firebase/firestore";
import { db } from "../../firebase";
import { useAuth } from "../../AuthContext";
import { Spinner, Toast } from "../../components";
import { AppShell } from "../../components/layout/AppShell";
import { ProductionStatusBadge, PaymentStatusBadge } from "../../components/StatusBadge";
import { useAllOrders } from "../../hooks/useOrders";
import { useToast } from "../../hooks";
import { formatMoney } from "../../lib/money";
import { formatDateDMY } from "../../lib/dates";
import { PRODUCTION_STATUS_LABELS, PRODUCTION_STATUS_ORDER } from "../../lib/statuses";
import type { Order, ProductionStatus } from "../../types/domain";

const PAGE_SIZE = 20;

export default function AdminOrders() {
  const { userData } = useAuth();
  const { orders, loading } = useAllOrders();
  const { message, visible, showToast } = useToast();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | ProductionStatus>("all");
  const [sortBy, setSortBy] = useState<"createdAt" | "priority" | "totalTiyn">("createdAt");
  const [page, setPage] = useState(1);

  const filtered = useMemo(() => {
    let list = orders;
    if (statusFilter !== "all") list = list.filter((o) => o.productionStatus === statusFilter);
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (o) =>
          o.orderNumber.toLowerCase().includes(q) ||
          o.customerName.toLowerCase().includes(q) ||
          o.customerPhone.includes(q),
      );
    }
    const sorted = [...list].sort((a, b) => {
      if (sortBy === "priority") return (a.priority || 0) - (b.priority || 0);
      if (sortBy === "totalTiyn") return b.totalTiyn - a.totalTiyn;
      return (b.createdAt?.seconds ?? 0) - (a.createdAt?.seconds ?? 0);
    });
    return sorted;
  }, [orders, statusFilter, search, sortBy]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageItems = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const totals = useMemo(() => {
    const total = orders.length;
    const done = orders.filter((o) => o.productionStatus === "delivered").length;
    const inProgress = orders.filter((o) => !["draft", "delivered", "cancelled"].includes(o.productionStatus)).length;
    const debt = orders.reduce((s, o) => s + (o.debtTiyn || 0), 0);
    return { total, done, inProgress, debt };
  }, [orders]);

  if (!userData) return <Spinner />;

  return (
    <AppShell
      title="Заказдар"
      subtitle={`Сәлем, ${userData.name || "Админ"}`}
      search={{
        value: search,
        onChange: (v) => {
          setSearch(v);
          setPage(1);
        },
        placeholder: "Заказ №, аты немесе телефон бойынша іздеу...",
      }}
    >
      <div className="stats-bar">
        <div className="stat-card">
          <div className="number">{totals.total}</div>
          <div className="label">Барлығы</div>
        </div>
        <div className="stat-card">
          <div className="number">{totals.inProgress}</div>
          <div className="label">Жұмыста</div>
        </div>
        <div className="stat-card">
          <div className="number">{formatMoney(totals.debt)}</div>
          <div className="label">Жалпы қарыз</div>
        </div>
      </div>

      <div className="status-filter-row" style={{ overflowX: "auto", flexWrap: "nowrap" }}>
        <button
          className={`status-filter-btn${statusFilter === "all" ? " active" : ""}`}
          onClick={() => {
            setStatusFilter("all");
            setPage(1);
          }}
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
              onClick={() => {
                setStatusFilter(s);
                setPage(1);
              }}
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
        ) : statusFilter === "cutting_queue" ? (
          <QueueReorder orders={filtered} showToast={showToast} />
        ) : pageItems.length === 0 ? (
          <div className="empty-state">
            <div className="icon">📭</div>
            <p>Заказдар жоқ</p>
          </div>
        ) : (
          pageItems.map((order) => <AdminOrderRow key={order.id} order={order} />)
        )}
        {statusFilter !== "cutting_queue" && totalPages > 1 && (
          <div className="pagination-row">
            <button className="btn btn-outline btn-sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              ← Алдыңғы
            </button>
            <span>
              {page} / {totalPages}
            </span>
            <button
              className="btn btn-outline btn-sm"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              Келесі →
            </button>
          </div>
        )}
      </div>

      <Toast message={message} visible={visible} />
    </AppShell>
  );
}

function QueueReorder({
  orders,
  showToast,
}: {
  orders: Order[];
  showToast: (msg: string) => void;
}) {
  const [items, setItems] = useState(orders);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!dirty) setItems(orders);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orders]);

  const handleDrop = (targetIndex: number) => {
    if (dragIndex === null || dragIndex === targetIndex) return;
    setItems((prev) => {
      const next = [...prev];
      const [moved] = next.splice(dragIndex, 1);
      next.splice(targetIndex, 0, moved);
      return next;
    });
    setDragIndex(null);
    setDirty(true);
  };

  const handleSave = async () => {
    try {
      const batch = writeBatch(db);
      items.forEach((order, i) =>
        batch.update(doc(db, "orders", order.id), {
          priority: i,
          queueAheadOrderNumber: i > 0 ? items[i - 1].orderNumber : null,
        }),
      );
      await batch.commit();
      setDirty(false);
      showToast("✅ Кезек реттелді");
    } catch (err: unknown) {
      showToast("Қате: " + (err as Error).message);
    }
  };

  if (items.length === 0) {
    return (
      <div className="empty-state">
        <div className="icon">📭</div>
        <p>Кезекте заказ жоқ</p>
      </div>
    );
  }

  return (
    <div>
      <p className="reorder-hint">🖱 Жолдарды сүйреп, кезек ретін өзгертіңіз</p>
      {items.map((order, i) => (
        <div
          key={order.id}
          className="track-card reorder-row"
          draggable
          onDragStart={() => setDragIndex(i)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={() => handleDrop(i)}
        >
          <span className="reorder-handle">⠿</span>
          <div style={{ flex: 1 }}>
            <div className="track-card-header">
              <span className="track-card-num">{i + 1}. {order.orderNumber}</span>
              <ProductionStatusBadge status={order.productionStatus} />
            </div>
            <div className="order-client">{order.customerName}</div>
          </div>
        </div>
      ))}
      {dirty && (
        <button className="btn btn-primary btn-full" onClick={handleSave} style={{ marginTop: 12 }}>
          💾 Кезекті сақтау
        </button>
      )}
    </div>
  );
}

function AdminOrderRow({ order }: { order: Order }) {
  return (
    <Link to={`/admin/order/${order.id}`} className="track-card">
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
      <div className="track-card-meta-row">
        <span>Лист: {order.confirmedSheets ?? order.estimatedSheets} (болжам)</span>
        <span>ПВХ: {order.pvcMetersTotal.toFixed(2)} м</span>
      </div>
      <div className="track-card-meta-row">
        <span>
          {order.assignedCutterName ? `🪚 ${order.assignedCutterName}` : "🪚 тағайындалмаған"}
        </span>
        <span>{order.assignedPvcName ? `🪟 ${order.assignedPvcName}` : ""}</span>
      </div>
      {order.createdAt && <div className="order-date">{formatDateDMY(order.createdAt)}</div>}
    </Link>
  );
}
