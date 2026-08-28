/**
 * Turning OCR text from a photo of a cut list into parts.
 *
 * The input is whatever Tesseract made of a phone photo of a handwritten or printed size list, so
 * it is noisy by definition: digits misread as letters, the multiplication sign read as anything
 * from "x" to "K", stray punctuation. Everything here is about recovering rows from that, and
 * about refusing rows it cannot recover rather than inventing a number.
 */

export interface ScannedPart {
  lengthMm: number;
  widthMm: number;
  qty: number;
}

/** Furniture parts outside this range are misreads, not parts — a 4-digit year, a price, a total. */
const MIN_MM = 10;
const MAX_MM = 3000;
/** A quantity larger than this on one line is far more likely a misread dimension. */
const MAX_QTY = 500;

/**
 * Letters Tesseract commonly returns in place of digits, in both alphabets. Applied only to tokens
 * that are already mostly digits, so a genuine word like "Дана" is never mangled into a number.
 */
const DIGIT_LOOKALIKES: Record<string, string> = {
  O: "0", o: "0", О: "0", о: "0", Q: "0", D: "0",
  I: "1", l: "1", i: "1", "|": "1", "!": "1",
  Z: "2", z: "2",
  З: "3", з: "3",
  A: "4",
  S: "5", s: "5", Ѕ: "5",
  b: "6", G: "6", б: "6",
  T: "7", т: "7",
  B: "8", В: "8",
  g: "9", q: "9",
};

/** Every character that can survive OCR as the "×" between two dimensions. */
const SEPARATORS = "xXхХ×*✕╳كKк";

function repairDigits(token: string): string {
  return [...token].map((ch) => DIGIT_LOOKALIKES[ch] ?? ch).join("");
}

/**
 * Repair is unconditional: this only ever runs on a token already sitting in a dimension slot next
 * to a "×", so it is contextually a number even when OCR returned "6OO". The guard against a real
 * word slipping through is what follows — the token must repair to 2–4 clean digits inside a
 * plausible millimetre range, which "ЛДСП" and "шт" never do.
 */
function toMm(token: string): number | null {
  const repaired = repairDigits(token);
  if (!/^\d{2,4}$/.test(repaired)) return null;
  const n = parseInt(repaired, 10);
  if (n >= MIN_MM && n <= MAX_MM) return n;

  /*
   * TrOCR repeats digits when it is unsure — a handwritten "600 x 450" comes back as
   * "6000x4500". The tell is a 4-digit number that is impossible as a part size but whose first
   * three digits are perfectly ordinary, so drop the last digit and re-check.
   *
   * Deliberately narrow: only exactly 4 digits (so a 5-digit misread stays rejected rather than
   * being whittled down to anything), and only when the full number is already out of range, so a
   * real 2750 is never touched. The recovered row still lands in the review table like every
   * other, where a wrong guess is visible and editable rather than silently applied.
   */
  if (repaired.length === 4) {
    const trimmed = parseInt(repaired.slice(0, 3), 10);
    if (trimmed >= MIN_MM && trimmed <= MAX_MM) return trimmed;
  }
  return null;
}

/**
 * The quantity on a cut-list row: "2шт", "х2", "- 3", or a bare small integer sitting on its own
 * after the dimensions. Absent means one part, which is what a bare "600x450" row means.
 */
function parseQty(rest: string): number {
  // "2 шт" / "2 дана" — an explicit unit is the least ambiguous signal, so try it first.
  const unit = rest.match(/(\d{1,3})\s*(?:шт|дана|pcs|ш\b)/i);
  if (unit) {
    const n = parseInt(unit[1], 10);
    if (n >= 1 && n <= MAX_QTY) return n;
  }

  // Otherwise the first short digit run anywhere in the tail. Deliberately not anchored to
  // whitespace: OCR mangles "шт" into things like "2wT" and "o6шWT", so a count is routinely
  // glued to letters on either side. This tail is only ever the text *after* the last dimension
  // pair on the line, so a digit here is a count far more often than it is anything else.
  const bare = rest.match(/\d{1,3}/);
  if (bare) {
    const n = parseInt(bare[0], 10);
    if (n >= 1 && n <= MAX_QTY) return n;
  }
  return 1;
}

/**
 * Every part the text describes, in the order they appear.
 *
 * Works line by line because a cut list is a list: one row per part. A line with no recoverable
 * "A × B" is skipped silently — a header, a customer name, or a smudge — rather than contributing
 * half a part from whatever digits it happened to contain.
 */
export function parseScannedParts(text: string): ScannedPart[] {
  const parts: ScannedPart[] = [];

  for (const rawLine of text.split(/[\n\r]+/)) {
    const line = rawLine.trim();
    if (!line) continue;

    // One line can legitimately carry more than one part ("600x450 700x300"), so scan, don't match.
    const pattern = new RegExp(`([0-9A-Za-zА-Яа-яЁё|!]{2,5})\\s*[${SEPARATORS}]\\s*([0-9A-Za-zА-Яа-яЁё|!]{2,5})`, "g");

    let m: RegExpExecArray | null;
    let lastIndex = 0;
    const found: { part: ScannedPart; end: number }[] = [];

    while ((m = pattern.exec(line)) !== null) {
      const lengthMm = toMm(m[1]);
      const widthMm = toMm(m[2]);
      if (lengthMm === null || widthMm === null) continue;
      found.push({ part: { lengthMm, widthMm, qty: 1 }, end: m.index + m[0].length });
      lastIndex = m.index + m[0].length;
    }

    if (found.length === 0) continue;

    // The quantity belongs to the last pair on the line — "600x450 700x300 2шт" is two parts with
    // the 2 attached to the second. A single-pair line (the overwhelming case) is unaffected.
    const tail = line.slice(lastIndex);
    found[found.length - 1].part.qty = parseQty(tail);

    parts.push(...found.map((f) => f.part));
  }

  return parts;
}

/**
 * The old single-pair behaviour, kept for callers that fill one length/width field pair. Returns
 * zeroes when nothing was recognised so the caller can tell "nothing found" from "found a 0".
 */
export function parseDimensions(text: string): { lengthMm: number; widthMm: number } {
  const [first] = parseScannedParts(text);
  if (first) return { lengthMm: first.lengthMm, widthMm: first.widthMm };

  // No "A × B" anywhere — fall back to the first two plausible standalone numbers, which covers a
  // photo where the separator itself was lost to noise.
  const nums = (text.match(/\d{2,4}/g) ?? []).map((n) => parseInt(n, 10)).filter((n) => n >= MIN_MM && n <= MAX_MM);
  return { lengthMm: nums[0] ?? 0, widthMm: nums[1] ?? 0 };
}
