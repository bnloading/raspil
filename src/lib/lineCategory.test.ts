import { describe, it, expect } from "vitest";
import { lineCategory } from "./lineCategory";

describe("lineCategory", () => {
  const catalogue = new Map([["top-votan", "countertop"], ["m-odd", "ldsp"]] as const);

  it("takes the catalogue's category whenever the material is still in it", () => {
    expect(lineCategory({ materialId: "top-votan", materialName: "Столешница Дуб Вотан" }, catalogue)).toBe("countertop");
    // A name is never allowed to overrule the catalogue — that is the decision someone made.
    expect(lineCategory({ materialId: "m-odd", materialName: "Столешница, ЛДСП ретінде" }, catalogue)).toBe("ldsp");
  });

  it("reads a deleted material by the name the line kept", () => {
    expect(lineCategory({ materialId: "top-simal-bezhevyi", materialName: "Столешница Симал Бежевый" }, catalogue)).toBe("countertop");
    expect(lineCategory({ materialId: "gone-hdf", materialName: "ХДФ ақ 3мм" }, catalogue)).toBe("hdf");
    expect(lineCategory({ materialId: "gone", materialName: "ЛДСП Сонома" }, catalogue)).toBe("ldsp");
    expect(lineCategory({ materialId: "gone" }, catalogue)).toBe("ldsp");
  });
});
