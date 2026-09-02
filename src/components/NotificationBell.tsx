import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { doc, updateDoc } from "firebase/firestore";
import { db } from "../firebase";
import { useAuth } from "../AuthContext";
import { useNotifications } from "../hooks/useNotifications";
import { formatDateTimeDMY } from "../lib/dates";

/** Widest the panel is ever drawn, and the margin it keeps from the edge of a phone screen. */
const PANEL_WIDTH = 320;
const EDGE_GAP = 8;

export function NotificationBell() {
  const { user } = useAuth();
  const { notifications, unreadCount } = useNotifications(user?.uid);
  const [open, setOpen] = useState(false);
  const [box, setBox] = useState<{ top: number; left: number; width: number } | null>(null);

  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  /**
   * Where to draw the panel, in viewport coordinates.
   *
   * It used to be `position: absolute; right: 0` on the bell, so it hung 320px to the LEFT of the
   * icon. On a workshop phone, where the topbar wraps and the bell is nowhere near the right edge,
   * most of the panel was off the left of the screen. Now it is anchored to the bell and then
   * pushed back inside the viewport, so it is always fully on screen whatever the topbar does.
   */
  const measure = useCallback(() => {
    const el = buttonRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const width = Math.min(PANEL_WIDTH, window.innerWidth - EDGE_GAP * 2);
    const flushRight = r.right - width;
    const left = Math.min(Math.max(EDGE_GAP, flushRight), window.innerWidth - width - EDGE_GAP);
    setBox({ top: r.bottom + EDGE_GAP, left, width });
  }, []);

  useEffect(() => {
    if (!open) return;
    measure();

    // A click outside closes it. This replaces the full-screen backdrop element, which could not
    // work from in here: .app-topbar sets backdrop-filter, and that makes it the containing block
    // for its `position: fixed` descendants — so an `inset: 0` backdrop covered the topbar only,
    // and clicking anywhere on the page below did nothing.
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (buttonRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };

    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [open, measure]);

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
        ref={buttonRef}
        type="button"
        className="header-icon-btn"
        aria-label="Хабарламалар"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {/* Every attribute spelled out, for the reason layout/icons.tsx documents: an inline
            <svg> with a viewBox but no width/height falls back to the UA default of 300x150 css
            px unless CSS happens to constrain it. */}
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

      {/* Portalled to the body on purpose. Left inside the topbar, a `position: fixed` panel is
          positioned against the topbar rather than the window — backdrop-filter makes that
          element a containing block — and it is trapped in the topbar's stacking context too. */}
      {open && box && createPortal(
        <div
          ref={panelRef}
          className="notification-dropdown"
          role="dialog"
          aria-label="Хабарламалар"
          style={{ top: box.top, left: box.left, width: box.width }}
        >
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
        </div>,
        document.body,
      )}
    </div>
  );
}
