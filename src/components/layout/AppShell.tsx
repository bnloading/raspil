import { useEffect, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { useAuth } from "../../AuthContext";
import { departmentOf } from "../../lib/rbac";
import { getNavForRole, matchNavKey } from "./navConfig";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { BottomNav } from "./BottomNav";

interface AppShellProps {
  title: string;
  subtitle?: string;
  navKey?: string; // override auto-detected active nav key
  actions?: ReactNode; // e.g. a "+ Жаңа заказ" button, rendered in the top bar
  search?: { value: string; onChange: (v: string) => void; placeholder?: string };
  fab?: { onClick?: () => void; to?: string; label?: string };
  back?: string; // if set, shows a back button/link to this path
  /** default "wide" (capped at --content-max); "narrow" caps at 900px; "full" removes the cap
   *  entirely for full-bleed data views like the Manager order journal. */
  contentWidth?: "wide" | "narrow" | "full";
  /** Collapses the sidebar once when this page mounts, so a dense view (the Journal table) opens
   *  with the extra width already available. Purely a one-time nudge on the shared collapse state —
   *  the manual toggle keeps working exactly as before, on this page or any other, and a page that
   *  doesn't ask for this never touches the setting. */
  autoCollapse?: boolean;
  children: ReactNode;
}

const SIDEBAR_COLLAPSED_KEY = "sidebar-collapsed";

export function AppShell({
  title,
  subtitle,
  navKey,
  actions,
  search,
  fab,
  back,
  contentWidth = "wide",
  autoCollapse = false,
  children,
}: AppShellProps) {
  const { userData } = useAuth();
  const location = useLocation();

  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(collapsed));
    } catch {
      // best-effort — collapse state just won't persist across reloads
    }
  }, [collapsed]);

  // Runs once per mount only (empty deps) — a deliberate re-expand while already on this page must
  // stick, not get overridden back to collapsed by this same effect re-firing.
  useEffect(() => {
    if (autoCollapse) setCollapsed(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const items = getNavForRole(userData?.role, userData ? departmentOf(userData) : undefined);
  const activeKey = navKey ?? matchNavKey(location.pathname, location.search, items);

  return (
    <div className={`app-shell${collapsed ? " collapsed" : ""}`}>
      <Sidebar
        items={items}
        activeKey={activeKey}
        collapsed={collapsed}
        onToggleCollapse={() => setCollapsed((v) => !v)}
      />
      <div className="app-main">
        <TopBar title={title} subtitle={subtitle} back={back} search={search} actions={actions} />
        <main
          className={`app-content${contentWidth === "narrow" ? " narrow" : ""}${
            contentWidth === "full" ? " full" : ""
          }`}
        >
          {children}
        </main>
        <BottomNav items={items} activeKey={activeKey} fab={fab} />
      </div>
    </div>
  );
}
