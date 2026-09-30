// Gives back the sheets ORD-2026-000282 (Бахтияр) took, now that ORD-2026-000284 carries the job —
// as the owner asked on 2026-09-30 ("№282 ні қоймаға қайтар").
//
// 282 was queued on credit at 11:38 and cut at 12:15 (1 ЛДСП Ақ Томск, 1 ХДФ). At 12:20 it was
// struck off the journal and typed again as 284, paid, which was queued at 12:21 and confirmed on
// the saw at 12:26. One job, two orders' worth of sheets off the rack: a plain cancel leaves a cut
// line's sheets taken, and the re-typed order took them again. This returns 282's the way
// lib/warehouse.ts returnLinesToWarehouse does — a "return" movement per material and the lines'
// consumedQty cleared — so 284 alone carries the job.
//
//   node --env-file=.env.local scripts/stock-double-take-fix-2026-09-30.mjs          # dry run, writes nothing
//   node --env-file=.env.local scripts/stock-double-take-fix-2026-09-30.mjs --apply
//
// Re-running after an apply is a no-op: 282's lines then hold nothing.
import { readFileSync } from "node:fs";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const APPLY = process.argv.includes("--apply");
const ACTOR_UID = "sPHBndKUNwZMgu6VUkjMyBTbqaC2";
const CANCELLED = "ORD-2026-000282";
const REENTERED = "ORD-2026-000284";
const COMMENT = `${CANCELLED} өшіріліп, ${REENTERED} болып қайта жазылды — екі рет алынған лист қоймаға қайтарылды`;

const sa = JSON.parse(readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, "utf8"));
if (getApps().length === 0) initializeApp({ credential: cert(sa) });
const db = getFirestore();
const actorSnap = await db.collection("users").doc(ACTOR_UID).get();
if (!actorSnap.exists) throw new Error(`Actor ${ACTOR_UID} табылмады`);
const actor = { uid: ACTOR_UID, name: actorSnap.data().name };
console.log(APPLY ? "== APPLY ==" : "== DRY RUN (nothing is written) ==");

const find = async (orderNumber) => {
  const snap = await db.collection("orders").where("orderNumber", "==", orderNumber).get();
  if (snap.size !== 1) throw new Error(`${orderNumber}: ${snap.size} табылды`);
  return { ref: snap.docs[0].ref, data: snap.docs[0].data() };
};
const cancelled = await find(CANCELLED);
const reentered = await find(REENTERED);
if (cancelled.data.productionStatus !== "cancelled") throw new Error(`${CANCELLED} бас тартылмаған`);

// What 282 still holds, per material — and 284 must be holding the same, or this is not a re-entry.
const held = (jobs) => {
  const m = new Map();
  for (const j of jobs ?? []) if ((j.consumedQty ?? 0) > 0) m.set(j.materialId, (m.get(j.materialId) ?? 0) + j.consumedQty);
  return m;
};
const owed = held(cancelled.data.lineJobs);
const carried = held(reentered.data.lineJobs);
if (owed.size === 0) {
  console.log(`${CANCELLED} holds no sheets — already returned, nothing to do.`);
  process.exit(0);
}
for (const [materialId, qty] of owed) {
  if ((carried.get(materialId) ?? 0) < qty) throw new Error(`${REENTERED} does not carry ${qty} of ${materialId} — not a re-entry of ${CANCELLED}`);
}

await db.runTransaction(async (tx) => {
  const orderSnap = await tx.get(cancelled.ref);
  const mats = [];
  for (const [materialId, qty] of owed) {
    const ref = db.collection("materials").doc(materialId);
    mats.push({ ref, materialId, qty, snap: await tx.get(ref) });
  }
  for (const { ref, materialId, qty, snap } of mats) {
    const { name, qtyOnHand } = snap.data();
    console.log(`${name}: ${qtyOnHand} → ${qtyOnHand + qty} (+${qty})`);
    if (!APPLY) continue;
    tx.update(ref, { qtyOnHand: qtyOnHand + qty });
    tx.set(db.collection("inventoryMovements").doc(), {
      materialId, type: "return", qty, orderId: cancelled.ref.id,
      userId: actor.uid, userName: actor.name, comment: COMMENT,
      balanceBefore: qtyOnHand, balanceAfter: qtyOnHand + qty, createdAt: FieldValue.serverTimestamp(),
    });
  }
  if (!APPLY) return;
  const jobs = (orderSnap.data().lineJobs ?? []).map((j) => ({ ...j, consumedQty: 0 }));
  tx.update(cancelled.ref, { lineJobs: jobs, cuttingConsumedQty: 0 });
  tx.set(db.collection("auditLogs").doc(), {
    userId: actor.uid, userName: actor.name, action: "stock.double_take_returned", entityType: "order",
    entityId: cancelled.ref.id, before: Object.fromEntries(owed), after: null, comment: COMMENT,
    createdAt: FieldValue.serverTimestamp(),
  });
});
console.log(APPLY ? "✅ Қайтарылды." : "Dry run only — add --apply to write.");
