import { describe, it, expect } from "vitest";
import { computePaymentStatus, canEnterCuttingQueue, getNextProductionStatuses, isCancellable } from "./statuses";

describe("computePaymentStatus", () => {
  it("unpaid when nothing paid", () => {
    expect(computePaymentStatus(100_000, 0)).toBe("unpaid");
  });
  it("partial when paid less than total (partial payment case)", () => {
    expect(computePaymentStatus(100_000, 50_000)).toBe("partial");
  });
  it("paid when paid equals total exactly (full payment case)", () => {
    expect(computePaymentStatus(100_000, 100_000)).toBe("paid");
  });
  it("overpaid when paid exceeds total", () => {
    expect(computePaymentStatus(100_000, 150_000)).toBe("overpaid");
  });
  it("mixed payments: sum of multiple methods is treated the same as one payment", () => {
    const cash = 50_000;
    const kaspi = 70_000;
    const nur = 30_000;
    const netPaid = cash + kaspi + nur;
    expect(computePaymentStatus(150_000, netPaid)).toBe("paid");
  });
});

describe("canEnterCuttingQueue", () => {
  it("allows paid and overpaid orders", () => {
    expect(canEnterCuttingQueue("paid")).toBe(true);
    expect(canEnterCuttingQueue("overpaid")).toBe(true);
  });
  it("blocks unpaid, partial and refunded orders", () => {
    expect(canEnterCuttingQueue("unpaid")).toBe(false);
    expect(canEnterCuttingQueue("partial")).toBe(false);
    expect(canEnterCuttingQueue("refunded")).toBe(false);
  });
});

describe("getNextProductionStatuses", () => {
  it("walks the linear pre-production workflow one step at a time", () => {
    expect(getNextProductionStatuses("draft", false)).toEqual(["submitted"]);
    expect(getNextProductionStatuses("submitted", false)).toEqual(["manager_review"]);
    expect(getNextProductionStatuses("price_calculated", false)).toEqual(["waiting_payment"]);
    expect(getNextProductionStatuses("paid", false)).toEqual(["cutting_queue"]);
  });
  it("manager_review can advance to price_calculated or be cancelled", () => {
    expect(getNextProductionStatuses("manager_review", false)).toEqual(["price_calculated", "cancelled"]);
  });
  it("waiting_payment can move to partially_paid or straight to paid", () => {
    expect(getNextProductionStatuses("waiting_payment", false)).toEqual(["partially_paid", "paid"]);
  });
  it("skips PVC entirely when the order doesn't need it", () => {
    expect(getNextProductionStatuses("cutting_completed", false)).toEqual(["ready"]);
  });
  it("routes through the PVC queue when the order needs it", () => {
    expect(getNextProductionStatuses("cutting_completed", true)).toEqual(["pvc_queue"]);
  });
  it("walks the cutting and PVC sub-workflows step by step", () => {
    expect(getNextProductionStatuses("cutting_queue", false)).toEqual(["cutting_started"]);
    expect(getNextProductionStatuses("cutting_started", false)).toEqual(["cutting_completed"]);
    expect(getNextProductionStatuses("pvc_queue", false)).toEqual(["pvc_started"]);
    expect(getNextProductionStatuses("pvc_started", false)).toEqual(["pvc_completed"]);
    expect(getNextProductionStatuses("pvc_completed", false)).toEqual(["ready"]);
    expect(getNextProductionStatuses("ready", false)).toEqual(["delivered"]);
  });
  it("terminal statuses have no further transitions", () => {
    expect(getNextProductionStatuses("delivered", false)).toEqual([]);
    expect(getNextProductionStatuses("cancelled", false)).toEqual([]);
  });
});

describe("isCancellable", () => {
  it("only pre-price-calculation orders can be cancelled", () => {
    expect(isCancellable("draft")).toBe(true);
    expect(isCancellable("submitted")).toBe(true);
    expect(isCancellable("manager_review")).toBe(true);
  });
  it("orders that already have a calculated price or are further along cannot be cancelled via this path", () => {
    expect(isCancellable("price_calculated")).toBe(false);
    expect(isCancellable("waiting_payment")).toBe(false);
    expect(isCancellable("cutting_queue")).toBe(false);
    expect(isCancellable("delivered")).toBe(false);
  });
});
