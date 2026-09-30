// Closes the books at order №281, as the owner asked on 2026-09-30: "№281 заказға дейінгі очет
// істеліп бітті — енді бастапқы сумма 5 339 797, келесі расчет №281 заказдан".
//
// The same operation as scripts/cash-restart-2026-09-22.mjs, drawn at an order instead of at
// midnight: №279 and №280 were written the same morning as №281 and are in the settlement, so the
// start date alone cannot separate them. cashStartOrderNumber does (lib/cashbox.ts
// isBeforeRestart), and the journal draws the "расчет істелді" line above №281.
//
// Current state before this script (read 2026-09-30):
//   cashStartDate:                       2026-09-22
//   cashOpeningBalanceTiyn.ldsp.deposit: 4 253 791 ₸
//
// After --apply:
//   cashStartDate:                       2026-09-30
//   cashStartOrderNumber:                ORD-2026-000281
//   cashOpeningBalanceTiyn.ldsp.deposit: 5 228 737 ₸
//
// The owner's 5 339 797 ₸ already held №281's own 111 060 ₸ ("ол заказ есептеліп қойды") — it
// was first applied as the opening balance and counted №281 a second time, so the opening is
// 5 339 797 − 111 060 and Нұр reads 5 339 797 ₸ with №281 counted once.
//
// Only ldsp.deposit (Нұр) carries a balance, as on 22.09 — Kaspi/Pay and қолма-қол start from 0.
// Payments on orders before №281 drop out of Касса from here on, today's included, and are listed
// under it instead; expenses dated before 30.09 drop out too. Order history is untouched.
//
//   node --env-file=.env.local scripts/cash-restart-2026-09-30.mjs          # dry run, writes nothing
//   node --env-file=.env.local scripts/cash-restart-2026-09-30.mjs --apply
//
// Re-running after an apply writes nothing: the settings already read as below.
import { readFileSync } from "node:fs";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const APPLY = process.argv.includes("--apply");
const ACTOR_UID = "sPHBndKUNwZMgu6VUkjMyBTbqaC2";
const NEW_START_DATE = "2026-09-30";
const NEW_START_ORDER = "ORD-2026-000281";
const NEW_DEPOSIT_TIYN = 5_339_797_00 - 111_060_00; // №281's payment is already inside the 5 339 797

const sa = JSON.parse(readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, "utf8"));
if (getApps().length === 0) initializeApp({ credential: cert(sa) });
const db = getFirestore();
const actorSnap = await db.collection("users").doc(ACTOR_UID).get();
if (!actorSnap.exists) throw new Error(`Actor ${ACTOR_UID} табылмады`);
const actor = { userId: ACTOR_UID, userName: actorSnap.data().name };
const day = (ts) => (ts ? new Date(ts.toMillis() + 5 * 3600e3).toISOString().slice(0, 10) : null);
const fmt = (t) => `${((t ?? 0) / 100).toLocaleString("ru-RU")} ₸`;
console.log(APPLY ? "== APPLY ==" : "== DRY RUN (nothing is written) ==");

const settingsRef = db.collection("applicationSettings").doc("global");
const before = (await settingsRef.get()).data() ?? {};
console.log("Қазір:  cashStartDate", before.cashStartDate ?? "(жоқ)",
  "| cashStartOrderNumber", before.cashStartOrderNumber ?? "(жоқ)",
  "| ldsp.deposit", fmt(before.cashOpeningBalanceTiyn?.ldsp?.deposit));
console.log("Болады: cashStartDate", NEW_START_DATE, "| cashStartOrderNumber", NEW_START_ORDER,
  "| ldsp.deposit", fmt(NEW_DEPOSIT_TIYN));

const orderDocs = (await db.collection("orders").get()).docs.map((d) => ({ id: d.id, ...d.data() }));
const first = orderDocs.find((o) => o.orderNumber === NEW_START_ORDER);
if (!first) throw new Error(`${NEW_START_ORDER} табылмады`);
console.log(`\n${NEW_START_ORDER}: ${first.customerName}, ${day(first.createdAt)}, ${fmt(first.totalTiyn)}`);

