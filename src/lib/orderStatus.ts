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
import { pvcConsumption, applyConsumption } from "./pvcStock";
import { releaseReservation, consumeLineForCutting, consumeStockOnQueue, returnLinesToWarehouse } from "./warehouse";
import { allPvcDone, buildLineJobs, jobAt, jobsOf, patchJob } from "./orderLines";
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
  // The sheets leave the warehouse now, not when the cutter reports back: once a job is queued the
  // boards are off the rack, and the Қойма page has to show what is actually left. Each material
  // line is charged to its own balance — a merged order (10 ЛДСП + 3 ХДФ) used to draw all 13
  // sheets from whichever material happened to be the order's primary one. A line whose material
  // is not shop stock (customer's own board, offcut) moves nothing — see consumeStockOnQueue.
  const jobs = buildLineJobs(order);
  await consumeStockOnQueue(db, actor, { orderId: order.id, orderNumber: order.orderNumber, jobs });
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
  // Stock moved here now, so this is where a thin balance is worth flagging to the admins — once
  // per material actually charged, a merged order's second material included.
  for (const materialId of new Set(jobs.map((j) => j.materialId))) {
    await notifyIfLowStock(db, materialId);
  }
}

/**
 * Releases any reservation left on an order from before per-line stock tracking existed — the
 * previous flow reserved the whole order's sheets against one material at queue time and never
 * released that hold until the (single) completion write. Once every line has its own stock
 * settled, that reservation is pure leftover bookkeeping.
 */
async function releaseLegacyReservations(db: Firestore, actor: Actor, orderId: string): Promise<void> {
  const activeRes = await getDocs(
    query(collection(db, "inventoryReservations"), where("orderId", "==", orderId), where("status", "==", "active")),
  );
  for (const resDoc of activeRes.docs) {
    await releaseReservation(db, actor, { reservationId: resDoc.id, comment: "Барлық материал бөлек есептен шығарылды" });
  }
}

/**
 * One material line starts cutting. Independent of every other line on the order — a merged
 * order's ЛДСП and ХДФ are two different jobs, and the shop starts whichever is on the saw first.
 */
export async function startCuttingLine(
  db: Firestore,
  actor: Actor,
  order: Order,
  lineIndex: number,
  estimatedMinutes: number,
): Promise<void> {
  const jobs = jobsOf(order);
  const job = jobAt(jobs, lineIndex);
  if (!job) throw new Error("Жол табылмады");

  const orderRef = doc(db, "orders", order.id);
  const now = Timestamp.now();
  const expected = new Date(Date.now() + estimatedMinutes * 60000);
  const nextJobs = patchJob(jobs, lineIndex, {
    cuttingStartedAt: now,
    cuttingEstimatedMinutes: estimatedMinutes,
    cuttingExpectedCompletionAt: Timestamp.fromDate(expected),
    cuttingByUid: actor.user.uid,
    cuttingByName: actor.userData.name,
  });

  await updateDoc(orderRef, {
    lineJobs: nextJobs,
    assignedCutterId: order.assignedCutterId || actor.user.uid,
    assignedCutterName: order.assignedCutterName || actor.userData.name,
    // The order-level fields mirror whichever line was started most recently — used by the
    // customer-facing progress strip, which shows one order stage, not a line breakdown.
    cuttingEstimatedMinutes: estimatedMinutes,
    cuttingExpectedCompletionAt: expected,
    ...(order.productionStatus === "cutting_queue" ? { productionStatus: "cutting_started" } : {}),
  });
  await writeStatusHistory(
    db, actor, order.id, "production", order.productionStatus, "cutting_started",
    `${job.materialName} басталды`, estimatedMinutes,
  );
  await syncWorkshopBoard(db, {
    ...order,
    productionStatus: "cutting_started",
    lineJobs: nextJobs,
    cuttingEstimatedMinutes: estimatedMinutes,
    cuttingStartedAt: now,
  });
  await notifyManagers(
    db, "Распил басталды",
    `${order.orderNumber}: ${job.materialName} кесіле бастады (шамамен ${estimatedMinutes} мин)`,
    order.id,
  );
  await notify(db, order.customerId, "Распил басталды", `${order.orderNumber} кесіліп жатыр`, order.id);
}

/** Updates one line's estimate without touching its start time (spec: "Estimated cutting time
 *  updated"). */
