import type { MaterialCategory, Order, OrderLineJob } from "../types/domain";
import { lineKind, type StockKind } from "./lineCategory";
import { isEmptyJob, jobsOf } from "./orderLines";

/**
 * One order's lines of one kind, as the cutter's page for that kind shows them. Динко's order of
 * 4 листов Ақ and 2 столешницы is the Ақ on «Лист» and the two countertops on «Столешница»; each
 * page starts and confirms only its own lines, and the order leaves the saw once both are done.
 */
export function jobsOfKind(
  order: Order,
  kind: StockKind,
  categoryByMaterialId: ReadonlyMap<string, MaterialCategory>,
): OrderLineJob[] {
  return jobsOf(order).filter((job) => !isEmptyJob(job) && lineKind(job, categoryByMaterialId) === kind);
}

/**
 * The saw's queue for one kind. An order is on it while a line of that kind is still to be cut:
 * at work when one of those lines is started, waiting otherwise — so the sheets done and the
 * countertops not yet started puts the order on «Столешница» only, and as waiting, not at work.
 */
export function cutterBoard(
  orders: readonly Order[],
  kind: StockKind,
  categoryByMaterialId: ReadonlyMap<string, MaterialCategory>,
): { inProgress: Order[]; queued: Order[] } {
  const inProgress: Order[] = [];
  const queued: Order[] = [];
  for (const order of orders) {
    if (order.productionStatus !== "cutting_queue" && order.productionStatus !== "cutting_started") continue;
    const open = jobsOfKind(order, kind, categoryByMaterialId).filter((job) => !job.cuttingCompletedAt);
    if (open.length === 0) continue;
    (open.some((job) => job.cuttingStartedAt) ? inProgress : queued).push(order);
  }
  const byPriority = (a: Order, b: Order) => (a.priority ?? 0) - (b.priority ?? 0);
  return { inProgress: inProgress.sort(byPriority), queued: queued.sort(byPriority) };
}
