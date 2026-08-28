import { Link } from "react-router-dom";
import type { NavItem } from "./navConfig";
import { IconPlus } from "./icons";

interface BottomNavProps {
  items: NavItem[];
  activeKey: string | undefined;
  fab?: { onClick?: () => void; to?: string; label?: string };
}

export function BottomNav({ items, activeKey, fab }: BottomNavProps) {
  // Six is what fits a 360px bar: each item has a 44px touch target and only the active one shows
  // its label. Beyond six they start to crowd, so the cap stays.
  const mobileItems = items.filter((item) => item.mobile).slice(0, 6);

  return (
    <>
      {fab &&
        (fab.to ? (
          <Link to={fab.to} className="track-fab" aria-label={fab.label ?? "Жаңа тапсырыс"}>
            <IconPlus />
          </Link>
        ) : (
          <button
            type="button"
            className="track-fab"
            onClick={fab.onClick}
            aria-label={fab.label ?? "Жаңа тапсырыс"}
          >
            <IconPlus />
          </button>
        ))}
      <nav className="bottom-nav" aria-label="Негізгі навигация">
        {mobileItems.map((item) => {
          const Icon = item.icon;
          const active = item.key === activeKey;
          return (
            <Link
              key={item.key}
              to={item.path}
              className={`bottom-nav-item${active ? " active" : ""}`}
              aria-label={item.label}
            >
              <span className="bottom-nav-icon">
                <Icon />
              </span>
              {active && <span className="bottom-nav-label">{item.label}</span>}
            </Link>
          );
        })}
      </nav>
    </>
  );
}
