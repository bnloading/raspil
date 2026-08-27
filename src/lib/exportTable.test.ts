import { describe, it, expect } from "vitest";
import {
  buildCuttingCsvRows,
  convertMm,
  csvColumnLabel,
  effectiveColumns,
  CSV_COLUMN_LABELS,
  DEFAULT_CSV_EXPORT_SETTINGS,
} from "./exportTable";
import type { CsvExportSettings, CuttingPart, Material, Order, PvcType } from "../types/domain";

const material: Material = {
  id: "m1",
  name: "ЛДСП Ақ",
  article: "A-1",
  color: "Ақ",
  manufacturer: "Egger",
  thicknessMm: 16,
  sheetLengthMm: 2800,
  sheetWidthMm: 2070,
  sellingPriceTiyn: 1620000,
  initialQty: 10,
  qtyOnHand: 10,
  reservedQty: 0,
  minStock: 1,
  active: true,
  archived: false,
  grainDirectionRequired: false,
};

const pvcType: PvcType = { id: "pvc1", thicknessMm: 2, colorName: "Ақ", pricePerMeterTiyn: 20000, active: true };

const order = {
  id: "o1",
  orderNumber: "ORD-2026-000123",
  customerName: "Алмат",
  materialId: "m1",
} as unknown as Order;

function part(overrides: Partial<CuttingPart> = {}): CuttingPart {
  return {
    id: "p1",
    name: "Есік панелі",
    lengthMm: 720,
    widthMm: 450,
    qty: 2,
    grainDirection: "vertical",
    rotationAllowed: false,
    note: "",
    edges: {
      A: { pvc: true, pvcTypeId: "pvc1" },
      B: { pvc: false },
      C: { pvc: false },
      D: { pvc: true, pvcTypeId: "pvc1" },
    },
    ...overrides,
  };
}

const build = (settings: Partial<CsvExportSettings>, parts: CuttingPart[] = [part()]) =>
  buildCuttingCsvRows(order, parts, [material], [pvcType], { ...DEFAULT_CSV_EXPORT_SETTINGS, ...settings });

/** Column index by header text, from the header row. */
const colIndex = (rows: string[][], header: string) => rows[0].indexOf(header);

describe("convertMm", () => {
  it("leaves millimetres untouched", () => {
    expect(convertMm(720, "mm")).toBe(720);
  });
  it("converts to cm and m", () => {
    expect(convertMm(720, "cm")).toBe(72);
    expect(convertMm(720, "m")).toBe(0.72);
  });
  it("rounds away float noise rather than emitting 72.00000000000001", () => {
    expect(convertMm(2070, "m")).toBe(2.07);
    expect(String(convertMm(2070, "cm"))).toBe("207");
  });
  it("defaults to millimetres", () => {
    expect(convertMm(500)).toBe(500);
  });
});

describe("custom column names", () => {
  it("uses the override when present and the standard label otherwise", () => {
    const settings = { columnLabels: { lengthMm: "Length" } };
    expect(csvColumnLabel("lengthMm", settings)).toBe("Length");
    expect(csvColumnLabel("widthMm", settings)).toBe(CSV_COLUMN_LABELS.widthMm);
  });
  it("ignores a blank override", () => {
    expect(csvColumnLabel("lengthMm", { columnLabels: { lengthMm: "   " } })).toBe(CSV_COLUMN_LABELS.lengthMm);
  });
  it("writes custom headers into the exported rows", () => {
    const rows = build({
      columns: ["partName", "lengthMm", "widthMm"],
      columnLabels: { lengthMm: "L", widthMm: "W" },
    });
    expect(rows[0]).toEqual([CSV_COLUMN_LABELS.partName, "L", "W"]);
  });
});

describe("included / excluded columns and order", () => {
  it("emits exactly the configured columns in the configured order", () => {
    const rows = build({ columns: ["quantity", "partName", "orderNumber"] });
    expect(rows[0]).toEqual([CSV_COLUMN_LABELS.quantity, CSV_COLUMN_LABELS.partName, CSV_COLUMN_LABELS.orderNumber]);
    expect(rows[1]).toEqual(["2", "Есік панелі", "ORD-2026-000123"]);
  });

  it("omits the header row when headers are disabled", () => {
    const rows = build({ columns: ["partName"], includeHeaders: false });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(["Есік панелі"]);
  });
});

describe("dimension units", () => {
  it("converts part dimensions into the template's unit", () => {
    const rows = build({ columns: ["lengthMm", "widthMm"], unit: "cm" });
    expect(rows[1]).toEqual(["72", "45"]);
  });

  it("keeps PVC thickness in millimetres even when parts are exported in metres", () => {
    const rows = build({ columns: ["lengthMm", "pvcThickness"], unit: "m" });
    expect(rows[1]).toEqual(["0.72", "2"]);
  });
});

