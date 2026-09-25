// Gives Pay and Kaspi their own cash accounts instead of sharing one "Депозит" pot with Нұр.
//
// The Касса merged every transfer method into a single balance, so the page could never be read
// against any one bank statement: Нұр 1 872 120 + Pay 261 200 showed as 2 133 320. Нұр keeps the
// "deposit" account id — every record already written under it is Нұр money, and that account
// reconciled to the tiyn (4 253 791 + 1 872 120 − 1 823 164 = 4 302 747).
//
// Only the METHOD catalogue is touched. No payment, expense or order is modified: each payment's
// account is derived from its method at read time (lib/cashbox.ts accountForMethod), so the split
// applies to the whole history at once.
//
//   node --env-file=.env.local scripts/split-cash-accounts-2026-09-24.mjs          # dry run
//   node --env-file=.env.local scripts/split-cash-accounts-2026-09-24.mjs --apply

import { readFileSync } from "node:fs";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const APPLY = process.argv.includes("--apply");
const sa = JSON.parse(readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, "utf8"));
if (getApps().length === 0) initializeApp({ credential: cert(sa) });
const db = getFirestore();
const tg = (t) => ((t ?? 0) / 100).toLocaleString("kk-KZ");
const dk = (ts) => ts?.toDate ? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Almaty" }).format(ts.toDate()) : null;

/** method id → the account its money actually lands in. Kaspi and Pay are the same
 *  account under two names, so both point at "pay". */
const MAP = { nur: "deposit", pay: "pay", kaspi: "pay", cash: "cash" };

const START = (await db.collection("applicationSettings").doc("global").get()).data()?.cashStartDate;
const pays = (await db.collection("payments").get()).docs.map((d) => d.data()).filter((p) => !p.reversed);

for (const [id, account] of Object.entries(MAP)) {
  const ref = db.collection("paymentMethods").doc(id);
  const snap = await ref.get();
  if (!snap.exists) { console.log(`  ⚠️ ${id} табылмады`); continue; }
  const m = snap.data();
  const mine = pays.filter((p) => p.methodId === id);
  const now = mine.filter((p) => (dk(p.paymentDate) ?? "") >= START);
  console.log(`${String(m.name).padEnd(16)} account: ${String(m.account ?? "(жоқ, әдепкі)").padEnd(14)} → ${account}`);
  console.log(`   ${mine.length} төлем, барлығы ${tg(mine.reduce((s, p) => s + (p.amountTiyn ?? 0), 0))} ₸ · ${START}-дан ${tg(now.reduce((s, p) => s + (p.amountTiyn ?? 0), 0))} ₸`);
  if (APPLY && m.account !== account) await ref.update({ account });
}

console.log(APPLY ? "\n✅ Жазылды. Касса енді үш бөлек шот көрсетеді: Нұр · Kaspi/Pay · Қолма-қол." : "\nDRY RUN — ештеңе жазылған жоқ.");
