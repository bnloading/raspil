import { describe, it, expect } from "vitest";
import type { Timestamp } from "firebase/firestore";
import type { InventoryMovement, Order } from "../types/domain";
import { cutStateOf, ledgerTotals, materialLedger } from "./materialLedger";

const at = (iso: string) => ({ seconds: Math.floor(Date.parse(iso) / 1000), nanoseconds: 0 }) as unknown as Timestamp;
let seq = 0;
const mv = (over: Partial<InventoryMovement>): InventoryMovement => ({
  id: `m${++seq}`, materialId: "kash", type: "cutting_consumption", qty: -4, orderId: "o663", userId: "n", userName: "Нур",
  comment: "ORD-2026-000663 распил кезегіне қосылды", balanceBefore: 10, balanceAfter: 6,
  createdAt: at("2026-11-03T16:28:00+05:00"), ...over,
});
const order = (over: Partial<Order>): Order => ({
  id: "o663", orderNumber: "ORD-2026-000663", customerName: "Нурик", productionStatus: "pvc_queue", materialId: "kash",
  lineJobs: [
    { index: 0, materialId: "kash", materialName: "ЛДСП Кашемир", sheetQty: 4, pvcMeters: 0, consumedQty: 4 },
    { index: 1, materialId: "hdf", materialName: "ХДФ", sheetQty: 2, pvcMeters: 0, consumedQty: 2 },
  ],
  ...over,
}) as Order;
const cut = { cuttingStartedAt: at("2026-11-03T18:40:00+05:00"), cuttingCompletedAt: at("2026-11-03T19:16:00+05:00"), cuttingByName: "Олжас", confirmedSheets: 4 };

describe("cutStateOf — what became of the sheets taken out for an order", () => {
  it("cut on the saw: by whom, when and how many — this material's line, not the ХДФ one", () => {
    const o = order({ lineJobs: [{ ...order({}).lineJobs![0], ...cut }, order({}).lineJobs![1]] });
    expect(cutStateOf(mv({}), o)).toEqual({ state: "done", byName: "Олжас", atMs: Date.parse("2026-11-03T19:16:00+05:00"), sheets: 4 });
  });

  it("on the saw now, waiting in the queue, or handed over whole", () => {
    const started = order({ lineJobs: [{ ...order({}).lineJobs![0], cuttingStartedAt: cut.cuttingStartedAt, cuttingByName: "Олжас" }] });
    expect(cutStateOf(mv({}), started)).toEqual({ state: "cutting", byName: "Олжас" });
    expect(cutStateOf(mv({}), order({}))).toEqual({ state: "queued" });
    expect(cutStateOf(mv({ withoutCutting: true }), order({}))).toEqual({ state: "without" });
  });

  it("an order struck off before the saw, or merged into another", () => {
    expect(cutStateOf(mv({}), order({ productionStatus: "cancelled" }))).toEqual({ state: "cancelled", merged: false });
    expect(cutStateOf(mv({}), order({ mergedIntoOrderId: "o700" }))).toEqual({ state: "cancelled", merged: true });
    expect(cutStateOf(mv({}), undefined)).toEqual({ state: "unknown" });
  });

  it("an order older than line jobs reads the order's own cut", () => {
    const old = order({ lineJobs: undefined, confirmedSheets: 5, cuttingCompletedAt: cut.cuttingCompletedAt, assignedCutterName: "Сүндет" });
    expect(cutStateOf(mv({}), old)).toMatchObject({ state: "done", byName: "Сүндет", sheets: 5 });
  });
});

describe("materialLedger — one material's «Тарих»", () => {
  it("names the order and the customer on a cut, newest first, and keeps the stock before and after", () => {
    const list = materialLedger([
      mv({ id: "cut" }),
      mv({ id: "in", type: "receipt", qty: 38, orderId: undefined, userName: "Ербол", comment: "Жеткізушіден қабылданды",
        balanceBefore: 6, balanceAfter: 44, createdAt: at("2026-11-03T16:30:00+05:00") }),
    ], [order({})]);
    expect(list.map((e) => [e.id, e.kind, e.qty, e.balanceBefore, e.balanceAfter])).toEqual([["in", "receipt", 38, 6, 44], ["cut", "cut", -4, 10, 6]]);
    expect(list[1].order).toEqual({ id: "o663", code: "№663", customerName: "Нурик" });
    expect(list[1].cut).toEqual({ state: "queued" });
    expect(list[0].note).toBe("");
  });

  it("keeps what someone typed and the stock that ran short, drops the app's own lines", () => {
    const [short, fixed, back] = materialLedger([
      mv({ id: "short", comment: "ORD-2026-000663 распил кезегіне қосылды — қоймада 2 лист жетіспеді", createdAt: at("2026-11-03T12:00:00+05:00") }),
      mv({ id: "fixed", type: "manual_correction", qty: -80, orderId: undefined, comment: "артық қосылған", createdAt: at("2026-11-03T11:00:00+05:00") }),
      mv({ id: "back", type: "return", qty: 4, comment: "ORD-2026-000663 бас тартылды — қоймаға қайтарылды", createdAt: at("2026-11-03T10:00:00+05:00") }),
    ], [order({})]);
    expect([short.shortBy, short.note]).toEqual([2, ""]);
    expect([fixed.kind, fixed.note]).toEqual(["correction", "артық қосылған"]);
    expect([back.kind, back.note, back.order?.code]).toEqual(["return", "Заказ өшірілді", "№663"]);
  });

  it("adds up what came in and what went to the saw", () => {
    const list = materialLedger([
      mv({ qty: -4 }), mv({ qty: -11 }), mv({ type: "receipt", qty: 38, orderId: undefined }), mv({ type: "return", qty: 1 }),
    ], [order({})]);
    expect(ledgerTotals(list)).toEqual({ received: 38, cut: 15 });
  });
});
