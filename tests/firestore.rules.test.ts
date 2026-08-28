import { readFileSync } from "node:fs";
import { beforeAll, afterAll, beforeEach, describe, it } from "vitest";
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { doc, getDoc, getDocs, collection, query, where, runTransaction, setDoc, updateDoc } from "firebase/firestore";

// Runs against the Firestore emulator only — see package.json's `test:rules` script, which
// wraps this file with `firebase emulators:exec`. Not part of the default `npm test` run.

let testEnv: RulesTestEnvironment;

const ADMIN_UID = "admin-1";
const MANAGER_UID = "manager-1";
const CUSTOMER_A_UID = "customer-a";
const CUSTOMER_B_UID = "customer-b";
const CUTTER_UID = "cutter-1";
const PVC_UID = "pvc-1";

const ORDER_A_ID = "order-a"; // waiting_payment, unpaid — the pre-cutting-queue order under review

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: "workshop-rules-test",
    firestore: {
      rules: readFileSync("firestore.rules", "utf8"),
      host: "127.0.0.1",
      port: 8080,
    },
  });
});

afterAll(async () => {
  await testEnv.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "users", ADMIN_UID), { name: "Admin", role: "admin", blocked: false, phone: "" });
    await setDoc(doc(db, "users", MANAGER_UID), { name: "Manager", role: "manager", blocked: false, phone: "" });
    await setDoc(doc(db, "users", CUSTOMER_A_UID), { name: "A", role: "customer", blocked: false, phone: "" });
    await setDoc(doc(db, "users", CUSTOMER_B_UID), { name: "B", role: "customer", blocked: false, phone: "" });
    await setDoc(doc(db, "users", CUTTER_UID), { name: "Cutter", role: "raspil", blocked: false, phone: "" });
    await setDoc(doc(db, "users", PVC_UID), { name: "PVC", role: "pvh", blocked: false, phone: "" });

    // An order still under manager review — unpaid, not yet priced.
    await setDoc(doc(db, "orders", ORDER_A_ID), {
      customerId: CUSTOMER_A_UID,
      customerName: "A",
      customerPhone: "77771234567",
      materialId: "mat-1",
      productionStatus: "waiting_payment",
      paymentStatus: "unpaid",
      priority: 0,
      totalTiyn: 100000,
      paidTiyn: 0,
      debtTiyn: 100000,
      estimatedSheets: 1,
      pvcMetersTotal: 0,
    });

    await setDoc(doc(db, "materials", "mat-1"), {
      name: "ЛДСП Ақ",
      qtyOnHand: 10,
      reservedQty: 0,
      active: true,
    });

    await setDoc(doc(db, "payments", "payment-1"), {
      orderId: ORDER_A_ID,
      amountTiyn: 50000,
      methodName: "Нал",
      reversed: false,
    });

    // A fully-paid order sitting in the cutting queue — cutter/PVC visibility fixtures.
    await setDoc(doc(db, "orders", "order-cutting-queue"), {
      customerId: CUSTOMER_A_UID,
      customerName: "A",
      customerPhone: "77771234567",
      materialId: "mat-1",
      productionStatus: "cutting_queue",
      paymentStatus: "paid",
      priority: 0,
      totalTiyn: 100000,
      paidTiyn: 100000,
      debtTiyn: 0,
      estimatedSheets: 2,
      pvcMetersTotal: 0,
    });
    await setDoc(doc(db, "orders", "order-cutting-started"), {
      customerId: CUSTOMER_A_UID,
      customerName: "A",
      customerPhone: "77771234567",
      materialId: "mat-1",
      productionStatus: "cutting_started",
      paymentStatus: "paid",
      priority: 0,
      totalTiyn: 100000,
      paidTiyn: 100000,
      debtTiyn: 0,
      estimatedSheets: 2,
      pvcMetersTotal: 0,
      assignedCutterId: CUTTER_UID,
    });
    await setDoc(doc(db, "inventoryReservations", "res-1"), {
      materialId: "mat-1",
      orderId: "order-cutting-started",
      qty: 2,
      status: "active",
    });
  });
});

describe("customer isolation", () => {
  it("customer A can read their own order", async () => {
    const db = testEnv.authenticatedContext(CUSTOMER_A_UID).firestore();
    await assertSucceeds(getDoc(doc(db, "orders", ORDER_A_ID)));
  });

  it("customer B CANNOT read customer A's order", async () => {
    const db = testEnv.authenticatedContext(CUSTOMER_B_UID).firestore();
    await assertFails(getDoc(doc(db, "orders", ORDER_A_ID)));
  });

  it("customer B CANNOT read customer A's payments", async () => {
    const db = testEnv.authenticatedContext(CUSTOMER_B_UID).firestore();
    await assertFails(getDoc(doc(db, "payments", "payment-1")));
  });

  it("unauthenticated read is rejected", async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, "orders", ORDER_A_ID)));
  });
});

