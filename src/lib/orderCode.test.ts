import { describe, it, expect } from "vitest";
import { shortOrderNumber, customerOrderCode } from "./orderCode";

describe("shortOrderNumber", () => {
  it("drops the prefix, the year and the leading zeros", () => {
    expect(shortOrderNumber("ORD-2026-000021")).toBe("21");
    expect(shortOrderNumber("ORD-2026-000007")).toBe("7");
    expect(shortOrderNumber("ORD-2026-001234")).toBe("1234");
  });

  it("keeps a zero order number visible rather than returning nothing", () => {
    expect(shortOrderNumber("ORD-2026-000000")).toBe("0");
  });

  it("returns the value unchanged when it has no trailing number", () => {
    expect(shortOrderNumber("ORD-TEST")).toBe("ORD-TEST");
  });

  it("handles a missing value", () => {
    expect(shortOrderNumber(undefined)).toBe("");
    expect(shortOrderNumber("")).toBe("");
  });

  it("ignores digits that are not at the end", () => {
    // The year must not be mistaken for the order number.
    expect(shortOrderNumber("ORD-2026-000045")).toBe("45");
  });
});

describe("customerOrderCode", () => {
  it("prefixes with № for display", () => {
    expect(customerOrderCode("ORD-2026-000021")).toBe("№21");
  });

  it("stays empty when there is nothing to show", () => {
    expect(customerOrderCode(undefined)).toBe("");
  });
});
