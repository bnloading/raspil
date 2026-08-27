import { collection, doc, serverTimestamp, setDoc, Timestamp, updateDoc, type Firestore } from "firebase/firestore";
import type { User } from "firebase/auth";
import { computeJournalRowTotals } from "./journal";
import { generateOrderNumber } from "./orderNumber";
import { logAudit } from "./audit";
import type { Material, Order, UserDoc } from "../types/domain";

type Actor = { user: User; userData: UserDoc };

/** The editable subset of an order that the journal's inline cells own. */
export interface JournalDraft {
  customerName: string;
  customerPhone: string;
  materialId: string;
  sheetQty: number;
  sheetPriceTiyn: number;
  pvcMeters: number;
  pvcPricePerMeterTiyn: number;
  hdfCostTiyn: number;
  cuttingCostTiyn: number;
  extraServicesTiyn: number;
  deliveryCostTiyn: number;
  discountTiyn: number;
  orderDate: Date;
}

export function emptyJournalDraft(): JournalDraft {
  return {
    customerName: "",
    customerPhone: "",
    materialId: "",
    sheetQty: 1,
    sheetPriceTiyn: 0,
    pvcMeters: 0,
    pvcPricePerMeterTiyn: 0,
    hdfCostTiyn: 0,
    cuttingCostTiyn: 0,
    extraServicesTiyn: 0,
    deliveryCostTiyn: 0,
    discountTiyn: 0,
    orderDate: new Date(),
  };
}

/** Reads an existing order back into the journal's editable shape. */
export function draftFromOrder(order: Order): JournalDraft {
  return {
    customerName: order.customerName,
    customerPhone: order.customerPhone,
    materialId: order.materialId,
    sheetQty: order.confirmedSheets ?? order.estimatedSheets,
    sheetPriceTiyn: order.materialSnapshot.sellingPriceTiyn,
    pvcMeters: order.pvcMetersTotal,
    // Older orders (built through OrderBuilder from per-part PVC edges) have no blended rate
    // stored — derive it back out of the cost/metres they do have so the cell isn't blank.
    pvcPricePerMeterTiyn:
      order.pvcPricePerMeterTiyn ??
      (order.pvcMetersTotal > 0 ? Math.round(order.pvcCostTiyn / order.pvcMetersTotal) : 0),
    hdfCostTiyn: order.hdfCostTiyn ?? 0,
    cuttingCostTiyn: order.cuttingCostTiyn ?? 0,
    extraServicesTiyn: order.extraServicesTiyn ?? 0,
    deliveryCostTiyn: order.deliveryCostTiyn ?? 0,
    discountTiyn: order.discountTiyn ?? 0,
    orderDate: order.createdAt ? order.createdAt.toDate() : new Date(),
  };
}

function snapshotFor(material: Material | undefined, draft: JournalDraft): Order["materialSnapshot"] {
  return {
    name: material?.name ?? "—",
    article: material?.article ?? "",
    color: material?.color ?? "",
    thicknessMm: material?.thicknessMm ?? 0,
    sheetLengthMm: material?.sheetLengthMm ?? 0,
    sheetWidthMm: material?.sheetWidthMm ?? 0,
    // The journal's "Лист бағасы" cell overrides the catalog price for this order — a walk-in
    // deal can be struck at a different rate, and the snapshot is what the order is billed at.
    sellingPriceTiyn: draft.sheetPriceTiyn,
  };
}

/**
 * Persists inline journal edits to an existing order, recomputing every derived money field from
 * the same pure function the row preview uses. `paidTiyn` is never written here — it only ever
 * changes through lib/payments.ts's transactional recordPayment/reversePayment.
 */
