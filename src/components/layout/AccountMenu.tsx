import { useEffect, useState } from "react";
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

export function AccountMenu() {
  const { user, userData, logout } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  // Same open/close-on-outside-click shape as NotificationBell (a full-screen backdrop that
  // closes the dropdown on click), plus Escape-to-close.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

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
      {open && (
        <>
          <div className="notification-backdrop" onClick={() => setOpen(false)} />
          <div className="account-menu-dropdown" role="menu">
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
          </div>
        </>
      )}
    </div>
  );
}
