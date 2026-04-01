import { useState, useMemo } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../AuthContext";
import { useOrders, type Order } from "../hooks";
import { ItemProgressSteps, Spinner } from "../components";
import { formatDateTime } from "../utils";

export default function Track() {
  const { orders, loading } = useOrders();
  const [search, setSearch] = useState("");

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
                <TrackOrderCard key={order.id} order={order} num={idx + 1} />
              ))
            )
          ) : null}
        </div>
      </div>

      <div className="orders-section">
        <div className="section-title">Барлық белсенді заказдар</div>
        <div>
          {loading ? (
            <Spinner />
          ) : activeOrders.length === 0 ? (
            <div className="empty-state">
              <div className="icon">🎉</div>
              <p>Қазір белсенді заказдар жоқ</p>
            </div>
          ) : (
            activeOrders.map((order, idx) => (
              <TrackOrderCard key={order.id} order={order} num={idx + 1} />
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
    </nav>
  );
}

function TrackOrderCard({ order, num }: { order: Order; num: number }) {
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

  return (
    <div className={`track-card${isDone ? " done" : ""}`}>
      <div className="track-card-header">
        <span className="track-card-num">{num}.</span>
        <span className="track-card-client">{order.clientName}</span>
        <span className={`track-card-status ${statusClass}`}>{statusText}</span>
      </div>
      <div className="track-card-items">
        {order.items.map((item, i) => (
          <div key={i} className="track-card-item">
            {item.material && (
              <span className={`material-tag material-${item.material}`}>
                {item.material.toUpperCase()}
              </span>
            )}
            <span className="track-card-desc">{item.description}</span>
            <ItemProgressSteps item={item} />
          </div>
        ))}
      </div>
      {order.createdAt && (
        <div className="track-card-date">📅 {formatDateTime(order.createdAt.seconds)}</div>
      )}
    </div>
  );
}
