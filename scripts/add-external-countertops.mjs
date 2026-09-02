// Adds the two "customer's own countertop" catalogue entries the journal prices by length.
//
// A столешница is not a sheet: it comes in fixed lengths, it is cut once, and the shop quotes the
// job — 3 м for 2000 ₸, 4 м for 3000 ₸ (see EXTERNAL_COUNTERTOP_PRICES_TIYN in
// src/lib/journalPricing.ts, which fills the charge in automatically when one is picked).
//
//   node --env-file=.env.local scripts/add-external-countertops.mjs           # report only
//   node --env-file=.env.local scripts/add-external-countertops.mjs --write   # apply
//
// Idempotent: matched by name, so re-running it updates the existing rows rather than adding a
// second copy. Nothing else in the catalogue is touched.

import { readFileSync } from "node:fs";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const write = process.argv.includes("--write");

const sa = JSON.parse(readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, "utf8"));
if (getApps().length === 0) initializeApp({ credential: cert(sa) });
const db = getFirestore();

/**
 * The shop sells the labour, not the board, so sellingPriceTiyn is 0 and stockTracked is false:
 * a customer's own countertop has no warehouse balance to draw down and must never be able to
 * block a job for being "out of stock".
 */
const ENTRIES = [
  {
    name: "Сырттан келетін столешница 3м",
    article: "EXT-TOP-3",
    color: "Сырттан",
    thicknessMm: 38,
    sheetLengthMm: 3000,
    sheetWidthMm: 600,
  },
  {
    name: "Сырттан келетін столешница 4м",
    article: "EXT-TOP-4",
    color: "Сырттан",
    thicknessMm: 38,
    sheetLengthMm: 4000,
    sheetWidthMm: 600,
  },
];

const existing = await db.collection("materials").get();
const byName = new Map(existing.docs.map((d) => [(d.data().name ?? "").trim().toLowerCase(), d]));

const plan = ENTRIES.map((e) => {
  const found = byName.get(e.name.toLowerCase());
  return { entry: e, id: found?.id ?? null };
});

const lines = [`Каталогта ${existing.size} материал бар.`, ""];
for (const p of plan) {
  lines.push(`  ${p.entry.name.padEnd(34)} ${p.id ? `бар (${p.id}) — жаңартылады` : "жоқ — қосылады"}`);
}
lines.push("", write ? "Жазылуда…" : "Бұл — тек тексеру. Жазу үшін --write қосыңыз.");
console.log(lines.join("\n"));

if (write) {
  for (const p of plan) {
    const data = {
      ...p.entry,
      category: "countertop",
      // Labour only: the board belongs to the customer.
      sellingPriceTiyn: 0,
      stockTracked: false,
      qtyOnHand: 0,
      reservedQty: 0,
      initialQty: 0,
      minStock: 0,
      active: true,
      archived: false,
      grainDirectionRequired: false,
      note: "Клиенттің өз столешницасы — тек кесу қызметі. Бағасы ұзындығы бойынша журналда автоматты қойылады.",
    };
    if (p.id) await db.collection("materials").doc(p.id).set(data, { merge: true });
    else await db.collection("materials").add({ ...data, createdAt: FieldValue.serverTimestamp() });
  }
  console.log(`\n✅ ${plan.length} жазба каталогқа жазылды.`);
}

// Not process.exit(): on Windows that truncates whatever is still queued on a piped stdout, and
// the report above is the whole point of the dry run.
await db.terminate();
