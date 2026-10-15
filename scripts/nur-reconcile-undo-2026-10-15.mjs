// Takes back the −106 634 ₸ «Банкпен теңестіру» correction on Нұр that
// scripts/nur-reconcile-2026-10-15.mjs wrote, as the owner asked on 2026-10-15 («түзетуді істеме»):
// they would rather the gap were closed by real records than by a correction.
//
// Removes the stored entry exactly as Касса's ✕ does (ManagerCashbox.tsx handleRemoveAdjustment —
// arrayRemove of the element as stored), with the same audit entry.
//
//   node --env-file=.env.local scripts/nur-reconcile-undo-2026-10-15.mjs          # dry run, writes nothing
//   node --env-file=.env.local scripts/nur-reconcile-undo-2026-10-15.mjs --apply
//
// Re-running after an apply is a no-op: the entry is then gone.
import { readFileSync } from "node:fs";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const APPLY = process.argv.includes("--apply");
const ACTOR_UID = "sPHBndKUNwZMgu6VUkjMyBTbqaC2"; // Нур — the owner, who asked
const DEPT = "ldsp";
const ID = "nur-reconcile-2026-10-15";

const sa = JSON.parse(readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, "utf8"));
if (getApps().length === 0) initializeApp({ credential: cert(sa) });
const db = getFirestore();
const actorSnap = await db.collection("users").doc(ACTOR_UID).get();
if (!actorSnap.exists) throw new Error(`Actor ${ACTOR_UID} табылмады`);
const actor = { uid: ACTOR_UID, name: actorSnap.data().name };
console.log(APPLY ? "== APPLY ==" : "== DRY RUN (nothing is written) ==");

const settingsRef = db.collection("applicationSettings").doc("global");
const stored = ((await settingsRef.get()).data().cashAdjustments?.[DEPT] ?? []).find((a) => a.id === ID);
if (!stored) {
  console.log(`${ID} is not there — nothing to do.`);
  process.exit(0);
}
console.log("to remove:", JSON.stringify(stored));
if (!APPLY) {
  console.log("Dry run only — add --apply to write.");
  process.exit(0);
}
const batch = db.batch();
batch.update(settingsRef, { [`cashAdjustments.${DEPT}`]: FieldValue.arrayRemove(stored) });
batch.set(db.collection("auditLogs").doc(), {
  userId: actor.uid, userName: actor.name, action: "cash.adjustment.remove", entityType: "applicationSettings",
  entityId: "global", before: { ...stored }, after: null, comment: `${stored.note} — қайтарылды (иесі, 15.10)`,
  createdAt: FieldValue.serverTimestamp(),
});
await batch.commit();
console.log("✅ Түзету өшірілді.");
