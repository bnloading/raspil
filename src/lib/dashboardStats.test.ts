import { describe, it, expect } from "vitest";
import type { Timestamp } from "firebase/firestore";
import type { ExpenseCategory, Material, Order, Payment, ProductionStatus } from "../types/domain";
import {
  computeIncomeAllocation,
  computeKpis,
  computeLowStock,
  computeMethodBreakdown,
  computeProductionBreakdown,
  computeQueueOrders,
} from "./dashboardStats";

function ts(date: Date): Timestamp {
  return { seconds: Math.floor(date.getTime() / 1000), nanoseconds: 0 } as unknown as Timestamp;
}

let orderSeq = 0;
function makeOrder(overrides: Partial<Order> = {}): Order {
  orderSeq += 1;
  return {
    id: `order-${orderSeq}`,
    orderNumber: `#${orderSeq}`,
    customerName: "Test customer",
    customerPhone: "",
    materialId: "mat-1",
    materialSnapshot: {
      name: "Test material",
      article: "A1",
      color: "white",
      thicknessMm: 16,
      sheetLengthMm: 2800,
      sheetWidthMm: 2070,
      sellingPriceTiyn: 0,
    },
    productionStatus: "cutting_queue",
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
    isDraft: false,
    pricePublished: false,
    ...overrides,
  };
}

function makePayment(overrides: Partial<Payment> = {}): Payment {
  return {
    id: "pay-1",
    orderId: "order-1",
    amountTiyn: 0,
    methodId: "cash",
    methodName: "Нал / Қолма-қол",
    paymentDate: ts(new Date()),
    recordedByUid: "uid-1",
    recordedByName: "Admin",
    reversed: false,
    ...overrides,
  };
}

function makeExpenseCategory(overrides: Partial<ExpenseCategory> = {}): ExpenseCategory {
  return {
    id: "cat-1",
    name: "Станок",
    percentage: 10,
    active: true,
    ...overrides,
  };
}

function makeMaterial(overrides: Partial<Material> = {}): Material {
  return {
    id: "mat-1",
    name: "Test material",
    article: "A1",
    color: "white",
    thicknessMm: 16,
    sheetLengthMm: 2800,
    sheetWidthMm: 2070,
    sellingPriceTiyn: 0,
    initialQty: 100,
    qtyOnHand: 100,
    reservedQty: 0,
    minStock: 10,
    active: true,
    archived: false,
    grainDirectionRequired: false,
    ...overrides,
  };
}

describe("computeKpis: today/week boundaries in Asia/Almaty (UTC+5)", () => {
  // "now" = 2026-08-26T05:00:00Z = 2026-08-26T10:00:00+05:00 (well inside the Almaty day of Aug 26).
  const now = new Date(Date.UTC(2026, 7, 26, 5, 0, 0));
  // Almaty midnight for Aug 26 is 2026-08-25T19:00:00Z.
  const justBeforeMidnight = new Date(Date.UTC(2026, 7, 25, 18, 59, 59));
  const justAfterMidnight = new Date(Date.UTC(2026, 7, 25, 19, 0, 1));

  it("excludes an order created just before the Almaty day boundary from today's count", () => {
    const orders = [makeOrder({ createdAt: ts(justBeforeMidnight) })];
    const kpis = computeKpis({ orders, payments: [], movements: [], materials: [], now });
    expect(kpis.todayOrders).toBe(0);
  });

  it("includes an order created just after the Almaty day boundary in today's count", () => {
    const orders = [makeOrder({ createdAt: ts(justAfterMidnight) })];
    const kpis = computeKpis({ orders, payments: [], movements: [], materials: [], now });
    expect(kpis.todayOrders).toBe(1);
  });

  it("counts today's revenue only from payments after the boundary", () => {
    const payments = [
      makePayment({ paymentDate: ts(justBeforeMidnight), amountTiyn: 1000 }),
      makePayment({ paymentDate: ts(justAfterMidnight), amountTiyn: 2000 }),
    ];
    const kpis = computeKpis({ orders: [], payments, movements: [], materials: [], now });
    expect(kpis.todayRevenueTiyn).toBe(2000);
  });
});