describe("payment gate: unpaid/partially-paid orders can never enter the cutting queue", () => {
  it("manager CANNOT push an unpaid order into cutting_queue", async () => {
    const db = testEnv.authenticatedContext(MANAGER_UID).firestore();
    await assertFails(updateDoc(doc(db, "orders", ORDER_A_ID), { productionStatus: "cutting_queue" }));
  });

  it("manager CANNOT push a partially-paid order into cutting_queue", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), "orders", ORDER_A_ID), {
        paymentStatus: "partial",
        paidTiyn: 40000,
        debtTiyn: 60000,
      });
    });
    const db = testEnv.authenticatedContext(MANAGER_UID).firestore();
    await assertFails(updateDoc(doc(db, "orders", ORDER_A_ID), { productionStatus: "cutting_queue" }));
  });

  it("manager CAN push a fully-paid order into cutting_queue", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), "orders", ORDER_A_ID), {
        paymentStatus: "paid",
        paidTiyn: 100000,
        debtTiyn: 0,
      });
    });
    const db = testEnv.authenticatedContext(MANAGER_UID).firestore();
    await assertSucceeds(updateDoc(doc(db, "orders", ORDER_A_ID), { productionStatus: "cutting_queue", priority: 0 }));
  });

  it("admin MAY override the payment gate on an unpaid order (app-layer requires a typed reason)", async () => {
    const db = testEnv.authenticatedContext(ADMIN_UID).firestore();
    await assertSucceeds(
      updateDoc(doc(db, "orders", ORDER_A_ID), {
        productionStatus: "cutting_queue",
        priority: 0,
        paymentGateOverride: true,
        paymentGateOverrideReason: "Сенімді клиент, кейін төлейді",
      }),
    );
  });
});

describe("cutter must never see unpaid orders", () => {
  it("cutter cannot read an order still in waiting_payment", async () => {
    const db = testEnv.authenticatedContext(CUTTER_UID).firestore();
    await assertFails(getDoc(doc(db, "orders", ORDER_A_ID)));
  });

  it("cutter CAN read an order once it has legitimately entered cutting_queue (paid)", async () => {
    const db = testEnv.authenticatedContext(CUTTER_UID).firestore();
    await assertSucceeds(getDoc(doc(db, "orders", "order-cutting-queue")));
  });

  it("cutter's visible-orders query never includes the unpaid order", async () => {
    const db = testEnv.authenticatedContext(CUTTER_UID).firestore();
    const q = query(
      collection(db, "orders"),
      where("productionStatus", "in", ["cutting_queue", "cutting_started", "cutting_completed"]),
    );
    const snap = await assertSucceeds(getDocs(q));
    const ids = snap.docs.map((d) => d.id);
    if (ids.includes(ORDER_A_ID)) throw new Error("unpaid order leaked into cutter's queue query");
  });
});

describe("PVC worker must never see unpaid orders", () => {
  it("PVC worker cannot read an order still in waiting_payment", async () => {
    const db = testEnv.authenticatedContext(PVC_UID).firestore();
    await assertFails(getDoc(doc(db, "orders", ORDER_A_ID)));
  });
});

describe("cutter cannot touch payments or financials", () => {
  it("cutter cannot create a payment", async () => {
    const db = testEnv.authenticatedContext(CUTTER_UID).firestore();
    await assertFails(
      setDoc(doc(db, "payments", "payment-new"), {
        orderId: ORDER_A_ID,
        amountTiyn: 1000,
        methodName: "Нал",
        recordedByUid: CUTTER_UID,
        reversed: false,
      }),
    );
  });

  it("cutter cannot change an order's totalTiyn", async () => {
    const db = testEnv.authenticatedContext(CUTTER_UID).firestore();
    await assertFails(updateDoc(doc(db, "orders", "order-cutting-started"), { totalTiyn: 1 }));
  });

  it("cutter CAN advance a visible order from cutting_started to cutting_completed", async () => {
    const db = testEnv.authenticatedContext(CUTTER_UID).firestore();
    await assertSucceeds(updateDoc(doc(db, "orders", "order-cutting-started"), { productionStatus: "cutting_completed" }));
  });
});

