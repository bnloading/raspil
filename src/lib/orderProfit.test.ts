import { describe, it, expect } from "vitest";
import { Timestamp } from "firebase/firestore";
import { computeOrderProfits, pvcCostKey, pvcOf, PVC_DEFAULT_COST_KEY } from "./orderProfit";
import type { Order, OrderMaterialLine } from "../types/domain";

const T = (n: number) => n * 100; // ₸ → tiyn
const at = (iso: string) => Timestamp.fromDate(new Date(`${iso}T12:00:00+05:00`));

function order(overrides: Partial<Order> = {}): Order {
  return {
    id: "o1",
    orderNumber: "001",
    customerName: "Алмат",
    customerPhone: "77001112233",
    materialId: "ldsp",
    materialSnapshot: { name: "ЛДСП Ақ", article: "", color: "Ақ", thicknessMm: 16, sheetLengthMm: 2750, sheetWidthMm: 1830, sellingPriceTiyn: T(16500) },
    productionStatus: "ready",
    paymentStatus: "paid",
    priority: 0,
    estimatedSheets: 0,
    pvcMetersTotal: 0,
    materialCostTiyn: 0,
    cuttingCostTiyn: 0,
    pvcCostTiyn: 0,
    hdfCostTiyn: 0,
    extraServicesTiyn: 0,
    deliveryCostTiyn: 0,
    discountTiyn: 0,
    totalTiyn: 0,
    paidTiyn: 0,
    debtTiyn: 0,
    createdAt: at("2026-09-24"),
    pricePublished: true,
    isDraft: false,
    ...overrides,
  } as Order;
}

const line = (l: Partial<OrderMaterialLine>): OrderMaterialLine => ({
  materialId: "ldsp", materialName: "ЛДСП Ақ", sheetQty: 0, sheetPriceTiyn: 0, pvcMeters: 0, pvcPricePerMeterTiyn: 0, ...l,
});

const costs = new Map<string, number>([
  ["ldsp", T(12000)],
  ["hdf", T(4000)],
  [pvcCostKey("white04"), T(60)],
  [PVC_DEFAULT_COST_KEY, T(90)],
]);

describe("computeOrderProfits", () => {
  it("costs each line of a merged order at its own material's wholesale price", () => {
    const s = computeOrderProfits({
      orders: [order({ totalTiyn: T(200000), items: [line({ materialId: "ldsp", sheetQty: 10 }), line({ materialId: "hdf", sheetQty: 3 })] })],
      costs,
    });
    expect(s.sheetCostTiyn).toBe(T(10 * 12000 + 3 * 4000));
    expect(s.profitTiyn).toBe(T(200000 - 132000));
    expect(s.materials.find((m) => m.materialId === "hdf")).toMatchObject({ sheets: 3, costTiyn: T(12000) });
  });

  it("costs ПВХ by colour, falling back to the default price for colours without one and for metres with no colour", () => {
    const s = computeOrderProfits({
      orders: [order({
        totalTiyn: T(50000),
        pvcMetersTotal: 150,
        items: [
          line({ pvcMeters: 100, pvcTypeId: "white04" }),
          line({ pvcMeters: 30, pvcTypeId: "oak1" }),
          line({ pvcMeters: 20 }),
        ],
      })],
      costs,
    });
    expect(s.pvcCostTiyn).toBe(T(100 * 60 + 30 * 90 + 20 * 90));
    expect(s.pvc.find((p) => p.pvcTypeId === "oak1")).toMatchObject({ meters: 30, wholesaleTiyn: T(90), ownPrice: false });
    expect(s.pvc.at(-1)).toMatchObject({ pvcTypeId: null, meters: 20 });
    expect(s.uncostedPvcMeters).toBe(0);
  });

  it("reads the colour split off pvcByType for orders built from parts, without counting the metres twice", () => {
    const o = order({
      pvcMetersTotal: 89,
      pvcByType: [{ pvcTypeId: "white04", colorName: "Ақ", thicknessMm: 0.4, meters: 89, costTiyn: 0 }],
    });
    expect(pvcOf(o).byType.get("white04")?.meters).toBe(89);
    expect(pvcOf(o).unknown.meters).toBe(0);
    expect(computeOrderProfits({ orders: [o], costs }).pvcCostTiyn).toBe(T(89 * 60));
  });

  it("reports sheets and metres it could not cost, except on materials that are not shop stock", () => {
    const s = computeOrderProfits({
      orders: [order({ items: [line({ materialId: "new", sheetQty: 4 }), line({ materialId: "own", sheetQty: 2, pvcMeters: 12, pvcTypeId: "x" })] })],
      costs: new Map([["ldsp", T(12000)]]),
      freeMaterialIds: new Set(["own"]),
    });
    expect(s.uncostedSheets).toBe(4);
    expect(s.uncostedPvcMeters).toBe(12);
  });

  it("counts from the start day inclusive and skips drafts and cancellations", () => {
    const s = computeOrderProfits({
      orders: [
        order({ id: "before", orderNumber: "1", totalTiyn: T(1), createdAt: at("2026-09-21") }),
        order({ id: "start", orderNumber: "2", totalTiyn: T(10), createdAt: at("2026-09-22") }),
        order({ id: "later", orderNumber: "3", totalTiyn: T(100), createdAt: at("2026-09-25"), debtTiyn: T(40) }),
        order({ id: "draft", orderNumber: "4", totalTiyn: T(1000), productionStatus: "draft" }),
        order({ id: "gone", orderNumber: "5", totalTiyn: T(1000), productionStatus: "cancelled" }),
      ],
      costs,
    });
    expect(s.orders.map((r) => r.orderId)).toEqual(["later", "start"]);
    expect(s.revenueTiyn).toBe(T(110));
    expect(s.debtTiyn).toBe(T(40));
  });

  it("treats an unmerged order as its single material line", () => {
    const s = computeOrderProfits({
      orders: [order({ totalTiyn: T(100000), estimatedSheets: 5, pvcMetersTotal: 40 })],
      costs,
    });
    expect(s.sheetCostTiyn).toBe(T(5 * 12000));
    expect(s.pvcCostTiyn).toBe(T(40 * 90));
    expect(s.profitTiyn).toBe(T(100000 - 60000 - 3600));
  });
});

