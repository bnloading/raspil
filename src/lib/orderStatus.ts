import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  runTransaction,
  serverTimestamp,
  Timestamp,
  updateDoc,
  where,
  type Firestore,
} from "firebase/firestore";
import type { User } from "firebase/auth";
import type { Material, Order, UserDoc } from "../types/domain";
import { canEnterCuttingQueue } from "./statuses";
import { reserveStock, releaseReservation, consumeForCutting } from "./warehouse";
import { syncWorkshopBoard, clearWorkshopBoard } from "./workshopActivity";

type Actor = { user: User; userData: UserDoc };

async function writeStatusHistory(
  db: Firestore,
  actor: Actor,
  orderId: string,
  field: "production" | "payment",
  prevStatus: string,
  newStatus: string,
  comment?: string,
  estimatedMinutes?: number,
) {
  await addDoc(collection(db, "orders", orderId, "statusHistory"), {
    field,
    prevStatus,
    newStatus,
    userId: actor.user.uid,
    userName: actor.userData.name,
    comment: comment ?? "",
    ...(estimatedMinutes !== undefined ? { estimatedMinutes } : {}),
    createdAt: serverTimestamp(),
  });
}

async function notify(db: Firestore, userId: string | undefined, title: string, body: string, orderId: string) {
  if (!userId) return;
  await addDoc(collection(db, "notifications"), {
    userId,
    type: "order_status",
    title,
    body,
    orderId,
    read: false,
    createdAt: serverTimestamp(),
  });
}

/** Notifies every non-blocked admin+manager — used for the "Notify Manager" steps the spec
 *  requires on every worker action, since any manager (not just the one assigned) should see it. */
async function notifyManagers(db: Firestore, title: string, body: string, orderId: string) {
  const snap = await getDocs(query(collection(db, "users"), where("role", "in", ["admin", "manager"])));
  await Promise.all(
    snap.docs
      .filter((d) => !d.data().blocked)
      .map((d) => notify(db, d.id, title, body, orderId)),
  );
}

async function logAudit(
  db: Firestore,
  actor: Actor,
  entry: { action: string; entityId: string; before?: Record<string, unknown>; after?: Record<string, unknown>; comment?: string },
) {
  await addDoc(collection(db, "auditLogs"), {
    userId: actor.user.uid,
    userName: actor.userData.name,
    action: entry.action,
    entityType: "order",
    entityId: entry.entityId,
    before: entry.before ?? null,
    after: entry.after ?? null,
    comment: entry.comment ?? "",
    createdAt: serverTimestamp(),
  });
}

/** Step 3-4 of the strict workflow: a Manager (or Admin) picks up a freshly submitted order. */
export async function startManagerReview(db: Firestore, actor: Actor, order: Order): Promise<void> {
  const orderRef = doc(db, "orders", order.id);
  await updateDoc(orderRef, {
    productionStatus: "manager_review",
    assignedManagerId: actor.user.uid,
    assignedManagerName: actor.userData.name,
    managerAcceptedAt: serverTimestamp(),
  });
  await writeStatusHistory(db, actor, order.id, "production", order.productionStatus, "manager_review");
  await logAudit(db, actor, { action: "order.manager_accept", entityId: order.id });
  await notify(db, order.customerId, "Заказ қабылданды", `${order.orderNumber} менеджерге жіберілді`, order.id);
}

/**
 * Step 5a: Manager corrects the specification and computes the exact total (still a draft/internal
 * number — the customer does not see it until publishPrice). Every call records the previous vs new
 * total in the audit trail with the given reason, per spec ("every price correction... previous
 * price, new price, ... reason").
 */
export async function calculatePrice(
  db: Firestore,
  actor: Actor,
  order: Order,
  breakdown: {
    materialCostTiyn: number;
    cuttingCostTiyn: number;
    pvcCostTiyn: number;
    hdfCostTiyn: number;
    extraServicesTiyn: number;
    deliveryCostTiyn: number;
    discountTiyn: number;
    totalTiyn: number;
  },
  reason?: string,
): Promise<void> {
  const orderRef = doc(db, "orders", order.id);
  const prevTotal = order.totalTiyn;
  await updateDoc(orderRef, {
    ...breakdown,
    debtTiyn: breakdown.totalTiyn - order.paidTiyn,
    productionStatus: order.productionStatus === "manager_review" ? "price_calculated" : order.productionStatus,
  });
  if (order.productionStatus === "manager_review") {
    await writeStatusHistory(db, actor, order.id, "production", order.productionStatus, "price_calculated");
  }
  if (prevTotal !== breakdown.totalTiyn) {
    await logAudit(db, actor, {
      action: "order.price_change",
      entityId: order.id,
      before: { totalTiyn: prevTotal },
      after: { totalTiyn: breakdown.totalTiyn },
      comment: reason ?? "",
    });
  }
}

