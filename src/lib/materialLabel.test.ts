import { describe, it, expect } from "vitest";
import { materialLabel } from "./materialLabel";
import { buildLineJobs, syncLineJobs } from "./orderLines";
import { draftFromOrder, emptyJournalLine, itemsFromDraft, type JournalDraft } from "./journalOrders";
import { isExternalSheet } from "./journalPricing";
import { sheetSummary } from "./journalColumns";
import type { Material, Order, OrderLineJob } from "../types/domain";

/** The owner, 09.11: «Сырттан келетін лист белгілеген кезінде аты жазылатын болсын». */

const own = { materialName: "Сырттан келетін лист", externalName: "Эггер Дуб Галифакс" };

describe("materialLabel", () => {
  it("names a customer's own sheet after the placeholder, in full or compact", () => {
    expect(materialLabel(own)).toBe("Сырттан келетін лист · Эггер Дуб Галифакс");
    expect(materialLabel(own, { compact: true })).toBe("Сырттан: Эггер Дуб Галифакс");
    expect(materialLabel({ materialName: "Сырттан келетін лист Эггер", externalName: "Дуб Галифакс" }, { compact: true }))
      .toBe("Сырттан Эггер: Дуб Галифакс");
  });

  it("reads exactly as before for a line with no such name", () => {
    expect(materialLabel({ materialName: "ЛДСП Ақ Томск" })).toBe("ЛДСП Ақ Томск");
    expect(materialLabel({ materialName: "ЛДСП Ақ Томск", externalName: "  " }, { compact: true })).toBe("ЛДСП Ақ Томск");
    expect(materialLabel({})).toBe("");
  });
});

describe("isExternalSheet — the lines the journal asks to name", () => {
  const mat = (name: string, category?: Material["category"]) => ({ name, ...(category ? { category } : {}) });
  it("is a customer's own sheet, not their ХДФ or countertop, and never the shop's own board", () => {
    expect(isExternalSheet(mat("Сырттан келетін лист"))).toBe(true);
    expect(isExternalSheet(mat("Сырттан келетін лист Эггер"))).toBe(true);
    expect(isExternalSheet(mat("Сырттан келетін ХДФ", "hdf"))).toBe(false);
    expect(isExternalSheet(mat("Сырттан келетін ХДФ"))).toBe(false);
    expect(isExternalSheet(mat("Сырттан келетін столешница 3м"))).toBe(false);
    expect(isExternalSheet(mat("ЛДСП Ақ Томск"))).toBe(false);
    expect(isExternalSheet(undefined)).toBe(false);
  });
});

describe("the name, from the journal to the cutter's job", () => {
  const catalog = new Map<string, Material>([
    ["ext", { id: "ext", name: "Сырттан келетін лист" } as Material],
    ["ak", { id: "ak", name: "ЛДСП Ақ Томск" } as Material],
  ]);
  const draft = (lines: Partial<ReturnType<typeof emptyJournalLine>>[]): JournalDraft => ({
    customerName: "Асет", customerPhone: "", hdfCostTiyn: 0, cuttingCostTiyn: 0, extraServicesTiyn: 0,
    deliveryCostTiyn: 0, discountTiyn: 0, discountPercent: 0, orderDate: new Date(),
    lines: lines.map((l) => ({ ...emptyJournalLine(), ...l })),
  });

  it("is saved, trimmed, on a customer's own sheet — and dropped from a line re-picked to the shop's board", () => {
    const [ext, ak, blank] = itemsFromDraft(draft([
      { materialId: "ext", sheetQty: 3, externalName: "  Эггер Дуб Галифакс " },
      { materialId: "ak", sheetQty: 2, externalName: "Эггер Дуб Галифакс" },
      { materialId: "ext", sheetQty: 1, externalName: "   " },
    ]), catalog);
    expect(ext.externalName).toBe("Эггер Дуб Галифакс");
    expect("externalName" in ak).toBe(false);
    expect("externalName" in blank).toBe(false);
  });

  it("reads back into the journal's draft", () => {
    const order = { items: [{ materialId: "ext", materialName: "Сырттан келетін лист", externalName: "Кроно Белый", sheetQty: 2, sheetPriceTiyn: 0, pvcMeters: 0, pvcPricePerMeterTiyn: 0 }] } as unknown as Order;
    expect(draftFromOrder(order).lines[0].externalName).toBe("Кроно Белый");
  });

  it("reaches the job at the queue, and follows a later edit — written, changed or cleared", () => {
    const order = { items: [{ materialId: "ext", materialName: "Сырттан келетін лист", externalName: "Кроно Белый", sheetQty: 2, sheetPriceTiyn: 0, pvcMeters: 0, pvcPricePerMeterTiyn: 0 }] } as unknown as Order;
    const [queued] = buildLineJobs(order);
    expect(queued.externalName).toBe("Кроно Белый");

    const work = { materialId: "ext", materialName: "Сырттан келетін лист", sheetQty: 2, pvcMeters: 0 };
    const [renamed] = syncLineJobs([queued], [{ ...work, externalName: "Эггер Дуб Галифакс" }]);
    expect(renamed.externalName).toBe("Эггер Дуб Галифакс");
    const [cleared] = syncLineJobs([renamed], [work]);
    // Gone, not undefined — Firestore refuses an undefined field.
    expect("externalName" in cleared).toBe(false);
    const job: OrderLineJob = { index: 0, materialId: "ak", materialName: "ЛДСП Ақ", sheetQty: 1, pvcMeters: 0 };
    expect("externalName" in buildLineJobs({ items: [job] } as unknown as Order)[0]).toBe(false);
  });

  it("shows in the journal's «Лист» cell beside the other boards", () => {
    expect(sheetSummary([
      { materialName: "Ақ", sheetQty: 8, pvcMeters: 0 },
      { ...own, sheetQty: 5, pvcMeters: 0 },
    ]).detail).toBe("Ақ 8 · Сырттан: Эггер Дуб Галифакс 5");
  });
});
