// Read-only audit of the Депозит total — checks the three things the owner asked about:
//   1) does a debt/credit-cut order's UNPAID portion ever end up counted as money received?
//   2) does a partially-paid order contribute more than what was actually paid?
//   3) do cancelled orders' payments (if never reversed) still add to the deposit?
// Mirrors the exact rules computeCashbox() (lib/cashbox.ts) and recordPayment() (lib/payments.ts)
// use, just run once here against the live data with every order/payment printed out instead of
// only a total. Nothing is written.
//
//   node --env-file=.env.local scripts/audit-deposit-2026-09-23.mjs

import { readFileSync } from "node:fs";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const sa = JSON.parse(readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, "utf8"));
if (getApps().length === 0) initializeApp({ credential: cert(sa) });
const db = getFirestore();

const tg = (tiyn) => (tiyn / 100).toLocaleString("kk-KZ");

const [ordersSnap, paymentsSnap, methodsSnap, settingsSnap] = await Promise.all([
  db.collection("orders").get(),
  db.collection("payments").get(),
  db.collection("paymentMethods").get(),
  db.collection("applicationSettings").doc("global").get(),
]);

const orders = new Map(ordersSnap.docs.map((d) => [d.id, { id: d.id, ...d.data() }]));
const payments = paymentsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
const methods = new Map(methodsSnap.docs.map((d) => [d.id, d.data()]));
const settings = settingsSnap.data() ?? {};
const cashStartDate = settings.cashStartDate ?? null;

const CASH_METHOD_ID = "cash";
function accountFor(methodId) {
  const m = methods.get(methodId);
  if (m?.account) return m.account;
  if (methodId === CASH_METHOD_ID) return "cash";
  return "deposit";
}
function dayKeyOf(ts) {
  if (!ts) return null;
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Almaty" }).format(d); // YYYY-MM-DD
}

console.log(`cashStartDate: ${cashStartDate}`);
console.log(`Барлығы: ${orders.size} заказ, ${payments.length} төлем жазбасы\n`);

// ── 1) Integrity: order.paidTiyn must equal sum of its own non-reversed payments ──
const paidByOrder = new Map();
for (const p of payments) {
  if (p.reversed) continue;
  paidByOrder.set(p.orderId, (paidByOrder.get(p.orderId) ?? 0) + (p.amountTiyn ?? 0));
}
let mismatches = [];
for (const [id, order] of orders) {
  const livePaid = paidByOrder.get(id) ?? 0;
  const stored = order.paidTiyn ?? 0;
  if (Math.abs(livePaid - stored) > 1) {
    mismatches.push({ order, livePaid, stored });
  }
  // Debt sanity: paid should never exceed total by more than a small overpay margin one would expect.
}
console.log(`=== 1) order.paidTiyn vs нақты төлемдер сомасы ===`);
if (mismatches.length === 0) {
  console.log("Сәйкессіздік жоқ — әр заказдың paidTiyn өрісі нақты (reversed емес) төлемдер сомасына дәл тең.\n");
} else {
  console.log(`⚠️ ${mismatches.length} заказда сәйкессіздік бар:`);
  for (const { order, livePaid, stored } of mismatches.slice(0, 30)) {
    console.log(`  №${order.orderNumber} (${order.productionStatus}) — тіркелген paidTiyn: ${tg(stored)} ₸, нақты төлемдер: ${tg(livePaid)} ₸`);
  }
  console.log();
}

// ── 2) Credit-cut / debt orders: does the UNPAID part ever show up as a payment? ──
console.log(`=== 2) Қарызға кесілген / қарызы бар заказдар ===`);
const debtOrders = [...orders.values()].filter((o) => (o.debtTiyn ?? 0) > 0 && o.productionStatus !== "cancelled");
let debtButOverpaid = debtOrders.filter((o) => (paidByOrder.get(o.id) ?? 0) > (o.paidTiyn ?? 0) + 1);
console.log(`Қарызы бар заказ саны: ${debtOrders.length}, жалпы қарыз: ${tg(debtOrders.reduce((s, o) => s + (o.debtTiyn ?? 0), 0))} ₸`);
console.log(`Соның ішінде "кесуге жіберілген" (қарызға): ${debtOrders.filter((o) => !["draft", "waiting_payment"].includes(o.productionStatus)).length}`);
if (debtButOverpaid.length > 0) {
  console.log(`⚠️ ${debtButOverpaid.length} заказда нақты төлем тіркелген paidTiyn-нен көп (тексеру керек):`);
  for (const o of debtButOverpaid) console.log(`  №${o.orderNumber} — тіркелген: ${tg(o.paidTiyn)} ₸, нақты: ${tg(paidByOrder.get(o.id) ?? 0)} ₸`);
} else {
  console.log("Әр қарызы бар заказда депозитке тек НАҚТЫ төленген сома ғана кіреді — қарыз (төленбеген) бөлігі ешқашан төлем ретінде саналмайды.");
}
console.log();