export async function saveJournalRow(
  db: Firestore,
  actor: Actor,
  order: Order,
  draft: JournalDraft,
  material: Material | undefined,
): Promise<void> {
  const totals = computeJournalRowTotals({
    sheetQty: draft.sheetQty,
    sheetPriceTiyn: draft.sheetPriceTiyn,
    pvcMeters: draft.pvcMeters,
    pvcPricePerMeterTiyn: draft.pvcPricePerMeterTiyn,
    hdfCostTiyn: draft.hdfCostTiyn,
    cuttingCostTiyn: draft.cuttingCostTiyn,
    extraServicesTiyn: draft.extraServicesTiyn,
    deliveryCostTiyn: draft.deliveryCostTiyn,
    discountTiyn: draft.discountTiyn,
    paidTiyn: order.paidTiyn,
  });

  await updateDoc(doc(db, "orders", order.id), {
    customerName: draft.customerName.trim(),
    customerPhone: draft.customerPhone.trim(),
    materialId: draft.materialId,
    materialSnapshot: snapshotFor(material, draft),
    confirmedSheets: draft.sheetQty,
    pvcMetersTotal: draft.pvcMeters,
    pvcPricePerMeterTiyn: draft.pvcPricePerMeterTiyn,
    hdfCostTiyn: draft.hdfCostTiyn,
    cuttingCostTiyn: draft.cuttingCostTiyn,
    extraServicesTiyn: draft.extraServicesTiyn,
    deliveryCostTiyn: draft.deliveryCostTiyn,
    discountTiyn: draft.discountTiyn,
    materialCostTiyn: totals.materialCostTiyn,
    pvcCostTiyn: totals.pvcCostTiyn,
    totalTiyn: totals.totalTiyn,
    debtTiyn: totals.debtTiyn,
    paymentStatus: totals.paymentStatus,
    updatedAt: serverTimestamp(),
  });

  await logAudit(db, actor, {
    action: "order.journal_edit",
    entityType: "order",
    entityId: order.id,
    before: { totalTiyn: order.totalTiyn, sheets: order.confirmedSheets ?? order.estimatedSheets },
    after: { totalTiyn: totals.totalTiyn, sheets: draft.sheetQty },
  });
}

/**
 * Creates a walk-in order typed straight into the journal. It lands in WAITING_PAYMENT with the
 * price already published (the Manager priced it in the ledger, face to face) — recording payment
 * then advances it, and the payment gate in lib/orderStatus.ts still governs entry to the cutting
 * queue exactly as it does for orders submitted online.
 */
export async function createJournalOrder(
  db: Firestore,
  actor: Actor,
  draft: JournalDraft,
  material: Material | undefined,
): Promise<string> {
  const totals = computeJournalRowTotals({
    sheetQty: draft.sheetQty,
    sheetPriceTiyn: draft.sheetPriceTiyn,
    pvcMeters: draft.pvcMeters,
    pvcPricePerMeterTiyn: draft.pvcPricePerMeterTiyn,
    hdfCostTiyn: draft.hdfCostTiyn,
    cuttingCostTiyn: draft.cuttingCostTiyn,
    extraServicesTiyn: draft.extraServicesTiyn,
    deliveryCostTiyn: draft.deliveryCostTiyn,
    discountTiyn: draft.discountTiyn,
    paidTiyn: 0,
  });

  const orderRef = doc(collection(db, "orders"));
  const orderNumber = await generateOrderNumber(db);

  await setDoc(orderRef, {
    orderNumber,
    // No customerId: a walk-in has no account. computeCustomerDebts() keys these by phone so they
    // still roll up onto the right customer card.
    customerName: draft.customerName.trim() || "Клиент",
    customerPhone: draft.customerPhone.trim(),
    materialId: draft.materialId,
    materialSnapshot: snapshotFor(material, draft),
    productionStatus: "waiting_payment",
    paymentStatus: "unpaid",
    priority: 0,
    estimatedSheets: draft.sheetQty,
    confirmedSheets: draft.sheetQty,
    pvcMetersTotal: draft.pvcMeters,
    pvcPricePerMeterTiyn: draft.pvcPricePerMeterTiyn,
    materialCostTiyn: totals.materialCostTiyn,
    pvcCostTiyn: totals.pvcCostTiyn,
    hdfCostTiyn: draft.hdfCostTiyn,
    cuttingCostTiyn: draft.cuttingCostTiyn,
    extraServicesTiyn: draft.extraServicesTiyn,
    deliveryCostTiyn: draft.deliveryCostTiyn,
    discountTiyn: draft.discountTiyn,
    totalTiyn: totals.totalTiyn,
    paidTiyn: 0,
    debtTiyn: totals.totalTiyn,
    pricePublished: true,
    pricePublishedAt: serverTimestamp(),
    pricePublishedByUid: actor.user.uid,
    pricePublishedByName: actor.userData.name,
    assignedManagerId: actor.user.uid,
    assignedManagerName: actor.userData.name,
    isDraft: false,
    createdAt: Timestamp.fromDate(draft.orderDate),
    submittedAt: serverTimestamp(),
  });

  await logAudit(db, actor, {
    action: "order.journal_create",
    entityType: "order",
    entityId: orderRef.id,
    after: { orderNumber, totalTiyn: totals.totalTiyn, customerName: draft.customerName },
  });

  return orderRef.id;
}
