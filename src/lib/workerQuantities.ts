import type { Material, Order, OrderLineJob } from "../types/domain";
import { jobsOf } from "./orderLines";

export type FloorStage = "cutting" | "pvc";
export function workerJobs(order: Order, stage: FloorStage, uid: string, completed: boolean) {
  return jobsOf(order).filter(j => stage === "cutting"
    ? j.cuttingByUid === uid && (completed ? !!j.cuttingCompletedAt : !!j.cuttingStartedAt && !j.cuttingCompletedAt)
    : j.pvcByUid === uid && (completed ? !!j.pvcCompletedAt : !!j.pvcStartedAt && !j.pvcCompletedAt));
}

/** Sheet area, not the area of finished parts. Never assume one size for a merged order. */
export function jobQuantities(order: Order, job: OrderLineJob, materials: readonly Material[]) {
  const snapshot = job.materialId === order.materialId ? order.materialSnapshot : undefined;
  const dimensions = snapshot ?? materials.find(m => m.id === job.materialId);
  const sheets = job.confirmedSheets ?? job.sheetQty;
  const area = dimensions?.sheetLengthMm && dimensions?.sheetWidthMm
    ? sheets * dimensions.sheetLengthMm * dimensions.sheetWidthMm / 1_000_000 : null;
  return { sheets, area, pvcMeters: job.pvcMeters };
}
