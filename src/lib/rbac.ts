import type { UserRole } from "../types/domain";

/**
 * UI-side convenience helpers only — the real enforcement is firestore.rules. These exist so
 * pages don't hand-roll role checks and drift from what the rules actually allow.
 */
export const isAdmin = (role?: UserRole) => role === "admin";
export const isManager = (role?: UserRole) => role === "manager";
export const isAdminOrManager = (role?: UserRole) => role === "admin" || role === "manager";
export const isCutter = (role?: UserRole) => role === "raspil";
export const isPvcWorker = (role?: UserRole) => role === "pvh";
export const isCustomer = (role?: UserRole) => role === "customer";
export const isStaff = (role?: UserRole) => role === "admin" || role === "manager" || role === "raspil" || role === "pvh";

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
export const canReversePayment = isAdmin; // reversal needs a reason + audit entry; Manager records, Admin corrects
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
  customer: "Клиент",
};
