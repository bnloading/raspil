import type { Timestamp } from "firebase/firestore";
import type { Order } from "../types/domain";
import { jobsOf } from "./orderLines";

/** One order this cutter actually cut sheets on — dated by when they finished their part of it. */
export interface CutHistoryEntry {
  orderId: string;
  orderNumber: string;
  customerName: string;
  /** When this cutter's last line on this order was confirmed done. */
  completedAt: Timestamp;
  /** Sheets across only the lines this cutter cut — a merged order another cutter partly worked
   *  never inflates this worker's own count. */
  sheets: number;
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
export function buildCutterHistory(orders: Order[], uid: string): CutHistoryEntry[] {
  const entries: CutHistoryEntry[] = [];

  for (const order of orders) {
    const mine = jobsOf(order).filter((j) => j.cuttingByUid === uid && j.cuttingCompletedAt);
    if (mine.length === 0) continue;

    const completedAt = mine.reduce((latest, j) =>
      j.cuttingCompletedAt!.toMillis() > latest.toMillis() ? j.cuttingCompletedAt! : latest,
      mine[0].cuttingCompletedAt!,
    );

    entries.push({
      orderId: order.id,
      orderNumber: order.orderNumber,
      customerName: order.customerName,
      completedAt,
      sheets: mine.reduce((s, j) => s + (j.confirmedSheets ?? j.sheetQty ?? 0), 0),
      materials: [...new Set(mine.map((j) => j.materialName))],
    });
  }

  return entries.sort((a, b) => b.completedAt.toMillis() - a.completedAt.toMillis());
}
