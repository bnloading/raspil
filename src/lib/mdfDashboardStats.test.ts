import { describe, it, expect } from "vitest";
import { Timestamp } from "firebase/firestore";
import { computeMdfBoard, computeMdfOverdue, computeMdfWorkerLoadToday, computeMdfWeeklyOutput } from "./mdfDashboardStats";
import type { Order } from "../types/domain";

function ts(date: Date): Timestamp {
  return { seconds: Math.floor(date.getTime() / 1000), nanoseconds: 0, toDate: () => date, toMillis: () => date.getTime() } as unknown as Timestamp;
}

let seq = 0;
function order(overrides: Partial<Order> = {}): Order {
  seq += 1;
  return {
    id: `o${seq}`,
    orderNumber: `#${seq}`,
    customerName: "Test",
    customerPhone: "",
    materialId: "",
    materialSnapshot: { name: "МДФ", article: "", color: "", thicknessMm: 0, sheetLengthMm: 0, sheetWidthMm: 0, sellingPriceTiyn: 0 },
    orderKind: "mdf_wrap",
    productionStatus: "waiting_payment",
    paymentStatus: "unpaid",
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

describe("computeMdfBoard", () => {
  it("buckets not-yet-queued orders under Кезек", () => {
    const board = computeMdfBoard([order({ productionStatus: "paid" })]);
    expect(board.find((c) => c.key === "queue")!.count).toBe(1);
  });

  it("buckets a production order under its current station", () => {
    const board = computeMdfBoard([order({ productionStatus: "mdf_production", mdfStage: "sanding" })]);
    expect(board.find((c) => c.key === "sanding")!.count).toBe(1);
    expect(board.find((c) => c.key === "cnc")!.count).toBe(0);
  });

  it("buckets ready/delivered under Дайын", () => {
    const board = computeMdfBoard([order({ productionStatus: "ready" }), order({ productionStatus: "delivered" })]);
    expect(board.find((c) => c.key === "ready")!.count).toBe(2);
  });

  it("ignores cancelled/draft orders and cutting-line orders entirely", () => {
    const board = computeMdfBoard([
      order({ productionStatus: "cancelled" }),
      order({ productionStatus: "draft" }),
      order({ orderKind: "cutting", productionStatus: "cutting_queue" }),
    ]);
    expect(board.every((c) => c.count === 0)).toBe(true);
  });
});

describe("computeMdfOverdue", () => {
  it("flags an in-production order past its expected completion", () => {
    const now = new Date("2026-09-03T12:00:00Z");
    const overdue = computeMdfOverdue(
      [
        order({
          productionStatus: "mdf_production",
          mdfStage: "cnc",
          mdfStageJobs: { cnc: { expectedCompletionAt: ts(new Date("2026-09-03T10:00:00Z")) } },
        }),
      ],
      now,
    );
    expect(overdue).toHaveLength(1);
  });

  it("does not flag an order still within its estimate", () => {
    const now = new Date("2026-09-03T12:00:00Z");
    const overdue = computeMdfOverdue(
      [
        order({
          productionStatus: "mdf_production",
          mdfStage: "cnc",
          mdfStageJobs: { cnc: { expectedCompletionAt: ts(new Date("2026-09-03T14:00:00Z")) } },
        }),
      ],
      now,
    );
    expect(overdue).toHaveLength(0);
  });
});

describe("computeMdfWorkerLoadToday", () => {
  it("counts one order per worker who touched the stage today", () => {
    const now = new Date("2026-09-03T12:00:00Z");
    const map = computeMdfWorkerLoadToday(
      [
        order({ mdfStageJobs: { cnc: { byName: "Ерлан", startedAt: ts(new Date("2026-09-03T09:00:00Z")) } } }),
        order({ mdfStageJobs: { cnc: { byName: "Ерлан", completedAt: ts(new Date("2026-09-03T11:00:00Z")) } } }),
        order({ mdfStageJobs: { cnc: { byName: "Ерлан", startedAt: ts(new Date("2026-09-02T09:00:00Z")) } } }),
      ],
      "cnc",
      now,
    );
    expect(map.get("Ерлан")).toBe(2);
  });
});

describe("computeMdfWeeklyOutput", () => {
  it("returns 7 days and sums finished area on the right day", () => {
    const now = new Date("2026-09-03T12:00:00Z");
    const out = computeMdfWeeklyOutput(
      [order({ mdfAreaM2: 12.5, mdfStageJobs: { vacuum: { completedAt: ts(new Date("2026-09-03T09:00:00Z")) } } })],
      now,
    );
    expect(out).toHaveLength(7);
    expect(out[out.length - 1].value).toBe(12.5);
  });
});
