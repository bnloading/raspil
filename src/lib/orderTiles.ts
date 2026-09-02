import { isHdfMaterial } from "./journalPricing";
import { linesOf } from "./orderMerge";
import type { Order } from "../types/domain";

/**
 * The three figures a customer's order card shows: sheets, metres of edging, ХДФ.
 *
 * ХДФ is counted apart from the rest because it is a different thing to the person collecting the
 * order — the thin backing panel, not the board the furniture is made of — and because it takes no
 * edging at all, so folding it into one "лист" figure makes the ПВХ number look wrong beside it.
 *
 * Detected by name, not by category: an order line stores `materialName`, and the customer's own
 * pages never load the material catalogue, so there is no `category` to read here. isHdfMaterial
 * falls back to the name for exactly this case.
 */
export interface OrderTiles {
  /** Sheets of everything that is not ХДФ. */
  sheets: number;
  /** Metres of edge banding across the whole order. */
  pvcMeters: number;
  hdfSheets: number;
}

export function orderTiles(order: Order): OrderTiles {
  let sheets = 0;
  let hdfSheets = 0;

  for (const line of linesOf(order)) {
    const qty = line.sheetQty ?? 0;
    if (qty <= 0) continue;
    if (isHdfMaterial({ name: line.materialName ?? "" })) hdfSheets += qty;
    else sheets += qty;
  }

  return {
    sheets,
    // Rounded once, here: metres are summed from per-edge millimetre divisions and a card has no
    // room for "175.83 м".
    pvcMeters: Math.round(order.pvcMetersTotal ?? 0),
    hdfSheets,
  };
}
