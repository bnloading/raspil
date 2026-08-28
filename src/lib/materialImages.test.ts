import { describe, it, expect } from "vitest";
import { materialImage } from "./materialImages";

describe("materialImage", () => {
  it("uses an Admin-supplied imageUrl above everything else", () => {
    const url = materialImage({ id: "ldsp-ak", imageUrl: "https://cdn.example/custom.jpg" });
    expect(url).toBe("https://cdn.example/custom.jpg");
  });

  it("ignores a blank imageUrl and falls through to the bundled photo", () => {
    const blank = materialImage({ id: "ldsp-ak", imageUrl: "   " });
    expect(blank).toBe(materialImage({ id: "ldsp-ak" }));
    expect(blank).toBeTruthy();
  });

  it("resolves every catalogue material by document id", () => {
    for (const id of [
      "ldsp-ak",
      "ldsp-bunratti",
      "ldsp-dub-votan",
      "ldsp-sonoma",
      "ldsp-svetlo-seryi",
      "ldsp-chesterfield",
    ]) {
      expect(materialImage({ id }), id).toBeTruthy();
    }
  });

  it("gives each finish a distinct picture", () => {
    const ids = ["ldsp-ak", "ldsp-bunratti", "ldsp-dub-votan", "ldsp-sonoma", "ldsp-svetlo-seryi", "ldsp-chesterfield"];
    const urls = ids.map((id) => materialImage({ id }));
    expect(new Set(urls).size).toBe(ids.length);
  });

  it("resolves by article code when the id is unknown", () => {
    expect(materialImage({ id: "some-new-doc", article: "DV-014" })).toBe(materialImage({ id: "ldsp-dub-votan" }));
  });

  it("resolves by colour name for a material added later", () => {
    // A second Вотан in another thickness gets the right photo without touching this table.
    expect(materialImage({ id: "new", name: "ЛДСП Дуб Вотан 18мм", color: "Дуб Вотан" }))
      .toBe(materialImage({ id: "ldsp-dub-votan" }));
  });

  it("accepts both spellings the shop actually uses", () => {
    const sonoma = materialImage({ id: "ldsp-sonoma" });
    expect(materialImage({ id: "x", color: "Санома" })).toBe(sonoma);
    expect(materialImage({ id: "x", color: "Сонома" })).toBe(sonoma);

    const chester = materialImage({ id: "ldsp-chesterfield" });
    expect(materialImage({ id: "x", color: "Честер" })).toBe(chester);
    expect(materialImage({ id: "x", color: "Честерфилд" })).toBe(chester);
  });

  it("matches the longer alias when one contains another", () => {
    // "серый" is a substring of the "светло серый" key; the more specific one must win.
    expect(materialImage({ id: "x", color: "Светло серый" })).toBe(materialImage({ id: "ldsp-svetlo-seryi" }));
  });

  it("is case and punctuation insensitive", () => {
    expect(materialImage({ id: "x", color: "  ДУБ-ВОТАН  " })).toBe(materialImage({ id: "ldsp-dub-votan" }));
  });

  it("returns null when there is genuinely no photo", () => {
    // The customer's own sheet has no catalogue picture, and that is a real answer.
    expect(materialImage({ id: "5ixr3H0H5TZeJ5eVdYGw", name: "Сырттан келетін лист", article: "1" })).toBeNull();
    expect(materialImage({ id: "ldsp-kashemir", name: "ЛДСП Кашемир", color: "Кашемир" })).toBeNull();
    expect(materialImage(undefined)).toBeNull();
    expect(materialImage({})).toBeNull();
  });

  it("also resolves an edge-banding colour, which uses colorName", () => {
    expect(materialImage({ id: "pvc-1-kanyon", colorName: "Каньон" })).toBeTruthy();
  });
});
