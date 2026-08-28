// Writes the shop's standing profit-allocation rule so the Қаржы report shows a configured
// category rather than falling back to the hard-coded constant in src/lib/finance.ts.
//
//   Станок / мусор : 5% of monthly gross profit
//
// Safe to re-run — keyed by a fixed document id, and it never overwrites a percentage an Admin has
// since changed in the UI.
//   node --env-file=.env.local scripts/seed-expense-categories.mjs

import { readFileSync } from "node:fs";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const sa = JSON.parse(readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, "utf8"));
if (getApps().length === 0) initializeApp({ credential: cert(sa) });
const db = getFirestore();

const ID = "machine-waste";
const ref = db.collection("expenseCategories").doc(ID);
const existing = await ref.get();

if (existing.exists) {
  console.log(`already present: ${existing.data().name} — ${existing.data().percentage}% (left as is)`);
} else {
  await ref.set({
    name: "Станок / мусор",
    percentage: 5,
    active: true,
    createdAt: FieldValue.serverTimestamp(),
  });
  console.log("created: Станок / мусор — 5%");
}

process.exit(0);