describe("the per-material breakdown", () => {
  // "Ақ: 16 200 − 13 000 = 3 200 ₸ × 45 лист" — the owner's own example.
  it("is sale minus wholesale, times the quantity, per sheet and per ПВХ colour", () => {
    const s = computeOrderProfits({
      orders: [
        order({ id: "a", orderNumber: "1", totalTiyn: T(20 * 16200 + 100 * 150 + 20 * 2000), cuttingCostTiyn: T(20 * 2000), pvcCostTiyn: T(100 * 150),
          pvcMetersTotal: 100, items: [line({ materialId: "ldsp", sheetQty: 20, sheetPriceTiyn: T(16200), pvcMeters: 100, pvcPricePerMeterTiyn: T(150), pvcTypeId: "white04" })] }),
        order({ id: "b", orderNumber: "2", totalTiyn: T(25 * 16200), items: [line({ materialId: "ldsp", sheetQty: 25, sheetPriceTiyn: T(16200) })] }),
      ],
      costs: new Map([["ldsp", T(13000)], [pvcCostKey("white04"), T(60)]]),
    });
    expect(s.materials[0]).toMatchObject({ sheets: 45, revenueTiyn: T(45 * 16200), wholesaleTiyn: T(13000), profitTiyn: T(45 * 3200), minPriceTiyn: T(16200), maxPriceTiyn: T(16200) });
    expect(s.pvc[0]).toMatchObject({ meters: 100, profitTiyn: T(100 * 90) });
    expect(s.cuttingTiyn).toBe(T(40000));
    expect(s.otherTiyn).toBe(0);
  });

  it("always adds up to the headline figure — discounts, delivery and прифуговка included", () => {
    const s = computeOrderProfits({
      orders: [order({
        totalTiyn: T(10 * 16500 + 50 * 200 + 5000 + 3000 - 7000),
        pvcCostTiyn: T(50 * 200), pvcMetersTotal: 50, cuttingCostTiyn: T(5000), deliveryCostTiyn: T(3000), discountTiyn: T(7000),
        items: [line({ materialId: "ldsp", sheetQty: 10, sheetPriceTiyn: T(16500), pvcMeters: 50, pvcPricePerMeterTiyn: T(150), pvcTypeId: "white04", pvcJointed: true })],
      })],
      costs,
    });
    // The 50 ₸/м jointing surcharge is billed as ПВХ but belongs to no roll: it lands on the no-colour row.
    expect(s.pvc.find((p) => p.pvcTypeId === null)).toMatchObject({ meters: 0, revenueTiyn: T(50 * 50) });
    expect(s.otherTiyn).toBe(T(3000 - 7000));
    expect(s.sheetProfitTiyn + s.pvcProfitTiyn + s.cuttingTiyn + s.otherTiyn).toBe(s.profitTiyn);
  });
});

describe("столешница", () => {
  it("is counted per piece and reported apart from the board sheets, and still adds up", () => {
    const s = computeOrderProfits({
      orders: [order({
        totalTiyn: T(10 * 16200 + 2 * 45000),
        items: [line({ materialId: "ldsp", sheetQty: 10, sheetPriceTiyn: T(16200) }), line({ materialId: "top", materialName: "Столешница Ақ", sheetQty: 2, sheetPriceTiyn: T(45000) })],
      })],
      costs: new Map([["ldsp", T(13000)], ["top", T(38000)]]),
      countertopIds: new Set(["top"]),
    });
    expect(s.orders[0]).toMatchObject({ sheets: 10, countertops: 2 });
    expect(s.materials.find((m) => m.materialId === "top")).toMatchObject({ countertop: true, sheets: 2, profitTiyn: T(2 * 7000) });
    expect(s.sheetProfitTiyn).toBe(T(10 * 3200));
    expect(s.countertopProfitTiyn).toBe(T(2 * 7000));
    expect(s.sheetProfitTiyn + s.countertopProfitTiyn + s.pvcProfitTiyn + s.cuttingTiyn + s.otherTiyn).toBe(s.profitTiyn);
  });

  it("flags a countertop with no wholesale as a missing countertop price, not a missing sheet", () => {
    const s = computeOrderProfits({
      orders: [order({ items: [line({ materialId: "top", sheetQty: 1, sheetPriceTiyn: T(45000) })] })],
      costs: new Map(),
      countertopIds: new Set(["top"]),
    });
    expect(s.uncostedCountertops).toBe(1);
    expect(s.uncostedSheets).toBe(0);
  });
});
