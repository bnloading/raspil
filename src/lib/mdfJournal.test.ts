import { describe, it, expect } from "vitest";
import { computeMdfOrderTotal, computeMdfPanelsAreaM2, formatMdfArea, type MdfOrderInput } from "./mdfJournal";

const T = (n: number) => n * 100; // ₸ → tiyn

function order(overrides: Partial<MdfOrderInput> = {}): MdfOrderInput {
  return {
    areaM2: 0,
    pricePerM2Tiyn: 0,
    extraServicesTiyn: 0,
    deliveryCostTiyn: 0,
    discountTiyn: 0,
    paidTiyn: 0,
    ...overrides,
  };
}

describe("computeMdfOrderTotal", () => {
  it("multiplies area by the per-m² price", () => {
    const r = computeMdfOrderTotal(order({ areaM2: 8.4, pricePerM2Tiyn: T(5000) }));
    expect(r.areaCostTiyn).toBe(T(42000));
    expect(r.totalTiyn).toBe(T(42000));
  });

  it("adds extras and delivery, then subtracts the discount", () => {
    const r = computeMdfOrderTotal(
      order({
        areaM2: 10,
        pricePerM2Tiyn: T(5000),
        extraServicesTiyn: T(3000),
        deliveryCostTiyn: T(2000),
        discountTiyn: T(5000),
      }),
    );
    expect(r.totalTiyn).toBe(T(50000) + T(3000) + T(2000) - T(5000));
  });

  it("floors the total at zero when the discount exceeds the cost", () => {
    const r = computeMdfOrderTotal(order({ areaM2: 1, pricePerM2Tiyn: T(1000), discountTiyn: T(5000) }));
    expect(r.totalTiyn).toBe(0);
  });

  it("debt is total minus paid, and can go negative when overpaid", () => {
    const r = computeMdfOrderTotal(order({ areaM2: 10, pricePerM2Tiyn: T(1000), paidTiyn: T(15000) }));
    expect(r.totalTiyn).toBe(T(10000));
    expect(r.debtTiyn).toBe(T(-5000));
    expect(r.paymentStatus).toBe("overpaid");
  });

  it("rounds fractional area×price to whole tiyn", () => {
    const r = computeMdfOrderTotal(order({ areaM2: 3.333, pricePerM2Tiyn: 12345 }));
    expect(Number.isInteger(r.areaCostTiyn)).toBe(true);
  });
});

describe("computeMdfPanelsAreaM2", () => {
  it("converts one panel's mm dimensions to m²", () => {
    expect(computeMdfPanelsAreaM2([{ lengthMm: 2000, widthMm: 600, qty: 1 }])).toBeCloseTo(1.2);
  });

  it("multiplies by quantity", () => {
    expect(computeMdfPanelsAreaM2([{ lengthMm: 1000, widthMm: 500, qty: 3 }])).toBeCloseTo(1.5);
  });

  it("sums several panels of different sizes", () => {
    const total = computeMdfPanelsAreaM2([
      { lengthMm: 2000, widthMm: 600, qty: 1 }, // 1.2
      { lengthMm: 800, widthMm: 400, qty: 2 }, // 0.64
    ]);
    expect(total).toBeCloseTo(1.84);
  });

  it("is zero for an empty panel list", () => {
    expect(computeMdfPanelsAreaM2([])).toBe(0);
  });
});

describe("formatMdfArea", () => {
  it("rounds mm-derived float noise away to two decimals", () => {
    // 2000×600×2 + 800×400×3, in mm, is the classic case that leaves 3.3600000000000003 in JS.
    const noisy = computeMdfPanelsAreaM2([
      { lengthMm: 2000, widthMm: 600, qty: 2 },
      { lengthMm: 800, widthMm: 400, qty: 3 },
    ]);
    expect(formatMdfArea(noisy)).toBe("3.36 м²");
  });

  it("defaults a missing area to zero rather than showing nothing", () => {
    expect(formatMdfArea(undefined)).toBe("0.00 м²");
    expect(formatMdfArea(null)).toBe("0.00 м²");
  });
});
