// Marks ORD-2026-000282 (Бахтияр) as struck off to be typed again — cutWorkVoided — so its cut stops
// counting for Олжас on top of the re-typed ORD-2026-000284, as the owner flagged on 2026-10-01
// ("артық есептеліп тұр").
//
// 282 was cut at 12:15 on 30.09, struck off at 12:20 and re-typed as 284, which the saw confirmed
// at 12:26: one job. Its sheets were given back on 30.09 (scripts/stock-double-take-fix-2026-09-30.mjs);
// the journal now sets cutWorkVoided itself whenever a cut row's sheets go back, and the salary
// engine and the cutter's history skip such orders (lib/orderLines.ts creditsFloorWork). 282 was
// struck off before that existed, so it gets the flag here.
//
//   node --env-file=.env.local scripts/void-cut-work-282-2026-10-01.mjs          # dry run, writes nothing
//   node --env-file=.env.local scripts/void-cut-work-282-2026-10-01.mjs --apply
//
// Re-running after an apply is a no-op.
import { readFileSync } from "node:fs";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const APPLY = process.argv.includes("--apply");
const ACTOR_UID = "sPHBndKUNwZMgu6VUkjMyBTbqaC2";
const ORDER = "ORD-2026-000282";
const COMMENT = `${ORDER} ORD-2026-000284 болып қайта жазылған — кесу жұмысы Олжасқа екі рет есептелмейді`;

const sa = JSON.parse(readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, "utf8"));
if (getApps().length === 0) initializeApp({ credential: cert(sa) });
const db = getFirestore();
const actorSnap = await db.collection("users").doc(ACTOR_UID).get();
if (!actorSnap.exists) throw new Error(`Actor ${ACTOR_UID} табылмады`);
console.log(APPLY ? "== APPLY ==" : "== DRY RUN (nothing is written) ==");

const snap = await db.collection("orders").where("orderNumber", "==", ORDER).get();
if (snap.size !== 1) throw new Error(`${ORDER}: ${snap.size} табылды`);
const ref = snap.docs[0].ref;
const order = snap.docs[0].data();
if (order.productionStatus !== "cancelled") throw new Error(`${ORDER} бас тартылмаған`);
const held = (order.lineJobs ?? []).reduce((s, j) => s + (j.consumedQty ?? 0), 0);
if (held > 0) throw new Error(`${ORDER} still holds ${held} sheets — give them back first`);
if (order.cutWorkVoided) {
  console.log(`${ORDER} already marked — nothing to do.`);
  process.exit(0);
}
const cut = (order.lineJobs ?? []).filter((j) => j.cuttingCompletedAt).map((j) => `${j.materialName} ×${j.confirmedSheets ?? j.sheetQty}`);
console.log(`${ORDER} ${order.customerName}: cut lines ${cut.join(", ")} → cutWorkVoided`);
if (APPLY) {
  await ref.update({ cutWorkVoided: true });
  await db.collection("auditLogs").add({
    userId: ACTOR_UID, userName: actorSnap.data().name, action: "order.cut_work_voided", entityType: "order",
    entityId: ref.id, before: null, after: { cutWorkVoided: true }, comment: COMMENT,
    createdAt: FieldValue.serverTimestamp(),
  });
  console.log("✅ Белгіленді.");
} else {
  console.log("Dry run only — add --apply to write.");
}
