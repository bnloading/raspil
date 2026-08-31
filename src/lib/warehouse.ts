import {
  collection,
  doc,
  runTransaction,
  serverTimestamp,
  Timestamp,
  type Firestore,
} from "firebase/firestore";
import type { User } from "firebase/auth";
import type { InventoryMovementType, Order, OrderLineJob, UserDoc } from "../types/domain";
import { allCuttingDone, jobAt, jobsOf, patchJob, totalConfirmedSheets, orderNeedsPvc } from "./orderLines";

type Actor = { user: User; userData: UserDoc };

/** Reservation/reservation-release move `reservedQty`; every other movement type moves `qtyOnHand`. */
function targetField(type: InventoryMovementType): "qtyOnHand" | "reservedQty" {
  return type === "reservation" || type === "reservation_release" ? "reservedQty" : "qtyOnHand";
}

export class InsufficientStockError extends Error {
  constructor(materialName: string, available: number, requested: number) {
    super(`"${materialName}" қоймада жеткіліксіз: қолда ${available}, керек ${requested}`);
    this.name = "InsufficientStockError";
  }
}

/**
 * Records one ledger entry and atomically updates the material's running balance in the same
 * transaction. Negative balances are rejected unless `allowNegative` (only manual_correction /
 * write_off / reservation_release pass true) — see spec: "Prevent negative warehouse quantity
 * unless Admin explicitly performs a confirmed correction with a reason."
 */
export async function recordInventoryMovement(
  db: Firestore,
  actor: Actor,
  params: {
    materialId: string;
    type: InventoryMovementType;
    qty: number; // signed delta
    orderId?: string;
    comment?: string;
    allowNegative?: boolean;
  },
): Promise<{ balanceBefore: number; balanceAfter: number }> {
  const materialRef = doc(db, "materials", params.materialId);
  const movementRef = doc(collection(db, "inventoryMovements"));
  const field = targetField(params.type);

  return runTransaction(db, async (tx) => {
    const snap = await tx.get(materialRef);
    if (!snap.exists()) throw new Error("Материал табылмады");
    const material = snap.data() as { name: string; qtyOnHand: number; reservedQty: number };
    const balanceBefore = field === "qtyOnHand" ? material.qtyOnHand : material.reservedQty;
    const balanceAfter = balanceBefore + params.qty;

    if (balanceAfter < 0 && !params.allowNegative) {
      throw new InsufficientStockError(material.name, balanceBefore, -params.qty);
    }

    tx.update(materialRef, { [field]: balanceAfter });
    tx.set(movementRef, {
      materialId: params.materialId,
      type: params.type,
      qty: params.qty,
      orderId: params.orderId ?? null,
      userId: actor.user.uid,
      userName: actor.userData.name,
      comment: params.comment ?? "",
      balanceBefore,
      balanceAfter,
      createdAt: serverTimestamp(),
    });

    return { balanceBefore, balanceAfter };
  });
}

/** A material that is not shop stock (a customer's own board, an offcut) never moves a balance. */
function isStockTracked(material: { stockTracked?: boolean }): boolean {
  return material.stockTracked !== false;
}

/**
 * Takes the sheets out of the warehouse the moment an order is sent to cutting — each material
 * line from its own balance.
 *
 * A merged order ("10 лист ЛДСП Ақ + 3 лист ХДФ") used to draw all 13 sheets from whichever
 * material happened to be the order's primary one. Now every line is charged to the material it is
 * actually made of, and the line records what it took, which is what lets the cutter settle the
 * difference per line when the real count comes in.
 *
 * No-ops when the order has already had its sheets taken, so a retried queue action can never
 * subtract twice. Lines whose material is not shop stock (a customer's own board, an offcut) move
 * nothing at all.
 */