export async function updateCuttingEstimateLine(
  db: Firestore, actor: Actor, order: Order, lineIndex: number, estimatedMinutes: number,
): Promise<void> {
  const jobs = jobsOf(order);
  const job = jobAt(jobs, lineIndex);
  if (!job) throw new Error("Жол табылмады");
  const expected = new Date(Date.now() + estimatedMinutes * 60000);
  const nextJobs = patchJob(jobs, lineIndex, {
    cuttingEstimatedMinutes: estimatedMinutes,
    cuttingExpectedCompletionAt: Timestamp.fromDate(expected),
  });
  await updateDoc(doc(db, "orders", order.id), {
    lineJobs: nextJobs,
    cuttingEstimatedMinutes: estimatedMinutes,
    cuttingExpectedCompletionAt: expected,
  });
  await logAudit(db, actor, {
    action: "order.cutting_estimate_change",
    entityId: order.id,
    before: { cuttingEstimatedMinutes: job.cuttingEstimatedMinutes ?? null },
    after: { cuttingEstimatedMinutes: estimatedMinutes },
    comment: job.materialName,
  });
  await syncWorkshopBoard(db, { ...order, lineJobs: nextJobs, cuttingEstimatedMinutes: estimatedMinutes });
  await notifyManagers(db, "Распил мерзімі өзгерді", `${order.orderNumber}: ${job.materialName} — жаңа болжам ${estimatedMinutes} мин`, order.id);
  await notify(db, order.customerId, "Распил мерзімі жаңартылды", `${order.orderNumber} шамамен ${estimatedMinutes} минутта аяқталады`, order.id);
}

/**
 * One material line finishes cutting: settles that line's stock, and — only once every line on
 * the order has been cut — advances the whole order to ПВХ кезегі or Дайын, exactly as the old
 * whole-order completeCutting used to.
 */
export async function completeCuttingLine(
  db: Firestore,
  actor: Actor,
  order: Order,
  lineIndex: number,
  confirmedSheets: number,
): Promise<{ alreadyCompleted: boolean }> {
  const jobsBefore = jobsOf(order);
  const job = jobAt(jobsBefore, lineIndex);
  if (!job) throw new Error("Жол табылмады");

  const result = await consumeLineForCutting(db, actor, {
    orderId: order.id,
    lineIndex,
    confirmedQty: confirmedSheets,
    cuttingStartedAtMs: job.cuttingStartedAt ? job.cuttingStartedAt.toMillis() : undefined,
  });
  if (result.alreadyCompleted) return { alreadyCompleted: true };

  await writeStatusHistory(
    db, actor, order.id, "production", "cutting_started", "cutting_started",
    `${job.materialName}: расталған ${confirmedSheets} лист`,
  );
  await logAudit(db, actor, {
    action: "order.cutting_line_completed",
    entityId: order.id,
    after: { materialId: job.materialId, materialName: job.materialName, confirmedSheets },
  });

  if (!result.orderDone) {
    // Other materials are still on the saw — nothing about the order's own stage changes yet.
    await syncWorkshopBoard(db, { ...order, lineJobs: result.jobs, productionStatus: "cutting_started" });
    return { alreadyCompleted: false };
  }

  await releaseLegacyReservations(db, actor, order.id);
  const nextStatus = result.needsPvc ? "pvc_queue" : "ready";
  await writeStatusHistory(db, actor, order.id, "production", "cutting_started", "cutting_completed");
  await writeStatusHistory(db, actor, order.id, "production", "cutting_completed", nextStatus);
  await logAudit(db, actor, {
    action: "order.cutting_completed",
    entityId: order.id,
    after: { confirmedSheets: result.jobs.reduce((s, j) => s + (j.confirmedSheets ?? 0), 0) },
  });
  await syncWorkshopBoard(db, { ...order, lineJobs: result.jobs, productionStatus: nextStatus });
  await notifyManagers(db, "Распил аяқталды", `${order.orderNumber}: барлық материал кесілді`, order.id);
  await notify(
    db, order.customerId,
    result.needsPvc ? "Распил аяқталды" : "Заказыңыз дайын",
    result.needsPvc ? `${order.orderNumber} ПВХ кезегіне өтті` : `${order.orderNumber} дайын болды`,
    order.id,
  );
  for (const materialId of new Set(result.jobs.map((j) => j.materialId))) {
    await notifyIfLowStock(db, materialId);
  }
  return { alreadyCompleted: false };
}

