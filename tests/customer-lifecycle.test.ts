import { readFileSync } from "node:fs";
import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import {
  collection, doc, getDoc, getDocs, orderBy, query, setDoc, updateDoc, deleteDoc, where,
  type Firestore,
} from "firebase/firestore";
import type { User } from "firebase/auth";

import { recordPayment } from "../src/lib/payments";
import {
  startManagerReview,
  calculatePrice,
  publishPrice,
  enterCuttingQueue,
  startCuttingLine,
  completeCuttingLine,
  startPvcLine,
  completePvcLine,
  markDelivered,
} from "../src/lib/orderStatus";
import { jobsOf } from "../src/lib/orderLines";
import { canEnterCuttingQueue } from "../src/lib/statuses";
import { orderProgress } from "../src/lib/orderProgress";
import type { Order, PvcType, UserDoc } from "../src/types/domain";

/**
 * The customer's own order, end to end, against the emulator with the real security rules on.
 *
 * The walk-in path (tests/order-lifecycle.test.ts) starts with a Manager typing a row that is
 * already agreed and already priced. This one starts a step earlier and with far less trust: the
 * customer builds the order themselves, and the shop has to review it, price it, publish that
 * price and take the money before anything reaches the saw. Every step checks both the numbers and
 * what each role is allowed to do — the customer must be able to follow their order all the way
 * through, and must not be able to move it, price it, or read anyone else's.
 */

let testEnv: RulesTestEnvironment;

const MANAGER_UID = "manager-1";
const CUTTER_UID = "cutter-1";
const PVC_UID = "pvc-1";
const CUSTOMER_UID = "customer-a";
const OTHER_CUSTOMER_UID = "customer-b";

const T = (tenge: number) => tenge * 100;

const MATERIAL_ID = "mat-ak";
const PVC_TYPE_ID = "pvc-ak";
const ORDER_ID = "order-customer-1";

const SHEETS = 4;
const SHEET_PRICE = T(16000);
const PVC_METERS = 30;
const PVC_RATE = T(200);
/** What the customer's own builder arrived at: 4 × 16 000 + 30 × 200 = 70 000 ₸. */
const CUSTOMER_ESTIMATE = SHEET_PRICE * SHEETS + PVC_RATE * PVC_METERS;
/** What the Manager settles on after checking the parts — a delivery charge the builder missed. */
const PUBLISHED_TOTAL = CUSTOMER_ESTIMATE + T(3000);

const START_SHEETS_ON_HAND = 10;
const START_PVC_METERS = 200;

function actorFor(uid: string, name: string) {
  return { user: { uid } as User, userData: { name } as UserDoc };
}

const asManager = () => testEnv.authenticatedContext(MANAGER_UID).firestore() as unknown as Firestore;
const asCutter = () => testEnv.authenticatedContext(CUTTER_UID).firestore() as unknown as Firestore;
const asPvc = () => testEnv.authenticatedContext(PVC_UID).firestore() as unknown as Firestore;
const asCustomer = () => testEnv.authenticatedContext(CUSTOMER_UID).firestore() as unknown as Firestore;
const asOtherCustomer = () => testEnv.authenticatedContext(OTHER_CUSTOMER_UID).firestore() as unknown as Firestore;

const manager = actorFor(MANAGER_UID, "Менеджер");
const cutter = actorFor(CUTTER_UID, "Распилшик");
const pvcWorker = actorFor(PVC_UID, "ПВХ шебері");

const material = {
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
  stockTracked: true,
};

const pvcType: PvcType = {
  id: PVC_TYPE_ID,
  colorName: "Ақ",
  thicknessMm: 0.4,
  pricePerMeterTiyn: PVC_RATE,
  active: true,
  metersOnHand: START_PVC_METERS,
  minStockMeters: 20,
};

/**
 * The document src/pages/customer/OrderBuilder.tsx writes on "Сақтау"/"Жіберу" — the same shape,
 * so what is tested here is what the screen actually produces.
 */