export async function consumeStockOnQueue(
  db: Firestore,
  actor: Actor,
  params: { orderId: string; orderNumber: string; jobs: OrderLineJob[] },
): Promise<{ jobs: OrderLineJob[]; consumed: number }> {
  const orderRef = doc(db, "orders", params.orderId);

  return runTransaction(db, async (tx) => {
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists()) throw new Error("Заказ табылмады");
    const existing = orderSnap.data() as { cuttingConsumedAt?: unknown; lineJobs?: OrderLineJob[] };
    if (existing.cuttingConsumedAt) {
      return { jobs: existing.lineJobs ?? params.jobs, consumed: 0 }; // already taken — never twice
    }

    // Two lines can share a material (the same colour typed on two rows), so the balance is
    // moved once per material, not once per line. A line with no material picked yet has no
    // balance to move and is simply skipped — it must not keep the order off the saw.
    const wanted = new Map<string, number>();
    for (const job of params.jobs) {
      if (job.sheetQty > 0 && job.materialId) {
        wanted.set(job.materialId, (wanted.get(job.materialId) ?? 0) + job.sheetQty);
      }
    }

    const materials = new Map<string, { name: string; qtyOnHand: number; tracked: boolean }>();
    for (const materialId of wanted.keys()) {
      const snap = await tx.get(doc(db, "materials", materialId));
      // A material deleted from the catalogue since the row was typed: nothing to charge, and
      // refusing the whole order over a missing catalogue row would be the wrong trade.
      if (!snap.exists()) {
        materials.set(materialId, { name: materialId, qtyOnHand: 0, tracked: false });
        continue;
      }
      const data = snap.data() as { name: string; qtyOnHand: number; stockTracked?: boolean };
      materials.set(materialId, {
        name: data.name,
        qtyOnHand: data.qtyOnHand,
        tracked: isStockTracked(data),
      });
    }

    let consumed = 0;
    let firstMovementId: string | undefined;
    for (const [materialId, qty] of wanted) {
      const material = materials.get(materialId)!;
      if (!material.tracked) continue;
      const balanceBefore = material.qtyOnHand;
      // Deliberately allowed to go negative. The warehouse count is a record of what the shop has,
      // not a gate on what it may do: the sheets are physically going to the saw whether or not
      // the tally was up to date, and blocking the job would only mean the ledger and the floor
      // disagree in silence. A negative balance says "we owe the rack 3 sheets", which is exactly
      // what the Қойма page should be showing until someone counts or restocks — and the low-stock
      // notification below fires on it. (The manual-correction and cutting-completion paths still
      // refuse to go negative: those are corrections, where a negative result means a typo.)
      const balanceAfter = balanceBefore - qty;

      const movementRef = doc(collection(db, "inventoryMovements"));
      firstMovementId ??= movementRef.id;
      tx.update(doc(db, "materials", materialId), { qtyOnHand: balanceAfter });
      tx.set(movementRef, {
        materialId,
        type: "cutting_consumption",
        qty: -qty,
        orderId: params.orderId,
        userId: actor.user.uid,
        userName: actor.userData.name,
        // The shortfall is named in the ledger entry itself, so the Қойма history explains a
        // negative balance without anyone having to work out which order caused it.
        comment:
          balanceAfter < 0
            ? `${params.orderNumber} распил кезегіне қосылды — қоймада ${-balanceAfter} лист жетіспеді`
            : `${params.orderNumber} распил кезегіне қосылды`,
        balanceBefore,
        balanceAfter,
        createdAt: serverTimestamp(),
      });
      consumed += qty;
    }

    const jobs = params.jobs.map((job) => ({
      ...job,
      consumedQty: materials.get(job.materialId)?.tracked ? job.sheetQty : 0,
    }));

    tx.update(orderRef, {
      lineJobs: jobs,
      cuttingConsumedAt: serverTimestamp(),
      cuttingConsumedQty: consumed,
      ...(firstMovementId ? { cuttingConsumedMovementId: firstMovementId } : {}),
    });

    return { jobs, consumed };
  });
}

/**
 * Puts sheets back on the rack for the given lines, one material at a time — a cancelled order
 * that never reached the saw, or a line still mid-cut when the order was cancelled. Two lines on
 * the same material (a colour typed on two rows) are combined into one movement, same as
 * consumeStockOnQueue. Silent no-op for any line that never took anything.
 */
