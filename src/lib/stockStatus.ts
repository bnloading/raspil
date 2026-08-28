import type { Material } from "../types/domain";

/**
 * How healthy a material's stock is, for the Қойма table's Күйі column.
 *
 * Judged on what is actually usable — `qtyOnHand` minus what is already reserved for approved
 * orders — because sheets promised to someone else cannot be sold twice.
 *
 * The bands are relative to each material's own `minStock` rather than a fixed count, so a fast
 * mover with a floor of 50 and a slow one with a floor of 2 both warn at the right moment:
 *
 *   available <= 0            Таусылды
 *   available <= minStock     Таусылуға жақын   (at or under the floor)
 *   available <= minStock × 2 Аз қалды          (approaching it)
 *   otherwise                 Жеткілікті
 *
 * A material with no floor set (minStock 0) only ever reports Таусылды or Жеткілікті — with no
 * floor there is no meaningful "getting low".
 */

export type StockLevel = "out" | "critical" | "low" | "ok";

export const STOCK_LABELS: Record<StockLevel, string> = {
  out: "Таусылды",
  critical: "Таусылуға жақын",
  low: "Аз қалды",
  ok: "Жеткілікті",
};

export interface StockInfo {
  level: StockLevel;
  label: string;
  /** Sheets free to sell: on hand less reserved, never negative. */
  available: number;
  /**
   * 0..1, for the bar under the count. Full bar at three times the floor, which is where a
   * material stops being interesting — otherwise one huge delivery would flatten every other bar.
   */
  ratio: number;
}

export function stockStatus(material: Pick<Material, "qtyOnHand" | "reservedQty" | "minStock">): StockInfo {
  const available = Math.max(0, (material.qtyOnHand ?? 0) - (material.reservedQty ?? 0));
  const floor = Math.max(0, material.minStock ?? 0);

  const level: StockLevel =
    available <= 0 ? "out"
    : floor <= 0 ? "ok"
    : available <= floor ? "critical"
    : available <= floor * 2 ? "low"
    : "ok";

  const full = floor > 0 ? floor * 3 : Math.max(available, 1);
  return { level, label: STOCK_LABELS[level], available, ratio: Math.min(1, available / full) };
}

/** Materials at or below their floor — what the "Аз қалған" KPI counts. */
export function lowStockCount(materials: Array<Pick<Material, "qtyOnHand" | "reservedQty" | "minStock">>): number {
  return materials.filter((m) => {
    const l = stockStatus(m).level;
    return l === "critical" || l === "out";
  }).length;
}
