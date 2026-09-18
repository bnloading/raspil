import type { Order } from "../types/domain";
import { boardProgress } from "../lib/boardProgress";
import { boardStageFor } from "../lib/workshopActivity";
import { OrderProgressStepper } from "./OrderProgressStepper";

export function CustomerProductionProgress({ order }: { order: Order }) {
  const stage = order.productionStatus === "delivered" ? "ready" : boardStageFor(order);
  if (!stage) return <OrderProgressStepper order={order} />;
  const steps = boardProgress(stage, order.pvcMetersTotal > 0, order.orderKind);
  return <div className="customer-production-progress" aria-label="Тапсырыс барысы">{steps.map(step =>
    <div key={step.key} className={`production-step is-${step.state}`} aria-current={step.state === "active" ? "step" : undefined}>
      <span className="production-step-dot" aria-hidden="true">{step.state === "done" ? "✓" : step.state === "skipped" ? "−" : ""}</span>
      <span>{step.label}{step.state === "skipped" ? " жоқ" : ""}</span>
    </div>)}</div>;
}
