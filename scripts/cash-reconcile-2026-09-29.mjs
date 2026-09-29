// Brings the ЛДСП Нұр (deposit) pot in line with the bank, as the owner asked on 2026-09-29.
//
//   1. ORD-2026-000083's 22 000 ₸ back to Нұр — it was taken as Нұр and later relabelled Pay.
//   2. Two payments on pre-restart orders counted as today's money after all (the owner's call,
//      Payment.countsInCurrentBooks): ORD-2026-000083 (22 000, Нұр) and ORD-2026-000145
//      (80 000, Қолма-қол). Every other such payment stays out of Касса.
//   3. One dated correction, "Банкпен теңестіру", for whatever still separates the computed Нұр
//      balance from the 4 430 482 ₸ the owner has in the account — worked out from live data at the
//      moment this runs, the same way lib/cashbox.ts computeCashbox counts (opening + counted
//      payments − expenses + earlier corrections), and stored in applicationSettings.cashAdjustments.
//
//   node --env-file=.env.local scripts/cash-reconcile-2026-09-29.mjs          # dry run, writes nothing
//   node --env-file=.env.local scripts/cash-reconcile-2026-09-29.mjs --apply
//
// Re-running after an apply is a no-op: the relabel and flags are already there, and the balance
// then already matches, so no second correction is written.
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const APPLY = process.argv.includes("--apply");
const ACTOR_UID = "sPHBndKUNwZMgu6VUkjMyBTbqaC2";
const DEPT = "ldsp";
const TARGET_TIYN = 4_430_482_00;
// Named by payment id, and checked against order and amount before anything is touched:
// ORD-2026-000145 also carries a 210 000 ₸ payment from 18.09, which is not one of these.
const TARGETS = [
  { paymentId: "o8rtDz9faD54GGXmN0NH", orderNumber: "ORD-2026-000083", amountTiyn: 22_000_00, relabel: { methodId: "nur", methodName: "Нұр" } },
  { paymentId: "Fu2eAW4BQvPL3wpyP0ar", orderNumber: "ORD-2026-000145", amountTiyn: 80_000_00 },
];
const TODAY = "2026-09-29";

const sa = JSON.parse(readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, "utf8"));
if (getApps().length === 0) initializeApp({ credential: cert(sa) });
const db = getFirestore();
const actorSnap = await db.collection("users").doc(ACTOR_UID).get();
if (!actorSnap.exists) throw new Error(`Actor ${ACTOR_UID} табылмады`);
const actor = { userId: ACTOR_UID, userName: actorSnap.data().name };
const audit = (entry) => db.collection("auditLogs").add({
  userId: actor.userId, userName: actor.userName, before: null, after: null, comment: null,
  ...entry, createdAt: FieldValue.serverTimestamp(),
});
const day = (ts) => (ts ? new Date(ts.toMillis() + 5 * 3600e3).toISOString().slice(0, 10) : null);
const fmt = (t) => `${(t / 100).toLocaleString("ru-RU")} ₸`;
console.log(APPLY ? "== APPLY ==" : "== DRY RUN (nothing is written) ==");

const orders = new Map((await db.collection("orders").get()).docs.map((d) => [d.id, d.data()]));

