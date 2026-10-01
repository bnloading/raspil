// Records a 140 000 ₸ advance for Сүндет against October, as the owner asked on 2026-10-01
// ("Сүндетке 140мың аванс жаз") — on his payslip only: the owner chose "Тек айлыққа, қазан", so
// the Касса is not touched (the money is accounted for there already, or came from elsewhere).
//
//   node --env-file=.env.local scripts/sundet-advance-2026-10-01.mjs          # dry run, writes nothing
//   node --env-file=.env.local scripts/sundet-advance-2026-10-01.mjs --apply
//
// Re-running after an apply is a no-op: the advance is found by its note.
import { readFileSync } from "node:fs";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const APPLY = process.argv.includes("--apply");
const ACTOR_UID = "sPHBndKUNwZMgu6VUkjMyBTbqaC2";
const SUNDET = "pN9hw0RPaRZYk4Re9QNDhn3hy0e2";
const PERIOD = "2026-10";
const AMOUNT = 140_000_00;
const NOTE = "Аванс (01.10, иесінің айтуымен) — Кассаға жазылмаған";

const sa = JSON.parse(readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, "utf8"));
if (getApps().length === 0) initializeApp({ credential: cert(sa) });
const db = getFirestore();
const actorSnap = await db.collection("users").doc(ACTOR_UID).get();
if (!actorSnap.exists) throw new Error(`Actor ${ACTOR_UID} табылмады`);
const actor = { uid: ACTOR_UID, name: actorSnap.data().name };
const worker = (await db.collection("users").doc(SUNDET).get()).data();
if (!worker) throw new Error("Сүндет табылмады");
console.log(APPLY ? "== APPLY ==" : "== DRY RUN (nothing is written) ==");

const existing = (await db.collection("advances").where("userId", "==", SUNDET).get()).docs
  .filter((d) => d.data().periodKey === PERIOD && d.data().note === NOTE && !d.data().reversed);
if (existing.length > 0) {
  console.log(`already recorded (${existing[0].id}) — nothing to do.`);
  process.exit(0);
}
console.log(`→ ${worker.name}: ${(AMOUNT / 100).toLocaleString("ru-RU")} ₸ advance, period ${PERIOD}, Касса untouched`);
if (!APPLY) {
  console.log("Dry run only — add --apply to write.");
  process.exit(0);
}
const ref = db.collection("advances").doc();
const batch = db.batch();
batch.set(ref, {
  userId: SUNDET, userName: worker.name, periodKey: PERIOD, amountTiyn: AMOUNT, note: NOTE,
  paidAt: FieldValue.serverTimestamp(), recordedByUid: actor.uid, recordedByName: actor.name,
  reversed: false, createdAt: FieldValue.serverTimestamp(),
});
batch.set(db.collection("auditLogs").doc(), {
  userId: actor.uid, userName: actor.name, action: "advance.create", entityType: "advance", entityId: ref.id,
  before: null, after: { userId: SUNDET, periodKey: PERIOD, amountTiyn: AMOUNT }, comment: NOTE,
  createdAt: FieldValue.serverTimestamp(),
});
await batch.commit();
console.log(`✅ advance ${ref.id} written.`);
