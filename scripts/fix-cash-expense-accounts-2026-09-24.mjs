// Re-books the expenses that were paid out of the CASH drawer but recorded against the DEPOSIT.
//
// On 24.09 the shop took 474 000 ₸ in cash (Бекзат Ержан 24 000, Канат 110 000, Ернат 340 000)
// and logged fifteen expenses — every one of them against the deposit, none against the drawer.
// Two of them are provably the drawer's money:
//
//   "Сүндет 110"   110 000 ₸ — the exact amount Канат paid in cash the same day
//   "Здача Ернат"    1 640 ₸ — change handed back out of Ернат's 340 000 ₸ cash
//
// Booking those to the deposit pushes the deposit down and the drawer up by the same amount, so
// the two accounts are wrong in opposite directions — a 220 000 ₸ swing on the 110 000 alone.
// No money is created or destroyed here: only which pot it left.
//
//   node --env-file=.env.local scripts/fix-cash-expense-accounts-2026-09-24.mjs          # dry run
//   node --env-file=.env.local scripts/fix-cash-expense-accounts-2026-09-24.mjs --apply

import { readFileSync } from "node:fs";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const APPLY = process.argv.includes("--apply");
const sa = JSON.parse(readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, "utf8"));
if (getApps().length === 0) initializeApp({ credential: cert(sa) });
const db = getFirestore();
const tg = (t) => ((t ?? 0) / 100).toLocaleString("kk-KZ");

/** Expense ids that are drawer money, with what proves it. */
const TO_CASH = [
  { id: "jxaJjuQIAidXZZbVdHL0", why: "Канаттың сол күнгі 110 000 ₸ қолма-қол төлемімен дәл сәйкес" },
  { id: "FCbOAZWT9PbKo09vkxrY", why: "Ернаттың 340 000 ₸ қолма-қол төлемінен қайтарылған здача" },
];

let moved = 0;
for (const t of TO_CASH) {
  const ref = db.collection("expenses").doc(t.id);
  const snap = await ref.get();
  if (!snap.exists) { console.log(`  ⚠️ ${t.id} табылмады`); continue; }
  const e = snap.data();
  const from = e.account ?? "cash";
  console.log(`"${e.name}" · ${tg(e.amountTiyn)} ₸ · ${e.date}`);
  console.log(`   шот: ${from} → cash     (${t.why})`);
  if (from === "cash") { console.log("   әлдеқашан дұрыс, өзгертілмейді"); continue; }
  moved += e.amountTiyn ?? 0;
  if (APPLY) await ref.update({ account: "cash" });
}

console.log(`\nДепозиттен қолма-қолға ауысатын сома: ${tg(moved)} ₸`);
console.log(`  Депозит қалдығы  ${tg(moved)} ₸ ӨСЕДІ`);
console.log(`  Қолма-қол қалдығы ${tg(moved)} ₸ АЗАЯДЫ`);
console.log(`  (екеуінің жиыны өзгермейді)`);
console.log(APPLY ? "\n✅ Жазылды." : "\nDRY RUN — ештеңе жазылған жоқ. Растасаңыз --apply қосыңыз.");
