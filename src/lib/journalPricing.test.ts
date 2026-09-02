import { describe, it, expect } from "vitest";
import {
  journalDefaultsFor,
  isExternalMaterial,
  isHdfMaterial,
  isWhiteMaterial,
  matchPvcTypeFor,
  pvcDefaultsFor,
  PVC_PRICE_WHITE_TIYN,
  PVC_PRICE_OTHER_TIYN,
  EXTERNAL_CUT_PER_SHEET_TIYN,
  EXTERNAL_PVC_PER_METER_TIYN,
} from "./journalPricing";

const m = (name: string, color = "") => ({ name, color });

describe("journalDefaultsFor", () => {
  it("prices ПВХ at 200 for the white finish", () => {
    expect(journalDefaultsFor(m("ЛДСП Ақ", "Ақ")).pvcPricePerMeterTiyn).toBe(PVC_PRICE_WHITE_TIYN);
    expect(journalDefaultsFor(m("ЛДСП Ақ", "Ақ")).pvcPricePerMeterTiyn).toBe(20000);
  });

  it("prices ПВХ at 220 for every other shop sheet", () => {
    for (const name of ["ЛДСП Дуб Вотан", "ЛДСП Кашемир", "ЛДСП Честерфилд", "ХДФ"]) {
      expect(journalDefaultsFor(m(name)).pvcPricePerMeterTiyn, name).toBe(PVC_PRICE_OTHER_TIYN);
    }
    expect(PVC_PRICE_OTHER_TIYN).toBe(22000);
  });

  it("charges labour on a customer's own sheet: 1600 to cut, 160 for ПВХ", () => {
    const d = journalDefaultsFor(m("Сырттан келетін лист"));
    expect(d.cuttingPerSheetTiyn).toBe(EXTERNAL_CUT_PER_SHEET_TIYN);
    expect(d.pvcPricePerMeterTiyn).toBe(EXTERNAL_PVC_PER_METER_TIYN);
    expect(d.cuttingPerSheetTiyn).toBe(160000);
    expect(d.pvcPricePerMeterTiyn).toBe(16000);
  });

  it("charges nothing per sheet for the shop's own material — the sheet price covers it", () => {
    expect(journalDefaultsFor(m("ЛДСП Ақ", "Ақ")).cuttingPerSheetTiyn).toBe(0);
    expect(journalDefaultsFor(m("ЛДСП Кашемир")).cuttingPerSheetTiyn).toBe(0);
  });

  it("treats a customer's own WHITE board as labour, not as our 200 ₸ white", () => {
    // The external rule has to win, or a white outside board would be priced as if we sold it.
    const d = journalDefaultsFor(m("Сырттан келетін лист Ақ", "Ақ"));
    expect(d.pvcPricePerMeterTiyn).toBe(EXTERNAL_PVC_PER_METER_TIYN);
    expect(d.cuttingPerSheetTiyn).toBe(EXTERNAL_CUT_PER_SHEET_TIYN);
  });

  it("falls back to the ordinary rate when no material is chosen yet", () => {
    expect(journalDefaultsFor(undefined).pvcPricePerMeterTiyn).toBe(PVC_PRICE_OTHER_TIYN);
    expect(journalDefaultsFor(undefined).cuttingPerSheetTiyn).toBe(0);
  });
});

describe("isWhiteMaterial", () => {
  it("accepts both spellings the shop uses", () => {
    expect(isWhiteMaterial(m("ЛДСП Ақ", "Ақ"))).toBe(true);
    expect(isWhiteMaterial(m("Столешница Белый", "Белый"))).toBe(true);
  });

  it("does not match a colour that merely contains those letters", () => {
    // "Бежевый" ends in -вый but is not white; "Ақсай" is a place, not the finish.
    expect(isWhiteMaterial(m("Столешница Бежевый", "Бежевый"))).toBe(false);
    expect(isWhiteMaterial(m("ЛДСП Ақсай"))).toBe(false);
  });
});

describe("isExternalMaterial", () => {
  it("recognises the customer's own board", () => {
    expect(isExternalMaterial(m("Сырттан келетін лист"))).toBe(true);
  });

  it("is false for catalogue materials", () => {
    expect(isExternalMaterial(m("ЛДСП Ақ"))).toBe(false);
    expect(isExternalMaterial(undefined)).toBe(false);
  });
});

// ── ХДФ and the matching edge ────────────────────────────────────────────────

const roll = (id: string, colorName: string, thicknessMm = 1) => ({
  id, colorName, thicknessMm,
  pricePerMeterTiyn: 20000, active: true,
});

const ROLLS = [
  roll("p-ak-04", "Ақ", 0.4),
  roll("p-ak-1", "Ақ", 1),
  roll("p-ak-2", "Ақ", 2),
  roll("p-chester", "Честер", 1),
  roll("p-oak", "Дуб Вотан", 2),
];

describe("isHdfMaterial", () => {
  it("trusts the category when the material has one", () => {
    expect(isHdfMaterial({ name: "ХДФ 3мм", category: "hdf" })).toBe(true);
    expect(isHdfMaterial({ name: "ЛДСП Ақ", category: "ldsp" })).toBe(false);
    // A board named ХДФ but filed as ЛДСП is ЛДСП: the category is the decision someone made.
    expect(isHdfMaterial({ name: "ХДФ ұқсас", category: "ldsp" })).toBe(false);
  });

  it("falls back to the name for sheets added before categories existed", () => {
    expect(isHdfMaterial({ name: "ХДФ ақ 3мм" })).toBe(true);
    expect(isHdfMaterial({ name: "HDF white" })).toBe(true);
    expect(isHdfMaterial({ name: "ЛДСП Ақ" })).toBe(false);
  });

  it("is false for nothing at all", () => {
    expect(isHdfMaterial(undefined)).toBe(false);
  });
});

