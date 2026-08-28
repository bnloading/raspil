import type { CuttingPart, EdgeKey, Material, PvcType } from "../types/domain";
import { EDGE_KEYS } from "../types/domain";

/**
 * Edge-length convention: A (top) and C (bottom) run along the part's width; B (right) and
 * D (left) run along the part's length. This matches a part laid flat with `lengthMm` as the
 * vertical dimension and `widthMm` as the horizontal one.
 */
export function edgeLengthMm(part: Pick<CuttingPart, "lengthMm" | "widthMm">, edge: EdgeKey): number {
  return edge === "A" || edge === "C" ? part.widthMm : part.lengthMm;
}

/** PVC metres for one part = (sum of selected edge lengths in mm) × qty ÷ 1000. Never counts an unselected edge. */
export function computePartPvcMeters(part: CuttingPart): number {
  let mmTotal = 0;
  for (const edge of EDGE_KEYS) {
    if (part.edges[edge]?.pvc) mmTotal += edgeLengthMm(part, edge);
  }
  return (mmTotal * part.qty) / 1000;
}

export interface PvcBreakdownRow {
  key: string;
  /** The first pvcType that contributed to this row. Rows group by thickness+colour, so if two
   *  pvcType documents describe the same product this names whichever was seen first — enough to
   *  attribute usage, not a claim that only one id contributed. */
  pvcTypeId: string;
  thicknessMm: number;
  colorName: string;
  meters: number;
  costTiyn: number;
}

export function computePvcBreakdown(
  parts: CuttingPart[],
  pvcTypesById: Map<string, PvcType>,
): PvcBreakdownRow[] {
  const map = new Map<string, PvcBreakdownRow>();
  for (const part of parts) {
    for (const edge of EDGE_KEYS) {
      const e = part.edges[edge];
      if (!e?.pvc || !e.pvcTypeId) continue;
      const pvcType = pvcTypesById.get(e.pvcTypeId);
      if (!pvcType) continue;
      const meters = (edgeLengthMm(part, edge) * part.qty) / 1000;
      const key = `${pvcType.thicknessMm}|${pvcType.colorName}`;
      const existing = map.get(key);
      const costTiyn = Math.round(meters * pvcType.pricePerMeterTiyn);
      if (existing) {
        existing.meters += meters;
        existing.costTiyn += costTiyn;
      } else {
        map.set(key, {
          key,
          pvcTypeId: e.pvcTypeId,
          thicknessMm: pvcType.thicknessMm,
          colorName: pvcType.colorName,
          meters,
          costTiyn,
        });
      }
    }
  }
  return [...map.values()].sort((a, b) => b.meters - a.meters);
}

export function totalPvcMeters(parts: CuttingPart[]): number {
  return parts.reduce((sum, p) => sum + computePartPvcMeters(p), 0);
}

export function totalPvcCostTiyn(parts: CuttingPart[], pvcTypesById: Map<string, PvcType>): number {
  return computePvcBreakdown(parts, pvcTypesById).reduce((sum, row) => sum + row.costTiyn, 0);
}

/**
 * Rough sheet estimate from total part area vs. sheet area — this is explicitly NOT an exact
 * nesting/layout calculation (spec: "Болжамды лист саны" estimate only). Admin fills in
 * "Расталған лист саны" (confirmedSheets) after real cutting-layout planning.
 */
export function estimateSheets(parts: CuttingPart[], material: Pick<Material, "sheetLengthMm" | "sheetWidthMm">): number {
  const sheetAreaMm2 = material.sheetLengthMm * material.sheetWidthMm;
  if (sheetAreaMm2 <= 0) return 0;
  const totalPartAreaMm2 = parts.reduce((sum, p) => sum + p.lengthMm * p.widthMm * p.qty, 0);
  // +15% waste margin since real nesting always loses some material to kerf/offcuts.
  return Math.max(1, Math.ceil((totalPartAreaMm2 * 1.15) / sheetAreaMm2));
}

export interface OrderTotalsInput {
  parts: CuttingPart[];
  material: Material;
  pvcTypesById: Map<string, PvcType>;
  sheets: number; // confirmedSheets ?? estimateSheets(...)
  cuttingPricePerSheetTiyn: number;
  extraServicesTiyn: number;
  deliveryCostTiyn: number;
  discountTiyn: number;
}

export interface OrderTotals {
  estimatedSheets: number;
  pvcMetersTotal: number;
  materialCostTiyn: number;
  cuttingCostTiyn: number;
  pvcCostTiyn: number;
  totalTiyn: number;
}

export function computeOrderTotals(input: OrderTotalsInput): OrderTotals {
  const estimatedSheets = estimateSheets(input.parts, input.material);
  const sheets = input.sheets || estimatedSheets;
  const materialCostTiyn = sheets * input.material.sellingPriceTiyn;
  const cuttingCostTiyn = sheets * input.cuttingPricePerSheetTiyn;
  const pvcCostTiyn = totalPvcCostTiyn(input.parts, input.pvcTypesById);
  const pvcMetersTotal = totalPvcMeters(input.parts);
  const totalTiyn = Math.max(
    0,
    materialCostTiyn + cuttingCostTiyn + pvcCostTiyn + input.extraServicesTiyn + input.deliveryCostTiyn - input.discountTiyn,
  );
  return { estimatedSheets, pvcMetersTotal, materialCostTiyn, cuttingCostTiyn, pvcCostTiyn, totalTiyn };
}

/** A part must fit inside the selected sheet, in either orientation if rotation is allowed. */
export function partFitsSheet(
  part: Pick<CuttingPart, "lengthMm" | "widthMm" | "rotationAllowed">,
  sheet: Pick<Material, "sheetLengthMm" | "sheetWidthMm">,
): boolean {
  const direct = part.lengthMm <= sheet.sheetLengthMm && part.widthMm <= sheet.sheetWidthMm;
  if (direct) return true;
  if (!part.rotationAllowed) return false;
  return part.widthMm <= sheet.sheetLengthMm && part.lengthMm <= sheet.sheetWidthMm;
}
