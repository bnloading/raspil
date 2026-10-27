// Points the МДФ line's «Басқа» payment method at its own Касса pot, as part of the owner's 26.10
// ask that МДФ money not read as «Нұр» («Нұр дегеннің орнына Ахжол болсын»).
//
// The МДФ Касса now names its pots «Ахжол» / «Басқа» / «Қолма-қол» (lib/cashbox.ts
// cashAccountLabels). «Ахжол» carries no `account`, so it lands in the transfer pot — now named
// «Ахжол», which is where Мейрам's 220 110 ₸ already sits. «Басқа» carried none either, so its money
// would have been counted as Ахжол's; this files it under the second pot instead, the one the МДФ
// Касса calls «Басқа». No «Басқа» payment exists yet, so no balance moves today. It is the same
// change an Admin makes by hand under «Төлем түрі қай кассаға түседі» on Касса.
//
//   node --env-file=.env.local scripts/mdf-basqa-pot-2026-10-27.mjs          # dry run, writes nothing
//   node --env-file=.env.local scripts/mdf-basqa-pot-2026-10-27.mjs --apply
//
// Re-running after an apply is a no-op.
import { readFileSync } from "node:fs";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const APPLY = process.argv.includes("--apply");
const ACTOR_UID = "sPHBndKUNwZMgu6VUkjMyBTbqaC2"; // Нур — the owner, who asked
const METHOD = "mdf_other";

const sa = JSON.parse(readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, "utf8"));
if (getApps().length === 0) initializeApp({ credential: cert(sa) });
const db = getFirestore();
const actorSnap = await db.collection("users").doc(ACTOR_UID).get();
if (!actorSnap.exists) throw new Error(`Actor ${ACTOR_UID} табылмады`);
const actor = { uid: ACTOR_UID, name: actorSnap.data().name };
console.log(APPLY ? "== APPLY ==" : "== DRY RUN (nothing is written) ==");

const ref = db.collection("paymentMethods").doc(METHOD);
const snap = await ref.get();
if (!snap.exists) throw new Error(`${METHOD} табылмады`);
const method = snap.data();
if (method.department !== "mdf") throw new Error(`${METHOD} — МДФ-тің әдісі емес (${method.department})`);
console.log(`${method.name}: account ${method.account ?? "(жоқ — Ахжол қапшығы)"} → pay («Басқа» қапшығы)`);
const used = (await db.collection("payments").where("methodId", "==", METHOD).get()).size;
console.log(`Осы әдіспен жазылған төлем: ${used}`);
if (method.account === "pay") {
  console.log("already set — nothing to do.");
  process.exit(0);
}
if (!APPLY) {
  console.log("Dry run only — add --apply to write.");
  process.exit(0);
}
const batch = db.batch();
batch.update(ref, { account: "pay" });
batch.set(db.collection("auditLogs").doc(), {
  userId: actor.uid, userName: actor.name, action: "payment_method.account", entityType: "paymentMethod", entityId: METHOD,
  before: { account: method.account ?? null }, after: { account: "pay" },
  comment: "МДФ «Басқа» — өз қапшығына (иесі, 26.10: МДФ ақшасы Нұр болып көрінбесін)",
  createdAt: FieldValue.serverTimestamp(),
});
await batch.commit();
console.log("✅ Түзетілді.");
