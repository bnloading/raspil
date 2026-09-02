import { describe, it, expect } from "vitest";
import { Timestamp } from "firebase/firestore";
import {
  customerDirectory,
  customerKeyOf,
  isExactly,
  suggestCustomers,
  type CustomerSuggestion,
} from "./customerSuggest";
import type { Order } from "../types/domain";

const at = (seconds: number) => Timestamp.fromMillis(seconds * 1000);

function order(name: string, phone: string, seconds: number): Order {
  return {
    id: `${name}-${seconds}`,
    orderNumber: "ORD-2026-000001",
    customerName: name,
    customerPhone: phone,
    createdAt: at(seconds),
    materialId: "m1",
    materialSnapshot: {
      name: "ЛДСП Ақ", article: "A-1", color: "Ақ",
      thicknessMm: 16, sheetLengthMm: 2750, sheetWidthMm: 1830, sellingPriceTiyn: 1600000,
    },
    productionStatus: "waiting_payment",
    paymentStatus: "unpaid",
    priority: 0,
    estimatedSheets: 0,
    pvcMetersTotal: 0,
    materialCostTiyn: 0, cuttingCostTiyn: 0, pvcCostTiyn: 0, hdfCostTiyn: 0,
    extraServicesTiyn: 0, deliveryCostTiyn: 0, discountTiyn: 0,
    totalTiyn: 0, paidTiyn: 0, debtTiyn: 0,
    pricePublished: true,
    isDraft: false,
  };
}

const person = (o: Partial<CustomerSuggestion> = {}): CustomerSuggestion => ({
  name: "Нурик",
  phone: "77011234567",
  orderCount: 1,
  lastOrderSeconds: 0,
  ...o,
});

describe("customerKeyOf", () => {
  it("treats one phone as one customer however the number was typed", () => {
    expect(customerKeyOf("Нурик", "+7 (701) 123-45-67")).toBe(customerKeyOf("нурик", "87011234567"));
  });

  it("falls back to the name when no phone was recorded", () => {
    expect(customerKeyOf("  Ерлан ", "")).toBe(customerKeyOf("ерлан", ""));
  });

  it("keeps two people apart when they share a name but not a number", () => {
    expect(customerKeyOf("Ерлан", "77011111111")).not.toBe(customerKeyOf("Ерлан", "77022222222"));
  });
});

describe("customerDirectory", () => {
  it("collapses three spellings of one phone into one customer", () => {
    const dir = customerDirectory([
      order("нурик", "77011234567", 100),
      order("Нурик", "8 701 123 45 67", 300),
      order("НУРИК", "+7 701 123 45 67", 200),
    ]);
    expect(dir).toHaveLength(1);
    expect(dir[0].orderCount).toBe(3);
  });

  it("keeps the newest spelling, so a corrected name carries forward", () => {
    const dir = customerDirectory([
      order("нурик", "77011234567", 100),
      order("Нұрик Мұратұлы", "77011234567", 500),
    ]);
    expect(dir[0].name).toBe("Нұрик Мұратұлы");
  });

  it("does not let a later row typed without a phone erase the number", () => {
    const dir = customerDirectory([
      order("Нурик", "77011234567", 100),
      order("Нурик", "", 500),
    ]);
    // Two keys — one phone-keyed, one name-keyed — and the phone-keyed one keeps its number.
    expect(dir.find((c) => c.phone === "77011234567")).toBeDefined();
  });

  it("backfills a number onto a customer first seen without one", () => {
    const dir = customerDirectory([order("Ерлан", "", 500), order("Ерлан", "", 100)]);
    expect(dir).toHaveLength(1);
    expect(dir[0].phone).toBe("");
  });

  it("ignores rows with no name at all", () => {
    expect(customerDirectory([order("   ", "77011234567", 100)])).toEqual([]);
  });
});

describe("suggestCustomers", () => {
  const dir: CustomerSuggestion[] = [
    person({ name: "Нурик", phone: "77011234567", lastOrderSeconds: 500, orderCount: 9 }),
    person({ name: "Нурсултан", phone: "77012223344", lastOrderSeconds: 900, orderCount: 2 }),
    person({ name: "Заказ Цех", phone: "77775553344", lastOrderSeconds: 100, orderCount: 4 }),
    person({ name: "Ерлан", phone: "77778889900", lastOrderSeconds: 800, orderCount: 1 }),
  ];

  it("offers nothing for an empty box", () => {
    expect(suggestCustomers(dir, "")).toEqual([]);
    expect(suggestCustomers(dir, "   ")).toEqual([]);
  });

  it("puts prefix matches first, most recent of them at the top", () => {
    expect(suggestCustomers(dir, "нур").map((c) => c.name)).toEqual(["Нурсултан", "Нурик"]);
  });

  it("is case-insensitive", () => {
    expect(suggestCustomers(dir, "ЕРЛ").map((c) => c.name)).toEqual(["Ерлан"]);
  });

  it("finds a customer by the distinguishing word, not just the first one", () => {
    expect(suggestCustomers(dir, "цех").map((c) => c.name)).toEqual(["Заказ Цех"]);
  });

  it("ranks a name prefix above a word prefix above a mid-word match", () => {
    const names = suggestCustomers(
      [
        person({ name: "Ақжол", lastOrderSeconds: 1 }),
        person({ name: "Цех Ақ", phone: "1", lastOrderSeconds: 2 }),
        person({ name: "Заказақ", phone: "2", lastOrderSeconds: 3 }),
      ],
      "ақ",
    ).map((c) => c.name);
    expect(names).toEqual(["Ақжол", "Цех Ақ", "Заказақ"]);
  });

  it("searches the phone once enough digits are typed", () => {
    expect(suggestCustomers(dir, "5553").map((c) => c.name)).toEqual(["Заказ Цех"]);
  });

  it("does not treat a single digit as a phone search", () => {
    expect(suggestCustomers(dir, "7")).toEqual([]);
  });

  it("caps the list so it cannot cover the rows below", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      person({ name: `Клиент ${i}`, phone: String(i), lastOrderSeconds: i }),
    );
    expect(suggestCustomers(many, "клиент")).toHaveLength(6);
    expect(suggestCustomers(many, "клиент", 3)).toHaveLength(3);
  });
});

describe("isExactly", () => {
  it("knows when there is nothing left to complete", () => {
    expect(isExactly(person({ name: "Нурик" }), " нурик ")).toBe(true);
    expect(isExactly(person({ name: "Нурик" }), "нур")).toBe(false);
  });
});
