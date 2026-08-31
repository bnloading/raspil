import { readFileSync } from "node:fs";
import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, doc, getDoc, getDocs, query, setDoc, where, type Firestore } from "firebase/firestore";
import type { User } from "firebase/auth";

import { createJournalOrder, draftFromOrder, saveJournalRow, type JournalDraft } from "../src/lib/journalOrders";
import { computeJournalRowTotals, netPaidTiyn } from "../src/lib/journal";
import { recordPayment } from "../src/lib/payments";
import {
  enterCuttingQueue,
  startCuttingLine,
  completeCuttingLine,
  startPvcLine,
  completePvcLine,
  markDelivered,
} from "../src/lib/orderStatus";
import { jobsOf, allCuttingDone, allPvcDone } from "../src/lib/orderLines";
import { canEnterCuttingQueue } from "../src/lib/statuses";
import { computeCashbox } from "../src/lib/cashbox";
import { computePvcUsage } from "../src/lib/pvcUsage";
import type { Material, Order, Payment, PaymentMethodDef, PvcType, UserDoc } from "../src/types/domain";

/**
 * The whole walk-in lifecycle, end to end, against the emulator with the real security rules on.
 *
 * "Журналға заказ толтыр, распилшик болып көр, бастау бас, дайын дегені дұрыс па" — every step is
 * driven through the same functions the screens call, as the same roles the screens run as, and
 * every number is checked after each step: the money, the sheet counts, the warehouse, the ПВХ
 * roll, and the stage the order is at. If a Manager, cutter or PVC worker lacks a permission the
 * real app needs, this fails here rather than in the shop.
 */

let testEnv: RulesTestEnvironment;

const MANAGER_UID = "manager-1";
const CUTTER_UID = "cutter-1";
const PVC_UID = "pvc-1";

const T = (tenge: number) => tenge * 100;

const MATERIAL_ID = "mat-ak";
const PVC_TYPE_ID = "pvc-ak";

/** The row the Manager types: 6 листов ЛДСП Ақ at 16 000, plus 92 м of Ақ edging at 200. */
const SHEETS = 6;
const SHEET_PRICE = T(16000);
const PVC_METERS = 92;
const PVC_RATE = T(200);
const EXPECTED_TOTAL = T(16000) * SHEETS + T(200) * PVC_METERS; // 96 000 + 18 400 = 114 400 ₸

const START_SHEETS_ON_HAND = 10;
const START_PVC_METERS = 200;

/** What the cutter actually counted — deliberately one fewer than was written down. */
const CONFIRMED_SHEETS = 5;

function actorFor(uid: string, name: string) {
  return { user: { uid } as User, userData: { name } as UserDoc };
}

const asManager = () => testEnv.authenticatedContext(MANAGER_UID).firestore() as unknown as Firestore;
const asCutter = () => testEnv.authenticatedContext(CUTTER_UID).firestore() as unknown as Firestore;
const asPvc = () => testEnv.authenticatedContext(PVC_UID).firestore() as unknown as Firestore;

const manager = actorFor(MANAGER_UID, "Менеджер");
const cutter = actorFor(CUTTER_UID, "Распилшик");
const pvcWorker = actorFor(PVC_UID, "ПВХ шебері");

const material: Material = {
  id: MATERIAL_ID,
  name: "ЛДСП Ақ",
  article: "AK-16",
  color: "Ақ",
  thicknessMm: 16,
  sheetLengthMm: 2750,
  sheetWidthMm: 1830,
  sellingPriceTiyn: SHEET_PRICE,
  qtyOnHand: START_SHEETS_ON_HAND,
  reservedQty: 0,
  minStock: 2,
  active: true,
} as Material;

const pvcType: PvcType = {
  id: PVC_TYPE_ID,
  colorName: "Ақ",
  thicknessMm: 0.4,
  pricePerMeterTiyn: PVC_RATE,
  active: true,
  metersOnHand: START_PVC_METERS,
  minStockMeters: 20,
};

