import { useState } from "react";
import { doc, updateDoc } from "firebase/firestore";
import { db } from "../firebase";
import { useAuth } from "../AuthContext";
import { useNotifications } from "../hooks/useNotifications";
import { formatDateTimeDMY } from "../lib/dates";

export function NotificationBell() {
  const { user } = useAuth();
  const { notifications, unreadCount } = useNotifications(user?.uid);
  const [open, setOpen] = useState(false);

  const markRead = async (id: string) => {
    try {
      await updateDoc(doc(db, "notifications", id), { read: true });
    } catch {
      // best-effort — a stale unread badge isn't worth surfacing an error toast for
    }
  };

  return (
    <div className="notification-bell-wrap">
      <button
        type="button"
        className="header-icon-btn"
        aria-label="Хабарламалар"
        onClick={() => setOpen((v) => !v)}
      >
        {/* Every attribute spelled out, for the reason layout/icons.tsx documents: an inline
            <svg> with a viewBox but no width/height falls back to the UA default of 300x150 css
            px unless CSS happens to constrain it — and the only .header-icon-btn rules in the
            stylesheet are scoped to .figma-track-page, which the app shell is not. Unstyled, the
            bell was a 300px-wide unstroked shape, so all anyone saw was its badge. */}
        <svg
          viewBox="0 0 24 24"
          width="20"
          height="20"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
          <path d="M10 21h4" />
        </svg>
        {unreadCount > 0 && <span className="notification-badge">{unreadCount > 9 ? "9+" : unreadCount}</span>}
      </button>
      {open && (
        <>
          <div className="notification-backdrop" onClick={() => setOpen(false)} />
          <div className="notification-dropdown">
            <div className="notification-dropdown-title">Хабарламалар</div>
            {notifications.length === 0 ? (
              <p className="notification-empty">Хабарлама жоқ</p>
            ) : (
              notifications.map((n) => (
                <div
                  key={n.id}
                  className={`notification-row${n.read ? "" : " unread"}`}
                  onClick={() => !n.read && markRead(n.id)}
                >
                  <strong>{n.title}</strong>
                  <span>{n.body}</span>
                  <small>{n.createdAt ? formatDateTimeDMY(n.createdAt) : ""}</small>
                </div>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}
