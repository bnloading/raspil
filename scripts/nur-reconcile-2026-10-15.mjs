// Brings the ЛДСП Касса's Нұр pot in line with the account, as the owner asked on 2026-10-15
// («менде қазір кассада 8761757 тұр, соған келтіріп Нұр деген заказды ретте»).
//
// One dated correction, "Банкпен теңестіру", for whatever separates Нұр as Касса counts it from the
// 8 761 757 ₸ the owner has — worked out from live data the moment this runs, the way lib/cashbox.ts
// computeCashbox counts the pot: opening + payments it counts + rent − expenses ± corrections. The
// same entry the Admin's «Банкпен теңестіру» form writes (ManagerCashbox.tsx ReconcileEditor), so
// Касса lists it with its date and reason and it can be taken back there.
//
//   node --env-file=.env.local scripts/nur-reconcile-2026-10-15.mjs          # dry run, writes nothing
//   node --env-file=.env.local scripts/nur-reconcile-2026-10-15.mjs --apply
//
// Re-running after an apply is a no-op: its fixed id is then already in the list.
import { readFileSync } from "node:fs";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const APPLY = process.argv.includes("--apply");
const ACTOR_UID = "sPHBndKUNwZMgu6VUkjMyBTbqaC2"; // Нур — the owner, who asked
const DEPT = "ldsp";
const TARGET_TIYN = 8_761_757_00;
const DATE = "2026-10-15";
const ID = "nur-reconcile-2026-10-15";

const sa = JSON.parse(readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, "utf8"));
if (getApps().length === 0) initializeApp({ credential: cert(sa) });
const db = getFirestore();
const actorSnap = await db.collection("users").doc(ACTOR_UID).get();
if (!actorSnap.exists) throw new Error(`Actor ${ACTOR_UID} табылмады`);
const actor = { uid: ACTOR_UID, name: actorSnap.data().name };
const fmt = (t) => `${t < 0 ? "−" : ""}${(Math.abs(t) / 100).toLocaleString("ru-RU")} ₸`;
const day = (ts) => new Date(ts.toMillis() + 5 * 3600e3).toISOString().slice(0, 10);
console.log(APPLY ? "== APPLY ==" : "== DRY RUN (nothing is written) ==");

const settingsRef = db.collection("applicationSettings").doc("global");
const settings = (await settingsRef.get()).data();
if ((settings.cashAdjustments?.[DEPT] ?? []).some((a) => a.id === ID)) {
  console.log(`already written (${ID}) — nothing to do.`);
  process.exit(0);
}
const start = settings.cashStartDate;
const firstNo = settings.cashStartOrderNumber;
const opening = settings.cashOpeningBalanceTiyn?.[DEPT]?.deposit ?? 0;
const methods = new Map((await db.collection("paymentMethods").get()).docs.map((d) => [d.id, d.data()]));
const pot = (id) => methods.get(id)?.account ?? (id === "cash" ? "cash" : "deposit");
const orders = new Map((await db.collection("orders").get()).docs.map((d) => [d.id, d.data()]));

let inTiyn = 0;
for (const p of (await db.collection("payments").get()).docs.map((d) => d.data())) {
  if (p.reversed || !p.paymentDate || (start && day(p.paymentDate) < start)) continue;
  const o = orders.get(p.orderId);
  if ((o?.orderKind === "mdf_wrap" ? "mdf" : "ldsp") !== DEPT) continue;
  const old = o && (firstNo ? o.orderNumber < firstNo : start && o.createdAt && day(o.createdAt) < start);
  if (old && !p.countsInCurrentBooks) continue;
  if (pot(p.methodId) === "deposit") inTiyn += p.amountTiyn;
}
const outTiyn = (await db.collection("expenses").get()).docs.map((d) => d.data())
  .filter((e) => (e.department ?? "ldsp") === DEPT && (!start || e.date >= start) && (e.account ?? "cash") === "deposit")
  .reduce((s, e) => s + e.amountTiyn, 0);
const rentTiyn = (await db.collection("rentPayments").get()).docs.map((d) => d.data())
  .filter((r) => (r.department ?? "ldsp") === DEPT && (!start || r.date >= start) && pot(r.methodId) === "deposit")
  .reduce((s, r) => s + r.amountTiyn, 0);
const adjTiyn = (settings.cashAdjustments?.[DEPT] ?? [])
  .filter((a) => a.account === "deposit" && (!start || a.date >= start))
  .reduce((s, a) => s + a.amountTiyn, 0);
const computed = opening + inTiyn + rentTiyn - outTiyn + adjTiyn;
const diff = TARGET_TIYN - computed;
console.log(`Нұр: бастапқы ${fmt(opening)} + түсті ${fmt(inTiyn)} + аренда ${fmt(rentTiyn)} − шықты ${fmt(outTiyn)} ± түзету ${fmt(adjTiyn)} = ${fmt(computed)}`);
console.log(`шотта ${fmt(TARGET_TIYN)} → түзету ${diff >= 0 ? "+" : ""}${fmt(diff)}`);
if (diff === 0) {
  console.log("Нұр already matches — no correction needed.");
  process.exit(0);
}
const adjustment = {
  id: ID, account: "deposit", amountTiyn: diff, date: DATE,
  note: `Банкпен теңестіру (шотта ${fmt(TARGET_TIYN)})`, byUid: actor.uid, byName: actor.name,
};
if (!APPLY) {
  console.log("Dry run only — add --apply to write.");
  process.exit(0);
}
const batch = db.batch();
batch.update(settingsRef, { [`cashAdjustments.${DEPT}`]: FieldValue.arrayUnion(adjustment) });
batch.set(db.collection("auditLogs").doc(), {
  userId: actor.uid, userName: actor.name, action: "cash.adjustment.add", entityType: "applicationSettings",
  entityId: "global", before: { balanceTiyn: computed }, after: { ...adjustment, balanceTiyn: TARGET_TIYN },
  comment: adjustment.note, createdAt: FieldValue.serverTimestamp(),
});
await batch.commit();
console.log("✅ Жазылды:", JSON.stringify(adjustment));