const catalog = {
  materials: new Map([[MATERIAL_ID, material]]),
  pvcTypes: new Map([[PVC_TYPE_ID, pvcType]]),
};

const methods: PaymentMethodDef[] = [
  { id: "cash", name: "Нал / Қолма-қол", active: true, isMixed: false },
  { id: "nur", name: "Нұр", active: true, isMixed: false },
];

function journalDraft(): JournalDraft {
  return {
    customerName: "Нурик",
    customerPhone: "77771234567",
    lines: [
      {
        materialId: MATERIAL_ID,
        materialName: "ЛДСП Ақ",
        sheetQty: SHEETS,
        sheetPriceTiyn: SHEET_PRICE,
        pvcMeters: PVC_METERS,
        pvcPricePerMeterTiyn: PVC_RATE,
        pvcTypeId: PVC_TYPE_ID,
        pvcColorName: "Ақ",
      },
    ],
    hdfCostTiyn: 0,
    cuttingCostTiyn: 0,
    extraServicesTiyn: 0,
    deliveryCostTiyn: 0,
    discountTiyn: 0,
    orderDate: new Date(),
  };
}

/** Reads an order back the way every screen does: one document, id included. */
async function readOrder(db: Firestore, id: string): Promise<Order> {
  const snap = await getDoc(doc(db, "orders", id));
  expect(snap.exists()).toBe(true);
  return { id: snap.id, ...(snap.data() as Omit<Order, "id">) };
}

async function readMaterialQty(): Promise<number> {
  let qty = -1;
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const snap = await getDoc(doc(ctx.firestore(), "materials", MATERIAL_ID));
    qty = (snap.data() as { qtyOnHand: number }).qtyOnHand;
  });
  return qty;
}

async function readPvcMeters(): Promise<number> {
  let meters = -1;
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const snap = await getDoc(doc(ctx.firestore(), "pvcTypes", PVC_TYPE_ID));
    meters = (snap.data() as { metersOnHand: number }).metersOnHand;
  });
  return meters;
}

async function readPayments(orderId: string): Promise<Payment[]> {
  const db = asManager();
  const snap = await getDocs(query(collection(db, "payments"), where("orderId", "==", orderId)));
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Payment, "id">) }));
}

/** Exactly the query hooks/useOrders.ts runs for a cutter — "what is on my screen right now". */
async function cutterQueue(): Promise<Order[]> {
  const db = asCutter();
  const snap = await getDocs(
    query(collection(db, "orders"), where("productionStatus", "in", ["cutting_queue", "cutting_started", "cutting_completed"])),
  );
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Order, "id">) }));
}

async function pvcQueue(): Promise<Order[]> {
  const db = asPvc();
  const snap = await getDocs(
    query(collection(db, "orders"), where("productionStatus", "in", [
      "cutting_queue", "cutting_started", "cutting_completed", "pvc_queue", "pvc_started", "pvc_completed",
    ])),
  );
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Order, "id">) }));
}

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: "workshop-lifecycle-test",
    firestore: { rules: readFileSync("firestore.rules", "utf8"), host: "127.0.0.1", port: 8080 },
  });
});

afterAll(async () => {
  await testEnv.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "users", MANAGER_UID), { name: "Менеджер", role: "manager", blocked: false, phone: "" });
    await setDoc(doc(db, "users", CUTTER_UID), { name: "Распилшик", role: "raspil", blocked: false, phone: "" });
    await setDoc(doc(db, "users", PVC_UID), { name: "ПВХ шебері", role: "pvh", blocked: false, phone: "" });
    // Firestore rejects an explicit `undefined`, so the id is dropped rather than blanked — it is
    // the document key here, not a field.
    const withoutId = <T extends { id: string }>({ id: _id, ...rest }: T) => rest;
    await setDoc(doc(db, "materials", MATERIAL_ID), { ...withoutId(material), stockTracked: true });
    await setDoc(doc(db, "pvcTypes", PVC_TYPE_ID), withoutId(pvcType));
    for (const m of methods) await setDoc(doc(db, "paymentMethods", m.id), withoutId(m));
  });
});

