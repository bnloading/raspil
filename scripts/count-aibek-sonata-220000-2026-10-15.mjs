// Counts in Касса the 220 000 ₸ Айбек Соната paid into Нұр on 13.10 against his old order №66, as
// the owner asked on 2026-10-15 («Айбек Соната 220 000 олар қосылған болу керек»).
//
// №66 (10.09) is from before the books were closed at №281 (30.09), so Касса left its payment out
// as the old books'. The money came in on 13.10 — two days before payments like it started counting
// by themselves (lib/payments.ts recordPayment) — so it gets countsInCurrentBooks, exactly as Касса's
// own «Кассаға қосу» does for an Admin (ManagerCashbox.tsx handleCountPayment).
//
//   node --env-file=.env.local scripts/count-aibek-sonata-220000-2026-10-15.mjs          # dry run, writes nothing
//   node --env-file=.env.local scripts/count-aibek-sonata-220000-2026-10-15.mjs --apply
//
// Checked against order, amount and method before anything is touched; re-running is a no-op.
import { readFileSync } from "node:fs";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const APPLY = process.argv.includes("--apply");
const ACTOR_UID = "sPHBndKUNwZMgu6VUkjMyBTbqaC2"; // Нур — the owner, who asked
const PAYMENT_ID = "E8A73YLcJQH8caCntOLn";
const EXPECT = { orderNumber: "ORD-2026-000066", amountTiyn: 220_000_00, methodId: "nur" };

const sa = JSON.parse(readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, "utf8"));
if (getApps().length === 0) initializeApp({ credential: cert(sa) });
const db = getFirestore();
const actorSnap = await db.collection("users").doc(ACTOR_UID).get();
if (!actorSnap.exists) throw new Error(`Actor ${ACTOR_UID} табылмады`);
const actor = { uid: ACTOR_UID, name: actorSnap.data().name };
const fmt = (t) => `${(t / 100).toLocaleString("ru-RU")} ₸`;
console.log(APPLY ? "== APPLY ==" : "== DRY RUN (nothing is written) ==");

const ref = db.collection("payments").doc(PAYMENT_ID);
const p = (await ref.get()).data();
if (!p) throw new Error(`${PAYMENT_ID} табылмады`);
const order = (await db.collection("orders").doc(p.orderId).get()).data();
if (order?.orderNumber !== EXPECT.orderNumber || p.amountTiyn !== EXPECT.amountTiyn || p.methodId !== EXPECT.methodId || p.reversed) {
  throw new Error(`күтілгені ${EXPECT.orderNumber} ${fmt(EXPECT.amountTiyn)} Нұр, табылғаны ${order?.orderNumber} ${fmt(p.amountTiyn)} ${p.methodName}${p.reversed ? " (қайтарылған)" : ""}`);
}
console.log(`${order.orderNumber} ${order.customerName} | ${fmt(p.amountTiyn)} ${p.methodName} | countsInCurrentBooks=${p.countsInCurrentBooks ?? false}`);
if (p.countsInCurrentBooks) {
  console.log("already counted — nothing to do.");
  process.exit(0);
}
if (!APPLY) {
  console.log("Dry run only — add --apply to write.");
  process.exit(0);
}
const batch = db.batch();
batch.update(ref, { countsInCurrentBooks: true });
batch.set(db.collection("auditLogs").doc(), {
  userId: actor.uid, userName: actor.name, action: "payment.countsInCurrentBooks", entityType: "payment",
  entityId: PAYMENT_ID, before: { countsInCurrentBooks: false }, after: { countsInCurrentBooks: true },
  comment: `${order.orderNumber} ${fmt(p.amountTiyn)} ${p.methodName} — 13.10 түскен, Кассаға қосылды (иесі, 15.10)`,
  createdAt: FieldValue.serverTimestamp(),
});
await batch.commit();
console.log("✅ Кассаға қосылды.");
