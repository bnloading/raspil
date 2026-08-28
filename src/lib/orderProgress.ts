import { PRODUCTION_STATUS_ORDER } from "./statuses";
import type { Order } from "../types/domain";

/**
 * The four-stage "Өндіріс барысы" strip: Төлем → Распил → ПВХ → Дайын.
 *
 * Collapses the 16-value ProductionStatus (plus the independent paymentStatus) into the four
 * milestones a person actually tracks, so one glance answers "where is this order stuck?".
 * Kept pure so the states are unit-tested rather than eyeballed in the UI.
 */

export type StepState =
  /** Finished. */
  | "done"
  /** Happening right now. */
  | "active"
  /** Blocking progress — an unpaid order cannot enter the cutting queue. */
  | "problem"
  /** Not reached yet. */
  | "pending"
  /** Not applicable to this order at all, e.g. PVC on an order with no edging. */
  | "skipped";

export type StepKey = "payment" | "cutting" | "pvc" | "ready";

export interface ProgressStep {
  key: StepKey;
  label: string;
  state: StepState;
}

const LABELS: Record<StepKey, string> = {
  payment: "Төлем",
  cutting: "Распил",
  pvc: "ПВХ",
  ready: "Дайын",
};

function rank(status: Order["productionStatus"]): number {
  return PRODUCTION_STATUS_ORDER.indexOf(status);
}

export function orderProgress(order: Order): ProgressStep[] {
  const s = order.productionStatus;
  const cancelled = s === "cancelled";
  // "cancelled" sorts last in PRODUCTION_STATUS_ORDER but is not "furthest along", so it must
  // never satisfy a reached() check.
  const reached = (milestone: Order["productionStatus"]) => !cancelled && rank(s) >= rank(milestone);

  const paid = order.paymentStatus === "paid" || order.paymentStatus === "overpaid";
  const partly = order.paymentStatus === "partial";

  const payment: StepState =
    cancelled ? "skipped"
    : paid ? "done"
    : partly ? "active"
    : "problem"; // unpaid is what actually blocks the queue, so it reads as a problem, not "pending"

  const cutting: StepState =
    cancelled ? "skipped"
    : reached("cutting_completed") ? "done"
    : s === "cutting_started" ? "active"
    : s === "cutting_queue" ? "active"
    : "pending";

  const hasPvc = order.pvcMetersTotal > 0;
  const pvc: StepState =
    cancelled ? "skipped"
    : !hasPvc ? "skipped"
    : reached("pvc_completed") ? "done"
    : s === "pvc_started" || s === "pvc_queue" ? "active"
    : "pending";

  const ready: StepState =
    cancelled ? "skipped"
    : s === "delivered" ? "done"
    : s === "ready" ? "done"
    : "pending";

  return [
    { key: "payment", label: LABELS.payment, state: payment },
    { key: "cutting", label: LABELS.cutting, state: cutting },
    { key: "pvc", label: LABELS.pvc, state: pvc },
    { key: "ready", label: LABELS.ready, state: ready },
  ];
}

/** Short "what is happening now" sentence, for the mobile card where the strip has no labels. */
export function progressSummary(order: Order): string {
  const steps = orderProgress(order);
  if (order.productionStatus === "cancelled") return "Бас тартылды";
  const problem = steps.find((s) => s.state === "problem");
  if (problem) return `${problem.label} күтілуде`;
  const active = steps.find((s) => s.state === "active");
  if (active) return `${active.label} орындалуда`;
  const lastDone = [...steps].reverse().find((s) => s.state === "done");
  return lastDone ? `${lastDone.label} аяқталды` : "Күтілуде";
}
