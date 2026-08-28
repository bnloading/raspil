import { monthKey } from "./dates";
import type { Order, PvcType, PvcUsage } from "../types/domain";

/**
 * "ПВХ қайсыдан қанша метр кетті" — how many metres of each edge-banding colour the shop used.
 *
 * Built from the `pvcByType` breakdown denormalized onto each order, so this needs no fan-out into
 * per-order `parts` subcollections.
 */

export interface PvcUsageRow {
  pvcTypeId: string;
  colorName: string;
  thicknessMm: number;
  meters: number;
  costTiyn: number;
  /** Orders that used this colour — the shape of demand, not just its size. */
  orderCount: number;
  /** ₸ per metre currently configured, for reconciling against the cost above. */
  pricePerMeterTiyn: number;
}

export interface PvcUsageSummary {
  rows: PvcUsageRow[];
  totalMeters: number;
  totalCostTiyn: number;
  /**
   * Metres on orders that record a PVC total but no colour breakdown — walk-ins typed into the
   * journal, and orders predating `pvcByType`. Surfaced rather than folded into a colour, because
   * attributing them to one would be a guess, and dropping them would make the totals disagree
   * with the money the shop actually billed.
   */
  unattributedMeters: number;
  unattributedOrderCount: number;
}

/** Drafts and cancellations never consumed material. */
function isRealOrder(order: Order): boolean {
  return order.productionStatus !== "draft" && order.productionStatus !== "cancelled";
}

/**
 * Aggregates colour usage over the given orders.
 *
 * `period` is a YYYY-MM key in Asia/Almaty, or null for all time. Usage is dated by the order's
 * creation, matching how the finance summary books the revenue that paid for it.
 */
export function computePvcUsage({
  orders,
  pvcTypes,
  period,
}: {
  orders: Order[];
  pvcTypes: PvcType[];
  period: string | null;
}): PvcUsageSummary {
  const priceById = new Map(pvcTypes.map((p) => [p.id, p.pricePerMeterTiyn]));

  const inPeriod = (order: Order): boolean => {
    if (period === null) return true;
    if (!order.createdAt) return false;
    return monthKey(order.createdAt) === period;
  };

  const byType = new Map<string, PvcUsageRow>();
  let unattributedMeters = 0;
  let unattributedOrderCount = 0;

  for (const order of orders) {
    if (!isRealOrder(order) || !inPeriod(order)) continue;

    const breakdown: PvcUsage[] = order.pvcByType ?? [];
    if (breakdown.length === 0) {
      // A metre total with no colours behind it. Zero-PVC orders contribute nothing at all.
      if (order.pvcMetersTotal > 0) {
        unattributedMeters += order.pvcMetersTotal;
        unattributedOrderCount++;
      }
      continue;
    }

    for (const use of breakdown) {
      const existing = byType.get(use.pvcTypeId);
      if (existing) {
        existing.meters += use.meters;
        existing.costTiyn += use.costTiyn;
        existing.orderCount++;
      } else {
        byType.set(use.pvcTypeId, {
          pvcTypeId: use.pvcTypeId,
          colorName: use.colorName,
          thicknessMm: use.thicknessMm,
          meters: use.meters,
          costTiyn: use.costTiyn,
          orderCount: 1,
          pricePerMeterTiyn: priceById.get(use.pvcTypeId) ?? 0,
        });
      }
    }
  }

  const rows = [...byType.values()].sort((a, b) => b.meters - a.meters);

  return {
    rows,
    totalMeters: rows.reduce((s, r) => s + r.meters, 0) + unattributedMeters,
    totalCostTiyn: rows.reduce((s, r) => s + r.costTiyn, 0),
    unattributedMeters,
    unattributedOrderCount,
  };
}
