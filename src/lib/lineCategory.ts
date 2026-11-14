import { isHdfMaterial } from "./journalPricing";
import type { MaterialCategory } from "../types/domain";

/**
 * The category a cut line is paid and counted by.
 *
 * The catalogue's own category whenever the material is still in it. When it has since been
 * deleted, the line still carries the name it was typed under, and that name is read instead:
 * "Столешница Симал Бежевый" was cut on two orders and then removed from the catalogue, and with
 * no entry to look up, both lines fell to the ЛДСП default and paid the cutter the sheet rate
 * (600 ₸) for a countertop (300 ₸). Anything the name does not settle stays ЛДСП, as before.
 */
export function lineCategory(
  line: { materialId: string; materialName?: string },
  categoryByMaterialId: ReadonlyMap<string, MaterialCategory>,
): MaterialCategory {
  const known = categoryByMaterialId.get(line.materialId);
  if (known) return known;
  const name = line.materialName ?? "";
  if (/столешниц/i.test(name)) return "countertop";
  if (isHdfMaterial({ name })) return "hdf";
  return "ldsp";
}

/**
 * The two things the shop keeps apart on Қойма and at the saw: sheets (ЛДСП, ХДФ, МДФ, черновой)
 * and countertops. The owner, 14.11: «Қоймада лист, столештер жеке көрінсін… Динкода 4 лист Ақ,
 * 2 столеш болса, бөлініп Ақ заказ ретінде көрінсін, столеш жеке бетте тұрсын».
 */
export type StockKind = "sheet" | "countertop";

/** A catalogue row's kind — what Қойма's «ЛДСП» / «Столешница» tabs split on. */
export function materialKind(material: { category?: MaterialCategory }): StockKind {
  return material.category === "countertop" ? "countertop" : "sheet";
}

/** A cut line's kind, read the same way it is paid (lineCategory). */
export function lineKind(
  line: { materialId: string; materialName?: string },
  categoryByMaterialId: ReadonlyMap<string, MaterialCategory>,
): StockKind {
  return lineCategory(line, categoryByMaterialId) === "countertop" ? "countertop" : "sheet";
}
