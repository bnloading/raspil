import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Firestore } from "firebase/firestore";
import type { Order, UserDoc } from "../types/domain";

// A one-process stand-in for Firestore: documents in a map, a transaction that reads from it and
// applies its writes straight back, and every write kept in order so a test can read the ledger.
type Data = Record<string, unknown>;
const store = new Map<string, Data>();
const writes: { op: "set" | "update"; path: string; data: Data }[] = [];
let autoId = 0;

vi.mock("firebase/firestore", () => ({
  collection: (_db: unknown, name: string) => ({ collection: name }),
  doc: (parent: { collection?: string }, ...segments: string[]) =>
    parent.collection ? { path: `${parent.collection}/auto-${++autoId}` } : { path: segments.join("/") },
  serverTimestamp: () => "SERVER_TIME",
  Timestamp: { now: () => "NOW", fromDate: (d: Date) => d },
  runTransaction: async (_db: unknown, fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      get: async (ref: { path: string }) => ({ exists: () => store.has(ref.path), data: () => store.get(ref.path) }),
      set: (ref: { path: string }, data: Data) => {
        writes.push({ op: "set", path: ref.path, data });
        store.set(ref.path, data);
      },
      update: (ref: { path: string }, data: Data) => {
        writes.push({ op: "update", path: ref.path, data });
        store.set(ref.path, { ...store.get(ref.path), ...data });
      },
    }),
}));

const { consumeStockOnQueue } = await import("./warehouse");

const db = {} as Firestore;
const actor = { user: { uid: "mgr-1" }, userData: { name: "Менеджер" } } as unknown as { user: import("firebase/auth").User; userData: UserDoc };

/** №509 as it stands: five МДФ бізден sheets bought whole, paid, never sent to the saw. */
function seedOrder(over: Partial<Order> = {}) {
  store.set("orders/o509", {
    orderNumber: "ORD-2026-000509",
    productionStatus: "paid",
    paymentStatus: "paid",
    items: [
      { materialId: "mdf-bizden", materialName: "МДФ бізден", sheetQty: 5, sheetPriceTiyn: 2350000, pvcMeters: 0, pvcPricePerMeterTiyn: 0 },
      { materialId: "external", materialName: "Сырттан келетін лист", sheetQty: 2, sheetPriceTiyn: 0, pvcMeters: 0, pvcPricePerMeterTiyn: 0 },
    ],
    ...over,
  });
}

const takeWhole = () =>
  consumeStockOnQueue(db, actor, { orderId: "o509", orderNumber: "ORD-2026-000509", jobs: [], withoutCutting: true });

beforeEach(() => {
  store.clear();
  writes.length = 0;
  autoId = 0;
  store.set("materials/mdf-bizden", { name: "МДФ бізден", qtyOnHand: 54 });
  store.set("materials/external", { name: "Сырттан келетін лист", qtyOnHand: 0, stockTracked: false });
});

describe("consumeStockOnQueue — «Қоймадан шегеру · распилсіз»", () => {
  it("takes the shop's own sheets off the rack and puts the order straight at Дайын", async () => {
    seedOrder();
    const result = await takeWhole();

    expect(result.consumed).toBe(5);
    expect(store.get("materials/mdf-bizden")?.qtyOnHand).toBe(49);
    const order = store.get("orders/o509")!;
    expect(order).toMatchObject({ productionStatus: "ready", withoutCutting: true, cuttingConsumedQty: 5 });
    // Never queued: nothing for the cutter to pick up, and no line is marked cut.
    expect(order.cuttingQueuedAt).toBeUndefined();
    expect((order.lineJobs as { cuttingCompletedAt?: unknown }[]).every((j) => !j.cuttingCompletedAt)).toBe(true);
  });

  it("writes a ledger entry that says no saw was involved, so the «кесілген» counts can leave it out", async () => {
    seedOrder();
    await takeWhole();

    const movements = writes.filter((w) => w.path.startsWith("inventoryMovements/"));
    expect(movements).toHaveLength(1); // the customer's own board moves nothing
    expect(movements[0].data).toMatchObject({
      materialId: "mdf-bizden", type: "cutting_consumption", qty: -5, withoutCutting: true,
      comment: "ORD-2026-000509 распилсіз берілді", balanceBefore: 54, balanceAfter: 49,
    });
  });

  it("does nothing the second time, so a double click never takes the sheets twice", async () => {
    seedOrder();
    await takeWhole();
    const before = writes.length;

    const again = await takeWhole();
    expect(again).toMatchObject({ consumed: 0, alreadyQueued: true });
    expect(writes).toHaveLength(before);
    expect(store.get("materials/mdf-bizden")?.qtyOnHand).toBe(49);
  });

  it("refuses an order that has meanwhile gone to the saw", async () => {
    seedOrder({ productionStatus: "cutting_queue" });
    await expect(takeWhole()).rejects.toThrow("Заказ күйі өзгерді");
    expect(store.get("materials/mdf-bizden")?.qtyOnHand).toBe(54);
  });

  it("works for an unpaid order too — handing sheets over on credit is the manager's call", async () => {
    seedOrder({ productionStatus: "waiting_payment", paymentStatus: "unpaid" });
    const result = await takeWhole();
    expect(result.consumed).toBe(5);
    expect(store.get("orders/o509")?.productionStatus).toBe("ready");
  });

  it("names a shortfall in the ledger, as a queued order does", async () => {
    store.set("materials/mdf-bizden", { name: "МДФ бізден", qtyOnHand: 3 });
    seedOrder();
    await takeWhole();
    const movement = writes.find((w) => w.path.startsWith("inventoryMovements/"))!;
    expect(movement.data.comment).toBe("ORD-2026-000509 распилсіз берілді — қоймада 2 лист жетіспеді");
    expect(store.get("materials/mdf-bizden")?.qtyOnHand).toBe(-2);
  });
});
