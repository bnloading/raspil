import { describe, it, expect } from "vitest";
import { tengeToTiyn, tiynToTenge, formatMoney, parseMoneyInput } from "./money";

describe("money as integer tiyn", () => {
  it("round-trips tenge <-> tiyn without float drift", () => {
    expect(tengeToTiyn(12345)).toBe(1_234_500);
    expect(tiynToTenge(1_234_500)).toBe(12345);
  });

  it("formats with the tenge symbol and locale thousands separators", () => {
    const expected = `${(12345).toLocaleString("ru-RU")} ₸`;
    expect(formatMoney(1_234_500)).toBe(expected);
  });

  it("treats undefined/null as zero", () => {
    expect(formatMoney(undefined)).toBe("0 ₸");
    expect(formatMoney(null)).toBe("0 ₸");
  });

  it("parses user-typed tenge into tiyn, ignoring stray characters", () => {
    expect(parseMoneyInput("12 345 ₸")).toBe(1_234_500);
    expect(parseMoneyInput("")).toBe(0);
  });
});
