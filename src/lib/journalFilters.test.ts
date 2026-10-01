import { describe, it, expect } from "vitest";
import { Timestamp } from "firebase/firestore";
import {
  JOURNAL_QUICK_FILTERS,
  journalCutState,
  journalMaterialOptions,
  matchesQuickFilter,
  materialOrderCounts,
  materialSheetTotals,
  orderUsesMaterial,
  quickFilterCounts,
  journalProgress,
} from "./journalFilters";
import type { Order, OrderMaterialLine } from "../types/domain";

const T = (n: number) => n * 100;

function order(overrides: Partial<Order> = {}): Order {
  return {
    id: "o1",
    orderNumber: "ORD-2026-000001",
    customerName: "Нурик",
    customerPhone: "77011234567",
    materialId: "m1",
    materialSnapshot: {
      name: "ЛДСП Ақ", article: "A-1", color: "Ақ",
      thicknessMm: 16, sheetLengthMm: 2750, sheetWidthMm: 1830, sellingPriceTiyn: T(16000),
    },
    productionStatus: "waiting_payment",
    paymentStatus: "unpaid",
    priority: 0,
    estimatedSheets: 6,
    pvcMetersTotal: 0,
    materialCostTiyn: T(96000), cuttingCostTiyn: 0, pvcCostTiyn: 0, hdfCostTiyn: 0,
    extraServicesTiyn: 0, deliveryCostTiyn: 0, discountTiyn: 0,
    totalTiyn: T(96000), paidTiyn: 0, debtTiyn: T(96000),
    pricePublished: true,
    isDraft: false,
    ...overrides,
  };
}

describe("the Материал filter — «МДФ» shows the orders MDF was cut for", () => {
  const line = (materialId: string, materialName: string, sheetQty: number): OrderMaterialLine => ({
    materialId, materialName, sheetQty, sheetPriceTiyn: T(23500), pvcMeters: 0, pvcPricePerMeterTiyn: 0,
  });
  const cutAt = Timestamp.fromDate(new Date("2026-09-28T12:00:00+05:00"));
  // A merged order: 3 МДФ бізден (cut, the cutter counted 3) and 4 Ақ Томск (still waiting).
  const merged = order({
    id: "o254", orderNumber: "ORD-2026-000254",
    items: [line("mdf", "МДФ бізден", 3), line("ak", "ЛДСП Ақ Томск", 4)],
    lineJobs: [
      { index: 0, materialId: "mdf", materialName: "МДФ бізден", sheetQty: 3, pvcMeters: 0, cuttingCompletedAt: cutAt, confirmedSheets: 3 },
      { index: 1, materialId: "ak", materialName: "ЛДСП Ақ Томск", sheetQty: 4, pvcMeters: 0 },
    ],
  });
  // A single-material order not yet on the saw.
  const single = order({ id: "o290", orderNumber: "ORD-2026-000290", materialId: "mdf", materialSnapshot: { ...order().materialSnapshot, name: "МДФ бізден" }, estimatedSheets: 2 });

  it("matches an order by any of its lines", () => {
    expect(orderUsesMaterial(merged, "mdf")).toBe(true);
    expect(orderUsesMaterial(merged, "ak")).toBe(true);
    expect(orderUsesMaterial(single, "ak")).toBe(false);
  });

  it("counts the material's sheets, and how many the saw has confirmed", () => {
    expect(materialSheetTotals([merged, single], "mdf")).toEqual({ billed: 5, cut: 3 });
    expect(materialSheetTotals([merged, single], "ak")).toEqual({ billed: 4, cut: 0 });
  });

  it("counts each order once per material on its chip, a merged order under every material in it", () => {
    const counts = materialOrderCounts([merged, single]);
    expect(counts.get("mdf")).toBe(2);
    expect(counts.get("ak")).toBe(1);
  });

  it("offers each material once, under the catalogue's name, alphabetically", () => {
    const catalogue = new Map([["ak", { name: "ЛДСП Ақ Томск" }], ["mdf", { name: "МДФ бізден" }]]);
    expect(journalMaterialOptions([single, merged], catalogue)).toEqual([
      { id: "ak", name: "ЛДСП Ақ Томск" },
      { id: "mdf", name: "МДФ бізден" },
    ]);
  });
});

