// Physical stocktake of 2026-09-25 — sets every counted sheet's warehouse balance to the number
// the owner counted.
//
// The counted figure REPLACES the running balance, and every difference is written as a
// `manual_correction` movement inside the same transaction as the balance update — the shape
// src/lib/warehouse.ts uses — so the ledger and the balance can never drift apart.
//
// Two rows were carrying impossible balances before this count and are put right by it:
// ЛДСП Кашемир (−10) and ХДФ (−81). Rows the count does not mention are left exactly as they are.
//
//   node --env-file=.env.local scripts/stocktake-2026-09-25.mjs          # dry run, writes nothing
//   node --env-file=.env.local scripts/stocktake-2026-09-25.mjs --apply
//
// Re-running after an apply is a no-op: the targets are absolute, so a second run sees no
// differences — unless real cutting happened in between, which it would silently undo, which is
// why every delta is printed before anything is touched.

import { readFileSync } from "node:fs";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const APPLY = process.argv.includes("--apply");
const COUNT_DATE = "2026-09-25";
const COMMENT = `Түгендеу ${COUNT_DATE}`;
const ACTOR_UID = "sPHBndKUNwZMgu6VUkjMyBTbqaC2";

/** id → counted sheets. Ids are the catalogue's own, so a rename can never redirect a count. */
const COUNT = [
  // ЛДСП
  { id: "ldsp-ak", qty: 143 },            // "ақ"
  { id: "ldsp-bunratti", qty: 19 },       // "Бнуратти"
  { id: "ldsp-kashemir", qty: 31 },       // "Кашемир"
  { id: "ldsp-svetlo-seryi", qty: 26 },   // "Светло Серый"
  { id: "ldsp-dub-votan", qty: 24 },      // "Вотан"
  { id: "ldsp-sonoma", qty: 30 },         // "Санома"
  { id: "ldsp-chesterfield", qty: 39 },   // "Честер"
  { id: "ldsp-dub-kanon", qty: 51 },      // "Каньон"
  // ХДФ
  { id: "hdf-white", qty: 202 },          // "ХДФ"
  // Столешница
  { id: "top-bezhevyi", qty: 5 },         // "Бери бежевый"  → the only бежевый row left
  { id: "top-belyi-mramor", qty: 5 },     // "Белый мрамор"
  { id: "top-votan", qty: 8 },            // "Дуб вотан"
  { id: "top-bunratti", qty: 9 },         // "Дуб бунратти"
  { id: "top-ak", qty: 12 },              // "Белый матовый"  → Столешница Ақ (ақ = белый)
];

const sa = JSON.parse(readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, "utf8"));
if (getApps().length === 0) initializeApp({ credential: cert(sa) });
const db = getFirestore();

const actorSnap = await db.collection("users").doc(ACTOR_UID).get();
if (!actorSnap.exists) throw new Error(`Actor ${ACTOR_UID} табылмады`);
const actor = { userId: ACTOR_UID, userName: actorSnap.data().name };

const rows = [];
for (const c of COUNT) {
  const snap = await db.collection("materials").doc(c.id).get();
  if (!snap.exists) { rows.push({ ...c, missing: true }); continue; }
  const m = snap.data();
  rows.push({ ...c, name: m.name, before: m.qtyOnHand ?? 0, reserved: m.reservedQty ?? 0 });
}

console.log(`Түгендеу ${COUNT_DATE} · ${rows.length} позиция\n`);
console.log("  материал                        болған  →  саналған    айырма");
let changes = 0;
for (const r of rows) {
  if (r.missing) { console.log(`  ⚠️  ${r.id} — каталогтан табылмады`); continue; }
  const delta = r.qty - r.before;
  if (delta !== 0) changes++;
  const mark = delta === 0 ? "=" : delta > 0 ? "↑" : "↓";
  console.log(`  ${mark} ${r.name.padEnd(28)} ${String(r.before).padStart(6)}  →  ${String(r.qty).padStart(7)}  ${delta === 0 ? "       —" : String(delta > 0 ? `+${delta}` : delta).padStart(8)}${r.reserved ? `   (резерв ${r.reserved})` : ""}`);
}
console.log(`\nӨзгеретіні: ${changes} позиция`);

if (!APPLY) {
  console.log("\nDRY RUN — ештеңе жазылған жоқ. Растасаңыз --apply қосып жіберіңіз.");
} else {
  for (const r of rows) {
    if (r.missing) continue;
    const delta = r.qty - r.before;
    if (delta === 0) continue;
    const materialRef = db.collection("materials").doc(r.id);
    const movementRef = db.collection("inventoryMovements").doc();
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(materialRef);
      const before = snap.data().qtyOnHand ?? 0;
      tx.update(materialRef, { qtyOnHand: r.qty });
      tx.set(movementRef, {
        materialId: r.id,
        type: "manual_correction",
        qty: r.qty - before,
        userId: actor.userId,
        userName: actor.userName,
        comment: COMMENT,
        balanceBefore: before,
        balanceAfter: r.qty,
        createdAt: FieldValue.serverTimestamp(),
      });
    });
  }
  console.log(`\n✅ ${changes} позицияның қалдығы жазылды, әрқайсысына "${COMMENT}" түзету жазбасы қосылды.`);
}
