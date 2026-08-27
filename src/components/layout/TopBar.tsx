import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../AuthContext";
import { NotificationBell } from "../NotificationBell";
import { AccountMenu } from "./AccountMenu";
import { IconArrowLeft, IconSearch } from "./icons";

interface TopBarProps {
  title: string;
  subtitle?: string;
  back?: string;
  search?: { value: string; onChange: (v: string) => void; placeholder?: string };
  actions?: ReactNode;
}

export function TopBar({ title, subtitle, back, search, actions }: TopBarProps) {
  const navigate = useNavigate();
  const { user } = useAuth();

  return (
    <header className="app-topbar">
      {back && (
        <button
          type="button"
          className="topbar-back"
          onClick={() => navigate(back)}
          aria-label="Артқа"
        >
          <IconArrowLeft />
        </button>
      )}
      <div className="topbar-titles">
        <span className="topbar-title">{title}</span>
        {subtitle && <span className="topbar-subtitle">{subtitle}</span>}
      </div>
      {search && (
        <div className="topbar-search">
          <div className="search-input-wrap">
            <span className="search-icon">
              <IconSearch />
            </span>
            <input
              type="text"
              className="search-input"
              placeholder={search.placeholder}
              value={search.value}
              onChange={(e) => search.onChange(e.target.value)}
            />
          </div>
        </div>
      )}
      <div className="topbar-actions">
        {user && <NotificationBell />}
        {actions}
        <AccountMenu />
      </div>
    </header>
  );
}
