import { describe, it, expect } from "vitest";
import { Timestamp } from "firebase/firestore";
import {
  measureWork,
  computeSalaryBase,
  computeFinalSalary,
  buildSalaryEntry,
  availablePeriods,
  EMPTY_WORK_TOTALS,
} from "./salary";
import { hoursBetween } from "./salaryWrite";
import type { AttendanceRecord, Order, SalaryRule } from "../types/domain";

const T = (n: number) => n * 100; // ₸ → tiyn
const CUTTER = "cutter-1";
const PVC = "pvc-1";

/** 2026-03-15 12:00 Almaty */
const MARCH = Timestamp.fromDate(new Date("2026-03-15T12:00:00+05:00"));
const APRIL = Timestamp.fromDate(new Date("2026-04-02T12:00:00+05:00"));

function order(overrides: Partial<Order> = {}): Order {
  return {
    id: "o1",
    orderNumber: "ORD-2026-000001",
    customerName: "A",
    customerPhone: "77001112233",
    materialId: "m1",
    materialSnapshot: {
      name: "ЛДСП", article: "", color: "", thicknessMm: 16,
      sheetLengthMm: 2800, sheetWidthMm: 2070, sellingPriceTiyn: 0,
    },
    productionStatus: "ready",
    paymentStatus: "paid",
    priority: 0,
    estimatedSheets: 0,
    pvcMetersTotal: 0,
    materialCostTiyn: 0, cuttingCostTiyn: 0, pvcCostTiyn: 0, hdfCostTiyn: 0,
    extraServicesTiyn: 0, deliveryCostTiyn: 0, discountTiyn: 0,
    totalTiyn: 0, paidTiyn: 0, debtTiyn: 0,
    pricePublished: true,
    isDraft: false,
    ...overrides,
  };
}

function attendance(overrides: Partial<AttendanceRecord> = {}): AttendanceRecord {
  return {
    id: "a1",
    userId: CUTTER,
    userName: "Cutter",
    date: "2026-03-02",
    status: "present",
    recordedByUid: "admin",
    recordedByName: "Admin",
    ...overrides,
  };
}

describe("measureWork", () => {
  it("credits cut sheets to the cutter in the month the cutting finished", () => {
    const work = measureWork(
      [order({ assignedCutterId: CUTTER, confirmedSheets: 6, cuttingCompletedAt: MARCH })],
      [],
      CUTTER,
      "2026-03",
    );
    expect(work.sheetsCut).toBe(6);
    expect(work.ordersCompleted).toBe(1);
  });

  it("credits work by completion date, not creation date — a March order finished in April counts in April", () => {
    const orders = [order({ assignedCutterId: CUTTER, confirmedSheets: 4, cuttingCompletedAt: APRIL })];
    expect(measureWork(orders, [], CUTTER, "2026-03").sheetsCut).toBe(0);
    expect(measureWork(orders, [], CUTTER, "2026-04").sheetsCut).toBe(4);
  });

  it("ignores work assigned to a different worker", () => {
    const work = measureWork(
      [order({ assignedCutterId: "someone-else", confirmedSheets: 9, cuttingCompletedAt: MARCH })],
      [],
      CUTTER,
      "2026-03",
    );
    expect(work).toEqual(EMPTY_WORK_TOTALS);
  });

  it("ignores an order that has not been completed yet", () => {
    const work = measureWork([order({ assignedCutterId: CUTTER, confirmedSheets: 5 })], [], CUTTER, "2026-03");
    expect(work.sheetsCut).toBe(0);
  });

  it("credits PVC metres to the PVC worker", () => {
    const work = measureWork(
      [order({ assignedPvcId: PVC, pvcMetersTotal: 89, pvcCompletedAt: MARCH })],
      [],
      PVC,
      "2026-03",
    );
    expect(work.pvcMeters).toBe(89);
    expect(work.ordersCompleted).toBe(1);
  });

  it("counts an order the same worker both cut and edged once, not twice", () => {
    const work = measureWork(
      [
        order({
          assignedCutterId: CUTTER, assignedPvcId: CUTTER,
          confirmedSheets: 3, pvcMetersTotal: 20,
          cuttingCompletedAt: MARCH, pvcCompletedAt: MARCH,
        }),
      ],
      [],
      CUTTER,
      "2026-03",
    );
    expect(work.ordersCompleted).toBe(1);
    expect(work.sheetsCut).toBe(3);
    expect(work.pvcMeters).toBe(20);
  });

  it("counts present/late as worked days and absent separately; day-off and sick count as neither", () => {
    const work = measureWork([], [
      attendance({ id: "1", date: "2026-03-02", status: "present", workedHours: 8 }),
      attendance({ id: "2", date: "2026-03-03", status: "late", workedHours: 6 }),
      attendance({ id: "3", date: "2026-03-04", status: "absent" }),
      attendance({ id: "4", date: "2026-03-05", status: "dayoff" }),
      attendance({ id: "5", date: "2026-03-06", status: "sick" }),
    ], CUTTER, "2026-03");
    expect(work.presentDays).toBe(2);
    expect(work.absentDays).toBe(1);
    expect(work.workedHours).toBe(14);
  });

  it("ignores attendance from another month", () => {
    const work = measureWork([], [attendance({ date: "2026-04-01", status: "present", workedHours: 8 })], CUTTER, "2026-03");
    expect(work.presentDays).toBe(0);
  });
});