describe("журнал → төлем → распил → ПВХ → дайын", () => {
  it("walks the whole order through, checking every figure at every step", async () => {
    // ── 1. The Manager types the row into the journal ────────────────────────────────────────
    const orderId = await createJournalOrder(asManager(), manager, journalDraft(), catalog);
    let order = await readOrder(asManager(), orderId);

    expect(order.orderNumber).toMatch(/^ORD-\d{4}-\d{6}$/);
    expect(order.customerName).toBe("Нурик");
    expect(order.materialCostTiyn).toBe(T(96000));
    expect(order.pvcCostTiyn).toBe(T(18400));
    expect(order.totalTiyn).toBe(EXPECTED_TOTAL);
    expect(order.paidTiyn).toBe(0);
    expect(order.debtTiyn).toBe(EXPECTED_TOTAL);
    expect(order.paymentStatus).toBe("unpaid");
    expect(order.productionStatus).toBe("waiting_payment");
    expect(order.confirmedSheets).toBe(SHEETS);
    expect(order.pvcMetersTotal).toBe(PVC_METERS);
    // The colour is on the line and rolled up for the ПВХ report / roll stock.
    expect(order.items?.[0]).toMatchObject({ materialId: MATERIAL_ID, pvcTypeId: PVC_TYPE_ID, pvcColorName: "Ақ" });
    expect(order.pvcByType).toEqual([
      { pvcTypeId: PVC_TYPE_ID, colorName: "Ақ", thicknessMm: 0.4, meters: PVC_METERS, costTiyn: T(18400) },
    ]);
    // Nothing has left the warehouse yet — sheets move when the order is queued, not when priced.
    expect(await readMaterialQty()).toBe(START_SHEETS_ON_HAND);

    // ── 2. Part payment: 50 000 ₸ in cash ───────────────────────────────────────────────────
    await recordPayment(asManager(), manager, {
      orderId, amountTiyn: T(50000), methodId: "cash", methodName: "Нал / Қолма-қол",
    });
    order = await readOrder(asManager(), orderId);
    expect(order.paidTiyn).toBe(T(50000));
    expect(order.debtTiyn).toBe(T(64400));
    expect(order.paymentStatus).toBe("partial");
    expect(order.productionStatus).toBe("partially_paid");
    // The payment gate is what keeps a half-paid row off the saw unless it is deliberately
    // overridden — the journal's "⚠️ Қарызға жіберу".
    expect(canEnterCuttingQueue(order.paymentStatus)).toBe(false);

    // ── 3. The rest, 64 400 ₸ by Нұр ────────────────────────────────────────────────────────
    await recordPayment(asManager(), manager, {
      orderId, amountTiyn: T(64400), methodId: "nur", methodName: "Нұр",
    });
    order = await readOrder(asManager(), orderId);
    expect(order.paidTiyn).toBe(EXPECTED_TOTAL);
    expect(order.debtTiyn).toBe(0);
    expect(order.paymentStatus).toBe("paid");
    expect(order.productionStatus).toBe("paid");
    expect(canEnterCuttingQueue(order.paymentStatus)).toBe(true);

    // The journal row and the Касса read the same two payments and agree with the order.
    const payments = await readPayments(orderId);
    expect(netPaidTiyn(payments)).toBe(EXPECTED_TOTAL);
    const cashbox = computeCashbox({ payments, expenses: [], methods, period: null });
    expect(cashbox.accounts.find((a) => a.account === "cash")!.inTiyn).toBe(T(50000));
    expect(cashbox.accounts.find((a) => a.account === "deposit")!.inTiyn).toBe(T(64400));
    expect(cashbox.totalInTiyn).toBe(EXPECTED_TOTAL);

    // ── 4. The Manager sends it to the saw ──────────────────────────────────────────────────
    await enterCuttingQueue(asManager(), manager, order, { isAdmin: false, queuePosition: 1 });
    order = await readOrder(asManager(), orderId);
    expect(order.productionStatus).toBe("cutting_queue");
    expect(order.priority).toBe(1);
    expect(order.cuttingQueuedAt).toBeTruthy();

    // The sheets leave the rack now: 10 − 6 = 4, with a ledger entry behind it.
    expect(await readMaterialQty()).toBe(START_SHEETS_ON_HAND - SHEETS);
    expect(order.lineJobs).toHaveLength(1);
    expect(order.lineJobs?.[0]).toMatchObject({ index: 0, materialId: MATERIAL_ID, sheetQty: SHEETS, consumedQty: SHEETS });
    const moves = await getDocs(query(collection(asManager(), "inventoryMovements"), where("orderId", "==", orderId)));
    expect(moves.docs).toHaveLength(1);
    expect(moves.docs[0].data()).toMatchObject({ type: "cutting_consumption", qty: -SHEETS, balanceBefore: 10, balanceAfter: 4 });

    // ── 5. The cutter opens their screen and sees it ────────────────────────────────────────
    const queue = await cutterQueue();
    expect(queue.map((o) => o.id)).toContain(orderId);
    const seenByCutter = queue.find((o) => o.id === orderId)!;
    const jobsInQueue = jobsOf(seenByCutter);
    expect(jobsInQueue).toHaveLength(1);
    expect(jobsInQueue[0].cuttingStartedAt).toBeUndefined();
    expect(jobsInQueue[0].cuttingCompletedAt).toBeUndefined();
    expect(allCuttingDone(jobsInQueue)).toBe(false);

    // ── 6. The cutter presses "Бастау" ──────────────────────────────────────────────────────
    await startCuttingLine(asCutter(), cutter, seenByCutter, 0, 30);
    order = await readOrder(asManager(), orderId);
    expect(order.productionStatus).toBe("cutting_started");
    expect(order.assignedCutterId).toBe(CUTTER_UID);
    expect(order.cuttingEstimatedMinutes).toBe(30);
    const started = jobsOf(order)[0];
    expect(started.cuttingStartedAt).toBeTruthy();
    expect(started.cuttingByName).toBe("Распилшик");
    expect(started.cuttingCompletedAt).toBeUndefined();

    // ── 7. The cutter finishes, counting 5 rather than the 6 that were written down ─────────
    const beforeComplete = await readOrder(asCutter(), orderId);
    const result = await completeCuttingLine(asCutter(), cutter, beforeComplete, 0, CONFIRMED_SHEETS);
    expect(result.alreadyCompleted).toBe(false);

    order = await readOrder(asManager(), orderId);
    // The order has edge banding on it, so it goes to the ПВХ queue rather than straight to ready.
    expect(order.productionStatus).toBe("pvc_queue");
    const cut = jobsOf(order)[0];
    expect(cut.cuttingCompletedAt).toBeTruthy();
    expect(cut.confirmedSheets).toBe(CONFIRMED_SHEETS);
    expect(allCuttingDone(jobsOf(order))).toBe(true);
    // The two counts are allowed to differ and each keeps its own job: order.confirmedSheets is
    // what came off the saw (warehouse, salary), items[].sheetQty is what was sold (the bill).
    expect(order.confirmedSheets).toBe(CONFIRMED_SHEETS);
    expect(order.items?.[0].sheetQty).toBe(SHEETS);
    expect(order.estimatedSheets).toBe(SHEETS);
    // The unused sheet goes back on the rack: 4 + 1 = 5, as its own ledger entry.
    expect(await readMaterialQty()).toBe(START_SHEETS_ON_HAND - CONFIRMED_SHEETS);
    const movesAfterCut = await getDocs(query(collection(asManager(), "inventoryMovements"), where("orderId", "==", orderId)));
    expect(movesAfterCut.docs).toHaveLength(2);

    // The cutter counting fewer sheets must never rewrite what the customer was billed — the
    // money is the Manager's to change, in the journal, deliberately.
    expect(order.totalTiyn).toBe(EXPECTED_TOTAL);
    expect(order.paidTiyn).toBe(EXPECTED_TOTAL);
    expect(order.paymentStatus).toBe("paid");

    // …and the journal must not read the cut back as a new price either: it still shows the row
    // that was agreed, so an untouched row cannot silently drift to "Артық төленді".
    const journalDraftBack = draftFromOrder(order);
    expect(journalDraftBack.lines[0].sheetQty).toBe(SHEETS);
    const preview = computeJournalRowTotals({
      lines: journalDraftBack.lines,
      hdfCostTiyn: journalDraftBack.hdfCostTiyn,
      cuttingCostTiyn: journalDraftBack.cuttingCostTiyn,
      extraServicesTiyn: journalDraftBack.extraServicesTiyn,
      deliveryCostTiyn: journalDraftBack.deliveryCostTiyn,
      discountTiyn: journalDraftBack.discountTiyn,
      paidTiyn: netPaidTiyn(await readPayments(orderId)),
    });
    expect(preview.totalTiyn).toBe(EXPECTED_TOTAL);
    expect(preview.debtTiyn).toBe(0);
    expect(preview.paymentStatus).toBe("paid");

    // ── 8. The PVC worker sees it, starts, and finishes ─────────────────────────────────────
    const pvcList = await pvcQueue();
    expect(pvcList.map((o) => o.id)).toContain(orderId);
    const seenByPvc = pvcList.find((o) => o.id === orderId)!;
    expect(jobsOf(seenByPvc)[0].pvcMeters).toBe(PVC_METERS);

    await startPvcLine(asPvc(), pvcWorker, seenByPvc, 0, 20);
    order = await readOrder(asManager(), orderId);
    expect(order.productionStatus).toBe("pvc_started");
    expect(jobsOf(order)[0].pvcStartedAt).toBeTruthy();
    // Still 200 m on the roll — it is drawn down when the job is finished, not when it is started.
    expect(await readPvcMeters()).toBe(START_PVC_METERS);

    const beforePvcDone = await readOrder(asPvc(), orderId);
    const pvcResult = await completePvcLine(asPvc(), pvcWorker, beforePvcDone, 0);
    expect(pvcResult.alreadyCompleted).toBe(false);

    order = await readOrder(asManager(), orderId);
    expect(order.productionStatus).toBe("ready");
    expect(order.readyAt).toBeTruthy();
    expect(allPvcDone(jobsOf(order))).toBe(true);
    // 92 m of Ақ off the roll: 200 − 92 = 108. This only works because the journal recorded a
    // colour on the line.
    expect(await readPvcMeters()).toBe(START_PVC_METERS - PVC_METERS);

    // ── 9. The Manager hands it over ────────────────────────────────────────────────────────
    await markDelivered(asManager(), manager, order);
    order = await readOrder(asManager(), orderId);
    expect(order.productionStatus).toBe("delivered");
    expect(order.deliveredAt).toBeTruthy();

    // ── 10. The reports agree with what actually happened ───────────────────────────────────
    const usage = computePvcUsage({ orders: [order], pvcTypes: [pvcType], period: null });
    expect(usage.rows).toHaveLength(1);
    expect(usage.rows[0]).toMatchObject({ pvcTypeId: PVC_TYPE_ID, colorName: "Ақ", meters: PVC_METERS });
    expect(usage.unattributedMeters).toBe(0);
    expect(usage.totalCostTiyn).toBe(T(18400));
  });

  it("bills what the Manager corrects the row to, not what the cutter counted", async () => {
    // The other half of step 7: when the shop DOES want to bill the 5 sheets that were cut, the
    // Manager types 5 into the journal and the row reprices itself — one deliberate edit, with an
    // audit entry, rather than a silent change nobody approved.
    const orderId = await createJournalOrder(asManager(), manager, journalDraft(), catalog);
    let order = await readOrder(asManager(), orderId);

    const draft = draftFromOrder(order);
    draft.lines[0].sheetQty = CONFIRMED_SHEETS;
    await saveJournalRow(asManager(), manager, order, draft, catalog);

    order = await readOrder(asManager(), orderId);
    expect(order.materialCostTiyn).toBe(T(16000) * CONFIRMED_SHEETS);
    expect(order.totalTiyn).toBe(T(16000) * CONFIRMED_SHEETS + T(18400)); // 98 400 ₸
    expect(order.debtTiyn).toBe(order.totalTiyn);
    expect(order.paymentStatus).toBe("unpaid");
    expect(order.items?.[0].sheetQty).toBe(CONFIRMED_SHEETS);
    // The ПВХ breakdown is rewritten with the row, and the metres on it are untouched.
    expect(order.pvcByType?.[0].meters).toBe(PVC_METERS);
  });

  it("still reaches the saw when the warehouse is short, leaving the balance negative", async () => {
    // "Қоймада лист жоқ болса да жіберіле берсін" — 12 sheets wanted, 10 on hand.
    const draft = journalDraft();
    draft.lines[0].sheetQty = 12;
    const orderId = await createJournalOrder(asManager(), manager, draft, catalog);
    let order = await readOrder(asManager(), orderId);

    await recordPayment(asManager(), manager, {
      orderId, amountTiyn: order.totalTiyn, methodId: "nur", methodName: "Нұр",
    });
    order = await readOrder(asManager(), orderId);

    await enterCuttingQueue(asManager(), manager, order, { isAdmin: false, queuePosition: 1 });
    order = await readOrder(asManager(), orderId);
    expect(order.productionStatus).toBe("cutting_queue");
    // −2: the shop owes the rack two sheets, and says so rather than blocking the job.
    expect(await readMaterialQty()).toBe(-2);

    // And the cutter can still close the job on a negative balance — an order stranded on the saw
    // with no way to finish it would be the worse failure.
    const seen = (await cutterQueue()).find((o) => o.id === orderId)!;
    await startCuttingLine(asCutter(), cutter, seen, 0, 30);
    const beforeDone = await readOrder(asCutter(), orderId);
    await completeCuttingLine(asCutter(), cutter, beforeDone, 0, 12);
    order = await readOrder(asManager(), orderId);
    expect(order.productionStatus).toBe("pvc_queue");
    expect(await readMaterialQty()).toBe(-2);
  });

  it("goes straight to Дайын when the order has no edge banding", async () => {
    const draft = journalDraft();
    draft.lines[0].pvcMeters = 0;
    draft.lines[0].pvcTypeId = "";
    draft.lines[0].pvcColorName = "";
    const orderId = await createJournalOrder(asManager(), manager, draft, catalog);
    let order = await readOrder(asManager(), orderId);
    expect(order.totalTiyn).toBe(T(96000));
    expect(order.pvcByType).toEqual([]);

    await recordPayment(asManager(), manager, {
      orderId, amountTiyn: order.totalTiyn, methodId: "cash", methodName: "Нал / Қолма-қол",
    });
    order = await readOrder(asManager(), orderId);
    await enterCuttingQueue(asManager(), manager, order, { isAdmin: false, queuePosition: 1 });

    const seen = (await cutterQueue()).find((o) => o.id === orderId)!;
    await startCuttingLine(asCutter(), cutter, seen, 0, 25);
    const beforeDone = await readOrder(asCutter(), orderId);
    await completeCuttingLine(asCutter(), cutter, beforeDone, 0, SHEETS);

    order = await readOrder(asManager(), orderId);
    expect(order.productionStatus).toBe("ready");
    expect(order.readyAt).toBeTruthy();
    // No colour was used, so no roll moved.
    expect(await readPvcMeters()).toBe(START_PVC_METERS);
  });
});
