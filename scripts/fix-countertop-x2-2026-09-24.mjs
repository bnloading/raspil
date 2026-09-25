// Repairs the orders the countertop double-charge left over-billed.
//
// The bug (fixed in lib/journalPricing.ts cuttingCostForLines): a "Сырттан келетін столешница"
// line carrying its own price was ALSO charged the standing cutting fee, so one 3 м top billed
// 2 000 + 2 000 and one 4 м top 3 000 + 3 000. This recomputes each affected order the way the
// journal now prices it — the fee is dropped, the price the manager typed on the line stays — and
// rewrites totalTiyn/debtTiyn/paymentStatus from that. Payments are never touched.
//
//   node --env-file=.env.local scripts/fix-countertop-x2-2026-09-24.mjs          # dry run
//   node --env-file=.env.local scripts/fix-countertop-x2-2026-09-24.mjs --apply

import { readFileSync } from "node:fs";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const APPLY = process.argv.includes("--apply");
const sa = JSON.parse(readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, "utf8"));
if (getApps().length === 0) initializeApp({ credential: cert(sa) });
const db = getFirestore();
const tg = (t) => ((t ?? 0) / 100).toLocaleString("kk-KZ");

const JOINT = 2000;
const PRICES = { 3: 200000, 4: 300000 };
const lenOf = (name = "") => {
  const m = name.toLowerCase().match(/(\d+(?:[.,]\d+)?)\s*м(?![a-zа-яё])/u);
  return m ? Number(m[1].replace(",", ".")) : null;
};
const isExternalTop = (name = "") => {
  const n = name.toLowerCase();
  return n.includes("сырттан") && n.includes("столеш");
};

const [oS, mS] = await Promise.all([db.collection("orders").get(), db.collection("materials").get()]);
const mats = new Map(mS.docs.map((d) => [d.id, d.data()]));

const fixes = [];
for (const d of oS.docs) {
  const o = d.data();
  const items = o.items ?? [];
  if (items.length === 0) continue;

  // The fee the journal WOULD charge now: only for a countertop line with no price of its own.
  let cuttingNow = 0;
  let doubled = false;
  for (const l of items) {
    const name = mats.get(l.materialId)?.name ?? l.materialName ?? "";
    if (!isExternalTop(name)) continue;
    const len = lenOf(name);
    const fee = len && PRICES[len] ? PRICES[len] * (l.sheetQty ?? 0) : 0;
    // Only a line that actually bills for the top (a price AND a quantity) is a double charge.
    // A price with no quantity behind it bills nothing, so that order's fee is its only charge —
    // ORD-2026-000209 is exactly that, and zeroing it would have made the order free.
    if ((l.sheetPriceTiyn ?? 0) > 0 && (l.sheetQty ?? 0) > 0) doubled = true;
    else cuttingNow += fee;
  }
  if (!doubled) continue;
  if ((o.cuttingCostTiyn ?? 0) === cuttingNow) continue; // already right

  const material = items.reduce((s, l) => s + Math.round((l.sheetQty ?? 0) * (l.sheetPriceTiyn ?? 0)), 0);
  const pvc = items.reduce((s, l) => s + Math.round((l.pvcMeters ?? 0) * ((l.pvcPricePerMeterTiyn ?? 0) + (l.pvcJointed ? JOINT : 0))), 0);

  // Some rows were already patched by hand: the manager saw the doubled figure and wrote a
  // "жеңілдік" for exactly the bogus fee to cancel it out (ORD-2026-000209). Removing the fee
  // without removing that discount would charge the customer nothing at all, so a discount that
  // matches the fee to the tiyn is understood as the workaround it is and lifted with it.
  const feeRemoved = (o.cuttingCostTiyn ?? 0) - cuttingNow;
  const discount = (o.discountTiyn ?? 0) === feeRemoved ? 0 : (o.discountTiyn ?? 0);

  const total = Math.max(0, material + pvc + (o.hdfCostTiyn ?? 0) + cuttingNow
    + (o.extraServicesTiyn ?? 0) + (o.deliveryCostTiyn ?? 0) - discount);
  const paid = o.paidTiyn ?? 0;
  const debt = total - paid;
  const status = paid <= 0 ? "unpaid" : paid < total ? "partial" : paid === total ? "paid" : "overpaid";

  fixes.push({ id: d.id, o, cuttingNow, discount, total, debt, status });
}

console.log(`Түзетуді қажет ететін заказ: ${fixes.length}\n`);
for (const f of fixes) {
  console.log(`№${f.o.orderNumber} · ${f.o.customerName} · ${f.o.productionStatus}`);
  console.log(`   кесу : ${tg(f.o.cuttingCostTiyn)} → ${tg(f.cuttingNow)} ₸`);
  if ((f.o.discountTiyn ?? 0) !== f.discount)
    console.log(`   жеңілдік (қолмен өтеу): ${tg(f.o.discountTiyn)} → ${tg(f.discount)} ₸`);
  console.log(`   сома : ${tg(f.o.totalTiyn)} → ${tg(f.total)} ₸   (${tg(f.total - (f.o.totalTiyn ?? 0))} ₸)`);
  console.log(`   қарыз: ${tg(f.o.debtTiyn)} → ${tg(f.debt)} ₸ · төлем күйі: ${f.o.paymentStatus} → ${f.status}`);
}
const delta = fixes.reduce((s, f) => s + (f.total - (f.o.totalTiyn ?? 0)), 0);
console.log(`\nЖалпы азаятын сома: ${tg(delta)} ₸`);

if (!APPLY) {
  console.log("\nDRY RUN — ештеңе жазылған жоқ. Растасаңыз --apply қосып жіберіңіз.");
} else {
  for (const f of fixes) {
    await db.collection("orders").doc(f.id).update({
      cuttingCostTiyn: f.cuttingNow,
      discountTiyn: f.discount,
      totalTiyn: f.total,
      debtTiyn: f.debt,
      paymentStatus: f.status,
    });
  }
  console.log(`\n✅ ${fixes.length} заказ түзетілді.`);
}
