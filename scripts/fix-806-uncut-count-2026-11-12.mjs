// Gives the rack back what a queued order no longer asks for. ORD-2026-000806 (Арман Сырт) went
// to the saw on 12.11 with 6 × ЛДСП Дуб Вотан, and the row was corrected to 5 that afternoon
// («6 лист болып тұрды соны 5 қылып журналда өзгерттім, 6 лист минус етілген қалпында қалып
// қойып тұр»). Until that day's fix in lib/uncutSettlement.ts a new count on a line not yet cut
// waited for the cutter's confirmation to reach the rack. This settles every such line now,
// exactly as the fixed journal edit does. On 12.11 that was only №806: 1 sheet back to Вотан.
//
//   node --env-file=.env.local scripts/fix-806-uncut-count-2026-11-12.mjs          # dry run, writes nothing
//   node --env-file=.env.local scripts/fix-806-uncut-count-2026-11-12.mjs --apply
//
// Re-running after an apply is a no-op. A line the saw has cut since is left to the cut.
import { readFileSync } from "node:fs";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const APPLY = process.argv.includes("--apply");
const ACTOR_UID = "sPHBndKUNwZMgu6VUkjMyBTbqaC2"; // Нур

const sa = JSON.parse(readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, "utf8"));
if (getApps().length === 0) initializeApp({ credential: cert(sa) });
const db = getFirestore();
const actorSnap = await db.collection("users").doc(ACTOR_UID).get();
if (!actorSnap.exists) throw new Error(`Actor ${ACTOR_UID} табылмады`);
const actor = { uid: ACTOR_UID, name: actorSnap.data().name };
console.log(APPLY ? "== APPLY ==" : "== DRY RUN (nothing is written) ==");

const isTracked = (m) => !!m && m.stockTracked !== false;
/** What an uncut line should hold: what its row says, as the queue takes it. */
const holds = (j, materials) =>
  j.materialId && (j.sheetQty ?? 0) > 0 && isTracked(materials.get(j.materialId)) ? j.sheetQty : 0;

const [queued, catalog] = await Promise.all([
  db.collection("orders").where("cuttingConsumedAt", "!=", null).get(),
  db.collection("materials").get(),
]);
const catalogById = new Map(catalog.docs.map((d) => [d.id, d.data()]));
let touched = 0;
for (const found of queued.docs) {
  const peek = found.data();
  if (peek.productionStatus === "cancelled" || peek.mergedIntoOrderId || !peek.lineJobs?.length) continue;
  // Only orders that look off are re-read and settled in a transaction.
  if (peek.lineJobs.every((j) => j.cuttingCompletedAt || (j.consumedQty ?? 0) === holds(j, catalogById))) continue;
  await db.runTransaction(async (tx) => {
    const order = (await tx.get(found.ref)).data();
    const jobs = order.lineJobs ?? [];
    const ids = [...new Set(jobs.map((j) => j.materialId).filter(Boolean))];
    const materials = new Map();
    for (const id of ids) {
      const snap = await tx.get(db.collection("materials").doc(id));
      if (snap.exists) materials.set(id, snap.data());
    }
    const deltas = new Map();
    const fixed = jobs.map((j) => {
      if (j.cuttingCompletedAt) return j;
      const now = j.consumedQty ?? 0;
      const should = holds(j, materials);
      if (now === should) return j;
      // What the line held came off its own material; what it should hold comes off the same one —
      // a changed material is settled by the journal edit itself, and the scan found none.
      deltas.set(j.materialId, (deltas.get(j.materialId) ?? 0) + (should - now));
      return { ...j, consumedQty: should };
    });
    if (deltas.size === 0) return;
    touched++;
    for (const [id, qty] of deltas) {
      const m = materials.get(id);
      console.log(`${order.orderNumber} (${order.customerName}) ${m?.name ?? id}: ${qty < 0 ? `${-qty} лист қоймаға қайтарылады` : `тағы ${qty} лист алынады`} — қоймада ${m?.qtyOnHand} → ${(m?.qtyOnHand ?? 0) - qty}`);
    }
    if (!APPLY) return;
    for (const [id, qty] of deltas) {
      const m = materials.get(id);
      if (!isTracked(m)) continue;
      const balanceBefore = m.qtyOnHand;
      const balanceAfter = balanceBefore - qty;
      tx.update(db.collection("materials").doc(id), { qtyOnHand: balanceAfter });
      tx.set(db.collection("inventoryMovements").doc(), {
        materialId: id,
        type: qty > 0 ? "cutting_consumption" : "return",
        qty: -qty,
        orderId: found.id,
        userId: actor.uid,
        userName: actor.name,
        comment: qty > 0
          ? `${order.orderNumber}: журналда түзетілді — тағы ${qty} лист алынды`
          : `${order.orderNumber}: журналда түзетілді — ${-qty} лист қоймаға қайтарылды`,
        balanceBefore,
        balanceAfter,
        createdAt: FieldValue.serverTimestamp(),
      });
    }
    tx.update(found.ref, { lineJobs: fixed, cuttingConsumedQty: fixed.reduce((s, j) => s + (j.consumedQty ?? 0), 0) });
    tx.set(db.collection("auditLogs").doc(), {
      userId: actor.uid, userName: actor.name, action: "stock.uncut_count_settled", entityType: "order", entityId: found.id,
      before: { consumedQty: jobs.map((j) => j.consumedQty ?? 0) }, after: { consumedQty: fixed.map((j) => j.consumedQty ?? 0) },
      comment: "Журналда кесілмеген жолдың саны өзгерген — қойма жолдағы санға келтірілді",
      createdAt: FieldValue.serverTimestamp(),
    });
  });
}
console.log(touched === 0 ? "Түзететін ештеңе жоқ." : APPLY ? `✅ ${touched} заказ түзетілді` : `${touched} заказ түзетіледі (--apply)`);
