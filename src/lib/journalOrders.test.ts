import { describe, it, expect } from "vitest";
import {
  draftHasContent,
  emptyJournalDraft,
  emptyJournalLine,
  pvcByTypeFromDraft,
  totalOverrideFor,
  type JournalDraft,
} from "./journalOrders";

describe("draftHasContent", () => {
  it("treats an untouched row as empty, so cancelling it asks nothing", () => {
    expect(draftHasContent(emptyJournalDraft())).toBe(false);
  });

  it("ignores the order date, which is filled in for you", () => {
    const draft = { ...emptyJournalDraft(), orderDate: new Date("2026-01-15T12:00:00+05:00") };
    expect(draftHasContent(draft)).toBe(false);
  });

  it("sees every order-level field a manager can type into", () => {
    const empty = emptyJournalDraft();
    const filled: Partial<JournalDraft>[] = [
      { customerName: "Асет" },
      { customerPhone: "+7 777 123 45 67" },
      { hdfCostTiyn: 750000 },
      { cuttingCostTiyn: 200000 },
      { extraServicesTiyn: 50000 },
      { deliveryCostTiyn: 300000 },
      { discountTiyn: 100000 },
    ];
    for (const patch of filled) {
      expect(draftHasContent({ ...empty, ...patch }), JSON.stringify(patch)).toBe(true);
    }
  });

  it("sees every material-line field too", () => {
    const empty = emptyJournalDraft();
    const lineEdits = [
      { materialId: "ldsp-ak" },
      { sheetQty: 4 },
      { sheetPriceTiyn: 1650000 },
      { pvcMeters: 12.5 },
      { pvcPricePerMeterTiyn: 22000 },
    ];
    for (const patch of lineEdits) {
      const draft = { ...empty, lines: [{ ...empty.lines[0], ...patch }] };
      expect(draftHasContent(draft), JSON.stringify(patch)).toBe(true);
    }
  });

  it("a blank line is every field at zero, so the new row's cells start empty", () => {
    const line = emptyJournalLine();
    expect(line.sheetQty).toBe(0);
    expect(line.sheetPriceTiyn).toBe(0);
    expect(line.pvcMeters).toBe(0);
    expect(line.pvcPricePerMeterTiyn).toBe(0);
    expect(draftHasContent(emptyJournalDraft())).toBe(false);
  });

  it("treats a second material line as content on its own", () => {
    const empty = emptyJournalDraft();
    expect(draftHasContent({ ...empty, lines: [...empty.lines, emptyJournalLine()] })).toBe(true);
  });

  it("does not count whitespace as typing", () => {
    expect(draftHasContent({ ...emptyJournalDraft(), customerName: "   " })).toBe(false);
  });
});

