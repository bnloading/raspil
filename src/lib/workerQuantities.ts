import type { Material, Order, OrderLineJob } from "../types/domain";
import { creditsFloorWork, jobsOf } from "./orderLines";
import { lineCategory } from "./lineCategory";
import type { CutCounts } from "./salary";

export type FloorStage = "cutting" | "pvc";
export function workerJobs(order: Order, stage: FloorStage, uid: string, completed: boolean) {
  // Struck off to be typed again: its work belongs to the re-typed order (creditsFloorWork).
  if (!creditsFloorWork(order)) return [];
  return jobsOf(order).filter(j => stage === "cutting"
    ? j.cuttingByUid === uid && (completed ? !!j.cuttingCompletedAt : !!j.cuttingStartedAt && !j.cuttingCompletedAt)
    : j.pvcByUid === uid && (completed ? !!j.pvcCompletedAt : !!j.pvcStartedAt && !j.pvcCompletedAt));
}

/**
 * Sheets on these lines as the shop counts them — "10 лист · 3 ХДФ" (lib/salary.ts cutCounts): ХДФ
 * and столешница apart, every other board — ЛДСП, черновой, МДФ — a лист. The category is the
 * material's own catalogue entry (materialSnapshot never carries it), so it's looked up live; only
 * a material since deleted from the catalogue falls back to the name the line was typed under
 * (lib/lineCategory.ts).
 */
export function cutCountsOfJobs(jobs: readonly OrderLineJob[], materials: readonly Material[]): CutCounts {
  const categories = new Map(materials.map(m => [m.id, m.category ?? "ldsp"] as const));
  const cut: CutCounts = { sheets: 0, hdf: 0, countertop: 0 };
  for (const job of jobs) {
    const sheets = job.confirmedSheets ?? job.sheetQty ?? 0;
    const category = lineCategory(job, categories);
    if (category === "hdf") cut.hdf += sheets;
    else if (category === "countertop") cut.countertop += sheets;
    else cut.sheets += sheets;
  }
  return cut;
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
