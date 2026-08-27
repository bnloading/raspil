import * as XLSX from "xlsx";
import { EDGE_KEYS } from "../types/domain";
import type {
  CsvColumnKey,
  CsvDimensionOrder,
  CsvExportSettings,
  CsvUnit,
  CuttingPart,
  Material,
  Order,
  PvcType,
} from "../types/domain";

/** Exports rows of plain objects to a downloaded CSV file (native, no dependency). */
export function exportCsv(filename: string, rows: Record<string, string | number>[]): void {
  if (rows.length === 0) return;
  const headers = Object.keys(rows[0]);
  const lines = [
    headers.join(","),
    ...rows.map((row) =>
      headers
        .map((h) => {
          const value = String(row[h] ?? "");
          return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
        })
        .join(","),
    ),
  ];
  const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  triggerDownload(blob, filename.endsWith(".csv") ? filename : `${filename}.csv`);
}

/** Exports rows of plain objects to a downloaded XLSX file via SheetJS. */
export function exportXlsx(filename: string, rows: Record<string, string | number>[], sheetName = "Sheet1"): void {
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  XLSX.writeFile(wb, filename.endsWith(".xlsx") ? filename : `${filename}.xlsx`);
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ─────────────────────────────────────────────────────────────────────────
// Cutting-program CSV export (admin-configurable columns/delimiter/encoding)
// ─────────────────────────────────────────────────────────────────────────

/** Kazakh display names for every configurable CSV column, in the spec's default order. Reused by
 *  AdminCsvSettings for the column-picker UI and preview table headers. */
export const CSV_COLUMN_LABELS: Record<CsvColumnKey, string> = {
  orderNumber: "Заказ №",
  customerName: "Клиент",
  partNumber: "Бөлшек №",
  partName: "Атауы",
  material: "Материал",
  materialThickness: "Қалыңдығы (мм)",
  lengthMm: "Ұзындығы (мм)",
  widthMm: "Ені (мм)",
  quantity: "Саны",
  grainDirection: "Талшық бағыты",
  rotationAllowed: "Айналдыруға рұқсат",
  pvcEdgeA: "ПВХ жиек (Жоғарғы)",
  pvcEdgeB: "ПВХ жиек (Оң)",
  pvcEdgeC: "ПВХ жиек (Төменгі)",
  pvcEdgeD: "ПВХ жиек (Сол)",
  pvcThickness: "ПВХ қалыңдығы (мм)",
  pvcColour: "ПВХ түсі",
  note: "Ескертпе",
};

/** All 18 columns in the spec's default order — used as the fallback when no settings doc exists yet. */
export const DEFAULT_CSV_COLUMNS: CsvColumnKey[] = [
  "orderNumber",
  "customerName",
  "partNumber",
  "partName",
  "material",
  "materialThickness",
  "lengthMm",
  "widthMm",
  "quantity",
  "grainDirection",
  "rotationAllowed",
  "pvcEdgeA",
  "pvcEdgeB",
  "pvcEdgeC",
  "pvcEdgeD",
  "pvcThickness",
  "pvcColour",
  "note",
];

export const DEFAULT_CSV_EXPORT_SETTINGS: CsvExportSettings = {
  columns: DEFAULT_CSV_COLUMNS,
  delimiter: ",",
  encoding: "utf8-bom",
  includeHeaders: true,
  unit: "mm",
  dimensionOrder: "length_first",
  pvcMapping: "per_edge",
};

export const CSV_UNIT_LABELS: Record<CsvUnit, string> = { mm: "мм", cm: "см", m: "м" };
const UNIT_DIVISOR: Record<CsvUnit, number> = { mm: 1, cm: 10, m: 1000 };

/**
 * Converts a millimetre measurement into the template's unit. Millimetres stay integers; cm/m are
 * rounded to 3 decimals and stripped of trailing zeros, so a converted value never carries float
 * noise like "72.00000000000001" into the cutting program.
 */
export function convertMm(valueMm: number, unit: CsvUnit = "mm"): number {
  const divisor = UNIT_DIVISOR[unit];
  if (divisor === 1) return valueMm;
  return Math.round((valueMm / divisor) * 1000) / 1000;
}

/** The header text for a column: the template's override if set, otherwise the standard label. */
export function csvColumnLabel(col: CsvColumnKey, settings: Pick<CsvExportSettings, "columnLabels">): string {
  const custom = settings.columnLabels?.[col]?.trim();
  return custom || CSV_COLUMN_LABELS[col];
}

/**
 * Resolves the effective column list. With `pvcMapping: "combined"`, the four per-edge columns
 * collapse into a single one at the position the first of them occupied, so the rest of the column
 * order the user arranged is preserved.
 */
export function effectiveColumns(settings: CsvExportSettings): CsvColumnKey[] {
  if (settings.pvcMapping !== "combined") return settings.columns;
  const edgeCols: CsvColumnKey[] = ["pvcEdgeA", "pvcEdgeB", "pvcEdgeC", "pvcEdgeD"];
  const out: CsvColumnKey[] = [];
  let inserted = false;
  for (const col of settings.columns) {
    if (edgeCols.includes(col)) {
      if (!inserted) {
        out.push("pvcEdgeA"); // stands in for the combined edge column
        inserted = true;
      }
      continue;
    }
    out.push(col);
  }
  return out;
}

/**
 * Applies the template's length/width order by swapping the two COLUMN KEYS wherever they appear.
 * The values themselves are never swapped — a part's length stays its length; only which heading
 * it is printed under changes, which is what "do not swap length/width" requires.
 */
function orderedColumns(cols: CsvColumnKey[], order: CsvDimensionOrder | undefined): CsvColumnKey[] {
  if (order !== "width_first") return cols;
  return cols.map((c) => (c === "lengthMm" ? "widthMm" : c === "widthMm" ? "lengthMm" : c));
}

const CSV_GRAIN_LABELS: Record<string, string> = { vertical: "Тік", horizontal: "Көлденең", any: "Маңызды емес" };

function yesNo(value: boolean): string {
  return value ? "Иә" : "Жоқ";
}

/**
 * Formula-injection mitigation (required by spec): if a cell's stringified value starts with
 * `=`, `+`, `-`, `@`, or a tab/CR character, prefix it with a single leading apostrophe — the
 * standard mitigation Excel/Google Sheets both honor as "force text," neutralizing any embedded
 * formula/DDE payload. Applied uniformly to every column regardless of source, since the
 * realistic attack vector is free-text fields like partName/note, not a fixed "risky" column list.
 */
function sanitizeCsvCell(raw: string | number): string {
  const value = String(raw);
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

/** Resolves, for one part, the first PVC-enabled edge (checked in A, B, C, D order) that also has
 *  a resolvable pvcTypeId — returns that PvcType, or undefined if the part has no PVC edges. */
function firstPvcTypeForPart(part: CuttingPart, pvcTypes: PvcType[]): PvcType | undefined {
  for (const edgeKey of EDGE_KEYS) {
    const edge = part.edges[edgeKey];
    if (edge?.pvc && edge.pvcTypeId) {
      const pvcType = pvcTypes.find((p) => p.id === edge.pvcTypeId);
      if (pvcType) return pvcType;
    }
  }
  return undefined;
}

/**
 * Builds the cutting-program export as a plain string grid: a header row (if
 * settings.includeHeaders) followed by one row per part, column-ordered per settings.columns.
 * Every cell already has formula-injection sanitization applied, so callers can hand the result
 * straight to exportCuttingCsv / copyCuttingRowsToClipboard / a preview <table> without further
 * processing.
 */
export function buildCuttingCsvRows(
  order: Order,
  parts: CuttingPart[],
  materials: Material[],
  pvcTypes: PvcType[],
  settings: CsvExportSettings,
): string[][] {
  const rows: string[][] = [];
  const combinedPvc = settings.pvcMapping === "combined";
  const cols = orderedColumns(effectiveColumns(settings), settings.dimensionOrder);
  const unit = settings.unit ?? "mm";

  if (settings.includeHeaders) {
    rows.push(
      cols.map((col) =>
        sanitizeCsvCell(
          combinedPvc && col === "pvcEdgeA"
            ? settings.columnLabels?.pvcEdgeA?.trim() || "ПВХ жиектері"
            : csvColumnLabel(col, settings),
        ),
      ),
    );
  }

  parts.forEach((part, index) => {
    const material = materials.find((m) => m.id === (part.materialId || order.materialId));
    const pvcType = firstPvcTypeForPart(part, pvcTypes);

    const cellFor = (col: CsvColumnKey): string | number => {
      // In combined mode the single edge column lists the enabled edges, e.g. "A,B,D".
      if (combinedPvc && col === "pvcEdgeA") {
        return EDGE_KEYS.filter((e) => part.edges[e]?.pvc).join(",");
      }
      switch (col) {
        case "orderNumber":
          return order.orderNumber;
        case "customerName":
          return order.customerName;
        case "partNumber":
          return index + 1;
        case "partName":
          return part.name;
        case "material":
          return material?.name ?? "";
        case "materialThickness":
          return material ? convertMm(material.thicknessMm, unit) : "";
        case "lengthMm":
          return convertMm(part.lengthMm, unit);
        case "widthMm":
          return convertMm(part.widthMm, unit);
        case "quantity":
          return Math.trunc(part.qty);
        case "grainDirection":
          return CSV_GRAIN_LABELS[part.grainDirection] ?? part.grainDirection;
        case "rotationAllowed":
          return yesNo(part.rotationAllowed);
        case "pvcEdgeA":
          return yesNo(!!part.edges.A?.pvc);
        case "pvcEdgeB":
          return yesNo(!!part.edges.B?.pvc);
        case "pvcEdgeC":
          return yesNo(!!part.edges.C?.pvc);
        case "pvcEdgeD":
          return yesNo(!!part.edges.D?.pvc);
        case "pvcThickness":
          // PVC thickness stays in millimetres regardless of the part-dimension unit — edging is
          // universally specified in mm (0.4/1/2), and converting it would be actively misleading.
          return pvcType?.thicknessMm ?? "";
        case "pvcColour":
          return pvcType?.colorName ?? "";
        case "note":
          return part.note ?? "";
      }
    };

    rows.push(cols.map((col) => sanitizeCsvCell(cellFor(col))));
  });

  return rows;
}

function escapeCsvCell(value: string, delimiter: string): string {
  return /["\r\n]/.test(value) || value.includes(delimiter)
    ? `"${value.replace(/"/g, '""')}"`
    : value;
}

/**
 * Triggers a browser download of already-built CSV rows (see buildCuttingCsvRows), honoring the
 * admin-configured delimiter and encoding.
 *
 * Encoding notes:
 * - "utf8-bom" (default): UTF-8 with a leading BOM, same technique as the generic exportCsv above.
 * - "utf8": UTF-8, no BOM.
 * - "windows-1251": best-effort. Reliably re-encoding arbitrary Unicode (Cyrillic customer names,
 *   free-text notes, ...) into a single-byte codepage requires a fully-verified 256-entry lookup
 *   table; browsers have no native API for it. Getting even one entry wrong would silently
 *   corrupt affected characters — worse than not supporting the option at all — so rather than
 *   hand-roll an unverified table, this falls back to the same UTF-8-with-BOM output as
 *   "utf8-bom". Modern Excel on Windows opens UTF-8-BOM CSVs correctly, so this is a reasonable
 *   "nice to have not fully delivered" compromise, not a functional blocker.
 */
export function exportCuttingCsv(
  filename: string,
  rows: string[][],
  settings: Pick<CsvExportSettings, "delimiter" | "encoding">,
): void {
  const content = rows
    .map((row) => row.map((cell) => escapeCsvCell(cell, settings.delimiter)).join(settings.delimiter))
    .join("\r\n");
  const useBom = settings.encoding !== "utf8";
  const blob = new Blob([useBom ? "﻿" + content : content], { type: "text/csv;charset=utf-8;" });
  triggerDownload(blob, filename.endsWith(".csv") ? filename : `${filename}.csv`);
}

/**
 * Copies rows to the clipboard as tab-separated text — always tabs, regardless of
 * settings.delimiter, since pasting into Excel/Google Sheets expects literal tabs to land values
 * in separate cells.
 */
export function copyCuttingRowsToClipboard(rows: string[][]): Promise<void> {
  const text = rows.map((row) => row.join("\t")).join("\r\n");
  return navigator.clipboard.writeText(text);
}

/** `${orderNumber}-${customerNameSlug}.csv` — strips anything outside [A-Za-zА-Яа-яЁё0-9-] so the
 *  filename is filesystem-safe; deliberately does NOT transliterate Cyrillic to Latin. */
export function buildCuttingCsvFilename(order: Order): string {
  const slug = order.customerName
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-zА-Яа-яЁё0-9-]/g, "");
  return `${order.orderNumber}-${slug}.csv`;
}
