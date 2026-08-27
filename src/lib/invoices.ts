import {
  collection,
  doc,
  getDocs,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  type Firestore,
} from "firebase/firestore";
import type { User } from "firebase/auth";
import type { Invoice, InvoiceLine, Order, Payment, UserDoc } from "../types/domain";
import { netPaidTiyn } from "./journal";
import { logAudit } from "./audit";

type Actor = { user: User; userData: UserDoc };

/** Sequential invoice number, atomic like the order counter so two Managers can't collide. */
async function generateInvoiceNumber(db: Firestore): Promise<string> {
  const year = new Date().getFullYear();
  const counterRef = doc(db, "counters", `invoiceNumber_${year}`);
  const seq = await runTransaction(db, async (tx) => {
    const snap = await tx.get(counterRef);
    const next = (snap.exists() ? (snap.data().seq as number) : 0) + 1;
    tx.set(counterRef, { seq: next }, { merge: true });
    return next;
  });
  return `INV-${year}-${String(seq).padStart(5, "0")}`;
}

/**
 * Builds the invoice's line items from an order. Only non-zero components appear, so a plain
 * cutting job doesn't carry empty "ХДФ — 0 ₸" filler rows.
 */
export function buildInvoiceLines(order: Order): InvoiceLine[] {
  const lines: InvoiceLine[] = [];
  const sheets = order.confirmedSheets ?? order.estimatedSheets;

  if (order.materialCostTiyn > 0) {
    lines.push({
      name: order.materialSnapshot.name || "Материал",
      qty: sheets,
      unit: "лист",
      unitPriceTiyn: order.materialSnapshot.sellingPriceTiyn,
      totalTiyn: order.materialCostTiyn,
    });
  }
  if (order.pvcCostTiyn > 0) {
    lines.push({
      name: "ПВХ жиек",
      qty: order.pvcMetersTotal,
      unit: "м",
      unitPriceTiyn: order.pvcPricePerMeterTiyn ?? 0,
      totalTiyn: order.pvcCostTiyn,
    });
  }
  if (order.hdfCostTiyn > 0) {
    lines.push({ name: "ХДФ", qty: 1, unit: "дана", unitPriceTiyn: order.hdfCostTiyn, totalTiyn: order.hdfCostTiyn });
  }
  if (order.cuttingCostTiyn > 0) {
    lines.push({
      name: "Распил қызметі",
      qty: sheets,
      unit: "лист",
      unitPriceTiyn: sheets > 0 ? Math.round(order.cuttingCostTiyn / sheets) : order.cuttingCostTiyn,
      totalTiyn: order.cuttingCostTiyn,
    });
  }
  if (order.extraServicesTiyn > 0) {
    lines.push({
      name: "Қосымша қызмет",
      qty: 1,
      unit: "қызмет",
      unitPriceTiyn: order.extraServicesTiyn,
      totalTiyn: order.extraServicesTiyn,
    });
  }
  if (order.deliveryCostTiyn > 0) {
    lines.push({
      name: "Жеткізу",
      qty: 1,
      unit: "қызмет",
      unitPriceTiyn: order.deliveryCostTiyn,
      totalTiyn: order.deliveryCostTiyn,
    });
  }
  return lines;
}

/**
 * Issues a new invoice version for an order. Never mutates a previous invoice — reprinting an old
 * one must still show the figures that were agreed at the time.
 */
export async function issueInvoice(
  db: Firestore,
  actor: Actor,
  order: Order,
  payments: Payment[],
  note?: string,
): Promise<string> {
  const existing = await getDocs(query(collection(db, "invoices"), where("orderId", "==", order.id)));
  const version = existing.size + 1;

  const lines = buildInvoiceLines(order);
  const subtotalTiyn = lines.reduce((s, l) => s + l.totalTiyn, 0);
  const paid = netPaidTiyn(payments);
  const methodNames = [
    ...new Set(payments.filter((p) => !p.reversed).map((p) => p.methodName)),
  ];

  const invoiceNumber = await generateInvoiceNumber(db);
  const ref = doc(collection(db, "invoices"));

  await setDoc(ref, {
    orderId: order.id,
    orderNumber: order.orderNumber,
    invoiceNumber,
    version,
    customerId: order.customerId ?? null,
    customerName: order.customerName,
    customerPhone: order.customerPhone,
    lines,
    subtotalTiyn,
    discountTiyn: order.discountTiyn ?? 0,
    totalTiyn: order.totalTiyn,
    paidTiyn: paid,
    debtTiyn: order.totalTiyn - paid,
    paymentMethods: methodNames,
    note: note ?? "",
    issuedByUid: actor.user.uid,
    issuedByName: actor.userData.name,
    issuedAt: serverTimestamp(),
    sentToCustomer: false,
    pdfStorage: "on_demand",
  });

  await logAudit(db, actor, {
    action: "invoice.issue",
    entityType: "invoice",
    entityId: ref.id,
    after: { invoiceNumber, version, totalTiyn: order.totalTiyn },
  });

  return ref.id;
}

/**
 * Publishes an invoice to the customer's account and notifies them in-app. Deliberately does not
 * claim to send email/WhatsApp — there's no such integration configured, and faking a successful
 * send would be worse than not offering it.
 */
export async function sendInvoiceToCustomer(db: Firestore, actor: Actor, invoice: Invoice): Promise<void> {
  await updateDoc(doc(db, "invoices", invoice.id), {
    sentToCustomer: true,
    sentAt: serverTimestamp(),
  });

  if (invoice.customerId) {
    await setDoc(doc(collection(db, "notifications")), {
      userId: invoice.customerId,
      type: "invoice_sent",
      title: "Накладной дайын",
      body: `${invoice.orderNumber} бойынша накладной аккаунтыңызға жіберілді`,
      orderId: invoice.orderId,
      read: false,
      createdAt: serverTimestamp(),
    });
  }

  await logAudit(db, actor, {
    action: "invoice.send",
    entityType: "invoice",
    entityId: invoice.id,
    after: { invoiceNumber: invoice.invoiceNumber },
  });
}
