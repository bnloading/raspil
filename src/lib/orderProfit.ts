import { dayKey, formatDateDMY } from "./dates";
import { formatMoney } from "./money";
import { linesOf } from "./orderMerge";
import type { Order } from "../types/domain";

/**
 * "Таза пайда" as the owner counts it: what each sheet and each metre of ПВХ was sold for, less
 * what it was bought for wholesale, times how many went out — "Ақ: 16 200 − 13 000 = 3 200 ₸,
 * × 45 лист". Cutting and the other charges on an order have no wholesale cost and count whole.
 *
 * Every order's total splits exactly into those parts (lib/journal.ts computeJournalRowTotals:
 * sheets + ПВХ + ХДФ + распил + қызмет + жеткізу − жеңілдік), so the per-material rows, the
 * per-order rows and the headline figure are three views of one sum and always agree.
 *
 * This is deliberately not lib/finance.ts's computeFinanceSummary, which subtracts percentage
 * set-asides and the Касса expense log and never costed ПВХ at all.
 */

/** Counted from the day the shop's books restarted (scripts/cash-restart-2026-09-22.mjs),
 *  that day included — the owner's own cut-off for this figure. */
export const PROFIT_START_DATE = "2026-09-22";

/**
 * ПВХ wholesale prices live in `materialCosts` beside the sheets' own, under `pvc_<pvcTypeId>`.
 * That collection is the one firestore.rules already keeps Admin-only, which is exactly the
 * protection a purchase price needs — a separate collection would be one more rule to get right.
 */
export const pvcCostKey = (pvcTypeId: string) => `pvc_${pvcTypeId}`;
/** One per-metre price for every colour that has none of its own, and for metres typed with no
 *  colour at all — so a single number is enough to cost all the banding. */
export const PVC_DEFAULT_COST_KEY = "pvc_default";

interface PvcPart {
  meters: number;
  /** What the customer was billed for these metres. */
  revenueTiyn: number;
  name: string;
}

/**
 * The ПВХ on one order, by colour: metres and what they were billed at. `unknown` is whatever the
 * colours do not account for — metres typed with no colour, and the per-metre jointing surcharge
 * (прифуговка), which is billed as ПВХ but belongs to no roll.
 */
export function pvcOf(order: Order): { byType: Map<string, PvcPart>; unknown: PvcPart } {
  const byType = new Map<string, PvcPart>();
  const add = (id: string, meters: number, revenueTiyn: number, name: string) => {
    const part = byType.get(id);
    if (part) {
      part.meters += meters;
      part.revenueTiyn += revenueTiyn;
    } else byType.set(id, { meters, revenueTiyn, name });
  };
  const lines = linesOf(order);
  // Orders built from parts carry the colour split in pvcByType; journal rows carry it per line
  // and write the same split to pvcByType. Never both for one order — a parts order's single
  // synthetic line has no colour — so pvcByType wins whenever it is there.
  if (order.pvcByType && order.pvcByType.length > 0) {
    for (const use of order.pvcByType) {
      if (use.meters > 0) add(use.pvcTypeId, use.meters, use.costTiyn ?? 0, `${use.colorName} · ${use.thicknessMm} мм`);
    }
  } else {
    for (const line of lines) {
      if (line.pvcMeters > 0 && line.pvcTypeId) {
        add(line.pvcTypeId, line.pvcMeters, Math.round(line.pvcMeters * line.pvcPricePerMeterTiyn), line.pvcColorName ?? "");
      }
    }
  }
  const parts = [...byType.values()];
  const meters = Math.max(order.pvcMetersTotal ?? 0, lines.reduce((s, l) => s + (l.pvcMeters ?? 0), 0));
  const billed = order.pvcCostTiyn ?? lines.reduce((s, l) => s + Math.round(l.pvcMeters * l.pvcPricePerMeterTiyn), 0);
  const unknownMeters = meters - parts.reduce((s, p) => s + p.meters, 0);
  return {
    byType,
    unknown: {
      meters: unknownMeters > 0.005 ? unknownMeters : 0,
      revenueTiyn: billed - parts.reduce((s, p) => s + p.revenueTiyn, 0),
      name: "",
    },
  };
}

/** One sheet material over the period: "ЛДСП Ақ — 45 лист, 16 200 − 13 000 = 3 200 ₸/лист".
 *  A столешница is the same sum per piece, and `sheets` counts pieces. */
export interface MaterialProfit {
  materialId: string;
  name: string;
  countertop: boolean;
  sheets: number;
  revenueTiyn: number;
  /** Wholesale ₸ per sheet — 0 when none has been entered. */
  wholesaleTiyn: number;
  costTiyn: number;
  profitTiyn: number;
  /** Lowest and highest price it was actually sold at — different when a deal was struck. */
  minPriceTiyn: number;
  maxPriceTiyn: number;
}

/** One ПВХ colour over the period; `pvcTypeId` null is the metres with no colour (and прифуговка). */
export interface PvcProfit {
  pvcTypeId: string | null;
  name: string;
  meters: number;
  revenueTiyn: number;
  /** Wholesale ₸ per metre actually applied: the colour's own, else the general one, else 0. */
  wholesaleTiyn: number;
  /** Whether wholesaleTiyn is this colour's own price rather than the general one. */
  ownPrice: boolean;
  costTiyn: number;
  profitTiyn: number;
}

