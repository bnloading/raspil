import { describe, it, expect } from "vitest";
import { Timestamp } from "firebase/firestore";
import { planMerge, linesOf, lineFromOrder, describeLines } from "./orderMerge";
import type { Order } from "../types/domain";

const T = (n: number) => n * 100;
const at = (sec: number) => Timestamp.fromMillis(sec * 1000);

function order(overrides: Partial<Order> = {}): Order {
  return {
    id: "o1",
    orderNumber: "ORD-2026-000001",
    customerName: "Асет",
    customerPhone: "77747412808",
    materialId: "ldsp-ak",
    materialSnapshot: {
      name: "ЛДСП Ақ", article: "AK-001", color: "Ақ",
      thicknessMm: 16, sheetLengthMm: 2750, sheetWidthMm: 1830, sellingPriceTiyn: T(16500),
    },
    productionStatus: "waiting_payment",
    paymentStatus: "unpaid",
    priority: 0,
    estimatedSheets: 5,
    confirmedSheets: 5,
    pvcMetersTotal: 0,
    materialCostTiyn: T(82500), cuttingCostTiyn: 0, pvcCostTiyn: 0, hdfCostTiyn: 0,
    extraServicesTiyn: 0, deliveryCostTiyn: 0, discountTiyn: 0,
    totalTiyn: T(82500), paidTiyn: 0, debtTiyn: T(82500),
    createdAt: at(1000),
    pricePublished: true,
    isDraft: false,
    ...overrides,
  };
}

const asetAk = order({ id: "a", orderNumber: "ORD-2026-000021", createdAt: at(1000) });
const asetHdf = order({
  id: "b", orderNumber: "ORD-2026-000022", createdAt: at(2000),
  materialId: "hdf-white",
  materialSnapshot: { ...asetAk.materialSnapshot, name: "ХДФ", sellingPriceTiyn: T(7500) },
  estimatedSheets: 3, confirmedSheets: 3,
  materialCostTiyn: T(22500), totalTiyn: T(22500), debtTiyn: T(22500),
});

describe("planMerge", () => {
  it("refuses fewer than two rows", () => {
    expect(planMerge([asetAk])).toEqual({ refusal: "Кемінде екі жол таңдаңыз" });
  });

  it("refuses rows belonging to different customers", () => {
    const other = order({ id: "c", customerName: "Дос", customerPhone: "78888888888" });
    const r = planMerge([asetAk, other]);
    expect("refusal" in r && r.refusal).toBe("Тек бір клиенттің жолдарын біріктіруге болады");
  });

  it("matches the customer by phone even when the name was typed differently", () => {
    const sameCustomer = order({ id: "c", customerName: "асет ", customerPhone: "+7 774 741 2808" });
    expect("plan" in planMerge([asetAk, sameCustomer])).toBe(true);
  });

  it("refuses a cancelled row", () => {
    const dead = order({ id: "c", productionStatus: "cancelled" });
    const r = planMerge([asetAk, dead]);
    expect("refusal" in r && r.refusal).toContain("Бас тартылған");
  });

  it("refuses once the shop has started the work", () => {
    const started = order({ id: "c", orderNumber: "ORD-2026-000099", productionStatus: "cutting_started" });
    const r = planMerge([asetAk, started]);
    expect("refusal" in r && r.refusal).toContain("ORD-2026-000099");
  });

  it("keeps the earliest row, so the customer keeps the number they were given", () => {
    const r = planMerge([asetHdf, asetAk]); // deliberately out of order
    expect("plan" in r && r.plan.keepId).toBe("a");
    expect("plan" in r && r.plan.absorbedIds).toEqual(["b"]);
  });

  it("collects one line per material", () => {
    const r = planMerge([asetAk, asetHdf]);
    if (!("plan" in r)) throw new Error(r.refusal);
    expect(r.plan.update.items.map((i) => `${i.sheetQty} ${i.materialName}`)).toEqual([
      "5 ЛДСП Ақ",
      "3 ХДФ",
    ]);
  });

  it("sums the sheets, metres and money", () => {
    const r = planMerge([asetAk, asetHdf]);
    if (!("plan" in r)) throw new Error(r.refusal);
    expect(r.plan.update.estimatedSheets).toBe(8);
    expect(r.plan.update.materialCostTiyn).toBe(T(105000));
    expect(r.plan.update.totalTiyn).toBe(T(105000));
  });

  it("recomputes debt rather than summing it, so an overpaid row nets out", () => {
    // 82 500 owed on one row, 10 000 overpaid on the other: the merged order owes 72 500, and
    // summing the debt fields would have wrongly produced 82 500.
    const overpaid = order({
      id: "b", createdAt: at(2000),
      totalTiyn: T(20000), paidTiyn: T(30000), debtTiyn: 0, paymentStatus: "overpaid",
      materialCostTiyn: T(20000),
    });
    const r = planMerge([asetAk, overpaid]);
    if (!("plan" in r)) throw new Error(r.refusal);
    expect(r.plan.update.totalTiyn).toBe(T(102500));
    expect(r.plan.update.paidTiyn).toBe(T(30000));
    expect(r.plan.update.debtTiyn).toBe(T(72500));
  });

  it("never produces a negative debt", () => {
    const paidUp = order({ id: "b", createdAt: at(2000), totalTiyn: T(100), paidTiyn: T(90000), debtTiyn: 0 });
    const r = planMerge([asetAk, paidUp]);
    if (!("plan" in r)) throw new Error(r.refusal);
    expect(r.plan.update.debtTiyn).toBeGreaterThanOrEqual(0);
  });

  it("merges an already-merged order without flattening its lines", () => {
    const merged = order({
      id: "b", createdAt: at(2000),
      items: [
        { materialId: "x", materialName: "ЛДСП Кашемир", sheetQty: 5, sheetPriceTiyn: T(17000), pvcMeters: 0, pvcPricePerMeterTiyn: 0 },
        { materialId: "y", materialName: "ХДФ", sheetQty: 2, sheetPriceTiyn: T(7500), pvcMeters: 0, pvcPricePerMeterTiyn: 0 },
      ],
    });
    const r = planMerge([asetAk, merged]);
    if (!("plan" in r)) throw new Error(r.refusal);
    expect(r.plan.update.items).toHaveLength(3);
    expect(r.plan.update.estimatedSheets).toBe(5 + 5 + 2);
  });
});

describe("linesOf", () => {
  it("returns the single material for an ordinary order", () => {
    expect(linesOf(asetAk)).toEqual([lineFromOrder(asetAk)]);
  });

  it("returns the stored lines for a merged order", () => {
    const merged = order({ items: [{ materialId: "x", materialName: "ХДФ", sheetQty: 2, sheetPriceTiyn: 0, pvcMeters: 0, pvcPricePerMeterTiyn: 0 }] });
    expect(linesOf(merged)).toHaveLength(1);
    expect(linesOf(merged)[0].materialName).toBe("ХДФ");
  });
});

describe("describeLines", () => {
  it("reads the way the shop says it", () => {
    const r = planMerge([asetAk, asetHdf]);
    if (!("plan" in r)) throw new Error(r.refusal);
    expect(describeLines(r.plan.update.items)).toBe("5 лист ЛДСП Ақ · 3 лист ХДФ");
  });
});
