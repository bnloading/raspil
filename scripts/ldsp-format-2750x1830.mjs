// Sets every ЛДСП sheet in the catalogue to the shop's real format, 2750 × 1830 mm.
//
// Eight of the twelve ЛДСП rows still carried 2800 × 2070 (the seed's format); the other four were
// already right. Only `category: "ldsp"` is touched — ХДФ, МДФ and столешница keep their own
// formats. Orders already written keep the dimensions in their own materialSnapshot, so nothing
// historical moves; what changes is what the sheet estimator, the "fits on a sheet" check and the
// m² figures use from now on.
//
//   node --env-file=.env.local scripts/ldsp-format-2750x1830.mjs          # dry run
//   node --env-file=.env.local scripts/ldsp-format-2750x1830.mjs --apply

import { readFileSync } from "node:fs";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const APPLY = process.argv.includes("--apply");
const LENGTH_MM = 2750;
const WIDTH_MM = 1830;

const sa = JSON.parse(readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, "utf8"));
if (getApps().length === 0) initializeApp({ credential: cert(sa) });
const db = getFirestore();

const snap = await db.collection("materials").orderBy("name").get();
const ldsp = snap.docs.filter((d) => (d.data().category ?? "ldsp") === "ldsp");
const toFix = ldsp.filter((d) => d.data().sheetLengthMm !== LENGTH_MM || d.data().sheetWidthMm !== WIDTH_MM);

console.log(`ЛДСП материалдары: ${ldsp.length}, өзгертілетіні: ${toFix.length}\n`);
for (const d of ldsp) {
  const m = d.data();
  const now = `${m.sheetLengthMm}×${m.sheetWidthMm}`;
  const needs = toFix.includes(d);
  console.log(`  ${needs ? "→" : " ="} ${now.padEnd(11)} ${needs ? `→ ${LENGTH_MM}×${WIDTH_MM}` : "(өзгермейді)".padEnd(13)}  ${m.name}`);
}

if (!APPLY) {
  console.log("\nDRY RUN — ештеңе жазылған жоқ. Растасаңыз --apply қосыңыз.");
} else {
  for (const d of toFix) {
    await d.ref.update({ sheetLengthMm: LENGTH_MM, sheetWidthMm: WIDTH_MM });
  }
  console.log(`\n✅ ${toFix.length} материалдың форматы ${LENGTH_MM}×${WIDTH_MM} болып жазылды.`);
}
