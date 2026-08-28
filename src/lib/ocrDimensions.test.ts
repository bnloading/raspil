import { describe, it, expect } from "vitest";
import { parseScannedParts, parseDimensions } from "./ocrDimensions";

describe("parseScannedParts — reading a photographed cut list", () => {
  it("reads one part per line", () => {
    expect(parseScannedParts("600x450\n700x300")).toEqual([
      { lengthMm: 600, widthMm: 450, qty: 1 },
      { lengthMm: 700, widthMm: 300, qty: 1 },
    ]);
  });

  it("accepts every separator OCR turns the × into", () => {
    const seps = ["x", "X", "х", "Х", "×", "*", "K", "к"];
    for (const sep of seps) {
      expect(parseScannedParts(`600${sep}450`)).toEqual([{ lengthMm: 600, widthMm: 450, qty: 1 }]);
    }
  });

  it("tolerates spaces around the separator", () => {
    expect(parseScannedParts("600 x 450")).toEqual([{ lengthMm: 600, widthMm: 450, qty: 1 }]);
  });

  it("repairs digits misread as letters", () => {
    // 6OO×45O — the zeros came back as capital O.
    expect(parseScannedParts("6OO x 45O")).toEqual([{ lengthMm: 600, widthMm: 450, qty: 1 }]);
    // 1O0×2З0 — mixed Latin O and Cyrillic З.
    expect(parseScannedParts("1O0 x 2З0")).toEqual([{ lengthMm: 100, widthMm: 230, qty: 1 }]);
  });

  it("reads an explicit quantity", () => {
    expect(parseScannedParts("600x450 2шт")).toEqual([{ lengthMm: 600, widthMm: 450, qty: 2 }]);
    expect(parseScannedParts("800x600 - 4 дана")).toEqual([{ lengthMm: 800, widthMm: 600, qty: 4 }]);
  });

  it("reads a bare trailing count", () => {
    expect(parseScannedParts("600x450 - 3")).toEqual([{ lengthMm: 600, widthMm: 450, qty: 3 }]);
  });

  it("defaults to one when no quantity is written", () => {
    expect(parseScannedParts("600x450")[0].qty).toBe(1);
  });

  it("takes two parts off one line and attaches the count to the last", () => {
    expect(parseScannedParts("600x450 700x300 2шт")).toEqual([
      { lengthMm: 600, widthMm: 450, qty: 1 },
      { lengthMm: 700, widthMm: 300, qty: 2 },
    ]);
  });

  it("skips lines with no recoverable pair instead of inventing one", () => {
    const text = ["ТАПСЫРЫС №12", "Клиент: Алмат", "600x450", "барлығы 5"].join("\n");
    expect(parseScannedParts(text)).toEqual([{ lengthMm: 600, widthMm: 450, qty: 1 }]);
  });

  it("rejects dimensions outside a plausible part size", () => {
    expect(parseScannedParts("5x450")).toEqual([]); // 5 mm is a misread
    expect(parseScannedParts("60000x450")).toEqual([]); // too many digits to be mm
    expect(parseScannedParts("2026x450")).toEqual([{ lengthMm: 2026, widthMm: 450, qty: 1 }]);
  });

  it("does not mangle words into numbers", () => {
    // "ЛДСП x Ақ" is not a pair of dimensions.
    expect(parseScannedParts("ЛДСП x Ақ")).toEqual([]);
  });

  it("reads the actual Tesseract output for a photographed list", () => {
    // Captured verbatim from tesseract.js running over the preprocessed image in
    // DimensionScanner — including the way it mangles "шт" into "2wT" and "o6wWT", which is why
    // parseQty does not require whitespace around the count.
    const real = "LEX - pasmepnep\n1) 600 x 450 2wT\n2) 720 x 380\n\n3) 1200 x 600 4 wr\n4) 840 x 396 o6wWT\n5) 300 x 300\n";
    expect(parseScannedParts(real)).toEqual([
      { lengthMm: 600, widthMm: 450, qty: 2 },
      { lengthMm: 720, widthMm: 380, qty: 1 },
      { lengthMm: 1200, widthMm: 600, qty: 4 },
      { lengthMm: 840, widthMm: 396, qty: 6 },
      { lengthMm: 300, widthMm: 300, qty: 1 },
    ]);
  });

  it("reads a realistic noisy list end to end", () => {
    const ocr = [
      "ЦЕХ - размерлер",
      "1) 6OO x 450  2шт",
      "2) 720 х 380",
      "3) 1200*600 - 4 дана",
      "   ",
      "барлыгы: 7",
    ].join("\n");
    expect(parseScannedParts(ocr)).toEqual([
      { lengthMm: 600, widthMm: 450, qty: 2 },
      { lengthMm: 720, widthMm: 380, qty: 1 },
      { lengthMm: 1200, widthMm: 600, qty: 4 },
    ]);
  });
});

describe("parseDimensions — single-pair callers", () => {
  it("returns the first recognised pair", () => {
    expect(parseDimensions("600x450\n700x300")).toEqual({ lengthMm: 600, widthMm: 450 });
  });

  it("falls back to the first two plausible numbers when the separator was lost", () => {
    expect(parseDimensions("600 450")).toEqual({ lengthMm: 600, widthMm: 450 });
  });

  it("returns zeroes when there is nothing to read", () => {
    expect(parseDimensions("тапсырыс журналы")).toEqual({ lengthMm: 0, widthMm: 0 });
  });
});
