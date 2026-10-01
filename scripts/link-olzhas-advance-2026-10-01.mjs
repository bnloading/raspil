// Puts Олжас's 300 000 ₸ advance of 29.09 on his payslip, as the owner asked on 2026-10-01
// ("Олжастың айлығы артық есептеліп кетіп тұр").
//
// The cash left the Касса on 29.09 as an expense, "ОЛжас — аванс", and nothing else: the Аванс
// page never heard of it, so his week of 28.09 went on reading 232 800 ₸ still to pay, though he
// had already been handed 300 000 ₸ of it. The Касса now writes both records itself when an
// expense is paid to a worker (lib/expenses.ts payWorkerFromCashbox); this does it for that one
// expense: a SalaryAdvance against his week, and the expense marked with whom and which week.
//
//   node --env-file=.env.local scripts/link-olzhas-advance-2026-10-01.mjs          # dry run, writes nothing
//   node --env-file=.env.local scripts/link-olzhas-advance-2026-10-01.mjs --apply
//
// Re-running after an apply is a no-op: the expense then carries its advance.
import { readFileSync } from "node:fs";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const APPLY = process.argv.includes("--apply");
const ACTOR_UID = "sPHBndKUNwZMgu6VUkjMyBTbqaC2";
const OLZHAS = "FkXf9oFAx1ccHa9YghUsjJvqF2G2";
const WEEK = "2026-09-28"; // Monday of the week 29.09 falls in — a cutter is paid by the week

const sa = JSON.parse(readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, "utf8"));
if (getApps().length === 0) initializeApp({ credential: cert(sa) });
const db = getFirestore();
const actorSnap = await db.collection("users").doc(ACTOR_UID).get();
if (!actorSnap.exists) throw new Error(`Actor ${ACTOR_UID} табылмады`);
const actor = { uid: ACTOR_UID, name: actorSnap.data().name };
const worker = (await db.collection("users").doc(OLZHAS).get()).data();
if (!worker) throw new Error("Олжас табылмады");
console.log(APPLY ? "== APPLY ==" : "== DRY RUN (nothing is written) ==");

const matches = (await db.collection("expenses").where("date", "==", "2026-09-29").get()).docs
  .filter((d) => /олжас/i.test(d.data().name ?? "") && d.data().amountTiyn === 300_000_00);
if (matches.length !== 1) throw new Error(`expected one 300 000 ₸ "Олжас" expense on 29.09, found ${matches.length}`);
const expenseRef = matches[0].ref;
const expense = matches[0].data();
console.log(`expense: ${expense.date} | ${expense.name} | ${(expense.amountTiyn / 100).toLocaleString("ru-RU")} ₸ | ${expense.comment ?? ""}`);
if (expense.advanceId) {
  console.log(`already on his payslip (advance ${expense.advanceId}) — nothing to do.`);
  process.exit(0);
}
console.log(`→ advance for ${worker.name}, week ${WEEK}, ${(expense.amountTiyn / 100).toLocaleString("ru-RU")} ₸`);
if (!APPLY) {
  console.log("Dry run only — add --apply to write.");
  process.exit(0);
}

const advanceRef = db.collection("advances").doc();
const batch = db.batch();
batch.set(advanceRef, {
  userId: OLZHAS,
  userName: worker.name,
  periodKey: WEEK,
  amountTiyn: expense.amountTiyn,
  note: `Касса: ${expense.name}${expense.comment ? ` · ${expense.comment}` : ""} (29.09)`,
  paidAt: FieldValue.serverTimestamp(),
  recordedByUid: actor.uid,
  recordedByName: actor.name,
  reversed: false,
  expenseId: expenseRef.id,
  createdAt: FieldValue.serverTimestamp(),
});
batch.update(expenseRef, { paidToUid: OLZHAS, paidToName: worker.name, payPeriodKey: WEEK, advanceId: advanceRef.id });
batch.set(db.collection("auditLogs").doc(), {
  userId: actor.uid, userName: actor.name, action: "advance.linked_from_cashbox", entityType: "advance",
  entityId: advanceRef.id, before: null, after: { userId: OLZHAS, periodKey: WEEK, amountTiyn: expense.amountTiyn, expenseId: expenseRef.id },
  comment: "29.09 Касса шығыны «ОЛжас — аванс» айлыққа аванс болып жазылды", createdAt: FieldValue.serverTimestamp(),
});
await batch.commit();
console.log(`✅ advance ${advanceRef.id} written and linked.`);
