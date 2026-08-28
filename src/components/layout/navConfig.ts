import type { ReactElement } from "react";
import type { UserRole } from "../../types/domain";
import {
  IconHome,
  IconTrophy,
  IconLayers,
  IconCamera,
  IconOrders,
  IconWarehouse,
  IconReports,
  IconUsers,
  IconAudit,
  IconCut,
  IconPvc,
  IconPlus,
} from "./icons";

export interface NavItem {
  key: string;
  label: string;
  path: string;
  // Spec calls for `JSX.Element` here; using ReactElement avoids relying on the ambient
  // `JSX` namespace (which @types/react 19 no longer guarantees globally) — same shape.
  icon: (props: { className?: string }) => ReactElement;
  group?: "main" | "secondary";
  mobile?: boolean; // included in the mobile bottom nav (max 6; see BottomNav)
  /**
   * One-word label for the phone bottom bar, where every item now shows its name and six of them
   * share ~300px. Falls back to `label`, which is fine when it is already short.
   */
  short?: string;
}

function adminNav(): NavItem[] {
  return [
    { key: "admin-home", label: "Басты бет", short: "Басты", path: "/admin", icon: IconHome, group: "main", mobile: true },
    { key: "admin-orders", label: "Заказдар", short: "Заказ", path: "/admin/orders", icon: IconOrders, group: "main", mobile: true },
    { key: "admin-oversight-manager", label: "Менеджер", path: "/admin/oversight/manager", icon: IconUsers, group: "main" },
    { key: "admin-oversight-cutting", label: "Распил", path: "/admin/oversight/cutting", icon: IconCut, group: "main" },
    { key: "admin-oversight-pvc", label: "ПВХ", path: "/admin/oversight/pvc", icon: IconPvc, group: "main" },
    { key: "admin-materials", label: "Қойма", short: "Қойма", path: "/admin/materials", icon: IconWarehouse, group: "main", mobile: true },
    { key: "admin-payments", label: "Төлемдер", path: "/admin/reports", icon: IconReports, group: "main" },
    { key: "admin-reports", label: "Есептер", short: "Есеп", path: "/admin/reports", icon: IconReports, group: "main", mobile: true },
    // On the phone bottom bar: an owner checking in from outside the shop wants the debt ledger
    // more than anything below it in this list.
    { key: "admin-debt", label: "Қарыз", short: "Қарыз", path: "/manager/debt", icon: IconReports, group: "main", mobile: true },
    { key: "admin-customers", label: "Клиенттер", path: "/setup", icon: IconUsers, group: "main" },
    { key: "admin-staff", label: "Қызметкерлер", path: "/setup", icon: IconUsers, group: "main" },
    { key: "admin-attendance", label: "Жұмысқа қатысу", path: "/admin/attendance", icon: IconAudit, group: "main" },
    { key: "admin-salary", label: "Айлық", path: "/admin/salary", icon: IconReports, group: "main" },
    { key: "admin-settings", label: "Баптаулар", path: "/admin/csv-settings", icon: IconAudit, group: "main" },
    { key: "admin-camera", label: "Камера", short: "Камера", path: "/camera", icon: IconCamera, group: "main", mobile: true },
    { key: "leaderboard", label: "Рейтинг", path: "/leaderboard", icon: IconTrophy, group: "secondary" },
    { key: "assortment", label: "Листтар", short: "Лист", path: "/assortment", icon: IconLayers, group: "secondary" },
    { key: "audit-log", label: "Аудит журналы", path: "/admin/audit-log", icon: IconAudit, group: "secondary" },
  ];
}

function managerNav(): NavItem[] {
  return [
    { key: "manager-home", label: "Басты бет", short: "Басты", path: "/manager", icon: IconHome, group: "main", mobile: true },
    { key: "manager-journal", label: "Тапсырыс журналы", short: "Журнал", path: "/manager/journal", icon: IconOrders, group: "main", mobile: true },
    { key: "manager-payments", label: "Төлемдер", short: "Төлем", path: "/manager/payments", icon: IconReports, group: "main", mobile: true },
    { key: "manager-debt", label: "Қарыз", path: "/manager/debt", icon: IconReports, group: "main" },
    { key: "manager-cutting", label: "Распил кезегі", short: "Распил", path: "/manager/cutting", icon: IconCut, group: "main", mobile: true },
    { key: "manager-pvc", label: "ПВХ кезегі", path: "/manager/pvc", icon: IconPvc, group: "main" },
    { key: "manager-ready", label: "Дайын", path: "/manager/ready", icon: IconWarehouse, group: "main" },
    { key: "manager-new", label: "Жаңа заказдар", path: "/manager/new", icon: IconPlus, group: "secondary" },
    { key: "manager-orders", label: "Заказдар (карта)", path: "/manager/orders", icon: IconOrders, group: "secondary" },
    { key: "manager-customers", label: "Клиенттер", path: "/setup", icon: IconUsers, group: "secondary" },
    { key: "manager-reports", label: "Есептер", path: "/admin/reports", icon: IconReports, group: "secondary" },
    { key: "assortment", label: "Листтар", short: "Лист", path: "/assortment", icon: IconLayers, group: "secondary" },
    { key: "camera", label: "Камера", path: "/camera", icon: IconCamera, group: "secondary" },
  ];
}