export async function returnLinesToWarehouse(
  db: Firestore,
  actor: Actor,
  params: { orderId: string; jobs: OrderLineJob[]; comment: string },
): Promise<void> {
  const owed = new Map<string, number>();
  for (const job of params.jobs) {
    const qty = job.consumedQty ?? 0;
    if (qty > 0) owed.set(job.materialId, (owed.get(job.materialId) ?? 0) + qty);
  }
  if (owed.size === 0) return;

  const orderRef = doc(db, "orders", params.orderId);

  await runTransaction(db, async (tx) => {
    const materials = new Map<string, { qtyOnHand: number; tracked: boolean }>();
    for (const materialId of owed.keys()) {
      const snap = await tx.get(doc(db, "materials", materialId));
      if (!snap.exists()) continue;
      const data = snap.data() as { qtyOnHand: number; stockTracked?: boolean };
      materials.set(materialId, { qtyOnHand: data.qtyOnHand, tracked: isStockTracked(data) });
    }

    for (const [materialId, qty] of owed) {
      const material = materials.get(materialId);
      if (!material || !material.tracked) continue;
      const balanceBefore = material.qtyOnHand;
      const balanceAfter = balanceBefore + qty;
      tx.update(doc(db, "materials", materialId), { qtyOnHand: balanceAfter });
      tx.set(doc(collection(db, "inventoryMovements")), {
        materialId,
        type: "return",
        qty,
        orderId: params.orderId,
        userId: actor.user.uid,
        userName: actor.userData.name,
        comment: params.comment,
        balanceBefore,
        balanceAfter,
        createdAt: serverTimestamp(),
      });
    }

    // Every returned line's own hold on the warehouse is cleared, not just the order-level total —
    // a cancelled order must never look like it still owes stock for sheets it gave back.
    const orderSnap = await tx.get(orderRef);
    if (orderSnap.exists()) {
      const jobs = jobsOf(orderSnap.data() as Order);
      const returned = new Set(params.jobs.map((j) => j.index));
      const nextJobs = jobs.map((j) => (returned.has(j.index) ? { ...j, consumedQty: 0 } : j));
      tx.update(orderRef, { lineJobs: nextJobs, cuttingConsumedQty: 0 });
    }
  });
}

/** Reserves `qty` sheets for an approved order: one atomic transaction updates the material's
 * reservedQty, appends a ledger entry, and creates the reservation record together.
 *
 * Kept for orders reserved under the previous flow (stock left the warehouse only when cutting
 * finished); new orders take their sheets up front via consumeStockOnQueue instead. */
export async function reserveStock(
  db: Firestore,
  actor: Actor,
  params: { materialId: string; orderId: string; qty: number; comment?: string },
): Promise<void> {
  const materialRef = doc(db, "materials", params.materialId);
  const movementRef = doc(collection(db, "inventoryMovements"));
  const reservationRef = doc(collection(db, "inventoryReservations"));

  await runTransaction(db, async (tx) => {
    const snap = await tx.get(materialRef);
    if (!snap.exists()) throw new Error("Материал табылмады");
    const material = snap.data() as { name: string; reservedQty: number };
    const balanceBefore = material.reservedQty;
    const balanceAfter = balanceBefore + params.qty;

    tx.update(materialRef, { reservedQty: balanceAfter });
    tx.set(movementRef, {
      materialId: params.materialId,
      type: "reservation",
      qty: params.qty,
      orderId: params.orderId,
      userId: actor.user.uid,
      userName: actor.userData.name,
      comment: params.comment ?? "Заказ бекітілгенде брондалды",
      balanceBefore,
      balanceAfter,
      createdAt: serverTimestamp(),
    });
    tx.set(reservationRef, {
      materialId: params.materialId,
      orderId: params.orderId,
      qty: params.qty,
      status: "active",
      createdAt: serverTimestamp(),
    });
  });
}

/** Releases a specific active reservation (order cancelled before cutting, or superseded by
 * cutting consumption) — atomic: reservedQty decreases, ledger entry, reservation marked released. */
export async function releaseReservation(
  db: Firestore,
  actor: Actor,
  params: { reservationId: string; comment?: string },
): Promise<void> {
  const reservationRef = doc(db, "inventoryReservations", params.reservationId);
  const movementRef = doc(collection(db, "inventoryMovements"));

  await runTransaction(db, async (tx) => {
    const resSnap = await tx.get(reservationRef);
    if (!resSnap.exists()) return; // already gone — nothing to release
    const reservation = resSnap.data() as {
      materialId: string;
      orderId: string;
      qty: number;
      status: string;
    };
    if (reservation.status !== "active") return; // idempotent: already released

    const materialRef = doc(db, "materials", reservation.materialId);
    const matSnap = await tx.get(materialRef);
    if (!matSnap.exists()) throw new Error("Материал табылмады");
    const material = matSnap.data() as { reservedQty: number };
    const balanceBefore = material.reservedQty;
    const balanceAfter = Math.max(0, balanceBefore - reservation.qty);

    tx.update(materialRef, { reservedQty: balanceAfter });
    tx.update(reservationRef, { status: "released", releasedAt: serverTimestamp() });
    tx.set(movementRef, {
      materialId: reservation.materialId,
      type: "reservation_release",
      qty: -reservation.qty,
      orderId: reservation.orderId,
      userId: actor.user.uid,
      userName: actor.userData.name,
      comment: params.comment ?? "Бронь босатылды",
      balanceBefore,
      balanceAfter,
      createdAt: serverTimestamp(),
    });
  });
}

