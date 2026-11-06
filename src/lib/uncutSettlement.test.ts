import { describe, it, expect } from "vitest";
import type { Timestamp } from "firebase/firestore";
import type { OrderLineJob } from "../types/domain";
import { planUncutSettlement } from "./uncutSettlement";

const cutAt = { seconds: 1, nanoseconds: 0 } as unknown as Timestamp;
const job = (index: number, materialId: string, sheetQty: number, consumedQty?: number, over: Partial<OrderLineJob> = {}): OrderLineJob => ({
  index, materialId, materialName: materialId, sheetQty, pvcMeters: 0, ...(consumedQty !== undefined ? { consumedQty } : {}), ...over,
});
const all = { tracked: () => true };
const asObject = (m: Map<string, number>) => Object.fromEntries(m);

describe("planUncutSettlement — the rack after a journal edit to an order already queued", () => {
  it("changes nothing when an uncut line keeps its material, even with a new count — the cut settles that", () => {
    const plan = planUncutSettlement([job(0, "kash", 8, 8)], [job(0, "kash", 10)], { withoutCutting: false, ...all });
    expect(asObject(plan.deltas)).toEqual({});
    expect(plan.jobs[0].consumedQty).toBe(8);
  });

  it("gives the sheets back to the old material when an uncut line's material is changed", () => {
    const plan = planUncutSettlement([job(0, "kash", 8, 8)], [job(0, "votan", 8)], { withoutCutting: false, ...all });
    expect(asObject(plan.deltas)).toEqual({ kash: -8 });
    // Nothing held for Вотан yet: the cut charges it in full.
    expect(plan.jobs[0].consumedQty).toBe(0);
  });

  it("gives back the sheets of an uncut line deleted from the row", () => {
    const plan = planUncutSettlement(
      [job(0, "kash", 8, 8), job(1, "hdf", 2, 2)],
      [job(0, "kash", 8)],
      { withoutCutting: false, ...all },
    );
    expect(asObject(plan.deltas)).toEqual({ hdf: -2 });
  });

  it("takes or gives back the difference at once on an order handed over whole (№533: 4 → 5)", () => {
    const more = planUncutSettlement([job(0, "mdf", 4, 4)], [job(0, "mdf", 5)], { withoutCutting: true, ...all });
    expect(asObject(more.deltas)).toEqual({ mdf: 1 });
    expect(more.jobs[0].consumedQty).toBe(5);
    const less = planUncutSettlement([job(0, "mdf", 5, 5)], [job(0, "mdf", 3)], { withoutCutting: true, ...all });
    expect(asObject(less.deltas)).toEqual({ mdf: -2 });
  });

  it("moves a handed-over order's sheets from one material to the other when it is changed", () => {
    const plan = planUncutSettlement([job(0, "mdf", 4, 4)], [job(0, "kash", 4)], { withoutCutting: true, ...all });
    expect(asObject(plan.deltas)).toEqual({ mdf: -4, kash: 4 });
  });

  it("never touches a line the saw already cut", () => {
    const done = job(0, "kash", 8, 8, { cuttingCompletedAt: cutAt, confirmedSheets: 8 });
    const plan = planUncutSettlement([done, job(1, "hdf", 2, 2)], [{ ...done, sheetQty: 9 }, job(1, "hdf", 2)], { withoutCutting: false, ...all });
    expect(asObject(plan.deltas)).toEqual({});
    expect(plan.jobs[0]).toEqual({ ...done, sheetQty: 9 });
  });

  it("leaves alone a line the saw finished after the page was opened", () => {
    const plan = planUncutSettlement(
      [job(0, "kash", 8, 8)],
      [job(0, "kash", 8, 7, { cuttingCompletedAt: cutAt, confirmedSheets: 7 })],
      { withoutCutting: false, ...all },
    );
    expect(asObject(plan.deltas)).toEqual({});
  });

  it("holds nothing for a board the warehouse does not count", () => {
    const plan = planUncutSettlement([job(0, "ext", 3, 0)], [job(0, "ext", 4)], { withoutCutting: true, tracked: (id) => id !== "ext" });
    expect(asObject(plan.deltas)).toEqual({});
    expect(plan.jobs[0].consumedQty).toBe(0);
  });
});