function customerNav(): NavItem[] {
  return [
    { key: "customer-home", label: "Басты бет", short: "Басты", path: "/dashboard", icon: IconHome, group: "main", mobile: true },
    { key: "customer-orders", label: "Заказдарым", short: "Заказ", path: "/orders", icon: IconOrders, group: "main", mobile: true },
    { key: "customer-debt", label: "Қарыз", path: "/debt", icon: IconReports, group: "main" },
    { key: "assortment", label: "Листтар", short: "Лист", path: "/assortment", icon: IconLayers, group: "main", mobile: true },
    { key: "customer-profile", label: "Профиль", short: "Профиль", path: "/profile", icon: IconUsers, group: "main", mobile: true },
    { key: "camera", label: "Камера", path: "/camera", icon: IconCamera, group: "secondary" },
  ];
}

function cutterNav(): NavItem[] {
  return [
    { key: "cutting-home", label: "Кезек", short: "Кезек", path: "/cutting", icon: IconCut, group: "main", mobile: true },
    { key: "salary", label: "Айлығым", short: "Айлық", path: "/salary", icon: IconReports, group: "main", mobile: true },
    { key: "attendance", label: "Қатысуым", short: "Қатысу", path: "/my-attendance", icon: IconAudit, group: "main", mobile: true },
    { key: "assortment", label: "Листтар", short: "Лист", path: "/assortment", icon: IconLayers, group: "secondary" },
    { key: "camera", label: "Камера", path: "/camera", icon: IconCamera, group: "secondary" },
  ];
}

function pvcNav(): NavItem[] {
  return [
    { key: "pvc-home", label: "ПВХ кезегі", short: "ПВХ", path: "/pvc", icon: IconPvc, group: "main", mobile: true },
    { key: "salary", label: "Айлығым", short: "Айлық", path: "/salary", icon: IconReports, group: "main", mobile: true },
    { key: "attendance", label: "Қатысуым", short: "Қатысу", path: "/my-attendance", icon: IconAudit, group: "main", mobile: true },
    { key: "assortment", label: "Листтар", short: "Лист", path: "/assortment", icon: IconLayers, group: "secondary" },
    { key: "camera", label: "Камера", path: "/camera", icon: IconCamera, group: "secondary" },
  ];
}

function publicNav(): NavItem[] {
  return [
    { key: "assortment", label: "Листтар", short: "Лист", path: "/assortment", icon: IconLayers, group: "main", mobile: true },
    { key: "camera", label: "Камера", path: "/camera", icon: IconCamera, group: "main", mobile: true },
  ];
}

export function getNavForRole(role: UserRole | undefined): NavItem[] {
  switch (role) {
    case "admin":
      return adminNav();
    case "manager":
      return managerNav();
    case "customer":
      return customerNav();
    case "raspil":
      return cutterNav();
    case "pvh":
      return pvcNav();
    default:
      return publicNav();
  }
}

/**
 * Longest-prefix match on `path` so a detail route like `/admin/order/123` highlights the
 * `/admin` nav entry, while `/admin/materials` highlights its own (longer, more specific) entry.
 */
export function matchNavKey(pathname: string, search: string, items: NavItem[]): string | undefined {
  void search; // not currently needed for matching, kept for API symmetry with useLocation()
  let bestKey: string | undefined;
  let bestLen = -1;
  for (const item of items) {
    const path = item.path;
    const isMatch =
      pathname === path || (pathname.startsWith(path) && (path === "/" || pathname[path.length] === "/"));
    if (isMatch && path.length > bestLen) {
      bestLen = path.length;
      bestKey = item.key;
    }
  }
  return bestKey;
}
