import { describe, it, expect } from "vitest";
import {
  journalDefaultsFor,
  isExternalMaterial,
  isWhiteMaterial,
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
