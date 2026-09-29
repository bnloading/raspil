// Puts back the money the journal's "Артық төлем түзетілді" moved to the day it was pressed.
//
// That button used to reverse every payment on an overpaid order and write one new payment for
// the order total, dated the moment it was pressed and under the last payment's method. Касса
// dates money by the payment, so on 29.09 ORD-2026-000224's 26.09 Нұр read as 29.09, and
// ORD-2026-000150's 100 000 ₸ Нұр + 50 000 ₸ cash became 148 400 ₸ cash. The button now trims the
// excess off the newest payments instead (lib/payments.ts planOverpaymentTrim); this gives the
// orders it already touched the same result:
//
//   1. The original payments that button reversed come back, with their own date and method.
//   2. The excess comes off them newest first, exactly as planOverpaymentTrim does: one whose
//      whole amount is excess stays reversed, the next one has its amount brought down.
//   3. The replacement payment it wrote is reversed.
//
// Only replacements dated on a different day from the payment they replaced, or under a different
// method, are touched: where both match (ORD-200, 164, 169) Касса already reads right. The order's
// paidTiyn does not change — what stays equals the replacement to the tenge, and that is checked
// before anything is written.
//
//   node --env-file=.env.local scripts/overpay-dates-fix-2026-09-29.mjs          # dry run, writes nothing
//   node --env-file=.env.local scripts/overpay-dates-fix-2026-09-29.mjs --apply
//
// Re-running after an apply is a no-op: a reversed replacement is no longer live, so its order is
// skipped.
import { readFileSync } from "node:fs";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const APPLY = process.argv.includes("--apply");
const ACTOR_UID = "sPHBndKUNwZMgu6VUkjMyBTbqaC2";
const TAG = "Артық төлем түзетілді";

const sa = JSON.parse(readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, "utf8"));
if (getApps().length === 0) initializeApp({ credential: cert(sa) });
const db = getFirestore();
const actorSnap = await db.collection("users").doc(ACTOR_UID).get();
if (!actorSnap.exists) throw new Error(`Actor ${ACTOR_UID} табылмады`);
const actor = { uid: ACTOR_UID, name: actorSnap.data().name };
const day = (ts) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Almaty", year: "numeric", month: "2-digit", day: "2-digit" }).format(ts.toDate());
const fmt = (t) => `${(t / 100).toLocaleString("ru-RU")} ₸`;
const said = (p) => `${day(p.paymentDate)} ${p.methodName} ${fmt(p.amountTiyn)}`;
console.log(APPLY ? "== APPLY ==" : "== DRY RUN (nothing is written) ==");

// lib/payments.ts planOverpaymentTrim, as it is in the app.
function planOverpaymentTrim(live, excessTiyn) {
  const when = (p) => p.paymentDate?.toMillis() ?? p.createdAt?.toMillis() ?? 0;
  const newestFirst = [...live].sort((a, b) => when(b) - when(a));
  const reverse = [];
  let left = excessTiyn;
  for (const p of newestFirst) {
    if (left <= 0) break;
    if (p.amountTiyn > left) return { reverse, correct: { paymentId: p.id, amountTiyn: p.amountTiyn - left } };
    reverse.push(p.id);
    left -= p.amountTiyn;
  }
  return { reverse, correct: null };
}

const payments = (await db.collection("payments").get()).docs.map((d) => ({ id: d.id, ...d.data() }));
const replacements = payments.filter((p) => p.comment === TAG && !p.reversed);
let fixed = 0;
for (const r of replacements) {
  const orderRef = db.collection("orders").doc(r.orderId);
  const order = (await orderRef.get()).data();
  const onOrder = payments.filter((p) => p.orderId === r.orderId);
  // The payments that button reversed: real ones (not an earlier replacement), reversed by it.
  const originals = onOrder.filter((p) => p.reversed && p.reversalReason === TAG && p.comment !== TAG);
  if (originals.length === 0) continue;
  const moved = originals.some((p) => day(p.paymentDate) !== day(r.paymentDate) || p.methodId !== r.methodId);
  if (!moved) {
    console.log(`${order.orderNumber}: same day and method as what it replaced — left alone`);
    continue;
  }
  const excess = originals.reduce((s, p) => s + p.amountTiyn, 0) - r.amountTiyn;
  if (excess < 0) throw new Error(`${order.orderNumber}: the replacement is more than the originals`);
  const plan = planOverpaymentTrim(originals, excess);
  const kept = originals.filter((p) => !plan.reverse.includes(p.id));
  const keptTiyn = kept.reduce((s, p) => s + (p.id === plan.correct?.paymentId ? plan.correct.amountTiyn : p.amountTiyn), 0);
  const liveNow = onOrder.filter((p) => !p.reversed).reduce((s, p) => s + p.amountTiyn, 0);
  if (keptTiyn !== r.amountTiyn || liveNow !== order.paidTiyn) {
    throw new Error(`${order.orderNumber}: kept ${fmt(keptTiyn)} ≠ replacement ${fmt(r.amountTiyn)}, or live ${fmt(liveNow)} ≠ paid ${fmt(order.paidTiyn)}`);
  }

  console.log(`${order.orderNumber} ${order.customerName} (${fmt(order.totalTiyn)}): replacement ${said(r)} → reversed`);
  for (const p of kept) {
    const to = p.id === plan.correct?.paymentId ? ` → ${fmt(plan.correct.amountTiyn)}` : "";
    console.log(`   back: ${said(p)}${to}`);
  }
  for (const id of plan.reverse) console.log(`   stays reversed: ${said(originals.find((p) => p.id === id))}`);
  fixed++;
  if (!APPLY) continue;

  const batch = db.batch();
  for (const p of kept) {
    const correct = p.id === plan.correct?.paymentId;
    batch.update(db.collection("payments").doc(p.id), {
      reversed: false,
      reversalReason: FieldValue.delete(),
      reversedByUid: FieldValue.delete(),
      reversedByName: FieldValue.delete(),
      ...(correct ? {
        amountTiyn: plan.correct.amountTiyn,
        correctedByUid: actor.uid,
        correctedByName: actor.name,
        correctedAt: FieldValue.serverTimestamp(),
      } : {}),
    });
  }
  batch.update(db.collection("payments").doc(r.id), {
    reversed: true,
    reversalReason: `${TAG}: орнына бастапқы төлем өз күнімен қайтарылды`,
    reversedByUid: actor.uid,
    reversedByName: actor.name,
  });
  batch.set(db.collection("auditLogs").doc(), {
    userId: actor.uid, userName: actor.name, action: "payment.overpayment_restore", entityType: "order", entityId: r.orderId,
    before: { replacementId: r.id, amountTiyn: r.amountTiyn, day: day(r.paymentDate), methodId: r.methodId },
    after: { kept: kept.map((p) => ({ id: p.id, day: day(p.paymentDate), methodId: p.methodId, amountTiyn: p.id === plan.correct?.paymentId ? plan.correct.amountTiyn : p.amountTiyn })) },
    comment: `${order.orderNumber}: артық төлем өз күнімен және тәсілімен түзетілді (2026-09-29)`,
    createdAt: FieldValue.serverTimestamp(),
  });
  await batch.commit();
}
console.log(`${fixed} заказ`);
console.log(APPLY ? "Done." : "Dry run only — add --apply to write.");