// Касса as lib/cashbox.ts computeCashbox will count it under the new settings, per line.
const orders = new Map(orderDocs.map((o) => [o.id, o]));
const methods = new Map((await db.collection("paymentMethods").get()).docs.map((d) => [d.id, d.data()]));
const account = (id) => methods.get(id)?.account ?? (id === "cash" ? "cash" : "deposit");
const dept = (o) => (o?.orderKind === "mdf_wrap" ? "mdf" : "ldsp");
const settled = (o) => (o.orderNumber ? o.orderNumber < NEW_START_ORDER : !!o.createdAt && day(o.createdAt) < NEW_START_DATE);
const payments = (await db.collection("payments").get()).docs.map((d) => ({ id: d.id, ...d.data() }));
const expenses = (await db.collection("expenses").get()).docs.map((d) => d.data());
const opening = { ...(before.cashOpeningBalanceTiyn ?? {}), ldsp: { ...(before.cashOpeningBalanceTiyn?.ldsp ?? {}), deposit: NEW_DEPOSIT_TIYN } };
for (const line of ["ldsp", "mdf"]) {
  const pot = { deposit: 0, pay: 0, cash: 0 };
  for (const a of Object.keys(pot)) pot[a] = opening[line]?.[a] ?? 0;
  const left = [];
  for (const p of payments) {
    if (p.reversed || !p.paymentDate || day(p.paymentDate) < NEW_START_DATE) continue;
    const o = orders.get(p.orderId);
    if (dept(o) !== line) continue;
    if (o && settled(o) && !p.countsInCurrentBooks) { left.push(`${o.orderNumber} ${o.customerName} ${p.methodName} ${fmt(p.amountTiyn)}`); continue; }
    pot[account(p.methodId)] += p.amountTiyn;
  }
  for (const e of expenses) if ((e.department ?? "ldsp") === line && e.date >= NEW_START_DATE) pot[e.account ?? "cash"] -= e.amountTiyn;
  for (const a of before.cashAdjustments?.[line] ?? []) if (a.date >= NEW_START_DATE) pot[a.account] += a.amountTiyn;
  console.log(`\n${line}: Нұр ${fmt(pot.deposit)} · Kaspi/Pay ${fmt(pot.pay)} · Қолма-қол ${fmt(pot.cash)}`);
  if (left.length) console.log(`  №281-ге дейінгі заказдарға бүгін түскен, Кассаға кірмейтін ${left.length} төлем:\n    ${left.join("\n    ")}`);
}

const already = before.cashStartDate === NEW_START_DATE && before.cashStartOrderNumber === NEW_START_ORDER
  && before.cashOpeningBalanceTiyn?.ldsp?.deposit === NEW_DEPOSIT_TIYN;
if (already) {
  console.log("\nAlready applied — nothing to write.");
} else if (!APPLY) {
  console.log("\nDry run only — add --apply to write.");
} else {
  await settingsRef.set(
    {
      cashStartDate: NEW_START_DATE,
      cashStartOrderNumber: NEW_START_ORDER,
      cashOpeningBalanceTiyn: { ldsp: { deposit: NEW_DEPOSIT_TIYN } },
    },
    { merge: true },
  );
  await db.collection("auditLogs").add({
    userId: actor.userId, userName: actor.userName,
    action: "cash.restart", entityType: "applicationSettings", entityId: "global",
    before: {
      cashStartDate: before.cashStartDate ?? null,
      cashStartOrderNumber: before.cashStartOrderNumber ?? null,
      ldspDepositTiyn: before.cashOpeningBalanceTiyn?.ldsp?.deposit ?? null,
    },
    after: { cashStartDate: NEW_START_DATE, cashStartOrderNumber: NEW_START_ORDER, ldspDepositTiyn: NEW_DEPOSIT_TIYN },
    comment: `№281 заказға дейін расчет істелді — бастапқы сумма ${fmt(NEW_DEPOSIT_TIYN)} (Нұр; 5 339 797 ₸ − №281-дің 111 060 ₸)`,
    createdAt: FieldValue.serverTimestamp(),
  });
  console.log("\n✅ Жазылды.");
}
