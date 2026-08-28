// Fills in Order.pvcByType for orders created before that field existed, by reading each order's
// `parts` subcollection once. After this, the "ПВХ шығыны" report needs orders only.
//
// Mirrors src/lib/pricing.ts computePvcBreakdown exactly — same A/C = width, B/D = length edge
// convention, same thickness|colour grouping.
//
// Safe to re-run: orders that already have pvcByType are skipped, and an order with no PVC edges
// is written an empty array so it is not re-examined on the next run.
//   node --env-file=.env.local scripts/backfill-pvc-usage.mjs

import { readFileSync } from "node:fs";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const sa = JSON.parse(readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, "utf8"));
if (getApps().length === 0) initializeApp({ credential: cert(sa) });
const db = getFirestore();

const EDGE_KEYS = ["A", "B", "C", "D"];

/** A and C run along the width; B and D along the length. */
function edgeLengthMm(part, edge) {
  return edge === "A" || edge === "C" ? part.widthMm : part.lengthMm;
}

const pvcSnap = await db.collection("pvcTypes").get();
const pvcById = new Map(pvcSnap.docs.map((d) => [d.id, d.data()]));
console.log(`pvc types: ${pvcById.size}`);

const orders = await db.collection("orders").get();
let written = 0;
let skipped = 0;
let empty = 0;

for (const doc of orders.docs) {
  if (Array.isArray(doc.data().pvcByType)) {
    skipped++;
    continue;
  }

  const parts = await doc.ref.collection("parts").get();
  const byKey = new Map();

  for (const p of parts.docs) {
    const part = p.data();
    for (const edge of EDGE_KEYS) {
      const e = part.edges?.[edge];
      if (!e?.pvc || !e.pvcTypeId) continue;
      const type = pvcById.get(e.pvcTypeId);
      if (!type) continue;

      const meters = (edgeLengthMm(part, edge) * (part.qty || 1)) / 1000;
      const costTiyn = Math.round(meters * type.pricePerMeterTiyn);
      const key = `${type.thicknessMm}|${type.colorName}`;
      const existing = byKey.get(key);
      if (existing) {
        existing.meters += meters;
        existing.costTiyn += costTiyn;
      } else {
        byKey.set(key, {
          pvcTypeId: e.pvcTypeId,
          colorName: type.colorName,
          thicknessMm: type.thicknessMm,
          meters,
          costTiyn,
        });
      }
    }
  }

  const pvcByType = [...byKey.values()].sort((a, b) => b.meters - a.meters);
  await doc.ref.set({ pvcByType }, { merge: true });

  if (pvcByType.length === 0) {
    empty++;
  } else {
    written++;
    const summary = pvcByType.map((r) => `${r.colorName} ${r.meters.toFixed(2)}м`).join(", ");
    console.log(`  ${doc.data().orderNumber}: ${summary}`);
  }
}

console.log(`\norders: ${orders.size} — with PVC: ${written}, no PVC edges: ${empty}, already done: ${skipped}`);
process.exit(0);
