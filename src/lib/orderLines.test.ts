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
  syncLineJobs,
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

  // This is the one hop that carries Прифуговка from the priced line to the shop floor: it is what
  // enterCuttingQueue() persists into lineJobs, so without it the PVC worker never sees the flag.
  it("carries Прифуговка through to the line's production job, per line", () => {
    const jobs = buildLineJobs(
      order({
        items: [
          { materialId: "ldsp-ak", materialName: "ЛДСП Ақ", sheetQty: 10, sheetPriceTiyn: 1600000, pvcMeters: 176, pvcPricePerMeterTiyn: 20000, pvcJointed: true },
          { materialId: "ldsp-kashemir", materialName: "ЛДСП Кашемир", sheetQty: 4, sheetPriceTiyn: 1600000, pvcMeters: 50, pvcPricePerMeterTiyn: 20000 },
        ],
      }),
    );
    expect(jobs[0].pvcJointed).toBe(true);
    // Not set on a line that was never flagged — and absent rather than false, since Firestore
    // rejects undefined and the field is optional everywhere downstream.
    expect(jobs[1].pvcJointed).toBeUndefined();
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

describe("syncLineJobs — the shop floor's copy follows the ledger", () => {
  const work = (over: Partial<{ materialId: string; materialName: string; sheetQty: number; pvcMeters: number }> = {}) => ({
    materialId: "ldsp-ak",
    materialName: "ЛДСП Ақ",
    sheetQty: 10,
    pvcMeters: 176,
    ...over,
  });

  it("fills in a line that reached the saw before its material was typed", () => {
    // Exactly ORD-2026-000142: queued with a blank row, the material entered afterwards, and the
    // cutter left holding a job for nothing at all.
    const started = [job({ materialId: "", materialName: "", sheetQty: 0, pvcMeters: 0, cuttingStartedAt: ts(), cuttingByName: "Олжас" })];
    const [synced] = syncLineJobs(started, [work({ materialName: "Столешница", sheetQty: 1, pvcMeters: 0 })]);
    expect(synced).toMatchObject({ materialId: "ldsp-ak", materialName: "Столешница", sheetQty: 1 });
    // The record of what the person did survives the correction.
    expect(synced.cuttingStartedAt).toBe(started[0].cuttingStartedAt);
    expect(synced.cuttingByName).toBe("Олжас");
  });

  it("never rewrites a line that has already been cut", () => {
    const done = [job({ sheetQty: 10, cuttingCompletedAt: ts(), confirmedSheets: 9, cuttingByName: "Олжас" })];
    const [synced] = syncLineJobs(done, [work({ sheetQty: 40, materialName: "Басқа материал" })]);
    // Not one field of it moves: the sheets were counted, charged and paid for as they stand.
    expect(synced).toEqual(done[0]);
  });

  it("keeps a finished job even when its line is deleted from the bill", () => {
    const jobs = [job({ index: 0, sheetQty: 4 }), job({ index: 1, sheetQty: 6, cuttingCompletedAt: ts(), confirmedSheets: 6 })];
    const synced = syncLineJobs(jobs, [work({ sheetQty: 4 })]);
    expect(synced).toHaveLength(2);
    expect(synced[1].confirmedSheets).toBe(6);
    expect(synced.map((j) => j.index)).toEqual([0, 1]);
  });

  it("drops a line that was removed before anyone cut it", () => {
    const jobs = [job({ index: 0, sheetQty: 4 }), job({ index: 1, sheetQty: 6 })];
    expect(syncLineJobs(jobs, [work({ sheetQty: 4 })])).toHaveLength(1);
  });

  it("adds a job for a line typed in after the order was queued", () => {
    const synced = syncLineJobs([job({ sheetQty: 4 })], [work({ sheetQty: 4 }), work({ materialId: "hdf", materialName: "ХДФ", sheetQty: 3, pvcMeters: 0 })]);
    expect(synced).toHaveLength(2);
    expect(synced[1]).toMatchObject({ index: 1, materialId: "hdf", sheetQty: 3 });
  });
});