function builderPayload(asDraft: boolean) {
  return {
    customerId: CUSTOMER_UID,
    customerName: "Клиент А",
    customerPhone: "77770001122",
    orderNumber: "ORD-2026-000100",
    materialSource: "shop",
    customerMaterialName: "",
    materialId: MATERIAL_ID,
    // The snapshot is the catalogue's spec/price frozen onto the order — never its stock counts.
    materialSnapshot: {
      name: material.name,
      article: material.article,
      color: material.color,
      thicknessMm: material.thicknessMm,
      sheetLengthMm: material.sheetLengthMm,
      sheetWidthMm: material.sheetWidthMm,
      sellingPriceTiyn: material.sellingPriceTiyn,
    },
    productionStatus: asDraft ? "draft" : "submitted",
    paymentStatus: "unpaid",
    priority: 0,
    estimatedSheets: SHEETS,
    pvcMetersTotal: PVC_METERS,
    pvcByType: [
      { pvcTypeId: PVC_TYPE_ID, colorName: "Ақ", thicknessMm: 0.4, meters: PVC_METERS, costTiyn: PVC_RATE * PVC_METERS },
    ],
    materialCostTiyn: SHEET_PRICE * SHEETS,
    cuttingCostTiyn: 0,
    pvcCostTiyn: PVC_RATE * PVC_METERS,
    hdfCostTiyn: 0,
    extraServicesTiyn: 0,
    deliveryCostTiyn: 0,
    discountTiyn: 0,
    totalTiyn: CUSTOMER_ESTIMATE,
    paidTiyn: 0,
    debtTiyn: CUSTOMER_ESTIMATE,
    // The customer's own arithmetic is never authoritative — the Manager publishes the real price.
    pricePublished: false,
    customerNote: "Есік үшін",
    isDraft: asDraft,
  };
}

const PART = {
  name: "Есік",
  lengthMm: 700,
  widthMm: 400,
  qty: 4,
  grainDirection: "none",
  rotationAllowed: true,
  note: "",
  edges: "",
};

async function readOrder(db: Firestore, id = ORDER_ID): Promise<Order> {
  const snap = await getDoc(doc(db, "orders", id));
  expect(snap.exists()).toBe(true);
  return { id: snap.id, ...(snap.data() as Omit<Order, "id">) };
}

async function readMaterialQty(): Promise<number> {
  let qty = -1;
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    qty = (await getDoc(doc(ctx.firestore(), "materials", MATERIAL_ID))).data()!.qtyOnHand as number;
  });
  return qty;
}

async function readPvcMeters(): Promise<number> {
  let meters = -1;
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    meters = (await getDoc(doc(ctx.firestore(), "pvcTypes", PVC_TYPE_ID))).data()!.metersOnHand as number;
  });
  return meters;
}

/** Exactly the query hooks/useOrders.ts's useCustomerOrders runs — "what is on my Заказдарым page". */
async function myOrders(db: Firestore, customerId: string): Promise<Order[]> {
  const snap = await getDocs(
    query(collection(db, "orders"), where("customerId", "==", customerId), orderBy("createdAt", "desc")),
  );
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Order, "id">) }));
}

/** How many notifications the customer has waiting — the bell on their dashboard. */
async function myNotifications(db: Firestore, uid: string): Promise<string[]> {
  const snap = await getDocs(query(collection(db, "notifications"), where("userId", "==", uid)));
  return snap.docs.map((d) => d.data().title as string);
}

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: "workshop-customer-test",
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
    await setDoc(doc(db, "users", CUSTOMER_UID), { name: "Клиент А", role: "customer", blocked: false, phone: "77770001122" });
    await setDoc(doc(db, "users", OTHER_CUSTOMER_UID), { name: "Клиент Б", role: "customer", blocked: false, phone: "77770003344" });
    await setDoc(doc(db, "materials", MATERIAL_ID), material);
    // The id is the document key, not a field — and Firestore rejects an explicit undefined.
    const withoutId = <T extends { id: string }>({ id: _id, ...rest }: T) => rest;
    await setDoc(doc(db, "pvcTypes", PVC_TYPE_ID), withoutId(pvcType));
    await setDoc(doc(db, "paymentMethods", "kaspi"), { name: "Kaspi", active: true, isMixed: false });
  });
});

