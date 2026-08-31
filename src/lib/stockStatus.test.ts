import { describe, it, expect } from "vitest";
import { stockStatus, lowStockCount, UNTRACKED_LABEL } from "./stockStatus";

const m = (qtyOnHand: number, reservedQty = 0, minStock = 5) => ({ qtyOnHand, reservedQty, minStock });

describe("stockStatus", () => {
  it("matches the bands in the reference table", () => {
    // 141 sheets against a floor of 5 is healthy; 6 is approaching it; 3 is at or under it.
    expect(stockStatus(m(141, 6)).level).toBe("ok");
    expect(stockStatus(m(6, 0)).level).toBe("low");
    expect(stockStatus(m(3, 0)).level).toBe("critical");
  });

  it("counts only what is not already reserved", () => {
    // 8 on hand but 5 promised away leaves 3 — under the floor, however full the shelf looks.
    const s = stockStatus(m(8, 5));
    expect(s.available).toBe(3);
    expect(s.level).toBe("critical");
  });

  it("reports out of stock at zero available", () => {
    expect(stockStatus(m(0)).level).toBe("out");
    expect(stockStatus(m(4, 4)).level).toBe("out");
  });

  it("never reports negative availability when over-reserved", () => {
    expect(stockStatus(m(2, 9)).available).toBe(0);
  });

  it("scales the bands to each material's own floor", () => {
    // 30 sheets is plenty against a floor of 5 and critical against a floor of 50.
    expect(stockStatus(m(30, 0, 5)).level).toBe("ok");
    expect(stockStatus(m(30, 0, 50)).level).toBe("critical");
  });

  it("has no 'getting low' band when no floor is set", () => {
    expect(stockStatus(m(1, 0, 0)).level).toBe("ok");
    expect(stockStatus(m(0, 0, 0)).level).toBe("out");
  });

  it("gives a bar ratio that fills by three times the floor and never exceeds 1", () => {
    expect(stockStatus(m(15, 0, 5)).ratio).toBe(1);
    expect(stockStatus(m(500, 0, 5)).ratio).toBe(1);
    expect(stockStatus(m(5, 0, 5)).ratio).toBeCloseTo(1 / 3, 5);
    expect(stockStatus(m(0, 0, 5)).ratio).toBe(0);
  });

  it("carries a Kazakh label with the level", () => {
    expect(stockStatus(m(3)).label).toBe("Таусылуға жақын");
    expect(stockStatus(m(141)).label).toBe("Жеткілікті");
  });
});

describe("materials that are not shop stock", () => {
  const untracked = { qtyOnHand: 0, reservedQty: 0, minStock: 5, stockTracked: false };

  it("never reports a shortage on a permanently empty line", () => {
    expect(stockStatus(untracked).level).toBe("ok");
    expect(stockStatus(untracked).label).toBe(UNTRACKED_LABEL);
    expect(stockStatus(untracked).ratio).toBe(0);
  });

  it("is left out of the low-stock count", () => {
    expect(lowStockCount([m(3), untracked, untracked])).toBe(1); // only the real shortage
  });
});

describe("lowStockCount", () => {
  it("counts materials at or under their floor, including empty ones", () => {
    expect(lowStockCount([m(141), m(6), m(3), m(0)])).toBe(2); // the 3 and the 0
  });

  it("is zero when everything is healthy", () => {
    expect(lowStockCount([m(100), m(80)])).toBe(0);
  });
});