/** Step 5b: "Бағаны клиентке жіберу" — the price becomes visible/authoritative to the customer. */
export async function publishPrice(db: Firestore, actor: Actor, order: Order): Promise<void> {
  const orderRef = doc(db, "orders", order.id);
  await updateDoc(orderRef, {
    pricePublished: true,
    pricePublishedAt: serverTimestamp(),
    pricePublishedByUid: actor.user.uid,
    pricePublishedByName: actor.userData.name,
    productionStatus: "waiting_payment",
  });
  await writeStatusHistory(db, actor, order.id, "production", order.productionStatus, "waiting_payment");
  await logAudit(db, actor, { action: "order.price_published", entityId: order.id, after: { totalTiyn: order.totalTiyn } });
  await notify(db, order.customerId, "Баға есептелді", `${order.orderNumber} үшін соңғы баға жарияланды`, order.id);
}

/**
 * Step 8: the one hard gate of the whole workflow — only PAID (or approved OVERPAID) orders may
 * enter the cutting queue. `overrideReason` lets an Admin bypass this, but ONLY when explicitly
 * provided (the UI must require a confirmation dialog + a typed reason first — see AdminOrderDetail);
 * every override is permanently audited, unpaid or not.
 */
export async function enterCuttingQueue(
  db: Firestore,
  actor: Actor,
  order: Order,
  opts: { isAdmin: boolean; overrideReason?: string; queuePosition: number },
): Promise<void> {
  const gateOk = canEnterCuttingQueue(order.paymentStatus);
  if (!gateOk) {
    if (!opts.isAdmin || !opts.overrideReason?.trim()) {
      throw new Error("Тек толық төленген заказды кезекке қоюға болады");
    }
  }

  const orderRef = doc(db, "orders", order.id);
  await reserveStock(db, actor, {
    materialId: order.materialId,
    orderId: order.id,
    qty: order.confirmedSheets ?? order.estimatedSheets,
    comment: `Заказ ${order.orderNumber} распил кезегіне қосылды`,
  });
  await updateDoc(orderRef, {
    productionStatus: "cutting_queue",
    priority: opts.queuePosition,
    cuttingQueuedAt: serverTimestamp(),
    ...(!gateOk ? { paymentGateOverride: true, paymentGateOverrideReason: opts.overrideReason } : {}),
  });
  await writeStatusHistory(db, actor, order.id, "production", order.productionStatus, "cutting_queue", !gateOk ? opts.overrideReason : undefined);

  if (!gateOk) {
    await logAudit(db, actor, {
      action: "order.payment_gate_override",
      entityId: order.id,
      before: { paymentStatus: order.paymentStatus },
      comment: opts.overrideReason,
    });
  }
  await logAudit(db, actor, { action: "order.sent_to_cutting", entityId: order.id });
  // The order is now on the shop floor — it appears on the public workshop board from here on.
  await syncWorkshopBoard(db, {
    ...order,
    productionStatus: "cutting_queue",
    priority: opts.queuePosition,
  });
  await notify(db, order.customerId, "Распил кезегіне қосылды", `${order.orderNumber} распил кезегінде`, order.id);
}

/** Step 10: cutter starts work — records the actor/start-time and the chosen estimate together. */
export async function startCutting(
  db: Firestore,
  actor: Actor,
  order: Order,
  estimatedMinutes: number,
): Promise<void> {
  const orderRef = doc(db, "orders", order.id);
  const expected = new Date(Date.now() + estimatedMinutes * 60000);
  await updateDoc(orderRef, {
    productionStatus: "cutting_started",
    assignedCutterId: order.assignedCutterId || actor.user.uid,
    assignedCutterName: order.assignedCutterName || actor.userData.name,
    cuttingStartedAt: serverTimestamp(),
    cuttingEstimatedMinutes: estimatedMinutes,
    cuttingExpectedCompletionAt: expected,
  });
  await writeStatusHistory(db, actor, order.id, "production", order.productionStatus, "cutting_started", undefined, estimatedMinutes);
  await syncWorkshopBoard(db, {
    ...order,
    productionStatus: "cutting_started",
    cuttingEstimatedMinutes: estimatedMinutes,
    cuttingStartedAt: Timestamp.fromDate(new Date()),
  });
  await notifyManagers(db, "Распил басталды", `${order.orderNumber}: распил басталды (шамамен ${estimatedMinutes} мин)`, order.id);
  await notify(db, order.customerId, "Распил басталды", `${order.orderNumber} кесіліп жатыр`, order.id);
}

