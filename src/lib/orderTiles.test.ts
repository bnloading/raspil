import { describe, it, expect } from "vitest";
import { orderTiles } from "./orderTiles";
import type { Order, OrderMaterialLine } from "../types/domain";

const line = (materialName: string, sheetQty: number): OrderMaterialLine => ({
  materialId: materialName, materialName, sheetQty,
  sheetPriceTiyn: 0, pvcMeters: 0, pvcPricePerMeterTiyn: 0,
});

function order(items: OrderMaterialLine[], pvcMetersTotal = 0): Order {
  return {
    id: "o1", orderNumber: "ORD-2026-000005",
    customerName: "Нұрик", customerPhone: "77011234567",
    materialId: "m1",
    materialSnapshot: {
      name: "ЛДСП Ақ", article: "A-1", color: "Ақ",
      thicknessMm: 16, sheetLengthMm: 2750, sheetWidthMm: 1830, sellingPriceTiyn: 0,
    },
    items,
    productionStatus: "cutting_started", paymentStatus: "paid", priority: 0,
    estimatedSheets: 0, pvcMetersTotal,
    materialCostTiyn: 0, cuttingCostTiyn: 0, pvcCostTiyn: 0, hdfCostTiyn: 0,
    extraServicesTiyn: 0, deliveryCostTiyn: 0, discountTiyn: 0,
    totalTiyn: 0, paidTiyn: 0, debtTiyn: 0,
    pricePublished: true, isDraft: false,
  };
}

describe("orderTiles", () => {
  it("counts ХДФ apart from the boards the furniture is made of", () => {
    expect(orderTiles(order([line("ЛДСП Ақ", 13), line("ХДФ 3мм", 5)], 176)))
      .toEqual({ sheets: 13, pvcMeters: 176, hdfSheets: 5 });
  });

  it("adds up several board types into the one лист figure", () => {
    expect(orderTiles(order([line("ЛДСП Ақ", 6), line("ЛДСП Честер", 4)])).sheets).toBe(10);
  });

  it("recognises ХДФ however it is written", () => {
    expect(orderTiles(order([line("хдф 3мм", 2)])).hdfSheets).toBe(2);
    expect(orderTiles(order([line("HDF white", 3)])).hdfSheets).toBe(3);
  });

  it("does not read ХДФ out of a board that merely mentions something similar", () => {
    expect(orderTiles(order([line("ЛДСП Ақ", 4)])).hdfSheets).toBe(0);
  });

  it("rounds the metres — a card has no room for 175.83 м", () => {
    expect(orderTiles(order([line("ЛДСП Ақ", 1)], 175.83)).pvcMeters).toBe(176);
  });

  it("is all zeroes for an order with nothing on it", () => {
    expect(orderTiles(order([]))).toEqual({ sheets: 0, pvcMeters: 0, hdfSheets: 0 });
  });

  it("ignores lines with no sheets rather than counting them as boards", () => {
    expect(orderTiles(order([line("ЛДСП Ақ", 0), line("ХДФ", 0)], 40)))
      .toEqual({ sheets: 0, pvcMeters: 40, hdfSheets: 0 });
  });
});
