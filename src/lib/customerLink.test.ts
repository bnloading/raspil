import { describe, it, expect } from "vitest";
import { needsCustomerLink } from "./customerLink";

describe("needsCustomerLink", () => {
  it("wants a link for a journal row with a phone and nobody attached", () => {
    expect(needsCustomerLink({ customerId: undefined, customerPhone: "+7 701 123 45 67" })).toBe(true);
  });

  it("leaves an order that already belongs to an account alone", () => {
    expect(needsCustomerLink({ customerId: "uid-1", customerPhone: "77011234567" })).toBe(false);
  });

  it("cannot match on a phone that is not one", () => {
    expect(needsCustomerLink({ customerId: undefined, customerPhone: "" })).toBe(false);
    expect(needsCustomerLink({ customerId: undefined, customerPhone: "123" })).toBe(false);
    expect(needsCustomerLink({ customerId: undefined, customerPhone: "телефон жоқ" })).toBe(false);
  });

  it("accepts every way the shop writes the same number", () => {
    for (const p of ["77011234567", "8 701 123 45 67", "+7 (701) 123-45-67", "7011234567"]) {
      expect(needsCustomerLink({ customerId: undefined, customerPhone: p })).toBe(true);
    }
  });
});
