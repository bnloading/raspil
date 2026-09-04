import type { Department, MdfStage, Order, PaymentMethodDef, UserDoc, UserRole } from "../types/domain";

/**
 * UI-side convenience helpers only — the real enforcement is firestore.rules. These exist so
 * pages don't hand-roll role checks and drift from what the rules actually allow.
 */
export const isAdmin = (role?: UserRole) => role === "admin";
export const isManager = (role?: UserRole) => role === "manager";
export const isAdminOrManager = (role?: UserRole) => role === "admin" || role === "manager";
export const isCutter = (role?: UserRole) => role === "raspil";
export const isPvcWorker = (role?: UserRole) => role === "pvh";
export const isCnc = (role?: UserRole) => role === "cnc";
export const isSanding = (role?: UserRole) => role === "sanding";
export const isPainting = (role?: UserRole) => role === "painting";
export const isVacuum = (role?: UserRole) => role === "vacuum";
export const isCustomer = (role?: UserRole) => role === "customer";
const STAFF_ROLES: UserRole[] = ["admin", "manager", "raspil", "pvh", "cnc", "sanding", "painting", "vacuum"];
export const isStaff = (role?: UserRole) => !!role && STAFF_ROLES.includes(role);

/**
 * The production line a user belongs to — ЛДСП (распил/ПВХ) vs МДФ (ЧПУ/шкурка/краска/вакуум),
 * now run as separate businesses (separate journal, queues and касса) inside one app.
 *
 * A worker role already implies its line and can never be reassigned to the other one (raspil/pvh
 * are always ldsp, the four МДФ stages are always mdf). Only admin/manager carry an explicit
 * `department` field, since either can plausibly run either line; absent means "ldsp" so every
 * account that existed before the МДФ team got its own department keeps working exactly as it did.
 */
export function departmentOf(userData: Pick<UserDoc, "role" | "department">): Department {
  if (userData.role === "raspil" || userData.role === "pvh") return "ldsp";
  if (
    userData.role === "cnc" ||
    userData.role === "sanding" ||
    userData.role === "painting" ||
    userData.role === "vacuum"
  ) {
    return "mdf";
  }
  return userData.department ?? "ldsp";
}

export const DEPARTMENT_LABELS: Record<Department, string> = {
  ldsp: "ЛДСП",
  mdf: "МДФ",
};

/** Which line an order belongs to — "mdf_wrap" is МДФ, everything else (including the historical
 *  absence of the field) is ЛДСП, the same default `Order.orderKind` itself already uses. */
export function departmentOfOrder(order: Pick<Order, "orderKind">): Department {
  return order.orderKind === "mdf_wrap" ? "mdf" : "ldsp";
}

/** Whether a payment method's button/option should appear on one line's journal/cashbox — unset
 *  `department` means shared (e.g. "Нал / Қолма-қол"), otherwise it must match exactly. */
export function methodVisibleTo(method: Pick<PaymentMethodDef, "department">, department: Department): boolean {
  return method.department === undefined || method.department === department;
}

// Admin-only: user/role management, materials/prices/payment-methods CRUD, system settings,
// audit-history retention. Manager explicitly must NOT be able to do any of these (spec).
export const canManageUsers = isAdmin;
export const canManageWarehouse = isAdmin;
export const canManagePrices = isAdmin;
export const canManagePaymentMethods = isAdmin;
export const canAccessSettings = isAdmin;
export const canOverridePaymentGate = isAdmin; // admin-only, requires reason + audit entry (see lib/orderStatus.ts)
// Reading the audit trail is Admin-only per spec ("View audit history" is listed only under
// Admin), and firestore.rules enforces exactly that — Manager may WRITE entries for its own
// actions but can never browse the log, and nobody can delete it.
export const canViewAuditLog = isAdmin;
// Reversal always writes a reason and an audit entry. Manager may reverse too: the journal's
// Статус column lets a row be moved back to "Қарыз" at any time, and the money has to follow the
// status — a payment can only ever be marked reversed, never un-reversed or edited.
export const canReversePayment = isAdminOrManager;
export const canAdjustDebt = isAdmin; // debt corrections create an adjustment record, never edit history
export const canManageAttendance = isAdmin;
export const canConfigureSalary = isAdmin;
export const canViewAllSalaries = isAdmin;

// Admin + Manager: the day-to-day order-processing powers the spec grants the Manager, which
// Admin can always also do ("Perform every Manager action").
export const canCreateOrders = isAdminOrManager; // Manager registers walk-in orders in the journal
export const canReviewOrders = isAdminOrManager;
export const canCalculatePrice = isAdminOrManager;
export const canPublishPrice = isAdminOrManager;
export const canManagePayments = isAdminOrManager;
export const canAssignWorkers = isAdminOrManager;
export const canSetQueuePriority = isAdminOrManager;
export const canExportOrders = isAdminOrManager;
export const canMarkDelivered = isAdminOrManager;
export const canViewDebtLedger = isAdminOrManager;
export const canGenerateInvoice = isAdminOrManager;
export const canRegisterLeftover = (role?: UserRole) => isAdmin(role) || isCutter(role);

/** Everyone sees their own salary page; only Admin sees anyone else's. */
export const canViewSalaryOf = (viewerRole: UserRole | undefined, viewerUid: string, targetUid: string) =>
  isAdmin(viewerRole) || viewerUid === targetUid;

export function roleHome(role?: UserRole): string {
  switch (role) {
    case "admin":
      return "/admin";
    case "manager":
      return "/manager";
    case "raspil":
      return "/cutting";
    case "pvh":
      return "/pvc";
    case "cnc":
      return "/cnc";
    case "sanding":
      return "/sanding";
    case "painting":
      return "/painting";
    case "vacuum":
      return "/vacuum";
    case "customer":
      return "/dashboard";
    default:
      return "/login";
  }
}

export const ROLE_LABELS: Record<UserRole, string> = {
  admin: "Админ",
  manager: "Менеджер",
  raspil: "Распилшик",
  pvh: "ПВХ жабыстырушы",
  cnc: "ЧПУ операторы",
  sanding: "Шкуркалаушы",
  painting: "Бояушы",
  vacuum: "Вакуумшы",
  customer: "Клиент",
};

/** Which МДФ station a worker role sees, for the shared MdfWorkerDashboard/ProductionOrderDetail
 *  action-panel dispatch — undefined for every non-МДФ role. */
export const ROLE_TO_MDF_STAGE: Partial<Record<UserRole, MdfStage>> = {
  cnc: "cnc",
  sanding: "sanding",
  painting: "painting",
  vacuum: "vacuum",
};
