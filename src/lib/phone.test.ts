import { describe, it, expect } from "vitest";
import { normalizePhone, isValidPhone, formatPhone, phoneToSyntheticEmail } from "./phone";

describe("normalizePhone", () => {
  it("accepts 10-digit local numbers and adds the country code", () => {
    expect(normalizePhone("7771234567")).toBe("77771234567");
  });
  it("accepts 11-digit numbers starting with 8 (common local habit)", () => {
    expect(normalizePhone("87771234567")).toBe("77771234567");
  });
  it("accepts already-formatted input", () => {
    expect(normalizePhone("+7 (777) 123-45-67")).toBe("77771234567");
  });
  it("rejects garbage", () => {
    expect(normalizePhone("12345")).toBeNull();
  });
});

describe("formatPhone", () => {
  it("formats as +7 (7**) ***-**-**", () => {
    expect(formatPhone("77771234567")).toBe("+7 (777) 123-45-67");
  });
});

describe("isValidPhone", () => {
  it("matches normalizePhone's judgement", () => {
    expect(isValidPhone("+7 777 123 45 67")).toBe(true);
    expect(isValidPhone("abc")).toBe(false);
  });
});

describe("phoneToSyntheticEmail", () => {
  it("produces a stable, deterministic fake address for Firebase Auth", () => {
    expect(phoneToSyntheticEmail("+7 (777) 123-45-67")).toBe("77771234567@customers.workshop.local");
    expect(phoneToSyntheticEmail("87771234567")).toBe(phoneToSyntheticEmail("7 777 123 45 67"));
  });
  it("throws on an invalid phone rather than silently emailing a garbage address", () => {
    expect(() => phoneToSyntheticEmail("123")).toThrow();
  });
});
