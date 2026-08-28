import type { ProgressStep, StepState } from "./orderProgress";
import type { WorkshopBoardStage } from "../types/domain";

/**
 * The Кезек → Распил → ПВХ → Дайын strip for a row of the public "Цех жұмысы" board.
 *
 * Separate from lib/orderProgress.ts on purpose. That one starts at Төлем, which the board must
 * never show: WorkshopActivityEntry deliberately carries no payment or pricing data, so every
 * customer can watch the shop's progress without learning anything about anyone else's money.
 * The board's first milestone is the queue instead.
 */
export function boardProgress(stage: WorkshopBoardStage, needsPvc: boolean): ProgressStep[] {
  const past = (...stages: WorkshopBoardStage[]) => stages.includes(stage);

  const queue: StepState = past("queue") ? "active" : "done";

  const cutting: StepState =
    past("queue") ? "pending"
    : past("cutting") ? "active"
    : "done";

  const pvc: StepState =
    !needsPvc ? "skipped"
    : past("queue", "cutting") ? "pending"
    : past("pvc_wait", "pvc") ? "active"
    : "done";

  const ready: StepState = past("ready") ? "done" : "pending";

  return [
    { key: "payment", label: "Кезек", state: queue },
    { key: "cutting", label: "Распил", state: cutting },
    { key: "pvc", label: "ПВХ", state: pvc },
    { key: "ready", label: "Дайын", state: ready },
  ];
}

/** One line saying what is happening to this order right now. */
export function boardSummary(stage: WorkshopBoardStage, queuePosition: number): string {
  switch (stage) {
    case "queue":
      return `Кезекте · №${queuePosition + 1}`;
    case "cutting":
      return "Кесіліп жатыр";
    case "pvc_wait":
      return "ПВХ кезегінде";
    case "pvc":
      return "ПВХ жасалып жатыр";
    default:
      return "Дайын";
  }
}
