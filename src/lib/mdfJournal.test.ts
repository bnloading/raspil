import { describe, it, expect } from "vitest";
import {
  computeMdfOrderTotal,
  computeMdfPanelsAreaM2,
  computeMdfPanelsCostTiyn,
  DEFAULT_MDF_PATTERN_TEMPLATES,
  findMdfPatternTemplate,
  formatMdfArea,
  mdfPanelCostTiyn,
  mdfPatternOf,
  mdfPatternTemplates,
  mdfTemplatesProblem,
  type MdfOrderInput,
} from "./mdfJournal";
import { emptyMdfJournalDraft, mdfDraftHasContent } from "./mdfJournalOrders";
import type { MdfPanel } from "../types/domain";

function panel(overrides: Partial<MdfPanel> = {}): Pick<MdfPanel, "lengthMm" | "widthMm" | "qty" | "pattern"> {
  return { lengthMm: 1000, widthMm: 1000, qty: 1, pattern: "modern", ...overrides };
}

const T = (n: number) => n * 100; // ₸ → tiyn

function order(overrides: Partial<MdfOrderInput> = {}): MdfOrderInput {
  return {
    areaM2: 0,
    pricePerM2Tiyn: 0,
    extraServicesTiyn: 0,
    deliveryCostTiyn: 0,
    discountTiyn: 0,
    paidTiyn: 0,
    ...overrides,
  };
}

describe("computeMdfOrderTotal", () => {
  it("multiplies area by the per-m² price", () => {
    const r = computeMdfOrderTotal(order({ areaM2: 8.4, pricePerM2Tiyn: T(5000) }));
    expect(r.areaCostTiyn).toBe(T(42000));
    expect(r.totalTiyn).toBe(T(42000));
  });

  it("adds extras and delivery, then subtracts the discount", () => {
    const r = computeMdfOrderTotal(
      order({
        areaM2: 10,
        pricePerM2Tiyn: T(5000),
        extraServicesTiyn: T(3000),
        deliveryCostTiyn: T(2000),
        discountTiyn: T(5000),
      }),
    );
    expect(r.totalTiyn).toBe(T(50000) + T(3000) + T(2000) - T(5000));
  });

  it("floors the total at zero when the discount exceeds the cost", () => {
    const r = computeMdfOrderTotal(order({ areaM2: 1, pricePerM2Tiyn: T(1000), discountTiyn: T(5000) }));
    expect(r.totalTiyn).toBe(0);
  });

  it("debt is total minus paid, and can go negative when overpaid", () => {
    const r = computeMdfOrderTotal(order({ areaM2: 10, pricePerM2Tiyn: T(1000), paidTiyn: T(15000) }));
    expect(r.totalTiyn).toBe(T(10000));
    expect(r.debtTiyn).toBe(T(-5000));
    expect(r.paymentStatus).toBe("overpaid");
  });

  it("rounds fractional area×price to whole tiyn", () => {
    const r = computeMdfOrderTotal(order({ areaM2: 3.333, pricePerM2Tiyn: 12345 }));
    expect(Number.isInteger(r.areaCostTiyn)).toBe(true);
  });
});

describe("computeMdfPanelsAreaM2", () => {
  it("converts one panel's mm dimensions to m²", () => {
    expect(computeMdfPanelsAreaM2([{ lengthMm: 2000, widthMm: 600, qty: 1 }])).toBeCloseTo(1.2);
  });

  it("multiplies by quantity", () => {
    expect(computeMdfPanelsAreaM2([{ lengthMm: 1000, widthMm: 500, qty: 3 }])).toBeCloseTo(1.5);
  });

  it("sums several panels of different sizes", () => {
    const total = computeMdfPanelsAreaM2([
      { lengthMm: 2000, widthMm: 600, qty: 1 }, // 1.2
      { lengthMm: 800, widthMm: 400, qty: 2 }, // 0.64
    ]);
    expect(total).toBeCloseTo(1.84);
  });

  it("is zero for an empty panel list", () => {
    expect(computeMdfPanelsAreaM2([])).toBe(0);
  });
});

describe("mdfPanelCostTiyn", () => {
  it("prices a 1m² panel at the pattern's fixed rate", () => {
    expect(mdfPanelCostTiyn(panel({ lengthMm: 1000, widthMm: 1000, qty: 1, pattern: "modern" }))).toBe(1_650_000);
  });

  it("multiplies by quantity", () => {
    expect(mdfPanelCostTiyn(panel({ lengthMm: 1000, widthMm: 1000, qty: 2, pattern: "modern" }))).toBe(3_300_000);
  });

  it("is undefined for a custom (\"basqa\") pattern — the Manager quotes it by hand", () => {
    expect(mdfPanelCostTiyn(panel({ pattern: "basqa" }))).toBeUndefined();
  });

  it("is undefined for the pre-split legacy \"vyborka\" value", () => {
    expect(mdfPanelCostTiyn(panel({ pattern: "vyborka" }))).toBeUndefined();
  });

  it("prices the two выборка depths differently", () => {
    const p50 = mdfPanelCostTiyn(panel({ pattern: "vyborka50" }))!;
    const p20 = mdfPanelCostTiyn(panel({ pattern: "vyborka20" }))!;
    expect(p50).toBeLessThan(p20);
  });
});

