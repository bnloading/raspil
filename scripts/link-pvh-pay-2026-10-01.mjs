// Puts the ПВХ workers' pay handed out of the Касса on their payslips, as the owner said on
// 2026-10-01: "Сүндет, Ержан, Ринат — тұрақты жалақы; 100 000 Ринатқа — аванс".
//
// Each of these left the Касса as an expense and nothing else, so their payslips never saw it
// (the Касса now writes both itself — lib/expenses.ts payWorkerFromCashbox):
//
//   Ержан  21.09  "Ержан Аванс" 300 000 ₸  → September's advance
//   Ержан  01.10  "Айлық"        50 000 ₸  → September's pay   (350 000 ₸ fixed = 300 000 + 50 000)
//   Сүндет 01.10  "Айлық"        28 000 ₸  → September's pay
//   Ренат  01.10  "Ринат Айлық" 100 000 ₸  → October's advance  (the owner: "аванс")
//
// Each gets a SalaryAdvance against that period, and the expense is marked with whom and which
// period. Found by id, checked against name and amount before anything is written.
//
//   node --env-file=.env.local scripts/link-pvh-pay-2026-10-01.mjs          # dry run, writes nothing
//   node --env-file=.env.local scripts/link-pvh-pay-2026-10-01.mjs --apply
//
// Re-running after an apply is a no-op: a linked expense is skipped.
import { readFileSync } from "node:fs";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const APPLY = process.argv.includes("--apply");
const ACTOR_UID = "sPHBndKUNwZMgu6VUkjMyBTbqaC2";
const ERZHAN = "Y2PRSjrNucM7SEpQqD0H8R5kL523";
const SUNDET = "pN9hw0RPaRZYk4Re9QNDhn3hy0e2";
const RENAT = "doIayF2UWZMER1Rc9cfrlRNvuef1";

const sa = JSON.parse(readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, "utf8"));
if (getApps().length === 0) initializeApp({ credential: cert(sa) });
const db = getFirestore();
const actorSnap = await db.collection("users").doc(ACTOR_UID).get();
if (!actorSnap.exists) throw new Error(`Actor ${ACTOR_UID} табылмады`);
const actor = { uid: ACTOR_UID, name: actorSnap.data().name };
const fmt = (t) => `${(t / 100).toLocaleString("ru-RU")} ₸`;
console.log(APPLY ? "== APPLY ==" : "== DRY RUN (nothing is written) ==");

// Ринат's expense is looked up rather than named by id: 01.10, "Ринат", 100 000 ₸.
const renatExpense = (await db.collection("expenses").where("date", "==", "2026-10-01").get()).docs
  .filter((d) => /ринат|ренат/i.test(d.data().name ?? "") && d.data().amountTiyn === 100_000_00);
if (renatExpense.length !== 1) throw new Error(`expected one 100 000 ₸ "Ринат" expense on 01.10, found ${renatExpense.length}`);

const LINKS = [
  { expenseId: "FBTETtiIs6Wg9KGXye6P", userId: ERZHAN, periodKey: "2026-09", amountTiyn: 300_000_00, what: "аванс" },
  { expenseId: "YeRtSRqUqYsHUfG0tvCP", userId: ERZHAN, periodKey: "2026-09", amountTiyn: 50_000_00, what: "айлық" },
  { expenseId: "B0hXTOjDGE9E3KVqkM0W", userId: SUNDET, periodKey: "2026-09", amountTiyn: 28_000_00, what: "айлық" },
  { expenseId: renatExpense[0].id, userId: RENAT, periodKey: "2026-10", amountTiyn: 100_000_00, what: "аванс" },
];

for (const link of LINKS) {
  const expenseRef = db.collection("expenses").doc(link.expenseId);
  const expense = (await expenseRef.get()).data();
  const worker = (await db.collection("users").doc(link.userId).get()).data();
  if (!expense || !worker) throw new Error(`${link.expenseId}: expense or worker not found`);
  if (expense.amountTiyn !== link.amountTiyn) throw new Error(`${link.expenseId}: expected ${fmt(link.amountTiyn)}, found ${fmt(expense.amountTiyn)}`);
  const line = `${expense.date} | ${expense.name} | ${fmt(expense.amountTiyn)} → ${worker.name}, ${link.periodKey} (${link.what})`;
  if (expense.advanceId) { console.log(`already linked: ${line}`); continue; }
  console.log(line);
  if (!APPLY) continue;
  const advanceRef = db.collection("advances").doc();
  const batch = db.batch();
  batch.set(advanceRef, {
    userId: link.userId, userName: worker.name, periodKey: link.periodKey, amountTiyn: expense.amountTiyn,
    note: `Касса: ${expense.name}${expense.comment ? ` · ${expense.comment}` : ""} (${expense.date.slice(8, 10)}.${expense.date.slice(5, 7)}) — ${link.what}`,
    paidAt: FieldValue.serverTimestamp(), recordedByUid: actor.uid, recordedByName: actor.name,
    reversed: false, expenseId: expenseRef.id, createdAt: FieldValue.serverTimestamp(),
  });
  batch.update(expenseRef, { paidToUid: link.userId, paidToName: worker.name, payPeriodKey: link.periodKey, advanceId: advanceRef.id });
  batch.set(db.collection("auditLogs").doc(), {
    userId: actor.uid, userName: actor.name, action: "advance.linked_from_cashbox", entityType: "advance",
    entityId: advanceRef.id, before: null,
    after: { userId: link.userId, periodKey: link.periodKey, amountTiyn: expense.amountTiyn, expenseId: expenseRef.id },
    comment: `Касса шығыны айлыққа жазылды: ${line}`, createdAt: FieldValue.serverTimestamp(),
  });
  await batch.commit();
}
console.log(APPLY ? "✅ Done." : "Dry run only — add --apply to write.");
