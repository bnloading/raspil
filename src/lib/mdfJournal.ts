import type { ApplicationSettings, MdfPanel, MdfPattern, MdfPatternTemplate, MdfStage, Order, PaymentStatus } from "../types/domain";
import type { ProgressStep, StepState } from "./journalFilters";
import { MDF_PATTERN_LABELS, MDF_PATTERNS } from "../types/domain";
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

/**
 * Fixed shop price per m² for each pattern that has one. "basqa" (custom/unlisted) and the legacy
 * "vyborka" value (see types/domain.ts) are deliberately absent — those still go through the
 * Manager's own "Баға белгілеу" step, exactly as every МДФ order did before this table existed.
 */
export const MDF_PATTERN_PRICE_TIYN: Partial<Record<MdfPattern, number>> = {
  modern: 1_650_000,
  riflenka: 1_750_000,
  kvadro: 1_850_000,
  vyborka50: 1_950_000,
  vyborka20: 2_050_000,
};

/**
 * The МДФ journal's «Узор» list before an Admin has edited it: the shop's fixed patterns at their
 * fixed rates, in the order the customer form offers them. "Басқа" is not a template — it is the
 * journal's "type the name and price by hand" choice.
 */
export const DEFAULT_MDF_PATTERN_TEMPLATES: MdfPatternTemplate[] = MDF_PATTERNS
  .filter((p) => MDF_PATTERN_PRICE_TIYN[p] !== undefined)
  .map((p) => ({ name: MDF_PATTERN_LABELS[p], pricePerM2Tiyn: MDF_PATTERN_PRICE_TIYN[p]! }));

/** The templates the journal offers: the Admin's list once one is saved, the fixed rates until then. */
export function mdfPatternTemplates(settings: Pick<ApplicationSettings, "mdfPatternTemplates">): MdfPatternTemplate[] {
  const saved = settings.mdfPatternTemplates;
  return saved && saved.length > 0 ? saved : DEFAULT_MDF_PATTERN_TEMPLATES;
}

/** The template an order's «Узор» name is, ignoring case and stray spaces — undefined for a name typed by hand. */
export function findMdfPatternTemplate(
  templates: readonly MdfPatternTemplate[],
  name: string,
): MdfPatternTemplate | undefined {
  const key = name.trim().toLowerCase();
  if (!key) return undefined;
  return templates.find((t) => t.name.trim().toLowerCase() === key);
}

/**
 * What an order is milled with, for the journal and the stations: the «Узор» the journal wrote
 * down, or — on a customer's own order — the patterns of its panels. Empty when neither says.
 */
export function mdfPatternOf(order: { mdfPatternName?: string; mdfPanels?: readonly Pick<MdfPanel, "pattern">[] }): string {
  const typed = order.mdfPatternName?.trim();
  if (typed) return typed;
  return [...new Set((order.mdfPanels ?? []).map((p) => MDF_PATTERN_LABELS[p.pattern]))].join(", ");
}

/**
 * Checks an edited template list before it is saved: every row named and priced, no name twice
 * (the journal picks a template by its name). Returns what is wrong, or null when it can be saved.
 */
export function mdfTemplatesProblem(templates: readonly MdfPatternTemplate[]): string | null {
  if (templates.length === 0) return "Кемінде бір узор керек";
  const seen = new Set<string>();
  for (const t of templates) {
    const key = t.name.trim().toLowerCase();
    if (!key) return "Узор аты жазылмаған";
    if (!(t.pricePerM2Tiyn > 0)) return `«${t.name.trim()}»: м² бағасы жазылмаған`;
    if (seen.has(key)) return `«${t.name.trim()}» екі рет жазылған`;
    seen.add(key);
  }
  return null;
}

/** A panel's cost at the shop's fixed rate for its pattern, or undefined when that pattern has no
 *  fixed price (see MDF_PATTERN_PRICE_TIYN). */
export function mdfPanelCostTiyn(
  panel: Pick<MdfPanel, "lengthMm" | "widthMm" | "qty" | "pattern">,
): number | undefined {
  const priceTiyn = MDF_PATTERN_PRICE_TIYN[panel.pattern];
  if (priceTiyn === undefined) return undefined;
  const areaM2 = (panel.lengthMm / 1000) * (panel.widthMm / 1000) * panel.qty;
  return Math.round(areaM2 * priceTiyn);
}