describe("cutter's completeCutting transaction (src/lib/warehouse.ts consumeForCutting)", () => {
  it("cutter CAN find their order's active reservation (src/lib/orderStatus.ts completeCutting looks it up before releasing it)", async () => {
    const db = testEnv.authenticatedContext(CUTTER_UID).firestore();
    const snap = await assertSucceeds(
      getDocs(query(collection(db, "inventoryReservations"), where("orderId", "==", "order-cutting-started"), where("status", "==", "active"))),
    );
    if (snap.empty) throw new Error("expected to find the active reservation fixture");
  });

  it("cutter CAN perform the full legitimate transaction: consume stock, log movement, release reservation, land on 'ready'", async () => {
    const db = testEnv.authenticatedContext(CUTTER_UID).firestore();
    await assertSucceeds(
      runTransaction(db, async (tx) => {
        tx.update(doc(db, "materials", "mat-1"), { qtyOnHand: 8 });
        tx.set(doc(db, "inventoryMovements", "mv-cut-1"), {
          materialId: "mat-1",
          type: "cutting_consumption",
          qty: -2,
          orderId: "order-cutting-started",
          userId: CUTTER_UID,
          userName: "Cutter",
          balanceBefore: 10,
          balanceAfter: 8,
        });
        tx.update(doc(db, "orders", "order-cutting-started"), {
          productionStatus: "ready",
          cuttingConsumedAt: new Date(),
          cuttingConsumedMovementId: "mv-cut-1",
          confirmedSheets: 2,
        });
        tx.update(doc(db, "inventoryReservations", "res-1"), { status: "released" });
      }),
    );
  });

  it("cutter CANNOT create a movement of a type other than cutting_consumption", async () => {
    const db = testEnv.authenticatedContext(CUTTER_UID).firestore();
    await assertFails(
      setDoc(doc(db, "inventoryMovements", "mv-bad"), {
        materialId: "mat-1",
        type: "manual_correction",
        qty: 100,
        userId: CUTTER_UID,
        balanceBefore: 10,
        balanceAfter: 110,
      }),
    );
  });

  it("cutter CANNOT set cuttingConsumedAt without landing on an approved next status", async () => {
    const db = testEnv.authenticatedContext(CUTTER_UID).firestore();
    await assertFails(
      updateDoc(doc(db, "orders", "order-cutting-started"), {
        cuttingConsumedAt: new Date(),
        productionStatus: "delivered", // skipping straight to delivered — not a sanctioned transition
      }),
    );
  });

  it("cutter CANNOT edit a material's price while updating stock", async () => {
    const db = testEnv.authenticatedContext(CUTTER_UID).firestore();
    await assertFails(updateDoc(doc(db, "materials", "mat-1"), { qtyOnHand: 8, sellingPriceTiyn: 1 }));
  });
});

describe("cutter/PVC can list admin+manager accounts to fan out notifyManagers(), nothing broader", () => {
  it("cutter CAN list users filtered to role in [admin, manager]", async () => {
    const db = testEnv.authenticatedContext(CUTTER_UID).firestore();
    const snap = await assertSucceeds(
      getDocs(query(collection(db, "users"), where("role", "in", ["admin", "manager"]))),
    );
    const ids = snap.docs.map((d) => d.id);
    if (!ids.includes(ADMIN_UID) || !ids.includes(MANAGER_UID)) throw new Error("expected to see admin+manager fixtures");
  });

  it("cutter CANNOT list all users unfiltered", async () => {
    const db = testEnv.authenticatedContext(CUTTER_UID).firestore();
    await assertFails(getDocs(collection(db, "users")));
  });
});

describe("PVC worker cannot touch warehouse", () => {
  it("PVC worker cannot create an inventory movement", async () => {
    const db = testEnv.authenticatedContext(PVC_UID).firestore();
    await assertFails(
      setDoc(doc(db, "inventoryMovements", "mv-new"), {
        materialId: "mat-1",
        type: "manual_correction",
        qty: 5,
        userId: PVC_UID,
        balanceBefore: 10,
        balanceAfter: 15,
      }),
    );
  });

  it("PVC worker cannot read materials warehouse ledger", async () => {
    const db = testEnv.authenticatedContext(PVC_UID).firestore();
    await assertFails(getDoc(doc(db, "inventoryMovements", "mv-1")));
  });
});

describe("customers cannot forge admin/financial fields on their own order", () => {
  it("customer cannot set their own order's paidTiyn directly", async () => {
    const db = testEnv.authenticatedContext(CUSTOMER_A_UID).firestore();
    await setDoc(doc(db, "orders", "draft-1"), {
      customerId: CUSTOMER_A_UID,
      customerName: "A",
      customerPhone: "77771234567",
      materialId: "mat-1",
      productionStatus: "draft",
      paymentStatus: "unpaid",
      priority: 0,
      totalTiyn: 100000,
      paidTiyn: 0,
      debtTiyn: 100000,
      estimatedSheets: 1,
      pvcMetersTotal: 0,
    });
    await assertFails(updateDoc(doc(db, "orders", "draft-1"), { paidTiyn: 999999 }));
  });

  it("customer cannot assign themselves as the cutter", async () => {
    const db = testEnv.authenticatedContext(CUSTOMER_A_UID).firestore();
    await assertFails(updateDoc(doc(db, "orders", ORDER_A_ID), { assignedCutterId: CUSTOMER_A_UID }));
  });
});

