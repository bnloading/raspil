import type { Timestamp } from "firebase/firestore";
import type { MaterialCategory, Order } from "../types/domain";
import { jobsOf } from "./orderLines";
import { lineCategory } from "./lineCategory";

/** One order this cutter actually cut sheets on — dated by when they finished their part of it. */
export interface CutHistoryEntry {
  orderId: string;
  orderNumber: string;
  customerName: string;
  /** When this cutter's last line on this order was confirmed done. */
  completedAt: Timestamp;
  /** Board sheets (ЛДСП/ХДФ/МДФ) across only the lines this cutter cut, столешница excluded — a
   *  merged order another cutter partly worked never inflates this worker's own count. */
  sheets: number;
  /** Столешница pieces from those same lines, counted separately: a length-priced countertop is
   *  not the same unit of work as a sheet, and adding them together used to read as one number
   *  nobody could actually use for either rate. */
  countertops: number;
  /** Distinct material names this cutter cut on this order, in cutting order. */
  materials: string[];
}

/**
 * Builds one cutter's whole cutting history from the orders their uid appears on — newest first.
 *
 * Reads per-line (`job.cuttingByUid`), not the order-level `assignedCutterId`, so a merged order
 * two different cutters split shows only each one's own sheets and materials, and an order this
 * cutter never actually cut a line on (assigned but reassigned before starting, say) is excluded.
 * jobsOf() derives lines for orders that predate per-line tracking, so history from before this
 * feature existed still counts exactly as it always did.
 */
export function buildCutterHistory(
  orders: Order[],
  uid: string,
  /** Material category per materialId — same map measureWork() takes. Anything missing (or no
   *  map at all) counts as a sheet, never a countertop, so callers that don't have the catalogue
   *  loaded yet still get a number rather than nothing. */
  categoryByMaterialId: Map<string, MaterialCategory> = new Map(),
): CutHistoryEntry[] {
  const entries: CutHistoryEntry[] = [];

  for (const order of orders) {
    const mine = jobsOf(order).filter((j) => j.cuttingByUid === uid && j.cuttingCompletedAt);
    if (mine.length === 0) continue;

    const completedAt = mine.reduce((latest, j) =>
      j.cuttingCompletedAt!.toMillis() > latest.toMillis() ? j.cuttingCompletedAt! : latest,
      mine[0].cuttingCompletedAt!,
    );

    let sheets = 0;
    let countertops = 0;
    for (const j of mine) {
      const qty = j.confirmedSheets ?? j.sheetQty ?? 0;
      if (lineCategory(j, categoryByMaterialId) === "countertop") countertops += qty;
      else sheets += qty;
    }

    entries.push({
      orderId: order.id,
      orderNumber: order.orderNumber,
      customerName: order.customerName,
      completedAt,
      sheets,
      countertops,
      materials: [...new Set(mine.map((j) => j.materialName))],
    });
  }

  return entries.sort((a, b) => b.completedAt.toMillis() - a.completedAt.toMillis());
}
