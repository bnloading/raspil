import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../../AuthContext";
import { ROLE_LABELS } from "../../lib/rbac";
import { IconChevronDown } from "./icons";

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

/** Widest the menu is drawn, and the margin it keeps from the edge of a phone screen. */
const MENU_WIDTH = 220;
const EDGE_GAP = 8;

export function AccountMenu() {
  const { user, userData, logout } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [box, setBox] = useState<{ top: number; left: number; width: number } | null>(null);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  /** Anchored to the avatar and then clamped inside the viewport — see NotificationBell. */
  const measure = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const width = Math.min(MENU_WIDTH, window.innerWidth - EDGE_GAP * 2);
    const left = Math.min(Math.max(EDGE_GAP, r.right - width), window.innerWidth - width - EDGE_GAP);
    setBox({ top: r.bottom + EDGE_GAP, left, width });
  }, []);

  useEffect(() => {
    if (!open) return;
    measure();

    // A document listener rather than the full-screen backdrop this used to render: .app-topbar
    // sets backdrop-filter, which makes it the containing block for `position: fixed` children,
    // so an `inset: 0` backdrop covered the topbar alone and a click on the page never closed it.
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
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

  if (!user || !userData) {
    return (
      <Link to="/login" className="account-menu-item">
        Кіру
      </Link>
    );
  }

  const handleLogout = async () => {
    await logout();
    navigate("/login");
  };

  return (
    <div className="account-menu">
      <button
        ref={triggerRef}
        type="button"
        className="account-menu-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Аккаунт мәзірі"
      >
        <span className="account-avatar">{initials(userData.name)}</span>
        <IconChevronDown />
      </button>
      {/* Portalled out of the topbar for the same reason as the notification panel: a fixed
          element inside a backdrop-filter ancestor is positioned against that ancestor. */}
      {open && box && createPortal(
        <div
          ref={menuRef}
          className="account-menu-dropdown"
          role="menu"
          style={{ top: box.top, left: box.left, width: box.width }}
        >
          <div className="account-menu-name">{userData.name}</div>
          <div className="account-menu-role">{ROLE_LABELS[userData.role]}</div>
          {userData.role === "customer" && (
            <Link to="/profile" className="account-menu-item" onClick={() => setOpen(false)} role="menuitem">
              Профиль
            </Link>
          )}
          <button
            type="button"
            className="account-menu-item danger"
            onClick={handleLogout}
            role="menuitem"
          >
            Шығу
          </button>
        </div>,
        document.body,
      )}
    </div>
  );
}
