import type { ProgressStep, StepState } from "./orderProgress";
import type { WorkshopBoardStage, WorkshopActivityEntry } from "../types/domain";

/**
 * The Кезек → Распил → ПВХ → Дайын strip for a row of the public "Цех жұмысы" board.
 *
 * Separate from lib/orderProgress.ts on purpose. That one starts at Төлем, which the board must
 * never show: WorkshopActivityEntry deliberately carries no payment or pricing data, so every
 * customer can watch the shop's progress without learning anything about anyone else's money.
 * The board's first milestone is the queue instead.
 */
export function boardProgress(
  stage: WorkshopBoardStage,
  needsPvc: boolean,
  orderKind?: "cutting" | "mdf_wrap",
): ProgressStep[] {
  // МДФ orders never pass through cutting/pvc at all — same 3-milestone collapse
  // lib/orderProgress.ts's mdf branch uses for the order's own (non-public) progress strip.
  if (orderKind === "mdf_wrap") {
    const isReady = stage === "ready";
    return [
      { key: "payment", label: "Кезек", state: "done" },
      { key: "mdf", label: "МДФ", state: isReady ? "done" : "active" },
      { key: "ready", label: "Дайын", state: isReady ? "done" : "pending" },
    ];
  }

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

/**
 * How many other customers are in front of this order in the cutting queue.
 *
 * Counted in people, not in orders: "алдыңызда 6 заказ" reads as six jobs when two of them may
 * belong to one customer who will be served once. Distinct names are what the person waiting
 * actually wants to know.
 *
 * Rows the board has no name for cannot be deduped against anything, so each counts as one — an
 * over-count is the honest direction to be wrong in when someone is waiting.
 */
export function customersAhead(
  entries: readonly Pick<WorkshopActivityEntry, "id" | "stage" | "queuePosition" | "customerName">[],
  mine: Pick<WorkshopActivityEntry, "id" | "queuePosition" | "customerName">,
): number {
  const myName = (mine.customerName ?? "").trim().toLowerCase();
  const names = new Set<string>();
  let unnamed = 0;

  for (const e of entries) {
    if (e.id === mine.id) continue;
    if (e.stage !== "queue") continue;
    if (e.queuePosition >= mine.queuePosition) continue;

    const name = (e.customerName ?? "").trim().toLowerCase();
    if (!name) unnamed += 1;
    else if (name !== myName) names.add(name);
  }

  return names.size + unnamed;
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
    case "mdf":
      return "МДФ өндірісінде";
    default:
      return "Дайын";
  }
}