describe("manager can review/price/pay orders but cannot manage users or audit history", () => {
  it("manager can move a submitted order into manager_review", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "orders", "order-submitted"), {
        customerId: CUSTOMER_A_UID,
        customerName: "A",
        customerPhone: "77771234567",
        materialId: "mat-1",
        productionStatus: "submitted",
        paymentStatus: "unpaid",
        priority: 0,
        totalTiyn: 0,
        paidTiyn: 0,
        debtTiyn: 0,
        estimatedSheets: 1,
        pvcMetersTotal: 0,
      });
    });
    const db = testEnv.authenticatedContext(MANAGER_UID).firestore();
    await assertSucceeds(
      updateDoc(doc(db, "orders", "order-submitted"), {
        productionStatus: "manager_review",
        assignedManagerId: MANAGER_UID,
        assignedManagerName: "Manager",
      }),
    );
  });

  it("manager can record a payment", async () => {
    const db = testEnv.authenticatedContext(MANAGER_UID).firestore();
    await assertSucceeds(
      setDoc(doc(db, "payments", "payment-new"), {
        orderId: ORDER_A_ID,
        amountTiyn: 1000,
        methodName: "Нал",
        recordedByUid: MANAGER_UID,
        reversed: false,
      }),
    );
  });

  it("manager CANNOT reverse a payment (admin-only)", async () => {
    const db = testEnv.authenticatedContext(MANAGER_UID).firestore();
    await assertFails(updateDoc(doc(db, "payments", "payment-1"), { reversed: true, reversalReason: "test" }));
  });

  it("manager CANNOT change another user's role", async () => {
    const db = testEnv.authenticatedContext(MANAGER_UID).firestore();
    await assertFails(updateDoc(doc(db, "users", CUTTER_UID), { role: "admin" }));
  });

  it("manager CANNOT block/unblock a user", async () => {
    const db = testEnv.authenticatedContext(MANAGER_UID).firestore();
    await assertFails(updateDoc(doc(db, "users", CUSTOMER_A_UID), { blocked: true }));
  });

  it("manager CANNOT read the audit log", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "auditLogs", "log-1"), { userId: MANAGER_UID, action: "test" });
    });
    const db = testEnv.authenticatedContext(MANAGER_UID).firestore();
    await assertFails(getDoc(doc(db, "auditLogs", "log-1")));
  });

  it("manager CANNOT delete an audit log entry (nobody can)", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "auditLogs", "log-1"), { userId: MANAGER_UID, action: "test" });
    });
    const db = testEnv.authenticatedContext(ADMIN_UID).firestore();
    // Even Admin cannot delete it — audit history is permanent per spec.
    const { deleteDoc } = await import("firebase/firestore");
    await assertFails(deleteDoc(doc(db, "auditLogs", "log-1")));
  });

  it("manager CANNOT edit material prices/specs", async () => {
    const db = testEnv.authenticatedContext(MANAGER_UID).firestore();
    await assertFails(updateDoc(doc(db, "materials", "mat-1"), { sellingPriceTiyn: 1 }));
  });
});

describe("manager creates walk-in orders in the journal, without bypassing the payment gate", () => {
  const walkIn = (overrides: Record<string, unknown> = {}) => ({
    orderNumber: "ORD-2026-000999",
    customerName: "Бақтияр",
    customerPhone: "77023334455",
    materialId: "mat-1",
    materialSnapshot: { name: "ЛДСП Ақ", sellingPriceTiyn: 1650000 },
    productionStatus: "waiting_payment",
    paymentStatus: "unpaid",
    priority: 0,
    estimatedSheets: 37,
    confirmedSheets: 37,
    pvcMetersTotal: 625,
    totalTiyn: 77925000,
    paidTiyn: 0,
    debtTiyn: 77925000,
    pricePublished: true,
    ...overrides,
  });

  it("manager CAN create a walk-in order with no customer account", async () => {
    const db = testEnv.authenticatedContext(MANAGER_UID).firestore();
    await assertSucceeds(setDoc(doc(db, "orders", "walkin-1"), walkIn()));
  });

  it("manager CANNOT create an order that is already paid (payments must go through recordPayment)", async () => {
    const db = testEnv.authenticatedContext(MANAGER_UID).firestore();
    await assertFails(
      setDoc(doc(db, "orders", "walkin-2"), walkIn({ paidTiyn: 77925000, paymentStatus: "paid", debtTiyn: 0 })),
    );
  });

  it("manager CANNOT create an order straight into the cutting queue", async () => {
    const db = testEnv.authenticatedContext(MANAGER_UID).firestore();
    await assertFails(setDoc(doc(db, "orders", "walkin-3"), walkIn({ productionStatus: "cutting_queue" })));
  });

  it("manager CANNOT create an order that is already marked ready", async () => {
    const db = testEnv.authenticatedContext(MANAGER_UID).firestore();
    await assertFails(setDoc(doc(db, "orders", "walkin-4"), walkIn({ productionStatus: "ready" })));
  });

  it("cutter CANNOT create an order at all", async () => {
    const db = testEnv.authenticatedContext(CUTTER_UID).firestore();
    await assertFails(setDoc(doc(db, "orders", "walkin-5"), walkIn()));
  });

  it("a customer CANNOT create an order in someone else's name", async () => {
    const db = testEnv.authenticatedContext(CUSTOMER_B_UID).firestore();
    await assertFails(
      setDoc(doc(db, "orders", "walkin-6"), walkIn({ customerId: CUSTOMER_A_UID, productionStatus: "submitted" })),
    );
  });
});