// 1 + 2. The two payments.
const planned = new Map(); // payment id → the fields set here, so a dry run's balance counts them too
for (const t of TARGETS) {
  const ref = db.collection("payments").doc(t.paymentId);
  const p = (await ref.get()).data();
  if (!p) throw new Error(`${t.paymentId} табылмады`);
  if (orders.get(p.orderId)?.orderNumber !== t.orderNumber || p.amountTiyn !== t.amountTiyn || p.reversed) {
    throw new Error(`${t.paymentId}: күтілгені ${t.orderNumber} ${fmt(t.amountTiyn)}, табылғаны ${orders.get(p.orderId)?.orderNumber} ${fmt(p.amountTiyn)}${p.reversed ? " (қайтарылған)" : ""}`);
  }
  const update = {};
  if (t.relabel && p.methodId !== t.relabel.methodId) Object.assign(update, t.relabel);
  if (!p.countsInCurrentBooks) update.countsInCurrentBooks = true;
  if (Object.keys(update).length === 0) {
    console.log(`${t.orderNumber}: already done`);
    continue;
  }
  planned.set(t.paymentId, update);
  console.log(`${t.orderNumber} ${fmt(p.amountTiyn)} ${p.methodName} (${day(p.paymentDate)}):`, JSON.stringify(update));
  if (APPLY) {
    await ref.update(update);
    await audit({
      action: "payment.update", entityType: "payment", entityId: t.paymentId,
      before: { methodId: p.methodId, methodName: p.methodName, countsInCurrentBooks: p.countsInCurrentBooks ?? false },
      after: update, comment: `${t.orderNumber}: иесі — қазіргі ақшаға кіреді${update.methodId ? ", төлем түрі Нұр" : ""} (2026-09-29)`,
    });
  }
}

// 3. The Нұр balance as Касса counts it (with the changes above in force), and the correction.
const settingsRef = db.collection("applicationSettings").doc("global");
const settings = (await settingsRef.get()).data();
const start = settings.cashStartDate;
const opening = settings.cashOpeningBalanceTiyn?.[DEPT]?.deposit ?? 0;
const methods = new Map((await db.collection("paymentMethods").get()).docs.map((d) => [d.id, d.data()]));
const account = (id) => methods.get(id)?.account ?? (id === "cash" ? "cash" : "deposit");
// On --apply the writes above have landed; on a dry run, overlay them so the figure is the same.
const payments = (await db.collection("payments").get()).docs
  .map((d) => ({ id: d.id, ...d.data(), ...(APPLY ? {} : planned.get(d.id) ?? {}) }));
let inTiyn = 0;
for (const p of payments) {
  if (p.reversed || !p.paymentDate || day(p.paymentDate) < start) continue;
  const o = orders.get(p.orderId);
  if ((o?.orderKind === "mdf_wrap" ? "mdf" : "ldsp") !== DEPT) continue;
  if (o?.createdAt && day(o.createdAt) < start && !p.countsInCurrentBooks) continue;
  if (account(p.methodId) === "deposit") inTiyn += p.amountTiyn;
}
const outTiyn = (await db.collection("expenses").get()).docs.map((d) => d.data())
  .filter((e) => (e.department ?? "ldsp") === DEPT && e.date >= start && (e.account ?? "cash") === "deposit")
  .reduce((s, e) => s + e.amountTiyn, 0);
const earlier = (settings.cashAdjustments?.[DEPT] ?? [])
  .filter((a) => a.account === "deposit" && a.date >= start)
  .reduce((s, a) => s + a.amountTiyn, 0);
const computed = opening + inTiyn - outTiyn + earlier;
const diff = TARGET_TIYN - computed;
console.log(`Нұр: бастапқы ${fmt(opening)} + түсті ${fmt(inTiyn)} − шықты ${fmt(outTiyn)} ± бұрынғы түзету ${fmt(earlier)} = ${fmt(computed)}`);
console.log(`банкте ${fmt(TARGET_TIYN)} → түзету ${diff >= 0 ? "+" : "−"}${fmt(Math.abs(diff))}`);
if (diff === 0) {
  console.log("Нұр already matches — no correction needed.");
} else if (APPLY) {
  const adjustment = {
    id: randomUUID(), account: "deposit", amountTiyn: diff, date: TODAY,
    note: `Банкпен теңестіру (шотта ${fmt(TARGET_TIYN)})`, byUid: actor.userId, byName: actor.userName,
  };
  await settingsRef.update({ [`cashAdjustments.${DEPT}`]: FieldValue.arrayUnion(adjustment) });
  await audit({
    action: "cash.adjustment.add", entityType: "applicationSettings", entityId: "global",
    before: { balanceTiyn: computed }, after: { ...adjustment, balanceTiyn: TARGET_TIYN }, comment: adjustment.note,
  });
  console.log("correction written:", JSON.stringify(adjustment));
}
console.log(APPLY ? "Done." : "Dry run only — add --apply to write.");
