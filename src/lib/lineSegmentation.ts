/**
 * Splitting a photographed list into single text lines.
 *
 * TrOCR recognises one line of text per image and does no layout analysis at all — hand it a whole
 * page and it returns a guess at the first line. So before recognition, the page has to be cut
 * into lines, which is what this does: a horizontal projection profile (count the dark pixels in
 * each row, then take the runs where that count stays above a floor).
 *
 * Deliberately pure and pixel-array based so it can be tested without a browser.
 */

export interface TextLine {
  /** Inclusive top row. */
  top: number;
  /** Exclusive bottom row. */
  bottom: number;
}

export interface SegmentOptions {
  /** A pixel this dark or darker counts as ink. 0 = black, 255 = white. */
  inkThreshold?: number;
  /**
   * A row needs this share of its width in ink to count as part of a line. Keeps paper speckle and
   * JPEG noise from registering as text, and is a fraction rather than a pixel count so it holds
   * at any image width.
   */
  minInkRatio?: number;
  /** Lines closer than this many rows are merged — the gap inside a two-storey digit, not between rows. */
  mergeGap?: number;
  /** Bands shorter than this are noise, not text. */
  minHeight?: number;
  /** Rows of padding added around each line, so ascenders/descenders are not shaved off. */
  padding?: number;
}

const DEFAULTS: Required<SegmentOptions> = {
  inkThreshold: 128,
  minInkRatio: 0.012,
  mergeGap: 6,
  minHeight: 8,
  padding: 4,
};

/**
 * Row-by-row ink counts. Exposed because it is the whole basis of the segmentation, and a caller
 * debugging a bad split wants to see the profile rather than guess at it.
 *
 * `grey` is one byte per pixel, row-major.
 */
export function inkProfile(grey: Uint8Array | Uint8ClampedArray, width: number, height: number, inkThreshold = DEFAULTS.inkThreshold): number[] {
  const profile = new Array<number>(height).fill(0);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let n = 0;
    for (let x = 0; x < width; x++) {
      if (grey[row + x] <= inkThreshold) n++;
    }
    profile[y] = n;
  }
  return profile;
}

/**
 * The text lines in a greyscale page, top to bottom.
 *
 * Returns an empty array for a blank page rather than one line covering everything — a caller
 * should be able to tell "nothing found" from "one line found".
 */
export function segmentLines(
  grey: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  options: SegmentOptions = {},
): TextLine[] {
  const o = { ...DEFAULTS, ...options };
  if (width <= 0 || height <= 0) return [];

  const profile = inkProfile(grey, width, height, o.inkThreshold);
  const minInk = Math.max(1, Math.floor(width * o.minInkRatio));

  // 1. Raw runs of "this row has ink".
  const runs: TextLine[] = [];
  let start = -1;
  for (let y = 0; y < height; y++) {
    const inked = profile[y] >= minInk;
    if (inked && start === -1) start = y;
    else if (!inked && start !== -1) {
      runs.push({ top: start, bottom: y });
      start = -1;
    }
  }
  if (start !== -1) runs.push({ top: start, bottom: height });

  // 2. Merge runs separated by only a small gap. The gap between the bar of a "5" and its stem is
  //    a few rows; the gap between two written lines is much larger.
  const merged: TextLine[] = [];
  for (const run of runs) {
    const last = merged[merged.length - 1];
    if (last && run.top - last.bottom <= o.mergeGap) last.bottom = run.bottom;
    else merged.push({ ...run });
  }

  // 3. Drop specks, then pad — clamped so a line at the very edge stays inside the image.
  return merged
    .filter((l) => l.bottom - l.top >= o.minHeight)
    .map((l) => ({
      top: Math.max(0, l.top - o.padding),
      bottom: Math.min(height, l.bottom + o.padding),
    }));
}

/**
 * Greyscale bytes from RGBA canvas data, which is the form every browser path produces.
 */
export function toGrey(rgba: Uint8ClampedArray, width: number, height: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height);
  for (let i = 0, p = 0; i < rgba.length; i += 4, p++) {
    out[p] = (rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114) | 0;
  }
  return out;
}
