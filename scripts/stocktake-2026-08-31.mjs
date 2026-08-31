// Physical stocktake of 2026-08-31 — sets every sheet's warehouse balance to the counted number.
//
// This is not a receipt: the counted figure REPLACES the running balance, so most rows go down
// (ЛДСП Ақ 147 → 33, Дуб Бунратти 100 → 35). Every difference is written as a `manual_correction`
// ledger entry inside the same transaction as the balance update — the shape src/lib/warehouse.ts
// uses — so the movement history and the balance can never drift apart.
//
// Four rows from the count sheet had no material in the catalogue and are created here with the
// counted number as their initial balance:
//   Столешница Симал Бежевый · Столешница Белый мрамор · ЛДСП Дуб Каньон · ЛДСП Ақ Ультра Декор
// and the single white ЛДСП row becomes "ЛДСП Ақ Томск", because the count separates it from the
// Ультра Декор white that is now a row of its own (its 6 reserved sheets stay with it).
//
// Price/thickness/format of the new rows copy the closest existing row of the same kind — a count
// sheet only carries quantities. Correct them on the Қойма page if they differ.
//
//   node --env-file=.env.local scripts/stocktake-2026-08-31.mjs          # dry run, writes nothing
//   node --env-file=.env.local scripts/stocktake-2026-08-31.mjs --apply
//
// Re-running after an apply is a no-op: the targets are absolute, so a second run sees no
// differences — unless real cutting happened in between, which it would silently undo, and that is
// exactly why every delta is printed before anything is touched.

import { readFileSync } from "node:fs";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const APPLY = process.argv.includes("--apply");
const COUNT_DATE = "2026-08-31";
const COMMENT = `Түгендеу ${COUNT_DATE}`;

// The ledger needs a real user, not a synthetic one, so the Қойма history shows who signed off on
// the correction — the admin who did the count.
const ACTOR_UID = "sPHBndKUNwZMgu6VUkjMyBTbqaC2";

const T = (tenge) => tenge * 100;

/** A countertop row: a 3000×600 blank, counted as one "лист" like every other sheet. */
const countertop = (color, article) => ({
  name: `Столешница ${color}`,
  category: "countertop",
  article,
  color,
  manufacturer: "",
  thicknessMm: 38,
  sheetLengthMm: 3000,
  sheetWidthMm: 600,
  sellingPriceTiyn: T(24000),
  minStock: 2,
  grainDirectionRequired: false,
});

/** A 16 mm ЛДСП sheet in the 2800×2070 format the rest of the catalogue uses. */
const ldsp = (name, color, article, priceTenge = 16500) => ({
  name,
  category: "ldsp",
  article,
  color,
  manufacturer: "",
  thicknessMm: 16,
  sheetLengthMm: 2800,
  sheetWidthMm: 2070,
  sellingPriceTiyn: T(priceTenge),
  minStock: 5,
  grainDirectionRequired: false,
});

// id → counted sheets. `create` builds the row when it is missing; `rename` corrects an existing
// row's name without touching anything else about it.
const COUNT = [
  // Столешница
  { id: "top-simal-bezhevyi", qty: 12, create: countertop("Симал Бежевый", "ST-007") },
  { id: "top-votan", qty: 15 },
  { id: "top-belyi-mramor", qty: 5, create: countertop("Белый мрамор", "ST-008") },
  { id: "top-bunratti", qty: 15 },
  { id: "top-ak", qty: 9 },

  // ЛДСП
  { id: "ldsp-sonoma", qty: 20 },
  { id: "ldsp-chesterfield", qty: 29 },
  { id: "ldsp-svetlo-seryi", qty: 47 },
  { id: "ldsp-dub-kanon", qty: 33, create: ldsp("ЛДСП Дуб Каньон", "Дуб Каньон", "DK-019") },
  { id: "ldsp-bunratti", qty: 35 },
  { id: "ldsp-kashemir", qty: 5 },
  { id: "ldsp-dub-votan", qty: 14 },
  { id: "ldsp-ak", qty: 33, rename: "ЛДСП Ақ Томск" },
  { id: "ldsp-ak-ultradekor", qty: 30, create: ldsp("ЛДСП Ақ Ультра Декор", "Ақ", "AU-020") },

  // ХДФ
  { id: "hdf-white", qty: 14 },
];

const sa = JSON.parse(readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, "utf8"));
if (getApps().length === 0) initializeApp({ credential: cert(sa) });
const db = getFirestore();

const actorSnap = await db.collection("users").doc(ACTOR_UID).get();
if (!actorSnap.exists) throw new Error(`Actor ${ACTOR_UID} табылмады`);
const actor = { userId: ACTOR_UID, userName: actorSnap.data().name };

console.log(`${APPLY ? "APPLY" : "DRY RUN"} — түгендеу ${COUNT_DATE}, есептеген: ${actor.userName}\n`);

let created = 0;
let corrected = 0;
let unchanged = 0;
const warnings = [];

