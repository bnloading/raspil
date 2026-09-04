import { IconCut, IconLayers, IconOrders, IconPvc, IconWarehouse } from "./layout/icons";
import type { StepKey } from "../lib/orderProgress";
import type { WorkshopBoardStage } from "../types/domain";

/**
 * The picture that goes with each stage of an order.
 *
 * The words already say it — these sit beside a written label, never instead of one — but a
 * customer glancing at a phone in a workshop recognises a saw faster than they read "Распил", and
 * the strip becomes something scanned rather than something read four times over.
 *
 * Two maps rather than one because the two strips do not start at the same place: an order's own
 * progress opens at Төлем, the public board opens at Кезек (the board carries no payment data).
 */
const BY_STEP: Record<StepKey, typeof IconCut> = {
  payment: IconOrders,
  cutting: IconCut,
  pvc: IconPvc,
  mdf: IconLayers,
  ready: IconWarehouse,
};

const BY_STAGE: Record<WorkshopBoardStage, typeof IconCut> = {
  queue: IconOrders,
  cutting: IconCut,
  pvc_wait: IconPvc,
  pvc: IconPvc,
  mdf: IconLayers,
  ready: IconWarehouse,
};

export function StepIcon({ step, className }: { step: StepKey; className?: string }) {
  const Icon = BY_STEP[step];
  return <Icon className={className} />;
}

export function StageIcon({ stage, className }: { stage: WorkshopBoardStage; className?: string }) {
  const Icon = BY_STAGE[stage];
  return <Icon className={className} />;
}