describe("invoices reach the right customer and nobody else", () => {
  const invoice = (overrides: Record<string, unknown> = {}) => ({
    orderId: ORDER_A_ID,
    orderNumber: "ORD-2026-000001",
    invoiceNumber: "INV-2026-00001",
    version: 1,
    customerId: CUSTOMER_A_UID,
    customerName: "A",
    customerPhone: "77771234567",
    lines: [{ name: "ЛДСП Ақ", qty: 6, unit: "лист", unitPriceTiyn: 1620000, totalTiyn: 9720000 }],
    subtotalTiyn: 9720000,
    discountTiyn: 0,
    totalTiyn: 9720000,
    paidTiyn: 0,
    debtTiyn: 9720000,
    paymentMethods: [],
    issuedByUid: MANAGER_UID,
    issuedByName: "Manager",
    sentToCustomer: false,
    ...overrides,
  });

  beforeEach(async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, "invoices", "inv-draft"), invoice());
      await setDoc(doc(db, "invoices", "inv-sent"), invoice({ sentToCustomer: true, invoiceNumber: "INV-2026-00002" }));
    });
  });

  it("manager CAN issue an invoice under their own name", async () => {
    const db = testEnv.authenticatedContext(MANAGER_UID).firestore();
    await assertSucceeds(setDoc(doc(db, "invoices", "inv-new"), invoice({ invoiceNumber: "INV-2026-00003" })));
  });

  it("the owning customer CAN read an invoice that has been sent to them", async () => {
    const db = testEnv.authenticatedContext(CUSTOMER_A_UID).firestore();
    await assertSucceeds(getDoc(doc(db, "invoices", "inv-sent")));
  });

  it("the owning customer CANNOT read a draft that has not been sent yet", async () => {
    const db = testEnv.authenticatedContext(CUSTOMER_A_UID).firestore();
    await assertFails(getDoc(doc(db, "invoices", "inv-draft")));
  });

  it("a different customer CANNOT read someone else's invoice", async () => {
    const db = testEnv.authenticatedContext(CUSTOMER_B_UID).firestore();
    await assertFails(getDoc(doc(db, "invoices", "inv-sent")));
  });

  it("a customer's own filtered query succeeds; an unfiltered one does not", async () => {
    const db = testEnv.authenticatedContext(CUSTOMER_A_UID).firestore();
    await assertSucceeds(
      getDocs(
        query(
          collection(db, "invoices"),
          where("customerId", "==", CUSTOMER_A_UID),
          where("sentToCustomer", "==", true),
        ),
      ),
    );
    await assertFails(getDocs(collection(db, "invoices")));
  });

  it("a cutter CANNOT read invoices at all", async () => {
    const db = testEnv.authenticatedContext(CUTTER_UID).firestore();
    await assertFails(getDoc(doc(db, "invoices", "inv-sent")));
  });

  it("the frozen financial snapshot cannot be edited — only the send flag may change", async () => {
    const db = testEnv.authenticatedContext(MANAGER_UID).firestore();
    await assertSucceeds(updateDoc(doc(db, "invoices", "inv-draft"), { sentToCustomer: true }));
    await assertFails(updateDoc(doc(db, "invoices", "inv-draft"), { totalTiyn: 1 }));
    await assertFails(updateDoc(doc(db, "invoices", "inv-draft"), { lines: [] }));
  });

  it("an invoice can never be deleted", async () => {
    const db = testEnv.authenticatedContext(ADMIN_UID).firestore();
    const { deleteDoc } = await import("firebase/firestore");
    await assertFails(deleteDoc(doc(db, "invoices", "inv-sent")));
  });

  it("a customer CANNOT forge an invoice for themselves", async () => {
    const db = testEnv.authenticatedContext(CUSTOMER_A_UID).firestore();
    await assertFails(
      setDoc(doc(db, "invoices", "inv-forged"), invoice({ issuedByUid: CUSTOMER_A_UID, debtTiyn: 0, paidTiyn: 9720000 })),
    );
  });
});

describe("attendance is visible only to the worker it belongs to, and to Admin", () => {
  beforeEach(async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, "attendance", `${CUTTER_UID}_2026-03-02`), {
        userId: CUTTER_UID, userName: "Cutter", date: "2026-03-02", status: "present",
        recordedByUid: ADMIN_UID, recordedByName: "Admin",
      });
      await setDoc(doc(db, "attendance", `${PVC_UID}_2026-03-02`), {
        userId: PVC_UID, userName: "PVC", date: "2026-03-02", status: "absent",
        recordedByUid: ADMIN_UID, recordedByName: "Admin",
      });
    });
  });

  it("a worker CAN read their own attendance record", async () => {
    const db = testEnv.authenticatedContext(CUTTER_UID).firestore();
    await assertSucceeds(getDoc(doc(db, "attendance", `${CUTTER_UID}_2026-03-02`)));
  });

  it("a worker CANNOT read another worker's attendance", async () => {
    const db = testEnv.authenticatedContext(CUTTER_UID).firestore();
    await assertFails(getDoc(doc(db, "attendance", `${PVC_UID}_2026-03-02`)));
  });

  it("a worker's own filtered attendance query succeeds; an unfiltered one does not", async () => {
    const db = testEnv.authenticatedContext(CUTTER_UID).firestore();
    await assertSucceeds(getDocs(query(collection(db, "attendance"), where("userId", "==", CUTTER_UID))));
    await assertFails(getDocs(collection(db, "attendance")));
  });

  it("a worker CANNOT mark their own attendance — only Admin records it", async () => {
    const db = testEnv.authenticatedContext(CUTTER_UID).firestore();
    await assertFails(
      setDoc(doc(db, "attendance", `${CUTTER_UID}_2026-03-03`), {
        userId: CUTTER_UID, userName: "Cutter", date: "2026-03-03", status: "present",
        recordedByUid: CUTTER_UID, recordedByName: "Cutter",
      }),
    );
  });

  it("admin CAN mark attendance and read everyone's", async () => {
    const db = testEnv.authenticatedContext(ADMIN_UID).firestore();
    await assertSucceeds(
      setDoc(doc(db, "attendance", `${PVC_UID}_2026-03-04`), {
        userId: PVC_UID, userName: "PVC", date: "2026-03-04", status: "late",
        recordedByUid: ADMIN_UID, recordedByName: "Admin",
      }),
    );
    await assertSucceeds(getDocs(collection(db, "attendance")));
  });
});

