import type { MaterialCategory, Order } from "../types/domain";
import { lineCategory } from "./lineCategory";
import { jobsOf } from "./orderLines";

/** Sheets the saw cut, in the four things the shop counts apart. */
export interface CutKinds {
  /** ЛДСП and every other board cut at the sheet rate — черновой, Эггер, a customer's own. */
  ldsp: number;
  mdf: number;
  hdf: number;
  countertop: number;
  /** How many orders those lines came from. */
  orders: number;
}

/** A row struck off the journal — cancelled, folded into another, a draft, or re-typed. */
function struckOff(o: Order): boolean {
  return o.productionStatus === "cancelled" || o.productionStatus === "draft" || !!o.mergedIntoOrderId || !!o.cutWorkVoided;
}

/**
 * What the saw really cut between `from` and `to` (the owner, 06.11: «бір айдағы нақты қанша лист,
 * қанша ХДФ, столеш, МДФ кесілді»): every line of a live journal order whose cut was confirmed
 * (cuttingCompletedAt) in the range, at the count the cutter confirmed — the same lines
 * scripts/cutter-pay.mjs pays for. Not the sheets taken off the rack when an order was queued:
 * those include orders still waiting for the saw, and the boards the shop does not stock.
 */
export function sheetsCutBetween(
  orders: readonly Order[],
  categoryByMaterialId: ReadonlyMap<string, MaterialCategory>,
  from: Date,
  to?: Date,
): CutKinds {
  const out: CutKinds = { ldsp: 0, mdf: 0, hdf: 0, countertop: 0, orders: 0 };
  const fromMs = from.getTime();
  const toMs = to?.getTime() ?? Infinity;
  for (const o of orders) {
    if (o.orderKind === "mdf_wrap" || struckOff(o)) continue;
    let counted = false;
    for (const job of jobsOf(o)) {
      const at = job.cuttingCompletedAt ? job.cuttingCompletedAt.seconds * 1000 : NaN;
      if (!(at >= fromMs && at < toMs)) continue;
      const sheets = job.confirmedSheets ?? job.sheetQty ?? 0;
      if (sheets <= 0) continue;
      const kind = lineCategory(job, categoryByMaterialId);
      out[kind === "mdf" || kind === "hdf" || kind === "countertop" ? kind : "ldsp"] += sheets;
      counted = true;
    }
    if (counted) out.orders += 1;
  }
  return out;
}

/** "2026-11" → the Almaty calendar month it names, as [start, start of the next). */
export function monthRange(key: string): [Date, Date] {
  const [y, m] = key.split("-").map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  return [new Date(`${key}-01T00:00:00+05:00`), new Date(`${next}-01T00:00:00+05:00`)];
}
