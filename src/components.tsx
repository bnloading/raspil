import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "./AuthContext";
import type { Order, OrderItem } from "./hooks";
import { needsPvh } from "./hooks";

export function TrackBottomNav({
  onCreateOrder,
  active = "home",
}: {
  onCreateOrder?: () => void;
  active?: "home" | "leaderboard" | "assortment" | "settings";
}) {
  const { user, userData, logout } = useAuth();
  const navigate = useNavigate();
  const homePath =
    userData?.role === "admin"
      ? "/admin"
      : userData?.role === "raspil"
        ? "/cutting"
        : userData?.role === "pvh"
          ? "/pvc"
          : "/track";
  const settingsPath = user && userData?.role === "admin" ? "/setup" : "/login";
  const handleLogout = async () => {
    await logout();
    navigate("/login");
  };

  return (
    <>
      {userData?.role === "admin" &&
        (onCreateOrder ? (
          <button
            type="button"
            className="track-fab"
            onClick={onCreateOrder}
            aria-label="Жаңа тапсырыс"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 5v14" />
              <path d="M5 12h14" />
            </svg>
          </button>
        ) : (
          <Link to="/admin" className="track-fab" aria-label="Жаңа тапсырыс">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 5v14" />
              <path d="M5 12h14" />
            </svg>
          </Link>
        ))}
      <nav className="bottom-nav" aria-label="Негізгі навигация">
        <Link
          to={homePath}
          className={`bottom-nav-item${active === "home" ? " active" : ""}`}
          aria-label="Басты бет"
        >
          <span className="bottom-nav-icon">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="m4 10 8-7 8 7" />
              <path d="M6 9.5V21h12V9.5" />
            </svg>
          </span>
          {active === "home" && <span className="bottom-nav-label">Басты</span>}
        </Link>
        <Link
          to="/leaderboard"
          className={`bottom-nav-item${active === "leaderboard" ? " active" : ""}`}
          aria-label="Leaderboard"
        >
          <span className="bottom-nav-icon">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M8 21h8" />
              <path d="M12 17v4" />
              <path d="M7 4h10v4a5 5 0 0 1-10 0V4Z" />
              <path d="M5 6H3a4 4 0 0 0 4 4" />
              <path d="M19 6h2a4 4 0 0 1-4 4" />
            </svg>
          </span>
          {active === "leaderboard" && (
            <span className="bottom-nav-label">Leaderboard</span>
          )}
        </Link>
        <Link
          to="/assortment"
          className={`bottom-nav-item${active === "assortment" ? " active" : ""}`}
          aria-label="Листтар"
        >
          <span className="bottom-nav-icon">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="m12 3 8 4-8 4-8-4 8-4Z" />
              <path d="m4 12 8 4 8-4" />
              <path d="m4 17 8 4 8-4" />
            </svg>
          </span>
          {active === "assortment" && (
            <span className="bottom-nav-label">Листтар</span>
          )}
        </Link>
        <Link
          to={settingsPath}
          className={`bottom-nav-item${active === "settings" ? " active" : ""}`}
          aria-label="Баптау"
        >
          <span className="bottom-nav-icon">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.1 2.1-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V20h-5v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1-2.1-2.1.1-.1A1.7 1.7 0 0 0 4.7 15a1.7 1.7 0 0 0-1.5-1H3v-4h.2a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1 2.1-2.1.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.5V4h5v.2a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1 2.1 2.1-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.5 1h.2v4h-.2a1.7 1.7 0 0 0-1.5 1Z" />
            </svg>
          </span>
          {active === "settings" && (
            <span className="bottom-nav-label">Баптау</span>
          )}
        </Link>
        {user && (
          <button
            type="button"
            className="bottom-nav-item"
            onClick={handleLogout}
            aria-label="Шығу"
          >
            <span className="bottom-nav-icon">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <path d="M16 17l5-5-5-5" />
                <path d="M21 12H9" />
              </svg>
            </span>
          </button>
        )}
      </nav>
    </>
  );
}

export function Toast({
  message,
  visible,
}: {
  message: string;
  visible: boolean;
}) {
  return <div className={`toast${visible ? " show" : ""}`}>{message}</div>;
}

export function getStatus(order: Order) {
  if (order.raspilDone && order.pvhDone)
    return { text: "Дайын ✅", className: "status-done" };
  if (order.raspilDone || order.pvhDone)
    return { text: "Жұмыста 🔄", className: "status-progress" };
  return { text: "Кезекте ⏳", className: "status-queue" };
}

export function ItemProgressSteps({ item }: { item: OrderItem }) {
  const hasPvh = needsPvh(item.material);
  const isDone = item.raspilDone && (hasPvh ? item.pvhDone : true);
  return (
    <div className="item-progress">
      <span
        className={`item-step ${item.raspilDone ? "completed" : "pending"}`}
        title="Распил"
      >
        🪚{item.raspilDone ? "✓" : ""}
      </span>
      {hasPvh && (
        <span
          className={`item-step ${item.pvhDone ? "completed" : "pending"}`}
          title="ПВХ"
        >
          🪟{item.pvhDone ? "✓" : ""}
        </span>
      )}
      {isDone && <span className="item-step-done">✅</span>}
    </div>
  );
}

export function ProgressSteps({ order }: { order: Order }) {
  const isDone = order.raspilDone && order.pvhDone;
  return (
    <div className="progress-steps">
      <div
        className={`step ${order.raspilDone ? "completed" : !order.raspilDone && !order.pvhDone ? "active" : ""}`}
      >
        <div className="step-dot">{order.raspilDone ? "✓" : "1"}</div>
        <div className="step-label">Распил</div>
      </div>
      <div
        className={`step ${order.pvhDone ? "completed" : order.raspilDone && !order.pvhDone ? "active" : ""}`}
      >
        <div className="step-dot">{order.pvhDone ? "✓" : "2"}</div>
        <div className="step-label">ПВХ</div>
      </div>
      <div className={`step ${isDone ? "completed" : ""}`}>
        <div className="step-dot">{isDone ? "✓" : "3"}</div>
        <div className="step-label">Дайын</div>
      </div>
    </div>
  );
}

export function Spinner() {
  return (
    <div className="loading">
      <div className="spinner" />
      <p>Жүктелуде...</p>
    </div>
  );
}
