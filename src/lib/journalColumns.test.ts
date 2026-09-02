import { describe, it, expect } from "vitest";
import {
  JOURNAL_COLUMNS,
  journalColumnCount,
  methodIdOf,
  methodLabelOf,
  methodTone,
  parseHiddenColumns,
  pvcSummary,
  sheetSummary,
  toggleHiddenColumn,
  type JournalColumnId,
} from "./journalColumns";
import type { PaymentMethodDef } from "../types/domain";

const line = (o: Partial<Parameters<typeof sheetSummary>[0][number]> = {}) => ({
  materialName: "Ақ",
  sheetQty: 0,
  pvcMeters: 0,
  ...o,
});

describe("sheetSummary", () => {
  it("names the single material rather than repeating the count", () => {
    expect(sheetSummary([line({ materialName: "Ақ", sheetQty: 13 })])).toEqual({
      headline: "13 лист",
      detail: "Ақ",
    });
  });

  it("breaks a merged order down per material so the cutter sees what is short", () => {
    expect(
      sheetSummary([
        line({ materialName: "Ақ", sheetQty: 8 }),
        line({ materialName: "ХДФ", sheetQty: 5 }),
      ]),
    ).toEqual({ headline: "13 лист", detail: "Ақ 8 · ХДФ 5" });
  });

  it("adds up two lines of the same material instead of listing it twice", () => {
    const summary = sheetSummary([
      line({ materialName: "Ақ", sheetQty: 6 }),
      line({ materialName: "Ақ", sheetQty: 4 }),
    ]);
    expect(summary).toEqual({ headline: "10 лист", detail: "Ақ" });
  });

  it("shows a dash for a ПВХ-only order rather than '0 лист'", () => {
    expect(sheetSummary([line({ pvcMeters: 40 })])).toEqual({ headline: "—", detail: "" });
  });

  it("keeps an unnamed material readable", () => {
    expect(sheetSummary([line({ materialName: "  ", sheetQty: 3 })]).detail).toBe("Материал");
  });
});

describe("pvcSummary", () => {
  const types = new Map([["p1", { colorName: "Ақ", thicknessMm: 1 }]]);

  it("prints the metres over the colour and thickness from the catalogue", () => {
    expect(pvcSummary([line({ pvcMeters: 176.4, pvcTypeId: "p1" })], types)).toEqual({
      headline: "176 м",
      detail: "Ақ · 1 мм",
    });
  });

  it("falls back to the colour stored on the line when the roll was retired", () => {
    expect(
      pvcSummary([line({ pvcMeters: 30, pvcTypeId: "gone", pvcColorName: "Каньон" })], types),
    ).toEqual({ headline: "30 м", detail: "Каньон" });
  });

  it("says so when metres were ordered with no colour picked", () => {
    expect(pvcSummary([line({ pvcMeters: 12 })], types).detail).toBe("түсі таңдалмаған");
  });

  it("lists each colour once, however many lines use it", () => {
    const summary = pvcSummary(
      [
        line({ pvcMeters: 20, pvcTypeId: "p1" }),
        line({ pvcMeters: 15, pvcTypeId: "p1" }),
        line({ pvcMeters: 5, pvcTypeId: "gone", pvcColorName: "Дуб" }),
      ],
      types,
    );
    expect(summary).toEqual({ headline: "40 м", detail: "Ақ · 1 мм · Дуб" });
  });

  it("shows a dash for an order with no ПВХ at all", () => {
    expect(pvcSummary([line({ sheetQty: 9 })], types)).toEqual({ headline: "—", detail: "" });
  });
});

describe("column visibility", () => {
  it("drops ids that are unknown or locked so a stale value cannot blank the money", () => {
    const hidden = parseHiddenColumns(JSON.stringify(["pvc", "total", "nonsense"]));
    expect([...hidden]).toEqual(["pvc"]);
  });

  it("survives a corrupted stored value", () => {
    expect(parseHiddenColumns("{not json")).toEqual(new Set());
    expect(parseHiddenColumns(null)).toEqual(new Set());
  });

  it("toggles a hideable column both ways without mutating the input", () => {
    const start: ReadonlySet<JournalColumnId> = new Set<JournalColumnId>();
    const off = toggleHiddenColumn(start, "method");
    expect(off.has("method")).toBe(true);
    expect(start.size).toBe(0);
    expect(toggleHiddenColumn(off, "method").has("method")).toBe(false);
  });

  it("refuses to hide a locked column", () => {
    expect(toggleHiddenColumn(new Set(), "total").has("total")).toBe(false);
  });

  it("counts the cells a full-width row has to span", () => {
    expect(journalColumnCount(new Set())).toBe(3 + JOURNAL_COLUMNS.length);
    expect(journalColumnCount(new Set<JournalColumnId>(["pvc", "date"]))).toBe(1 + JOURNAL_COLUMNS.length);
  });
});

describe("payment method pill", () => {
  const methods: PaymentMethodDef[] = [
    { id: "kaspi", name: "Kaspi", active: true, isMixed: false },
    { id: "nur", name: "Нұр", active: true, isMixed: false },
  ];

  it("reports a split payment as mixed rather than picking a side", () => {
    expect(methodIdOf(["cash", "kaspi"])).toBe("mixed");
    expect(methodLabelOf("mixed", methods)).toBe("Аралас");
  });

  it("names an unpaid row instead of leaving the cell blank", () => {
    expect(methodIdOf([])).toBeNull();
    expect(methodLabelOf(null, methods)).toBe("Таңдалмаған");
  });

  it("uses the method's own name, and the payment's stored name if it was deleted", () => {
    expect(methodLabelOf("nur", methods)).toBe("Нұр");
    expect(methodLabelOf("old", methods, "Ескі әдіс")).toBe("Ескі әдіс");
  });

  it("gives every known method its own tone and anything else a neutral one", () => {
    expect(methodTone("kaspi")).toBe("red");
    expect(methodTone("nur")).toBe("green");
    expect(methodTone("something-new")).toBe("slate");
    expect(methodTone(null)).toBe("none");
  });
});
