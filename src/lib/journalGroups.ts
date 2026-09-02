import type { Order, OrderMaterialLine } from "../types/domain";

/**
 * Merged orders, made visible again.
 *
 * Merging folds several journal rows into one order and hides the rows it absorbed, which is right
 * for the money — three rows would count the same sheets three times — but it left the manager
 * with a single row saying "13 лист" and no way back to what went into it. The customer standing
 * at the counter asks the other half of the same question: what does each sheet cost?
 *
 * Both answers come out of `items[]`, which already carries every line at its own price. What was
 * missing was somewhere to show them and a way to tell which original order each line came from —
 * this module works out both, and assigns each merged order a colour so its parent row and its
 * lines read as one block down the ledger.
 */

/** What one material line is worth, split the way the customer asks about it. */
export interface LinePrice {
  /** Sheets × the sheet price. */
  sheetsTiyn: number;
  /** Metres × the per-metre rate. */
  pvcTiyn: number;
  sheetsAndPvcTiyn: number;
}

export function linePrice(line: Pick<OrderMaterialLine, "sheetQty" | "sheetPriceTiyn" | "pvcMeters" | "pvcPricePerMeterTiyn">): LinePrice {
  const sheetsTiyn = Math.round(line.sheetQty * line.sheetPriceTiyn);
  // Metres are fractional (176.4 м), so the product is rounded once, here, rather than leaving
  // a fraction of a tiyn to accumulate down a column of lines.
  const pvcTiyn = Math.round(line.pvcMeters * line.pvcPricePerMeterTiyn);
  return { sheetsTiyn, pvcTiyn, sheetsAndPvcTiyn: sheetsTiyn + pvcTiyn };
}

/**
 * How many colours a merge group can wear.
 *
 * Six is enough to tell apart the groups visible on one screen without the ledger turning into a
 * paint chart — and the colour is only ever a second signal: every grouped row also carries the
 * "⧉ N заказ" badge and its source order number, so nothing depends on telling teal from indigo.
 */
export const GROUP_TONE_COUNT = 6;

/**
 * A stable colour for one merge group, derived from the surviving order's id.
 *
 * Derived rather than stored so it survives a reload, an edit and a re-merge without a field to
 * keep in sync, and so two merged orders sitting next to each other almost always differ.
 */
export function groupTone(orderId: string): number {
  let hash = 0;
  for (let i = 0; i < orderId.length; i += 1) {
    hash = (hash * 31 + orderId.charCodeAt(i)) >>> 0;
  }
  return hash % GROUP_TONE_COUNT;
}

/** Surviving order id → the rows folded straight into it. Built once per page, not per row. */
export type MergeChildren = ReadonlyMap<string, Order[]>;

/**
 * Indexes every merge the ledger has ever made, in one pass over the orders.
 *
 * Asking each visible row "which orders were folded into you?" used to mean re-scanning the whole
 * order history per row — fine at 20 orders, wasteful at several thousand. One pass answers it for
 * every row at once.
 */
export function mergeChildrenByParent(orders: readonly Order[]): MergeChildren {
  const map = new Map<string, Order[]>();
  for (const order of orders) {
    if (!order.mergedIntoOrderId) continue;
    const list = map.get(order.mergedIntoOrderId);
    if (list) list.push(order);
    else map.set(order.mergedIntoOrderId, [order]);
  }
  return map;
}

/**
 * The orders folded into this one, oldest first.
 *
 * Merges can chain — A into B, then B into C — so this follows the index all the way down rather
 * than only picking up direct children, which would leave the first merge's rows unaccounted for
 * on the surviving order.
 */
export function absorbedOrdersOf(orderId: string, children: MergeChildren): Order[] {
  const found: Order[] = [];
  const seen = new Set<string>([orderId]);
  const frontier = [orderId];

  while (frontier.length > 0) {
    const parentId = frontier.pop()!;
    for (const order of children.get(parentId) ?? []) {
      // A cycle would be corrupt data rather than anything the UI can produce — stop, don't hang.
      if (seen.has(order.id)) continue;
      seen.add(order.id);
      found.push(order);
      frontier.push(order.id);
    }
  }

  return found.sort((a, b) => (a.createdAt?.seconds ?? 0) - (b.createdAt?.seconds ?? 0));
}

/**
 * Shift-click range selection, the way a spreadsheet does it.
 *
 * `ids` is the rows in the order they are on screen, so the range follows what the eye sees rather
 * than creation order. An anchor that has scrolled off the current page selects just the row that
 * was clicked, which is the only sane reading of "from nowhere to here".
 */
export function rangeBetween(ids: readonly string[], anchorId: string, targetId: string): string[] {
  const from = ids.indexOf(anchorId);
  const to = ids.indexOf(targetId);
  if (from === -1 || to === -1) return to === -1 ? [] : [targetId];
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  return ids.slice(lo, hi + 1);
}

/** Adds a range to the current selection without dropping what was already picked elsewhere. */
export function withRangePicked(
  picked: ReadonlySet<string>,
  ids: readonly string[],
  anchorId: string,
  targetId: string,
): Set<string> {
  const next = new Set(picked);
  for (const id of rangeBetween(ids, anchorId, targetId)) next.add(id);
  return next;
}