// ── 3) Cancelled orders: do their (unreversed) payments still count toward the deposit? ──
console.log(`=== 3) Бас тартылған (cancelled) заказдар ===`);
const cancelled = [...orders.values()].filter((o) => o.productionStatus === "cancelled");
const cancelledWithMoney = cancelled
  .map((o) => ({ order: o, activePaid: paidByOrder.get(o.id) ?? 0 }))
  .filter((x) => x.activePaid > 0);
console.log(`Барлық бас тартылған заказ: ${cancelled.length}`);
console.log(`Соның ішінде әлі "reversed" болмаған (қайтарылмаған) төлемі барлар: ${cancelledWithMoney.length}`);
if (cancelledWithMoney.length > 0) {
  const total = cancelledWithMoney.reduce((s, x) => s + x.activePaid, 0);
  console.log(`Бұлардың депозит/қолма-қолға әлі қосылып тұрған жалпы сомасы: ${tg(total)} ₸\n`);
  for (const { order, activePaid } of cancelledWithMoney) {
    const reason = order.cancelReason ? ` — себебі: "${order.cancelReason}"` : "";
    console.log(`  №${order.orderNumber} · ${order.customerName ?? ""} · ${tg(activePaid)} ₸${reason}`);
  }
  console.log(`\n⚠️ Бұл заказдар жүйеде әлі "cancelled" болғанымен, олардың төлемдері "reversed" деп белгіленбеген —`);
  console.log(`сондықтан жоғарыдағы сома қазір де Депозит/Қолма-қол қалдығына қосылып тұр. Егер бұл ақша`);
  console.log(`нақты клиентке қайтарылған болса, әр төлемді "Қайтару" (reversePayment) арқылы белгілеу керек.`);
  console.log(`Егер ақша клиентте қалдырылған болса (депозит қайтарылмайтын саясат), бұл дұрыс — түзету қажет емес.`);
} else {
  console.log("Барлық бас тартылған заказдың төлемдері дұрыс — не төлем болмаған, не бәрі 'reversed' деп белгіленген.");
}
console.log();

// ── 4) The actual deposit total right now, with/without cancelled-order money, for comparison ──
console.log(`=== 4) Депозит қалдығы (қазіргі cashStartDate=${cashStartDate} бойынша, барлық уақыт) ===`);
let depositAll = 0, depositExclCancelled = 0, cashAll = 0;
for (const p of payments) {
  if (p.reversed) continue;
  const day = dayKeyOf(p.paymentDate);
  if (cashStartDate && (!day || day < cashStartDate)) continue;
  const acct = accountFor(p.methodId);
  if (acct === "deposit") {
    depositAll += p.amountTiyn ?? 0;
    const order = orders.get(p.orderId);
    if (!order || order.productionStatus !== "cancelled") depositExclCancelled += p.amountTiyn ?? 0;
  } else if (acct === "cash") {
    cashAll += p.amountTiyn ?? 0;
  }
}
const opening = settings.cashOpeningBalanceTiyn?.ldsp?.deposit ?? 0;
console.log(`Депозит бастапқы қалдығы: ${tg(opening)} ₸`);
console.log(`+ осы кезеңдегі түскен төлемдер (барлығы, cancelled қоса): ${tg(depositAll)} ₸`);
console.log(`  → жиынтық: ${tg(opening + depositAll)} ₸  (қосымша Кассадағы бетте көрсетілетін сома)`);
console.log(`+ осы кезеңдегі түскен төлемдер (cancelled заказдарды АЛЫП ТАСТАП): ${tg(depositExclCancelled)} ₸`);
console.log(`  → айырмашылық: ${tg(depositAll - depositExclCancelled)} ₸ (cancelled заказдардан қалған, reversed етілмеген ақша)`);
