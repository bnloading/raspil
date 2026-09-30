// Brings ORD-2026-000185 (Рустем-1) back into the journal.
//
// On 29.09 at 14:30 the row was struck off with "🗑 Жолды өшіру" (cancelOrder), which only sets
// productionStatus to "cancelled" — nothing is deleted. It was at pvc_queue then: cut on 23.09,
// waiting for ПВХ. Cutting was already done, so cancelOrder returned no sheets to the rack, and
// this script moves no stock either. It puts the status back to what the order's own
// statusHistory says it was, clears the cancel fields, writes the matching history/audit rows
// and puts the order back on the workshop board, as syncWorkshopBoard would.
//
//   node --env-file=.env.local scripts/restore-rustem-order-2026-09-30.mjs          # dry run
//   node --env-file=.env.local scripts/restore-rustem-order-2026-09-30.mjs --apply
//
// Re-running after an apply is a no-op: the order is no longer cancelled.
import { readFileSync } from "node:fs";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const APPLY = process.argv.includes("--apply");
const ACTOR_UID = "sPHBndKUNwZMgu6VUkjMyBTbqaC2";
const ORDER_ID = "FYt2N0F5P3ClYDddYrD5";
const REASON = "Қате өшірілген — журналға қайтарылды";

const sa = JSON.parse(readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, "utf8"));
if (getApps().length === 0) initializeApp({ credential: cert(sa) });
const db = getFirestore();
const actorSnap = await db.collection("users").doc(ACTOR_UID).get();
if (!actorSnap.exists) throw new Error(`Actor ${ACTOR_UID} табылмады`);
const actor = { uid: ACTOR_UID, name: actorSnap.data().name };
const t = (ts) => ts ? new Intl.DateTimeFormat("ru-RU", { timeZone: "Asia/Almaty", dateStyle: "short", timeStyle: "short" }).format(ts.toDate()) : "-";
console.log(APPLY ? "== APPLY ==" : "== DRY RUN (nothing is written) ==", "actor:", actor.name);

const orderRef = db.collection("orders").doc(ORDER_ID);
const order = (await orderRef.get()).data();
if (!order) throw new Error("Заказ табылмады");
console.log(order.orderNumber, "|", order.customerName, "| status", order.productionStatus, "| cancelled", t(order.cancelledAt));
if (order.productionStatus !== "cancelled") { console.log("Бас тартылмаған — істейтін ештеңе жоқ."); process.exit(0); }

// The status it had just before the cancel, from its own history.
const hist = (await orderRef.collection("statusHistory").orderBy("createdAt").get()).docs.map((d) => d.data());
const cancelRow = [...hist].reverse().find((h) => h.field === "production" && h.newStatus === "cancelled");
if (!cancelRow) throw new Error("statusHistory-да cancel жолы жоқ");
const restoreTo = cancelRow.prevStatus;
console.log("cancelled by", cancelRow.userName, t(cancelRow.createdAt), "— back to:", restoreTo);

// What else the cancel touched: reservations it released, sheets it returned.
const res = await db.collection("inventoryReservations").where("orderId", "==", ORDER_ID).get();
for (const r of res.docs) { const x = r.data(); console.log("  reservation", r.id, x.status, t(x.updatedAt ?? x.createdAt)); }
const moves = await db.collection("inventoryMovements").where("orderId", "==", ORDER_ID).get();
for (const m of moves.docs) { const x = m.data(); console.log("  movement", x.type ?? x.movementType, x.materialName ?? "", x.qty ?? x.quantity ?? "", t(x.createdAt), x.comment ?? ""); }
const board = await db.collection("workshopActivity").doc(ORDER_ID).get();
console.log("  on workshop board now:", board.exists);

const stage =
  restoreTo === "cutting_completed" ? (order.pvcMetersTotal > 0 ? "pvc_wait" : "ready")
  : { cutting_queue: "queue", cutting_started: "cutting", pvc_queue: "pvc_wait", pvc_started: "pvc", pvc_completed: "ready", ready: "ready", mdf_production: "mdf" }[restoreTo] ?? null;
console.log("  board stage to write:", stage);

if (!APPLY) process.exit(0);

await orderRef.update({
  productionStatus: restoreTo,
  cancelledAt: FieldValue.delete(),
  cancelReason: FieldValue.delete(),
});
await orderRef.collection("statusHistory").add({
  field: "production", prevStatus: "cancelled", newStatus: restoreTo,
  userId: actor.uid, userName: actor.name, comment: REASON, createdAt: FieldValue.serverTimestamp(),
});
await db.collection("auditLogs").add({
  userId: actor.uid, userName: actor.name, action: "order.restored", entityType: "order", entityId: ORDER_ID,
  before: { productionStatus: "cancelled", cancelReason: order.cancelReason ?? null },
  after: { productionStatus: restoreTo }, comment: REASON, createdAt: FieldValue.serverTimestamp(),
});
if (stage) {
  await db.collection("workshopActivity").doc(ORDER_ID).set({
    orderNumber: order.orderNumber,
    customerName: (order.customerName ?? "").trim(),
    orderKind: order.orderKind ?? "cutting",
    stage,
    queuePosition: order.priority ?? 0,
    needsPvc: order.pvcMetersTotal > 0,
    estimatedMinutes: 0,
    startedAt: null,
    updatedAt: FieldValue.serverTimestamp(),
  });
}
const after = (await orderRef.get()).data();
console.log("✅ done:", after.orderNumber, after.productionStatus, "cancelReason:", after.cancelReason ?? "(none)");
