import type { PaymentStatus, ProductionStatus } from "../types/domain";

export const PRODUCTION_STATUS_LABELS: Record<ProductionStatus, string> = {
  draft: "Черновик",
  submitted: "Жіберілді",
  manager_review: "Менеджер тексеріп жатыр",
  price_calculated: "Бағасы есептелді",
  waiting_payment: "Төлем күтілуде",
  partially_paid: "Жартылай төленді",
  paid: "Төленді",
  cutting_queue: "Распил кезегінде",
  cutting_started: "Распил басталды",
  cutting_completed: "Распил аяқталды",
  pvc_queue: "ПВХ кезегінде",
  pvc_started: "ПВХ басталды",
  pvc_completed: "ПВХ аяқталды",
  ready: "Дайын",
  delivered: "Клиентке берілді",
  cancelled: "Бас тартылды",
};

export const PRODUCTION_STATUS_ORDER: ProductionStatus[] = [
  "draft",
  "submitted",
  "manager_review",
  "price_calculated",
  "waiting_payment",
  "partially_paid",
  "paid",
  "cutting_queue",
  "cutting_started",
  "cutting_completed",
  "pvc_queue",
  "pvc_started",
  "pvc_completed",
  "ready",
  "delivered",
  "cancelled",
];

export const PRODUCTION_STATUS_COLOR: Record<ProductionStatus, string> = {
  draft: "gray",
  submitted: "blue",
  manager_review: "blue",
  price_calculated: "blue",
  waiting_payment: "amber",
  partially_paid: "amber",
  paid: "green",
  cutting_queue: "amber",
  cutting_started: "amber",
  cutting_completed: "amber",
  pvc_queue: "amber",
  pvc_started: "amber",
  pvc_completed: "amber",
  ready: "green",
  delivered: "green",
  cancelled: "red",
};

/** Terminal statuses — nothing advances a production/payment workflow past these. */
export const TERMINAL_PRODUCTION_STATUSES: ProductionStatus[] = ["delivered", "cancelled"];

/** Statuses that existed before an order is even a real, priced order (never shown in staff queues). */
export const PRE_ORDER_STATUSES: ProductionStatus[] = ["draft"];

export const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  unpaid: "Төленбеді",
  partial: "Жартылай төленді",
  paid: "Төленді",
  overpaid: "Артық төленді",
  refunded: "Қайтарылды",
};

/**
 * Short forms for the journal's narrow Статус column, where the full labels above clip mid-word.
 * Everywhere with room keeps PAYMENT_STATUS_LABELS.
 */
export const PAYMENT_STATUS_SHORT: Record<PaymentStatus, string> = {
  unpaid: "Жоқ",
  partial: "Жартылай",
  paid: "Төленді",
  overpaid: "Артық",
  refunded: "Қайтар.",
};

export const PAYMENT_STATUS_COLOR: Record<PaymentStatus, string> = {
  unpaid: "red",
  partial: "amber",
  paid: "green",
  overpaid: "blue",
  refunded: "gray",
};

/** Payment status is always derived, never manually chosen — see spec "calculate payment status automatically." */
export function computePaymentStatus(totalTiyn: number, netPaidTiyn: number): PaymentStatus {
  if (netPaidTiyn <= 0) return "unpaid";
  if (netPaidTiyn < totalTiyn) return "partial";
  if (netPaidTiyn === totalTiyn) return "paid";
  return "overpaid";
}

/** Only a fully-paid (or admin-approved overpaid) order may enter the cutting queue — the one
 *  hard rule the whole strict workflow exists to enforce (see lib/orderStatus.ts enterCuttingQueue). */
export function canEnterCuttingQueue(paymentStatus: PaymentStatus): boolean {
  return paymentStatus === "paid" || paymentStatus === "overpaid";
}

/**
 * Valid forward transitions for the one-click "advance" actions shown to staff/manager. Admin
 * additionally has a manual override selector (any status, with a required reason) for corrections
 * — this list only drives the normal linear-workflow buttons.
 */
export function getNextProductionStatuses(
  current: ProductionStatus,
  needsPvc: boolean,
): ProductionStatus[] {
  switch (current) {
    case "draft":
      return ["submitted"];
    case "submitted":
      return ["manager_review"];
    case "manager_review":
      return ["price_calculated", "cancelled"];
    case "price_calculated":
      return ["waiting_payment"];
    case "waiting_payment":
      return ["partially_paid", "paid"];
    case "partially_paid":
      return ["paid"];
    case "paid":
      return ["cutting_queue"];
    case "cutting_queue":
      return ["cutting_started"];
    case "cutting_started":
      return ["cutting_completed"];
    case "cutting_completed":
      return needsPvc ? ["pvc_queue"] : ["ready"];
    case "pvc_queue":
      return ["pvc_started"];
    case "pvc_started":
      return ["pvc_completed"];
    case "pvc_completed":
      return ["ready"];
    case "ready":
      return ["delivered"];
    case "delivered":
      return [];
    case "cancelled":
      return [];
  }
}

export function isCancellable(status: ProductionStatus): boolean {
  return status === "draft" || status === "submitted" || status === "manager_review";
}
