// Takes "Pay" out of the shop's payment methods.
//
// Why: the Касса merges every transfer method into one "Депозит" pot, so Нұр (1 872 120 ₸) and
// Pay (261 200 ₸ this period) are shown as one figure — which is why the page never matched the
// owner's Нұр account. Pay is not junk: 33 payments, 2 662 160 ₸ all told.
//
// Two separate steps, because they mean very different things:
//
//   --deactivate   Pay stops being offered for NEW payments. The 33 existing records keep their
//                  method and their money stays exactly where it is. Reversible, nothing moves.
//
//   --to-nur       ALSO re-records every existing Pay payment as "Нұр". Do this ONLY if that
//                  money really did land in the Нұр account — it moves 2 662 160 ₸ between
//                  accounts in the books. Order totals and paid amounts are untouched either way;
//                  only which method/account the money is filed under changes.
//
//   node --env-file=.env.local scripts/remove-pay-method-2026-09-24.mjs                  # dry run
//   node --env-file=.env.local scripts/remove-pay-method-2026-09-24.mjs --deactivate
//   node --env-file=.env.local scripts/remove-pay-method-2026-09-24.mjs --deactivate --to-nur

import { readFileSync } from "node:fs";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const DEACTIVATE = process.argv.includes("--deactivate");
const TO_NUR = process.argv.includes("--to-nur");
const sa = JSON.parse(readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, "utf8"));
if (getApps().length === 0) initializeApp({ credential: cert(sa) });
const db = getFirestore();
const tg = (t) => ((t ?? 0) / 100).toLocaleString("kk-KZ");
const dk = (ts) => ts?.toDate ? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Almaty" }).format(ts.toDate()) : null;

const settings = (await db.collection("applicationSettings").doc("global").get()).data() ?? {};
const START = settings.cashStartDate;
const payDoc = await db.collection("paymentMethods").doc("pay").get();
console.log(`paymentMethods/pay: ${JSON.stringify(payDoc.data())}`);

const pays = (await db.collection("payments").get()).docs
  .map((d) => ({ id: d.id, ...d.data() }))
  .filter((p) => !p.reversed && p.methodId === "pay");
const inPeriod = pays.filter((p) => (dk(p.paymentDate) ?? "") >= START);
const sum = (a) => a.reduce((s, p) => s + (p.amountTiyn ?? 0), 0);

console.log(`\nPay төлемдері: ${pays.length} жазба, ${tg(sum(pays))} ₸`);
console.log(`  оның ағымдағы кезеңде (${START}-дан): ${inPeriod.length} жазба, ${tg(sum(inPeriod))} ₸`);

console.log(`\n1) Әдісті өшіру (active: false): ${DEACTIVATE ? "ЖАСАЛАДЫ" : "жасалмайды"}`);
console.log(`   → жаңа төлемдерде «Pay» енді ұсынылмайды, ескі жазбалар сол күйі қалады`);
console.log(`2) Ескі төлемдерді «Нұр»-ға көшіру: ${TO_NUR ? "ЖАСАЛАДЫ" : "жасалмайды"}`);
console.log(`   → ${tg(sum(pays))} ₸ Pay-дан Нұрға ауысады (ағымдағы кезеңде ${tg(sum(inPeriod))} ₸)`);
console.log(`   → Кассадағы «Депозит» сомасы өзгермейді, тек әдіс бөлінісі өзгереді`);

if (!DEACTIVATE && !TO_NUR) {
  console.log(`\nDRY RUN — ештеңе жазылған жоқ.`);
} else {
  if (DEACTIVATE) {
    await db.collection("paymentMethods").doc("pay").update({ active: false });
    console.log(`\n✅ «Pay» әдісі өшірілді (active: false).`);
  }
  if (TO_NUR) {
    const nur = (await db.collection("paymentMethods").doc("nur").get()).data();
    let n = 0;
    for (const p of pays) {
      await db.collection("payments").doc(p.id).update({
        methodId: "nur",
        methodName: nur?.name ?? "Нұр",
        movedFromMethodId: "pay",
      });
      n++;
    }
    console.log(`✅ ${n} төлем «Нұр»-ға көшірілді (${tg(sum(pays))} ₸).`);
  }
}
