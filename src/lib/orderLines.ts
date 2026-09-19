import type { Order, OrderLineJob } from "../types/domain";
import { linesOf } from "./orderMerge";

/**
 * A merged order is one order for the customer and several jobs for the shop.
 *
 * "5 sheets of Ақ, 3 of ХДФ and 5 of Кашемир" is one invoice, but three trips to the rack, three
 * different piece rates and three different warehouse balances — so the floor tracks each material
 * line separately: its own start, its own confirmed count, its own draw on stock. These helpers
 * are pure so the arithmetic that decides "is this order finished?" is testable on its own; the
 * writes live in lib/orderStatus.ts and lib/warehouse.ts.
 *
 * Jobs are index-aligned with `Order.items` but hold no money, which is what lets firestore.rules
 * grant a cutter `lineJobs` while keeping `items` off limits.
 */

/**
 * The jobs an order should have, derived from its priced lines.
 *
 * Two backward-compatibility seams for orders that predate per-line tracking:
 *
 * - A single-material order that already has `cuttingConsumedQty` set (queued before per-line
 *   tracking existed) had that amount taken from the warehouse under the old, order-level
 *   accounting — the derived job's baseline has to start from that number, or a later per-line
 *   completion would charge the same sheets to the warehouse twice. A merged order never carries
 *   that field this way (the old flow could only reserve, never consume, a merged order's stock),
 *   so for every line past the first it is correctly read as "nothing taken yet".
 *
 * - An order the old, whole-order flow already finished cutting/edging (`cuttingCompletedAt` /
 *   `pvcCompletedAt` set, no `lineJobs`) has to keep counting for the salary engine, which reads
 *   `job.cuttingByUid`/`cuttingCompletedAt` per line — see lib/salary.ts. The old flow recorded one
 *   cutter and one sheet count for the whole order, so that is what every derived line inherits: a
 *   merged order's per-material split here is an approximation (the planned quantity, since no
 *   historical breakdown exists), not a rewrite of what was actually cut.
 */
export function buildLineJobs(order: Order): OrderLineJob[] {
  const lines = linesOf(order);
  const single = lines.length === 1;
  return lines.map((line, index) => ({
    index,
    materialId: line.materialId,
    materialName: line.materialName,
    sheetQty: line.sheetQty,
    pvcMeters: line.pvcMeters,
    ...(line.pvcJointed ? { pvcJointed: true } : {}),
    ...(single && order.cuttingConsumedQty ? { consumedQty: order.cuttingConsumedQty } : {}),
    ...(order.cuttingCompletedAt
      ? {
          cuttingStartedAt: order.cuttingStartedAt,
          cuttingCompletedAt: order.cuttingCompletedAt,
          cuttingByUid: order.assignedCutterId,
          cuttingByName: order.assignedCutterName,
          confirmedSheets: single ? (order.confirmedSheets ?? line.sheetQty) : line.sheetQty,
          ...(order.cuttingActualMinutes !== undefined ? { cuttingActualMinutes: order.cuttingActualMinutes } : {}),
        }
      : {}),
    ...(line.pvcMeters > 0 && order.pvcCompletedAt
      ? {
          pvcStartedAt: order.pvcStartedAt,
          pvcCompletedAt: order.pvcCompletedAt,
          pvcByUid: order.assignedPvcId,
          pvcByName: order.assignedPvcName,
          ...(order.pvcActualMinutes !== undefined ? { pvcActualMinutes: order.pvcActualMinutes } : {}),
        }
      : {}),
  }));
}

/**
 * The jobs to work from: the ones on the order, or freshly derived for an order that predates
 * per-line tracking (or has not reached the cutting queue, where they are written).
 */
export function jobsOf(order: Order): OrderLineJob[] {
  return order.lineJobs && order.lineJobs.length > 0 ? order.lineJobs : buildLineJobs(order);
}

/** The part of a priced line the shop floor needs — what the work is, as opposed to its price. */
export interface LineWork {
  materialId: string;
  materialName: string;
  sheetQty: number;
  pvcMeters: number;
  pvcJointed?: boolean;
}

