import { describe, it, expect } from "vitest";
import { segmentLines, inkProfile, toGrey } from "./lineSegmentation";

const W = 200;
const H = 120;

/** A blank white page with black bands painted at the given row ranges. */
function page(bands: Array<{ top: number; bottom: number; from?: number; to?: number }>): Uint8ClampedArray {
  const g = new Uint8ClampedArray(W * H).fill(255);
  for (const b of bands) {
    const from = b.from ?? 20;
    const to = b.to ?? 180;
    for (let y = b.top; y < b.bottom; y++) {
      for (let x = from; x < to; x++) g[y * W + x] = 0;
    }
  }
  return g;
}

describe("segmentLines", () => {
  it("finds nothing on a blank page", () => {
    expect(segmentLines(new Uint8ClampedArray(W * H).fill(255), W, H)).toEqual([]);
  });

  it("finds one band", () => {
    const lines = segmentLines(page([{ top: 40, bottom: 60 }]), W, H, { padding: 0 });
    expect(lines).toEqual([{ top: 40, bottom: 60 }]);
  });

  it("finds several bands in top-to-bottom order", () => {
    const lines = segmentLines(
      page([{ top: 10, bottom: 25 }, { top: 50, bottom: 70 }, { top: 90, bottom: 110 }]),
      W, H, { padding: 0 },
    );
    expect(lines).toEqual([
      { top: 10, bottom: 25 },
      { top: 50, bottom: 70 },
      { top: 90, bottom: 110 },
    ]);
  });

  it("merges bands split by a gap smaller than mergeGap", () => {
    // Two strokes 3 rows apart are one character, not two lines.
    const lines = segmentLines(page([{ top: 40, bottom: 50 }, { top: 53, bottom: 62 }]), W, H, {
      padding: 0,
      mergeGap: 6,
    });
    expect(lines).toEqual([{ top: 40, bottom: 62 }]);
  });

  it("keeps bands separated by more than mergeGap apart", () => {
    const lines = segmentLines(page([{ top: 40, bottom: 50 }, { top: 62, bottom: 72 }]), W, H, {
      padding: 0,
      mergeGap: 6,
    });
    expect(lines).toHaveLength(2);
  });

  it("ignores a band thinner than minHeight", () => {
    const lines = segmentLines(page([{ top: 40, bottom: 43 }]), W, H, { padding: 0, minHeight: 8 });
    expect(lines).toEqual([]);
  });

  it("ignores speckle that never reaches the ink ratio", () => {
    // A handful of dark pixels on an otherwise white row is dust, not text.
    const g = new Uint8ClampedArray(W * H).fill(255);
    for (let y = 40; y < 60; y++) g[y * W + 5] = 0; // a single-pixel-wide column
    expect(segmentLines(g, W, H)).toEqual([]);
  });

  it("pads around the band without leaving the image", () => {
    const lines = segmentLines(page([{ top: 0, bottom: 20 }]), W, H, { padding: 4 });
    expect(lines[0].top).toBe(0); // clamped, not negative
    expect(lines[0].bottom).toBe(24);
  });

  it("clamps padding at the bottom edge", () => {
    const lines = segmentLines(page([{ top: 100, bottom: H }]), W, H, { padding: 4 });
    expect(lines[0].bottom).toBe(H);
  });

  it("handles a zero-sized image", () => {
    expect(segmentLines(new Uint8ClampedArray(0), 0, 0)).toEqual([]);
  });

  it("separates a realistic 5-row cut list", () => {
    const rows = [12, 34, 56, 78, 100].map((top) => ({ top, bottom: top + 14 }));
    expect(segmentLines(page(rows), W, H, { padding: 2 })).toHaveLength(5);
  });
});

describe("inkProfile", () => {
  it("counts dark pixels per row", () => {
    const g = page([{ top: 5, bottom: 7, from: 0, to: 50 }]);
    const p = inkProfile(g, W, H);
    expect(p[5]).toBe(50);
    expect(p[6]).toBe(50);
    expect(p[7]).toBe(0);
  });
});

describe("toGrey", () => {
  it("converts RGBA to one luminance byte per pixel", () => {
    const rgba = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]);
    const g = toGrey(rgba, 2, 1);
    expect(g[0]).toBe(255);
    expect(g[1]).toBe(0);
  });
});
