import { describe, it, expect } from "vitest";
import { Timestamp } from "firebase/firestore";
import {
  computeJournalRowTotals,
  netPaidTiyn,
  paidByMethod,
  groupPaymentsByOrder,
  computeCustomerDebts,
  materialSummary,
  type JournalRowInput,
  type JournalLineInput,
  customerDebtKey,
} from "./journal";
import type { Order, Payment } from "../types/domain";

const T = (n: number) => n * 100; // ₸ → tiyn

/**
 * A single-material row, the common case: the four line fields are spelled flat here so each test
 * reads as one journal line. `lines` builds a multi-material (merged) row instead.
 */
type FlatRow = Omit<JournalRowInput, "lines"> & JournalLineInput;

function row(overrides: Partial<FlatRow> = {}): JournalRowInput {
  const f: FlatRow = {
    sheetQty: 0,
    sheetPriceTiyn: 0,
    pvcMeters: 0,
    pvcPricePerMeterTiyn: 0,
    hdfCostTiyn: 0,
    cuttingCostTiyn: 0,
    extraServicesTiyn: 0,
    deliveryCostTiyn: 0,
    discountTiyn: 0,
    paidTiyn: 0,
    ...overrides,
  };
  return {
    lines: [{
      sheetQty: f.sheetQty,
      sheetPriceTiyn: f.sheetPriceTiyn,
      pvcMeters: f.pvcMeters,
      pvcPricePerMeterTiyn: f.pvcPricePerMeterTiyn,
    }],
    hdfCostTiyn: f.hdfCostTiyn,
    cuttingCostTiyn: f.cuttingCostTiyn,
    extraServicesTiyn: f.extraServicesTiyn,
    deliveryCostTiyn: f.deliveryCostTiyn,
    discountTiyn: f.discountTiyn,
    paidTiyn: f.paidTiyn,
  };
}

function payment(overrides: Partial<Payment> = {}): Payment {
  return {
    id: "p1",
    orderId: "o1",
    amountTiyn: 0,
    methodId: "cash",
    methodName: "Нал / Қолма-қол",
    paymentDate: Timestamp.fromMillis(0),
    recordedByUid: "u1",
    recordedByName: "Manager",
    reversed: false,
    ...overrides,
  };
}

function order(overrides: Partial<Order> = {}): Order {
  return {
    id: "o1",
    orderNumber: "ORD-2026-000001",
    customerName: "Алмат",
    customerPhone: "77001112233",
    materialId: "m1",
    materialSnapshot: {
      name: "ЛДСП Ақ",
      article: "A-1",
      color: "Ақ",
      thicknessMm: 16,
      sheetLengthMm: 2800,
      sheetWidthMm: 2070,
      sellingPriceTiyn: T(16200),
    },
    productionStatus: "waiting_payment",
    paymentStatus: "unpaid",
    priority: 0,
    estimatedSheets: 1,
    pvcMetersTotal: 0,
    materialCostTiyn: 0,
    cuttingCostTiyn: 0,
    pvcCostTiyn: 0,
    hdfCostTiyn: 0,
    extraServicesTiyn: 0,
    deliveryCostTiyn: 0,
    discountTiyn: 0,
    totalTiyn: 0,
    paidTiyn: 0,
    debtTiyn: 0,
    pricePublished: true,
    isDraft: false,
    ...overrides,
  };
}