describe("matchesQuickFilter", () => {
  const o = order({ totalTiyn: T(100000) });

  it("counts a row as paid only once the money covers the total", () => {
    expect(matchesQuickFilter(o, T(100000), "paid")).toBe(true);
    expect(matchesQuickFilter(o, T(120000), "paid")).toBe(true); // overpaid is still paid
    expect(matchesQuickFilter(o, T(99999), "paid")).toBe(false);
  });

  it("judges payment on the money, not on the stored paymentStatus", () => {
    // The stored status can be a merge behind the payments ledger — that is the exact bug the
    // rest of this page was fixed for, so the chips must not reintroduce it.
    const stale = order({ totalTiyn: T(100000), paymentStatus: "unpaid" });
    expect(matchesQuickFilter(stale, T(100000), "paid")).toBe(true);
    expect(matchesQuickFilter(stale, T(100000), "debt")).toBe(false);
  });

  it("puts anything still owing under Қарыз", () => {
    expect(matchesQuickFilter(o, 0, "debt")).toBe(true);
    expect(matchesQuickFilter(o, T(40000), "debt")).toBe(true);
    expect(matchesQuickFilter(o, T(100000), "debt")).toBe(false);
  });

  it("never calls a cancelled order a debt", () => {
    const cancelled = order({ totalTiyn: T(100000), productionStatus: "cancelled" });
    expect(matchesQuickFilter(cancelled, 0, "debt")).toBe(false);
  });

  it("does not call a zero-sum row paid — there was nothing to pay", () => {
    expect(matchesQuickFilter(order({ totalTiyn: 0 }), 0, "paid")).toBe(false);
  });

  it("groups the queue and the saw under Распил кезегінде", () => {
    expect(matchesQuickFilter(order({ productionStatus: "cutting_queue" }), 0, "queued")).toBe(true);
    expect(matchesQuickFilter(order({ productionStatus: "cutting_started" }), 0, "queued")).toBe(true);
    expect(matchesQuickFilter(order({ productionStatus: "cutting_completed" }), 0, "queued")).toBe(false);
  });

  it("counts everything past the saw as Кесілді, delivery included", () => {
    for (const s of ["cutting_completed", "pvc_queue", "pvc_started", "pvc_completed", "ready", "delivered"] as const) {
      expect(matchesQuickFilter(order({ productionStatus: s }), 0, "cut"), s).toBe(true);
    }
    expect(matchesQuickFilter(order({ productionStatus: "cutting_started" }), 0, "cut")).toBe(false);
  });

  it("Барлығы takes every row", () => {
    expect(matchesQuickFilter(order({ productionStatus: "cancelled" }), 0, "all")).toBe(true);
  });
});

describe("quickFilterCounts", () => {
  it("counts each chip independently — a row can sit under several", () => {
    const orders = [
      order({ id: "a", totalTiyn: T(100000), productionStatus: "cutting_queue" }),   // debt + queued
      order({ id: "b", totalTiyn: T(50000), productionStatus: "ready" }),            // paid + cut
      order({ id: "c", totalTiyn: T(70000), productionStatus: "waiting_payment" }),  // debt
    ];
    const paid = new Map([["a", 0], ["b", T(50000)], ["c", 0]]);
    const counts = quickFilterCounts(orders, (o) => paid.get(o.id) ?? 0);

    expect(counts.all).toBe(3);
    expect(counts.paid).toBe(1);
    expect(counts.debt).toBe(2);
    expect(counts.queued).toBe(1);
    expect(counts.cut).toBe(1);
  });

  it("reports zero for every chip on an empty ledger", () => {
    const counts = quickFilterCounts([], () => 0);
    for (const { id } of JOURNAL_QUICK_FILTERS) expect(counts[id]).toBe(0);
  });
});

describe("journalProgress — the three dots", () => {
  const at = (status: Order["productionStatus"], paid: number) =>
    journalProgress(order({ totalTiyn: T(100000), productionStatus: status }), paid);

  it("unpaid and untouched: nothing done, payment is what blocks it", () => {
    const [payment, cutting, ready] = at("waiting_payment", 0);
    expect(payment.state).toBe("blocked");
    expect(cutting.state).toBe("todo");
    expect(ready.state).toBe("todo");
  });

  it("part-paid shows payment as under way rather than blocked", () => {
    expect(at("partially_paid", T(40000))[0].state).toBe("active");
  });

  it("paid and queued: money done, saw under way", () => {
    const [payment, cutting] = at("cutting_queue", T(100000));
    expect(payment.state).toBe("done");
    expect(cutting.state).toBe("active");
  });

  it("cut but still edging: cutting done, ready under way", () => {
    const [, cutting, ready] = at("pvc_started", T(100000));
    expect(cutting.state).toBe("done");
    expect(ready.state).toBe("active");
  });

  it("delivered: all three done", () => {
    expect(at("delivered", T(100000)).every((s) => s.state === "done")).toBe(true);
  });

  it("a cancelled order reads as blocked throughout, never as progress", () => {
    expect(at("cancelled", T(100000)).every((s) => s.state === "blocked")).toBe(true);
  });

  it("an order cut on credit still shows the money as outstanding", () => {
    // "Қарызға жіберу" moves the sheets without the money — the row must keep saying so.
    const [payment, cutting] = at("cutting_started", 0);
    expect(payment.state).toBe("blocked");
    expect(cutting.state).toBe("active");
  });
});

describe("journalCutState", () => {
  const at = (s: Order["productionStatus"]) => order({ productionStatus: s });

  it("is green only once the sheets have actually been through the saw", () => {
    for (const s of ["cutting_completed", "pvc_queue", "pvc_started", "pvc_completed",
                     "ready", "delivered"] as const) {
      expect(journalCutState(at(s))).toBe("cut");
    }
  });

  it("counts everything before that as still to do, queued included", () => {
    for (const s of ["submitted", "manager_review", "price_calculated",
                     "waiting_payment", "partially_paid", "paid",
                     "cutting_queue", "cutting_started"] as const) {
      expect(journalCutState(at(s))).toBe("uncut");
    }
  });

  it("keeps a cancelled order out of both colours — it is not work", () => {
    expect(journalCutState(at("cancelled"))).toBe("cancelled");
  });
});
