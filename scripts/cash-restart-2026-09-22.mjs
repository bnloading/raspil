// Restarts the shop's cash accounting on 2026-09-22 — same operation the Admin-only "Есеп басталу
// күні" / "Депозит" fields on the Касса page (OpeningBalanceEditor, ManagerCashbox.tsx) perform,
// just done here for a round number handed over outside the app.
//
// Current state before this script (read 2026-09-23):
//   cashStartDate:                     2026-09-18
//   cashOpeningBalanceTiyn.ldsp.deposit: 1 467 781 ₸
//
// After --apply:
//   cashStartDate:                     2026-09-22
//   cashOpeningBalanceTiyn.ldsp.deposit: 4 253 791 ₸
//
// Only ldsp.deposit is touched — mdf has no line of its own yet (1 order total) and cash (қолма-қол)
// was never set, so both are left exactly as they are. Payments/expenses dated before the new start
// date drop out of Касса/Таза пайда from this point on, same as every earlier restart; order history
// itself is untouched (see lib/finance.ts, lib/cashbox.ts).
//
//   node --env-file=.env.local scripts/cash-restart-2026-09-22.mjs          # dry run, writes nothing
//   node --env-file=.env.local scripts/cash-restart-2026-09-22.mjs --apply

import { readFileSync } from "node:fs";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const APPLY = process.argv.includes("--apply");
const NEW_START_DATE = "2026-09-22";
const NEW_DEPOSIT_TENGE = 4_253_791;
const NEW_DEPOSIT_TIYN = NEW_DEPOSIT_TENGE * 100;

const sa = JSON.parse(readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, "utf8"));
if (getApps().length === 0) initializeApp({ credential: cert(sa) });
const db = getFirestore();

const ref = db.collection("applicationSettings").doc("global");
const before = (await ref.get()).data() ?? {};

console.log("Қазіргі жағдай:");
console.log("  cashStartDate:", before.cashStartDate ?? "(жоқ)");
console.log("  cashOpeningBalanceTiyn.ldsp.deposit:", before.cashOpeningBalanceTiyn?.ldsp?.deposit ?? "(жоқ)",
  before.cashOpeningBalanceTiyn?.ldsp?.deposit ? `(${(before.cashOpeningBalanceTiyn.ldsp.deposit / 100).toLocaleString("kk-KZ")} ₸)` : "");

console.log("\nЖаңа жағдай:");
console.log("  cashStartDate:", NEW_START_DATE);
console.log("  cashOpeningBalanceTiyn.ldsp.deposit:", NEW_DEPOSIT_TIYN, `(${NEW_DEPOSIT_TENGE.toLocaleString("kk-KZ")} ₸)`);

if (!APPLY) {
  console.log("\nDRY RUN — ештеңе жазылған жоқ. Растасаңыз, --apply қосып қайта жіберіңіз.");
} else {
  await ref.set(
    {
      cashStartDate: NEW_START_DATE,
      cashOpeningBalanceTiyn: { ldsp: { deposit: NEW_DEPOSIT_TIYN } },
    },
    { merge: true },
  );
  console.log("\n✅ Жазылды.");
}
