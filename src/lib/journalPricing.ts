import type { Material } from "../types/domain";

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