for (const row of COUNT) {
  const ref = db.collection("materials").doc(row.id);
  const snap = await ref.get();

  if (!snap.exists) {
    if (!row.create) {
      warnings.push(`${row.id}: қоймада жоқ, құру шаблоны да жоқ — өткізілмеді`);
      continue;
    }
    console.log(`  + ${row.create.name} — жаңа материал, ${row.qty} лист`);
    created++;
    if (!APPLY) continue;

    const movementRef = db.collection("inventoryMovements").doc();
    await db.runTransaction(async (tx) => {
      tx.set(ref, {
        ...row.create,
        initialQty: row.qty,
        qtyOnHand: row.qty,
        reservedQty: 0,
        active: true,
        archived: false,
        note: "",
        createdAt: FieldValue.serverTimestamp(),
      });
      tx.set(movementRef, {
        materialId: row.id,
        type: "initial",
        qty: row.qty,
        orderId: null,
        userId: actor.userId,
        userName: actor.userName,
        comment: `Бастапқы қалдық (${COMMENT})`,
        balanceBefore: 0,
        balanceAfter: row.qty,
        createdAt: FieldValue.serverTimestamp(),
      });
    });
    // Purchase price is Admin-only and lives in its own collection; a count sheet doesn't carry it.
    await db.collection("materialCosts").doc(row.id).set({ purchasePriceTiyn: 0 }, { merge: true });
    await db.collection("auditLogs").add({
      userId: actor.userId,
      userName: actor.userName,
      action: "material.create",
      entityType: "material",
      entityId: row.id,
      before: null,
      after: { ...row.create, qtyOnHand: row.qty },
      comment: COMMENT,
      createdAt: FieldValue.serverTimestamp(),
    });
    continue;
  }

  const cur = snap.data();
  const name = row.rename ?? cur.name;
  const delta = row.qty - cur.qtyOnHand;
  const renaming = !!row.rename && cur.name !== row.rename;

  if (row.qty < (cur.reservedQty ?? 0)) {
    warnings.push(`${name}: есептелген ${row.qty} < брондалған ${cur.reservedQty} — бронь артық қалады`);
  }
  if (renaming) console.log(`  ~ "${cur.name}" → "${row.rename}"`);
  if (delta === 0) {
    if (!renaming) {
      console.log(`  = ${name} — ${row.qty} лист, өзгеріссіз`);
      unchanged++;
    }
  } else {
    console.log(`  ${delta > 0 ? "↑" : "↓"} ${name}: ${cur.qtyOnHand} → ${row.qty} (${delta > 0 ? "+" : ""}${delta})`);
    corrected++;
  }
  if (!APPLY) continue;

  if (delta !== 0) {
    const movementRef = db.collection("inventoryMovements").doc();
    await db.runTransaction(async (tx) => {
      const fresh = await tx.get(ref);
      const balanceBefore = fresh.data().qtyOnHand;
      // The target is absolute, so the ledger delta is re-derived inside the transaction: if the
      // balance moved between the read above and this write, the count still wins and the ledger
      // entry still describes the jump that actually happened.
      const qty = row.qty - balanceBefore;
      tx.update(ref, { qtyOnHand: row.qty, ...(renaming ? { name: row.rename } : {}) });
      if (qty !== 0) {
        tx.set(movementRef, {
          materialId: row.id,
          type: "manual_correction",
          qty,
          orderId: null,
          userId: actor.userId,
          userName: actor.userName,
          comment: COMMENT,
          balanceBefore,
          balanceAfter: row.qty,
          createdAt: FieldValue.serverTimestamp(),
        });
      }
    });
    await db.collection("auditLogs").add({
      userId: actor.userId,
      userName: actor.userName,
      action: "warehouse.correction",
      entityType: "material",
      entityId: row.id,
      before: { qtyOnHand: cur.qtyOnHand },
      after: { qtyOnHand: row.qty, delta, reason: COMMENT },
      comment: COMMENT,
      createdAt: FieldValue.serverTimestamp(),
    });
  } else if (renaming) {
    await ref.update({ name: row.rename });
  }

  if (renaming) {
    await db.collection("auditLogs").add({
      userId: actor.userId,
      userName: actor.userName,
      action: "material.update",
      entityType: "material",
      entityId: row.id,
      before: { name: cur.name },
      after: { name: row.rename },
      comment: COMMENT,
      createdAt: FieldValue.serverTimestamp(),
    });
  }
}

// Anything in the catalogue the count sheet did not mention: printed, never zeroed silently.
const all = await db.collection("materials").get();
const counted = new Set(COUNT.map((r) => r.id));
const missed = all.docs.filter((d) => !counted.has(d.id));
if (missed.length > 0) {
  console.log("\nТізімде жоқ материалдар (қолмен тексеріңіз):");
  for (const d of missed) console.log(`  ? ${d.data().name} — қоймада ${d.data().qtyOnHand} лист`);
}

if (warnings.length > 0) {
  console.log("\n⚠ Ескерту:");
  for (const w of warnings) console.log(`  ${w}`);
}

console.log(`\nжаңа: ${created}, түзетілді: ${corrected}, өзгеріссіз: ${unchanged}`);
if (!APPLY) console.log("Ештеңе жазылған жоқ. Жазу үшін: --apply");
process.exit(0);
