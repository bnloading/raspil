// End-to-end check that a journal order reaches the customer's own account.
//
// Runs the same rule the app runs (src/lib/customerLink.ts): normalise the phone, find the
// customer account holding it, attach the order. Then it asks the question from the customer's
// side — the exact query their pages use, `where("customerId", "==", uid)` — and reports whether
// the order came back and what debt it carries.
//
//   node --env-file=.env.local scripts/verify-customer-link.mjs            # report only
//   node --env-file=.env.local scripts/verify-customer-link.mjs --write    # create a test order
//   node --env-file=.env.local scripts/verify-customer-link.mjs --cleanup  # remove it again
//
// The test order is marked in its own customerName so it is obvious in the journal and safe to
// delete; --cleanup removes exactly the orders this script created, by that marker.

import { readFileSync } from "node:fs";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

const write = process.argv.includes("--write");
const cleanup = process.argv.includes("--cleanup");

const MARKER = "ТЕСТ — байланыс тексерісі";

function normalizePhone(raw) {
  let digits = String(raw ?? "").replace(/\D/g, "");
  if (digits.length === 10) digits = "7" + digits;
  if (digits.length === 11 && digits.startsWith("8")) digits = "7" + digits.slice(1);
  return digits.length === 11 && digits.startsWith("7") ? digits : null;
}

const sa = JSON.parse(readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, "utf8"));
if (getApps().length === 0) initializeApp({ credential: cert(sa) });
const db = getFirestore();

if (cleanup) {
  const junk = await db.collection("orders").where("customerName", "==", MARKER).get();
  for (const d of junk.docs) await d.ref.delete();
  console.log(`🧹 ${junk.size} тексеру заказы өшірілді.`);
  await db.terminate();
} else {
  const accounts = await db.collection("users").where("role", "==", "customer").get();
  console.log(`Клиент аккаунттары: ${accounts.size}`);
  for (const a of accounts.docs) {
    const u = a.data();
    console.log(`  ${a.id}  "${u.name}"  ${u.phone || "(телефонсыз)"}`);
  }

  const usable = accounts.docs.filter((a) => normalizePhone(a.data().phone));
  if (usable.length === 0) {
    console.log("\n⚠ Телефоны бар клиент аккаунты жоқ — тексеретін ештеңе жоқ.");
    console.log("   Аккаунт тіркеп, нөмірін жазыңыз, сосын қайта жүргізіңіз.");
    await db.terminate();
  } else {
    const account = usable[0];
    const phone = normalizePhone(account.data().phone);
    console.log(`\nТексеру: "${account.data().name}" · +${phone}`);

    // ── the app's rule, run here exactly as src/lib/customerLink.ts runs it ────
    const found = await db
      .collection("users")
      .where("role", "==", "customer")
      .where("phone", "==", phone)
      .limit(1)
      .get();
    const linkedId = found.empty ? null : found.docs[0].id;
    console.log(`  Телефон бойынша табылған аккаунт: ${linkedId ?? "жоқ"}`);
    console.log(`  Күтілген: ${account.id} → ${linkedId === account.id ? "✅ сәйкес" : "❌ сәйкес емес"}`);

    let orderId = null;
    if (write) {
      const ref = db.collection("orders").doc();
      await ref.set({
        orderNumber: `TEST-${Date.now()}`,
        customerId: linkedId,
        customerName: MARKER,
        customerPhone: `+${phone}`,
        productionStatus: "waiting_payment",
        paymentStatus: "unpaid",
        priority: 0,
        estimatedSheets: 2,
        confirmedSheets: 2,
        pvcMetersTotal: 0,
        materialId: "",
        materialSnapshot: {
          name: "ЛДСП Ақ", article: "TEST", color: "Ақ",
          thicknessMm: 16, sheetLengthMm: 2800, sheetWidthMm: 2070, sellingPriceTiyn: 1650000,
        },
        materialCostTiyn: 3300000, cuttingCostTiyn: 0, pvcCostTiyn: 0, hdfCostTiyn: 0,
        extraServicesTiyn: 0, deliveryCostTiyn: 0, discountTiyn: 0,
        totalTiyn: 3300000, paidTiyn: 0, debtTiyn: 3300000,
        pricePublished: true, isDraft: false,
        createdAt: Timestamp.now(),
      });
      orderId = ref.id;
      console.log(`\n  Тексеру заказы құрылды: ${orderId}`);
    }

    // ── the customer's own side: the exact query their pages run ──────────────
    const mine = await db.collection("orders").where("customerId", "==", account.id).get();
    const debt = mine.docs
      .filter((d) => d.data().productionStatus !== "cancelled")
      .reduce((s, d) => s + Math.max(0, d.data().debtTiyn ?? 0), 0);

    console.log(`\nКлиент өз аккаунтынан көретіні (customerId == ${account.id}):`);
    console.log(`  Заказ саны: ${mine.size}`);
    for (const d of mine.docs) {
      console.log(`    ${d.data().orderNumber}  "${d.data().customerName}"  қарыз ${(d.data().debtTiyn ?? 0) / 100} ₸`);
    }
    console.log(`  Жалпы қарызы: ${debt / 100} ₸`);

    if (!write) console.log("\nЗаказ құрып тексеру үшін --write қосыңыз.");
    else console.log("\nӨшіру үшін: node --env-file=.env.local scripts/verify-customer-link.mjs --cleanup");

    await db.terminate();
  }
}