describe("a worker sees only their own salary", () => {
  beforeEach(async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, "salaryEntries", `${CUTTER_UID}_2026-03`), {
        userId: CUTTER_UID, userName: "Cutter", periodKey: "2026-03", mode: "MANUAL",
        baseTiyn: 0, finalTiyn: 18000000, status: "calculated",
        sheetsCut: 40, pvcMeters: 0, ordersCompleted: 5, presentDays: 20, absentDays: 0, workedHours: 160,
        bonusTiyn: 0, deductionTiyn: 0, adjustmentTiyn: 18000000,
      });
      await setDoc(doc(db, "salaryEntries", `${PVC_UID}_2026-03`), {
        userId: PVC_UID, userName: "PVC", periodKey: "2026-03", mode: "MANUAL",
        baseTiyn: 0, finalTiyn: 15000000, status: "calculated",
        sheetsCut: 0, pvcMeters: 300, ordersCompleted: 4, presentDays: 20, absentDays: 0, workedHours: 160,
        bonusTiyn: 0, deductionTiyn: 0, adjustmentTiyn: 15000000,
      });
      await setDoc(doc(db, "salaryRules", CUTTER_UID), { userId: CUTTER_UID, mode: "MANUAL" });
    });
  });

  it("a worker CAN read their own salary entry", async () => {
    const db = testEnv.authenticatedContext(CUTTER_UID).firestore();
    await assertSucceeds(getDoc(doc(db, "salaryEntries", `${CUTTER_UID}_2026-03`)));
  });

  it("a worker CANNOT read a colleague's salary entry", async () => {
    const db = testEnv.authenticatedContext(CUTTER_UID).firestore();
    await assertFails(getDoc(doc(db, "salaryEntries", `${PVC_UID}_2026-03`)));
  });

  it("a worker CANNOT list every salary entry", async () => {
    const db = testEnv.authenticatedContext(CUTTER_UID).firestore();
    await assertFails(getDocs(collection(db, "salaryEntries")));
  });

  it("a manager CANNOT read a worker's salary either", async () => {
    const db = testEnv.authenticatedContext(MANAGER_UID).firestore();
    await assertFails(getDoc(doc(db, "salaryEntries", `${CUTTER_UID}_2026-03`)));
  });

  it("a worker CANNOT edit their own salary", async () => {
    const db = testEnv.authenticatedContext(CUTTER_UID).firestore();
    await assertFails(updateDoc(doc(db, "salaryEntries", `${CUTTER_UID}_2026-03`), { finalTiyn: 99900000 }));
  });

  it("a worker CAN read their own pay rule but CANNOT change it", async () => {
    const db = testEnv.authenticatedContext(CUTTER_UID).firestore();
    await assertSucceeds(getDoc(doc(db, "salaryRules", CUTTER_UID)));
    await assertFails(updateDoc(doc(db, "salaryRules", CUTTER_UID), { mode: "FIXED_MONTHLY", fixedMonthlyTiyn: 99900000 }));
  });

  it("admin CAN read and write every salary entry", async () => {
    const db = testEnv.authenticatedContext(ADMIN_UID).firestore();
    await assertSucceeds(getDocs(collection(db, "salaryEntries")));
    await assertSucceeds(updateDoc(doc(db, "salaryEntries", `${CUTTER_UID}_2026-03`), { status: "confirmed" }));
  });
});