/**
 * Sum of every panel's fixed-price cost — or undefined the moment even one panel's pattern has no
 * fixed price. All-or-nothing on purpose: a mixed order still needs the Manager to quote the whole
 * job, not just the one panel that happens to be "Басқа".
 *
 * This is what lets MdfOrderBuilder.tsx show the customer a real total and submit straight to
 * WAITING_PAYMENT (pricePublished: true) whenever every panel is a known pattern.
 */
export function computeMdfPanelsCostTiyn(
  panels: readonly Pick<MdfPanel, "lengthMm" | "widthMm" | "qty" | "pattern">[],
): number | undefined {
  let totalTiyn = 0;
  for (const panel of panels) {
    const cost = mdfPanelCostTiyn(panel);
    if (cost === undefined) return undefined;
    totalTiyn += cost;
  }
  return totalTiyn;
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

/**
 * The area as the counter types it: «13,34», or the pieces it was measured in, «2,5 + 3,1 + 0,8».
 * A comma or a point for the decimals; empty is 0. Null while it is not yet a number — «2,5+» half
 * typed — so the caller keeps the last good figure instead of saving a wrong one.
 */
export function parseMdfArea(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "") return 0;
  let sum = 0;
  for (const raw of trimmed.split("+")) {
    const part = raw.trim().replace(",", ".");
    if (!/^(\d+(\.\d*)?|\.\d+)$/.test(part)) return null;
    sum += Number(part);
  }
  // Summing decimals carries float noise (2.5 + 3.1 = 5.6000000000000005); four places is far
  // finer than any panel is measured to.
  return Math.round(sum * 10000) / 10000;
}

/** An area back into the cell as it would be typed: «13,34», no trailing zeros. */
export function formatMdfAreaInput(areaM2: number): string {
  return areaM2 ? String(Math.round(areaM2 * 10000) / 10000).replace(".", ",") : "";
}

/** Where a МДФ order is on the floor, in the counter's words. */
const MDF_STATION_WHERE: Record<MdfStage, string> = {
  cnc: "ЧПУ-да",
  sanding: "Шкуркада",
  painting: "Краскада",
  vacuum: "Вакуумда",
};

export function mdfStationLabel(order: Pick<Order, "productionStatus" | "mdfStage">): string {
  if (order.productionStatus === "ready") return "Дайын";
  if (order.productionStatus === "delivered") return "Берілді";
  if (order.productionStatus === "mdf_production" && order.mdfStage) return MDF_STATION_WHERE[order.mdfStage];
  return "Жіберілмеді";
}

/**
 * The МДФ row's three dots — money in, on the floor, finished — the same read-out the ЛДСП ledger
 * gives (lib/journalFilters.ts journalProgress), with the four stations folded into one «Өндіріс».
 */
export function mdfJournalProgress(order: Pick<Order, "productionStatus" | "totalTiyn">, paidTiyn: number): ProgressStep[] {
  const s = order.productionStatus;
  const cancelled = s === "cancelled";
  const finished = s === "ready" || s === "delivered";
  const owing = order.totalTiyn - paidTiyn;
  const payment: StepState = cancelled ? "blocked" : owing <= 0 ? "done" : paidTiyn > 0 ? "active" : "blocked";
  const production: StepState = cancelled ? "blocked" : finished ? "done" : s === "mdf_production" ? "active" : "todo";
  const ready: StepState = cancelled ? "blocked" : finished ? "done" : "todo";
  return [
    { key: "payment", label: "Төлем", state: payment },
    { key: "cutting", label: "Өндіріс", state: production },
    { key: "ready", label: "Дайын", state: ready },
  ];
}

/** The МДФ journal's chips. */
export type MdfQuickFilter = "all" | "debt" | "paid" | "production" | "ready";
export const MDF_QUICK_FILTERS: { id: MdfQuickFilter; label: string }[] = [
  { id: "all", label: "Барлығы" },
  { id: "debt", label: "Қарыз" },
  { id: "paid", label: "Төленді" },
  { id: "production", label: "Өндірісте" },
  { id: "ready", label: "Дайын" },
];

export function mdfMatchesQuickFilter(
  order: Pick<Order, "productionStatus" | "totalTiyn">,
  paidTiyn: number,
  filter: MdfQuickFilter,
): boolean {
  switch (filter) {
    case "all":
      return true;
    case "debt":
      return order.totalTiyn - paidTiyn > 0;
    case "paid":
      return order.totalTiyn > 0 && paidTiyn >= order.totalTiyn;
    case "production":
      return order.productionStatus === "mdf_production";
    case "ready":
      return order.productionStatus === "ready" || order.productionStatus === "delivered";
  }
}
