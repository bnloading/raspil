// Squares two order records with the rack after the 09.11 count — moving NO sheets. Found by the
// stock audit the owner asked for on 2026-11-09 («журналдағы қоймадан минус етілгенде теріс
// есептеп тұр ма жоқ ба — бәрін тексер»), right after Ербол and Нұр counted the rack that morning.
//
// 1. ORD-2026-000533 (Заказ Цех, МДФ бізден, handed over whole on 23.10 with 4 sheets, corrected
//    to 5 the next day). The fifth sheet never reached the rack in the app — the bug fixed in
//    lib/uncutSettlement.ts on 06.11. The 09.11 count («МДФ бізден −2, 2кем») has since taken it off
//    the rack for real, so the old fix (scripts/fix-533-…-2026-11-06.mjs, never run) would now
//    take it a second time. But the line still says «4 taken of 5», and the next edit of that row,
//    even of a phone number, would settle the difference and take it again. This records the line
//    as holding all 5 — the rack is not touched.
//
// 2. An active reservation of 8 × ЛДСП Кашемир from 31.08 on an order that no longer exists (the
//    reserve-first flow before sheets were taken at the queue). It keeps «8 бронда» on Кашемир and
//    takes 8 off what the Admin's home reads as available. Released, and reservedQty brought down
//    by its 8. qtyOnHand is not touched.
//
//   node --env-file=.env.local scripts/fix-stock-records-2026-11-09.mjs          # dry run, writes nothing
//   node --env-file=.env.local scripts/fix-stock-records-2026-11-09.mjs --apply
//
// Re-running after an apply is a no-op.
import { readFileSync } from "node:fs";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const APPLY = process.argv.includes("--apply");
const ACTOR_UID = "sPHBndKUNwZMgu6VUkjMyBTbqaC2"; // Нур
const ORDER = "ORD-2026-000533";

const sa = JSON.parse(readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, "utf8"));
if (getApps().length === 0) initializeApp({ credential: cert(sa) });
const db = getFirestore();
const actorSnap = await db.collection("users").doc(ACTOR_UID).get();
if (!actorSnap.exists) throw new Error(`Actor ${ACTOR_UID} табылмады`);
const actor = { uid: ACTOR_UID, name: actorSnap.data().name };
console.log(APPLY ? "== APPLY ==" : "== DRY RUN (nothing is written) ==");

// ── 1. №533: the line holds what it says; the rack already lost the sheet at the count ──
const found = await db.collection("orders").where("orderNumber", "==", ORDER).get();
if (found.size !== 1) throw new Error(`${ORDER}: ${found.size} табылды`);
const orderRef = found.docs[0].ref;
await db.runTransaction(async (tx) => {
  const order = (await tx.get(orderRef)).data();
  if (!order.withoutCutting) throw new Error(`${ORDER} распилсіз берілмеген — бұл түзету оған арналмаған`);
  const jobs = order.lineJobs ?? [];
  const short = jobs.filter((j) => (j.sheetQty ?? 0) !== (j.consumedQty ?? 0));
  if (short.length === 0) {
    console.log(`1. ${ORDER}: every line already holds what it says — nothing to do.`);
    return;
  }
  for (const j of short) {
    console.log(`1. ${ORDER} ${j.materialName}: жолда ${j.sheetQty}, алынған деп тұр ${j.consumedQty ?? 0} → ${j.sheetQty} деп жазылады (қойма қозғалмайды — 09.11 санағы алып қойған)`);
  }
  if (!APPLY) return;
  const fixed = jobs.map((j) => ({ ...j, consumedQty: j.sheetQty ?? 0 }));
  tx.update(orderRef, { lineJobs: fixed, cuttingConsumedQty: fixed.reduce((s, j) => s + j.consumedQty, 0) });
  tx.set(db.collection("auditLogs").doc(), {
    userId: actor.uid, userName: actor.name, action: "stock.record_squared", entityType: "order", entityId: orderRef.id,
    before: { consumedQty: jobs.map((j) => j.consumedQty ?? 0) }, after: { consumedQty: fixed.map((j) => j.consumedQty) },
    comment: "Распилсіз заказдың 5-листі 09.11 санағында қоймадан алынды — жазбасы ғана сәйкестендірілді, қойма қозғалмады",
    createdAt: FieldValue.serverTimestamp(),
  });
});

// ── 2. Reservations left on orders that no longer exist ──
const active = await db.collection("inventoryReservations").where("status", "==", "active").get();
let stale = 0;
for (const r of active.docs) {
  const { orderId, materialId, qty } = r.data();
  const orderSnap = orderId ? await db.collection("orders").doc(orderId).get() : null;
  if (orderSnap?.exists) continue;
  stale++;
  await db.runTransaction(async (tx) => {
    const matRef = db.collection("materials").doc(materialId);
    const mat = (await tx.get(matRef)).data();
    const reserved = mat?.reservedQty ?? 0;
    const after = Math.max(0, reserved - qty);
    console.log(`2. ${mat?.name ?? materialId}: ${qty} лист бронь, заказы жоқ (${orderId}) → босатылады; резерв ${reserved} → ${after}, қолда ${mat?.qtyOnHand} өзгермейді`);
    if (!APPLY) return;
    tx.update(r.ref, { status: "released", releasedReason: "Заказы жоқ — тексеру 09.11" });
    tx.update(matRef, { reservedQty: after });
    tx.set(db.collection("auditLogs").doc(), {
      userId: actor.uid, userName: actor.name, action: "stock.reservation_released", entityType: "material", entityId: materialId,
      before: { reservedQty: reserved }, after: { reservedQty: after },
      comment: `Жоқ заказдың (${orderId}) ${qty} лист броні босатылды — тексеру 09.11`,
      createdAt: FieldValue.serverTimestamp(),
    });
  });
}
if (stale === 0) console.log("2. Заказы жоқ бронь қалмаған — nothing to do.");
console.log(APPLY ? "✅ Түзетілді." : "Dry run only — add --apply to write.");
