import type { Material, PvcType } from "../types/domain";

/**
 * The shop's standing price rules, applied automatically when a material is picked in the journal
 * so the manager does not retype the same three numbers on every row.
 *
 * These are defaults, not locks: every field stays editable, because a one-off job is negotiated
 * at the counter and the ledger has to be able to record what was actually agreed.
 */

/** ПВХ, ₸ per metre. */
export const PVC_PRICE_WHITE_TIYN = 200_00;
export const PVC_PRICE_OTHER_TIYN = 220_00;
/** A customer's own sheet: we sell the labour, not the board. */
export const EXTERNAL_CUT_PER_SHEET_TIYN = 1600_00;
export const EXTERNAL_PVC_PER_METER_TIYN = 160_00;

/**
 * The letters of a string, as whole words.
 *
 * Whole words, never substrings: "Бежевый" must not read as white and "Ақсай" must not read as
 * "Ақ". This cannot use  — JavaScript word boundaries are defined over ASCII word characters
 * only, so /ақ/ never matches Cyrillic at all.
 */
function words(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/**
 * True for ХДФ — the thin backing board.
 *
 * ХДФ is the panel that goes behind a cabinet; nobody edge-bands it, so offering ПВХ on that line
 * is offering a service that does not exist, and any metres typed there would be billed for work
 * the shop never does.
 *
 * `category` is authoritative when set. It is a later addition that reads as "ldsp" when absent,
 * so a sheet added before categories existed is identified by its name instead.
 */
export function isHdfMaterial(material: Pick<Material, "name" | "category"> | undefined): boolean {
  if (!material) return false;
  if (material.category) return material.category === "hdf";
  const named = words(material.name ?? "");
  return named.includes("хдф") || named.includes("hdf");
}

/**
 * One finish, two spellings.
 *
 * The catalogue writes the white board as "Ақ" and the countertop range as "Белый" — isWhiteMaterial
 * below already has to know this to price the metre, and the roll has to be found by the same rule
 * or a Белый board silently comes up with no edge at all.
 */
const COLOUR_SYNONYMS: Record<string, string> = { "белый": "ақ", "white": "ақ" };

/** A colour, as words, with the spellings above folded together. */
function colourWords(text: string): string[] {
  return words(text).map((word) => COLOUR_SYNONYMS[word] ?? word);
}

/**
 * Which thickness to reach for when a colour is stocked in several.
 *
 * 1 мм is the shop's standard edge; the others are picked deliberately, so they are not guessed
 * at. Like every other default here it is only a starting point — the ПВХ түсі cell stays open.
 */
const PREFERRED_PVC_THICKNESS_MM = 1;

function preferredOf(types: readonly PvcType[]): PvcType | undefined {
  return [...types].sort((a, b) => {
    const aStandard = a.thicknessMm === PREFERRED_PVC_THICKNESS_MM ? 0 : 1;
    const bStandard = b.thicknessMm === PREFERRED_PVC_THICKNESS_MM ? 0 : 1;
    return aStandard - bStandard || a.thicknessMm - b.thicknessMm;
  })[0];
}

/**
 * The edge-banding roll that matches a board: Ақ board, Ақ edge; Честер board, Честер edge.
 *
 * Edging is chosen to match the board almost every time — a contrasting edge is the exception
 * someone asks for — so retyping the colour on every row was work the ledger could do itself.
 *
 * The board's own `color` is tried first, then its name, because the catalogue is not consistent
 * about which field carries the finish ("ЛДСП Честер 16мм" with the colour field left empty is
 * a real row). Matching is on whole words throughout, so "Ақ" never matches "Ақсай"; when a roll's
 * name is several words, every one of them has to appear, and the most specific match wins so
 * "Ақ Глянец" beats plain "Ақ" on a board that says both.
 */
export function matchPvcTypeFor(
  material: Pick<Material, "name" | "color"> | undefined,
  pvcTypes: readonly PvcType[],
): PvcType | undefined {
  if (!material) return undefined;

  const colour = colourWords(material.color ?? "").join(" ");
  if (colour) {
    const exact = pvcTypes.filter((p) => colourWords(p.colorName).join(" ") === colour);
    if (exact.length > 0) return preferredOf(exact);
  }

  const haystack = colourWords(`${material.name ?? ""} ${material.color ?? ""}`);
  if (haystack.length === 0) return undefined;

  const byName = pvcTypes
    .map((type) => ({ type, parts: colourWords(type.colorName) }))
    .filter(({ parts }) => parts.length > 0 && parts.every((part) => haystack.includes(part)));
  if (byName.length === 0) return undefined;

  const mostSpecific = Math.max(...byName.map(({ parts }) => parts.length));
  return preferredOf(byName.filter(({ parts }) => parts.length === mostSpecific).map(({ type }) => type));
}

/** The ПВХ half of a journal line, as picking a material should leave it. */
export interface PvcLineDefaults {
  /** False for a board that takes no edging at all — the ПВХ cells are hidden for these. */
  edgeBanded: boolean;
  pvcTypeId: string;
  pvcColorName: string;
  pvcPricePerMeterTiyn: number;
  /** Metres to force onto the line; undefined leaves whatever is typed there alone. */
  pvcMeters?: number;
}

/**
 * What picking a material does to the line's ПВХ fields.
 *
 * Three cases, and the difference between them matters at the counter:
 *
 *   ХДФ                 no edging exists, so the colour, the rate and any metres already typed
 *                       are cleared — leaving them would bill for work the shop cannot do
 *   a matching roll     colour filled in automatically, at the shop's standing rate for the board
 *   no matching roll    the rate is still filled in, and whatever colour was already chosen is
 *                       kept rather than wiped by a match that was never found
 */
export function pvcDefaultsFor(
  material: Pick<Material, "name" | "color" | "category"> | undefined,
  pvcTypes: readonly PvcType[],
  current: { pvcTypeId: string; pvcColorName: string },
): PvcLineDefaults {
  if (isHdfMaterial(material)) {
    return { edgeBanded: false, pvcTypeId: "", pvcColorName: "", pvcPricePerMeterTiyn: 0, pvcMeters: 0 };
  }

  const match = matchPvcTypeFor(material, pvcTypes);
  return {
    edgeBanded: true,
    pvcTypeId: match?.id ?? current.pvcTypeId,
    pvcColorName: match?.colorName ?? current.pvcColorName,
    pvcPricePerMeterTiyn: journalDefaultsFor(material).pvcPricePerMeterTiyn,
  };
}

/**
 * True when the sheet belongs to the customer rather than the shop.
 *
 * Detected by name because that is how the row is entered — the catalogue holds one placeholder
 * material ("Сырттан келетін лист") for exactly this case.
 */
export function isExternalMaterial(material: Pick<Material, "name"> | undefined): boolean {
  const n = (material?.name ?? "").toLowerCase();
  return n.includes("сырттан") || n.includes("сырттан келетін");
}

/**
 * True for the white finish, which is priced below the rest of the range.
 *
 * Compares whole words rather than substrings, so "Бежевый" is not read as white and "Ақсай" is
 * not read as "Ақ". Note this cannot use \b: JavaScript word boundaries are defined over ASCII
 * word characters only, so /\bақ\b/ never matches Cyrillic at all.
 */
export function isWhiteMaterial(material: Pick<Material, "name" | "color"> | undefined): boolean {
  const words = `${material?.name ?? ""} ${material?.color ?? ""}`
    .toLowerCase()
    .split(/[^\p{L}]+/u)
    .filter(Boolean);
  // Both spellings: the catalogue says "Ақ", the countertop range says "Белый".
  return words.includes("ақ") || words.includes("белый");
}

export interface JournalDefaults {
  pvcPricePerMeterTiyn: number;
  /** Per-sheet cutting charge — only non-zero for a customer's own board. */
  cuttingPerSheetTiyn: number;
}

/**
 * Prices to pre-fill for a chosen material.
 *
 *   Ақ                     ПВХ 200 ₸/м
 *   other shop sheets      ПВХ 220 ₸/м
 *   customer's own sheet   кесу 1600 ₸/лист, ПВХ 160 ₸/м
 *
 * The external case is checked first: a customer's own white board is still labour-priced, so the
 * white rule must not shadow it.
 */
export function journalDefaultsFor(material: Pick<Material, "name" | "color"> | undefined): JournalDefaults {
  if (isExternalMaterial(material)) {
    return {
      pvcPricePerMeterTiyn: EXTERNAL_PVC_PER_METER_TIYN,
      cuttingPerSheetTiyn: EXTERNAL_CUT_PER_SHEET_TIYN,
    };
  }
  return {
    pvcPricePerMeterTiyn: isWhiteMaterial(material) ? PVC_PRICE_WHITE_TIYN : PVC_PRICE_OTHER_TIYN,
    cuttingPerSheetTiyn: 0,
  };
}
