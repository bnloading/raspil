import { describe, it, expect } from "vitest";
import { Timestamp } from "firebase/firestore";
import { buildCutterHistory } from "./cutterHistory";
import type { Order, OrderLineJob } from "../types/domain";

const CUTTER = "cutter-1";
const OTHER = "cutter-2";
const at = (iso: string) => Timestamp.fromDate(new Date(`${iso}T10:00:00+05:00`));

const order = (over: Partial<Order> = {}): Order =>
  ({
    id: "o1",
    orderNumber: "ORD-2026-000001",
    customerName: "Асет",
    materialId: "m1",
    materialSnapshot: { name: "ЛДСП Ақ", sellingPriceTiyn: 0 },
    estimatedSheets: 5,
    pvcMetersTotal: 0,
    ...over,
  }) as unknown as Order;

const job = (over: Partial<OrderLineJob> = {}): OrderLineJob => ({
  index: 0,
  materialId: "m1",
  materialName: "ЛДСП Ақ",
  sheetQty: 5,
  pvcMeters: 0,
  ...over,
});

describe("buildCutterHistory", () => {
  it("skips an order this cutter never actually finished a line on", () => {
    expect(buildCutterHistory([order({ lineJobs: [job()] })], CUTTER)).toHaveLength(0);
  });

  it("counts only this cutter's own lines on a merged order, not the other cutter's", () => {
    const merged = order({
      lineJobs: [
        job({ index: 0, materialId: "m-ldsp", materialName: "ЛДСП", sheetQty: 10, confirmedSheets: 10, cuttingByUid: CUTTER, cuttingCompletedAt: at("2026-08-25") }),
        job({ index: 1, materialId: "m-hdf", materialName: "ХДФ", sheetQty: 4, confirmedSheets: 4, cuttingByUid: OTHER, cuttingCompletedAt: at("2026-08-25") }),
      ],
    });
    const [entry] = buildCutterHistory([merged], CUTTER);
    expect(entry.sheets).toBe(10);
    expect(entry.materials).toEqual(["ЛДСП"]);
  });

  it("dates the entry by the latest of this cutter's own lines", () => {
    const merged = order({
      lineJobs: [
        job({ index: 0, materialName: "ЛДСП", confirmedSheets: 5, cuttingByUid: CUTTER, cuttingCompletedAt: at("2026-08-25") }),
        job({ index: 1, materialId: "m-hdf", materialName: "ХДФ", confirmedSheets: 2, cuttingByUid: CUTTER, cuttingCompletedAt: at("2026-08-27") }),
      ],
    });
    const [entry] = buildCutterHistory([merged], CUTTER);
    expect(entry.completedAt.toMillis()).toBe(at("2026-08-27").toMillis());
    expect(entry.sheets).toBe(7);
  });

  it("sorts newest first across orders", () => {
    const a = order({ id: "a", lineJobs: [job({ cuttingByUid: CUTTER, cuttingCompletedAt: at("2026-08-20") })] });
    const b = order({ id: "b", lineJobs: [job({ cuttingByUid: CUTTER, cuttingCompletedAt: at("2026-08-28") })] });
    const entries = buildCutterHistory([a, b], CUTTER);
    expect(entries.map((e) => e.orderId)).toEqual(["b", "a"]);
  });

  it("falls back to the legacy single-line shape for an order that predates per-line jobs", () => {
    const legacy = order({
      lineJobs: undefined,
      assignedCutterId: CUTTER,
      cuttingCompletedAt: at("2026-08-15"),
      confirmedSheets: 13,
    });
    const entries = buildCutterHistory([legacy], CUTTER);
    expect(entries).toHaveLength(1);
    expect(entries[0].sheets).toBe(13);
  });
});
