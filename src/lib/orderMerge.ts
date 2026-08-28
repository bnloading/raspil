import type { Order, OrderMaterialLine } from "../types/domain";

/**
 * Merging several journal rows into one order.
 *
 * A walk-in who buys 5 sheets of Ақ, 3 of ХДФ and 5 of Кашемир is placing ONE order, but the
 * journal is a row-per-material ledger, so typing that produces three rows and — until this — three
 * separate orders reaching the cutter as Заказ-1, Заказ-2, Заказ-3.
 *
 * Merging keeps the earliest row as the surviving order, folds the rest in as `items[]` lines, and
 * sums the money. Everything here is pure so the arithmetic and the refusals are testable; the
 * caller performs the writes.
 */

/** Why a set of rows cannot be merged, in a form the UI can show directly. */
export type MergeRefusal = string;

export interface MergePlan {
  /** The order that survives, with its merged fields. */
  keepId: string;
  /** Fields to write onto the surviving order. */
  update: {
    items: OrderMaterialLine[];
    estimatedSheets: number;
    confirmedSheets: number;
    pvcMetersTotal: number;
    materialCostTiyn: number;
    pvcCostTiyn: number;
    cuttingCostTiyn: number;
    hdfCostTiyn: number;
    extraServicesTiyn: number;
    deliveryCostTiyn: number;
    discountTiyn: number;
    totalTiyn: number;
    paidTiyn: number;
    debtTiyn: number;
  };
  /** Orders absorbed into `keepId`, to be cancelled by the caller. */
  absorbedIds: string[];
}

/** The material line an order already represents on its own. */
export function lineFromOrder(order: Order): OrderMaterialLine {
  return {
    materialId: order.materialId,
    materialName: order.materialSnapshot?.name ?? "",
    sheetQty: order.confirmedSheets ?? order.estimatedSheets ?? 0,
    sheetPriceTiyn: order.materialSnapshot?.sellingPriceTiyn ?? 0,
    pvcMeters: order.pvcMetersTotal ?? 0,
    pvcPricePerMeterTiyn: order.pvcPricePerMeterTiyn ?? 0,
  };
}

/** Every line an order carries: its own `items` when it has them, else the single material. */
export function linesOf(order: Order): OrderMaterialLine[] {
  return order.items && order.items.length > 0 ? order.items : [lineFromOrder(order)];
}

/** Normalised customer key — merging is only ever valid within one customer. */
function customerKey(order: Order): string {
  const phone = (order.customerPhone ?? "").replace(/\D/g, "");
  if (phone) return `phone:${phone}`;
  return `name:${(order.customerName ?? "").trim().toLowerCase()}`;
}

/** Statuses past which an order is already on the shop floor and must not be restructured. */
const IN_PRODUCTION = new Set([
  "cutting_started",
  "cutting_completed",
  "pvc_queue",
  "pvc_started",
  "pvc_completed",
  "ready",
  "delivered",
]);

/**
 * Checks the rows and returns either a plan or the reason it is refused.
 *
 * Refusals are deliberate rather than best-effort fixes: silently merging orders from different
 * customers, or restructuring one the cutter has already started, would be worse than doing
 * nothing.
 */
export function planMerge(orders: Order[]): { plan: MergePlan } | { refusal: MergeRefusal } {
  if (orders.length < 2) return { refusal: "Кемінде екі жол таңдаңыз" };

  const keys = new Set(orders.map(customerKey));
  if (keys.size > 1) return { refusal: "Тек бір клиенттің жолдарын біріктіруге болады" };

  if (orders.some((o) => o.productionStatus === "cancelled")) {
    return { refusal: "Бас тартылған заказды біріктіруге болмайды" };
  }
  const started = orders.find((o) => IN_PRODUCTION.has(o.productionStatus));
  if (started) return { refusal: `${started.orderNumber} өндіріске кеткен — біріктіруге болмайды` };

  // The earliest row survives, so the customer keeps the order number they were already given.
  const sorted = [...orders].sort((a, b) => (a.createdAt?.seconds ?? 0) - (b.createdAt?.seconds ?? 0));
  const keep = sorted[0];
  const absorbed = sorted.slice(1);

  const items = sorted.flatMap(linesOf);
  const sum = (pick: (o: Order) => number) => sorted.reduce((s, o) => s + (pick(o) || 0), 0);

  const totalTiyn = sum((o) => o.totalTiyn);
  const paidTiyn = sum((o) => o.paidTiyn);

  return {
    plan: {
      keepId: keep.id,
      update: {
        items,
        estimatedSheets: items.reduce((s, i) => s + i.sheetQty, 0),
        confirmedSheets: items.reduce((s, i) => s + i.sheetQty, 0),
        pvcMetersTotal: items.reduce((s, i) => s + i.pvcMeters, 0),
        materialCostTiyn: sum((o) => o.materialCostTiyn),
        pvcCostTiyn: sum((o) => o.pvcCostTiyn),
        cuttingCostTiyn: sum((o) => o.cuttingCostTiyn),
        hdfCostTiyn: sum((o) => o.hdfCostTiyn),
        extraServicesTiyn: sum((o) => o.extraServicesTiyn),
        deliveryCostTiyn: sum((o) => o.deliveryCostTiyn),
        discountTiyn: sum((o) => o.discountTiyn),
        totalTiyn,
        paidTiyn,
        // Recomputed rather than summed: an overpaid row and an unpaid row must net out, not
        // carry a negative debt across.
        debtTiyn: Math.max(0, totalTiyn - paidTiyn),
      },
      absorbedIds: absorbed.map((o) => o.id),
    },
  };
}

/** "5 лист ЛДСП Ақ · 3 лист ХДФ · 5 лист Кашемир" — the merged order in one line. */
export function describeLines(lines: OrderMaterialLine[]): string {
  return lines
    .filter((l) => l.sheetQty > 0 || l.materialName)
    .map((l) => `${l.sheetQty} лист ${l.materialName}`.trim())
    .join(" · ");
}
