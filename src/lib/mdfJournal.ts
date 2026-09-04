import type { MdfPanel, PaymentStatus } from "../types/domain";
import { computePaymentStatus } from "./statuses";

/**
 * Money arithmetic for the МДФ order journal ("МДФ — ТАПСЫРЫС ЖУРНАЛЫ").
 *
 * A МДФ order is always one production job — one film colour, no multi-material lines or merging
 * like ЛДСП orders can have (see journal.ts's JournalRowInput) — so the total is a single
 * area × price product plus flat extras, mirroring computeJournalRowTotals's shape without its
 * per-line composition. The area itself may be a single typed number, or the sum of several
 * measured panels (see computeMdfPanelsAreaM2) — either way it collapses to one number here.
 */

/** Total area of a panel breakdown, in m² — length/width entered in mm, so each panel divides both
 *  by 1000 before multiplying by its quantity. What Order.mdfAreaM2 is always kept equal to
 *  whenever mdfPanels is present (see types/domain.ts's MdfPanel doc comment). */
export function computeMdfPanelsAreaM2(panels: readonly Pick<MdfPanel, "lengthMm" | "widthMm" | "qty">[]): number {
  return panels.reduce((sum, p) => sum + (p.lengthMm / 1000) * (p.widthMm / 1000) * p.qty, 0);
}

/** An area summed from mm dimensions (computeMdfPanelsAreaM2) carries float noise like
 *  3.3600000000000003 — every screen that shows Order.mdfAreaM2 formats it through this rather
 *  than interpolating the raw number. */
export function formatMdfArea(areaM2: number | undefined | null): string {
  return `${(areaM2 ?? 0).toFixed(2)} м²`;
}
export interface MdfOrderInput {
  areaM2: number;
  pricePerM2Tiyn: number;
  extraServicesTiyn: number;
  deliveryCostTiyn: number;
  discountTiyn: number;
  paidTiyn: number;
}

export interface MdfOrderTotals {
  areaCostTiyn: number;
  totalTiyn: number;
  debtTiyn: number;
  paymentStatus: PaymentStatus;
}

/** Area × price + extras + delivery − discount = final total, floored at 0, then debt = total − paid. */
export function computeMdfOrderTotal(input: MdfOrderInput): MdfOrderTotals {
  const areaCostTiyn = Math.round(input.areaM2 * input.pricePerM2Tiyn);
  const totalTiyn = Math.max(
    0,
    areaCostTiyn + input.extraServicesTiyn + input.deliveryCostTiyn - input.discountTiyn,
  );
  return {
    areaCostTiyn,
    totalTiyn,
    debtTiyn: totalTiyn - input.paidTiyn,
    paymentStatus: computePaymentStatus(totalTiyn, input.paidTiyn),
  };
}
