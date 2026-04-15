import { useState, useMemo } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../AuthContext";
import { useOrders, type Order, needsPvh } from "../hooks";
import { Spinner } from "../components";
import { formatDateTime } from "../utils";

export default function Track() {
  const { orders, loading } = useOrders();
  const [search, setSearch] = useState("");
  const [selectedDate, setSelectedDate] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "done" | "pending">(
    "all",
  );

  // Generate date tabs: today + 6 past days
  const dateTabs = useMemo(() => {
    const tabs: { key: string; label: string; date: Date }[] = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    for (let i = 0; i >= -6; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() + i);
      let label: string;
      if (i === 0) label = "Бүгін";
      else if (i === -1) label = "Кеше";
      else {
        const dayNum = d.getDate();
        const monthNames = [
          "қаң",
          "ақп",
          "нау",
          "сәу",
          "мам",
          "мау",
          "шіл",
          "там",
          "қыр",
          "қаз",
          "қар",
          "жел",
        ];
        label = `${dayNum} ${monthNames[d.getMonth()]}`;
      }
      tabs.push({ key: d.toISOString().slice(0, 10), label, date: d });
    }
    return tabs;
  }, []);

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

  // Filter orders by selected date and status
  const dateFilteredOrders = useMemo(() => {
    let list =
      selectedDate === "all"
        ? activeOrders
        : orders.filter((o) => {
            if (!o.createdAt) return false;
            const d = new Date(o.createdAt.seconds * 1000);
            const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
            return key === selectedDate;
          });
    if (statusFilter === "done") {
      list = orders.filter((o) => o.raspilDone && o.pvhDone);
    } else if (statusFilter === "pending") {
      list = list.filter((o) => !(o.raspilDone && o.pvhDone));
    }
    return list;
  }, [orders, activeOrders, selectedDate, statusFilter]);

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

  return (
    <>
      <div className="client-header">
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <h1>📦 Заказ трекер</h1>
          <Link to="/login" className="btn-login-link">
            🔑 Кіру
          </Link>
        </div>
        <p>Заказыңыздың дайындығын бақылаңыз</p>
      </div>

      <div className="search-bar">
        <div className="search-input-wrap">
          <span className="search-icon">🔍</span>
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
        <div className="section-title">Барлық белсенді заказдар</div>
        <div className="status-filter-row">
          <button
            className={`status-filter-btn${statusFilter === "all" ? " active" : ""}`}
            onClick={() => setStatusFilter("all")}
          >
            Барлығы
          </button>
          <button
            className={`status-filter-btn pending${statusFilter === "pending" ? " active" : ""}`}
            onClick={() => setStatusFilter("pending")}
          >
            ⏳ Дайын емес
          </button>
          <button
            className={`status-filter-btn done${statusFilter === "done" ? " active" : ""}`}
            onClick={() => setStatusFilter("done")}
          >
            ✅ Дайын
          </button>
        </div>
        <div className="date-tabs-scroll">
          <div className="date-tabs">
            <button
              className={`date-tab${selectedDate === "all" ? " active" : ""}`}
              onClick={() => setSelectedDate("all")}
            >
              Барлығы
            </button>
            {dateTabs.map((tab) => (
              <button
                key={tab.key}
                className={`date-tab${selectedDate === tab.key ? " active" : ""}`}
                onClick={() => setSelectedDate(tab.key)}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>
        <div>
          {loading ? (
            <Spinner />
          ) : dateFilteredOrders.length === 0 ? (
            <div className="empty-state">
              <div className="icon">🎉</div>
              <p>
                {selectedDate === "all"
                  ? "Қазір белсенді заказдар жоқ"
                  : "Бұл күнде заказдар жоқ"}
              </p>
            </div>
          ) : (
            dateFilteredOrders.map((order, idx) => (
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

      <div style={{ paddingBottom: 80 }} />

      <TrackBottomNav />
    </>
  );
}

function TrackBottomNav() {
  const { user, userData } = useAuth();
  if (!user || !userData) {
    return (
      <nav className="bottom-nav">
        <Link to="/" className="bottom-nav-item active">
          <span className="bottom-nav-icon">📦</span>
          <span className="bottom-nav-label">Бақылау</span>
        </Link>
        <Link to="/assortment" className="bottom-nav-item">
          <span className="bottom-nav-icon">🎨</span>
          <span className="bottom-nav-label">Листтар</span>
        </Link>
        <Link to="/login" className="bottom-nav-item">
          <span className="bottom-nav-icon">🔑</span>
          <span className="bottom-nav-label">Кіру</span>
        </Link>
      </nav>
    );
  }
  if (userData.role === "admin") {
    return (
      <nav className="bottom-nav">
        <Link to="/admin" className="bottom-nav-item">
          <span className="bottom-nav-icon">📋</span>
          <span className="bottom-nav-label">Заказдар</span>
        </Link>
        <Link to="/track" className="bottom-nav-item active">
          <span className="bottom-nav-icon">📦</span>
          <span className="bottom-nav-label">Бақылау</span>
        </Link>
        <Link to="/assortment" className="bottom-nav-item">
          <span className="bottom-nav-icon">🎨</span>
          <span className="bottom-nav-label">Листтар</span>
        </Link>
        <Link to="/setup" className="bottom-nav-item">
          <span className="bottom-nav-icon">⚙️</span>
          <span className="bottom-nav-label">Баптау</span>
        </Link>
      </nav>
    );
  }
  return (
    <nav className="bottom-nav">
      <Link to="/worker" className="bottom-nav-item">
        <span className="bottom-nav-icon">🔧</span>
        <span className="bottom-nav-label">Заказ</span>
      </Link>
      <Link to="/track" className="bottom-nav-item active">
        <span className="bottom-nav-icon">📦</span>
        <span className="bottom-nav-label">Бақылау</span>
      </Link>
      <Link to="/assortment" className="bottom-nav-item">
        <span className="bottom-nav-icon">🎨</span>
        <span className="bottom-nav-label">Листтар</span>
      </Link>
    </nav>
  );
}

function TrackOrderCard({
  order,
  num,
  waitMinutes,
}: {
  order: Order;
  num: number;
  waitMinutes?: number;
}) {
  const isDone = order.raspilDone && order.pvhDone;
  let statusText: string, statusClass: string;
  if (isDone) {
    statusText = "Дайын ✅";
    statusClass = "status-done";
  } else if (order.raspilDone || order.pvhDone) {
    statusText = "Жұмыста 🔄";
    statusClass = "status-progress";
  } else {
    statusText = "Кезекте ⏳";
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
      <div className="track-card-header">
        <span className="track-card-num">{num}.</span>
        <span className="track-card-client">{order.clientName}</span>
        <span className={`track-card-status ${statusClass}`}>{statusText}</span>
      </div>
      {waitDisplay && <div className="track-card-wait">{waitDisplay}</div>}
      <div className="track-card-items">
        {order.items.map((item, i) => {
          const hasPvh = needsPvh(item.material);
          const itemDone = item.raspilDone && (hasPvh ? item.pvhDone : true);
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
                  🪚<small>Распил</small>
                </span>
                {hasPvh && (
                  <span className={`track-dot${item.pvhDone ? " done" : ""}`}>
                    🪟<small>ПВХ</small>
                  </span>
                )}
                <span className={`track-dot${itemDone ? " done" : ""}`}>
                  {itemDone ? "✅" : "⬜"}
                  <small>Дайын</small>
                </span>
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
