import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { writeBatch, doc } from "firebase/firestore";
import { db } from "../../firebase";
import { useAuth } from "../../AuthContext";
import { Spinner, Toast } from "../../components";
import { AppShell } from "../../components/layout/AppShell";
import { ProductionStatusBadge, PaymentStatusBadge } from "../../components/StatusBadge";
import { OrderProgress } from "../../components/OrderProgress";
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
      <div className="kpi-row">
        <div className="kpi-card">
          <div className="kpi-text">
            <div className="kpi-label">Барлығы</div>
            <div className="kpi-value">{totals.total}</div>
          </div>
          <span className="kpi-icon is-indigo">📋</span>
        </div>
        <div className="kpi-card">
          <div className="kpi-text">
            <div className="kpi-label">Жұмыста</div>
            <div className="kpi-value">{totals.inProgress}</div>
          </div>
          <span className="kpi-icon is-blue">⚙</span>
        </div>
        <div className="kpi-card">
          <div className="kpi-text">
            <div className="kpi-label">Дайын</div>
            <div className="kpi-value">{totals.done}</div>
          </div>
          <span className="kpi-icon is-green">✓</span>
        </div>
        <div className="kpi-card">
          <div className="kpi-text">
            <div className="kpi-label">Жалпы қарыз</div>
            <div className="kpi-value is-danger">{formatMoney(totals.debt)}</div>
          </div>
          <span className="kpi-icon is-red">💼</span>
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
            <p className="empty-state-hint">
              Іздеуді немесе сүзгіні өзгертіп көріңіз — бұл шартқа сай заказ табылмады.
            </p>
          </div>
        ) : (
          <>
            {/* Desktop: the full ledger with the production strip. Phones get the card list
                below — the same data, stacked, since ten columns cannot fit a 390px screen. */}
            <div className="otable-wrap">
              <table className="otable">
                <thead>
                  <tr>
                    <th>Заказ / Күні</th>
                    <th>Клиент</th>
                    <th>Материал</th>
                    <th className="num">Сома</th>
                    <th>Төлем</th>
                    <th>Өндіріс барысы</th>
                    <th>Жауапты</th>
                  </tr>
                </thead>
                <tbody>
                  {pageItems.map((order) => (
                    <OrderTableRow key={order.id} order={order} />
                  ))}
                </tbody>
              </table>
            </div>

            <div className="ocards">
              {pageItems.map((order) => (
                <OrderCard key={order.id} order={order} />
              ))}
            </div>
          </>
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

/** Initials for the assignee bubble — two letters, so "Нұрбақыт Асанов" reads as НА. */
function initials(name: string | undefined): string {
  if (!name) return "—";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "—";
  return (parts[0][0] + (parts[1]?.[0] ?? "")).toUpperCase();
}

/** "6 лист · 89 м ПВХ" — what the order is made of, in one line. */
function materialLine(order: Order): string {
  const sheets = order.confirmedSheets ?? order.estimatedSheets ?? 0;
  const bits = [`${sheets} лист`];
  if (order.pvcMetersTotal > 0) {
    // Metres are a sum of per-edge millimetre divisions, so binary floating point leaks through
    // as "3.3000000000000003". Round to centimetres, then drop a trailing ".00"/".50" zero.
    bits.push(`${Number(order.pvcMetersTotal.toFixed(2))} м ПВХ`);
  }
  return bits.join(" · ");
}

function assignee(order: Order): string | undefined {
  return order.assignedCutterName ?? order.assignedPvcName ?? order.assignedManagerName;
}

function OrderTableRow({ order }: { order: Order }) {
  return (
    <tr className="otable-row">
      <td>
        <Link to={`/admin/order/${order.id}`} className="otable-num">{order.orderNumber}</Link>
        <div className="otable-sub">{order.createdAt ? formatDateDMY(order.createdAt) : "—"}</div>
      </td>
      <td>
        <div className="otable-strong">{order.customerName}</div>
        <div className="otable-sub">{order.customerPhone || "—"}</div>
      </td>
      <td className="otable-sub">{materialLine(order)}</td>
      <td className="num otable-money">{formatMoney(order.totalTiyn)}</td>
      <td><PaymentStatusBadge status={order.paymentStatus} /></td>
      <td><OrderProgress order={order} /></td>
      <td>
        <span className="otable-avatar" title={assignee(order) ?? "Тағайындалмаған"}>
          {initials(assignee(order))}
        </span>
      </td>
    </tr>
  );
}

function OrderCard({ order }: { order: Order }) {
  return (
    <Link to={`/admin/order/${order.id}`} className="ocard">
      <div className="ocard-top">
        <span className="otable-num">{order.orderNumber}</span>
        <span className="otable-sub">{order.createdAt ? formatDateDMY(order.createdAt) : "—"}</span>
      </div>
      <div className="ocard-mid">
        <span className="otable-strong">{order.customerName}</span>
        <span className="otable-money">{formatMoney(order.totalTiyn)}</span>
      </div>
      <div className="ocard-meta">
        <span className="otable-sub">{materialLine(order)}</span>
        <PaymentStatusBadge status={order.paymentStatus} />
      </div>
      <OrderProgress order={order} />
    </Link>
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
