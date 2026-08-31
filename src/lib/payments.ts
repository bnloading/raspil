import { collection, doc, runTransaction, serverTimestamp, Timestamp, writeBatch, type Firestore } from "firebase/firestore";
import type { User } from "firebase/auth";
import type { Order, UserDoc } from "../types/domain";
import type { StrandedPayment } from "./orderMerge";
import { logAudit } from "./audit";
import { computePaymentStatus } from "./statuses";

type Actor = { user: User; userData: UserDoc };

/**
 * The productionStatus field doubles as the payment stage (WAITING_PAYMENT/PARTIALLY_PAID/PAID)
 * while an order is still upstream of the cutting queue — recordPayment/reversePayment keep the
 * two fields in sync here rather than making every caller remember to. Once an order has actually
 * entered the cutting pipeline (or beyond), payment changes must never rewind its workflow stage —
 * a debt collected after delivery shouldn't un-deliver the order.
 */
const PRE_CUTTING_STATUSES: Order["productionStatus"][] = ["waiting_payment", "partially_paid", "paid"];

function nextProductionStatusForPayment(
  current: Order["productionStatus"],
  paymentStatus: "unpaid" | "partial" | "paid" | "overpaid" | "refunded",
): Order["productionStatus"] | null {
  if (!PRE_CUTTING_STATUSES.includes(current)) return null; // already past this stage — don't rewind
  if (paymentStatus === "partial") return "partially_paid";
  if (paymentStatus === "paid" || paymentStatus === "overpaid") return "paid";
  return "waiting_payment";
}

/**
 * Records one payment (or one leg of a mixed payment — call once per method/amount pair) and
 * atomically recalculates the order's paidTiyn/debtTiyn/paymentStatus from the new total. Runs in
 * a transaction so concurrent payments never race each other's totals.
 */
export async function recordPayment(
  db: Firestore,
  actor: Actor,
  params: {
    orderId: string;
    amountTiyn: number;
    methodId: string;
    methodName: string;
    comment?: string;
    receiptNumber?: string;
    groupId?: string;
    paymentDate?: Date;
  },
): Promise<void> {
  const orderRef = doc(db, "orders", params.orderId);
  const paymentRef = doc(collection(db, "payments"));

  await runTransaction(db, async (tx) => {
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists()) throw new Error("Заказ табылмады");
    const order = orderSnap.data() as Order;
    const newPaid = order.paidTiyn + params.amountTiyn;
    const newDebt = order.totalTiyn - newPaid;
    const newPaymentStatus = computePaymentStatus(order.totalTiyn, newPaid);
    const newProductionStatus = nextProductionStatusForPayment(order.productionStatus, newPaymentStatus);

    tx.set(paymentRef, {
      orderId: params.orderId,
      amountTiyn: params.amountTiyn,
      methodId: params.methodId,
      methodName: params.methodName,
      paymentDate: params.paymentDate ? Timestamp.fromDate(params.paymentDate) : serverTimestamp(),
      recordedByUid: actor.user.uid,
      recordedByName: actor.userData.name,
      comment: params.comment ?? "",
      receiptNumber: params.receiptNumber ?? "",
      groupId: params.groupId ?? null,
      reversed: false,
      createdAt: serverTimestamp(),
    });
    tx.update(orderRef, {
      paidTiyn: newPaid,
      debtTiyn: newDebt,
      paymentStatus: newPaymentStatus,
      ...(newProductionStatus ? { productionStatus: newProductionStatus } : {}),
    });
  });
}

/** Reverses a payment (never deletes it) and recalculates the order's totals in the same transaction. */
export async function reversePayment(
  db: Firestore,
  actor: Actor,
  params: { paymentId: string; reason: string },
): Promise<void> {
  const paymentRef = doc(db, "payments", params.paymentId);

  await runTransaction(db, async (tx) => {
    const paymentSnap = await tx.get(paymentRef);
    if (!paymentSnap.exists()) throw new Error("Төлем табылмады");
    const payment = paymentSnap.data() as { orderId: string; amountTiyn: number; reversed: boolean };
    if (payment.reversed) return; // idempotent

    const orderRef = doc(db, "orders", payment.orderId);
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists()) throw new Error("Заказ табылмады");
    const order = orderSnap.data() as Order;
    const newPaid = order.paidTiyn - payment.amountTiyn;
    const newDebt = order.totalTiyn - newPaid;
    const newPaymentStatus = computePaymentStatus(order.totalTiyn, newPaid);
    const newProductionStatus = nextProductionStatusForPayment(order.productionStatus, newPaymentStatus);

    tx.update(paymentRef, {
      reversed: true,
      reversalReason: params.reason,
      reversedByUid: actor.user.uid,
      reversedByName: actor.userData.name,
    });
    tx.update(orderRef, {
      paidTiyn: newPaid,
      debtTiyn: newDebt,
      paymentStatus: newPaymentStatus,
      ...(newProductionStatus ? { productionStatus: newProductionStatus } : {}),
    });
  });
}

/**
 * Moves payments left behind by a merge onto the order that is actually live, then re-syncs that
 * order's own paidTiyn/debtTiyn/paymentStatus from the rolled-up total.
 *
 * No money changes: the amount, the method, the date and the person who took it are all untouched,
 * and the original order id is kept on `mergedFromOrderId` so the move stays traceable. It is the
 * bookkeeping equivalent of filing a receipt under the right invoice — which is exactly the
 * narrow diff firestore.rules lets a Manager write here.
 */
export async function reattachPayments(
  db: Firestore,
  actor: Actor,
  params: {
    moves: StrandedPayment[];
    /** Net (non-reversed) paid per target order once the moves land. */
    netPaidByOrderId: ReadonlyMap<string, number>;
  },
): Promise<void> {
  if (params.moves.length === 0) return;

  const batch = writeBatch(db);
  for (const move of params.moves) {
    batch.update(doc(db, "payments", move.paymentId), {
      orderId: move.toOrderId,
      mergedFromOrderId: move.fromOrderId,
    });
  }
  await batch.commit();

  // Each target separately, and after the payments have landed: an order's stored totals are only
  // ever a cache of its payments, so this recomputes rather than adjusting by a delta.
  for (const [orderId, paidTiyn] of params.netPaidByOrderId) {
    const orderRef = doc(db, "orders", orderId);
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(orderRef);
      if (!snap.exists()) return;
      const order = snap.data() as Order;
      if (order.paidTiyn === paidTiyn) return;
      tx.update(orderRef, {
        paidTiyn,
        debtTiyn: order.totalTiyn - paidTiyn,
        paymentStatus: computePaymentStatus(order.totalTiyn, paidTiyn),
      });
    });
  }

  await logAudit(db, actor, {
    action: "payment.reattached",
    entityType: "payment",
    entityId: params.moves[0].paymentId,
    after: {
      moved: params.moves.length,
      orders: [...new Set(params.moves.map((m) => m.toOrderId))],
    },
  });
}
