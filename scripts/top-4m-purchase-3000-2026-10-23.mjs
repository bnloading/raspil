// Sets «Сырттан келетін столешница 4м»'s purchase price to 3 000 ₸, as the owner said on 2026-10-23
// («4м 3000 болады»). It came back from the 22.10 delete at 5 000 ₸ — the last figure the audit
// log had (Ербол, 26.09), above the 3 000 ₸ it sells for.
//
//   node --env-file=.env.local scripts/top-4m-purchase-3000-2026-10-23.mjs          # dry run, writes nothing
//   node --env-file=.env.local scripts/top-4m-purchase-3000-2026-10-23.mjs --apply
//
// Re-running after an apply is a no-op.
import { readFileSync } from "node:fs";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const APPLY = process.argv.includes("--apply");
const ACTOR_UID = "sPHBndKUNwZMgu6VUkjMyBTbqaC2"; // Нур — the owner, who asked
const MATERIAL = "8azUDcodwLpR8h0i8mU6"; // Сырттан келетін столешница 4м
const PRICE_TIYN = 300000;

const sa = JSON.parse(readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, "utf8"));
if (getApps().length === 0) initializeApp({ credential: cert(sa) });
const db = getFirestore();
const actorSnap = await db.collection("users").doc(ACTOR_UID).get();
if (!actorSnap.exists) throw new Error(`Actor ${ACTOR_UID} табылмады`);
const actor = { uid: ACTOR_UID, name: actorSnap.data().name };
const fmt = (t) => `${(t / 100).toLocaleString("ru-RU")} ₸`;
console.log(APPLY ? "== APPLY ==" : "== DRY RUN (nothing is written) ==");

const material = await db.collection("materials").doc(MATERIAL).get();
if (!material.exists) throw new Error(`${MATERIAL} табылмады`);
const costRef = db.collection("materialCosts").doc(MATERIAL);
const before = (await costRef.get()).data()?.purchasePriceTiyn ?? 0;
console.log(`${material.data().name}: сату ${fmt(material.data().sellingPriceTiyn)}, сатып алу ${fmt(before)} → ${fmt(PRICE_TIYN)}`);
if (before === PRICE_TIYN) {
  console.log("already set — nothing to do.");
  process.exit(0);
}
if (!APPLY) {
  console.log("Dry run only — add --apply to write.");
  process.exit(0);
}
const batch = db.batch();
batch.set(costRef, { purchasePriceTiyn: PRICE_TIYN });
batch.set(db.collection("auditLogs").doc(), {
  userId: actor.uid, userName: actor.name, action: "purchasePrice.update", entityType: "material", entityId: MATERIAL,
  before: { purchasePriceTiyn: before }, after: { purchasePriceTiyn: PRICE_TIYN },
  comment: material.data().name,
  createdAt: FieldValue.serverTimestamp(),
});
await batch.commit();
console.log("✅ Түзетілді.");