export interface OrderProfit {
  orderId: string;
  orderNumber: string;
  customerName: string;
  createdAt?: Order["createdAt"];
  revenueTiyn: number;
  sheetCostTiyn: number;
  pvcCostTiyn: number;
  profitTiyn: number;
  debtTiyn: number;
  /** Board sheets, столешница excluded. */
  sheets: number;
  /** Столешница pieces. */
  countertops: number;
  pvcMeters: number;
  /** Sheets on this order whose material has no wholesale price — costed at 0. */
  uncostedSheets: number;
  uncostedCountertops: number;
  /** Metres on this order with no wholesale price, own or general — costed at 0. */
  uncostedPvcMeters: number;
}

export interface ProfitSummary {
  startDate: string;
  /** Newest first. */
  orders: OrderProfit[];
  revenueTiyn: number;
  sheetCostTiyn: number;
  pvcCostTiyn: number;
  profitTiyn: number;
  debtTiyn: number;
  uncostedSheets: number;
  uncostedCountertops: number;
  uncostedPvcMeters: number;
  /** Most sold first — sheets and столешница both; `countertop` tells them apart. */
  materials: MaterialProfit[];
  /** Most metres first; the no-colour row, if any, last. */
  pvc: PvcProfit[];
  /** Board sheets only. */
  sheetProfitTiyn: number;
  countertopProfitTiyn: number;
  pvcProfitTiyn: number;
  /** Распил — billed, no wholesale cost. */
  cuttingTiyn: number;
  /** ХДФ, extra services and delivery, less discounts — whatever else the totals carry. */
  otherTiyn: number;
}

/**
 * `costs` is useMaterialCosts()'s map: material id → wholesale ₸ per sheet, and pvcCostKey(id) /
 * PVC_DEFAULT_COST_KEY → wholesale ₸ per metre, all in tiyn.
 *
 * `freeMaterialIds` are materials that are not shop stock (a customer's own board, offcuts —
 * Material.stockTracked === false): a zero price on those is true, not missing, so they are never
 * reported as uncosted.
 *
 * `countertopIds` are the столешница materials (Material.category "countertop"): sold per piece,
 * so they are counted and reported apart from the board sheets rather than as more "лист".
 */
