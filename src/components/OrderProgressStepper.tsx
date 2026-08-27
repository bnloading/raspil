import { PRODUCTION_STATUS_ORDER } from "../lib/statuses";
import type { Order, ProductionStatus } from "../types/domain";

const STATUS_INDEX: Record<ProductionStatus, number> = Object.fromEntries(
  PRODUCTION_STATUS_ORDER.map((s, i) => [s, i]),
) as Record<ProductionStatus, number>;

interface Stage {
  key: string;
  label: string;
  /** The stage counts as done once the order has moved strictly past this status (the last stage
   *  is the one exception — see isLast below — since there's nothing "after" it to prove by). */
  completionStatus: ProductionStatus;
}

const BASE_STAGES: Stage[] = [
  { key: "accepted", label: "Қабылданды", completionStatus: "manager_review" },
  { key: "paid", label: "Төленді", completionStatus: "paid" },
  { key: "queued", label: "Кезекте", completionStatus: "cutting_queue" },
  { key: "cutting", label: "Распил", completionStatus: "cutting_completed" },
];
const PVC_STAGE: Stage = { key: "pvc", label: "ПВХ", completionStatus: "pvc_completed" };
const READY_STAGE: Stage = { key: "ready", label: "Дайын", completionStatus: "ready" };

type StageState = "done" | "active" | "pending";

/**
 * The customer-facing "Заказдың жолы" horizontal stepper: Қабылданды → Төленді → Кезекте →
 * Распил → (ПВХ, only if the order needs it) → Дайын, each shown done/active/pending. Not shown
 * for cancelled orders (there's no meaningful "progress" through a cancelled path).
 */
export function OrderProgressStepper({ order }: { order: Order }) {
  if (order.productionStatus === "cancelled") return null;

  const needsPvc = order.pvcMetersTotal > 0;
  const stages = needsPvc ? [...BASE_STAGES, PVC_STAGE, READY_STAGE] : [...BASE_STAGES, READY_STAGE];
  const curIdx = STATUS_INDEX[order.productionStatus];

  const states: StageState[] = stages.map((stage, i) => {
    const isLast = i === stages.length - 1;
    const completionIdx = STATUS_INDEX[stage.completionStatus];
    const done = isLast ? curIdx >= completionIdx : curIdx > completionIdx;
    return done ? "done" : "pending"; // "active" is assigned below, to the first non-done stage only
  });
  const firstPendingIdx = states.indexOf("pending");
  if (firstPendingIdx !== -1) states[firstPendingIdx] = "active";

  return (
    <div className="order-stepper">
      {stages.map((stage, i) => (
        <div key={stage.key} className="order-stepper-step">
          <div className="order-stepper-node-row">
            <span
              className={`order-stepper-line ${i === 0 ? "is-invisible" : states[i - 1] === "done" ? "is-done" : ""}`}
            />
            <span className={`order-stepper-dot is-${states[i]}`}>{states[i] === "done" ? "✓" : i + 1}</span>
            <span
              className={`order-stepper-line ${
                i === stages.length - 1 ? "is-invisible" : states[i] === "done" ? "is-done" : ""
              }`}
            />
          </div>
          <span className={`order-stepper-label is-${states[i]}`}>{stage.label}</span>
        </div>
      ))}
    </div>
  );
}
