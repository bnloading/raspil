// Puts №496 (Ержан Берекет) back on the sum of its lines, as the owner asked on 2026-10-20
// («№496 заказдың суммасын жөнде»).
//
// The Жалпы сома cell could not be typed into on this row: totalOverrideFor left прифуговка out of
// the base, so every keystroke showed the typed figure plus 20 160 ₸ (898 + 110 м × 20 ₸) and the
// next digit landed on the end of that — 2 240 116 160 at 16:35, then a 1 214 880 ₸ discount and a
// 20 160 ₸ total at 16:50. (Fixed in lib/journalOrders.ts the same day.) The lines themselves are
// right: 1 235 040 ₸ with their edging and прифуговка. This clears the surcharge and the discount
// and sets total and debt to the lines, checked against them before it writes; the owner can then
// give a percentage in the journal panel's new «Жеңілдік %».
//
//   node --env-file=.env.local scripts/fix-496-total-2026-10-20.mjs          # dry run, writes nothing
//   node --env-file=.env.local scripts/fix-496-total-2026-10-20.mjs --apply
//
// Re-running after an apply is a no-op.
import { readFileSync } from "node:fs";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const APPLY = process.argv.includes("--apply");
const ACTOR_UID = "sPHBndKUNwZMgu6VUkjMyBTbqaC2"; // Нур — the owner, who asked
const ORDER = "ORD-2026-000496";
const EXPECT_LINES_TIYN = 1_235_040_00;
const JOINTING_TIYN = 2000; // lib/journal.ts PVC_JOINTING_SURCHARGE_TIYN

const sa = JSON.parse(readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, "utf8"));
if (getApps().length === 0) initializeApp({ credential: cert(sa) });
const db = getFirestore();
const actorSnap = await db.collection("users").doc(ACTOR_UID).get();
if (!actorSnap.exists) throw new Error(`Actor ${ACTOR_UID} табылмады`);
const actor = { uid: ACTOR_UID, name: actorSnap.data().name };
const fmt = (t) => `${(t / 100).toLocaleString("ru-RU")} ₸`;
console.log(APPLY ? "== APPLY ==" : "== DRY RUN (nothing is written) ==");

const snap = await db.collection("orders").where("orderNumber", "==", ORDER).get();
if (snap.size !== 1) throw new Error(`${ORDER}: ${snap.size} табылды`);
const ref = snap.docs[0].ref;
const o = snap.docs[0].data();
// Each line as lib/journal.ts computeLineTotals prices it.
const lines = (o.items ?? []).reduce((s, l) => s + Math.round(l.sheetQty * l.sheetPriceTiyn)
  + Math.round(l.pvcMeters * ((l.pvcPricePerMeterTiyn ?? 0) + (l.pvcJointed ? JOINTING_TIYN : 0))), 0);
const total = lines + (o.hdfCostTiyn ?? 0) + (o.cuttingCostTiyn ?? 0) + (o.deliveryCostTiyn ?? 0);
console.log(`${ORDER} ${o.customerName}: total ${fmt(o.totalTiyn)}, қосымша ${fmt(o.extraServicesTiyn ?? 0)}, жеңілдік ${fmt(o.discountTiyn ?? 0)}, paid ${fmt(o.paidTiyn ?? 0)}`);
console.log(`lines come to ${fmt(lines)} → total ${fmt(total)}`);
if (lines !== EXPECT_LINES_TIYN) throw new Error(`lines changed since: ${fmt(lines)}, not ${fmt(EXPECT_LINES_TIYN)} — look again`);
if ((o.extraServicesTiyn ?? 0) === 0 && (o.discountTiyn ?? 0) === 0 && o.totalTiyn === total) {
  console.log("already fixed — nothing to do.");
  process.exit(0);
}
const paid = o.paidTiyn ?? 0;
const update = {
  extraServicesTiyn: 0,
  discountTiyn: 0,
  totalTiyn: total,
  debtTiyn: total - paid,
  paymentStatus: paid <= 0 ? "unpaid" : paid >= total ? (paid > total ? "overpaid" : "paid") : "partial",
  updatedAt: FieldValue.serverTimestamp(),
};
console.log("→", JSON.stringify({ ...update, updatedAt: "now" }));
if (!APPLY) {
  console.log("Dry run only — add --apply to write.");
  process.exit(0);
}
const batch = db.batch();
batch.update(ref, update);
batch.set(db.collection("auditLogs").doc(), {
  userId: actor.uid, userName: actor.name, action: "order.journal_edit", entityType: "order", entityId: ref.id,
  before: { totalTiyn: o.totalTiyn, extraServicesTiyn: o.extraServicesTiyn ?? 0, discountTiyn: o.discountTiyn ?? 0 },
  after: { totalTiyn: total, extraServicesTiyn: 0, discountTiyn: 0 },
  comment: `${ORDER}: Жалпы сомаға қате терілген ${fmt(o.totalTiyn)} — жолдардың сомасына қайтарылды (иесі, 20.10)`,
  createdAt: FieldValue.serverTimestamp(),
});
await batch.commit();
console.log("✅ Түзетілді.");
