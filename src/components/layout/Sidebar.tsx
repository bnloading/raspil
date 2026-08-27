import { Fragment } from "react";
import { Link } from "react-router-dom";
import type { NavItem } from "./navConfig";
import { IconMenu } from "./icons";

interface SidebarProps {
  items: NavItem[];
  activeKey: string | undefined;
  collapsed: boolean;
  onToggleCollapse: () => void;
}

const GROUPS: Array<{ key: "main" | "secondary"; label: string }> = [
  { key: "main", label: "Негізгі" },
  { key: "secondary", label: "Қосымша" },
];

export function Sidebar({ items, activeKey, collapsed, onToggleCollapse }: SidebarProps) {
  return (
    <aside className="app-sidebar">
      <div className="sidebar-brand">
        <span className="sidebar-brand-mark">M</span>
        <span>Modera</span>
      </div>
      <nav className="sidebar-groups">
        {GROUPS.map((group) => {
          const groupItems = items.filter((item) => (item.group ?? "main") === group.key);
          if (groupItems.length === 0) return null;
          return (
            <Fragment key={group.key}>
              <div className="sidebar-group-label">{group.label}</div>
              {groupItems.map((item) => {
                const Icon = item.icon;
                return (
                  <Link
                    key={item.key}
                    to={item.path}
                    className={`sidebar-item${item.key === activeKey ? " active" : ""}`}
                  >
                    <Icon />
                    <span>{item.label}</span>
                  </Link>
                );
              })}
            </Fragment>
          );
        })}
      </nav>
      <div className="sidebar-footer">
        <button
          type="button"
          className="sidebar-item"
          onClick={onToggleCollapse}
          aria-label={collapsed ? "Мәзірді жаю" : "Мәзірді тарылту"}
        >
          <IconMenu />
          <span>{collapsed ? "Жаю" : "Тарылту"}</span>
        </button>
      </div>
    </aside>
  );
}