/** Updates just the estimate/expected-completion of an already-started cutting job (spec: "Estimated
 *  cutting time updated" notification + audit entry for "Estimated time changed"). */
export async function updateCuttingEstimate(db: Firestore, actor: Actor, order: Order, estimatedMinutes: number): Promise<void> {
  const orderRef = doc(db, "orders", order.id);
  const expected = new Date(Date.now() + estimatedMinutes * 60000);
  await updateDoc(orderRef, { cuttingEstimatedMinutes: estimatedMinutes, cuttingExpectedCompletionAt: expected });
  await logAudit(db, actor, {
    action: "order.cutting_estimate_change",
    entityId: order.id,
    before: { cuttingEstimatedMinutes: order.cuttingEstimatedMinutes ?? null },
    after: { cuttingEstimatedMinutes: estimatedMinutes },
  });
  await syncWorkshopBoard(db, { ...order, cuttingEstimatedMinutes: estimatedMinutes });
  await notifyManagers(db, "Распил мерзімі өзгерді", `${order.orderNumber}: жаңа болжам ${estimatedMinutes} мин`, order.id);
  await notify(db, order.customerId, "Распил мерзімі жаңартылды", `${order.orderNumber} шамамен ${estimatedMinutes} минутта аяқталады`, order.id);
}

/**
 * Step 11-12: cutter finishes — delegates the stock decrement + idempotency guard + PVC/READY
 * branch to warehouse.consumeForCutting (one transaction), then records the supplementary
 * (non-safety-critical) history/notifications. `needsPvc` must be computed by the caller from the
 * order's parts (any edge PVC-selected) — see components/OrderView "needsPvc" for the existing pattern.
 */
export async function completeCutting(
  db: Firestore,
  actor: Actor,
  order: Order,
  confirmedSheets: number,
  needsPvc: boolean,
): Promise<{ alreadyConsumed: boolean }> {
  const activeRes = await getDocs(
    query(collection(db, "inventoryReservations"), where("orderId", "==", order.id), where("status", "==", "active")),
  );
  const reservationId = activeRes.docs[0]?.id;

  const result = await consumeForCutting(db, actor, {
    orderId: order.id,
    materialId: order.materialId,
    qty: confirmedSheets,
    reservationId,
    needsPvc,
    cuttingStartedAtMs: order.cuttingStartedAt ? order.cuttingStartedAt.toMillis() : undefined,
  });
  if (result.alreadyConsumed) return result;

  const nextStatus = needsPvc ? "pvc_queue" : "ready";
  await writeStatusHistory(db, actor, order.id, "production", "cutting_started", "cutting_completed");
  await writeStatusHistory(db, actor, order.id, "production", "cutting_completed", nextStatus);
  await logAudit(db, actor, { action: "order.cutting_completed", entityId: order.id, after: { confirmedSheets } });
  // Cutting is done: the board row moves to "waiting for PVC" or "ready" depending on the order.
  await syncWorkshopBoard(db, { ...order, productionStatus: nextStatus });
  await notifyManagers(db, "Распил аяқталды", `${order.orderNumber}: распил аяқталды`, order.id);
  await notify(
    db,
    order.customerId,
    needsPvc ? "Распил аяқталды" : "Заказыңыз дайын",
    needsPvc ? `${order.orderNumber} ПВХ кезегіне өтті` : `${order.orderNumber} дайын болды`,
    order.id,
  );
  await notifyIfLowStock(db, order.materialId);
  return result;
}

