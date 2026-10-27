import { collection, doc, runTransaction, serverTimestamp, Timestamp, writeBatch, type Firestore } from "firebase/firestore";
import type { User } from "firebase/auth";
import type { ApplicationSettings, Order, Payment, UserDoc } from "../types/domain";
import type { StrandedPayment } from "./orderMerge";
import { logAudit } from "./audit";
import { isBeforeRestart } from "./cashbox";
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

export function nextProductionStatusForPayment(
  current: Order["productionStatus"],
  paymentStatus: "unpaid" | "partial" | "paid" | "overpaid" | "refunded",
): Order["productionStatus"] | null {
  if (!PRE_CUTTING_STATUSES.includes(current)) return null; // already past this stage — don't rewind
  if (paymentStatus === "partial") return "partially_paid";
  if (paymentStatus === "paid" || paymentStatus === "overpaid") return "paid";
  return "waiting_payment";
}

/** Comments the app writes on a payment itself — where it was taken, not anything a person typed. */
const APP_PAYMENT_COMMENTS = new Set([
  "Журнал арқылы", "Журналда түзетілді", "Артық төлем түзетілді",
  // Cash taken on the МДФ line's «Қолма-қол» page with nothing written on it.
  "Қолма-қол беті арқылы",
]);

/**
 * What a person wrote on a payment — "Ерболға берілді" on cash taken at the counter — or null when
 * the comment is only one of the app's own tags. The journal shows the first and hides the second.
 */
export function paymentNote(payment: Pick<Payment, "comment">): string | null {
  const comment = payment.comment?.trim();
  return comment && !APP_PAYMENT_COMMENTS.has(comment) ? comment : null;
}

/**
 * Whether money re-recorded in place of these payments is Касса's: only if every one of them was
 * (Payment.countsInCurrentBooks). Otherwise it stays out, so correcting an order from before the
 * restart never brings the old books' money into Касса.
 */
export function countedInBooks(payments: readonly Pick<Payment, "countsInCurrentBooks">[]): boolean {
  return payments.length > 0 && payments.every((p) => p.countsInCurrentBooks === true);
}

/**
 * Everything people wrote on an order's live payments, each once, in the order given — what the
 * journal row prints under «Төленді» ("💬 30000"). Once each: an Аралас split writes the one cash
 * note on every cash leg, and "30000 · 30000" says nothing the first one did not.
 */
export function paymentNotes(payments: readonly Pick<Payment, "comment" | "reversed">[]): string[] {
  const notes = payments.filter((p) => !p.reversed).map(paymentNote).filter((n): n is string => !!n);
  return [...new Set(notes)];
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
    /**
     * Whether Касса counts it although its order predates the restart (Payment.countsInCurrentBooks).
     * Left out, it is decided here: money taken on such an order now is today's money. A caller
     * re-recording money that was already taken — a corrected «Төленді», «Жартылай» — passes what
     * the payments it replaces had, so correcting an old order never brings old money into Касса.
     */
    countsInCurrentBooks?: boolean;
  },
): Promise<void> {
  const orderRef = doc(db, "orders", params.orderId);
  const paymentRef = doc(collection(db, "payments"));

  await runTransaction(db, async (tx) => {
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists()) throw new Error("Заказ табылмады");
    const order = orderSnap.data() as Order;
    // A debt on an order from before the books were closed, paid now, lands in Касса by itself —
    // the owner's call (15.10): it used to wait for an Admin's «Кассаға қосу», and until then the
    // money was in the account and the drawer but in no figure here.
    let counts = params.countsInCurrentBooks;
    if (counts === undefined) {
      const settings = (await tx.get(doc(db, "applicationSettings", "global"))).data() as ApplicationSettings | undefined;
      counts = isBeforeRestart(order, settings?.cashStartDate ?? null, settings?.cashStartOrderNumber ?? null);
    }
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
      ...(counts ? { countsInCurrentBooks: true } : {}),
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
 * Corrects a mistyped amount on an existing, non-reversed payment — never a reversal, never a new
 * row, just the figure that was actually agreed (a leg of an Аралас split typed as 8 000 when it
 * should have been 18 000, say). Recalculates the order's paidTiyn/debtTiyn/paymentStatus from the
 * delta in the same transaction, same as recordPayment/reversePayment.
 */
export async function correctPaymentAmount(
  db: Firestore,
  actor: Actor,
  params: { paymentId: string; amountTiyn: number },
): Promise<void> {
  if (params.amountTiyn <= 0) throw new Error("Сома дұрыс емес");
  const paymentRef = doc(db, "payments", params.paymentId);

  await runTransaction(db, async (tx) => {
    const paymentSnap = await tx.get(paymentRef);
    if (!paymentSnap.exists()) throw new Error("Төлем табылмады");
    const payment = paymentSnap.data() as { orderId: string; amountTiyn: number; reversed: boolean };
    if (payment.reversed) throw new Error("Қайтарылған төлемді түзетуге болмайды");
    if (payment.amountTiyn === params.amountTiyn) return; // nothing actually changed

    const orderRef = doc(db, "orders", payment.orderId);
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists()) throw new Error("Заказ табылмады");
    const order = orderSnap.data() as Order;
    const newPaid = order.paidTiyn - payment.amountTiyn + params.amountTiyn;
    const newDebt = order.totalTiyn - newPaid;
    const newPaymentStatus = computePaymentStatus(order.totalTiyn, newPaid);
    const newProductionStatus = nextProductionStatusForPayment(order.productionStatus, newPaymentStatus);

    tx.update(paymentRef, {
      amountTiyn: params.amountTiyn,
      correctedByUid: actor.user.uid,
      correctedByName: actor.userData.name,
      correctedAt: serverTimestamp(),
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
 * How to take an overpayment back off an order's live payments without moving any money in time
 * or between accounts. Newest first: a payment larger than what is still over keeps its date and
 * its method, and only its amount comes down (correctPaymentAmount); one the excess covers whole
 * is reversed, and the rest comes off the one before it.
 *
 * The journal's "Артық төлем түзетілді" used to reverse every payment and write one new payment
 * for the order total, dated the moment it was pressed and under the last payment's method. Касса
 * dates money by the payment, so ORD-2026-000224's 26.09 money moved to 29.09, and
 * ORD-2026-000150's 100 000 ₸ Нұр + 50 000 ₸ cash became 148 400 ₸ cash.
 */
export function planOverpaymentTrim(
  live: readonly Pick<Payment, "id" | "amountTiyn" | "paymentDate" | "createdAt">[],
  excessTiyn: number,
): { reverse: string[]; correct: { paymentId: string; amountTiyn: number } | null } {
  const when = (p: (typeof live)[number]) => p.paymentDate?.toMillis() ?? p.createdAt?.toMillis() ?? 0;
  const newestFirst = [...live].sort((a, b) => when(b) - when(a));
  const reverse: string[] = [];
  let left = excessTiyn;
  for (const p of newestFirst) {
    if (left <= 0) break;
    if (p.amountTiyn > left) return { reverse, correct: { paymentId: p.id, amountTiyn: p.amountTiyn - left } };
    reverse.push(p.id);
    left -= p.amountTiyn;
  }
  return { reverse, correct: null };
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
