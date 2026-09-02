import { deleteDoc, doc, serverTimestamp, setDoc, type Firestore } from "firebase/firestore";
import type { Order, WorkshopBoardStage } from "../types/domain";

/**
 * The public workshop board ("Цех жұмысы" / "Цехта қазір").
 *
 * Every signed-in customer may read this collection, so what goes in it is deliberate and short:
 * the order number, the stage, the queue position, and the customer's name. The name is here at
 * the shop's explicit request — the board is the digital version of the whiteboard on the
 * workshop wall, and a wall says names. Nothing else identifying follows it: no customerId, no
 * phone, no price, no dimensions.
 *
 * One document per in-production order, keyed by order id, kept in sync by syncWorkshopBoard()
 * from every status transition in lib/orderStatus.ts and removed once the order leaves the floor.
 * Rows written before the name was added carry none until their next transition re-syncs them.
 */

/** Which board stage an order is at, or null if it doesn't belong on the public board at all. */
export function boardStageFor(order: Pick<Order, "productionStatus" | "pvcMetersTotal">): WorkshopBoardStage | null {
  switch (order.productionStatus) {
    case "cutting_queue":
      return "queue";
    case "cutting_started":
      return "cutting";
    case "cutting_completed":
      return order.pvcMetersTotal > 0 ? "pvc_wait" : "ready";
    case "pvc_queue":
      return "pvc_wait";
    case "pvc_started":
      return "pvc";
    case "pvc_completed":
    case "ready":
      return "ready";
    // Everything before payment (and everything after handover/cancellation) stays off the board:
    // an order the shop hasn't started isn't "in the workshop", and a delivered one has left it.
    default:
      return null;
  }
}

/**
 * Writes (or removes) one order's public board row to match its current state. Safe to call after
 * any transition — it is a plain upsert/delete keyed by order id, so repeated calls converge
 * rather than duplicating rows.
 */
export async function syncWorkshopBoard(db: Firestore, order: Order): Promise<void> {
  const ref = doc(db, "workshopActivity", order.id);
  const stage = boardStageFor(order);

  if (stage === null) {
    await deleteDoc(ref).catch(() => {
      // Already absent (the common case for an order that was never on the board) — deleting a
      // missing doc is a no-op we don't want to surface as a workflow error.
    });
    return;
  }

  const estimatedMinutes =
    stage === "cutting" ? order.cuttingEstimatedMinutes ?? 0
    : stage === "pvc" ? order.pvcEstimatedMinutes ?? 0
    : 0;
  const startedAt =
    stage === "cutting" ? order.cuttingStartedAt ?? null
    : stage === "pvc" ? order.pvcStartedAt ?? null
    : null;

  await setDoc(ref, {
    orderNumber: order.orderNumber,
    // Trimmed and defaulted rather than written as undefined: Firestore rejects undefined values,
    // and an order typed without a name must not fail the whole status transition.
    customerName: (order.customerName ?? "").trim(),
    stage,
    queuePosition: order.priority ?? 0,
    needsPvc: order.pvcMetersTotal > 0,
    estimatedMinutes,
    startedAt,
    updatedAt: serverTimestamp(),
  });
}

/** Removes an order from the public board (handover, cancellation). */
export async function clearWorkshopBoard(db: Firestore, orderId: string): Promise<void> {
  await deleteDoc(doc(db, "workshopActivity", orderId)).catch(() => {});
}
