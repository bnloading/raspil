// Takes off the rack the one sheet ORD-2026-000533 («Заказ Цех», МДФ бізден) never took — found by
// the stock audit the owner asked for on 2026-11-06 («қайтару кезінде bug-тар болып минус етілмей
// қалды ма, артық қосылды ма — бәрін тексеріп көр»).
//
// 533 was handed over whole («распилсіз берілді») on 23.10 at 17:59 with 4 sheets, which took 4.
// On 24.10 at 11:39 the row was corrected to 5 sheets (and repriced, 102 500 ₸), but a corrected
// count on an order handed over whole never reached the rack: only a line the saw cut was settled
// after an edit (fixed in lib/uncutSettlement.ts the same day). This takes the fifth sheet the way
// that fix now does — a cutting_consumption marked withoutCutting, and the line's consumedQty set
// to what the row says.
//
//   node --env-file=.env.local scripts/fix-533-handed-over-count-2026-11-06.mjs          # dry run, writes nothing
//   node --env-file=.env.local scripts/fix-533-handed-over-count-2026-11-06.mjs --apply
//
// Re-running after an apply is a no-op: the line then holds what it says.
import { readFileSync } from "node:fs";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const APPLY = process.argv.includes("--apply");
const ACTOR_UID = "sPHBndKUNwZMgu6VUkjMyBTbqaC2"; // Нур, who handed it over and corrected it
const ORDER = "ORD-2026-000533";

const sa = JSON.parse(readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, "utf8"));
if (getApps().length === 0) initializeApp({ credential: cert(sa) });
const db = getFirestore();
const actorSnap = await db.collection("users").doc(ACTOR_UID).get();
if (!actorSnap.exists) throw new Error(`Actor ${ACTOR_UID} табылмады`);
const actor = { uid: ACTOR_UID, name: actorSnap.data().name };
console.log(APPLY ? "== APPLY ==" : "== DRY RUN (nothing is written) ==");

const found = await db.collection("orders").where("orderNumber", "==", ORDER).get();
if (found.size !== 1) throw new Error(`${ORDER}: ${found.size} табылды`);
const orderRef = found.docs[0].ref;

await db.runTransaction(async (tx) => {
  const order = (await tx.get(orderRef)).data();
  if (!order.withoutCutting) throw new Error(`${ORDER} распилсіз берілмеген — бұл түзету оған арналмаған`);
  if (order.productionStatus === "cancelled") throw new Error(`${ORDER} өшірілген`);
  const jobs = order.lineJobs ?? [];
  const owed = jobs.map((j) => ({ j, short: (j.sheetQty ?? 0) - (j.consumedQty ?? 0) })).filter((x) => x.short !== 0);
  if (owed.length === 0) {
    console.log(`${ORDER}: every line already holds what it says — nothing to do.`);
    return;
  }
  const reads = [];
  for (const { j, short } of owed) {
    const ref = db.collection("materials").doc(j.materialId);
    reads.push({ ref, j, short, snap: await tx.get(ref) });
  }
  for (const { ref, j, short, snap } of reads) {
    if (!snap.exists || snap.data().stockTracked === false) throw new Error(`${j.materialName}: қоймада есептелмейді`);
    const { name, qtyOnHand } = snap.data();
    const after = qtyOnHand - short;
    console.log(`${ORDER} ${name}: жолда ${j.sheetQty}, алынған ${j.consumedQty ?? 0} → қойма ${qtyOnHand} → ${after} (${short > 0 ? "−" : "+"}${Math.abs(short)})`);
    if (!APPLY) continue;
    tx.update(ref, { qtyOnHand: after });
    tx.set(db.collection("inventoryMovements").doc(), {
      materialId: j.materialId,
      type: short > 0 ? "cutting_consumption" : "return",
      qty: -short,
      orderId: orderRef.id,
      userId: actor.uid,
      userName: actor.name,
      comment: `${ORDER}: журналда ${j.consumedQty ?? 0} → ${j.sheetQty} түзетілген, қоймаға жетпеген — тексеруде табылды`,
      ...(short > 0 ? { withoutCutting: true } : {}),
      balanceBefore: qtyOnHand,
      balanceAfter: after,
      createdAt: FieldValue.serverTimestamp(),
    });
  }
  if (!APPLY) return;
  const fixed = jobs.map((j) => ({ ...j, consumedQty: j.sheetQty }));
  tx.update(orderRef, { lineJobs: fixed, cuttingConsumedQty: fixed.reduce((s, j) => s + (j.consumedQty ?? 0), 0) });
  tx.set(db.collection("auditLogs").doc(), {
    userId: actor.uid, userName: actor.name, action: "stock.handed_over_count_settled", entityType: "order",
    entityId: orderRef.id, before: { consumedQty: jobs.map((j) => j.consumedQty ?? 0) }, after: { consumedQty: fixed.map((j) => j.consumedQty) },
    comment: "Распилсіз берілген заказдың түзетілген саны қоймаға жеткізілді (тексеру 06.11)",
    createdAt: FieldValue.serverTimestamp(),
  });
});
console.log(APPLY ? "✅ Түзетілді." : "Dry run only — add --apply to write.");