/** Step 13: PVC worker starts — same shape as startCutting. */
export async function startPvc(db: Firestore, actor: Actor, order: Order, estimatedMinutes: number): Promise<void> {
  const orderRef = doc(db, "orders", order.id);
  const expected = new Date(Date.now() + estimatedMinutes * 60000);
  await updateDoc(orderRef, {
    productionStatus: "pvc_started",
    assignedPvcId: order.assignedPvcId || actor.user.uid,
    assignedPvcName: order.assignedPvcName || actor.userData.name,
    pvcStartedAt: serverTimestamp(),
    pvcEstimatedMinutes: estimatedMinutes,
    pvcExpectedCompletionAt: expected,
  });
  await writeStatusHistory(db, actor, order.id, "production", order.productionStatus, "pvc_started", undefined, estimatedMinutes);
  await syncWorkshopBoard(db, {
    ...order,
    productionStatus: "pvc_started",
    pvcEstimatedMinutes: estimatedMinutes,
    pvcStartedAt: Timestamp.fromDate(new Date()),
  });
  await notifyManagers(db, "ПВХ басталды", `${order.orderNumber}: ПВХ жұмысы басталды (шамамен ${estimatedMinutes} мин)`, order.id);
  await notify(db, order.customerId, "ПВХ басталды", `${order.orderNumber} ПВХ жасалып жатыр`, order.id);
}

export async function updatePvcEstimate(db: Firestore, actor: Actor, order: Order, estimatedMinutes: number): Promise<void> {
  const orderRef = doc(db, "orders", order.id);
  const expected = new Date(Date.now() + estimatedMinutes * 60000);
  await updateDoc(orderRef, { pvcEstimatedMinutes: estimatedMinutes, pvcExpectedCompletionAt: expected });
  await logAudit(db, actor, {
    action: "order.pvc_estimate_change",
    entityId: order.id,
    before: { pvcEstimatedMinutes: order.pvcEstimatedMinutes ?? null },
    after: { pvcEstimatedMinutes: estimatedMinutes },
  });
  await syncWorkshopBoard(db, { ...order, pvcEstimatedMinutes: estimatedMinutes });
  await notifyManagers(db, "ПВХ мерзімі өзгерді", `${order.orderNumber}: жаңа болжам ${estimatedMinutes} мин`, order.id);
  await notify(db, order.customerId, "ПВХ мерзімі жаңартылды", `${order.orderNumber} шамамен ${estimatedMinutes} минутта аяқталады`, order.id);
}

/** Step 14-15: PVC worker finishes — idempotent (guarded by pvcCompletedAt), always ends in READY. */
export async function completePvc(db: Firestore, actor: Actor, order: Order): Promise<{ alreadyCompleted: boolean }> {
  const orderRef = doc(db, "orders", order.id);
  const result = await runTransaction(db, async (tx) => {
    const snap = await tx.get(orderRef);
    if (!snap.exists()) throw new Error("Заказ табылмады");
    if (snap.data().pvcCompletedAt) return { alreadyCompleted: true };

    const now = new Date();
    const startedAtMs = order.pvcStartedAt ? order.pvcStartedAt.toMillis() : undefined;
    const actualMinutes = startedAtMs ? Math.max(0, Math.round((now.getTime() - startedAtMs) / 60000)) : undefined;

    tx.update(orderRef, {
      productionStatus: "ready",
      pvcCompletedAt: serverTimestamp(),
      readyAt: serverTimestamp(),
      ...(actualMinutes !== undefined ? { pvcActualMinutes: actualMinutes } : {}),
    });
    return { alreadyCompleted: false };
  });
  if (result.alreadyCompleted) return result;

  await writeStatusHistory(db, actor, order.id, "production", "pvc_started", "pvc_completed");
  await writeStatusHistory(db, actor, order.id, "production", "pvc_completed", "ready");
  await logAudit(db, actor, { action: "order.pvc_completed", entityId: order.id });
  // Stays on the board as "Дайын" (green) until the Manager hands it over — that's the state the
  // customer most wants to see, and markDelivered() is what finally removes the row.
  await syncWorkshopBoard(db, { ...order, productionStatus: "ready" });
  await notifyManagers(db, "ПВХ аяқталды", `${order.orderNumber}: ПВХ жұмысы аяқталды, заказ дайын`, order.id);
  await notify(db, order.customerId, "Заказыңыз дайын", `${order.orderNumber} толығымен дайын!`, order.id);
  return result;
}

/** Step 16: Manager hands the finished order over to the customer. */
export async function markDelivered(db: Firestore, actor: Actor, order: Order): Promise<void> {
  const orderRef = doc(db, "orders", order.id);
  await updateDoc(orderRef, { productionStatus: "delivered", deliveredAt: serverTimestamp() });
  await writeStatusHistory(db, actor, order.id, "production", order.productionStatus, "delivered");
  await logAudit(db, actor, { action: "order.delivered", entityId: order.id });
  await clearWorkshopBoard(db, order.id); // handed over — it has left the shop floor
  await notify(db, order.customerId, "Заказ берілді", `${order.orderNumber} сізге берілді`, order.id);
}

