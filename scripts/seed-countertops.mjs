// Adds the countertop (столешница) range to the warehouse so it can be picked in the journal and
// the order builder like any other sheet.
//
//   Ақ · Вотан · Бнуратти · Белый · Мрамор берил · Бежевый — 24 000 ₸ each
//
// Category "countertop" already exists and is what the salary engine charges the 200 ₸/piece
// cutting rate against (see src/lib/salary.ts).
//
// Safe to re-run: keyed by fixed document ids, and an existing row's stock is never touched —
// only the price is corrected if it has drifted from the list above.
//   node --env-file=.env.local scripts/seed-countertops.mjs

import { readFileSync } from "node:fs";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const sa = JSON.parse(readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, "utf8"));
if (getApps().length === 0) initializeApp({ credential: cert(sa) });
const db = getFirestore();

const T = (tenge) => tenge * 100;
const PRICE = T(24000);

// A countertop is sold as a length of worktop, not a 2800×2070 sheet. 3000×600 is the standard
// blank; the journal treats it as one "лист" either way.
const COLOURS = [
  { id: "top-ak", color: "Ақ", article: "ST-001" },
  { id: "top-votan", color: "Вотан", article: "ST-002" },
  { id: "top-bunratti", color: "Бнуратти", article: "ST-003" },
  { id: "top-belyi", color: "Белый", article: "ST-004" },
  { id: "top-mramor-beril", color: "Мрамор берил", article: "ST-005" },
  { id: "top-bezhevyi", color: "Бежевый", article: "ST-006" },
];

let created = 0;
let repriced = 0;

for (const c of COLOURS) {
  const ref = db.collection("materials").doc(c.id);
  const snap = await ref.get();

  if (!snap.exists) {
    await ref.set({
      name: `Столешница ${c.color}`,
      category: "countertop",
      article: c.article,
      color: c.color,
      thicknessMm: 38,
      sheetLengthMm: 3000,
      sheetWidthMm: 600,
      sellingPriceTiyn: PRICE,
      initialQty: 0,
      qtyOnHand: 0,
      reservedQty: 0,
      minStock: 2,
      active: true,
      archived: false,
      grainDirectionRequired: false,
      createdAt: FieldValue.serverTimestamp(),
    });
    console.log(`  + Столешница ${c.color} — ${PRICE / 100} ₸`);
    created++;
    continue;
  }

  const cur = snap.data();
  if (cur.sellingPriceTiyn !== PRICE) {
    await ref.set({ sellingPriceTiyn: PRICE }, { merge: true });
    console.log(`  ~ ${cur.name}: ${cur.sellingPriceTiyn / 100} → ${PRICE / 100} ₸`);
    repriced++;
  } else {
    console.log(`  = ${cur.name} — өзгеріссіз`);
  }
}

console.log(`\ncreated: ${created}, repriced: ${repriced}, total: ${COLOURS.length}`);
console.log("Қалдықтары 0 — Қойма бетінен «+ Қабылдау» арқылы кіріс жасаңыз.");
process.exit(0);
