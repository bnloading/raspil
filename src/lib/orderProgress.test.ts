import { describe, it, expect } from "vitest";
import { orderProgress, progressSummary, type StepKey, type StepState } from "./orderProgress";
import type { Order } from "../types/domain";

const T = (n: number) => n * 100;

function order(overrides: Partial<Order> = {}): Order {
  return {
    id: "o1",
    orderNumber: "ORD-2026-000001",
    customerName: "Алмат",
    customerPhone: "77001112233",
    materialId: "m1",
    materialSnapshot: {
      name: "ЛДСП Ақ", article: "A-1", color: "Ақ",
      thicknessMm: 16, sheetLengthMm: 2800, sheetWidthMm: 2070, sellingPriceTiyn: T(16200),
    },
    productionStatus: "submitted",
    paymentStatus: "unpaid",
    priority: 0,
    estimatedSheets: 1,
    pvcMetersTotal: 0,
    materialCostTiyn: 0, cuttingCostTiyn: 0, pvcCostTiyn: 0, hdfCostTiyn: 0,
    extraServicesTiyn: 0, deliveryCostTiyn: 0, discountTiyn: 0,
    totalTiyn: T(1000), paidTiyn: 0, debtTiyn: T(1000),
    pricePublished: true,
    isDraft: false,
    ...overrides,
  };
}

const state = (o: Order, key: StepKey): StepState =>
  orderProgress(o).find((s) => s.key === key)!.state;

describe("orderProgress", () => {
  it("always returns the four milestones in order", () => {
    expect(orderProgress(order()).map((s) => s.key)).toEqual(["payment", "cutting", "pvc", "ready"]);
  });

  describe("Төлем", () => {
    it("unpaid is a problem, not merely pending — it blocks the queue", () => {
      expect(state(order({ paymentStatus: "unpaid" }), "payment")).toBe("problem");
    });
    it("partial is in progress", () => {
      expect(state(order({ paymentStatus: "partial" }), "payment")).toBe("active");
    });
    it("paid and overpaid are done", () => {
      expect(state(order({ paymentStatus: "paid" }), "payment")).toBe("done");
      expect(state(order({ paymentStatus: "overpaid" }), "payment")).toBe("done");
    });
  });

  describe("Распил", () => {
    it("is pending before the queue", () => {
      expect(state(order({ productionStatus: "submitted" }), "cutting")).toBe("pending");
    });
    it("is active in the queue and while cutting", () => {
      expect(state(order({ productionStatus: "cutting_queue" }), "cutting")).toBe("active");
      expect(state(order({ productionStatus: "cutting_started" }), "cutting")).toBe("active");
    });
    it("is done once cut, and stays done later in the flow", () => {
      expect(state(order({ productionStatus: "cutting_completed" }), "cutting")).toBe("done");
      expect(state(order({ productionStatus: "delivered" }), "cutting")).toBe("done");
    });
  });

  describe("ПВХ", () => {
    it("is skipped when the order has no edging at all", () => {
      expect(state(order({ pvcMetersTotal: 0, productionStatus: "ready" }), "pvc")).toBe("skipped");
    });
    it("is pending, active then done when the order does have edging", () => {
      expect(state(order({ pvcMetersTotal: 12, productionStatus: "cutting_queue" }), "pvc")).toBe("pending");
      expect(state(order({ pvcMetersTotal: 12, productionStatus: "pvc_queue" }), "pvc")).toBe("active");
      expect(state(order({ pvcMetersTotal: 12, productionStatus: "pvc_started" }), "pvc")).toBe("active");
      expect(state(order({ pvcMetersTotal: 12, productionStatus: "pvc_completed" }), "pvc")).toBe("done");
    });
  });

  describe("Дайын", () => {
    it("is done when ready or delivered", () => {
      expect(state(order({ productionStatus: "ready" }), "ready")).toBe("done");
      expect(state(order({ productionStatus: "delivered" }), "ready")).toBe("done");
    });
    it("is pending otherwise", () => {
      expect(state(order({ productionStatus: "cutting_started" }), "ready")).toBe("pending");
    });
  });

  it("marks every step skipped on a cancelled order", () => {
    const steps = orderProgress(order({ productionStatus: "cancelled", paymentStatus: "paid", pvcMetersTotal: 10 }));
    expect(steps.every((s) => s.state === "skipped")).toBe(true);
  });

  it("never treats cancelled as being furthest along", () => {
    // "cancelled" sorts last in PRODUCTION_STATUS_ORDER; a naive rank comparison would call it done.
    expect(state(order({ productionStatus: "cancelled" }), "cutting")).not.toBe("done");
  });

  describe("МДФ orders", () => {
    it("collapses to three milestones instead of the cutting/pvc four", () => {
      expect(orderProgress(order({ orderKind: "mdf_wrap" })).map((s) => s.key)).toEqual([
        "payment",
        "mdf",
        "ready",
      ]);
    });
    it("МДФ step is pending before production, active during it, done once ready", () => {
      expect(state(order({ orderKind: "mdf_wrap", productionStatus: "paid" }), "mdf")).toBe("pending");
      expect(state(order({ orderKind: "mdf_wrap", productionStatus: "mdf_production" }), "mdf")).toBe("active");
      expect(state(order({ orderKind: "mdf_wrap", productionStatus: "ready" }), "mdf")).toBe("done");
    });
  });
});

describe("progressSummary", () => {
  it("names the blocking step first", () => {
    expect(progressSummary(order({ paymentStatus: "unpaid" }))).toBe("Төлем күтілуде");
  });
  it("names the step in progress when nothing is blocking", () => {
    expect(progressSummary(order({ paymentStatus: "paid", productionStatus: "cutting_started" })))
      .toBe("Распил орындалуда");
  });
  it("names the last finished step when nothing is active", () => {
    expect(progressSummary(order({ paymentStatus: "paid", productionStatus: "ready" }))).toBe("Дайын аяқталды");
  });
  it("says so for a cancelled order", () => {
    expect(progressSummary(order({ productionStatus: "cancelled" }))).toBe("Бас тартылды");
  });
});