describe("computeJournalRowTotals — journal row arithmetic", () => {
  it("sheet total = quantity × unit price", () => {
    const t = computeJournalRowTotals(row({ sheetQty: 6, sheetPriceTiyn: T(16200) }));
    expect(t.materialCostTiyn).toBe(T(97200));
    expect(t.totalTiyn).toBe(T(97200));
  });

  it("PVC total = metres × price per metre", () => {
    const t = computeJournalRowTotals(row({ pvcMeters: 69, pvcPricePerMeterTiyn: T(200) }));
    expect(t.pvcCostTiyn).toBe(T(13800));
  });

  it("reproduces the reference journal row: 6 лист × 16 000 ₸ + 69 м × 200 ₸ = 109 800 ₸", () => {
    const t = computeJournalRowTotals(
      row({ sheetQty: 6, sheetPriceTiyn: T(16000), pvcMeters: 69, pvcPricePerMeterTiyn: T(200) }),
    );
    expect(t.materialCostTiyn).toBe(T(96000));
    expect(t.pvcCostTiyn).toBe(T(13800));
    expect(t.totalTiyn).toBe(T(109800));
  });

  it("adds HDF, countertop/extra services, cutting and delivery, then subtracts the discount", () => {
    const t = computeJournalRowTotals(
      row({
        sheetQty: 6,
        sheetPriceTiyn: T(16200),
        pvcMeters: 89,
        pvcPricePerMeterTiyn: T(200),
        hdfCostTiyn: T(15000),
        cuttingCostTiyn: T(50000),
        extraServicesTiyn: T(8000),
        deliveryCostTiyn: T(5000),
        discountTiyn: T(3000),
      }),
    );
    // 97 200 + 17 800 + 15 000 + 50 000 + 8 000 + 5 000 − 3 000
    expect(t.totalTiyn).toBe(T(190000));
  });

  it("never returns a negative total when the discount exceeds everything else", () => {
    const t = computeJournalRowTotals(row({ sheetQty: 1, sheetPriceTiyn: T(1000), discountTiyn: T(999999) }));
    expect(t.totalTiyn).toBe(0);
  });

  it("rounds fractional PVC metres to whole tiyn rather than carrying float dust", () => {
    const t = computeJournalRowTotals(row({ pvcMeters: 10.5, pvcPricePerMeterTiyn: T(220) }));
    expect(t.pvcCostTiyn).toBe(T(2310));
    expect(Number.isInteger(t.pvcCostTiyn)).toBe(true);
  });

  it("derives debt and payment status from the paid amount", () => {
    const base = { sheetQty: 1, sheetPriceTiyn: T(100000) };
    expect(computeJournalRowTotals(row({ ...base, paidTiyn: 0 })).paymentStatus).toBe("unpaid");
    expect(computeJournalRowTotals(row({ ...base, paidTiyn: T(40000) })).paymentStatus).toBe("partial");
    expect(computeJournalRowTotals(row({ ...base, paidTiyn: T(100000) })).paymentStatus).toBe("paid");
    expect(computeJournalRowTotals(row({ ...base, paidTiyn: T(120000) })).paymentStatus).toBe("overpaid");
  });

  it("reports debt as total − paid, including a negative balance when overpaid", () => {
    expect(computeJournalRowTotals(row({ sheetQty: 1, sheetPriceTiyn: T(100000), paidTiyn: T(30000) })).debtTiyn).toBe(
      T(70000),
    );
    expect(computeJournalRowTotals(row({ sheetQty: 1, sheetPriceTiyn: T(100000), paidTiyn: T(120000) })).debtTiyn).toBe(
      T(-20000),
    );
  });
});

describe("computeJournalRowTotals — a merged row is priced line by line", () => {
  // The bug this replaces: a merged order was priced as (13 sheets × the FIRST line's 16 000 ₸),
  // so folding a 7 500 ₸ ХДФ row into an ЛДСП row silently repriced the ХДФ at ЛДСП money the
  // moment anyone typed in the ledger.
  const merged: JournalRowInput = {
    lines: [
      { sheetQty: 6, sheetPriceTiyn: T(16000), pvcMeters: 92, pvcPricePerMeterTiyn: T(200) },
      { sheetQty: 2, sheetPriceTiyn: T(7500), pvcMeters: 0, pvcPricePerMeterTiyn: 0 },
    ],
    hdfCostTiyn: 0,
    cuttingCostTiyn: 0,
    extraServicesTiyn: 0,
    deliveryCostTiyn: 0,
    discountTiyn: 0,
    paidTiyn: 0,
  };

  it("charges each line at its own price instead of the first line's", () => {
    const t = computeJournalRowTotals(merged);
    expect(t.materialCostTiyn).toBe(T(96000) + T(15000));
    expect(t.pvcCostTiyn).toBe(T(18400));
    expect(t.totalTiyn).toBe(T(129400));
  });

  it("reports each line's own money, so a sub-row can show it", () => {
    const t = computeJournalRowTotals(merged);
    expect(t.lineTotals).toHaveLength(2);
    expect(t.lineTotals[0]).toEqual({ materialCostTiyn: T(96000), pvcCostTiyn: T(18400), lineTotalTiyn: T(114400) });
    expect(t.lineTotals[1]).toEqual({ materialCostTiyn: T(15000), pvcCostTiyn: 0, lineTotalTiyn: T(15000) });
  });

  it("settles to zero debt when the paid sum covers every line", () => {
    const t = computeJournalRowTotals({ ...merged, paidTiyn: T(129400) });
    expect(t.debtTiyn).toBe(0);
    expect(t.paymentStatus).toBe("paid");
  });

  it("a row with no lines at all is worth nothing rather than throwing", () => {
    const t = computeJournalRowTotals({ ...merged, lines: [] });
    expect(t.totalTiyn).toBe(0);
    expect(t.lineTotals).toEqual([]);
  });
});