/**
 * Re-aligns an order's stored line jobs with its priced lines after the journal row is edited.
 *
 * `lineJobs` is a snapshot taken once, when the order enters the cutting queue. Editing the
 * materials afterwards used to leave that snapshot alone, so the shop floor kept working from
 * whatever the row said at queue time: an order sent to the saw before its material was typed
 * reached the cutter as a blank line, and the sheet it actually cut counted for nothing — not on
 * the warehouse, not on the cutter's salary.
 *
 * The split is deliberate. Progress stays with the job — who started it, when, what they
 * confirmed — because that is the record of what a person did. What the work *is* comes from the
 * line, because the journal is where that is decided.
 *
 * A line already cut keeps one more thing: its `materialId`. The quantity on it may still be
 * corrected ("2 лист деп жаздым, шынында 4"), and lib/journalOrders.ts settles that difference
 * against the rack and the cutter's pay — but the material itself is what those sheets were
 * charged to, and pointing the finished job at a different one would strand that movement against
 * a material nothing references any more.
 */
export function syncLineJobs(existing: OrderLineJob[], lines: LineWork[]): OrderLineJob[] {
  const synced = lines.map((line, index) => {
    const job = existing[index];
    const cut = job && isCuttingDone(job);
    return {
      ...job,
      index,
      ...(cut ? {} : { materialId: line.materialId }),
      materialName: line.materialName,
      sheetQty: line.sheetQty,
      pvcMeters: line.pvcMeters,
      ...(line.pvcJointed ? { pvcJointed: true } : {}),
    };
  });

  // Deleting a line must never delete a cut. If the row now has fewer lines than it has finished
  // jobs, the extra ones are kept: the sheets came off the saw, the warehouse was charged and the
  // cutter was paid for them, and none of that stops being true because the line was removed from
  // the bill. Re-indexed so the array stays addressable by position, as every reader assumes.
  const kept = existing.slice(lines.length).filter(isCuttingDone);
  return [...synced, ...kept].map((job, index) => ({ ...job, index }));
}

export function isCuttingDone(job: OrderLineJob): boolean {
  return !!job.cuttingCompletedAt;
}

export function isCuttingStarted(job: OrderLineJob): boolean {
  return !!job.cuttingStartedAt && !job.cuttingCompletedAt;
}

/** Only lines with edge banding on them are the PVC worker's business. */
export function needsPvc(job: OrderLineJob): boolean {
  return job.pvcMeters > 0;
}

export function isPvcDone(job: OrderLineJob): boolean {
  return !!job.pvcCompletedAt;
}

export function isPvcStarted(job: OrderLineJob): boolean {
  return !!job.pvcStartedAt && !job.pvcCompletedAt;
}

/** The order leaves the saw only when every material has been cut. */
export function allCuttingDone(jobs: OrderLineJob[]): boolean {
  return jobs.length > 0 && jobs.every(isCuttingDone);
}

/** Likewise for edge banding — lines with no ПВХ never hold the order up. */
export function allPvcDone(jobs: OrderLineJob[]): boolean {
  const banded = jobs.filter(needsPvc);
  return banded.length === 0 || banded.every(isPvcDone);
}

/** Whether any of the order's lines needs edge banding at all. */
export function orderNeedsPvc(jobs: OrderLineJob[]): boolean {
  return jobs.some(needsPvc);
}

/** What the cutter actually counted across the whole order, falling back to the planned figure. */
export function totalConfirmedSheets(jobs: OrderLineJob[]): number {
  return jobs.reduce((sum, j) => sum + (j.confirmedSheets ?? j.sheetQty), 0);
}

/** Sheets this order has taken out of the warehouse so far. */
export function totalConsumedSheets(jobs: OrderLineJob[]): number {
  return jobs.reduce((sum, j) => sum + (j.consumedQty ?? 0), 0);
}

/** Returns a new job list with one line patched — arrays are rewritten whole in Firestore. */
export function patchJob(
  jobs: OrderLineJob[],
  index: number,
  patch: Partial<OrderLineJob>,
): OrderLineJob[] {
  return jobs.map((job) => (job.index === index ? { ...job, ...patch } : job));
}

/** The line a worker is looking at, by its index — undefined if the order has changed underneath. */
export function jobAt(jobs: OrderLineJob[], index: number): OrderLineJob | undefined {
  return jobs.find((j) => j.index === index);
}

/** "10 лист · 176 м ПВХ" for a single line, the same shape materialSummary() uses for an order. */
export function jobSummary(job: OrderLineJob): string {
  const parts: string[] = [];
  const sheets = job.confirmedSheets ?? job.sheetQty;
  if (sheets > 0) parts.push(`${sheets} лист`);
  if (job.pvcMeters > 0) parts.push(`${job.pvcMeters} м ПВХ`);
  return parts.join(" · ") || "—";
}
