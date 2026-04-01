import { useEffect, useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { doc, updateDoc } from "firebase/firestore";
import { db } from "../firebase";
import { useAuth } from "../AuthContext";
import {
  useOrders,
  useToast,
  type Order,
  type OrderItem,
  needsPvh,
} from "../hooks";
import { Toast, Spinner } from "../components";

export default function Worker() {
  const { user, userData, loading: authLoading, logout } = useAuth();
  const navigate = useNavigate();
  const { orders, loading: ordersLoading } = useOrders();
  const { message, visible, showToast } = useToast();

  useEffect(() => {
    if (!authLoading) {
      if (!user) {
        navigate("/login", { replace: true });
      } else if (userData?.role === "admin") {
        navigate("/admin", { replace: true });
      }
    }
  }, [authLoading, user, userData, navigate]);

  if (authLoading || !userData) return <Spinner />;

  const currentRole = userData.role;
  const roleNames: Record<string, string> = {
    raspil: "🪚 Распил",
    pvh: "🪟 ПВХ",
  };

  const handleLogout = () => {
    logout().then(() => navigate("/login"));
  };

  const handleToggle = async (order: Order, itemIndex: number) => {
    const item = order.items[itemIndex];
    if (currentRole === "pvh" && !needsPvh(item.material)) return;
    const field = currentRole === "raspil" ? "raspilDone" : "pvhDone";
    const current = item[field];
    const updatedItems = order.items.map((item, i) =>
      i === itemIndex ? { ...item, [field]: !current } : item,
    );
    try {
      await updateDoc(doc(db, "orders", order.id), { items: updatedItems });
      showToast(current ? "↩️ Артқа қайтарылды" : "✅ Дайын деп белгіленді!");
    } catch (err: unknown) {
      showToast("Қате: " + (err as Error).message);
    }
  };

  const myField = currentRole === "raspil" ? "raspilDone" : "pvhDone";
  const pendingOrders = orders.filter((o) => {
    const items =
      currentRole === "pvh"
        ? o.items.filter((it) => needsPvh(it.material))
        : o.items;
    return items.some((it) => !it[myField]);
  });
  const pendingItems = orders.reduce((sum, o) => {
    const items =
      currentRole === "pvh"
        ? o.items.filter((it) => needsPvh(it.material))
        : o.items;
    return sum + items.filter((it) => !it[myField]).length;
  }, 0);
  const doneItems = orders.reduce((sum, o) => {
    const items =
      currentRole === "pvh"
        ? o.items.filter((it) => needsPvh(it.material))
        : o.items;
    return sum + items.filter((it) => it[myField]).length;
  }, 0);

  return (
    <>
      <div className="header">
        <div className="header-top">
          <div>
            <h1>
              {roleNames[currentRole]
                ? `${roleNames[currentRole]} панелі`
                : "🔧 Жұмыс панелі"}
            </h1>
            <p>Сәлем, {userData.name || "Жұмысшы"}</p>
          </div>
          <div>
            <span className="header-badge">
              {roleNames[currentRole] || currentRole}
            </span>
            <button
              className="btn-logout"
              onClick={handleLogout}
              style={{ marginLeft: 8 }}
            >
              Шығу ↗
            </button>
          </div>
        </div>
      </div>

      <div className="worker-stats-bar">
        <div className="worker-stat">
          <div className="worker-stat-number">{pendingOrders.length}</div>
          <div className="worker-stat-label">Клиент</div>
        </div>
        <div className="worker-stat">
          <div className="worker-stat-number">{pendingItems}</div>
          <div className="worker-stat-label">Лист күтуде</div>
        </div>
        <div className="worker-stat accent">
          <div className="worker-stat-number">{doneItems}</div>
          <div className="worker-stat-label">Дайын ✅</div>
        </div>
      </div>

      <WorkerOrderList
        orders={orders}
        loading={ordersLoading}
        currentRole={currentRole}
        onToggle={handleToggle}
      />

      <Toast message={message} visible={visible} />

      <nav className="bottom-nav">
        <Link to="/worker" className="bottom-nav-item active">
          <span className="bottom-nav-icon">🔧</span>
          <span className="bottom-nav-label">Заказ</span>
        </Link>
        <Link to="/track" className="bottom-nav-item">
          <span className="bottom-nav-icon">📍</span>
          <span className="bottom-nav-label">Бақылау</span>
        </Link>
      </nav>
    </>
  );
}

function WorkerOrderList({
  orders,
  loading,
  currentRole,
  onToggle,
}: {
  orders: Order[];
  loading: boolean;
  currentRole: string;
  onToggle: (order: Order, itemIndex: number) => void;
}) {
  const [compact, setCompact] = useState(false);

  const visibleOrders =
    currentRole === "pvh"
      ? orders.filter((o) => o.items.some((it) => needsPvh(it.material)))
      : orders;

  return (
    <div className="orders-section" style={{ paddingBottom: 80 }}>
      <div className="section-title-row">
        <div className="section-title" style={{ marginBottom: 0 }}>
          Сіздің заказдарыңыз
        </div>
        <button
          className={`view-toggle${compact ? " active" : ""}`}
          onClick={() => setCompact((v) => !v)}
          title={compact ? "Толық көрініс" : "Ықшам көрініс"}
        >
          {compact ? "📋 Толық" : "☑️ Ықшам"}
        </button>
      </div>
      <div>
        {loading ? (
          <Spinner />
        ) : orders.length === 0 ? (
          <div className="empty-state">
            <div className="icon">📭</div>
            <p>Заказдар жоқ</p>
          </div>
        ) : compact ? (
          <div className="compact-list">
            {visibleOrders.map((order, idx) => (
              <CompactOrderRow
                key={order.id}
                order={order}
                num={idx + 1}
                currentRole={currentRole}
                onToggle={onToggle}
              />
            ))}
          </div>
        ) : (
          visibleOrders.map((order, idx) => (
            <WorkerOrderCard
              key={order.id}
              order={order}
              num={idx + 1}
              currentRole={currentRole}
              onToggle={onToggle}
            />
          ))
        )}
      </div>
    </div>
  );
}

function CompactOrderRow({
  order,
  num,
  currentRole,
  onToggle,
}: {
  order: Order;
  num: number;
  currentRole: string;
  onToggle: (order: Order, itemIndex: number) => void;
}) {
  const isDone = order.raspilDone && order.pvhDone;
  const myField = currentRole === "raspil" ? "raspilDone" : "pvhDone";

  return (
    <div className={`compact-order-group${isDone ? " done" : ""}`}>
      <div className="compact-order-header">
        <span className="compact-order-num">{num}.</span>
        <span className="compact-order-name">{order.clientName}</span>
        <span
          className={`compact-order-status ${isDone ? "status-done" : order.items.some((it) => it[myField]) ? "status-progress" : "status-queue"}`}
        >
          {isDone ? "✅" : order.items.every((it) => it[myField]) ? "✓" : "⏳"}
        </span>
      </div>
      {order.items.map((item, i) => {
        const myDone = item[myField];
        const hasPvh = needsPvh(item.material);
        if (currentRole === "pvh" && !hasPvh) return null;
        return (
          <div
            key={i}
            className={`compact-order-row${myDone ? " checked" : ""}`}
            onClick={() => onToggle(order, i)}
          >
            <div className={`toggle-switch${myDone ? " on" : ""}`}>
              <div className="toggle-knob" />
            </div>
            <span className="compact-order-desc">
              {item.material && item.material !== "лдсп" && (
                <span className={`material-tag material-${item.material}`}>
                  {item.material.toUpperCase()}{" "}
                </span>
              )}
              {item.description}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function WorkerOrderCard({
  order,
  num,
  currentRole,
  onToggle,
}: {
  order: Order;
  num: number;
  currentRole: string;
  onToggle: (order: Order, itemIndex: number) => void;
}) {
  const isDone = order.raspilDone && order.pvhDone;

  return (
    <div className={`worker-card${isDone ? " done" : ""}`}>
      <div className="worker-card-top">
        <span className="order-number">{num}.</span>
        <span className="worker-card-client">{order.clientName}</span>
        <span
          className={`order-status ${isDone ? "status-done" : "status-queue"}`}
        >
          {isDone ? "✅" : "⏳"}
        </span>
      </div>
      <div className="worker-card-items">
        {order.items.map((item, i) => {
          if (currentRole === "pvh" && !needsPvh(item.material)) return null;
          return (
            <WorkerItemRow
              key={i}
              item={item}
              currentRole={currentRole}
              onToggle={() => onToggle(order, i)}
            />
          );
        })}
      </div>
    </div>
  );
}

function WorkerItemRow({
  item,
  currentRole,
  onToggle,
}: {
  item: OrderItem;
  currentRole: string;
  onToggle: () => void;
}) {
  const myDone = currentRole === "raspil" ? item.raspilDone : item.pvhDone;
  const hasPvh = needsPvh(item.material);
  const itemDone = item.raspilDone && (hasPvh ? item.pvhDone : true);

  return (
    <div
      className={`worker-item-row${itemDone ? " done" : ""}`}
      onClick={onToggle}
    >
      <div className={`toggle-switch${myDone ? " on" : ""}`}>
        <div className="toggle-knob" />
      </div>
      <span className="worker-item-desc">
        {item.material && item.material !== "лдсп" && (
          <span className={`material-tag material-${item.material}`}>
            {item.material.toUpperCase()}{" "}
          </span>
        )}
        {item.description}
      </span>
      <div className="item-roadmap">
        <div className={`roadmap-step${item.raspilDone ? " completed" : ""}`}>
          <div className="roadmap-dot">🪚</div>
          <div className="roadmap-label">Распил</div>
        </div>
        {hasPvh && (
          <>
            <div
              className={`roadmap-line${item.raspilDone ? " completed" : ""}`}
            />
            <div className={`roadmap-step${item.pvhDone ? " completed" : ""}`}>
              <div className="roadmap-dot">🪟</div>
              <div className="roadmap-label">ПВХ</div>
            </div>
          </>
        )}
        <div className={`roadmap-line${itemDone ? " completed" : ""}`} />
        <div className={`roadmap-step${itemDone ? " completed" : ""}`}>
          <div className="roadmap-dot">{itemDone ? "✅" : "🏁"}</div>
          <div className="roadmap-label">Дайын</div>
        </div>
      </div>
    </div>
  );
}