describe("mixed payments (Аралас)", () => {
  const legs = [
    payment({ id: "a", methodId: "cash", amountTiyn: T(50000), groupId: "g1" }),
    payment({ id: "b", methodId: "kaspi", amountTiyn: T(100000), groupId: "g1" }),
    payment({ id: "c", methodId: "nur", amountTiyn: T(98500), groupId: "g1" }),
  ];

  it("sums every leg of a mixed payment into one paid total", () => {
    expect(netPaidTiyn(legs)).toBe(T(248500));
  });

  it("splits the paid amount back out per method for the journal's method columns", () => {
    const byMethod = paidByMethod(legs);
    expect(byMethod.get("cash")).toBe(T(50000));
    expect(byMethod.get("kaspi")).toBe(T(100000));
    expect(byMethod.get("nur")).toBe(T(98500));
    expect(byMethod.get("pay")).toBeUndefined();
  });

  it("a mixed payment settles the order exactly when the legs sum to the total", () => {
    const t = computeJournalRowTotals(row({ sheetQty: 1, sheetPriceTiyn: T(248500), paidTiyn: netPaidTiyn(legs) }));
    expect(t.paymentStatus).toBe("paid");
    expect(t.debtTiyn).toBe(0);
  });

  it("excludes a reversed leg and recalculates the status automatically", () => {
    const reversed = [legs[0], { ...legs[1], reversed: true }, legs[2]];
    expect(netPaidTiyn(reversed)).toBe(T(148500));
    expect(paidByMethod(reversed).get("kaspi")).toBeUndefined();
    const t = computeJournalRowTotals(row({ sheetQty: 1, sheetPriceTiyn: T(248500), paidTiyn: netPaidTiyn(reversed) }));
    expect(t.paymentStatus).toBe("partial");
    expect(t.debtTiyn).toBe(T(100000));
  });
});

describe("groupPaymentsByOrder", () => {
  it("buckets payments by their order so the journal needs one query, not one per row", () => {
    const grouped = groupPaymentsByOrder([
      payment({ id: "a", orderId: "o1", amountTiyn: T(100) }),
      payment({ id: "b", orderId: "o2", amountTiyn: T(200) }),
      payment({ id: "c", orderId: "o1", amountTiyn: T(300) }),
    ]);
    expect(grouped.get("o1")).toHaveLength(2);
    expect(grouped.get("o2")).toHaveLength(1);
    expect(netPaidTiyn(grouped.get("o1")!)).toBe(T(400));
  });
});

describe("computeCustomerDebts — debt matches every unpaid order", () => {
  it("sums one customer's outstanding balances across orders", () => {
    const debts = computeCustomerDebts([
      order({ id: "o1", customerId: "c1", totalTiyn: T(100000), paidTiyn: T(40000) }),
      order({ id: "o2", customerId: "c1", totalTiyn: T(50000), paidTiyn: 0 }),
      order({ id: "o3", customerId: "c1", totalTiyn: T(30000), paidTiyn: T(30000) }),
    ]);
    expect(debts).toHaveLength(1);
    expect(debts[0].orderTotalTiyn).toBe(T(180000));
    expect(debts[0].paidTiyn).toBe(T(70000));
    expect(debts[0].debtTiyn).toBe(T(110000));
    expect(debts[0].unpaidOrderCount).toBe(2);
  });

  it("keeps separate customers separate and sorts by who owes most", () => {
    const debts = computeCustomerDebts([
      order({ id: "o1", customerId: "c1", customerName: "A", totalTiyn: T(10000), paidTiyn: 0 }),
      order({ id: "o2", customerId: "c2", customerName: "B", totalTiyn: T(90000), paidTiyn: 0 }),
    ]);
    expect(debts.map((d) => d.customerName)).toEqual(["B", "A"]);
  });

  it("excludes cancelled and draft orders from debt", () => {
    const debts = computeCustomerDebts([
      order({ id: "o1", customerId: "c1", totalTiyn: T(100000), paidTiyn: 0, productionStatus: "cancelled" }),
      order({ id: "o2", customerId: "c1", totalTiyn: T(70000), paidTiyn: 0, productionStatus: "draft" }),
      order({ id: "o3", customerId: "c1", totalTiyn: T(20000), paidTiyn: 0 }),
    ]);
    expect(debts[0].debtTiyn).toBe(T(20000));
    expect(debts[0].unpaidOrderCount).toBe(1);
  });

  it("does not let an overpaid order cancel out another order's real debt", () => {
    const debts = computeCustomerDebts([
      order({ id: "o1", customerId: "c1", totalTiyn: T(10000), paidTiyn: T(50000) }), // overpaid by 40 000
      order({ id: "o2", customerId: "c1", totalTiyn: T(30000), paidTiyn: 0 }),
    ]);
    expect(debts[0].debtTiyn).toBe(T(30000));
  });

  it("groups a walk-in order (no account) with the same customer's phone number", () => {
    const debts = computeCustomerDebts([
      order({ id: "o1", customerId: undefined, customerPhone: "77001112233", totalTiyn: T(10000), paidTiyn: 0 }),
      order({ id: "o2", customerId: undefined, customerPhone: "77001112233", totalTiyn: T(20000), paidTiyn: 0 }),
    ]);
    expect(debts).toHaveLength(1);
    expect(debts[0].debtTiyn).toBe(T(30000));
  });

  it("reports the oldest unpaid order's date", () => {
    const debts = computeCustomerDebts([
      order({ id: "o1", customerId: "c1", totalTiyn: T(10000), paidTiyn: 0, createdAt: Timestamp.fromMillis(5000) }),
      order({ id: "o2", customerId: "c1", totalTiyn: T(10000), paidTiyn: 0, createdAt: Timestamp.fromMillis(1000) }),
      // Fully paid and older — must not become the "oldest debt".
      order({ id: "o3", customerId: "c1", totalTiyn: T(10000), paidTiyn: T(10000), createdAt: Timestamp.fromMillis(1) }),
    ]);
    expect(debts[0].oldestDebtAtMs).toBe(1000);
  });

  it("a customer's debt card total equals the sum of their per-order debts", () => {
    const orders = [
      order({ id: "o1", customerId: "c1", totalTiyn: T(200000), paidTiyn: T(120000) }),
      order({ id: "o2", customerId: "c1", totalTiyn: T(150000), paidTiyn: T(0) }),
      order({ id: "o3", customerId: "c1", totalTiyn: T(80000), paidTiyn: T(75000) }),
    ];
    const perOrder = orders.reduce((s, o) => s + Math.max(0, o.totalTiyn - o.paidTiyn), 0);
    expect(computeCustomerDebts(orders)[0].debtTiyn).toBe(perOrder);
  });
});

