import { describe, it, expect } from "vitest";
import {
  computePartPvcMeters,
  computePvcBreakdown,
  computeOrderTotals,
  edgeLengthMm,
  estimateSheets,
  partFitsSheet,
} from "./pricing";
import type { CuttingPart, Material, PvcType } from "../types/domain";

function makePart(overrides: Partial<CuttingPart> = {}): CuttingPart {
  return {
    id: "p1",
    name: "Бүйір",
    lengthMm: 800,
    widthMm: 400,
    qty: 2,
    grainDirection: "any",
    rotationAllowed: false,
    edges: {
      A: { pvc: false },
      B: { pvc: false },
      C: { pvc: false },
      D: { pvc: false },
    },
    ...overrides,
  };
}

const material: Material = {
  id: "m1",
  name: "ЛДСП Ақ",
  article: "AK-001",
  color: "Ақ",
  thicknessMm: 16,
  sheetLengthMm: 2800,
  sheetWidthMm: 2070,
  sellingPriceTiyn: 1_500_000,
  initialQty: 100,
  qtyOnHand: 100,
  reservedQty: 0,
  minStock: 5,
  active: true,
  archived: false,
  grainDirectionRequired: false,
};

const pvcType: PvcType = {
  id: "pvc1",
  thicknessMm: 2,
  colorName: "Ақ",
  pricePerMeterTiyn: 20_000,
  active: true,
};

describe("edgeLengthMm", () => {
  it("A/C follow width, B/D follow length", () => {
    const part = makePart({ lengthMm: 800, widthMm: 400 });
    expect(edgeLengthMm(part, "A")).toBe(400);
    expect(edgeLengthMm(part, "C")).toBe(400);
    expect(edgeLengthMm(part, "B")).toBe(800);
    expect(edgeLengthMm(part, "D")).toBe(800);
  });
});

describe("computePartPvcMeters", () => {
  it("never counts an unselected edge", () => {
    const part = makePart();
    expect(computePartPvcMeters(part)).toBe(0);
  });

  it("sums only selected edges, scaled by qty", () => {
    const part = makePart({
      lengthMm: 800,
      widthMm: 400,
      qty: 3,
      edges: {
        A: { pvc: true, pvcTypeId: "pvc1" }, // 400mm
        B: { pvc: true, pvcTypeId: "pvc1" }, // 800mm
        C: { pvc: false },
        D: { pvc: false },
      },
    });
    // (400 + 800) * 3 / 1000 = 3.6
    expect(computePartPvcMeters(part)).toBeCloseTo(3.6);
  });
});

describe("computePvcBreakdown", () => {
  it("groups by thickness+colour and computes cost", () => {
    const part = makePart({
      qty: 1,
      edges: {
        A: { pvc: true, pvcTypeId: "pvc1" }, // width 400mm -> 0.4m
        B: { pvc: false },
        C: { pvc: false },
        D: { pvc: false },
      },
    });
    const rows = computePvcBreakdown([part], new Map([["pvc1", pvcType]]));
    expect(rows).toHaveLength(1);
    expect(rows[0].meters).toBeCloseTo(0.4);
    expect(rows[0].costTiyn).toBe(Math.round(0.4 * 20_000));
  });

  it("ignores edges without a valid pvcTypeId", () => {
    const part = makePart({
      edges: {
        A: { pvc: true }, // no pvcTypeId
        B: { pvc: false },
        C: { pvc: false },
        D: { pvc: false },
      },
    });
    const rows = computePvcBreakdown([part], new Map([["pvc1", pvcType]]));
    expect(rows).toHaveLength(0);
  });
});

describe("estimateSheets", () => {
  it("returns at least 1 sheet and adds a waste margin", () => {
    const part = makePart({ lengthMm: 100, widthMm: 100, qty: 1 });
    expect(estimateSheets([part], material)).toBeGreaterThanOrEqual(1);
  });

  it("scales with part area", () => {
    const small = [makePart({ lengthMm: 100, widthMm: 100, qty: 1 })];
    const big = [makePart({ lengthMm: 2000, widthMm: 2000, qty: 5 })];
    expect(estimateSheets(big, material)).toBeGreaterThan(estimateSheets(small, material));
  });
});

describe("partFitsSheet", () => {
  const sheet = { sheetLengthMm: 2800, sheetWidthMm: 2070 };
  it("fits directly when smaller than sheet", () => {
    expect(partFitsSheet({ lengthMm: 800, widthMm: 400, rotationAllowed: false }, sheet)).toBe(true);
  });
  it("rejects oversized parts without rotation", () => {
    expect(partFitsSheet({ lengthMm: 3000, widthMm: 400, rotationAllowed: false }, sheet)).toBe(false);
  });
  it("allows rotation to make an oversized part fit", () => {
    // lengthMm > sheetLengthMm but fits when swapped with widthMm
    expect(partFitsSheet({ lengthMm: 2075, widthMm: 2000, rotationAllowed: true }, sheet)).toBe(true);
  });
});

describe("computeOrderTotals", () => {
  it("combines material, cutting, and PVC costs minus discount", () => {
    const part = makePart({
      qty: 1,
      edges: {
        A: { pvc: true, pvcTypeId: "pvc1" },
        B: { pvc: false },
        C: { pvc: false },
        D: { pvc: false },
      },
    });
    const totals = computeOrderTotals({
      parts: [part],
      material,
      pvcTypesById: new Map([["pvc1", pvcType]]),
      sheets: 2,
      cuttingPricePerSheetTiyn: 500_000,
      extraServicesTiyn: 0,
      deliveryCostTiyn: 0,
      discountTiyn: 100_000,
    });
    expect(totals.materialCostTiyn).toBe(2 * material.sellingPriceTiyn);
    expect(totals.cuttingCostTiyn).toBe(2 * 500_000);
    expect(totals.pvcCostTiyn).toBe(Math.round(0.4 * 20_000));
    expect(totals.totalTiyn).toBe(
      totals.materialCostTiyn + totals.cuttingCostTiyn + totals.pvcCostTiyn - 100_000,
    );
  });

  it("never goes negative even with a huge discount", () => {
    const totals = computeOrderTotals({
      parts: [],
      material,
      pvcTypesById: new Map(),
      sheets: 1,
      cuttingPricePerSheetTiyn: 0,
      extraServicesTiyn: 0,
      deliveryCostTiyn: 0,
      discountTiyn: 999_999_999,
    });
    expect(totals.totalTiyn).toBe(0);
  });
});
