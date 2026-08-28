import { describe, it, expect } from "vitest";
import { pvcStockStatus, lowPvcCount, pvcConsumption, applyConsumption } from "./pvcStock";

const t = (metersOnHand: number, minStockMeters = 20) => ({ metersOnHand, minStockMeters });

describe("pvcStockStatus", () => {
  it("bands the stock against the colour's own floor", () => {
    expect(pvcStockStatus(t(200)).level).toBe("ok");
    expect(pvcStockStatus(t(35)).level).toBe("low");      // within 2x the floor
    expect(pvcStockStatus(t(15)).level).toBe("critical"); // at or under it
    expect(pvcStockStatus(t(0)).level).toBe("out");
  });

  it("scales with the floor, so a fast and a slow colour both warn correctly", () => {
    expect(pvcStockStatus(t(60, 20)).level).toBe("ok");
    expect(pvcStockStatus(t(60, 100)).level).toBe("critical");
  });

  it("has no 'getting low' band when no floor is set", () => {
    expect(pvcStockStatus({ metersOnHand: 1, minStockMeters: 0 }).level).toBe("ok");
    expect(pvcStockStatus({ metersOnHand: 0, minStockMeters: 0 }).level).toBe("out");
  });

  it("treats a missing or negative total as empty", () => {
    expect(pvcStockStatus({ metersOnHand: undefined, minStockMeters: 20 }).metersOnHand).toBe(0);
    expect(pvcStockStatus(t(-5)).level).toBe("out");
  });

  it("gives a bar ratio that fills at three times the floor", () => {
    expect(pvcStockStatus(t(60, 20)).ratio).toBe(1);
    expect(pvcStockStatus(t(20, 20)).ratio).toBeCloseTo(1 / 3, 5);
    expect(pvcStockStatus(t(0, 20)).ratio).toBe(0);
  });

  it("carries a Kazakh label", () => {
    expect(pvcStockStatus(t(15)).label).toBe("Таусылуға жақын");
  });
});

describe("lowPvcCount", () => {
  it("counts colours at or under their floor, empty ones included", () => {
    expect(lowPvcCount([t(200), t(35), t(15), t(0)])).toBe(2);
  });
});

describe("pvcConsumption", () => {
  const use = (pvcTypeId: string, meters: number) => ({
    pvcTypeId, colorName: "", thicknessMm: 1, meters, costTiyn: 0,
  });

  it("totals metres per colour", () => {
    const m = pvcConsumption({ pvcByType: [use("white", 12), use("gray", 8), use("white", 3)] });
    expect(m.get("white")).toBe(15);
    expect(m.get("gray")).toBe(8);
  });

  it("is empty for an order with no colour breakdown, rather than guessing a roll", () => {
    // A walk-in typed into the journal has metres but no colour — deducting from an arbitrary
    // colour would corrupt the count.
    expect(pvcConsumption({ pvcByType: undefined }).size).toBe(0);
    expect(pvcConsumption({ pvcByType: [] }).size).toBe(0);
  });

  it("skips entries with no colour or no length", () => {
    const m = pvcConsumption({ pvcByType: [use("", 10), use("white", 0), use("gray", 5)] });
    expect([...m.keys()]).toEqual(["gray"]);
  });
});

describe("applyConsumption", () => {
  it("subtracts what was used", () => {
    expect(applyConsumption(100, 12.5)).toBe(87.5);
  });

  it("floors at zero rather than blocking a job that is already glued", () => {
    expect(applyConsumption(5, 40)).toBe(0);
  });

  it("rounds to centimetres so floating point does not accumulate", () => {
    expect(applyConsumption(10, 3.3000000000000003)).toBe(6.7);
  });

  it("tolerates missing numbers", () => {
    expect(applyConsumption(undefined as unknown as number, 5)).toBe(0);
    expect(applyConsumption(10, undefined as unknown as number)).toBe(10);
  });
});