describe("materialSummary", () => {
  it("shows sheets and PVC metres compactly", () => {
    expect(materialSummary(order({ estimatedSheets: 6, pvcMetersTotal: 89 }))).toBe("6 лист · 89 м ПВХ");
  });
  it("prefers the confirmed sheet count once cutting has confirmed it", () => {
    expect(materialSummary(order({ estimatedSheets: 6, confirmedSheets: 7, pvcMetersTotal: 0 }))).toBe("7 лист");
  });
  it("falls back to a dash when there is nothing to summarize", () => {
    expect(materialSummary(order({ estimatedSheets: 0, pvcMetersTotal: 0 }))).toBe("—");
  });
});

describe("customerDebtKey", () => {
  const o = (over: Partial<Order>) => order({ customerId: undefined, customerPhone: "", ...over });

  it("prefers the account when the customer has one", () => {
    expect(customerDebtKey(o({ customerId: "uid-1", customerPhone: "77011234567" }))).toBe("uid-1");
  });

  it("treats one phone written three ways as one customer", () => {
    const a = customerDebtKey(o({ customerPhone: "+7 (701) 123-45-67" }));
    const b = customerDebtKey(o({ customerPhone: "87011234567" }));
    const c = customerDebtKey(o({ customerPhone: "77011234567" }));
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("falls back to the name when there is no phone at all", () => {
    // The journal's own rows mostly have none, and without this every one of them shared a key.
    expect(customerDebtKey(o({ customerName: "Бахытжан" }))).toBe("name:бахытжан");
    expect(customerDebtKey(o({ customerName: " БАХЫТЖАН " }))).toBe("name:бахытжан");
  });

  it("keeps two phoneless customers apart", () => {
    expect(customerDebtKey(o({ customerName: "Бахытжан" })))
      .not.toBe(customerDebtKey(o({ customerName: "Ерлан" })));
  });
});

describe("computeCustomerDebts — walk-ins with no phone", () => {
  const walkIn = (name: string, totalTiyn: number) =>
    order({ id: name, customerId: undefined, customerPhone: "", customerName: name, totalTiyn, paidTiyn: 0 });

  it("gives each phoneless customer their own row", () => {
    // Before: all three shared the key "phone:" and appeared as one row under the first name,
    // carrying the sum of everybody's debt.
    const debts = computeCustomerDebts([
      walkIn("Бахытжан", 234440_00),
      walkIn("Ерлан", 15000_00),
      walkIn("Рустем", 30000_00),
    ]);
    expect(debts).toHaveLength(3);
    expect(debts.map((d) => d.customerName)).toEqual(["Бахытжан", "Рустем", "Ерлан"]);
    expect(debts[0].debtTiyn).toBe(234440_00);
  });

  it("still rolls one customer's several orders into one row", () => {
    const debts = computeCustomerDebts([walkIn("Бахытжан", 100_00), walkIn("Бахытжан", 50_00)]);
    expect(debts).toHaveLength(1);
    expect(debts[0].debtTiyn).toBe(150_00);
    expect(debts[0].unpaidOrderCount).toBe(2);
  });
});
