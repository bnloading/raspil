// Applies the shop's real pay rules and tags each material with its category, which is what the
// per-sheet rates are charged against.
//
//   Распилшик : 600 ₸ / ЛДСП лист · 100 ₸ / ХДФ · 200 ₸ / столешница
//   ПВХ        : 350 000 ₸ тұрақты айлық
//
// Safe to re-run — everything is an idempotent merge keyed by user/material id.
//   node --env-file=.env.local scripts/seed-salary-rules.mjs

import { readFileSync } from "node:fs";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const sa = JSON.parse(readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, "utf8"));
if (getApps().length === 0) initializeApp({ credential: cert(sa) });
const db = getFirestore();

const T = (tenge) => tenge * 100; // tiyn

// --- 1. Material categories -------------------------------------------------
// Guessed from the name, then written explicitly so pay never depends on a guess again.
function guessCategory(name = "") {
  const n = name.toLowerCase();
  if (n.includes("хдф") || n.includes("hdf")) return "hdf";
  if (n.includes("столеш") || n.includes("countertop")) return "countertop";
  return "ldsp";
}

const materials = await db.collection("materials").get();
let tagged = 0;
for (const d of materials.docs) {
  const data = d.data();
  if (data.category) continue; // already set by an admin — never overwrite a human decision
  const category = guessCategory(data.name);
  await d.ref.set({ category }, { merge: true });
  console.log(`  ${data.name} → ${category}`);
  tagged++;
}
console.log(`materials tagged: ${tagged} (of ${materials.size})`);

// --- 2. Pay rules -----------------------------------------------------------
const users = await db.collection("users").where("role", "in", ["raspil", "pvh"]).get();
let ruled = 0;
for (const d of users.docs) {
  const u = d.data();
  const rule =
    u.role === "raspil"
      ? {
          mode: "PER_SHEET",
          perSheetTiyn: T(600),
          perHdfSheetTiyn: T(100),
          perCountertopTiyn: T(200),
        }
      : { mode: "FIXED_MONTHLY", fixedMonthlyTiyn: T(350000) };

  await db.collection("salaryRules").doc(d.id).set(
    { userId: d.id, ...rule, updatedAt: FieldValue.serverTimestamp(), updatedByName: "seed" },
    { merge: true },
  );
  console.log(`  ${u.name} (${u.role}) → ${rule.mode}`);
  ruled++;
}
console.log(`pay rules written: ${ruled}`);
process.exit(0);
