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

describe("the shop's actual pay rules", () => {
  // Cutter: 600 ₸ per ЛДСП sheet, 100 ₸ per ХДФ, 200 ₸ per countertop.
  const cutterRule: SalaryRule = {
    id: CUTTER, userId: CUTTER, mode: "PER_SHEET",
    perSheetTiyn: T(600), perHdfSheetTiyn: T(100), perCountertopTiyn: T(200),
  };
  // PVC worker: flat 350 000 ₸ a month regardless of metres.
  const pvcRule: SalaryRule = { id: PVC, userId: PVC, mode: "FIXED_MONTHLY", fixedMonthlyTiyn: T(350000) };

  const categories = new Map<string, "ldsp" | "hdf" | "countertop">([
    ["m-ldsp", "ldsp"], ["m-hdf", "hdf"], ["m-top", "countertop"],
  ]);

  it("pays a cutter each category at its own rate", () => {
    const work = measureWork(
      [
        order({ id: "a", materialId: "m-ldsp", assignedCutterId: CUTTER, confirmedSheets: 10, cuttingCompletedAt: MARCH }),
        order({ id: "b", materialId: "m-hdf", assignedCutterId: CUTTER, confirmedSheets: 4, cuttingCompletedAt: MARCH }),
        order({ id: "c", materialId: "m-top", assignedCutterId: CUTTER, confirmedSheets: 3, cuttingCompletedAt: MARCH }),
      ],
      [], CUTTER, "2026-03", categories,
    );
    expect(work).toMatchObject({ sheetsCut: 17, ldspSheets: 10, hdfSheets: 4, countertopSheets: 3 });
    // 10×600 + 4×100 + 3×200 = 6 000 + 400 + 600 = 7 000 ₸
    expect(computeSalaryBase(cutterRule, work).baseTiyn).toBe(T(7000));
  });

  it("splits a merged order across its own materials' categories, not the order's primary one", () => {
    // ORD с 10 лист ЛДСП + 4 лист ХДФ, typed as one journal merge — materialId only names the
    // primary line, but every material still owes its own category's rate.
    const merged = order({
      id: "merged",
      materialId: "m-ldsp",
      assignedCutterId: CUTTER,
      cuttingCompletedAt: MARCH,
      items: [
        { materialId: "m-ldsp", materialName: "ЛДСП", sheetQty: 10, sheetPriceTiyn: 0, pvcMeters: 0, pvcPricePerMeterTiyn: 0 },
        { materialId: "m-hdf", materialName: "ХДФ", sheetQty: 4, sheetPriceTiyn: 0, pvcMeters: 0, pvcPricePerMeterTiyn: 0 },
      ],
    });
    const work = measureWork([merged], [], CUTTER, "2026-03", categories);
    expect(work).toMatchObject({ sheetsCut: 14, ldspSheets: 10, hdfSheets: 4, ordersCompleted: 1 });
    // 10×600 + 4×100 = 6 000 + 400 = 6 400 ₸ — not 14×600, which is what charging the whole
    // merged total to the primary material's rate used to produce.
    expect(computeSalaryBase(cutterRule, work).baseTiyn).toBe(T(6400));
  });

  it("splits a merged order between two different workers, one per line", () => {
    const cutterB = "cutter-2";
    const merged = order({
      id: "merged",
      materialId: "m-ldsp",
      cuttingCompletedAt: MARCH,
      lineJobs: [
        { index: 0, materialId: "m-ldsp", materialName: "ЛДСП", sheetQty: 10, pvcMeters: 0, confirmedSheets: 10, cuttingByUid: CUTTER, cuttingCompletedAt: MARCH },
        { index: 1, materialId: "m-hdf", materialName: "ХДФ", sheetQty: 4, pvcMeters: 0, confirmedSheets: 4, cuttingByUid: cutterB, cuttingCompletedAt: MARCH },
      ],
    });
    const workA = measureWork([merged], [], CUTTER, "2026-03", categories);
    const workB = measureWork([merged], [], cutterB, "2026-03", categories);
    expect(workA).toMatchObject({ ldspSheets: 10, hdfSheets: 0, ordersCompleted: 1 });
    expect(workB).toMatchObject({ ldspSheets: 0, hdfSheets: 4, ordersCompleted: 1 });
  });

  it("prices МДФ on its own, falling back to the ЛДСП rate when no separate one is set", () => {
    // The shop's real rule: ХДФ/Столешница 300 ₸, ЛДСП/МДФ 600 ₸ — МДФ has no perMdfSheetTiyn of
    // its own, so it rides the base rate exactly like ЛДСП, without being folded into that count.
    const realRule: SalaryRule = {
      id: CUTTER, userId: CUTTER, mode: "PER_SHEET",
      perSheetTiyn: T(600), perHdfSheetTiyn: T(300), perCountertopTiyn: T(300),
    };
    const cats = new Map<string, "ldsp" | "hdf" | "countertop" | "mdf">([
      ["m-ldsp", "ldsp"], ["m-hdf", "hdf"], ["m-top", "countertop"], ["m-mdf", "mdf"],
    ]);
    const work = measureWork(
      [
        order({ id: "a", materialId: "m-hdf", assignedCutterId: CUTTER, confirmedSheets: 5, cuttingCompletedAt: MARCH }),
        order({ id: "b", materialId: "m-top", assignedCutterId: CUTTER, confirmedSheets: 2, cuttingCompletedAt: MARCH }),
        order({ id: "c", materialId: "m-ldsp", assignedCutterId: CUTTER, confirmedSheets: 6, cuttingCompletedAt: MARCH }),
        order({ id: "d", materialId: "m-mdf", assignedCutterId: CUTTER, confirmedSheets: 3, cuttingCompletedAt: MARCH }),
      ],
      [], CUTTER, "2026-03", cats,
    );
    expect(work).toMatchObject({ hdfSheets: 5, countertopSheets: 2, ldspSheets: 6, mdfSheets: 3 });
    // 5×300 + 2×300 + 6×600 + 3×600 = 1 500 + 600 + 3 600 + 1 800 = 7 500 ₸
    expect(computeSalaryBase(realRule, work).baseTiyn).toBe(T(7500));
  });

  it("charges МДФ its own configured rate when one is set, instead of the ЛДСП fallback", () => {
    const rule: SalaryRule = {
      id: CUTTER, userId: CUTTER, mode: "PER_SHEET",
      perSheetTiyn: T(600), perMdfSheetTiyn: T(450),
    };
    const cats = new Map<string, "mdf">([["m-mdf", "mdf"]]);
    const work = measureWork(
      [order({ materialId: "m-mdf", assignedCutterId: CUTTER, confirmedSheets: 4, cuttingCompletedAt: MARCH })],
      [], CUTTER, "2026-03", cats,
    );
    expect(computeSalaryBase(rule, work).baseTiyn).toBe(T(1800)); // 4×450, not 4×600
  });

  it("treats an uncategorised material as ЛДСП", () => {
    const work = measureWork(
      [order({ materialId: "unknown", assignedCutterId: CUTTER, confirmedSheets: 5, cuttingCompletedAt: MARCH })],
      [], CUTTER, "2026-03", categories,
    );
    expect(work.ldspSheets).toBe(5);
    expect(computeSalaryBase(cutterRule, work).baseTiyn).toBe(T(3000));
  });

  it("falls back to the ЛДСП rate when a category rate is not configured", () => {
    const flat: SalaryRule = { id: CUTTER, userId: CUTTER, mode: "PER_SHEET", perSheetTiyn: T(600) };
    const work = { ...EMPTY_WORK_TOTALS, ldspSheets: 1, hdfSheets: 1, countertopSheets: 1, sheetsCut: 3 };
    expect(computeSalaryBase(flat, work).baseTiyn).toBe(T(1800));
  });

  it("pays an uncategorised legacy total at the ЛДСП rate rather than zero", () => {
    // Entries measured before categories existed carry only sheetsCut.
    const legacy = { ...EMPTY_WORK_TOTALS, sheetsCut: 20 };
    expect(computeSalaryBase(cutterRule, legacy).baseTiyn).toBe(T(12000));
  });

  it("pays the PVC worker a flat monthly amount, independent of metres", () => {
    const busy = { ...EMPTY_WORK_TOTALS, pvcMeters: 900 };
    const quiet = { ...EMPTY_WORK_TOTALS, pvcMeters: 12 };
    expect(computeSalaryBase(pvcRule, busy).baseTiyn).toBe(T(350000));
    expect(computeSalaryBase(pvcRule, quiet).baseTiyn).toBe(T(350000));
  });

  it("builds a full cutter payslip end to end", () => {
    const entry = buildSalaryEntry({
      userId: CUTTER, userName: "Распилшик", periodKey: "2026-03",
      rule: cutterRule,
      orders: [
        order({ id: "a", materialId: "m-ldsp", assignedCutterId: CUTTER, confirmedSheets: 120, cuttingCompletedAt: MARCH }),
        order({ id: "b", materialId: "m-hdf", assignedCutterId: CUTTER, confirmedSheets: 30, cuttingCompletedAt: MARCH }),
        order({ id: "c", materialId: "m-top", assignedCutterId: CUTTER, confirmedSheets: 10, cuttingCompletedAt: MARCH }),
      ],
      attendance: [], categoryByMaterialId: categories,
    });
    // 120×600 + 30×100 + 10×200 = 72 000 + 3 000 + 2 000 = 77 000 ₸
    expect(entry.baseTiyn).toBe(T(77000));
    expect(entry.finalTiyn).toBe(T(77000));
    expect(entry.mode).toBe("PER_SHEET");
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
