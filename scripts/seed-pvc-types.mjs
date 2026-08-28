// The shop's PVC edge-banding range.
//
//   Ақ            — 200 ₸/м
//   Серый, Вотан, Каньон, Честер, Бнуратти, Кашемир, Санома — 220 ₸/м
//
// Seeded at 1 mm, the thickness the shop actually stocks these colours in. Ақ already exists in
// 0.4 / 1 / 2 mm and is left exactly as it is.
//
// Safe to re-run — each row has a fixed document id, and an existing row's price is only corrected
// if it disagrees with the list above.
//   node --env-file=.env.local scripts/seed-pvc-types.mjs

import { readFileSync } from "node:fs";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const sa = JSON.parse(readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, "utf8"));
if (getApps().length === 0) initializeApp({ credential: cert(sa) });
const db = getFirestore();

const T = (tenge) => tenge * 100;

const COLOURS = [
  { id: "pvc-1-white", colorName: "Ақ", pricePerMeterTiyn: T(200) },
  { id: "pvc-1-gray", colorName: "Серый", pricePerMeterTiyn: T(220) },
  { id: "pvc-1-votan", colorName: "Вотан", pricePerMeterTiyn: T(220) },
  { id: "pvc-1-kanyon", colorName: "Каньон", pricePerMeterTiyn: T(220) },
  { id: "pvc-1-chester", colorName: "Честер", pricePerMeterTiyn: T(220) },
  { id: "pvc-1-bnuratti", colorName: "Бнуратти", pricePerMeterTiyn: T(220) },
  { id: "pvc-1-kashemir", colorName: "Кашемир", pricePerMeterTiyn: T(220) },
  { id: "pvc-1-sanoma", colorName: "Санома", pricePerMeterTiyn: T(220) },
];

let created = 0;
let repriced = 0;

for (const c of COLOURS) {
  const ref = db.collection("pvcTypes").doc(c.id);
  const snap = await ref.get();
  const row = { ...c, thicknessMm: 1, active: true };

  if (!snap.exists) {
    await ref.set(row);
    console.log(`  + ${c.colorName} — ${c.pricePerMeterTiyn / 100} ₸/м`);
    created++;
    continue;
  }

  const current = snap.data();
  if (current.pricePerMeterTiyn !== c.pricePerMeterTiyn) {
    await ref.set({ pricePerMeterTiyn: c.pricePerMeterTiyn }, { merge: true });
    console.log(`  ~ ${c.colorName}: ${current.pricePerMeterTiyn / 100} → ${c.pricePerMeterTiyn / 100} ₸/м`);
    repriced++;
  } else {
    console.log(`  = ${c.colorName} — ${c.pricePerMeterTiyn / 100} ₸/м (өзгеріссіз)`);
  }
}

console.log(`\ncreated: ${created}, repriced: ${repriced}, total in list: ${COLOURS.length}`);
process.exit(0);
