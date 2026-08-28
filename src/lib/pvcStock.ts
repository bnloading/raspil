import type { Order, PvcType } from "../types/domain";

/**
 * Edge-banding stock, counted in metres per colour.
 *
 * Mirrors how sheets are handled: the warehouse holds a running total, finishing a job draws it
 * down, and a low total is flagged before it runs out mid-order. The unit is metres rather than
 * pieces because that is how the roll is bought and how every order already measures its edging.
 */

export type PvcStockLevel = "out" | "critical" | "low" | "ok";

export const PVC_STOCK_LABELS: Record<PvcStockLevel, string> = {
  out: "Таусылды",
  critical: "Таусылуға жақын",
  low: "Аз қалды",
  ok: "Жеткілікті",
};

export interface PvcStockInfo {
  level: PvcStockLevel;
  label: string;
  metersOnHand: number;
  /** 0..1 for the bar, full at three times the floor. */
  ratio: number;
}

/**
 * Bands are relative to each colour's own floor, so a colour the shop gets through quickly and one
 * it barely touches both warn at the right moment. Same shape as lib/stockStatus.ts for sheets.
 */
export function pvcStockStatus(pvc: Pick<PvcType, "metersOnHand" | "minStockMeters">): PvcStockInfo {
  const metersOnHand = Math.max(0, pvc.metersOnHand ?? 0);
  const floor = Math.max(0, pvc.minStockMeters ?? 0);

  const level: PvcStockLevel =
    metersOnHand <= 0 ? "out"
    : floor <= 0 ? "ok"
    : metersOnHand <= floor ? "critical"
    : metersOnHand <= floor * 2 ? "low"
    : "ok";

  const full = floor > 0 ? floor * 3 : Math.max(metersOnHand, 1);
  return {
    level,
    label: PVC_STOCK_LABELS[level],
    metersOnHand,
    ratio: Math.min(1, metersOnHand / full),
  };
}

/** Colours at or below their floor — what the "Аз қалған" tile counts. */
export function lowPvcCount(types: Array<Pick<PvcType, "metersOnHand" | "minStockMeters">>): number {
  return types.filter((t) => {
    const l = pvcStockStatus(t).level;
    return l === "critical" || l === "out";
  }).length;
}

/**
 * How many metres of each colour an order consumes, from the breakdown denormalized onto it.
 *
 * Returns an empty map when the order has no colour breakdown — a walk-in typed into the journal
 * records a blended metre total with no colour attached, and guessing which roll it came off would
 * corrupt the stock figures. Those metres simply are not deducted, which is visible in the ПВХ
 * report as "Түрі көрсетілмеген" rather than hidden.
 */
export function pvcConsumption(order: Pick<Order, "pvcByType">): Map<string, number> {
  const out = new Map<string, number>();
  for (const use of order.pvcByType ?? []) {
    if (!use.pvcTypeId || !(use.meters > 0)) continue;
    out.set(use.pvcTypeId, (out.get(use.pvcTypeId) ?? 0) + use.meters);
  }
  return out;
}

/**
 * Stock after a consumption, floored at zero.
 *
 * Never refuses: the edging is already glued on by the time this runs, so a stock figure that had
 * drifted must not block a finished job. It settles at zero and the shortfall shows up as an
 * out-of-stock colour for someone to correct.
 */
export function applyConsumption(metersOnHand: number, used: number): number {
  return Math.max(0, Math.round(((metersOnHand ?? 0) - (used ?? 0)) * 100) / 100);
}
