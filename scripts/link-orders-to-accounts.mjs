// Attaches journal orders to the customer accounts that own them.
//
// An order typed into the journal records a name and a phone but, until now, no customerId — so a
// customer who later registered signed in to an empty "Заказдарым" while the shop's ledger held
// six of their orders. New orders are linked as they are written (src/lib/customerLink.ts); this
// is the one-off pass over everything already in the book.
//
//   node --env-file=.env.local scripts/link-orders-to-accounts.mjs           # report only
//   node --env-file=.env.local scripts/link-orders-to-accounts.mjs --write   # apply
//
// Matched on the PHONE, never on the name: names collide, get abbreviated and get typed three
// ways, while the phone is the same key the debt ledger and the merge check already use. An order
// that already has a customerId is never moved, whatever its phone says.

import { readFileSync } from "node:fs";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const write = process.argv.includes("--write");

/** Same rule as src/lib/phone.ts — 11 digits starting 7, or null. */
function normalizePhone(raw) {
  let digits = String(raw ?? "").replace(/\D/g, "");
  if (digits.length === 10) digits = "7" + digits;
  if (digits.length === 11 && digits.startsWith("8")) digits = "7" + digits.slice(1);
  return digits.length === 11 && digits.startsWith("7") ? digits : null;
}

const sa = JSON.parse(readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, "utf8"));
if (getApps().length === 0) initializeApp({ credential: cert(sa) });
const db = getFirestore();

const users = await db.collection("users").where("role", "==", "customer").get();
const uidByPhone = new Map();
for (const u of users.docs) {
  const phone = normalizePhone(u.data().phone);
  // First writer wins: two accounts on one number is a data problem to look at, not one to guess
  // the answer to, so it is reported rather than silently resolved.
  if (phone && !uidByPhone.has(phone)) uidByPhone.set(phone, { uid: u.id, name: u.data().name });
}

const orders = await db.collection("orders").get();
const toLink = [];
let already = 0;
let noPhone = 0;
let noAccount = 0;
/** A sample of the phones that could not be read, so an empty column is visible as such. */
const rejected = [];

for (const o of orders.docs) {
  const d = o.data();
  if (d.customerId) { already += 1; continue; }
  const phone = normalizePhone(d.customerPhone);
  if (!phone) {
    noPhone += 1;
    // Worth seeing, not just counting: a column of empty strings means the journal is not being
    // given phone numbers at all, which is a different problem from a number typed wrongly.
    if (rejected.length < 8) rejected.push(`${d.orderNumber}: "${d.customerPhone ?? ""}"`);
    continue;
  }
  const match = uidByPhone.get(phone);
  if (!match) { noAccount += 1; continue; }
  toLink.push({ id: o.id, orderNumber: d.orderNumber, name: d.customerName, account: match });
}

console.log(`Аккаунт: ${users.size} клиент · Заказ: ${orders.size}\n`);
for (const l of toLink) {
  console.log(`  ${String(l.orderNumber).padEnd(20)} "${l.name}" → ${l.account.name} (${l.account.uid})`);
}
console.log(
  `\nБайланысатын: ${toLink.length} · Бұрыннан байлы: ${already} · ` +
  `Телефонсыз: ${noPhone} · Аккаунты жоқ: ${noAccount}`,
);

if (rejected.length > 0) {
  console.log("\nТелефоны оқылмаған заказдар (үлгі):");
  for (const r of rejected) console.log(`  ${r}`);
}

if (!write) {
  console.log("\nБұл — тек тексеру. Жазу үшін --write қосыңыз.");
} else if (toLink.length === 0) {
  console.log("\nБайланыстыратын заказ жоқ.");
} else {
  for (let i = 0; i < toLink.length; i += 400) {
    const batch = db.batch();
    for (const l of toLink.slice(i, i + 400)) {
      batch.update(db.collection("orders").doc(l.id), { customerId: l.account.uid });
    }
    await batch.commit();
  }
  console.log(`\n✅ ${toLink.length} заказ өз аккаунтына байланды.`);
}

// Not process.exit(): on Windows that truncates a piped stdout, and the report is the point.
await db.terminate();