describe("computeLowStock", () => {
  it("includes a material exactly at the minStock threshold (<=, not <)", () => {
    const atThreshold = makeMaterial({ id: "m1", qtyOnHand: 10, reservedQty: 0, minStock: 10 });
    const aboveThreshold = makeMaterial({ id: "m2", qtyOnHand: 11, reservedQty: 0, minStock: 10 });
    const result = computeLowStock([atThreshold, aboveThreshold]);
    expect(result.map((m) => m.id)).toEqual(["m1"]);
  });

  it("excludes inactive materials even if below threshold", () => {
    const inactive = makeMaterial({ id: "m3", active: false, qtyOnHand: 0, reservedQty: 0, minStock: 10 });
    expect(computeLowStock([inactive])).toEqual([]);
  });
});

describe("computeProductionBreakdown", () => {
  it("bucket values sum to the count of non-draft orders, excluding draft entirely", () => {
    const now = new Date(Date.UTC(2026, 7, 26, 5, 0, 0));
    const statuses: ProductionStatus[] = [
      "draft",
      "submitted",
      "price_calculated",
      "cutting_queue",
      "cutting_started",
      "cutting_completed",
      "pvc_queue",
      "pvc_started",
      "pvc_completed",
      "ready",
      "delivered",
      "cancelled",
    ];
    const orders = statuses.map((productionStatus) => makeOrder({ productionStatus }));
    const breakdown = computeProductionBreakdown(orders, now);
    const total = breakdown.reduce((s, b) => s + b.value, 0);
    const nonDraftCount = orders.filter((o) => o.productionStatus !== "draft").length;
    expect(total).toBe(nonDraftCount);
    expect(nonDraftCount).toBe(statuses.length - 1);
  });

  it("an overdue non-terminal order counts as Кідіріс even though its raw status is elsewhere", () => {
    const now = new Date(Date.UTC(2026, 7, 26, 5, 0, 0));
    const pastDue = new Date(Date.UTC(2026, 7, 1, 0, 0, 0));
    const orders = [makeOrder({ productionStatus: "cutting_started", expectedCompletionAt: ts(pastDue) })];
    const breakdown = computeProductionBreakdown(orders, now);
    const overdue = breakdown.find((b) => b.key === "overdue")!;
    const inProgress = breakdown.find((b) => b.key === "in_progress")!;
    expect(overdue.value).toBe(1);
    expect(inProgress.value).toBe(0);
  });
});

describe("computeKpis / computeMethodBreakdown: reversed payments are excluded", () => {
  it("does not count a reversed payment toward revenue", () => {
    const now = new Date(Date.UTC(2026, 7, 26, 5, 0, 0));
    const payments = [
      makePayment({ paymentDate: ts(now), amountTiyn: 5000, reversed: false }),
      makePayment({ paymentDate: ts(now), amountTiyn: 9999, reversed: true }),
    ];
    const kpis = computeKpis({ orders: [], payments, movements: [], materials: [], now });
    expect(kpis.todayRevenueTiyn).toBe(5000);
  });

  it("does not count a reversed payment in the method breakdown", () => {
    const payments = [
      makePayment({ methodName: "Kaspi", amountTiyn: 10000, reversed: false }),
      makePayment({ methodName: "Kaspi", amountTiyn: 99999, reversed: true }),
    ];
    const breakdown = computeMethodBreakdown(payments);
    expect(breakdown).toEqual([{ label: "Kaspi", value: 100 }]);
  });
});

describe("computeKpis: totalDebtTiyn matches computeCustomerDebts' notion of real debt", () => {
  it("excludes a cancelled order's balance from the dashboard total", () => {
    const orders = [
      makeOrder({ productionStatus: "cutting_queue", totalTiyn: 10000, paidTiyn: 4000, debtTiyn: 6000 }),
      makeOrder({ productionStatus: "cancelled", totalTiyn: 7500, paidTiyn: 0, debtTiyn: 7500 }),
    ];
    const kpis = computeKpis({ orders, payments: [], movements: [], materials: [] });
    expect(kpis.totalDebtTiyn).toBe(6000);
  });

  it("excludes a draft order's balance from the dashboard total", () => {
    const orders = [makeOrder({ productionStatus: "draft", totalTiyn: 5000, paidTiyn: 0, debtTiyn: 5000 })];
    const kpis = computeKpis({ orders, payments: [], movements: [], materials: [] });
    expect(kpis.totalDebtTiyn).toBe(0);
  });

  it("does not let an overpaid order's negative balance offset another order's real debt", () => {
    const orders = [
      makeOrder({ productionStatus: "cutting_queue", totalTiyn: 10000, paidTiyn: 4000, debtTiyn: 6000 }),
      makeOrder({ productionStatus: "delivered", totalTiyn: 5000, paidTiyn: 8000, debtTiyn: -3000 }),
    ];
    const kpis = computeKpis({ orders, payments: [], movements: [], materials: [] });
    expect(kpis.totalDebtTiyn).toBe(6000);
  });
});

