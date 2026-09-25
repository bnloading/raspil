// Makes "Нұр" -> Депозит an explicit fact on the paymentMethods doc instead of an implicit
// fallback (accountForMethod in lib/cashbox.ts already resolves it to "deposit" today — this
// removes the one remaining bit of "it works because nothing overrides the default" and turns it
// into "it works because the catalogue says so"). No order, payment or worker-history record is
// touched — only the payment METHOD's own catalogue entry.
//
//   node --env-file=.env.local scripts/lock-nur-as-deposit-2026-09-24.mjs          # dry run
//   node --env-file=.env.local scripts/lock-nur-as-deposit-2026-09-24.mjs --apply

import { readFileSync } from "node:fs";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const APPLY = process.argv.includes("--apply");
const sa = JSON.parse(readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, "utf8"));
if (getApps().length === 0) initializeApp({ credential: cert(sa) });
const db = getFirestore();

const ref = db.collection("paymentMethods").doc("nur");
const before = (await ref.get()).data();
console.log("Қазіргі 'nur' жазбасы:", JSON.stringify(before));
console.log("Жаңа мән: account = \"deposit\" (нақты белгіленеді)");

if (!APPLY) {
  console.log("\nDRY RUN — ештеңе жазылған жоқ.");
} else {
  await ref.set({ account: "deposit" }, { merge: true });
  console.log("\n✅ Жазылды.");
}