/**
 * Settles one material line of cutting: the cutter's confirmed count against that line's own
 * warehouse balance, and a release of any reservation left over from an order queued under the
 * old, whole-order reserve-first flow.
 *
 * The sheets themselves normally left the warehouse when the order entered the queue (see
 * consumeStockOnQueue), one line at a time — what happens here is the correction: only the
 * difference between what was taken and what the cutter actually used moves. An order restored
 * from before per-line tracking, or one still mid-flight from the previous release, is charged in
 * full here via the legacy baseline buildLineJobs() seeds (see its doc comment).
 *
 * Idempotency guard is the line's own `cuttingCompletedAt`, not the order's — so finishing one
 * material twice by accident is a no-op, while the order's other materials are untouched either
 * way.
 */
export async function consumeLineForCutting(
  db: Firestore,
  actor: Actor,
  params: {
    orderId: string;
    lineIndex: number;
    confirmedQty: number;
    cuttingStartedAtMs?: number; // epoch ms, for this line's actual duration
  },
): Promise<{ alreadyCompleted: boolean; jobs: OrderLineJob[]; orderDone: boolean; needsPvc: boolean }> {
  const orderRef = doc(db, "orders", params.orderId);
  const movementRef = doc(collection(db, "inventoryMovements"));

  return runTransaction(db, async (tx) => {
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists()) throw new Error("Заказ табылмады");
    const orderData = orderSnap.data() as Order;
    const jobs = jobsOf(orderData);
    const job = jobAt(jobs, params.lineIndex);
    if (!job) throw new Error("Жол табылмады");
    if (job.cuttingCompletedAt) {
      return { alreadyCompleted: true, jobs, orderDone: allCuttingDone(jobs), needsPvc: orderNeedsPvc(jobs) };
    }

    const matSnap = await tx.get(doc(db, "materials", job.materialId));
    // A line with no material, or one whose material has since been deleted: there is no balance
    // to settle, and the cutter must still be able to report the job finished.
    const material = matSnap.exists()
      ? (matSnap.data() as { name: string; qtyOnHand: number; stockTracked?: boolean })
      : { name: "", qtyOnHand: 0, stockTracked: false };
    const tracked = matSnap.exists() && isStockTracked(material);

    const alreadyTaken = job.consumedQty ?? 0;
    const delta = tracked ? params.confirmedQty - alreadyTaken : 0;
    const balanceBefore = material.qtyOnHand;
    // Not blocked on a negative result, for the same reason consumeStockOnQueue is not: the sheets
    // are already cut by the time this runs, so the count the cutter reports is a fact to record,
    // not a request to approve. An order queued against short stock leaves the balance negative,
    // and refusing here would have stranded that order on the saw with no way to close it.
    const balanceAfter = balanceBefore - delta;

    if (delta !== 0) {
      tx.update(doc(db, "materials", job.materialId), { qtyOnHand: balanceAfter });
      tx.set(movementRef, {
        materialId: job.materialId,
        type: delta > 0 ? "cutting_consumption" : "return",
        qty: -delta,
        orderId: params.orderId,
        userId: actor.user.uid,
        userName: actor.userData.name,
        comment: alreadyTaken > 0
          ? `${job.materialName}: расталған саны ${alreadyTaken} → ${params.confirmedQty}`
          : `${job.materialName}: кесу кезінде есептен шығарылды`,
        balanceBefore,
        balanceAfter,
        createdAt: serverTimestamp(),
      });
    }

    const actualMinutes = params.cuttingStartedAtMs
      ? Math.max(0, Math.round((Date.now() - params.cuttingStartedAtMs) / 60000))
      : undefined;

    const newJobs = patchJob(jobs, params.lineIndex, {
      confirmedSheets: params.confirmedQty,
      consumedQty: tracked ? params.confirmedQty : alreadyTaken,
      cuttingCompletedAt: Timestamp.now(),
      cuttingByUid: actor.user.uid,
      cuttingByName: actor.userData.name,
      ...(actualMinutes !== undefined ? { cuttingActualMinutes: actualMinutes } : {}),
    });

    const orderDone = allCuttingDone(newJobs);
    const needsPvc = orderNeedsPvc(newJobs);

    tx.update(orderRef, {
      lineJobs: newJobs,
      confirmedSheets: totalConfirmedSheets(newJobs),
      ...(orderDone
        ? {
            productionStatus: needsPvc ? "pvc_queue" : "ready",
            cuttingCompletedAt: serverTimestamp(),
            ...(needsPvc ? { pvcQueuedAt: serverTimestamp() } : { readyAt: serverTimestamp() }),
          }
        : {}),
    });

    return { alreadyCompleted: false, jobs: newJobs, orderDone, needsPvc };
  });
}