/** Cancels/rejects an order (any pre-cutting stage) — releases any active stock reservation. */
export async function cancelOrder(db: Firestore, actor: Actor, order: Order, reason: string): Promise<void> {
  const orderRef = doc(db, "orders", order.id);
  await updateDoc(orderRef, { productionStatus: "cancelled", cancelledAt: serverTimestamp(), cancelReason: reason });
  await writeStatusHistory(db, actor, order.id, "production", order.productionStatus, "cancelled", reason);

  const activeRes = await getDocs(
    query(collection(db, "inventoryReservations"), where("orderId", "==", order.id), where("status", "==", "active")),
  );
  for (const resDoc of activeRes.docs) {
    await releaseReservation(db, actor, { reservationId: resDoc.id, comment: "Заказ бас тартылды" });
  }
  await logAudit(db, actor, { action: "order.cancelled", entityId: order.id, comment: reason });
  await clearWorkshopBoard(db, order.id);
  await notify(db, order.customerId, "Заказ бас тартылды", `${order.orderNumber}: ${reason}`, order.id);
}

/** Assigns the cutter and/or PVC worker for an order (Manager/Admin action). */
export async function assignWorkers(
  db: Firestore,
  actor: Actor,
  orderId: string,
  assignment: { cutterId?: string; cutterName?: string; pvcId?: string; pvcName?: string },
): Promise<void> {
  const updates: Record<string, unknown> = {};
  if (assignment.cutterId !== undefined) {
    updates.assignedCutterId = assignment.cutterId || null;
    updates.assignedCutterName = assignment.cutterName || null;
  }
  if (assignment.pvcId !== undefined) {
    updates.assignedPvcId = assignment.pvcId || null;
    updates.assignedPvcName = assignment.pvcName || null;
  }
  await updateDoc(doc(db, "orders", orderId), updates);
  if (assignment.cutterId) await notify(db, assignment.cutterId, "Жаңа тапсырма", "Сізге заказ тағайындалды", orderId);
  if (assignment.pvcId) await notify(db, assignment.pvcId, "Жаңа тапсырма", "Сізге ПВХ жұмысы тағайындалды", orderId);
  await logAudit(db, actor, { action: "order.assign_workers", entityId: orderId, after: assignment });
}

/**
 * Generic manual override for Admin (status-select dropdown for corrections that don't fit the
 * linear helpers above) — always audited, comment required to be meaningful for anything that
 * isn't a normal forward step.
 */
export async function overrideStatus(
  db: Firestore,
  actor: Actor,
  order: Order,
  newStatus: Order["productionStatus"],
  comment?: string,
): Promise<void> {
  await updateDoc(doc(db, "orders", order.id), { productionStatus: newStatus });
  await writeStatusHistory(db, actor, order.id, "production", order.productionStatus, newStatus, comment);
  await logAudit(db, actor, {
    action: "admin.status_override",
    entityId: order.id,
    before: { productionStatus: order.productionStatus },
    after: { productionStatus: newStatus },
    comment,
  });
  await notify(db, order.customerId, "Заказ мәртебесі өзгерді", `${order.orderNumber}: жаңа мәртебе — ${newStatus}`, order.id);
}

/** Best-effort side effect: if consumption just pushed a material at/below its minimum, alert
 * every admin. Not part of the stock transaction itself — a missed notification is not a
 * correctness issue the way a double-decrement would be. */
async function notifyIfLowStock(db: Firestore, materialId: string): Promise<void> {
  const matSnap = await getDoc(doc(db, "materials", materialId));
  if (!matSnap.exists()) return;
  const material = matSnap.data() as Material;
  const available = material.qtyOnHand - material.reservedQty;
  if (available > material.minStock) return;

  const admins = await getDocs(query(collection(db, "users"), where("role", "==", "admin")));
  for (const adminDoc of admins.docs) {
    await addDoc(collection(db, "notifications"), {
      userId: adminDoc.id,
      type: "low_stock",
      title: "Қойма азайды",
      body: `"${material.name}" материалынан ${available} лист қалды (мин. ${material.minStock})`,
      read: false,
      createdAt: serverTimestamp(),
    });
  }
}

// Kept for compatibility with any UI still calling the old name during migration.
export const changeProductionStatus = overrideStatus;
export const markAsCut = completeCutting;