describe("computeSalaryBase — MANUAL is the default and invents nothing", () => {
  const work = { ...EMPTY_WORK_TOTALS, sheetsCut: 10, pvcMeters: 50, ordersCompleted: 4, workedHours: 160, absentDays: 2 };

  it("defaults to MANUAL when the worker has no rule at all", () => {
    expect(computeSalaryBase(undefined, work).mode).toBe("MANUAL");
  });

  it("MANUAL computes a base of zero regardless of how much work was done", () => {
    const result = computeSalaryBase({ id: CUTTER, userId: CUTTER, mode: "MANUAL" }, work);
    expect(result.baseTiyn).toBe(0);
  });

  it("MANUAL never applies an attendance deduction — the Admin's typed figure already accounts for it", () => {
    const rule: SalaryRule = { id: CUTTER, userId: CUTTER, mode: "MANUAL", absentDayDeductionTiyn: T(5000) };
    expect(computeSalaryBase(rule, work).deductionTiyn).toBe(0);
  });

  it("FIXED_MONTHLY pays the configured amount", () => {
    const rule: SalaryRule = { id: CUTTER, userId: CUTTER, mode: "FIXED_MONTHLY", fixedMonthlyTiyn: T(250000) };
    expect(computeSalaryBase(rule, work).baseTiyn).toBe(T(250000));
  });

  it("PER_SHEET multiplies sheets by the per-sheet rate", () => {
    const rule: SalaryRule = { id: CUTTER, userId: CUTTER, mode: "PER_SHEET", perSheetTiyn: T(1500) };
    expect(computeSalaryBase(rule, work).baseTiyn).toBe(T(15000));
  });

  it("PER_PVC_METER multiplies metres by the per-metre rate", () => {
    const rule: SalaryRule = { id: PVC, userId: PVC, mode: "PER_PVC_METER", perPvcMeterTiyn: T(120) };
    expect(computeSalaryBase(rule, work).baseTiyn).toBe(T(6000));
  });

  it("PER_ORDER multiplies completed orders by the per-order rate", () => {
    const rule: SalaryRule = { id: CUTTER, userId: CUTTER, mode: "PER_ORDER", perOrderTiyn: T(2000) };
    expect(computeSalaryBase(rule, work).baseTiyn).toBe(T(8000));
  });

  it("HOURLY multiplies worked hours by the hourly rate", () => {
    const rule: SalaryRule = { id: CUTTER, userId: CUTTER, mode: "HOURLY", hourlyTiyn: T(1000) };
    expect(computeSalaryBase(rule, work).baseTiyn).toBe(T(160000));
  });

  it("MIXED adds every configured component and ignores the unset ones", () => {
    const rule: SalaryRule = {
      id: CUTTER, userId: CUTTER, mode: "MIXED",
      fixedMonthlyTiyn: T(100000), perSheetTiyn: T(1500), perPvcMeterTiyn: T(100),
    };
    // 100 000 + 10×1 500 + 50×100 (+ no per-order, no hourly)
    expect(computeSalaryBase(rule, work).baseTiyn).toBe(T(120000));
  });

  it("applies the absent-day deduction on non-MANUAL modes", () => {
    const rule: SalaryRule = {
      id: CUTTER, userId: CUTTER, mode: "FIXED_MONTHLY",
      fixedMonthlyTiyn: T(200000), absentDayDeductionTiyn: T(5000),
    };
    expect(computeSalaryBase(rule, work).deductionTiyn).toBe(T(10000));
  });
});

