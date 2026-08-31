import { describe, it, expect } from "vitest";
import { Timestamp } from "firebase/firestore";
import {
  allCuttingDone,
  allPvcDone,
  buildLineJobs,
  jobSummary,
  jobsOf,
  orderNeedsPvc,
  patchJob,
  totalConfirmedSheets,
} from "./orderLines";
import type { Order, OrderLineJob } from "../types/domain";

const ts = () => Timestamp.fromDate(new Date("2026-08-31T10:00:00+05:00"));

const order = (over: Partial<Order> = {}): Order =>
  ({
    id: "o1",
    orderNumber: "ORD-2026-000001",
    materialId: "ldsp-ak",
    materialSnapshot: { name: "ЛДСП Ақ", sellingPriceTiyn: 1600000 },
    estimatedSheets: 13,
    confirmedSheets: 13,
    pvcMetersTotal: 176,
    pvcPricePerMeterTiyn: 20000,
    ...over,
  }) as unknown as Order;

const job = (over: Partial<OrderLineJob> = {}): OrderLineJob => ({
  index: 0,
  materialId: "ldsp-ak",
  materialName: "ЛДСП Ақ",
  sheetQty: 10,
  pvcMeters: 176,
  ...over,
});

describe("buildLineJobs", () => {
  it("makes one job per merged material line", () => {
    const jobs = buildLineJobs(
      order({
        items: [
          { materialId: "ldsp-ak", materialName: "ЛДСП Ақ", sheetQty: 10, sheetPriceTiyn: 1600000, pvcMeters: 176, pvcPricePerMeterTiyn: 20000 },
          { materialId: "hdf-white", materialName: "ХДФ", sheetQty: 3, sheetPriceTiyn: 750000, pvcMeters: 0, pvcPricePerMeterTiyn: 0 },
        ],
      }),
    );
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({ index: 0, materialId: "ldsp-ak", sheetQty: 10, pvcMeters: 176 });
    expect(jobs[1]).toMatchObject({ index: 1, materialId: "hdf-white", sheetQty: 3, pvcMeters: 0 });
  });

  it("makes a single job for an order that was never merged", () => {
    const jobs = buildLineJobs(order());
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ index: 0, materialId: "ldsp-ak", sheetQty: 13, pvcMeters: 176 });
  });

  it("carries no money — a cutter's write must never be able to touch a price", () => {
    const jobs = buildLineJobs(order());
    expect(Object.keys(jobs[0]).some((k) => k.toLowerCase().includes("tiyn"))).toBe(false);
  });
});

describe("jobsOf", () => {
  it("prefers what is stored on the order", () => {
    const stored = [job({ confirmedSheets: 9, cuttingCompletedAt: ts() })];
    expect(jobsOf(order({ lineJobs: stored }))).toBe(stored);
  });

  it("falls back to the lines for an order queued before per-line tracking", () => {
    expect(jobsOf(order({ lineJobs: [] }))).toHaveLength(1);
  });
});

describe("completion", () => {
  it("an order leaves the saw only when every material is cut", () => {
    const jobs = [job({ cuttingCompletedAt: ts() }), job({ index: 1, materialId: "hdf-white", pvcMeters: 0 })];
    expect(allCuttingDone(jobs)).toBe(false);
    expect(allCuttingDone(patchJob(jobs, 1, { cuttingCompletedAt: ts() }))).toBe(true);
  });

  it("lines with no ПВХ never hold the order up", () => {
    const jobs = [
      job({ pvcMeters: 176, pvcCompletedAt: ts() }),
      job({ index: 1, materialId: "hdf-white", pvcMeters: 0 }),
    ];
    expect(allPvcDone(jobs)).toBe(true);
    expect(orderNeedsPvc(jobs)).toBe(true);
  });

  it("an order with no banding at all counts as PVC-done and PVC-free", () => {
    const jobs = [job({ pvcMeters: 0 })];
    expect(allPvcDone(jobs)).toBe(true);
    expect(orderNeedsPvc(jobs)).toBe(false);
  });
});

describe("patchJob", () => {
  it("rewrites one line and leaves the rest alone", () => {
    const jobs = [job(), job({ index: 1, materialId: "hdf-white", sheetQty: 3, pvcMeters: 0 })];
    const next = patchJob(jobs, 1, { confirmedSheets: 2 });
    expect(next[1].confirmedSheets).toBe(2);
    expect(next[0]).toEqual(jobs[0]);
    expect(jobs[1].confirmedSheets).toBeUndefined(); // input untouched
  });
});

describe("totalConfirmedSheets", () => {
  it("uses what was counted, and the plan for lines not yet cut", () => {
    const jobs = [job({ confirmedSheets: 9 }), job({ index: 1, sheetQty: 3, pvcMeters: 0 })];
    expect(totalConfirmedSheets(jobs)).toBe(12);
  });
});

describe("jobSummary", () => {
  it("reads like the order summary, per line", () => {
    expect(jobSummary(job())).toBe("10 лист · 176 м ПВХ");
    expect(jobSummary(job({ pvcMeters: 0 }))).toBe("10 лист");
    expect(jobSummary(job({ sheetQty: 10, confirmedSheets: 9, pvcMeters: 0 }))).toBe("9 лист");
    expect(jobSummary(job({ sheetQty: 0, pvcMeters: 0 }))).toBe("—");
  });
});
