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

  it("costs a merged order line by line, at each material's own purchase price", () => {
    const s = run({
      orders: [
        order({
          totalTiyn: T(129400),
          confirmedSheets: 8,
          items: [
            { materialId: "m1", materialName: "ЛДСП Ақ", sheetQty: 6, sheetPriceTiyn: T(16000), pvcMeters: 0, pvcPricePerMeterTiyn: 0 },
            { materialId: "hdf", materialName: "ХДФ", sheetQty: 2, sheetPriceTiyn: T(7500), pvcMeters: 0, pvcPricePerMeterTiyn: 0 },
          ],
        }),
      ],
      purchaseByMaterialId: new Map([["m1", T(12000)], ["hdf", T(5000)]]),
    });
    // 6 × 12 000 + 2 × 5 000 — not 8 × 12 000, which is what costing the whole order at the first
    // material's rate produced.
    expect(s.costTiyn).toBe(T(82000));
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

  it("subtracts the month's logged one-off expenses from net profit", () => {
    const s = run({
      orders: [order({ totalTiyn: T(100000), confirmedSheets: 5 })],
      purchaseByMaterialId: new Map([["m1", T(12000)]]),
      expenses: [
        { id: "e1", name: "Мусор", amountTiyn: T(12500), date: "2026-08-10", createdByUid: "u1", createdByName: "Admin" },
        { id: "e2", name: "Ертерек", amountTiyn: T(9999), date: "2026-07-20", createdByUid: "u1", createdByName: "Admin" },
      ],
    });
    // gross 40 000 − 5% (2 000) − Мусор 12 500 = 25 500 ₸. July's entry never counts for August.
    expect(s.fixedExpensesTiyn).toBe(T(12500));
    expect(s.netProfitTiyn).toBe(T(25500));
  });

  it("defaults to no logged expenses for callers that don't pass any", () => {
    const s = run({ orders: [order({ totalTiyn: T(100000), confirmedSheets: 5 })], purchaseByMaterialId: new Map([["m1", T(12000)]]) });
    expect(s.fixedExpensesTiyn).toBe(0);
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

describe("computeFinanceSummary — есеп басталатын күн (accounting restart)", () => {
  const expense = (date: string, amountTiyn: number) => ({
    id: date, name: "Шығын", amountTiyn, date,
    createdByUid: "u1", createdByName: "Manager",
  });

  it("leaves out everything that moved before the start date", () => {
    const s = run({
      period: null,
      startDate: "2026-08-15",
      orders: [
        order({ id: "old", totalTiyn: T(400000), createdAt: at("2026-08-10") }),
        order({ id: "new", totalTiyn: T(120000), createdAt: at("2026-08-20") }),
      ],
      payments: [
        payment({ id: "old", amountTiyn: T(400000), paymentDate: at("2026-08-10") }),
        payment({ id: "new", amountTiyn: T(90000), paymentDate: at("2026-08-20") }),
      ],
      expenses: [expense("2026-08-01", T(300000)), expense("2026-08-20", T(15000))],
    });
    expect(s.billedTiyn).toBe(T(120000));
    expect(s.receivedTiyn).toBe(T(90000));
    expect(s.fixedExpensesTiyn).toBe(T(15000));
    expect(s.orderCount).toBe(1);
  });

  it("counts the start date itself — the restart day is in, not out", () => {
    const s = run({
      period: null,
      startDate: "2026-08-15",
      orders: [order({ id: "a", totalTiyn: T(70000), createdAt: at("2026-08-15") })],
      expenses: [expense("2026-08-15", T(5000))],
    });
    expect(s.billedTiyn).toBe(T(70000));
    expect(s.fixedExpensesTiyn).toBe(T(5000));
  });

  it("moves revenue and expenses together — never one without the other", () => {
    // Dropping the old expenses while keeping the old orders would report a month's revenue
    // against no costs at all, which reads as profit the shop never made.
    const args = {
      period: null,
      orders: [order({ id: "old", totalTiyn: T(400000), createdAt: at("2026-08-10") })],
      expenses: [expense("2026-08-10", T(300000))],
    };
    const before = run(args);
    const after = run({ ...args, startDate: "2026-08-15" });
    expect(before.billedTiyn).toBe(T(400000));
    expect(before.fixedExpensesTiyn).toBe(T(300000));
    expect(after.billedTiyn).toBe(0);
    expect(after.fixedExpensesTiyn).toBe(0);
  });

  it("counts everything when no start date is set, exactly as before", () => {
    const s = run({
      period: null,
      orders: [order({ id: "old", totalTiyn: T(400000), createdAt: at("2026-08-10") })],
      expenses: [expense("2026-08-01", T(300000))],
    });
    expect(s.billedTiyn).toBe(T(400000));
    expect(s.fixedExpensesTiyn).toBe(T(300000));
  });
});

describe("computeFinanceSummary — uncosted sheets", () => {
  it("counts sheets whose material has no purchase price, so the page can say the profit is high", () => {
    const s = run({
      orders: [
        order({ id: "a", materialId: "priced", estimatedSheets: 4, confirmedSheets: 4, totalTiyn: T(100000) }),
        order({ id: "b", materialId: "unpriced", estimatedSheets: 6, confirmedSheets: 6, totalTiyn: T(90000) }),
      ],
      purchaseByMaterialId: new Map([["priced", T(1500)]]),
    });
    expect(s.uncostedSheets).toBe(6);
    // Only the priced sheets contribute a cost; the rest inflate the margin, which is the point.
    expect(s.costTiyn).toBe(T(6000));
  });

  it("is zero once every material on the period's orders has a price", () => {
    const s = run({
      orders: [order({ id: "a", materialId: "priced", estimatedSheets: 4, confirmedSheets: 4 })],
      purchaseByMaterialId: new Map([["priced", T(1500)]]),
    });
    expect(s.uncostedSheets).toBe(0);
  });

  it("treats a recorded price of zero as no price — a free sheet is not a real cost", () => {
    const s = run({
      orders: [order({ id: "a", materialId: "zero", estimatedSheets: 3, confirmedSheets: 3 })],
      purchaseByMaterialId: new Map([["zero", 0]]),
    });
    expect(s.uncostedSheets).toBe(3);
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
