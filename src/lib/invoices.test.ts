import { describe, it, expect } from "vitest";
import { buildInvoiceLines } from "./invoices";
import type { Order, OrderMaterialLine } from "../types/domain";

const T = (n: number) => n * 100; // ₸ → tiyn

function order(overrides: Partial<Order> = {}): Order {
  return {
    id: "o1",
    orderNumber: "ORD-2026-000200",
    customerName: "Айбек",
    customerPhone: "77001112233",
    materialId: "m1",
    materialSnapshot: { name: "ЛДСП Ақ Томск", article: "", color: "Ақ", thicknessMm: 16, sheetLengthMm: 2750, sheetWidthMm: 1830, sellingPriceTiyn: T(16200) },
    productionStatus: "ready",
    paymentStatus: "paid",
    priority: 0,
    estimatedSheets: 0,
    pvcMetersTotal: 0,
    materialCostTiyn: 0,
    cuttingCostTiyn: 0,
    pvcCostTiyn: 0,
    hdfCostTiyn: 0,
    extraServicesTiyn: 0,
    deliveryCostTiyn: 0,
    discountTiyn: 0,
    totalTiyn: 0,
    paidTiyn: 0,
    debtTiyn: 0,
    pricePublished: true,
    isDraft: false,
    ...overrides,
  } as Order;
}

const line = (l: Partial<OrderMaterialLine>): OrderMaterialLine => ({
  materialId: "m1", materialName: "ЛДСП Ақ Томск", sheetQty: 0, sheetPriceTiyn: 0, pvcMeters: 0, pvcPricePerMeterTiyn: 0, ...l,
});

const sum = (lines: { totalTiyn: number }[]) => lines.reduce((s, l) => s + l.totalTiyn, 0);

describe("buildInvoiceLines — the journal row, line by line", () => {
  // The owner's own shape: "Ақ осындай, ПВХ осынша, Кашемир осынша", then the total.
  const twoBoards = order({
    items: [
      line({ materialName: "ЛДСП Ақ Томск", sheetQty: 12, sheetPriceTiyn: T(16200), pvcMeters: 120, pvcPricePerMeterTiyn: T(200), pvcTypeId: "p-ak", pvcColorName: "Ақ" }),
      line({ materialId: "m2", materialName: "ЛДСП Кашемир", sheetQty: 9, sheetPriceTiyn: T(17000), pvcMeters: 64, pvcPricePerMeterTiyn: T(220), pvcTypeId: "p-kash" }),
    ],
    pvcByType: [{ pvcTypeId: "p-kash", colorName: "Кашемир", thicknessMm: 1, meters: 64, costTiyn: T(64 * 220) }],
    cuttingCostTiyn: T(2000),
    discountTiyn: T(5000),
    totalTiyn: T(12 * 16200 + 120 * 200 + 9 * 17000 + 64 * 220 + 2000 - 5000),
  });

  it("lists each sheet with its own quantity and price, followed by its own ПВХ in its own colour", () => {
    expect(buildInvoiceLines(twoBoards)).toEqual([
      { name: "ЛДСП Ақ Томск", qty: 12, unit: "лист", unitPriceTiyn: T(16200), totalTiyn: T(194400) },
      { name: "ПВХ Ақ", qty: 120, unit: "м", unitPriceTiyn: T(200), totalTiyn: T(24000) },
      { name: "ЛДСП Кашемир", qty: 9, unit: "лист", unitPriceTiyn: T(17000), totalTiyn: T(153000) },
      // No colour name on the line itself: read from the order's per-colour breakdown.
      { name: "ПВХ Кашемир", qty: 64, unit: "м", unitPriceTiyn: T(220), totalTiyn: T(14080) },
      // Every line here is a priced shop sheet, so распил is one service, not a per-sheet rate.
      { name: "Распил қызметі", qty: 1, unit: "қызмет", unitPriceTiyn: T(2000), totalTiyn: T(2000) },
    ]);
  });

  it("adds up to the order's own total once the discount comes off", () => {
    expect(sum(buildInvoiceLines(twoBoards)) - twoBoards.discountTiyn).toBe(twoBoards.totalTiyn);
  });

  it("charges прифуговка in the ПВХ rate and says so, and counts a столешница in pieces", () => {
    const lines = buildInvoiceLines(order({
      items: [
        line({ sheetQty: 2, sheetPriceTiyn: T(16200), pvcMeters: 50, pvcPricePerMeterTiyn: T(200), pvcColorName: "Ақ", pvcJointed: true }),
        line({ materialName: "Столешница Дуб Вотан", sheetQty: 1, sheetPriceTiyn: T(45000) }),
      ],
    }));
    expect(lines[1]).toEqual({ name: "ПВХ Ақ · прифуговка", qty: 50, unit: "м", unitPriceTiyn: T(220), totalTiyn: T(11000) });
    expect(lines[2]).toMatchObject({ name: "Столешница Дуб Вотан", qty: 1, unit: "дана" });
  });

  it("leaves out a customer's own board billed only through распил, rather than printing it at 0 ₸", () => {
    const lines = buildInvoiceLines(order({
      items: [line({ materialName: "Сырттан келетін лист", sheetQty: 14, sheetPriceTiyn: 0, pvcMeters: 30, pvcPricePerMeterTiyn: T(160) })],
      cuttingCostTiyn: T(14 * 1600),
    }));
    expect(lines.map((l) => l.name)).toEqual(["ПВХ жиек", "Распил қызметі"]);
  });
});