describe("клиент заказы: черновик → жіберу → баға → төлем → распил → ПВХ → дайын", () => {
  it("walks a customer-built order all the way through, checking every figure and permission", async () => {
    // ── 1. The customer builds the order and keeps it as a draft ────────────────────────────
    const customerDb = asCustomer();
    await assertSucceeds(setDoc(doc(customerDb, "orders", ORDER_ID), { ...builderPayload(true), createdAt: new Date() }));
    await assertSucceeds(setDoc(doc(customerDb, "orders", ORDER_ID, "parts", "part-1"), PART));

    let order = await readOrder(customerDb);
    expect(order.productionStatus).toBe("draft");
    expect(order.isDraft).toBe(true);
    expect(order.pricePublished).toBe(false);
    expect(order.totalTiyn).toBe(CUSTOMER_ESTIMATE);
    // A draft is the customer's own scratch pad: it is not yet the shop's business and never
    // appears in the Manager's journal (ManagerJournal filters productionStatus === "draft").
    expect(order.submittedAt).toBeUndefined();

    // It is on their own Заказдарым page from the start…
    expect((await myOrders(customerDb, CUSTOMER_UID)).map((o) => o.id)).toEqual([ORDER_ID]);
    // …and on nobody else's. Another customer cannot read it, by id or by query.
    await assertFails(getDoc(doc(asOtherCustomer(), "orders", ORDER_ID)));
    expect(await myOrders(asOtherCustomer(), OTHER_CUSTOMER_UID)).toEqual([]);

    // ── 2. The customer submits it ─────────────────────────────────────────────────────────
    await assertSucceeds(
      updateDoc(doc(customerDb, "orders", ORDER_ID), { productionStatus: "submitted", isDraft: false }),
    );
    order = await readOrder(asManager());
    expect(order.productionStatus).toBe("submitted");

    // It now shows up in the Manager's "Жаңа заказдар" list.
    const newForManager = await getDocs(
      query(collection(asManager(), "orders"), where("productionStatus", "in", ["submitted", "manager_review"])),
    );
    expect(newForManager.docs.map((d) => d.id)).toContain(ORDER_ID);

    // The saw must not see it yet — it is neither priced nor paid.
    const cutterSees = await getDocs(
      query(collection(asCutter(), "orders"), where("productionStatus", "in", ["cutting_queue", "cutting_started", "cutting_completed"])),
    );
    expect(cutterSees.docs.map((d) => d.id)).not.toContain(ORDER_ID);

    // ── 3. The Manager picks it up ─────────────────────────────────────────────────────────
    await startManagerReview(asManager(), manager, order);
    order = await readOrder(asManager());
    expect(order.productionStatus).toBe("manager_review");
    expect(order.assignedManagerName).toBe("Менеджер");
    expect(await myNotifications(asCustomer(), CUSTOMER_UID)).toContain("Заказ қабылданды");

    // The Manager may still correct the specification at this stage.
    await assertSucceeds(updateDoc(doc(asManager(), "orders", ORDER_ID, "parts", "part-1"), { qty: 5 }));

    // ── 4. The Manager prices it — but the customer must not see it as final yet ────────────
    await calculatePrice(asManager(), manager, order, {
      materialCostTiyn: SHEET_PRICE * SHEETS,
      cuttingCostTiyn: 0,
      pvcCostTiyn: PVC_RATE * PVC_METERS,
      hdfCostTiyn: 0,
      extraServicesTiyn: 0,
      deliveryCostTiyn: T(3000),
      discountTiyn: 0,
      totalTiyn: PUBLISHED_TOTAL,
    }, "Жеткізу қосылды");
    order = await readOrder(asCustomer());
    expect(order.productionStatus).toBe("price_calculated");
    expect(order.totalTiyn).toBe(PUBLISHED_TOTAL);
    // Still unpublished: the customer's screen reads this flag and shows "Баға есептелуде…".
    expect(order.pricePublished).toBe(false);
    expect(canEnterCuttingQueue(order.paymentStatus)).toBe(false);

    // ── 5. The Manager publishes the price ─────────────────────────────────────────────────
    await publishPrice(asManager(), manager, order);
    order = await readOrder(asCustomer());
    expect(order.productionStatus).toBe("waiting_payment");
    expect(order.pricePublished).toBe(true);
    expect(order.debtTiyn).toBe(PUBLISHED_TOTAL);
    expect(await myNotifications(asCustomer(), CUSTOMER_UID)).toContain("Баға есептелді");

    // ── 6. What the customer still cannot do ───────────────────────────────────────────────
    // Pay themselves — every tenge goes through the Manager's recordPayment.
    await assertFails(
      setDoc(doc(customerDb, "payments", "fake"), {
        orderId: ORDER_ID, amountTiyn: PUBLISHED_TOTAL, methodId: "kaspi", methodName: "Kaspi",
        recordedByUid: CUSTOMER_UID, recordedByName: "Клиент А", reversed: false,
      }),
    );
    // Mark themselves paid, discount themselves, or push the order onto the saw.
    await assertFails(updateDoc(doc(customerDb, "orders", ORDER_ID), { paidTiyn: PUBLISHED_TOTAL }));
    await assertFails(updateDoc(doc(customerDb, "orders", ORDER_ID), { discountTiyn: T(10000) }));
    await assertFails(updateDoc(doc(customerDb, "orders", ORDER_ID), { productionStatus: "cutting_queue" }));
    await assertFails(deleteDoc(doc(customerDb, "orders", ORDER_ID)));
    // Even editing the parts is closed now that the order is priced and awaiting payment.
    await assertFails(updateDoc(doc(customerDb, "orders", ORDER_ID, "parts", "part-1"), { qty: 99 }));

    // ── 7. The Manager takes the payment ───────────────────────────────────────────────────
    await recordPayment(asManager(), manager, {
      orderId: ORDER_ID, amountTiyn: PUBLISHED_TOTAL, methodId: "kaspi", methodName: "Kaspi",
    });
    order = await readOrder(asCustomer());
    expect(order.paidTiyn).toBe(PUBLISHED_TOTAL);
    expect(order.debtTiyn).toBe(0);
    expect(order.paymentStatus).toBe("paid");
    expect(order.productionStatus).toBe("paid");

    // The customer can see the receipt on their own order — and only on their own.
    const myPayments = await getDocs(query(collection(customerDb, "payments"), where("orderId", "==", ORDER_ID)));
    expect(myPayments.docs).toHaveLength(1);
    expect(myPayments.docs[0].data().amountTiyn).toBe(PUBLISHED_TOTAL);
    await assertFails(getDocs(query(collection(asOtherCustomer(), "payments"), where("orderId", "==", ORDER_ID))));

    // ── 8. To the saw ──────────────────────────────────────────────────────────────────────
    await enterCuttingQueue(asManager(), manager, order, { isAdmin: false, queuePosition: 1 });
    order = await readOrder(asCustomer());
    expect(order.productionStatus).toBe("cutting_queue");
    expect(await readMaterialQty()).toBe(START_SHEETS_ON_HAND - SHEETS);
    expect(order.lineJobs).toHaveLength(1);

    // ── 9. The cutter: sees the order AND its dimensions, starts, finishes ─────────────────
    const cutterQueue = await getDocs(
      query(collection(asCutter(), "orders"), where("productionStatus", "in", ["cutting_queue", "cutting_started", "cutting_completed"])),
    );
    expect(cutterQueue.docs.map((d) => d.id)).toContain(ORDER_ID);
    // A customer-built order is cut from its parts list, so the cutter must be able to read it.
    const partsForCutter = await getDocs(collection(asCutter(), "orders", ORDER_ID, "parts"));
    expect(partsForCutter.docs).toHaveLength(1);
    expect(partsForCutter.docs[0].data()).toMatchObject({ lengthMm: 700, widthMm: 400, qty: 5 });

    const forCutter = await readOrder(asCutter());
    await startCuttingLine(asCutter(), cutter, forCutter, 0, 40);
    order = await readOrder(asCustomer());
    expect(order.productionStatus).toBe("cutting_started");
    expect(await myNotifications(asCustomer(), CUSTOMER_UID)).toContain("Распил басталды");

    await completeCuttingLine(asCutter(), cutter, await readOrder(asCutter()), 0, SHEETS);
    order = await readOrder(asCustomer());
    expect(order.productionStatus).toBe("pvc_queue");
    expect(jobsOf(order)[0].confirmedSheets).toBe(SHEETS);
    // Nothing to give back: the cut came out exactly as planned.
    expect(await readMaterialQty()).toBe(START_SHEETS_ON_HAND - SHEETS);

    // ── 10. The PVC worker finishes the job ────────────────────────────────────────────────
    await startPvcLine(asPvc(), pvcWorker, await readOrder(asPvc()), 0, 15);
    order = await readOrder(asCustomer());
    expect(order.productionStatus).toBe("pvc_started");

    await completePvcLine(asPvc(), pvcWorker, await readOrder(asPvc()), 0);
    order = await readOrder(asCustomer());
    expect(order.productionStatus).toBe("ready");
    expect(order.readyAt).toBeTruthy();
    // The colour breakdown the customer's builder wrote is what draws the roll down.
    expect(await readPvcMeters()).toBe(START_PVC_METERS - PVC_METERS);
    expect(await myNotifications(asCustomer(), CUSTOMER_UID)).toContain("Заказыңыз дайын");

    // ── 11. Handed over ────────────────────────────────────────────────────────────────────
    await markDelivered(asManager(), manager, order);
    order = await readOrder(asCustomer());
    expect(order.productionStatus).toBe("delivered");
    expect(order.deliveredAt).toBeTruthy();

    // ── 12. The customer can follow the whole trail on their own order ─────────────────────
    const history = await getDocs(collection(customerDb, "orders", ORDER_ID, "statusHistory"));
    const stages = history.docs.map((d) => d.data().newStatus as string);
    for (const stage of ["manager_review", "price_calculated", "waiting_payment", "cutting_queue", "cutting_started", "ready", "delivered"]) {
      expect(stages, `status history is missing ${stage}`).toContain(stage);
    }
    // …and the progress strip on their screen reads every step as done.
    expect(orderProgress(order).every((step) => step.state === "done" || step.state === "skipped")).toBe(true);
  });

  it("keeps a draft to itself: the shop floor never sees an order the customer has not sent", async () => {
    const customerDb = asCustomer();
    await setDoc(doc(customerDb, "orders", ORDER_ID), { ...builderPayload(true), createdAt: new Date() });

    // Neither the cutter nor the PVC worker can reach a draft, by query or by id.
    await assertFails(getDoc(doc(asCutter(), "orders", ORDER_ID)));
    await assertFails(getDoc(doc(asPvc(), "orders", ORDER_ID)));

    // The Manager can see it (they see every order) but the journal hides drafts, and the payment
    // gate would refuse it anyway.
    const order = await readOrder(asManager());
    expect(order.productionStatus).toBe("draft");
    expect(canEnterCuttingQueue(order.paymentStatus)).toBe(false);
  });

  it("refuses to send an unpaid customer order to the saw", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "orders", ORDER_ID), {
        ...builderPayload(false),
        productionStatus: "waiting_payment",
        pricePublished: true,
        createdAt: new Date(),
      });
    });
    const order = await readOrder(asManager());

    // The library refuses it outright for a Manager with no override…
    await expect(
      enterCuttingQueue(asManager(), manager, order, { isAdmin: false, queuePosition: 1 }),
    ).rejects.toThrow("Тек толық төленген заказды кезекке қоюға болады");

    // …and firestore.rules refuses the same write even if the client tried to make it directly,
    // unless it carries the audited override shape the "⚠️ Қарызға жіберу" button writes.
    await assertFails(updateDoc(doc(asManager(), "orders", ORDER_ID), { productionStatus: "cutting_queue" }));
    await assertSucceeds(
      updateDoc(doc(asManager(), "orders", ORDER_ID), {
        productionStatus: "cutting_queue",
        paymentGateOverride: true,
        paymentGateOverrideReason: "Сенімді клиент",
      }),
    );

    // The stock only moves through enterCuttingQueue, so a raw status write leaves it untouched.
    expect(await readMaterialQty()).toBe(START_SHEETS_ON_HAND);
  });
});
