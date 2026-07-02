import { useState, useMemo } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../AuthContext";
import { useOrders, type Material, type Order, needsPvh } from "../hooks";
import { Spinner, TrackBottomNav } from "../components";
import { formatDateTime } from "../utils";
import moderaLogo from "../assets/modera-logo.svg";

function getSheetLeaderboard(orders: Order[]) {
  // Count material usage across all order items
  const sheetMap = new Map<Material | string, number>();
  for (const order of orders) {
    for (const item of order.items) {
      const mat = item.material || "лдсп";
      sheetMap.set(mat, (sheetMap.get(mat) || 0) + 1);
    }
  }
  return Array.from(sheetMap.entries()).sort((a, b) => b[1] - a[1]);
}

function getDateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getOrderDateKey(order: Order) {
  return getDateKey(
    order.createdAt ? new Date(order.createdAt.seconds * 1000) : new Date(),
  );
}

function formatDayChip(date: Date, index: number) {
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = date.getFullYear();
  return `${index === 0 ? "Бүгін " : ""}${day}.${month}.${year}`;
}

function getRecentDays() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Array.from({ length: 4 }, (_, index) => {
    const date = new Date(today);
    date.setDate(today.getDate() - index);
    return { key: getDateKey(date), label: formatDayChip(date, index) };
  });
}