describe("salary adjustments always carry a reason and are never rewritten", () => {
  it("admin CAN create an adjustment with a reason", async () => {
    const db = testEnv.authenticatedContext(ADMIN_UID).firestore();
    await assertSucceeds(
      setDoc(doc(db, "salaryAdjustments", "adj-1"), {
        userId: CUTTER_UID, periodKey: "2026-03", amountTiyn: 5000000,
        reason: "Наурыз айындағы бонус", createdByUid: ADMIN_UID, createdByName: "Admin",
      }),
    );
  });

  it("an adjustment with an empty reason is refused", async () => {
    const db = testEnv.authenticatedContext(ADMIN_UID).firestore();
    await assertFails(
      setDoc(doc(db, "salaryAdjustments", "adj-2"), {
        userId: CUTTER_UID, periodKey: "2026-03", amountTiyn: 5000000,
        reason: "", createdByUid: ADMIN_UID, createdByName: "Admin",
      }),
    );
  });

  it("nobody can edit or delete an adjustment once written — corrections are new entries", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "salaryAdjustments", "adj-3"), {
        userId: CUTTER_UID, periodKey: "2026-03", amountTiyn: 5000000,
        reason: "Бонус", createdByUid: ADMIN_UID, createdByName: "Admin",
      });
    });
    const db = testEnv.authenticatedContext(ADMIN_UID).firestore();
    const { deleteDoc } = await import("firebase/firestore");
    await assertFails(updateDoc(doc(db, "salaryAdjustments", "adj-3"), { amountTiyn: 1 }));
    await assertFails(deleteDoc(doc(db, "salaryAdjustments", "adj-3")));
  });

  it("a manager CANNOT create a salary adjustment", async () => {
    const db = testEnv.authenticatedContext(MANAGER_UID).firestore();
    await assertFails(
      setDoc(doc(db, "salaryAdjustments", "adj-4"), {
        userId: CUTTER_UID, periodKey: "2026-03", amountTiyn: 5000000,
        reason: "Бонус", createdByUid: MANAGER_UID, createdByName: "Manager",
      }),
    );
  });
});

describe("PVC stock: the roll is drawn down by work, never repriced by it", () => {
  beforeEach(async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "pvcTypes", "pvc-1-white"), {
        colorName: "Ақ", thicknessMm: 1, pricePerMeterTiyn: 20000,
        active: true, metersOnHand: 100, minStockMeters: 20,
      });
    });
  });

  it("a PVC worker CAN draw the roll down when finishing a job", async () => {
    const db = testEnv.authenticatedContext(PVC_UID).firestore();
    await assertSucceeds(updateDoc(doc(db, "pvcTypes", "pvc-1-white"), { metersOnHand: 88 }));
  });

  it("a manager CAN receive new stock", async () => {
    const db = testEnv.authenticatedContext(MANAGER_UID).firestore();
    await assertSucceeds(updateDoc(doc(db, "pvcTypes", "pvc-1-white"), { metersOnHand: 300 }));
  });

  it("neither may change the price, the colour or whether it is active", async () => {
    const pvc = testEnv.authenticatedContext(PVC_UID).firestore();
    await assertFails(updateDoc(doc(pvc, "pvcTypes", "pvc-1-white"), { pricePerMeterTiyn: 1 }));
    await assertFails(updateDoc(doc(pvc, "pvcTypes", "pvc-1-white"), { colorName: "Қара" }));
    await assertFails(updateDoc(doc(pvc, "pvcTypes", "pvc-1-white"), { active: false }));
    const mgr = testEnv.authenticatedContext(MANAGER_UID).firestore();
    await assertFails(updateDoc(doc(mgr, "pvcTypes", "pvc-1-white"), { pricePerMeterTiyn: 1 }));
    // The floor is a purchasing decision, so it stays Admin-only too.
    await assertFails(updateDoc(doc(mgr, "pvcTypes", "pvc-1-white"), { minStockMeters: 0 }));
  });

  it("a cutter has no business touching edge banding", async () => {
    const db = testEnv.authenticatedContext(CUTTER_UID).firestore();
    await assertFails(updateDoc(doc(db, "pvcTypes", "pvc-1-white"), { metersOnHand: 5 }));
  });

  it("a customer can neither read an archived colour nor write any", async () => {
    const db = testEnv.authenticatedContext(CUSTOMER_A_UID).firestore();
    await assertFails(updateDoc(doc(db, "pvcTypes", "pvc-1-white"), { metersOnHand: 5 }));
  });

  it("an admin may still change everything", async () => {
    const db = testEnv.authenticatedContext(ADMIN_UID).firestore();
    await assertSucceeds(
      updateDoc(doc(db, "pvcTypes", "pvc-1-white"), { pricePerMeterTiyn: 22000, minStockMeters: 30 }),
    );
  });
});

