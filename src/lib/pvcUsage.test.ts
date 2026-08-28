import { describe, it, expect } from "vitest";
import { Timestamp } from "firebase/firestore";
import { computePvcUsage } from "./pvcUsage";
import type { Order, PvcType, PvcUsage } from "../types/domain";

const T = (n: number) => n * 100;
const at = (iso: string) => Timestamp.fromDate(new Date(`${iso}T12:00:00+05:00`));

const TYPES: PvcType[] = [
  { id: "pvc-1-white", colorName: "Ақ", thicknessMm: 1, pricePerMeterTiyn: T(200), active: true },
  { id: "pvc-1-gray", colorName: "Серый", thicknessMm: 1, pricePerMeterTiyn: T(220), active: true },
];

const use = (pvcTypeId: string, colorName: string, meters: number, perMeter: number): PvcUsage => ({
  pvcTypeId,
  colorName,
  thicknessMm: 1,
  meters,
  costTiyn: Math.round(meters * T(perMeter)),
});

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
    productionStatus: "ready",
    paymentStatus: "unpaid",
    priority: 0,
    estimatedSheets: 1,
    pvcMetersTotal: 0,
    materialCostTiyn: 0, cuttingCostTiyn: 0, pvcCostTiyn: 0, hdfCostTiyn: 0,
    extraServicesTiyn: 0, deliveryCostTiyn: 0, discountTiyn: 0,
    totalTiyn: 0, paidTiyn: 0, debtTiyn: 0,
    createdAt: at("2026-08-10"),
    pricePublished: true,
    isDraft: false,
    ...overrides,
  };
}

const run = (orders: Order[], period: string | null = "2026-08") =>
  computePvcUsage({ orders, pvcTypes: TYPES, period });

describe("computePvcUsage — metres per colour", () => {
  it("totals each colour across orders", () => {
    const s = run([
      order({ id: "a", pvcMetersTotal: 30, pvcByType: [use("pvc-1-white", "Ақ", 30, 200)] }),
      order({ id: "b", pvcMetersTotal: 50, pvcByType: [use("pvc-1-white", "Ақ", 20, 200), use("pvc-1-gray", "Серый", 30, 220)] }),
    ]);
    expect(s.rows).toHaveLength(2);
    const white = s.rows.find((r) => r.pvcTypeId === "pvc-1-white")!;
    expect(white.meters).toBe(50);
    expect(white.costTiyn).toBe(T(10000)); // 50 × 200
    expect(white.orderCount).toBe(2);
    const gray = s.rows.find((r) => r.pvcTypeId === "pvc-1-gray")!;
    expect(gray.meters).toBe(30);
    expect(gray.costTiyn).toBe(T(6600)); // 30 × 220
  });

  it("sorts by metres used, most first", () => {
    const s = run([
      order({ id: "a", pvcMetersTotal: 5, pvcByType: [use("pvc-1-white", "Ақ", 5, 200)] }),
      order({ id: "b", pvcMetersTotal: 40, pvcByType: [use("pvc-1-gray", "Серый", 40, 220)] }),
    ]);
    expect(s.rows.map((r) => r.colorName)).toEqual(["Серый", "Ақ"]);
  });

  it("carries the currently configured price for reconciliation", () => {
    const s = run([order({ pvcMetersTotal: 10, pvcByType: [use("pvc-1-gray", "Серый", 10, 220)] })]);
    expect(s.rows[0].pricePerMeterTiyn).toBe(T(220));
  });

  it("reports metres with no colour separately instead of guessing or dropping them", () => {
    const s = run([
      order({ id: "a", pvcMetersTotal: 30, pvcByType: [use("pvc-1-white", "Ақ", 30, 200)] }),
      order({ id: "b", pvcMetersTotal: 12 }), // walk-in typed into the journal — no breakdown
    ]);
    expect(s.unattributedMeters).toBe(12);
    expect(s.unattributedOrderCount).toBe(1);
    expect(s.rows).toHaveLength(1);
    // The grand total still matches what the shop billed.
    expect(s.totalMeters).toBe(42);
  });

  it("ignores orders with no PVC at all", () => {
    const s = run([order({ pvcMetersTotal: 0 })]);
    expect(s.unattributedMeters).toBe(0);
    expect(s.unattributedOrderCount).toBe(0);
    expect(s.totalMeters).toBe(0);
  });

  it("excludes drafts and cancellations", () => {
    const s = run([
      order({ id: "a", pvcMetersTotal: 30, pvcByType: [use("pvc-1-white", "Ақ", 30, 200)] }),
      order({ id: "b", productionStatus: "draft", pvcMetersTotal: 99, pvcByType: [use("pvc-1-white", "Ақ", 99, 200)] }),
      order({ id: "c", productionStatus: "cancelled", pvcMetersTotal: 77 }),
    ]);
    expect(s.totalMeters).toBe(30);
    expect(s.unattributedMeters).toBe(0);
  });

  it("filters to the selected month", () => {
    const s = run([
      order({ id: "a", createdAt: at("2026-08-03"), pvcMetersTotal: 30, pvcByType: [use("pvc-1-white", "Ақ", 30, 200)] }),
      order({ id: "b", createdAt: at("2026-07-30"), pvcMetersTotal: 99, pvcByType: [use("pvc-1-white", "Ақ", 99, 200)] }),
    ]);
    expect(s.rows[0].meters).toBe(30);
  });

  it("period null totals every month", () => {
    const s = run(
      [
        order({ id: "a", createdAt: at("2026-08-03"), pvcMetersTotal: 30, pvcByType: [use("pvc-1-white", "Ақ", 30, 200)] }),
        order({ id: "b", createdAt: at("2025-02-01"), pvcMetersTotal: 20, pvcByType: [use("pvc-1-white", "Ақ", 20, 200)] }),
      ],
      null,
    );
    expect(s.rows[0].meters).toBe(50);
  });

  it("totals cost across colours", () => {
    const s = run([
      order({ id: "a", pvcMetersTotal: 10, pvcByType: [use("pvc-1-white", "Ақ", 10, 200)] }),
      order({ id: "b", pvcMetersTotal: 10, pvcByType: [use("pvc-1-gray", "Серый", 10, 220)] }),
    ]);
    expect(s.totalCostTiyn).toBe(T(2000) + T(2200));
  });
});