describe("matchPvcTypeFor", () => {
  it("matches the board's colour field to the roll", () => {
    expect(matchPvcTypeFor({ name: "ЛДСП Ақ 16мм", color: "Ақ" }, ROLLS)?.id).toBe("p-ak-1");
    expect(matchPvcTypeFor({ name: "ЛДСП Честер", color: "Честер" }, ROLLS)?.id).toBe("p-chester");
  });

  it("prefers the shop's standard 1 мм when a colour is stocked in several", () => {
    expect(matchPvcTypeFor({ name: "x", color: "Ақ" }, ROLLS)?.thicknessMm).toBe(1);
  });

  it("takes the thinnest when there is no 1 мм roll of that colour", () => {
    const only = [roll("a", "Каньон", 2), roll("b", "Каньон", 0.4)];
    expect(matchPvcTypeFor({ name: "x", color: "Каньон" }, only)?.id).toBe("b");
  });

  it("reads the finish out of the name when the colour field is empty", () => {
    expect(matchPvcTypeFor({ name: "ЛДСП Честер 16мм", color: "" }, ROLLS)?.id).toBe("p-chester");
  });

  it("matches a multi-word roll only when every word is on the board", () => {
    expect(matchPvcTypeFor({ name: "ЛДСП Дуб Вотан 16", color: "" }, ROLLS)?.id).toBe("p-oak");
    expect(matchPvcTypeFor({ name: "ЛДСП Дуб Санома", color: "" }, ROLLS)).toBeUndefined();
  });

  it("prefers the more specific roll when both could match", () => {
    const rolls = [roll("plain", "Ақ"), roll("gloss", "Ақ Глянец")];
    expect(matchPvcTypeFor({ name: "ЛДСП Ақ Глянец", color: "" }, rolls)?.id).toBe("gloss");
  });

  it("never matches on a fragment of a word", () => {
    // The whole point of matching words: "Ақсай" is a place, not the colour "Ақ".
    expect(matchPvcTypeFor({ name: "ЛДСП Ақсай", color: "Ақсай" }, ROLLS)).toBeUndefined();
  });

  it("returns nothing when the shop stocks no matching roll", () => {
    expect(matchPvcTypeFor({ name: "ЛДСП Каньон", color: "Каньон" }, ROLLS)).toBeUndefined();
    expect(matchPvcTypeFor(undefined, ROLLS)).toBeUndefined();
  });
});

describe("pvcDefaultsFor", () => {
  const nothingChosen = { pvcTypeId: "", pvcColorName: "" };

  it("clears ПВХ entirely for ХДФ, metres included", () => {
    expect(pvcDefaultsFor({ name: "ХДФ 3мм", category: "hdf", color: "" }, ROLLS, {
      pvcTypeId: "p-ak-1", pvcColorName: "Ақ",
    })).toEqual({
      edgeBanded: false, pvcTypeId: "", pvcColorName: "", pvcPricePerMeterTiyn: 0, pvcMeters: 0,
    });
  });

  it("fills in the matching colour at the board's standing rate", () => {
    expect(pvcDefaultsFor({ name: "ЛДСП Ақ", category: "ldsp", color: "Ақ" }, ROLLS, nothingChosen))
      .toEqual({
        edgeBanded: true,
        pvcTypeId: "p-ak-1",
        pvcColorName: "Ақ",
        pvcPricePerMeterTiyn: PVC_PRICE_WHITE_TIYN,
      });
  });

  it("keeps a colour already chosen when nothing matches, rather than wiping it", () => {
    const chosen = { pvcTypeId: "p-chester", pvcColorName: "Честер" };
    const out = pvcDefaultsFor({ name: "ЛДСП Каньон", category: "ldsp", color: "Каньон" }, ROLLS, chosen);
    expect(out).toMatchObject({ edgeBanded: true, pvcTypeId: "p-chester", pvcColorName: "Честер" });
    // The rate still follows the new board.
    expect(out.pvcPricePerMeterTiyn).toBe(PVC_PRICE_OTHER_TIYN);
  });

  it("prices a customer's own board at the labour rate, matching colour and all", () => {
    const out = pvcDefaultsFor({ name: "Сырттан келетін лист Честер", category: "ldsp", color: "Честер" }, ROLLS, nothingChosen);
    expect(out.pvcTypeId).toBe("p-chester");
    expect(out.pvcPricePerMeterTiyn).toBe(EXTERNAL_PVC_PER_METER_TIYN);
  });
});

describe("matchPvcTypeFor — Ақ and Белый are one finish", () => {
  it("finds the Ақ roll for a board the catalogue calls Белый", () => {
    expect(matchPvcTypeFor({ name: "Столешница Белый", color: "Белый" }, ROLLS)?.id).toBe("p-ak-1");
  });

  it("finds a Белый roll for a board the catalogue calls Ақ", () => {
    const rolls = [roll("p-bel", "Белый", 1)];
    expect(matchPvcTypeFor({ name: "ЛДСП Ақ", color: "Ақ" }, rolls)?.id).toBe("p-bel");
  });

  it("still refuses a fragment: Белая is not Белый", () => {
    expect(matchPvcTypeFor({ name: "ЛДСП Белая ночь", color: "Белая ночь" }, ROLLS)).toBeUndefined();
  });
});
