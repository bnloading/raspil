import { describe, it, expect } from "vitest";
import { Timestamp } from "firebase/firestore";
import {
  debtOverview,
  periodStart,
  previousPeriodRange,
  pvcMetersSince,
  revenueFor,
  weeklyRevenue,
} from "./reportsDashboard";
import type { Order, OrderLineJob, Payment } from "../types/domain";

/** Almaty is UTC+5, so 2026-09-02T06:00Z is 11:00 on Wednesday 2 September there. */
const NOW = new Date(Date.UTC(2026, 8, 2, 6, 0, 0));

const ts = (iso: string) => Timestamp.fromDate(new Date(iso));

function payment(amountTiyn: number, isoDate: string, reversed = false): Payment {
  return {
    id: `p-${isoDate}-${amountTiyn}`,
    orderId: "o1",
    amountTiyn,
    methodId: "cash",
    methodName: "Нал",
    paymentDate: ts(isoDate),
    reversed,
  } as Payment;
}

function order(over: Partial<Order> = {}): Order {
  return {
    id: "o1", orderNumber: "ORD-2026-000001",
    customerName: "Нурик", customerPhone: "77011234567",
    materialId: "m1",
    materialSnapshot: {
      name: "ЛДСП Ақ", article: "A-1", color: "Ақ",
      thicknessMm: 16, sheetLengthMm: 2750, sheetWidthMm: 1830, sellingPriceTiyn: 0,
    },
    productionStatus: "waiting_payment", paymentStatus: "unpaid", priority: 0,
    estimatedSheets: 0, pvcMetersTotal: 0,
    materialCostTiyn: 0, cuttingCostTiyn: 0, pvcCostTiyn: 0, hdfCostTiyn: 0,
    extraServicesTiyn: 0, deliveryCostTiyn: 0, discountTiyn: 0,
    totalTiyn: 0, paidTiyn: 0, debtTiyn: 0,
    pricePublished: true, isDraft: false,
    ...over,
  };
}

describe("periodStart / previousPeriodRange", () => {
  it("starts the week on Monday, in Almaty", () => {
    // Wednesday 2 Sep 2026 → the week began Monday 31 Aug.
    expect(periodStart("week", NOW).toISOString()).toContain("2026-08-30T19:00");
  });

  it("gives the same stretch one period back", () => {
    const prev = previousPeriodRange("week", NOW);
    expect(prev.to.getTime()).toBe(periodStart("week", NOW).getTime());
    expect(prev.to.getTime() - prev.from.getTime()).toBe(7 * 86_400_000);
  });

  it("steps a month back by calendar, not by 30 days", () => {
    const prev = previousPeriodRange("month", NOW);
    expect(prev.to.toISOString()).toContain("2026-08-31T19:00"); // 1 Sep Almaty
    expect(prev.from.toISOString()).toContain("2026-07-31T19:00"); // 1 Aug Almaty
  });
});

describe("revenueFor", () => {
  const payments = [
    payment(100_00, "2026-09-02T05:00:00Z"),  // today
    payment(200_00, "2026-09-01T05:00:00Z"),  // yesterday, still this week
    payment(50_00, "2026-08-25T05:00:00Z"),   // last week
    payment(999_00, "2026-09-02T05:00:00Z", true), // reversed — never counts
  ];

  it("counts only live payments in the period", () => {
    expect(revenueFor(payments, "today", NOW).currentTiyn).toBe(100_00);
    expect(revenueFor(payments, "week", NOW).currentTiyn).toBe(300_00);
  });

  it("compares against the same stretch one period earlier", () => {
    const week = revenueFor(payments, "week", NOW);
    expect(week.previousTiyn).toBe(50_00);
    expect(week.changePct).toBe(500); // 300 vs 50
  });

  it("reports no change rather than inventing one when there is nothing to compare with", () => {
    // The first money of its kind is not "+100%".
    const only = [payment(100_00, "2026-09-02T05:00:00Z")];
    expect(revenueFor(only, "week", NOW).changePct).toBeNull();
  });

  it("reports a fall as a negative", () => {
    const falling = [payment(50_00, "2026-09-02T05:00:00Z"), payment(100_00, "2026-08-25T05:00:00Z")];
    expect(revenueFor(falling, "week", NOW).changePct).toBe(-50);
  });
});

