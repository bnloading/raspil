import { describe, it, expect } from "vitest";
import {
  assortmentStock,
  categoryChips,
  categoryOf,
  filterMaterials,
  materialSpec,
  sortMaterials,
} from "./assortment";
import type { Material } from "../types/domain";

function material(over: Partial<Material> = {}): Material {
  return {
    id: over.article ?? "m1",
    name: "ЛДСП Ақ Томск",
    article: "AK-001",
    color: "Ақ",
    thicknessMm: 16,
    sheetLengthMm: 2800,
    sheetWidthMm: 2070,
    sellingPriceTiyn: 1650000,
    initialQty: 0,
    qtyOnHand: 20,
    reservedQty: 0,
    minStock: 5,
    active: true,
    archived: false,
    grainDirectionRequired: false,
    ...over,
  };
}

describe("categoryOf", () => {
  it("defaults to ЛДСП, the way the domain does for rows added before categories", () => {
    expect(categoryOf(material({ category: undefined }))).toBe("ldsp");
    expect(categoryOf(material({ category: "hdf" }))).toBe("hdf");
  });
});

describe("categoryChips", () => {
  const list = [
    material({ article: "a", category: "ldsp" }),
    material({ article: "b", category: undefined }),
    material({ article: "c", category: "hdf" }),
    material({ article: "d", category: "countertop" }),
  ];

  it("counts each category, with Барлығы first", () => {
    expect(categoryChips(list)).toEqual([
      { id: "all", label: "Барлығы", count: 4 },
      { id: "ldsp", label: "ЛДСП", count: 2 },
      { id: "hdf", label: "ХДФ", count: 1 },
      { id: "countertop", label: "Столешница", count: 1 },
    ]);
  });

  it("offers no chip for a category the shop does not stock", () => {
    expect(categoryChips(list).map((c) => c.id)).not.toContain("mdf");
  });

  it("still offers Барлығы for an empty catalogue", () => {
    expect(categoryChips([])).toEqual([{ id: "all", label: "Барлығы", count: 0 }]);
  });
});

describe("filterMaterials", () => {
  const list = [
    material({ article: "AK-001", name: "ЛДСП Ақ Томск", category: "ldsp" }),
    material({ article: "DB-014", name: "ЛДСП Дуб Бунратти", category: "ldsp" }),
    material({ article: "HD-003", name: "ХДФ 3мм", category: "hdf", qtyOnHand: 0 }),
  ];
  const base = { query: "", category: "all" as const, inStockOnly: false };

  it("finds a board by name", () => {
    expect(filterMaterials(list, { ...base, query: "бунратти" }).map((m) => m.article)).toEqual(["DB-014"]);
  });

  it("finds the same board by its article code", () => {
    // A customer says "Дуб Бунратти", a fitter says "DB-014".
    expect(filterMaterials(list, { ...base, query: "db-014" }).map((m) => m.article)).toEqual(["DB-014"]);
  });

  it("narrows to one category", () => {
    expect(filterMaterials(list, { ...base, category: "hdf" }).map((m) => m.article)).toEqual(["HD-003"]);
  });

  it("hides what cannot be sold today when asked to", () => {
    expect(filterMaterials(list, { ...base, inStockOnly: true }).map((m) => m.article))
      .toEqual(["AK-001", "DB-014"]);
  });

  it("counts reserved sheets as unavailable, not as stock", () => {
    const promised = [material({ article: "X", qtyOnHand: 4, reservedQty: 4 })];
    expect(filterMaterials(promised, { ...base, inStockOnly: true })).toEqual([]);
  });

  it("combines search and category rather than picking one", () => {
    expect(filterMaterials(list, { ...base, query: "лдсп", category: "hdf" })).toEqual([]);
  });
});

describe("sortMaterials", () => {
  const list = [
    material({ article: "b", name: "Бета", sellingPriceTiyn: 300, qtyOnHand: 1, minStock: 0 }),
    material({ article: "a", name: "Альфа", sellingPriceTiyn: 900, qtyOnHand: 9, minStock: 0 }),
    material({ article: "c", name: "Гамма", sellingPriceTiyn: 100, qtyOnHand: 5, minStock: 0 }),
  ];

  it("sorts by name by default", () => {
    expect(sortMaterials(list, "name").map((m) => m.name)).toEqual(["Альфа", "Бета", "Гамма"]);
  });

  it("sorts cheapest first by price", () => {
    expect(sortMaterials(list, "price").map((m) => m.article)).toEqual(["c", "b", "a"]);
  });

  it("sorts most available first by stock — the question is what you can have today", () => {
    expect(sortMaterials(list, "stock").map((m) => m.article)).toEqual(["a", "c", "b"]);
  });

  it("does not reorder the caller's own array", () => {
    const original = [...list];
    sortMaterials(list, "price");
    expect(list).toEqual(original);
  });
});

describe("assortmentStock", () => {
  it("says nothing is there when nothing can be sold", () => {
    expect(assortmentStock(material({ qtyOnHand: 0 }))).toEqual({ tone: "out", label: "Қоймада жоқ" });
  });

  it("counts what is promised to somebody else as gone", () => {
    expect(assortmentStock(material({ qtyOnHand: 6, reservedQty: 6 })).tone).toBe("out");
  });

  it("warns while there is still some left", () => {
    // minStock 5, four free: at or under the floor.
    expect(assortmentStock(material({ qtyOnHand: 4, minStock: 5 })))
      .toEqual({ tone: "low", label: "Аз қалды: 4 лист" });
  });

  it("gives the plain count when there is plenty", () => {
    expect(assortmentStock(material({ qtyOnHand: 15, minStock: 2 })))
      .toEqual({ tone: "ok", label: "Қоймада 15 лист" });
  });

  it("does not report a warehouse level for something the shop does not stock", () => {
    // A customer's own board has no balance to be short of — see Material.stockTracked.
    expect(assortmentStock(material({ stockTracked: false, qtyOnHand: 0 })))
      .toEqual({ tone: "untracked", label: "Тапсырыспен" });
  });
});

describe("materialSpec", () => {
  it("prints the thickness and the sheet size", () => {
    expect(materialSpec({ thicknessMm: 16, sheetLengthMm: 2800, sheetWidthMm: 2070 }))
      .toBe("16 мм · 2800×2070");
  });

  it("leaves out a dimension the catalogue does not have", () => {
    expect(materialSpec({ thicknessMm: 16, sheetLengthMm: 0, sheetWidthMm: 0 })).toBe("16 мм");
    expect(materialSpec({ thicknessMm: 0, sheetLengthMm: 2800, sheetWidthMm: 2070 })).toBe("2800×2070");
  });
});