export function computeOrderProfits({
  orders,
  costs,
  freeMaterialIds = new Set(),
  countertopIds = new Set(),
  startDate = PROFIT_START_DATE,
}: {
  orders: Order[];
  costs: ReadonlyMap<string, number>;
  freeMaterialIds?: ReadonlySet<string>;
  countertopIds?: ReadonlySet<string>;
  startDate?: string;
}): ProfitSummary {
  const defaultPvc = costs.get(PVC_DEFAULT_COST_KEY) ?? 0;
  const pvcPrice = (pvcTypeId: string | null) => {
    const own = pvcTypeId ? costs.get(pvcCostKey(pvcTypeId)) ?? 0 : 0;
    return { price: own > 0 ? own : defaultPvc, own: own > 0 };
  };

  const materials = new Map<string, MaterialProfit>();
  const pvc = new Map<string | null, PvcProfit>();
  let cuttingTiyn = 0;
  let otherTiyn = 0;

  const rows: OrderProfit[] = [];
  for (const order of orders) {
    if (order.productionStatus === "draft" || order.productionStatus === "cancelled") continue;
    if (!order.createdAt || dayKey(order.createdAt) < startDate) continue;

    // Sheets, line by line at the price each line was billed at. An order with no `items` is
    // one line, billed as materialCostTiyn.
    const lines = linesOf(order);
    const hasItems = !!order.items && order.items.length > 0;
    let sheets = 0;
    let countertops = 0;
    let sheetRevenueTiyn = 0;
    let sheetCostTiyn = 0;
    let uncostedSheets = 0;
    let uncostedCountertops = 0;
    for (const line of lines) {
      const qty = line.sheetQty ?? 0;
      if (qty <= 0) continue;
      const countertop = countertopIds.has(line.materialId);
      const revenue = hasItems ? Math.round(qty * line.sheetPriceTiyn) : order.materialCostTiyn ?? 0;
      const unitPrice = Math.round(revenue / qty);
      const wholesale = costs.get(line.materialId) ?? 0;
      const cost = qty * wholesale;
      if (countertop) countertops += qty;
      else sheets += qty;
      sheetRevenueTiyn += revenue;
      sheetCostTiyn += cost;
      if (wholesale <= 0 && !freeMaterialIds.has(line.materialId)) {
        if (countertop) uncostedCountertops += qty;
        else uncostedSheets += qty;
      }

      const m = materials.get(line.materialId);
      if (m) {
        m.sheets += qty;
        m.revenueTiyn += revenue;
        m.costTiyn += cost;
        m.minPriceTiyn = Math.min(m.minPriceTiyn, unitPrice);
        m.maxPriceTiyn = Math.max(m.maxPriceTiyn, unitPrice);
      } else {
        materials.set(line.materialId, {
          materialId: line.materialId, name: line.materialName, countertop, sheets: qty, revenueTiyn: revenue,
          wholesaleTiyn: wholesale, costTiyn: cost, profitTiyn: 0, minPriceTiyn: unitPrice, maxPriceTiyn: unitPrice,
        });
      }
    }

    // ПВХ, colour by colour, and whatever the colours leave over.
    const { byType, unknown } = pvcOf(order);
    let pvcMeters = 0;
    let pvcRevenueTiyn = 0;
    let pvcCostTiyn = 0;
    let uncostedPvcMeters = 0;
    const addPvc = (pvcTypeId: string | null, part: PvcPart) => {
      const { price, own } = pvcPrice(pvcTypeId);
      const cost = Math.round(part.meters * price);
      pvcMeters += part.meters;
      pvcRevenueTiyn += part.revenueTiyn;
      pvcCostTiyn += cost;
      if (price <= 0) uncostedPvcMeters += part.meters;
      const p = pvc.get(pvcTypeId);
      if (p) {
        p.meters += part.meters;
        p.revenueTiyn += part.revenueTiyn;
        p.costTiyn += cost;
      } else {
        pvc.set(pvcTypeId, {
          pvcTypeId, name: part.name, meters: part.meters, revenueTiyn: part.revenueTiyn,
          wholesaleTiyn: price, ownPrice: own, costTiyn: cost, profitTiyn: 0,
        });
      }
    };
    for (const [pvcTypeId, part] of byType) addPvc(pvcTypeId, part);
    if (unknown.meters > 0 || unknown.revenueTiyn !== 0) addPvc(null, unknown);

    // Everything else on the total: распил, then ХДФ/қызмет/жеткізу less жеңілдік.
    const revenueTiyn = order.totalTiyn ?? 0;
    const cutting = order.cuttingCostTiyn ?? 0;
    cuttingTiyn += cutting;
    otherTiyn += revenueTiyn - sheetRevenueTiyn - pvcRevenueTiyn - cutting;

    rows.push({
      orderId: order.id,
      orderNumber: order.orderNumber,
      customerName: order.customerName,
      createdAt: order.createdAt,
      revenueTiyn,
      sheetCostTiyn,
      pvcCostTiyn,
      profitTiyn: revenueTiyn - sheetCostTiyn - pvcCostTiyn,
      debtTiyn: Math.max(0, order.debtTiyn ?? 0),
      sheets,
      countertops,
      pvcMeters,
      uncostedSheets,
      uncostedCountertops,
      uncostedPvcMeters,
    });
  }

  rows.sort((a, b) => (b.createdAt?.seconds ?? 0) - (a.createdAt?.seconds ?? 0) || b.orderNumber.localeCompare(a.orderNumber));
  const sum = <T,>(list: T[], pick: (r: T) => number) => list.reduce((s, r) => s + pick(r), 0);

  const materialRows = [...materials.values()]
    .map((m) => ({ ...m, profitTiyn: m.revenueTiyn - m.costTiyn }))
    .sort((a, b) => b.sheets - a.sheets);
  const pvcRows = [...pvc.values()]
    .map((p) => ({ ...p, profitTiyn: p.revenueTiyn - p.costTiyn }))
    .sort((a, b) => (a.pvcTypeId === null ? 1 : 0) - (b.pvcTypeId === null ? 1 : 0) || b.meters - a.meters);

  return {
    startDate,
    orders: rows,
    revenueTiyn: sum(rows, (r) => r.revenueTiyn),
    sheetCostTiyn: sum(rows, (r) => r.sheetCostTiyn),
    pvcCostTiyn: sum(rows, (r) => r.pvcCostTiyn),
    profitTiyn: sum(rows, (r) => r.profitTiyn),
    debtTiyn: sum(rows, (r) => r.debtTiyn),
    uncostedSheets: sum(rows, (r) => r.uncostedSheets),
    uncostedCountertops: sum(rows, (r) => r.uncostedCountertops),
    uncostedPvcMeters: sum(rows, (r) => r.uncostedPvcMeters),
    materials: materialRows,
    pvc: pvcRows,
    sheetProfitTiyn: sum(materialRows.filter((m) => !m.countertop), (m) => m.profitTiyn),
    countertopProfitTiyn: sum(materialRows.filter((m) => m.countertop), (m) => m.profitTiyn),
    pvcProfitTiyn: sum(pvcRows, (p) => p.profitTiyn),
    cuttingTiyn,
    otherTiyn,
  };
}

/** "89,5 м" */
export const formatMeters = (m: number) => `${m.toLocaleString("ru-RU", { maximumFractionDigits: 1 })} м`;
/** "2026-09-22" → "22.09.2026" */
export const formatStartDate = (day: string) => formatDateDMY(new Date(`${day}T12:00:00+05:00`));
/** "+144 000 ₸" / "−5 000 ₸" — a profit line says which way it went. */
export const signedMoney = (tiyn: number) => (tiyn < 0 ? `−${formatMoney(-tiyn)}` : `+${formatMoney(tiyn)}`);
