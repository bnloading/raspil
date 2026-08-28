import { describe, it, expect } from "vitest";
import { Timestamp } from "firebase/firestore";
import { computeFinanceSummary, availableMonths, MACHINE_WASTE_PCT } from "./finance";
import type { ExpenseCategory, Order, Payment } from "../types/domain";

const T = (n: number) => n * 100; // ₸ → tiyn

/** Noon Almaty on the given day, so the month never slips across the UTC boundary. */
const at = (iso: string) => Timestamp.fromDate(new Date(`${iso}T12:00:00+05:00`));

function order(overrides: Partial<Order> = {}): Order {
  return {
    id: "o1",
    orderNumber: "ORD-2026-000001",
    customerName: "Алмат",
    customerPhone: "77001112233",
    materialId: "m1",
    materialSnapshot: {
      name: "ЛДСП Ақ",
      article: "A-1",
      color: "Ақ",
      thicknessMm: 16,
      sheetLengthMm: 2800,
      sheetWidthMm: 2070,
      sellingPriceTiyn: T(16200),
    },
    productionStatus: "ready",
    paymentStatus: "unpaid",
    priority: 0,
    estimatedSheets: 1,
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
    createdAt: at("2026-08-10"),
    pricePublished: true,
    isDraft: false,
    ...overrides,
  };
}

function payment(overrides: Partial<Payment> = {}): Payment {
  return {
    id: "p1",
    orderId: "o1",
    amountTiyn: 0,
    methodId: "cash",
    methodName: "Нал / Қолма-қол",
    paymentDate: at("2026-08-10"),
    recordedByUid: "u1",
    recordedByName: "Manager",
    reversed: false,
    ...overrides,
  };
}

const cat = (name: string, percentage: number, active = true): ExpenseCategory => ({
  id: name,
  name,
  percentage,
  active,
});

const run = (args: Partial<Parameters<typeof computeFinanceSummary>[0]> = {}) =>
  computeFinanceSummary({
    orders: [],
    payments: [],
    purchaseByMaterialId: new Map(),
    categories: [],
    period: "2026-08",
    ...args,
  });

describe("computeFinanceSummary — monthly money", () => {
  it("bills only the selected month", () => {
    const s = run({
      orders: [
        order({ id: "a", totalTiyn: T(100000), createdAt: at("2026-08-03") }),
        order({ id: "b", totalTiyn: T(50000), createdAt: at("2026-07-28") }),
      ],
    });
    expect(s.billedTiyn).toBe(T(100000));
    expect(s.orderCount).toBe(1);
  });

  it("excludes drafts and cancellations from every figure", () => {
    const s = run({
      orders: [
        order({ id: "a", totalTiyn: T(100000) }),
        order({ id: "b", totalTiyn: T(999999), productionStatus: "draft" }),
        order({ id: "c", totalTiyn: T(888888), productionStatus: "cancelled" }),
      ],
    });
    expect(s.billedTiyn).toBe(T(100000));
    expect(s.orderCount).toBe(1);
  });

  it("counts received money separately from billed money", () => {
    // Billed in August, paid in September: August's profit, September's cash.
    const s = run({
      orders: [order({ totalTiyn: T(100000), debtTiyn: T(100000) })],
      payments: [payment({ amountTiyn: T(100000), paymentDate: at("2026-09-02") })],
    });
    expect(s.billedTiyn).toBe(T(100000));
    expect(s.receivedTiyn).toBe(0);
    expect(s.debtTiyn).toBe(T(100000));
  });

  it("ignores reversed payments", () => {
    const s = run({
      payments: [
        payment({ id: "p1", amountTiyn: T(30000) }),
        payment({ id: "p2", amountTiyn: T(70000), reversed: true }),
      ],
    });
    expect(s.receivedTiyn).toBe(T(30000));
  });

  it("gross profit is billed less what the sheets cost us, not what we charged for them", () => {
    const s = run({
      orders: [order({ totalTiyn: T(100000), confirmedSheets: 5, materialCostTiyn: T(81000) })],
      purchaseByMaterialId: new Map([["m1", T(12000)]]),
    });
    expect(s.costTiyn).toBe(T(60000)); // 5 × 12 000
    expect(s.grossProfitTiyn).toBe(T(40000));
  });

  it("falls back to the estimate when sheets were never confirmed", () => {
    const s = run({
      orders: [order({ totalTiyn: T(100000), estimatedSheets: 3 })],
      purchaseByMaterialId: new Map([["m1", T(10000)]]),
    });
    expect(s.costTiyn).toBe(T(30000));
  });

  it("costs an unpriced or deleted material at zero rather than guessing", () => {
    const s = run({
      orders: [order({ totalTiyn: T(100000), confirmedSheets: 5, materialId: "gone" })],
      purchaseByMaterialId: new Map([["m1", T(12000)]]),
    });
    expect(s.costTiyn).toBe(0);
    expect(s.grossProfitTiyn).toBe(T(100000));
  });

  it("sets aside 5% of gross profit for the machine and waste when nothing is configured", () => {
    const s = run({
      orders: [order({ totalTiyn: T(100000), confirmedSheets: 5 })],
      purchaseByMaterialId: new Map([["m1", T(12000)]]),
    });
    // gross 40 000 ₸ → 5% = 2 000 ₸
    expect(s.allocations).toHaveLength(1);
    expect(s.allocations[0].percentage).toBe(MACHINE_WASTE_PCT);
    expect(s.allocations[0].amountTiyn).toBe(T(2000));
    expect(s.netProfitTiyn).toBe(T(38000));
  });

  it("uses the configured categories once an Admin has created them", () => {
    const s = run({
      orders: [order({ totalTiyn: T(100000) })],
      categories: [cat("Станок / мусор", 5), cat("Жалдау", 10), cat("Ескі", 50, false)],
    });
    expect(s.allocations.map((a) => a.name)).toEqual(["Станок / мусор", "Жалдау"]);
    expect(s.allocations[0].amountTiyn).toBe(T(5000));
    expect(s.allocations[1].amountTiyn).toBe(T(10000));
    expect(s.netProfitTiyn).toBe(T(85000));
  });

  it("reports a loss rather than clamping it to zero", () => {
    const s = run({
      orders: [order({ totalTiyn: T(10000), confirmedSheets: 5 })],
      purchaseByMaterialId: new Map([["m1", T(12000)]]),
    });
    expect(s.grossProfitTiyn).toBe(T(-50000));
  });

  it("period null totals everything ever billed", () => {
    const s = run({
      period: null,
      orders: [
        order({ id: "a", totalTiyn: T(100000), createdAt: at("2026-08-03") }),
        order({ id: "b", totalTiyn: T(50000), createdAt: at("2025-01-28") }),
      ],
    });
    expect(s.billedTiyn).toBe(T(150000));
    expect(s.orderCount).toBe(2);
  });
});

describe("availableMonths", () => {
  it("lists only months with billable orders, newest first", () => {
    const months = availableMonths([
      order({ id: "a", createdAt: at("2026-08-03") }),
      order({ id: "b", createdAt: at("2026-06-03") }),
      order({ id: "c", createdAt: at("2026-08-29") }),
      order({ id: "d", createdAt: at("2026-01-01"), productionStatus: "draft" }),
    ]);
    expect(months).toEqual(["2026-08", "2026-06"]);
  });
});