/** One material line starts edge banding. Only lines with metres of ПВХ on them are ever offered
 *  this — see lib/orderLines.needsPvc. */
export async function startPvcLine(
  db: Firestore, actor: Actor, order: Order, lineIndex: number, estimatedMinutes: number,
): Promise<void> {
  const jobs = jobsOf(order);
  const job = jobAt(jobs, lineIndex);
  if (!job) throw new Error("Жол табылмады");

  const orderRef = doc(db, "orders", order.id);
  const now = Timestamp.now();
  const expected = new Date(Date.now() + estimatedMinutes * 60000);
  const nextJobs = patchJob(jobs, lineIndex, {
    pvcStartedAt: now,
    pvcEstimatedMinutes: estimatedMinutes,
    pvcExpectedCompletionAt: Timestamp.fromDate(expected),
    pvcByUid: actor.user.uid,
    pvcByName: actor.userData.name,
  });

  await updateDoc(orderRef, {
    lineJobs: nextJobs,
    assignedPvcId: order.assignedPvcId || actor.user.uid,
    assignedPvcName: order.assignedPvcName || actor.userData.name,
    pvcEstimatedMinutes: estimatedMinutes,
    pvcExpectedCompletionAt: expected,
    ...(order.productionStatus === "pvc_queue" ? { productionStatus: "pvc_started" } : {}),
  });
  await writeStatusHistory(
    db, actor, order.id, "production", order.productionStatus, "pvc_started",
    `${job.materialName} басталды`, estimatedMinutes,
  );
  await syncWorkshopBoard(db, {
    ...order,
    productionStatus: "pvc_started",
    lineJobs: nextJobs,
    pvcEstimatedMinutes: estimatedMinutes,
    pvcStartedAt: now,
  });
  await notifyManagers(db, "ПВХ басталды", `${order.orderNumber}: ${job.materialName} — ПВХ басталды (шамамен ${estimatedMinutes} мин)`, order.id);
  await notify(db, order.customerId, "ПВХ басталды", `${order.orderNumber} ПВХ жасалып жатыр`, order.id);
}

export async function updatePvcEstimateLine(
  db: Firestore, actor: Actor, order: Order, lineIndex: number, estimatedMinutes: number,
): Promise<void> {
  const jobs = jobsOf(order);
  const job = jobAt(jobs, lineIndex);
  if (!job) throw new Error("Жол табылмады");
  const expected = new Date(Date.now() + estimatedMinutes * 60000);
  const nextJobs = patchJob(jobs, lineIndex, {
    pvcEstimatedMinutes: estimatedMinutes,
    pvcExpectedCompletionAt: Timestamp.fromDate(expected),
  });
  await updateDoc(doc(db, "orders", order.id), {
    lineJobs: nextJobs,
    pvcEstimatedMinutes: estimatedMinutes,
    pvcExpectedCompletionAt: expected,
  });
  await logAudit(db, actor, {
    action: "order.pvc_estimate_change",
    entityId: order.id,
    before: { pvcEstimatedMinutes: job.pvcEstimatedMinutes ?? null },
    after: { pvcEstimatedMinutes: estimatedMinutes },
    comment: job.materialName,
  });
  await syncWorkshopBoard(db, { ...order, lineJobs: nextJobs, pvcEstimatedMinutes: estimatedMinutes });
  await notifyManagers(db, "ПВХ мерзімі өзгерді", `${order.orderNumber}: ${job.materialName} — жаңа болжам ${estimatedMinutes} мин`, order.id);
  await notify(db, order.customerId, "ПВХ мерзімі жаңартылды", `${order.orderNumber} шамамен ${estimatedMinutes} минутта аяқталады`, order.id);
}

/**
 * One material line finishes edge banding. Only once every line that needs ПВХ is done does the
 * order draw down the colour rolls and move to Дайын — exactly what the old whole-order
 * completePvc used to do, just gated on the per-line state instead of one flag.
 */