describe("buildInvoiceLines — an order built from parts (no journal lines)", () => {
  it("splits the ПВХ by colour when the colours account for all of it", () => {
    const lines = buildInvoiceLines(order({
      estimatedSheets: 5, materialCostTiyn: T(81000), pvcMetersTotal: 89, pvcCostTiyn: T(89 * 200),
      pvcByType: [{ pvcTypeId: "p", colorName: "Ақ", thicknessMm: 0.4, meters: 89, costTiyn: T(89 * 200) }],
    }));
    expect(lines).toEqual([
      { name: "ЛДСП Ақ Томск", qty: 5, unit: "лист", unitPriceTiyn: T(16200), totalTiyn: T(81000) },
      { name: "ПВХ Ақ", qty: 89, unit: "м", unitPriceTiyn: T(200), totalTiyn: T(17800) },
    ]);
  });

  it("keeps one ПВХ line when the colours do not account for all of it", () => {
    const lines = buildInvoiceLines(order({
      pvcMetersTotal: 100, pvcCostTiyn: T(20000), pvcPricePerMeterTiyn: T(200),
      pvcByType: [{ pvcTypeId: "p", colorName: "Ақ", thicknessMm: 0.4, meters: 60, costTiyn: T(12000) }],
    }));
    expect(lines).toEqual([{ name: "ПВХ жиек", qty: 100, unit: "м", unitPriceTiyn: T(200), totalTiyn: T(20000) }]);
  });
});

describe("buildInvoiceLines — распил", () => {
  it("is per sheet of the customer's own board, the only lines it is charged on", () => {
    const lines = buildInvoiceLines(order({
      items: [
        line({ sheetQty: 7, sheetPriceTiyn: T(16200) }),
        line({ materialName: "Сырттан келетін лист", sheetQty: 14, sheetPriceTiyn: 0 }),
      ],
      estimatedSheets: 21,
      cuttingCostTiyn: T(14 * 1600),
    }));
    expect(lines.at(-1)).toEqual({ name: "Распил қызметі", qty: 14, unit: "лист", unitPriceTiyn: T(1600), totalTiyn: T(22400) });
  });
});

describe("buildInvoiceLines — МДФ", () => {
  it("is one line by the square metre, and adds up to the order total", () => {
    // ORD-2026-000195: 28,4 м² of Капучино Матовый at 16 500 ₸/м² = 468 600 ₸.
    const o = order({ orderKind: "mdf_wrap", mdfAreaM2: 28.4, mdfPricePerM2Tiyn: T(16500), mdfFilmColor: "Капучино Матовый", totalTiyn: T(468600) });
    const lines = buildInvoiceLines(o);
    expect(lines).toEqual([{ name: "МДФ · Капучино Матовый", qty: 28.4, unit: "м²", unitPriceTiyn: T(16500), totalTiyn: T(468600) }]);
    expect(sum(lines)).toBe(o.totalTiyn);
  });
});
