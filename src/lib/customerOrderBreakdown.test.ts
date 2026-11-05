import { describe, it, expect } from "vitest";
import type { Order } from "../types/domain";
import { customerOrderBreakdown } from "./customerOrderBreakdown";

const T = (n: number) => n * 100;
// formatMoney separates thousands with a no-break space; compare on plain spaces.
const plain = (s: string | undefined) => (s ?? "").replace(/[  ]/g, " ");

function order(overrides: Partial<Order> = {}): Order {
  return {
    id: "o1",
    orderNumber: "ORD-2026-000503",
    customerName: "Мейрам",
    customerPhone: "77011234567",
    materialId: "ldsp-ak",
    materialSnapshot: { name: "ЛДСП Ақ Томск", article: "", color: "Ақ", thicknessMm: 16, sheetLengthMm: 2750, sheetWidthMm: 1830, sellingPriceTiyn: T(16200) },
    productionStatus: "pvc_queue",
    paymentStatus: "paid",
    priority: 0,
    estimatedSheets: 0,
    pvcMetersTotal: 129,
    materialCostTiyn: 0, cuttingCostTiyn: 0, pvcCostTiyn: 0, hdfCostTiyn: 0,
    extraServicesTiyn: 0, deliveryCostTiyn: 0, discountTiyn: 0,
    totalTiyn: 0, paidTiyn: 0, debtTiyn: 0,
    pricePublished: true,
    isDraft: false,
    ...overrides,
  } as Order;
}

describe("customerOrderBreakdown — what the customer's order is made of", () => {
  it("lists every material line of a journal order, not just the first", () => {
    const { lines } = customerOrderBreakdown(order({
      items: [
        { materialId: "ldsp-ak", materialName: "ЛДСП Ақ Томск", sheetQty: 8, sheetPriceTiyn: T(16200), pvcMeters: 129, pvcPricePerMeterTiyn: T(200), pvcColorName: "Ақ" },
        { materialId: "hdf-white", materialName: "ХДФ", sheetQty: 7, sheetPriceTiyn: T(7500), pvcMeters: 0, pvcPricePerMeterTiyn: 0 },
      ],
    }));
    expect(lines.map((l) => [l.title, plain(l.detail), l.amountTiyn])).toEqual([
      ["ЛДСП Ақ Томск", "8 лист × 16 200 ₸", T(129600)],
      ["ПВХ · Ақ", "129 м × 200 ₸", T(25800)],
      ["ХДФ", "7 лист × 7 500 ₸", T(52500)],
    ]);
  });

  it("says how much of each line without its price, for an order not priced yet", () => {
    const { lines } = customerOrderBreakdown(order({
      items: [
        { materialId: "ldsp-ak", materialName: "ЛДСП Ақ Томск", sheetQty: 8, sheetPriceTiyn: T(16200), pvcMeters: 129, pvcPricePerMeterTiyn: T(200), pvcJointed: true },
      ],
    }));
    expect(lines.map((l) => l.quantity)).toEqual(["8 лист", "129 м · прифуговка"]);
    const mdf = customerOrderBreakdown(order({ orderKind: "mdf_wrap", mdfAreaM2: 13.34, mdfPricePerM2Tiyn: T(16500) }));
    expect(plain(mdf.lines[0].quantity)).toBe("13.34 м²");
  });

  it("prices прифуговка into the edge line and says so", () => {
    const { lines } = customerOrderBreakdown(order({
      items: [{ materialId: "ldsp-ak", materialName: "ЛДСП Ақ Томск", sheetQty: 1, sheetPriceTiyn: T(16200), pvcMeters: 10, pvcPricePerMeterTiyn: T(200), pvcJointed: true }],
    }));
    expect(plain(lines[1].detail)).toBe("10 м × 220 ₸ · прифуговка");
    expect(lines[1].amountTiyn).toBe(T(2200));
  });

  it("shows the charges outside the lines, ХДФ included, and a discount as a minus", () => {
    const { extras } = customerOrderBreakdown(order({
      cuttingCostTiyn: T(2000), hdfCostTiyn: T(7500), deliveryCostTiyn: T(5000), discountTiyn: T(3000), discountPercent: 6,
    }));
    expect(extras.map((e) => [e.title, e.amountTiyn])).toEqual([
      ["Кесу", T(2000)], ["ХДФ", T(7500)], ["Жеткізу", T(5000)], ["Жеңілдік 6%", -T(3000)],
    ]);
  });

  it("leaves out a charge that is zero", () => {
    expect(customerOrderBreakdown(order()).extras).toEqual([]);
  });

  it("describes a МДФ order by its pattern, finish, area and rate", () => {
    const { lines } = customerOrderBreakdown(order({
      orderKind: "mdf_wrap", mdfAreaM2: 13.34, mdfPricePerM2Tiyn: T(16500), mdfPatternName: "Модерн", mdfFinish: "film", mdfFilmColor: "Капучино",
    }));
    expect(lines.map((l) => [l.title, plain(l.detail), l.amountTiyn])).toEqual([
      ["Модерн · Пленка · Капучино", "13.34 м² × 16 500 ₸", T(220110)],
    ]);
  });
});
