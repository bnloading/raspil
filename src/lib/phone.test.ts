import { describe, it, expect } from "vitest";
import { normalizePhone, isValidPhone, formatPhone, phoneToSyntheticEmail,
  nationalDigits,
  formatNational,
} from "./phone";

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

describe("nationalDigits", () => {
  it("keeps the ten digits that are actually typed", () => {
    expect(nationalDigits("7011234567")).toBe("7011234567");
  });

  it("drops a country code that came in with a pasted number", () => {
    expect(nationalDigits("+7 701 123 45 67")).toBe("7011234567");
    expect(nationalDigits("87011234567")).toBe("7011234567");
    expect(nationalDigits("77011234567")).toBe("7011234567");
  });

  it("never grows past ten, however much is pasted", () => {
    expect(nationalDigits("7701123456789999")).toBe("7011234567");
  });

  it("is empty for nothing, or for something with no digits in it", () => {
    expect(nationalDigits("")).toBe("");
    expect(nationalDigits("телефон")).toBe("");
  });

  it("keeps a half-typed number as it is", () => {
    expect(nationalDigits("701123")).toBe("701123");
  });
});

describe("formatNational", () => {
  it("builds the mask up as the digits arrive", () => {
    expect(formatNational("")).toBe("");
    expect(formatNational("70")).toBe("(70");
    expect(formatNational("701")).toBe("(701)");
    expect(formatNational("701123")).toBe("(701) 123");
    expect(formatNational("70112345")).toBe("(701) 123-45");
    expect(formatNational("7011234567")).toBe("(701) 123-45-67");
  });

  it("formats a full number that still carries its country code", () => {
    expect(formatNational("+77011234567")).toBe("(701) 123-45-67");
  });
});
