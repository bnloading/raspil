import { describe, it, expect } from "vitest";
import { needsCustomerLink, planCustomerLinks } from "./customerLink";

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

describe("planCustomerLinks — a customer who registers after their orders were typed", () => {
  const order = (id: string, customerPhone: string, over: Record<string, unknown> = {}) =>
    ({ id, customerPhone, productionStatus: "ready", ...over }) as Parameters<typeof planCustomerLinks>[0][number];

  it("attaches every live order with the account's phone, however the phone was typed", () => {
    const links = planCustomerLinks(
      [order("a", "+7 (777) 514-71-05"), order("b", "87775147105"), order("c", "77011234567")],
      [{ id: "abylai", phone: "77775147105" }],
    );
    expect(links).toEqual([{ orderId: "a", customerId: "abylai" }, { orderId: "b", customerId: "abylai" }]);
  });

  it("leaves alone an order already attached, a struck-off one, and one with no phone", () => {
    const links = planCustomerLinks(
      [order("a", "77775147105", { customerId: "someone" }), order("b", "77775147105", { productionStatus: "cancelled" }), order("c", "")],
      [{ id: "abylai", phone: "77775147105" }],
    );
    expect(links).toEqual([]);
  });

  it("does not guess when two accounts claim one phone", () => {
    const links = planCustomerLinks([order("a", "77775147105")], [{ id: "one", phone: "77775147105" }, { id: "two", phone: "+77775147105" }]);
    expect(links).toEqual([]);
  });
});
