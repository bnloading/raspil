// Counts in Касса the money that came in after the 30.09 settlement on orders from before it, as
// the owner asked on 2026-10-05 («Расчеттан кейін №281-ден бұрынғы заказдарға түскен 937 860 ₸-ді
// Кассаға қосайын ба?» — «Иә, қос»).
//
// The books were closed at №281 on 30.09 (the restart was written at 11:24 and 11:30), and Касса
// leaves out every payment on an order numbered before it (lib/cashbox.ts isBeforeRestart). Right
// for money that was already in the 30.09 balance; wrong for money that arrived afterwards — a
// debt settled on 03.10 for №231, cash for №104 and №161 today — which is in the account and the
// drawer but was in no figure here. Ten such payments were recorded after the restart: 937 860 ₸
// (Нұр 448 440, Қолма-қол 487 820, Pay 1 600). Each gets countsInCurrentBooks, exactly as Касса's
// own «Кассаға қосу» does for an Admin (ManagerCashbox.tsx handleCountPayment). The five recorded
// on 30.09 before the restart (09:56–10:34, 680 460 ₸) were in its balance and stay out.
//
//   node --env-file=.env.local scripts/count-old-orders-money-2026-10-05.mjs          # dry run, writes nothing
//   node --env-file=.env.local scripts/count-old-orders-money-2026-10-05.mjs --apply
//
// Refuses if the payments found no longer add up to the 937 860 ₸ the owner agreed to: anything
// recorded since is the owner's to decide on. Re-running after an apply is a no-op.
import { readFileSync } from "node:fs";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const APPLY = process.argv.includes("--apply");
const ACTOR_UID = "sPHBndKUNwZMgu6VUkjMyBTbqaC2"; // Нур — the owner, who agreed
const AGREED_TIYN = 937_860_00;
const RESTART_MS = Date.parse("2026-09-30T11:30:16+05:00"); // the second, final cash.restart write

const sa = JSON.parse(readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, "utf8"));
if (getApps().length === 0) initializeApp({ credential: cert(sa) });
const db = getFirestore();
const actorSnap = await db.collection("users").doc(ACTOR_UID).get();
if (!actorSnap.exists) throw new Error(`Actor ${ACTOR_UID} табылмады`);
const actor = { uid: ACTOR_UID, name: actorSnap.data().name };
const fmt = (t) => `${(t / 100).toLocaleString("ru-RU")} ₸`;
const when = (ts) => new Date(ts.toMillis() + 5 * 3600e3).toISOString().slice(0, 16).replace("T", " ");
const day = (ts) => new Date(ts.toMillis() + 5 * 3600e3).toISOString().slice(0, 10);
console.log(APPLY ? "== APPLY ==" : "== DRY RUN (nothing is written) ==");

const settings = (await db.collection("applicationSettings").doc("global").get()).data();
const firstNo = settings.cashStartOrderNumber;
if (firstNo !== "ORD-2026-000281" || settings.cashStartDate !== "2026-09-30") {
  throw new Error(`the books no longer start at №281 on 30.09 (${firstNo}, ${settings.cashStartDate})`);
}
const orders = new Map((await db.collection("orders").get()).docs.map((d) => [d.id, d.data()]));
const payments = (await db.collection("payments").get()).docs.map((d) => ({ ref: d.ref, id: d.id, ...d.data() }));
const late = payments.filter((p) => {
  const o = orders.get(p.orderId);
  return o && o.orderKind !== "mdf_wrap" && o.orderNumber < firstNo && !p.reversed
    && p.paymentDate && day(p.paymentDate) >= settings.cashStartDate
    && p.createdAt && p.createdAt.toMillis() > RESTART_MS;
}).sort((a, b) => a.createdAt.toMillis() - b.createdAt.toMillis());

const todo = late.filter((p) => !p.countsInCurrentBooks);
for (const p of late) {
  const o = orders.get(p.orderId);
  console.log(`  ${o.orderNumber} ${o.customerName} | ${fmt(p.amountTiyn)} ${p.methodName} | recorded ${when(p.createdAt)}${p.countsInCurrentBooks ? " | already counted" : ""}`);
}
const total = late.reduce((s, p) => s + p.amountTiyn, 0);
console.log(`${late.length} payments, ${fmt(total)}; ${todo.length} still left out`);
if (total !== AGREED_TIYN) {
  throw new Error(`found ${fmt(total)}, not the ${fmt(AGREED_TIYN)} the owner agreed to — ask before counting the rest`);
}
if (todo.length === 0) {
  console.log("All already counted — nothing to do.");
  process.exit(0);
}
if (!APPLY) {
  console.log("Dry run only — add --apply to write.");
  process.exit(0);
}

const batch = db.batch();
for (const p of todo) {
  const o = orders.get(p.orderId);
  batch.update(p.ref, { countsInCurrentBooks: true });
  batch.set(db.collection("auditLogs").doc(), {
    userId: actor.uid, userName: actor.name, action: "payment.countsInCurrentBooks", entityType: "payment",
    entityId: p.id, before: { countsInCurrentBooks: false }, after: { countsInCurrentBooks: true },
    comment: `${o.orderNumber} ${fmt(p.amountTiyn)} ${p.methodName} — 30.09 расчеттан кейін түскен (иесі, 05.10)`,
    createdAt: FieldValue.serverTimestamp(),
  });
}
await batch.commit();
console.log(`✅ ${todo.length} төлем Кассаға қосылды.`);
