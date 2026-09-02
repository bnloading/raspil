import { Fragment } from "react";
import { Link } from "react-router-dom";
import type { NavItem } from "./navConfig";
import { IconMenu } from "./icons";
import moderaLogo from "../../assets/modera-logo-compact.png";
import moderaMark from "../../assets/modera-mark.png";

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
      {/* Two crops of one mark rather than a logo and an unrelated letter tile: the full
          lockup while there is room for it, and the KDA glyphs alone once the rail narrows to
          76px. CSS picks between them, so the collapse stays a pure style change. */}
      <div className="sidebar-brand">
        <img src={moderaLogo} alt="Modera" className="sidebar-brand-full" />
        <img src={moderaMark} alt="Modera" className="sidebar-brand-icon" />
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