function Track() {
  const { orders, loading } = useOrders();
  const recentDays = useMemo(() => getRecentDays(), []);
  const [selectedDateKey, setSelectedDateKey] = useState(recentDays[0].key);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "done" | "pending">(
    "all",
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return null;
    return orders.filter(
      (o) =>
        o.clientName.toLowerCase().includes(q) ||
        (o.phone && o.phone.includes(q)),
    );
  }, [search, orders]);

  const activeOrders = useMemo(() => {
    return orders.filter((o) => !(o.raspilDone && o.pvhDone));
  }, [orders]);

  const dateOrders = useMemo(() => {
    return orders.filter((o) => getOrderDateKey(o) === selectedDateKey);
  }, [orders, selectedDateKey]);

  const visibleOrders = useMemo(() => {
    let list = dateOrders;
    if (statusFilter === "done") {
      list = list.filter((o) => o.raspilDone && o.pvhDone);
    } else if (statusFilter === "pending") {
      list = list.filter((o) => !(o.raspilDone && o.pvhDone));
    }
    return list;
  }, [dateOrders, statusFilter]);

  // Calculate estimated wait minutes for each active order
  const waitTimes = useMemo(() => {
    const map = new Map<string, number>();
    let cumulative = 0;
    for (const o of activeOrders) {
      map.set(o.id, cumulative);
      if (o.estimatedMinutes) {
        cumulative += o.estimatedMinutes;
      }
    }
    return map;
  }, [activeOrders]);

  // Sheet/material leaderboard
  const sheetLeaderboard = useMemo(() => getSheetLeaderboard(orders), [orders]);

  const [showSheetLeaderboard, setShowSheetLeaderboard] = useState(false);

  return (
    <div className="figma-track-page">
      <div className="client-header">
        <div className="client-header-top">
          <img
            src={moderaLogo}
            alt="Modera Interior Objects"
            className="client-logo"
          />
          <div className="client-header-actions">
            <button
              className="header-icon-btn"
              type="button"
              aria-label="Notifications"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
                <path d="M10 21h4" />
              </svg>
            </button>
            <Link to="/login" className="btn-login-link" aria-label="Кіру">
              <span />
            </Link>
          </div>
        </div>
      </div>

      <div className="search-bar">
        <div className="search-input-wrap">
          <span className="search-icon">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="m16.5 16.5 4 4" />
            </svg>
          </span>
          <input
            type="text"
            className="search-input"
            placeholder="Атыңызды немесе телефон нөміріңізді жазыңыз..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      <div className="orders-section">
        <div>
          {filtered !== null ? (
            filtered.length === 0 ? (
              <div className="empty-state">
                <div className="icon">😔</div>
                <p>
                  Заказ табылмады
                  <br />
                  Басқа атпен немесе нөмірмен іздеңіз
                </p>
              </div>
            ) : (
              filtered.map((order, idx) => (
                <TrackOrderCard
                  key={order.id}
                  order={order}
                  num={idx + 1}
                  waitMinutes={waitTimes.get(order.id)}
                />
              ))
            )
          ) : null}
        </div>
      </div>

      <div className="orders-section">
        <div className="section-title">Барлық заказдар</div>
        <div className="date-filter-row" aria-label="Күн бойынша сүзгі">
          {recentDays.map((day) => (
            <button
              key={day.key}
              type="button"
              className={`date-filter-btn${selectedDateKey === day.key ? " active" : ""}`}
              onClick={() => setSelectedDateKey(day.key)}
            >
              {day.label}
            </button>
          ))}
        </div>
        <div className="status-filter-row">
          <button
            className={`status-filter-btn${statusFilter === "all" ? " active" : ""}`}
            onClick={() => setStatusFilter("all")}
          >
            <span>Барлығы</span>
            <b>{dateOrders.length}</b>
          </button>
          <button
            className={`status-filter-btn pending${statusFilter === "pending" ? " active" : ""}`}
            onClick={() => setStatusFilter("pending")}
          >
            <span>Дайын емес</span>
            <b>
              {dateOrders.filter((o) => !(o.raspilDone && o.pvhDone)).length}
            </b>
          </button>
          <button
            className={`status-filter-btn done${statusFilter === "done" ? " active" : ""}`}
            onClick={() => setStatusFilter("done")}
          >
            <span>Дайын</span>
            <b>{dateOrders.filter((o) => o.raspilDone && o.pvhDone).length}</b>
          </button>
        </div>
        <div>
          {loading ? (
            <Spinner />
          ) : visibleOrders.length === 0 ? (
            <div className="empty-state">
              <div className="icon">✓</div>
              <p>Бұл күнге заказдар жоқ</p>
            </div>
          ) : (
            visibleOrders.map((order, idx) => (
              <TrackOrderCard
                key={order.id}
                order={order}
                num={idx + 1}
                waitMinutes={waitTimes.get(order.id)}
              />
            ))
          )}
        </div>
      </div>

      <div className="track-page-spacer" />

      <TrackBottomNav />
      {showSheetLeaderboard && (
        <div
          className="modal-overlay"
          onClick={() => setShowSheetLeaderboard(false)}
        >
          <div
            className="modal"
            onClick={(e) => e.stopPropagation()}
            style={{
              minWidth: 320,
              background: "#fff",
              borderRadius: 12,
              padding: 24,
              maxWidth: "90vw",
              margin: "40px auto",
            }}
          >
            <h2 style={{ marginTop: 0 }}>Листтар Лидерборды</h2>
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {sheetLeaderboard.length === 0 ? (
                <li style={{ color: "#aaa" }}>Дерек жоқ</li>
              ) : (
                sheetLeaderboard.map(([mat, count], i) => (
                  <li
                    key={mat}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      padding: "6px 0",
                    }}
                  >
                    <span style={{ fontWeight: 600 }}>
                      {i + 1}. {mat.toUpperCase()}
                    </span>
                    <span style={{ color: "#555" }}>{count} рет</span>
                  </li>
                ))
              )}
            </ul>
            <button
              style={{ marginTop: 20 }}
              onClick={() => setShowSheetLeaderboard(false)}
            >
              Жабу
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default Track;

function TrackOrderCard({
  order,
  num,
  waitMinutes,
}: {
  order: Order;
  num: number;
  waitMinutes?: number;
}) {
  const { userData } = useAuth();
  const canDelete = userData?.role === "admin";
  const isDone = order.raspilDone && order.pvhDone;
  let statusText: string, statusClass: string;
  if (isDone) {
    statusText = "Дайын";
    statusClass = "status-done";
  } else if (order.raspilDone || order.pvhDone) {
    statusText = "Жұмыста";
    statusClass = "status-progress";
  } else {
    statusText = "Кезекте";
    statusClass = "status-queue";
  }

  // Format wait time display
  let waitDisplay: string | null = null;
  if (!isDone && waitMinutes !== undefined) {
    if (waitMinutes === 0 && order.estimatedMinutes) {
      waitDisplay = `⏱ ~${order.estimatedMinutes} мин. ішінде дайын`;
    } else if (waitMinutes > 0) {
      const total = waitMinutes + (order.estimatedMinutes || 0);
      if (total >= 60) {
        const h = Math.floor(total / 60);
        const m = total % 60;
        waitDisplay = `⏱ ~${h} сағ.${m > 0 ? ` ${m} мин.` : ""} ішінде дайын`;
      } else {
        waitDisplay = `⏱ ~${total} мин. ішінде дайын`;
      }
    }
  }

  return (
    <div className={`track-card${isDone ? " done" : ""}`}>
      <div className={`track-card-header${canDelete ? " has-delete" : ""}`}>
        <span className="track-card-num">{num}</span>
        <span className="track-card-client">{order.clientName}</span>
        <span className={`track-card-status ${statusClass}`}>{statusText}</span>
        {canDelete && (
          <button
            className="track-card-delete"
            type="button"
            aria-label="Өшіру"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M3 6h18" />
              <path d="M8 6V4h8v2" />
              <path d="M6 6l1 15h10l1-15" />
              <path d="M10 10v7" />
              <path d="M14 10v7" />
            </svg>
          </button>
        )}
      </div>
      {waitDisplay && <div className="track-card-wait">{waitDisplay}</div>}
      <div className="track-card-items">
        {order.items.map((item, i) => {
          const hasPvh = needsPvh(item.material);
          return (
            <div key={i} className="track-item-compact">
              <div className="track-item-left">
                {item.material && (
                  <span className={`material-tag material-${item.material}`}>
                    {item.material.toUpperCase()}
                  </span>
                )}
                <span className="track-card-desc">{item.description}</span>
              </div>
              <div className="track-item-dots">
                <span className={`track-dot${item.raspilDone ? " done" : ""}`}>
                  <span className="track-dot-icon">⌁</span>
                  <small>Распил</small>
                </span>
                {hasPvh && (
                  <span className={`track-dot${item.pvhDone ? " done" : ""}`}>
                    <span className="track-dot-icon">╂</span>
                    <small>ПВХ</small>
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {order.createdAt && (
        <div className="track-card-date">
          📅 {formatDateTime(order.createdAt.seconds)}
        </div>
      )}
    </div>
  );
}