describe("length/width order", () => {
  it("swaps the column headings, never the values", () => {
    const rows = build({ columns: ["partName", "lengthMm", "widthMm"], dimensionOrder: "width_first" });
    // Headings now read Width, Length …
    expect(rows[0]).toEqual([CSV_COLUMN_LABELS.partName, CSV_COLUMN_LABELS.widthMm, CSV_COLUMN_LABELS.lengthMm]);
    // …and each value still sits under its own correct heading.
    expect(rows[1][colIndex(rows, CSV_COLUMN_LABELS.widthMm)]).toBe("450");
    expect(rows[1][colIndex(rows, CSV_COLUMN_LABELS.lengthMm)]).toBe("720");
  });

  it("length_first is the default and leaves the order alone", () => {
    const rows = build({ columns: ["lengthMm", "widthMm"] });
    expect(rows[1]).toEqual(["720", "450"]);
  });
});

describe("PVC column mapping", () => {
  it("per_edge writes four separate yes/no columns", () => {
    const rows = build({ columns: ["pvcEdgeA", "pvcEdgeB", "pvcEdgeC", "pvcEdgeD"] });
    expect(rows[1]).toEqual(["Иә", "Жоқ", "Жоқ", "Иә"]);
  });

  it("combined collapses them into one column listing the enabled edges", () => {
    const rows = build({
      columns: ["partName", "pvcEdgeA", "pvcEdgeB", "pvcEdgeC", "pvcEdgeD", "note"],
      pvcMapping: "combined",
    });
    expect(rows[0]).toEqual([CSV_COLUMN_LABELS.partName, "ПВХ жиектері", CSV_COLUMN_LABELS.note]);
    expect(rows[1]).toEqual(["Есік панелі", "A,D", ""]);
  });

  it("combined keeps the surrounding column order intact", () => {
    expect(
      effectiveColumns({
        ...DEFAULT_CSV_EXPORT_SETTINGS,
        columns: ["orderNumber", "pvcEdgeA", "pvcEdgeB", "pvcEdgeC", "pvcEdgeD", "quantity"],
        pvcMapping: "combined",
      }),
    ).toEqual(["orderNumber", "pvcEdgeA", "quantity"]);
  });

  it("a part with no PVC yields an empty combined cell", () => {
    const bare = part({
      edges: { A: { pvc: false }, B: { pvc: false }, C: { pvc: false }, D: { pvc: false } },
    });
    const rows = build({ columns: ["pvcEdgeA", "pvcEdgeB", "pvcEdgeC", "pvcEdgeD"], pvcMapping: "combined" }, [bare]);
    expect(rows[1]).toEqual([""]);
  });
});

describe("formula-injection protection survives every template option", () => {
  const nasty = part({ name: "=cmd|'/c calc'!A1", note: "+1+1" });

  it("neutralises dangerous leading characters in per_edge mode", () => {
    const rows = build({ columns: ["partName", "note"] }, [nasty]);
    expect(rows[1][0]).toBe("'=cmd|'/c calc'!A1");
    expect(rows[1][1]).toBe("'+1+1");
  });

  it("still neutralises them in combined mode with custom labels and cm units", () => {
    const rows = build(
      {
        columns: ["partName", "pvcEdgeA", "pvcEdgeB", "pvcEdgeC", "pvcEdgeD", "note"],
        pvcMapping: "combined",
        unit: "cm",
        columnLabels: { partName: "-Name" },
      },
      [nasty],
    );
    // A malicious custom HEADER is sanitised too, not just the data cells.
    expect(rows[0][0]).toBe("'-Name");
    expect(rows[1][0]).toBe("'=cmd|'/c calc'!A1");
    expect(rows[1][2]).toBe("'+1+1");
  });
});

describe("100–200 row exports", () => {
  it("produces one row per part plus a header, for 200 parts", () => {
    const parts = Array.from({ length: 200 }, (_, i) =>
      part({ id: `p${i}`, name: `Бөлшек ${i + 1}`, lengthMm: 400 + i, widthMm: 300 }),
    );
    const rows = build({ columns: ["partNumber", "partName", "lengthMm", "widthMm"] }, parts);
    expect(rows).toHaveLength(201);
    expect(rows[1][0]).toBe("1");
    expect(rows[200][0]).toBe("200");
    expect(rows[200][2]).toBe(String(400 + 199));
    // Every row has the same width as the header — no ragged output.
    expect(new Set(rows.map((r) => r.length)).size).toBe(1);
  });
});
