import { describe, it, expect } from "vitest";
import { Timestamp } from "firebase/firestore";
import {
  GROUP_TONE_COUNT,
  absorbedOrdersOf,
  groupTone,
  linePrice,
  mergeChildrenByParent,
  rangeBetween,
  withRangePicked,
} from "./journalGroups";
import type { Order } from "../types/domain";

const T = (n: number) => n * 100;

function order(id: string, overrides: Partial<Order> = {}): Order {
  return {
    id,
    orderNumber: `ORD-2026-${id}`,
    customerName: "Нурик",
    customerPhone: "77011234567",
    materialId: "m1",
    materialSnapshot: {
      name: "ЛДСП Ақ", article: "A-1", color: "Ақ",
      thicknessMm: 16, sheetLengthMm: 2750, sheetWidthMm: 1830, sellingPriceTiyn: T(16000),
    },
    productionStatus: "waiting_payment",
    paymentStatus: "unpaid",
    priority: 0,
    estimatedSheets: 6,
    pvcMetersTotal: 0,
    materialCostTiyn: 0, cuttingCostTiyn: 0, pvcCostTiyn: 0, hdfCostTiyn: 0,
    extraServicesTiyn: 0, deliveryCostTiyn: 0, discountTiyn: 0,
    totalTiyn: 0, paidTiyn: 0, debtTiyn: 0,
    pricePublished: true,
    isDraft: false,
    ...overrides,
  };
}

const at = (seconds: number) => Timestamp.fromMillis(seconds * 1000);

describe("linePrice", () => {
  it("prices the sheets and the metres separately, then together", () => {
    expect(
      linePrice({ sheetQty: 8, sheetPriceTiyn: T(16000), pvcMeters: 120, pvcPricePerMeterTiyn: T(200) }),
    ).toEqual({ sheetsTiyn: T(128000), pvcTiyn: T(24000), sheetsAndPvcTiyn: T(152000) });
  });

  it("rounds fractional metres once rather than leaving a fraction of a tiyn", () => {
    const price = linePrice({ sheetQty: 0, sheetPriceTiyn: 0, pvcMeters: 176.4, pvcPricePerMeterTiyn: 20033 });
    expect(price.pvcTiyn).toBe(Math.round(176.4 * 20033));
    expect(Number.isInteger(price.pvcTiyn)).toBe(true);
  });

  it("is zero for a line with nothing on it", () => {
    expect(linePrice({ sheetQty: 0, sheetPriceTiyn: T(16000), pvcMeters: 0, pvcPricePerMeterTiyn: T(200) }))
      .toEqual({ sheetsTiyn: 0, pvcTiyn: 0, sheetsAndPvcTiyn: 0 });
  });
});

describe("groupTone", () => {
  it("gives the same order the same colour every time", () => {
    expect(groupTone("abc123")).toBe(groupTone("abc123"));
  });

  it("stays inside the palette for any id", () => {
    for (const id of ["", "a", "ORD-2026-000001", "x".repeat(200)]) {
      const tone = groupTone(id);
      expect(tone).toBeGreaterThanOrEqual(0);
      expect(tone).toBeLessThan(GROUP_TONE_COUNT);
    }
  });

  it("spreads ids across the palette instead of collapsing onto one colour", () => {
    const seen = new Set(Array.from({ length: 60 }, (_, i) => groupTone(`order-${i}`)));
    expect(seen.size).toBe(GROUP_TONE_COUNT);
  });
});

describe("absorbedOrdersOf", () => {
  it("finds the rows folded straight into an order, oldest first", () => {
    const orders = [
      order("keep", { createdAt: at(100) }),
      order("b", { mergedIntoOrderId: "keep", createdAt: at(300) }),
      order("a", { mergedIntoOrderId: "keep", createdAt: at(200) }),
      order("unrelated", { createdAt: at(400) }),
    ];
    expect(absorbedOrdersOf("keep", mergeChildrenByParent(orders)).map((o) => o.id)).toEqual(["a", "b"]);
  });

  it("follows a chained merge so the first merge's rows are not lost", () => {
    // a → b, then b → c: everything belongs to c now.
    const orders = [
      order("c", { createdAt: at(100) }),
      order("b", { mergedIntoOrderId: "c", createdAt: at(200) }),
      order("a", { mergedIntoOrderId: "b", createdAt: at(300) }),
    ];
    expect(absorbedOrdersOf("c", mergeChildrenByParent(orders)).map((o) => o.id)).toEqual(["b", "a"]);
  });

  it("stops on corrupt data instead of looping forever", () => {
    const orders = [
      order("x", { mergedIntoOrderId: "y" }),
      order("y", { mergedIntoOrderId: "x" }),
    ];
    expect(absorbedOrdersOf("x", mergeChildrenByParent(orders)).map((o) => o.id)).toEqual(["y"]);
  });

  it("returns nothing for an ordinary row", () => {
    expect(absorbedOrdersOf("keep", mergeChildrenByParent([order("keep"), order("other")]))).toEqual([]);
  });
});

describe("mergeChildrenByParent", () => {
  it("indexes only the rows that were folded into something", () => {
    const index = mergeChildrenByParent([
      order("keep"),
      order("a", { mergedIntoOrderId: "keep" }),
      order("b", { mergedIntoOrderId: "keep" }),
      order("loose"),
    ]);
    expect([...index.keys()]).toEqual(["keep"]);
    expect(index.get("keep")!.map((o) => o.id)).toEqual(["a", "b"]);
  });
});

describe("rangeBetween", () => {
  const ids = ["r1", "r2", "r3", "r4", "r5"];

  it("selects everything between the two rows, inclusive", () => {
    expect(rangeBetween(ids, "r2", "r4")).toEqual(["r2", "r3", "r4"]);
  });

  it("works upwards as well as downwards", () => {
    expect(rangeBetween(ids, "r4", "r2")).toEqual(["r2", "r3", "r4"]);
  });

  it("is just the one row when the anchor is the target", () => {
    expect(rangeBetween(ids, "r3", "r3")).toEqual(["r3"]);
  });

  it("falls back to the clicked row when the anchor has scrolled off the page", () => {
    expect(rangeBetween(ids, "gone", "r3")).toEqual(["r3"]);
  });

  it("selects nothing when the clicked row is not on the page either", () => {
    expect(rangeBetween(ids, "r1", "gone")).toEqual([]);
  });
});

describe("withRangePicked", () => {
  const ids = ["r1", "r2", "r3", "r4"];

  it("adds the range without dropping rows picked elsewhere", () => {
    const picked = withRangePicked(new Set(["r1"]), ids, "r3", "r4");
    expect([...picked].sort()).toEqual(["r1", "r3", "r4"]);
  });

  it("does not mutate the set it was given", () => {
    const before = new Set(["r1"]);
    withRangePicked(before, ids, "r2", "r3");
    expect([...before]).toEqual(["r1"]);
  });
});