describe("computeIncomeAllocation", () => {
  it("adds a Таза пайда remainder bucket when active percentages sum to less than 100", () => {
    const categories = [
      makeExpenseCategory({ id: "c1", name: "Станок", percentage: 5, active: true }),
      makeExpenseCategory({ id: "c2", name: "Жалақы", percentage: 30, active: true }),
    ];
    const result = computeIncomeAllocation(categories, 100_000_00); // 100,000 ₸ in tiyn
    expect(result).toEqual([
      { label: "Станок", value: 5_000, color: "var(--chart-blue)" },
      { label: "Жалақы", value: 30_000, color: "var(--chart-green)" },
      { label: "Таза пайда", value: 65_000, color: "var(--chart-gray)" },
    ]);
  });

  it("omits the remainder bucket when active percentages sum to exactly 100", () => {
    const categories = [
      makeExpenseCategory({ id: "c1", name: "Станок", percentage: 40, active: true }),
      makeExpenseCategory({ id: "c2", name: "Жалақы", percentage: 60, active: true }),
    ];
    const result = computeIncomeAllocation(categories, 100_000_00);
    expect(result.find((r) => r.label === "Таза пайда")).toBeUndefined();
    expect(result).toEqual([
      { label: "Станок", value: 40_000, color: "var(--chart-blue)" },
      { label: "Жалақы", value: 60_000, color: "var(--chart-green)" },
    ]);
  });

  it("excludes inactive categories from the allocation and their percentage from the remainder", () => {
    const categories = [
      makeExpenseCategory({ id: "c1", name: "Станок", percentage: 10, active: true }),
      makeExpenseCategory({ id: "c2", name: "Ескі санат", percentage: 50, active: false }),
    ];
    const result = computeIncomeAllocation(categories, 100_000_00);
    expect(result).toEqual([
      { label: "Станок", value: 10_000, color: "var(--chart-blue)" },
      { label: "Таза пайда", value: 90_000, color: "var(--chart-gray)" },
    ]);
  });

  it("returns a single 100% Таза пайда bucket when there are no categories but revenue is positive", () => {
    const result = computeIncomeAllocation([], 100_000_00);
    expect(result).toEqual([{ label: "Таза пайда", value: 100_000, color: "var(--chart-gray)" }]);
  });

  it("returns an empty array when there are no categories and no revenue", () => {
    expect(computeIncomeAllocation([], 0)).toEqual([]);
  });
});

describe("computeQueueOrders", () => {
  it("excludes terminal statuses (delivered/rejected) and drafts", () => {
    const orders = [
      makeOrder({ productionStatus: "delivered" }),
      makeOrder({ productionStatus: "cancelled" }),
      makeOrder({ productionStatus: "draft" }),
      makeOrder({ productionStatus: "cutting_queue" }),
    ];
    const result = computeQueueOrders(orders);
    expect(result).toHaveLength(1);
    expect(result[0].productionStatus).toBe("cutting_queue");
  });

  it("respects the limit parameter", () => {
    const orders = Array.from({ length: 20 }, (_, i) =>
      makeOrder({ productionStatus: "cutting_queue", priority: i, createdAt: ts(new Date(Date.UTC(2026, 0, i + 1))) }),
    );
    expect(computeQueueOrders(orders, 3)).toHaveLength(3);
    expect(computeQueueOrders(orders)).toHaveLength(8);
  });

  it("sorts by priority desc, then createdAt asc", () => {
    const low = makeOrder({ productionStatus: "cutting_queue", priority: 1, createdAt: ts(new Date(Date.UTC(2026, 0, 2))) });
    const high = makeOrder({ productionStatus: "cutting_queue", priority: 5, createdAt: ts(new Date(Date.UTC(2026, 0, 3))) });
    const highEarlier = makeOrder({ productionStatus: "cutting_queue", priority: 5, createdAt: ts(new Date(Date.UTC(2026, 0, 1))) });
    const result = computeQueueOrders([low, high, highEarlier]);
    expect(result.map((o) => o.id)).toEqual([highEarlier.id, high.id, low.id]);
  });
});
