// Gives boards their ПВХ colour back where the catalogue name of the roll did not match the board.
//
// The journal fills a line's ПВХ colour by matching the roll's name against the board's, whole
// words only (lib/journalPricing.ts matchPvcTypeFor). Two rolls were catalogued under names the
// boards do not contain, so their lines were saved with metres but no colour:
//
//   "Бнуратти" for "ЛДСП Дуб Бунратти"    — a typo
//   "Честер"   for "ЛДСП Дуб Честерфилд"  — a shortening
//
// Their ПВХ still counted in Таза пайда, but as "Түсі жазылмаған" rather than under the colour, and
// the roll was not drawn down when the edging was finished. For each:
//
//   1. pvcTypes/<id>.colorName is corrected, so new journal rows match on their own.
//   2. On the listed orders (all from 22.09 on, the owner's approved list), each matching line with
//      metres and no colour gets pvcTypeId/pvcColorName, and pvcByType gains the entry, costed at
//      the line's own rate exactly as lib/journalOrders.ts pvcByTypeFromDraft does. No total, price
//      or payment changes: the metres were already billed on the line.
//
//   node --env-file=.env.local scripts/pvc-colour-fix-2026-09-26.mjs          # dry run, writes nothing
//   node --env-file=.env.local scripts/pvc-colour-fix-2026-09-26.mjs --apply
//
// Re-running after an apply is a no-op: a corrected name and lines that already carry a colour are
// left alone. (Бунратти was applied first, on its own; Честерфилд was added after.)
import { readFileSync } from "node:fs";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const APPLY = process.argv.includes("--apply");
const ACTOR_UID = "sPHBndKUNwZMgu6VUkjMyBTbqaC2";
const FIXES = [
  {
    pvcId: "pvc-1-bnuratti",
    name: "Бунратти",
    board: /бунратти/i,
    orders: ["ORD-2026-000188", "ORD-2026-000218"],
  },
  {
    pvcId: "pvc-1-chester",
    name: "Честерфилд",
    board: /честерфилд/i,
    orders: ["ORD-2026-000211", "ORD-2026-000216", "ORD-2026-000217", "ORD-2026-000229", "ORD-2026-000232"],
  },
];

const sa = JSON.parse(readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, "utf8"));
if (getApps().length === 0) initializeApp({ credential: cert(sa) });
const db = getFirestore();

const actorSnap = await db.collection("users").doc(ACTOR_UID).get();
if (!actorSnap.exists) throw new Error(`Actor ${ACTOR_UID} табылмады`);
const actor = { userId: ACTOR_UID, userName: actorSnap.data().name };
console.log(APPLY ? "== APPLY ==" : "== DRY RUN (nothing is written) ==");

for (const fix of FIXES) {
  const comment = `ПВХ "${fix.name}": журнал түсін таба алмаған (2026-09-26)`;

  // 1. The roll's name.
  const typeRef = db.collection("pvcTypes").doc(fix.pvcId);
  const type = (await typeRef.get()).data();
  if (!type) throw new Error(`${fix.pvcId} табылмады`);
  if (type.colorName === fix.name) {
    console.log(`pvcTypes/${fix.pvcId}: already "${fix.name}"`);
  } else {
    console.log(`pvcTypes/${fix.pvcId}: "${type.colorName}" → "${fix.name}"`);
    if (APPLY) {
      await typeRef.update({ colorName: fix.name });
      await db.collection("auditLogs").add({
        userId: actor.userId, userName: actor.userName, action: "pvcType.update", entityType: "pvcType",
        entityId: fix.pvcId, before: { colorName: type.colorName }, after: { colorName: fix.name },
        comment, createdAt: FieldValue.serverTimestamp(),
      });
    }
  }

  // 2. The orders' lines.
  for (const orderNumber of fix.orders) {
    const found = await db.collection("orders").where("orderNumber", "==", orderNumber).get();
    if (found.size !== 1) throw new Error(`${orderNumber}: ${found.size} заказ табылды, 1 болуы керек`);
    const ref = found.docs[0].ref;

    await db.runTransaction(async (tx) => {
      const order = (await tx.get(ref)).data();
      const items = (order.items ?? []).map((l) => ({ ...l }));
      let meters = 0;
      let costTiyn = 0;
      for (const line of items) {
        if (!fix.board.test(line.materialName ?? "") || !(line.pvcMeters > 0) || line.pvcTypeId) continue;
        line.pvcTypeId = fix.pvcId;
        line.pvcColorName = fix.name;
        meters += line.pvcMeters;
        costTiyn += Math.round(line.pvcMeters * (line.pvcPricePerMeterTiyn ?? 0));
      }
      if (meters === 0) {
        console.log(`${orderNumber}: nothing to fix`);
        return;
      }
      const pvcByType = (order.pvcByType ?? []).map((u) => ({ ...u }));
      const existing = pvcByType.find((u) => u.pvcTypeId === fix.pvcId);
      if (existing) {
        existing.meters += meters;
        existing.costTiyn += costTiyn;
        existing.colorName = fix.name;
      } else {
        pvcByType.push({ pvcTypeId: fix.pvcId, colorName: fix.name, thicknessMm: type.thicknessMm ?? 1, meters, costTiyn });
      }
      const billedByType = pvcByType.reduce((s, u) => s + (u.costTiyn ?? 0), 0);
      console.log(`${orderNumber} (${order.productionStatus}): +${meters} м ${fix.name}, ${costTiyn / 100} ₸; `
        + `colours now cover ${billedByType / 100} of ${(order.pvcCostTiyn ?? 0) / 100} ₸ billed ПВХ`);
      if (!APPLY) return;
      tx.update(ref, { items, pvcByType });
      tx.create(db.collection("auditLogs").doc(), {
        userId: actor.userId, userName: actor.userName, action: "order.pvcColour.fix", entityType: "order",
        entityId: ref.id, before: { pvcByType: order.pvcByType ?? [] }, after: { pvcByType },
        comment: `${orderNumber}: ${comment}`, createdAt: FieldValue.serverTimestamp(),
      });
    });
  }
}
console.log(APPLY ? "Done." : "Dry run only — add --apply to write.");
