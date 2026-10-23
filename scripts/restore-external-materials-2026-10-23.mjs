// Puts back the five catalogue rows deleted from Қойма on 22.10 (17:39–17:41, Ербол), as the owner
// asked on 2026-10-23 («журналда бұрынғы Сырттан келетін лист, Эггер, 4м столешница, сырттан
// келетін ХДФ өшіп қалыпты — қайта қос, бірақ қоймада көрінбесін; Остаток дегенді де қос»).
//
// Each comes back under its OLD id, so the 150-odd orders that already name it (№523, №519, №518,
// №505, №524 …) find it again. Name, article, size and selling price are the material snapshot on
// the latest order that used it; the purchase price is the last one the audit log recorded (the
// delete took the materialCosts doc with it). None of them was ever counted on the rack — not one
// inventory movement in their history — so all five are stockTracked: false, which is also what
// now keeps them out of the Қойма stock table and the low-stock lists.
//
//   node --env-file=.env.local scripts/restore-external-materials-2026-10-23.mjs          # dry run, writes nothing
//   node --env-file=.env.local scripts/restore-external-materials-2026-10-23.mjs --apply
//
// Re-running after an apply is a no-op: a row that exists again is left alone.
import { readFileSync } from "node:fs";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const APPLY = process.argv.includes("--apply");
const ACTOR_UID = "sPHBndKUNwZMgu6VUkjMyBTbqaC2"; // Нур — the owner, who asked

const NOT_STOCK = {
  manufacturer: "",
  minStock: 0,
  initialQty: 0,
  qtyOnHand: 0,
  reservedQty: 0,
  stockTracked: false,
  active: true,
  archived: false,
  grainDirectionRequired: false,
  imageUrl: "",
};
const ROWS = [
  {
    id: "5ixr3H0H5TZeJ5eVdYGw",
    data: { name: "Сырттан келетін лист", article: "1", color: "", category: "ldsp", thicknessMm: 16, sheetLengthMm: 2750, sheetWidthMm: 1830, sellingPriceTiyn: 160000, note: "" },
    purchasePriceTiyn: 70000,
  },
  {
    id: "XmcsExoc64wM8WufwdMw",
    data: { name: "Сырттан келетін лист Эггер", article: "EXT-EGGER", color: "", category: "ldsp", thicknessMm: 16, sheetLengthMm: 2750, sheetWidthMm: 1830, sellingPriceTiyn: 210000, note: "" },
    purchasePriceTiyn: 70000,
  },
  {
    id: "external-hdf",
    data: { name: "Сырттан келетін ХДФ", article: "EX-002", color: "", category: "hdf", thicknessMm: 3, sheetLengthMm: 2800, sheetWidthMm: 2070, sellingPriceTiyn: 100000, note: "" },
    purchasePriceTiyn: 40000,
  },
  {
    id: "8azUDcodwLpR8h0i8mU6",
    data: {
      name: "Сырттан келетін столешница 4м", article: "EXT-TOP-4", color: "Сырттан", category: "countertop", thicknessMm: 38, sheetLengthMm: 4000, sheetWidthMm: 600, sellingPriceTiyn: 300000,
      note: "Клиенттің өз столешницасы — тек кесу қызметі. Бағасы ұзындығы бойынша журналда автоматты қойылады.",
    },
    purchasePriceTiyn: 500000,
  },
  {
    id: "ostatok",
    data: { name: "Остаток", article: "OST-001", color: "", category: "other", thicknessMm: 0, sheetLengthMm: 0, sheetWidthMm: 0, sellingPriceTiyn: 0, note: "" },
    purchasePriceTiyn: null, // never set
  },
];

const sa = JSON.parse(readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, "utf8"));
if (getApps().length === 0) initializeApp({ credential: cert(sa) });
const db = getFirestore();
const actorSnap = await db.collection("users").doc(ACTOR_UID).get();
if (!actorSnap.exists) throw new Error(`Actor ${ACTOR_UID} табылмады`);
const actor = { uid: ACTOR_UID, name: actorSnap.data().name };
const fmt = (t) => `${(t / 100).toLocaleString("ru-RU")} ₸`;
console.log(APPLY ? "== APPLY ==" : "== DRY RUN (nothing is written) ==");

const byName = new Map((await db.collection("materials").get()).docs.map((d) => [d.data().name.trim().toLowerCase(), d.id]));
const batch = db.batch();
let restoring = 0;
for (const row of ROWS) {
  const ref = db.collection("materials").doc(row.id);
  if ((await ref.get()).exists) {
    console.log(`  ${row.data.name.padEnd(32)} бар — қозғалмайды`);
    continue;
  }
  // A row typed again by hand since the delete would become a duplicate in every picker.
  const twin = byName.get(row.data.name.toLowerCase());
  if (twin) throw new Error(`«${row.data.name}» басқа id-мен қайта қосылған (${twin}) — қолмен қараңыз`);
  console.log(`  ${row.data.name.padEnd(32)} қайта қосылады · ${fmt(row.data.sellingPriceTiyn)}`
    + (row.purchasePriceTiyn !== null ? ` · сатып алу ${fmt(row.purchasePriceTiyn)}` : ""));
  restoring++;
  batch.set(ref, { ...NOT_STOCK, ...row.data, createdAt: FieldValue.serverTimestamp() });
  if (row.purchasePriceTiyn !== null) {
    batch.set(db.collection("materialCosts").doc(row.id), { purchasePriceTiyn: row.purchasePriceTiyn });
  }
  batch.set(db.collection("auditLogs").doc(), {
    userId: actor.uid, userName: actor.name, action: "material.restored", entityType: "material", entityId: row.id,
    after: { name: row.data.name, article: row.data.article, category: row.data.category, sellingPriceTiyn: row.data.sellingPriceTiyn, stockTracked: false },
    comment: `«${row.data.name}» қайта қосылды — 22.10 өшірілген еді; журналда бар, қоймада есептелмейді (иесі, 23.10)`,
    createdAt: FieldValue.serverTimestamp(),
  });
}
if (restoring === 0) {
  console.log("already restored — nothing to do.");
  process.exit(0);
}
if (!APPLY) {
  console.log("Dry run only — add --apply to write.");
  process.exit(0);
}
await batch.commit();
console.log(`✅ ${restoring} материал қайта қосылды.`);
