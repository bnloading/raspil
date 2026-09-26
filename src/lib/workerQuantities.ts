import type { Material, Order, OrderLineJob } from "../types/domain";
import { jobsOf } from "./orderLines";
import { lineCategory } from "./lineCategory";

export type FloorStage = "cutting" | "pvc";
export function workerJobs(order: Order, stage: FloorStage, uid: string, completed: boolean) {
  return jobsOf(order).filter(j => stage === "cutting"
    ? j.cuttingByUid === uid && (completed ? !!j.cuttingCompletedAt : !!j.cuttingStartedAt && !j.cuttingCompletedAt)
    : j.pvcByUid === uid && (completed ? !!j.pvcCompletedAt : !!j.pvcStartedAt && !j.pvcCompletedAt));
}

/**
 * True for a line cut from a столешница rather than a board — the material's own catalogue entry
 * carries this (materialSnapshot never does), so it's looked up live; only a material since deleted
 * from the catalogue falls back to the name the line was typed under (lib/lineCategory.ts).
 */
export function isCountertopJob(job: Pick<OrderLineJob, "materialId" | "materialName">, materials: readonly Material[]): boolean {
  const material = materials.find(m => m.id === job.materialId);
  const known = new Map(material ? [[material.id, material.category ?? "ldsp"] as const] : []);
  return lineCategory(job, known) === "countertop";
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