describe("computeFinalSalary", () => {
  it("adds bonus and adjustments, subtracts deductions", () => {
    expect(
      computeFinalSalary({ baseTiyn: T(200000), bonusTiyn: T(20000), deductionTiyn: T(15000), adjustmentTiyn: T(5000) }),
    ).toBe(T(210000));
  });

  it("applies a negative adjustment as a reduction", () => {
    expect(
      computeFinalSalary({ baseTiyn: T(100000), bonusTiyn: 0, deductionTiyn: 0, adjustmentTiyn: T(-30000) }),
    ).toBe(T(70000));
  });

  it("never returns a negative payslip", () => {
    expect(
      computeFinalSalary({ baseTiyn: T(10000), bonusTiyn: 0, deductionTiyn: T(99999), adjustmentTiyn: 0 }),
    ).toBe(0);
  });
});

describe("buildSalaryEntry", () => {
  it("defaults a worker with no rule to MANUAL with a zero base, but still reports measured work", () => {
    const entry = buildSalaryEntry({
      userId: CUTTER,
      userName: "Cutter",
      periodKey: "2026-03",
      rule: undefined,
      orders: [order({ assignedCutterId: CUTTER, confirmedSheets: 12, cuttingCompletedAt: MARCH })],
      attendance: [attendance({ status: "present", workedHours: 8 })],
    });
    expect(entry.mode).toBe("MANUAL");
    expect(entry.baseTiyn).toBe(0);
    expect(entry.finalTiyn).toBe(0);
    // The work is still measured and shown — only the pay formula is withheld.
    expect(entry.sheetsCut).toBe(12);
    expect(entry.presentDays).toBe(1);
  });

  it("a MANUAL worker is paid purely through an adjustment", () => {
    const entry = buildSalaryEntry({
      userId: CUTTER, userName: "Cutter", periodKey: "2026-03",
      rule: { id: CUTTER, userId: CUTTER, mode: "MANUAL" },
      orders: [], attendance: [], adjustmentTiyn: T(180000),
    });
    expect(entry.finalTiyn).toBe(T(180000));
  });
});

describe("availablePeriods — new months appear automatically", () => {
  it("always offers the current month even with no data at all", () => {
    const periods = availablePeriods([], [], new Date("2026-07-10T12:00:00+05:00"));
    expect(periods).toContain("2026-07");
  });

  it("derives months from completion dates and attendance, newest first, with no hardcoded list", () => {
    const periods = availablePeriods(
      [order({ cuttingCompletedAt: MARCH }), order({ pvcCompletedAt: APRIL })],
      [attendance({ date: "2026-01-09" })],
      new Date("2026-04-20T12:00:00+05:00"),
    );
    expect(periods).toEqual(["2026-04", "2026-03", "2026-01"]);
  });
});

describe("hoursBetween", () => {
  it("computes worked hours from check-in/check-out", () => {
    expect(hoursBetween("09:00", "18:00")).toBe(9);
    expect(hoursBetween("09:30", "18:00")).toBe(8.5);
  });
  it("returns undefined when either end is missing or the span is not positive", () => {
    expect(hoursBetween(undefined, "18:00")).toBeUndefined();
    expect(hoursBetween("09:00", undefined)).toBeUndefined();
    expect(hoursBetween("18:00", "09:00")).toBeUndefined();
  });
});