describe("pvcByTypeFromDraft — which roll the metres came off", () => {
  const line = (over: Partial<ReturnType<typeof emptyJournalLine>>) => ({ ...emptyJournalLine(), ...over });
  const pvcTypes = new Map([
    ["ak-04", { id: "ak-04", colorName: "Ақ", thicknessMm: 0.4, pricePerMeterTiyn: 20000, active: true }],
    ["dub-2", { id: "dub-2", colorName: "Дуб", thicknessMm: 2, pricePerMeterTiyn: 22000, active: true }],
  ]);

  it("costs each colour at the rate the line is actually billed at", () => {
    const draft = {
      ...emptyJournalDraft(),
      lines: [line({ pvcTypeId: "ak-04", pvcMeters: 92, pvcPricePerMeterTiyn: 20000 })],
    };
    expect(pvcByTypeFromDraft(draft, pvcTypes)).toEqual([
      { pvcTypeId: "ak-04", colorName: "Ақ", thicknessMm: 0.4, meters: 92, costTiyn: 1840000 },
    ]);
  });

  it("adds up two lines that used the same roll", () => {
    const draft = {
      ...emptyJournalDraft(),
      lines: [
        line({ pvcTypeId: "ak-04", pvcMeters: 92, pvcPricePerMeterTiyn: 20000 }),
        line({ pvcTypeId: "ak-04", pvcMeters: 8, pvcPricePerMeterTiyn: 20000 }),
      ],
    };
    const rows = pvcByTypeFromDraft(draft, pvcTypes);
    expect(rows).toHaveLength(1);
    expect(rows[0].meters).toBe(100);
    expect(rows[0].costTiyn).toBe(2000000);
  });

  it("keeps a merged order's two colours apart", () => {
    const draft = {
      ...emptyJournalDraft(),
      lines: [
        line({ pvcTypeId: "ak-04", pvcMeters: 92, pvcPricePerMeterTiyn: 20000 }),
        line({ pvcTypeId: "dub-2", pvcMeters: 27, pvcPricePerMeterTiyn: 22000 }),
      ],
    };
    expect(pvcByTypeFromDraft(draft, pvcTypes).map((r) => r.colorName)).toEqual(["Ақ", "Дуб"]);
  });

  it("attributes nothing when no colour was picked, rather than guessing a roll", () => {
    // Those metres surface as "Түрі көрсетілмеген" on the ПВХ report — an honest gap beats a
    // wrong colour drawn down in the warehouse.
    const draft = { ...emptyJournalDraft(), lines: [line({ pvcMeters: 92, pvcPricePerMeterTiyn: 20000 })] };
    expect(pvcByTypeFromDraft(draft, pvcTypes)).toEqual([]);
  });

  it("ignores a colour picked on a line with no metres on it", () => {
    const draft = { ...emptyJournalDraft(), lines: [line({ pvcTypeId: "ak-04", pvcMeters: 0 })] };
    expect(pvcByTypeFromDraft(draft, pvcTypes)).toEqual([]);
  });

  it("still names a colour that has since left the catalogue", () => {
    const draft = {
      ...emptyJournalDraft(),
      lines: [line({ pvcTypeId: "gone", pvcColorName: "Ескі өң", pvcMeters: 10, pvcPricePerMeterTiyn: 20000 })],
    };
    expect(pvcByTypeFromDraft(draft, pvcTypes)[0]).toMatchObject({ pvcTypeId: "gone", colorName: "Ескі өң" });
  });
});

describe("totalOverrideFor — typing a total by hand", () => {
  const draft = (over: Partial<JournalDraft> = {}): JournalDraft => ({
    ...emptyJournalDraft(),
    lines: [{ ...emptyJournalLine(), sheetQty: 6, sheetPriceTiyn: 1600000, pvcMeters: 92, pvcPricePerMeterTiyn: 20000 }],
    ...over,
  });
  // 6 × 16 000 + 92 × 200 = 114 400 ₸
  const BASE = 11440000;

  it("records a lower figure as a discount", () => {
    expect(totalOverrideFor(draft(), 11000000)).toEqual({ extraServicesTiyn: 0, discountTiyn: 440000 });
  });

  it("records a higher figure as a surcharge", () => {
    expect(totalOverrideFor(draft(), 12000000)).toEqual({ extraServicesTiyn: 560000, discountTiyn: 0 });
  });

  it("clears both when the typed figure is exactly what the lines come to", () => {
    expect(totalOverrideFor(draft(), BASE)).toEqual({ extraServicesTiyn: 0, discountTiyn: 0 });
  });

  it("counts the order's other charges as part of the base, not as the override", () => {
    const withCharges = draft({ hdfCostTiyn: 750000, cuttingCostTiyn: 200000, deliveryCostTiyn: 300000 });
    // base is now 114 400 + 7 500 + 2 000 + 3 000 = 126 900 ₸ — typing that clears the override.
    expect(totalOverrideFor(withCharges, 12690000)).toEqual({ extraServicesTiyn: 0, discountTiyn: 0 });
  });

  it("re-typing the original figure undoes an earlier override", () => {
    const discounted = draft({ discountTiyn: 440000 });
    expect(totalOverrideFor(discounted, BASE)).toEqual({ extraServicesTiyn: 0, discountTiyn: 0 });
  });

  it("treats a negative typed figure as zero rather than inventing a surcharge", () => {
    expect(totalOverrideFor(draft(), -5000)).toEqual({ extraServicesTiyn: 0, discountTiyn: BASE });
  });
});
