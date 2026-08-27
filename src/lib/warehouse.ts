import {
  collection,
  doc,
  runTransaction,
  serverTimestamp,
  type Firestore,
} from "firebase/firestore";
import type { User } from "firebase/auth";
import type { InventoryMovementType, UserDoc } from "../types/domain";

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

/** Reserves `qty` sheets for an approved order: one atomic transaction updates the material's
 * reservedQty, appends a ledger entry, and creates the reservation record together. */
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
 * Marks an order's material as cut: consumes `qty` sheets from qtyOnHand, releases the matching
 * reservation, and stamps the order with an idempotency guard — all in ONE transaction, so a
 * double-click or a retried request can never subtract stock twice. If the order already has
 * `cuttingConsumedAt` set, this is a silent no-op.
 *
 * Also advances productionStatus straight to PVC_QUEUE (if the order needs PVC work) or READY
 * (if not) in the same transaction — per spec, cutting-completion is the single moment stock
 * changes, so the branch decision belongs in the same atomic write as the guard that prevents it
 * from ever running twice.
 */
export async function consumeForCutting(
  db: Firestore,
  actor: Actor,
  params: {
    orderId: string;
    materialId: string;
    qty: number;
    reservationId?: string;
    needsPvc: boolean;
    cuttingStartedAtMs?: number; // epoch ms, for computing cuttingActualMinutes
  },
): Promise<{ alreadyConsumed: boolean }> {
  const orderRef = doc(db, "orders", params.orderId);
  const materialRef = doc(db, "materials", params.materialId);
  const movementRef = doc(collection(db, "inventoryMovements"));
  const reservationRef = params.reservationId
    ? doc(db, "inventoryReservations", params.reservationId)
    : null;

  return runTransaction(db, async (tx) => {
    // Firestore transactions require every read to happen before any write, so the (optional)
    // reservation lookup must be gathered up front alongside the order/material reads, not
    // interleaved with the tx.update/tx.set calls below.
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists()) throw new Error("Заказ табылмады");
    if (orderSnap.data().cuttingConsumedAt) {
      return { alreadyConsumed: true }; // idempotency guard — nothing more to do
    }

    const matSnap = await tx.get(materialRef);
    if (!matSnap.exists()) throw new Error("Материал табылмады");
    const material = matSnap.data() as { name: string; qtyOnHand: number; reservedQty: number };
    const balanceBefore = material.qtyOnHand;
    const balanceAfter = balanceBefore - params.qty;
    if (balanceAfter < 0) {
      throw new InsufficientStockError(material.name, balanceBefore, params.qty);
    }

    const resSnap = reservationRef ? await tx.get(reservationRef) : null;
    const releasingReservation = !!resSnap?.exists() && resSnap.data().status === "active";
    const reservedAfter = releasingReservation
      ? Math.max(0, material.reservedQty - (resSnap!.data().qty as number))
      : undefined;

    tx.update(materialRef, {
      qtyOnHand: balanceAfter,
      ...(reservedAfter !== undefined ? { reservedQty: reservedAfter } : {}),
    });
    tx.set(movementRef, {
      materialId: params.materialId,
      type: "cutting_consumption",
      qty: -params.qty,
      orderId: params.orderId,
      userId: actor.user.uid,
      userName: actor.userData.name,
      comment: "Кесу кезінде есептен шығарылды",
      balanceBefore,
      balanceAfter,
      createdAt: serverTimestamp(),
    });

    const now = new Date();
    const actualMinutes = params.cuttingStartedAtMs
      ? Math.max(0, Math.round((now.getTime() - params.cuttingStartedAtMs) / 60000))
      : undefined;

    tx.update(orderRef, {
      productionStatus: params.needsPvc ? "pvc_queue" : "ready",
      cuttingConsumedAt: serverTimestamp(),
      cuttingConsumedMovementId: movementRef.id,
      confirmedSheets: params.qty,
      cuttingCompletedAt: serverTimestamp(),
      ...(actualMinutes !== undefined ? { cuttingActualMinutes: actualMinutes } : {}),
      ...(params.needsPvc ? { pvcQueuedAt: serverTimestamp() } : { readyAt: serverTimestamp() }),
    });

    if (releasingReservation && reservationRef) {
      tx.update(reservationRef, { status: "released", releasedAt: serverTimestamp() });
    }

    return { alreadyConsumed: false };
  });
}
