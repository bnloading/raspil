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