export async function completePvcLine(
  db: Firestore, actor: Actor, order: Order, lineIndex: number,
): Promise<{ alreadyCompleted: boolean }> {
  const jobsBefore = jobsOf(order);
  const job = jobAt(jobsBefore, lineIndex);
  if (!job) throw new Error("Жол табылмады");
  if (job.pvcCompletedAt) return { alreadyCompleted: true };

  const startedAtMs = job.pvcStartedAt ? job.pvcStartedAt.toMillis() : undefined;
  const actualMinutes = startedAtMs ? Math.max(0, Math.round((Date.now() - startedAtMs) / 60000)) : undefined;
  const nextJobs = patchJob(jobsBefore, lineIndex, {
    pvcCompletedAt: Timestamp.now(),
    pvcByUid: actor.user.uid,
    pvcByName: actor.userData.name,
    ...(actualMinutes !== undefined ? { pvcActualMinutes: actualMinutes } : {}),
  });
  await updateDoc(doc(db, "orders", order.id), { lineJobs: nextJobs });
  await writeStatusHistory(db, actor, order.id, "production", "pvc_started", "pvc_started", `${job.materialName} аяқталды`);
  await logAudit(db, actor, {
    action: "order.pvc_line_completed",
    entityId: order.id,
    after: { materialId: job.materialId, materialName: job.materialName },
  });

  if (!allPvcDone(nextJobs)) {
    // Some other banded material is still with the PVC worker.
    await syncWorkshopBoard(db, { ...order, lineJobs: nextJobs, productionStatus: "pvc_started" });
    return { alreadyCompleted: false };
  }

  const orderRef = doc(db, "orders", order.id);
  // Metres of each colour this order used, from the breakdown denormalized onto it. Empty for a
  // walk-in typed into the journal, which records a blended total with no colour attached.
  const consumption = pvcConsumption(order);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(orderRef);
    if (!snap.exists()) return;
    if (snap.data().pvcCompletedAt) return; // another line's completion already finished the order

    const rolls = await Promise.all(
      [...consumption.keys()].map(async (pvcTypeId) => {
        const ref = doc(db, "pvcTypes", pvcTypeId);
        return { ref, snap: await tx.get(ref) };
      }),
    );
    tx.update(orderRef, {
      lineJobs: nextJobs,
      productionStatus: "ready",
      pvcCompletedAt: serverTimestamp(),
      readyAt: serverTimestamp(),
    });
    for (const { ref, snap: rollSnap } of rolls) {
      if (!rollSnap.exists()) continue; // colour deleted since the order was priced
      const used = consumption.get(ref.id) ?? 0;
      const before = (rollSnap.data() as { metersOnHand?: number }).metersOnHand ?? 0;
      tx.update(ref, { metersOnHand: applyConsumption(before, used) });
    }
  });

  await writeStatusHistory(db, actor, order.id, "production", "pvc_started", "pvc_completed");
  await writeStatusHistory(db, actor, order.id, "production", "pvc_completed", "ready");
  await logAudit(db, actor, { action: "order.pvc_completed", entityId: order.id });
  // Stays on the board as "Дайын" (green) until the Manager hands it over — that's the state the
  // customer most wants to see, and markDelivered() is what finally removes the row.
  await syncWorkshopBoard(db, { ...order, lineJobs: nextJobs, productionStatus: "ready" });
  await notifyManagers(db, "ПВХ аяқталды", `${order.orderNumber}: ПВХ жұмысы аяқталды, заказ дайын`, order.id);
  await notify(db, order.customerId, "Заказыңыз дайын", `${order.orderNumber} толығымен дайын!`, order.id);
  return { alreadyCompleted: false };
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
  // Sheets taken when the order was queued go back on the rack, material by material — unless the
  // saw already cut a given line, in which case those sheets are genuinely gone and cancelling
  // cannot un-cut them. A line still mid-cut (started but not confirmed) also returns: its
  // consumedQty was taken at queue time, and nothing was ever subtracted for the actual cut.
  if (order.productionStatus === "cutting_queue" || order.productionStatus === "cutting_started") {
    await returnLinesToWarehouse(db, actor, {
      orderId: order.id,
      jobs: jobsOf(order).filter((j) => !j.cuttingCompletedAt),
      comment: `${order.orderNumber} бас тартылды — қоймаға қайтарылды`,
    });
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
  // A journal row can reach the saw before its material has been picked. Firestore rejects an
  // empty document path outright, so this has to be caught here rather than by the exists() check
  // below — otherwise the order queues and then the call throws, reading as a failed send.
  if (!materialId) return;
  const matSnap = await getDoc(doc(db, "materials", materialId));
  if (!matSnap.exists()) return;
  const material = matSnap.data() as Material;
  // A line that is not shop stock sits at zero for ever; warning about it would be a standing
  // false alarm rather than news.
  if (material.stockTracked === false) return;
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