describe("computeMdfPanelsCostTiyn", () => {
  it("sums several panels of known patterns", () => {
    const total = computeMdfPanelsCostTiyn([
      panel({ lengthMm: 1000, widthMm: 1000, qty: 1, pattern: "modern" }), // 1_650_000
      panel({ lengthMm: 1000, widthMm: 1000, qty: 1, pattern: "riflenka" }), // 1_750_000
    ]);
    expect(total).toBe(3_400_000);
  });

  it("is undefined the moment any one panel's pattern has no fixed price", () => {
    const total = computeMdfPanelsCostTiyn([
      panel({ pattern: "modern" }),
      panel({ pattern: "basqa" }),
    ]);
    expect(total).toBeUndefined();
  });

  it("is zero for an empty panel list", () => {
    expect(computeMdfPanelsCostTiyn([])).toBe(0);
  });
});

describe("formatMdfArea", () => {
  it("rounds mm-derived float noise away to two decimals", () => {
    // 2000×600×2 + 800×400×3, in mm, is the classic case that leaves 3.3600000000000003 in JS.
    const noisy = computeMdfPanelsAreaM2([
      { lengthMm: 2000, widthMm: 600, qty: 2 },
      { lengthMm: 800, widthMm: 400, qty: 3 },
    ]);
    expect(formatMdfArea(noisy)).toBe("3.36 м²");
  });

  it("defaults a missing area to zero rather than showing nothing", () => {
    expect(formatMdfArea(undefined)).toBe("0.00 м²");
    expect(formatMdfArea(null)).toBe("0.00 м²");
  });
});

describe("«Узор» templates — what the МДФ journal fills an order's м² price from", () => {
  it("starts from the shop's fixed rates, «Басқа» left out (it is the typed-by-hand choice)", () => {
    expect(DEFAULT_MDF_PATTERN_TEMPLATES).toEqual([
      { name: "Модерн", pricePerM2Tiyn: T(16500) },
      { name: "Рифленка", pricePerM2Tiyn: T(17500) },
      { name: "Квадро", pricePerM2Tiyn: T(18500) },
      { name: "Выборка 50мм", pricePerM2Tiyn: T(19500) },
      { name: "20мм выборка", pricePerM2Tiyn: T(20500) },
    ]);
  });

  it("uses the Admin's list once one is saved, and the fixed rates until then", () => {
    const saved = [{ name: "Модерн", pricePerM2Tiyn: T(17000) }];
    expect(mdfPatternTemplates({ mdfPatternTemplates: saved })).toBe(saved);
    expect(mdfPatternTemplates({})).toBe(DEFAULT_MDF_PATTERN_TEMPLATES);
    expect(mdfPatternTemplates({ mdfPatternTemplates: [] })).toBe(DEFAULT_MDF_PATTERN_TEMPLATES);
  });

  it("finds an order's template by name, whatever the case or stray spaces", () => {
    expect(findMdfPatternTemplate(DEFAULT_MDF_PATTERN_TEMPLATES, "  рифленка ")?.pricePerM2Tiyn).toBe(T(17500));
    expect(findMdfPatternTemplate(DEFAULT_MDF_PATTERN_TEMPLATES, "Классика")).toBeUndefined();
    expect(findMdfPatternTemplate(DEFAULT_MDF_PATTERN_TEMPLATES, "")).toBeUndefined();
  });

  it("refuses a list it could not pick from: a blank name, no price, or one name twice", () => {
    expect(mdfTemplatesProblem(DEFAULT_MDF_PATTERN_TEMPLATES)).toBeNull();
    expect(mdfTemplatesProblem([])).toBe("Кемінде бір узор керек");
    expect(mdfTemplatesProblem([{ name: " ", pricePerM2Tiyn: T(100) }])).toBe("Узор аты жазылмаған");
    expect(mdfTemplatesProblem([{ name: "Классика", pricePerM2Tiyn: 0 }])).toBe("«Классика»: м² бағасы жазылмаған");
    expect(mdfTemplatesProblem([
      { name: "Модерн", pricePerM2Tiyn: T(16500) },
      { name: "модерн ", pricePerM2Tiyn: T(17000) },
    ])).toBe("«модерн» екі рет жазылған");
  });
});

describe("mdfPatternOf — what an order is milled with", () => {
  it("is the «Узор» the journal wrote down", () => {
    expect(mdfPatternOf({ mdfPatternName: " Модерн " })).toBe("Модерн");
  });

  it("falls back to a customer's own panels, each pattern named once", () => {
    expect(mdfPatternOf({ mdfPanels: [{ pattern: "modern" }, { pattern: "kvadro" }, { pattern: "modern" }] })).toBe("Модерн, Квадро");
  });

  it("is empty when neither says", () => {
    expect(mdfPatternOf({})).toBe("");
  });
});

describe("mdfDraftHasContent", () => {
  it("counts a picked «Узор» as typing, so closing the form asks first", () => {
    expect(mdfDraftHasContent(emptyMdfJournalDraft())).toBe(false);
    expect(mdfDraftHasContent({ ...emptyMdfJournalDraft(), patternName: "Модерн" })).toBe(true);
  });
});