describe("weeklyRevenue", () => {
  it("returns all seven days, Monday first, even the empty ones", () => {
    const days = weeklyRevenue([payment(100_00, "2026-09-02T05:00:00Z")], NOW);
    expect(days).toHaveLength(7);
    expect(days.map((d) => d.label)).toEqual(["Дс", "Сс", "Ср", "Бс", "Жм", "Сб", "Жс"]);
    // Wednesday is the third bar.
    expect(days[2].valueTiyn).toBe(100_00);
    expect(days[0].valueTiyn).toBe(0);
  });

  it("puts each payment on its own Almaty day", () => {
    // 20:00 UTC on Monday is 01:00 Tuesday in Almaty.
    const days = weeklyRevenue([payment(70_00, "2026-08-31T20:00:00Z")], NOW);
    expect(days[0].valueTiyn).toBe(0);
    expect(days[1].valueTiyn).toBe(70_00);
  });

  it("keeps a reversed payment out of the chart", () => {
    const days = weeklyRevenue([payment(100_00, "2026-09-02T05:00:00Z", true)], NOW);
    expect(days.every((d) => d.valueTiyn === 0)).toBe(true);
  });
});

describe("debtOverview", () => {
  const owing = (phone: string, debtTiyn: number, createdIso: string) =>
    order({
      id: phone, customerPhone: phone, totalTiyn: debtTiyn, debtTiyn,
      createdAt: ts(createdIso),
    });

  it("counts customers, not orders — one person is one phone call", () => {
    const o = debtOverview(
      [owing("77011111111", 1000_00, "2026-08-30T05:00:00Z"), owing("77011111111", 500_00, "2026-08-30T05:00:00Z")],
      NOW,
    );
    expect(o.customers).toBe(1);
    expect(o.totalTiyn).toBe(1500_00);
  });

  it("flags a debt older than the window, measured from the oldest unpaid order", () => {
    const o = debtOverview(
      [
        owing("77011111111", 1000_00, "2026-06-01T05:00:00Z"), // long overdue
        owing("77022222222", 400_00, "2026-09-01T05:00:00Z"),  // fresh
      ],
      NOW,
    );
    expect(o.customers).toBe(2);
    expect(o.overdue).toBe(1);
  });

  it("ignores anybody who owes nothing", () => {
    expect(debtOverview([order({ totalTiyn: 500_00, paidTiyn: 500_00, debtTiyn: 0 })], NOW))
      .toEqual({ totalTiyn: 0, customers: 0, overdue: 0 });
  });
});

describe("pvcMetersSince", () => {
  const job = (over: Partial<OrderLineJob>): OrderLineJob => ({
    index: 0, materialId: "m1", materialName: "ЛДСП Ақ", sheetQty: 0, pvcMeters: 0, ...over,
  });

  it("counts each finished line on the day its own work landed", () => {
    const o = order({
      lineJobs: [
        job({ index: 0, pvcMeters: 40, pvcCompletedAt: ts("2026-09-02T05:00:00Z") }),
        job({ index: 1, pvcMeters: 26, pvcCompletedAt: ts("2026-09-02T06:00:00Z") }),
      ],
    });
    expect(pvcMetersSince([o], periodStart("today", NOW))).toBe(66);
  });

  it("does not count a line that has not been finished yet", () => {
    const o = order({
      lineJobs: [
        job({ index: 0, pvcMeters: 40, pvcCompletedAt: ts("2026-09-02T05:00:00Z") }),
        job({ index: 1, pvcMeters: 100 }),
      ],
    });
    expect(pvcMetersSince([o], periodStart("today", NOW))).toBe(40);
  });

  it("ignores work finished before the period", () => {
    const o = order({ lineJobs: [job({ pvcMeters: 90, pvcCompletedAt: ts("2026-08-20T05:00:00Z") })] });
    expect(pvcMetersSince([o], periodStart("today", NOW))).toBe(0);
  });
});
