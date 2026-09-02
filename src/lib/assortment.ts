import { MATERIAL_CATEGORY_LABELS, type Material, type MaterialCategory } from "../types/domain";
import { stockStatus } from "./stockStatus";

/**
 * The "Листтер" catalogue: what the shop sells, as anyone standing in it would ask for it.
 *
 * Everything here is pure so the searching, the category chips, the sorting and the stock wording
 * can be tested without a page — this is the screen a customer browses before they order anything,
 * and "is it in stock" has to be right.
 */

/** The order the chips are drawn in; only the ones the catalogue actually has are shown. */
const CATEGORY_ORDER: MaterialCategory[] = ["ldsp", "hdf", "countertop", "mdf", "other"];

/** Category of a material, defaulting the way the domain does for rows added before categories. */
export function categoryOf(material: Pick<Material, "category">): MaterialCategory {
  return material.category ?? "ldsp";
}

export interface CategoryChip {
  id: MaterialCategory | "all";
  label: string;
  count: number;
}

/**
 * "Барлығы 28 · ЛДСП 21 · ХДФ 4 · Столешница 3".
 *
 * A chip for a category the shop does not stock is a dead end, so only the ones with something
 * behind them are offered — and the counts are on them, so "do you have ХДФ" is answered without
 * a tap.
 */
export function categoryChips(materials: readonly Material[]): CategoryChip[] {
  const counts = new Map<MaterialCategory, number>();
  for (const m of materials) {
    const c = categoryOf(m);
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }

  return [
    { id: "all" as const, label: "Барлығы", count: materials.length },
    ...CATEGORY_ORDER.filter((c) => counts.has(c)).map((c) => ({
      id: c,
      label: MATERIAL_CATEGORY_LABELS[c],
      count: counts.get(c) ?? 0,
    })),
  ];
}

export interface AssortmentFilter {
  query: string;
  category: MaterialCategory | "all";
  /** Hides anything with nothing free to sell. */
  inStockOnly: boolean;
}

/**
 * Search matches the name or the article code, because a customer says "Ақ Томск" and a fitter
 * says "AK-001", and both are looking for the same board.
 */
export function filterMaterials(materials: readonly Material[], filter: AssortmentFilter): Material[] {
  const q = filter.query.trim().toLowerCase();

  return materials.filter((m) => {
    if (filter.category !== "all" && categoryOf(m) !== filter.category) return false;
    if (filter.inStockOnly && stockStatus(m).available <= 0) return false;
    if (!q) return true;
    return (
      (m.name ?? "").toLowerCase().includes(q) ||
      (m.article ?? "").toLowerCase().includes(q)
    );
  });
}

export type AssortmentSort = "name" | "price" | "stock";

export const SORT_LABELS: Record<AssortmentSort, string> = {
  name: "Атауы бойынша",
  price: "Арзаннан қымбатқа",
  stock: "Қоймадағы саны",
};

/** Sorted copy — never in place, the caller's list is a memo somebody else may still be holding. */
export function sortMaterials(materials: readonly Material[], sort: AssortmentSort): Material[] {
  const out = [...materials];
  switch (sort) {
    case "price":
      return out.sort((a, b) => a.sellingPriceTiyn - b.sellingPriceTiyn || a.name.localeCompare(b.name));
    case "stock":
      // Most available first: this sort is used to answer "what can I have today".
      return out.sort(
        (a, b) => stockStatus(b).available - stockStatus(a).available || a.name.localeCompare(b.name),
      );
    default:
      return out.sort((a, b) => a.name.localeCompare(b.name));
  }
}

export type StockTone = "out" | "low" | "ok" | "untracked";

export interface AssortmentStock {
  tone: StockTone;
  label: string;
}

/**
 * The stock line on a catalogue card, in a customer's words rather than the warehouse's.
 *
 * The Қойма table says "Таусылуға жақын"; a customer only needs to know whether they can have it
 * today and roughly how much is there. The count is the sellable figure — on hand less what is
 * already promised to somebody else — so it is never a number the shop cannot honour.
 */
export function assortmentStock(material: Material): AssortmentStock {
  const info = stockStatus(material);

  if (material.stockTracked === false) return { tone: "untracked", label: "Тапсырыспен" };
  if (info.available <= 0) return { tone: "out", label: "Қоймада жоқ" };
  if (info.level === "critical" || info.level === "low") {
    return { tone: "low", label: `Аз қалды: ${info.available} лист` };
  }
  return { tone: "ok", label: `Қоймада ${info.available} лист` };
}

/** "16 мм · 2800×2070" — the board's own dimensions, as the catalogue prints them. */
export function materialSpec(material: Pick<Material, "thicknessMm" | "sheetLengthMm" | "sheetWidthMm">): string {
  const size =
    material.sheetLengthMm > 0 && material.sheetWidthMm > 0
      ? `${material.sheetLengthMm}×${material.sheetWidthMm}`
      : "";
  return [material.thicknessMm > 0 ? `${material.thicknessMm} мм` : "", size].filter(Boolean).join(" · ");
}
