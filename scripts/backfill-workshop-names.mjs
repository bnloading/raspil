// Fills in customerName on workshop-board rows that were written before the board carried names.
//
// The board (/workshopActivity) is rebuilt from scratch on every order status transition, so new
// rows carry the name already and this is only needed once, for the orders that were sitting on
// the floor when the field was added. Without it those rows keep showing their anonymous code
// until somebody happens to start or finish them.
//
//   node --env-file=.env.local scripts/backfill-workshop-names.mjs            # report only
//   node --env-file=.env.local scripts/backfill-workshop-names.mjs --write    # apply
//
// Additive and idempotent: it only ever sets customerName, never touches the stage, the queue
// position or anything else the shop floor writes, and re-running it changes nothing once the
// names match. A row whose order has since been deleted is reported and left alone.

import { readFileSync } from "node:fs";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const write = process.argv.includes("--write");

const sa = JSON.parse(readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, "utf8"));
if (getApps().length === 0) initializeApp({ credential: cert(sa) });
const db = getFirestore();

const rows = await db.collection("workshopActivity").get();
console.log(`Тақтада ${rows.size} жол бар.\n`);

const toFix = [];
const orphans = [];
let alreadyNamed = 0;

for (const row of rows.docs) {
  const data = row.data();
  // The board document id IS the order id (see lib/workshopActivity.ts).
  const orderSnap = await db.collection("orders").doc(row.id).get();

  if (!orderSnap.exists) {
    orphans.push({ id: row.id, orderNumber: data.orderNumber });
    continue;
  }

  const name = (orderSnap.data().customerName ?? "").trim();
  if ((data.customerName ?? "") === name) {
    alreadyNamed += 1;
    continue;
  }
  toFix.push({ id: row.id, orderNumber: data.orderNumber, name, stage: data.stage });
}

for (const r of toFix) {
  console.log(`  ${r.orderNumber.padEnd(20)} ${r.stage.padEnd(10)} → "${r.name || "(атсыз)"}"`);
}
if (orphans.length > 0) {
  console.log(`\n⚠ ${orphans.length} жолдың заказы табылмады (қолмен қаралсын):`);
  for (const o of orphans) console.log(`  ${o.orderNumber} (${o.id})`);
}

console.log(`\nАты бар: ${alreadyNamed} · Түзетілетін: ${toFix.length} · Иесіз: ${orphans.length}`);

if (!write) {
  console.log("\nБұл — тек тексеру. Жазу үшін --write қосыңыз.");
  process.exit(0);
}

if (toFix.length === 0) {
  console.log("\nТүзетілетін жол жоқ.");
  process.exit(0);
}

// One batch: 500 is Firestore's limit and the board never holds anything close to that, but the
// chunking is here so a busy month cannot silently drop the tail.
for (let i = 0; i < toFix.length; i += 400) {
  const batch = db.batch();
  for (const r of toFix.slice(i, i + 400)) {
    batch.update(db.collection("workshopActivity").doc(r.id), { customerName: r.name });
  }
  await batch.commit();
}

console.log(`\n✅ ${toFix.length} жолға ат жазылды.`);