describe("advances: the manager hands them over, the worker sees their own, nobody edits the amount", () => {
  const advance = (over = {}) => ({
    userId: CUTTER_UID, userName: "Cutter", periodKey: "2026-08", amountTiyn: 5000000,
    recordedByUid: MANAGER_UID, recordedByName: "Manager", ...over,
  });

  it("a manager CAN record an advance — unlike a salary adjustment, which is Admin-only", async () => {
    const db = testEnv.authenticatedContext(MANAGER_UID).firestore();
    await assertSucceeds(setDoc(doc(db, "advances", "adv-1"), advance()));
  });

  it("an admin can record one too", async () => {
    const db = testEnv.authenticatedContext(ADMIN_UID).firestore();
    await assertSucceeds(
      setDoc(doc(db, "advances", "adv-2"), advance({ recordedByUid: ADMIN_UID, recordedByName: "Admin" })),
    );
  });

  it("the recorder cannot be attributed to someone else", async () => {
    const db = testEnv.authenticatedContext(MANAGER_UID).firestore();
    await assertFails(setDoc(doc(db, "advances", "adv-3"), advance({ recordedByUid: ADMIN_UID })));
  });

  it("a zero or negative advance is refused", async () => {
    const db = testEnv.authenticatedContext(MANAGER_UID).firestore();
    await assertFails(setDoc(doc(db, "advances", "adv-4"), advance({ amountTiyn: 0 })));
    await assertFails(setDoc(doc(db, "advances", "adv-5"), advance({ amountTiyn: -5000000 })));
  });

  it("a worker cannot record an advance for themselves", async () => {
    const db = testEnv.authenticatedContext(CUTTER_UID).firestore();
    await assertFails(
      setDoc(doc(db, "advances", "adv-6"), advance({ recordedByUid: CUTTER_UID, recordedByName: "Cutter" })),
    );
  });

  it("a worker CAN read their own advances", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "advances", "adv-7"), advance());
    });
    const db = testEnv.authenticatedContext(CUTTER_UID).firestore();
    await assertSucceeds(getDoc(doc(db, "advances", "adv-7")));
    await assertSucceeds(getDocs(query(collection(db, "advances"), where("userId", "==", CUTTER_UID))));
  });

  it("a worker CANNOT read another worker's advances", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "advances", "adv-8"), advance({ userId: PVC_UID }));
    });
    const db = testEnv.authenticatedContext(CUTTER_UID).firestore();
    await assertFails(getDoc(doc(db, "advances", "adv-8")));
    // An unfiltered list must fail too, or one query would leak the whole collection.
    await assertFails(getDocs(collection(db, "advances")));
  });

  it("the amount can never be edited, even by an admin reversing it", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "advances", "adv-9"), advance());
    });
    const db = testEnv.authenticatedContext(ADMIN_UID).firestore();
    await assertSucceeds(updateDoc(doc(db, "advances", "adv-9"), { reversed: true, reversalReason: "Қате" }));
    await assertFails(updateDoc(doc(db, "advances", "adv-9"), { amountTiyn: 1 }));
  });

  it("a manager cannot reverse, and nobody can delete", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "advances", "adv-10"), advance());
    });
    const { deleteDoc } = await import("firebase/firestore");
    const mgr = testEnv.authenticatedContext(MANAGER_UID).firestore();
    await assertFails(updateDoc(doc(mgr, "advances", "adv-10"), { reversed: true }));
    const admin = testEnv.authenticatedContext(ADMIN_UID).firestore();
    await assertFails(deleteDoc(doc(admin, "advances", "adv-10")));
  });
});

describe("public workshop board hides customer identities", () => {
  beforeEach(async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "workshopActivity", "order-cutting-started"), {
        orderNumber: "ORD-2026-000010", stage: "cutting", queuePosition: 0,
        needsPvc: false, estimatedMinutes: 20, startedAt: null,
      });
    });
  });

  it("any signed-in customer CAN read the board, including rows for other customers' orders", async () => {
    const db = testEnv.authenticatedContext(CUSTOMER_B_UID).firestore();
    const snap = await assertSucceeds(getDocs(collection(db, "workshopActivity")));
    // The row exists and carries no identifying fields — that is what makes it safe to share.
    const row = snap.docs[0].data();
    for (const forbidden of ["customerId", "customerName", "customerPhone", "totalTiyn", "paidTiyn", "debtTiyn"]) {
      if (forbidden in row) throw new Error(`workshopActivity leaked "${forbidden}"`);
    }
  });

  it("a customer CANNOT write to the board", async () => {
    const db = testEnv.authenticatedContext(CUSTOMER_B_UID).firestore();
    await assertFails(setDoc(doc(db, "workshopActivity", "forged"), { orderNumber: "X", stage: "ready" }));
  });

  it("an unauthenticated visitor CANNOT read the board", async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDocs(collection(db, "workshopActivity")));
  });
});

describe("admin has full access", () => {
  it("admin can read any order", async () => {
    const db = testEnv.authenticatedContext(ADMIN_UID).firestore();
    await assertSucceeds(getDoc(doc(db, "orders", ORDER_A_ID)));
  });

  it("admin can record a payment", async () => {
    const db = testEnv.authenticatedContext(ADMIN_UID).firestore();
    await assertSucceeds(
      setDoc(doc(db, "payments", "payment-new"), {
        orderId: ORDER_A_ID,
        amountTiyn: 1000,
        methodName: "Нал",
        recordedByUid: ADMIN_UID,
        reversed: false,
      }),
    );
  });

  it("blocked admin loses access", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), "users", ADMIN_UID), { blocked: true });
    });
    const db = testEnv.authenticatedContext(ADMIN_UID).firestore();
    await assertFails(getDoc(doc(db, "orders", ORDER_A_ID)));
  });
});
