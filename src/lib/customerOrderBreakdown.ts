import { computeLineTotals } from "./journal";
import { formatMdfArea, mdfPatternOf } from "./mdfJournal";
import { formatMoney } from "./money";
import { linesOf } from "./orderMerge";
import { MDF_FINISH_LABELS } from "../types/domain";
import type { Order } from "../types/domain";

/** One line of what an order is made of, as the customer reads it: what, how much, what it cost. */
export interface BreakdownRow {
  key: string;
  title: string;
  /** How much at what price — «8 лист × 16 200 ₸». */
  detail?: string;
  /** How much alone — «8 лист» — for an order the shop has not priced yet. */
  quantity?: string;
  amountTiyn: number;
}

/**
 * What a customer's order is made of — «ЛДСП Ақ Томск · 12 лист × 16 200 ₸», «ПВХ Ақ · 129 м ×
 * 200 ₸», then cutting, ХДФ, delivery, any discount — so the sum they owe can be read line by line
 * on their phone.
 *
 * The customer's order page used to name only the order's first material ("Болжамды лист: 0") and
 * an empty «Бөлшектер (0)» table for every order typed in the journal: a merged order of Ақ Томск
 * and ХДФ read as Ақ Томск alone, and the ХДФ charge was missing from the sum altogether. Every
 * figure here is the one the journal priced the line at (lib/journal.ts computeLineTotals).
 */
export function customerOrderBreakdown(order: Order): { lines: BreakdownRow[]; extras: BreakdownRow[] } {
  const lines: BreakdownRow[] = [];
  if (order.orderKind === "mdf_wrap") {
    const area = order.mdfAreaM2 ?? 0;
    const rate = order.mdfPricePerM2Tiyn ?? 0;
    lines.push({
      key: "mdf",
      title: [mdfPatternOf(order) || "МДФ", MDF_FINISH_LABELS[order.mdfFinish ?? "film"], order.mdfFilmColor?.trim()]
        .filter(Boolean).join(" · "),
      detail: rate > 0 ? `${formatMdfArea(area)} × ${formatMoney(rate)}` : formatMdfArea(area),
      quantity: formatMdfArea(area),
      amountTiyn: Math.round(area * rate),
    });
  } else {
    linesOf(order).forEach((line, index) => {
      const totals = computeLineTotals(line);
      if (line.sheetQty > 0 || totals.materialCostTiyn > 0) {
        lines.push({
          key: `sheets-${index}`,
          title: line.materialName || "Материал",
          detail: `${line.sheetQty} лист × ${formatMoney(line.sheetPriceTiyn)}`,
          quantity: `${line.sheetQty} лист`,
          amountTiyn: totals.materialCostTiyn,
        });
      }
      if (line.pvcMeters > 0) {
        const rate = line.pvcMeters > 0 ? Math.round(totals.pvcCostTiyn / line.pvcMeters) : 0;
        const meters = `${Math.round(line.pvcMeters * 10) / 10} м`;
        const jointed = line.pvcJointed ? " · прифуговка" : "";
        lines.push({
          key: `pvc-${index}`,
          title: `ПВХ${line.pvcColorName ? ` · ${line.pvcColorName}` : ""}`,
          detail: `${meters} × ${formatMoney(rate)}${jointed}`,
          quantity: `${meters}${jointed}`,
          amountTiyn: totals.pvcCostTiyn,
        });
      }
    });
  }

  const extras: BreakdownRow[] = [
    { key: "cutting", title: "Кесу", amountTiyn: order.cuttingCostTiyn ?? 0 },
    { key: "hdf", title: "ХДФ", amountTiyn: order.hdfCostTiyn ?? 0 },
    { key: "extra", title: "Қосымша қызмет", amountTiyn: order.extraServicesTiyn ?? 0 },
    { key: "delivery", title: "Жеткізу", amountTiyn: order.deliveryCostTiyn ?? 0 },
    {
      key: "discount",
      title: order.discountPercent ? `Жеңілдік ${order.discountPercent}%` : "Жеңілдік",
      amountTiyn: -(order.discountTiyn ?? 0),
    },
  ].filter((row) => row.amountTiyn !== 0);

  return { lines, extras };
}
