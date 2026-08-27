import { useEffect, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { useAuth } from "../../AuthContext";
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

  const items = getNavForRole(userData?.role);
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
