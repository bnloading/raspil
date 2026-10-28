import { collection, doc, serverTimestamp, setDoc, Timestamp, updateDoc, type Firestore } from "firebase/firestore";
import type { User } from "firebase/auth";
import { computeMdfOrderTotal } from "./mdfJournal";
import { findCustomerIdByPhone } from "./customerLink";
import { generateOrderNumber } from "./orderNumber";
import { logAudit } from "./audit";
import { nextProductionStatusForPayment } from "./payments";
import { mdfStageFor } from "./mdfRoute";
import { syncWorkshopBoard } from "./workshopActivity";
import type { MdfFinish, Order, UserDoc } from "../types/domain";

type Actor = { user: User; userData: UserDoc };

/**
 * МДФ mirror of journalOrders.ts's JournalDraft/createJournalOrder/saveJournalRow, but without a
 * `lines[]` — a МДФ order is always a single area × price job (see mdfJournal.ts), so there is
 * nothing to merge and no per-line material catalogue lookup.
 */
export interface MdfJournalDraft {
  customerName: string;
  customerPhone: string;
  areaM2: number;
  /** «Узор» — a template's name (which filled pricePerM2Tiyn in) or one typed by hand. */
  patternName: string;
  /** Пленка or Краска — which stations the order passes (lib/mdfRoute.ts). */
  finish: MdfFinish;
  pricePerM2Tiyn: number;
  filmColor: string;
  extraServicesTiyn: number;
  deliveryCostTiyn: number;
  discountTiyn: number;
  orderDate: Date;
  /** Упаковка — never affects the customer's price, only the vacuum worker's pay (see
   *  lib/salary.ts's packagingOrdersCount). Set by the МДФ manager, not computed. */
  packaging: boolean;
}

export function emptyMdfJournalDraft(): MdfJournalDraft {
  return {
    customerName: "",
    customerPhone: "",
    areaM2: 0,
    patternName: "",
    finish: "film",
    pricePerM2Tiyn: 0,
    filmColor: "",
    extraServicesTiyn: 0,
    deliveryCostTiyn: 0,
    discountTiyn: 0,
    orderDate: new Date(),
    packaging: false,
  };
}

/** Has anything been typed into a new-order row yet? Mirrors journalOrders.ts's draftHasContent. */
export function mdfDraftHasContent(draft: MdfJournalDraft): boolean {
  return (
    draft.customerName.trim() !== "" ||
    draft.customerPhone.trim() !== "" ||
    draft.areaM2 !== 0 ||
    draft.patternName.trim() !== "" ||
    draft.pricePerM2Tiyn !== 0 ||
    draft.filmColor.trim() !== "" ||
    draft.extraServicesTiyn !== 0 ||
    draft.deliveryCostTiyn !== 0 ||
    draft.discountTiyn !== 0 ||
    draft.packaging
  );
}

/**
 * A total typed by hand over what the area comes to — the shop agrees a round figure — kept as the
 * ЛДСП row keeps one (journalOrders.ts totalOverrideFor): the difference from area × rate (plus
 * delivery) becomes a surcharge or a discount, so the area and the rate stay what they really were.
 */
export function mdfTotalOverride(
  draft: MdfJournalDraft,
  typedTiyn: number,
): Pick<MdfJournalDraft, "extraServicesTiyn" | "discountTiyn"> {
  const base = computeMdfOrderTotal({
    areaM2: draft.areaM2,
    pricePerM2Tiyn: draft.pricePerM2Tiyn,
    extraServicesTiyn: 0,
    deliveryCostTiyn: draft.deliveryCostTiyn,
    discountTiyn: 0,
    paidTiyn: 0,
  }).totalTiyn;
  const target = Math.max(0, Math.round(typedTiyn));
  return target >= base
    ? { extraServicesTiyn: target - base, discountTiyn: 0 }
    : { extraServicesTiyn: 0, discountTiyn: base - target };
}

/** The row's totals as the journal shows them — the same arithmetic saveMdfJournalRow stores. */
export function mdfDraftTotals(draft: MdfJournalDraft, paidTiyn: number) {
  return computeMdfOrderTotal(totalsInputFor(draft, paidTiyn));
}

/** Reads an existing МДФ order back into the journal's editable shape. */
export function draftFromMdfOrder(order: Order): MdfJournalDraft {
  return {
    customerName: order.customerName,
    customerPhone: order.customerPhone,
    areaM2: order.mdfAreaM2 ?? 0,
    patternName: order.mdfPatternName ?? "",
    finish: order.mdfFinish ?? "film",
    pricePerM2Tiyn: order.mdfPricePerM2Tiyn ?? 0,
    filmColor: order.mdfFilmColor ?? "",
    extraServicesTiyn: order.extraServicesTiyn ?? 0,
    deliveryCostTiyn: order.deliveryCostTiyn ?? 0,
    discountTiyn: order.discountTiyn ?? 0,
    orderDate: order.createdAt ? order.createdAt.toDate() : new Date(),
    packaging: order.mdfPackaging ?? false,
  };
}

function totalsInputFor(draft: MdfJournalDraft, paidTiyn: number) {
  return {
    areaM2: draft.areaM2,
    pricePerM2Tiyn: draft.pricePerM2Tiyn,
    extraServicesTiyn: draft.extraServicesTiyn,
    deliveryCostTiyn: draft.deliveryCostTiyn,
    discountTiyn: draft.discountTiyn,
    paidTiyn,
  };
}

/** An order's materialSnapshot has no catalogue meaning for a МДФ order (there's no sheet/colour
 *  lookup) but the field is required on every Order — every other screen that names an order's
 *  material degrades gracefully on this placeholder (zero sheets/metres reads as "—"). Exported so
 *  MdfOrderBuilder.tsx (customer self-service) writes the exact same placeholder. */
export const MDF_MATERIAL_SNAPSHOT: Order["materialSnapshot"] = {
  name: "МДФ",
  article: "",
  color: "",
  thicknessMm: 0,
  sheetLengthMm: 0,
  sheetWidthMm: 0,
  sellingPriceTiyn: 0,
};

/**
 * Persists inline journal edits to an existing МДФ order, recomputing every derived money field
 * from the same pure function the row preview uses. `paidTiyn` is never written here — same rule
 * as saveJournalRow, it only changes through lib/payments.ts.
 */
export async function saveMdfJournalRow(
  db: Firestore,
  actor: Actor,
  order: Order,
  draft: MdfJournalDraft,
): Promise<void> {
  const totals = computeMdfOrderTotal(totalsInputFor(draft, order.paidTiyn));
  const linkedId = order.customerId ? null : await findCustomerIdByPhone(db, draft.customerPhone);
  // A corrected total can settle an order or reopen its debt, and the stage before production
  // follows that exactly as a payment moves it — or «Өндіріске жіберу» never appears.
  const productionStatus = nextProductionStatusForPayment(order.productionStatus, totals.paymentStatus);
  // Пленка ↔ Краска changed on an order already on the floor: if the station it waits at is not on
  // its new route, it goes to the one it belongs at now — a film order taken off «Краска» to the
  // vacuum press, and back (lib/mdfRoute.ts). Every station of the new route already done: finished.
  let reroute: Partial<Order> | Record<string, unknown> = {};
  if (order.productionStatus === "mdf_production" && draft.finish !== (order.mdfFinish ?? "film")) {
    const belongsAt = mdfStageFor({ mdfFinish: draft.finish, mdfStageJobs: order.mdfStageJobs });
    if (!belongsAt) reroute = { productionStatus: "ready", readyAt: serverTimestamp() };
    else if (belongsAt !== order.mdfStage) reroute = { mdfStage: belongsAt };
  }

  await updateDoc(doc(db, "orders", order.id), {
    customerName: draft.customerName.trim(),
    customerPhone: draft.customerPhone.trim(),
    ...(linkedId ? { customerId: linkedId } : {}),
    mdfAreaM2: draft.areaM2,
    mdfPatternName: draft.patternName.trim(),
    mdfFinish: draft.finish,
    mdfPricePerM2Tiyn: draft.pricePerM2Tiyn,
    mdfFilmColor: draft.filmColor.trim(),
    mdfPackaging: draft.packaging,
    extraServicesTiyn: draft.extraServicesTiyn,
    deliveryCostTiyn: draft.deliveryCostTiyn,
    discountTiyn: draft.discountTiyn,
    totalTiyn: totals.totalTiyn,
    debtTiyn: totals.debtTiyn,
    paymentStatus: totals.paymentStatus,
    ...(productionStatus ? { productionStatus } : {}),
    ...reroute,
    createdAt: Timestamp.fromDate(draft.orderDate),
    updatedAt: serverTimestamp(),
  });
  if (Object.keys(reroute).length > 0) {
    await syncWorkshopBoard(db, { ...order, mdfFinish: draft.finish, ...(reroute as Partial<Order>) });
  }

  await logAudit(db, actor, {
    action: "order.mdf_journal_edit",
    entityType: "order",
    entityId: order.id,
    before: {
      totalTiyn: order.totalTiyn, mdfAreaM2: order.mdfAreaM2 ?? 0,
      mdfPatternName: order.mdfPatternName ?? "", mdfPricePerM2Tiyn: order.mdfPricePerM2Tiyn ?? 0,
    },
    after: {
      totalTiyn: totals.totalTiyn, mdfAreaM2: draft.areaM2,
      mdfPatternName: draft.patternName.trim(), mdfPricePerM2Tiyn: draft.pricePerM2Tiyn,
    },
  });
}

/**
 * Prices and publishes a customer-submitted МДФ order (MdfOrderBuilder.tsx) — the customer only
 * gives an area/colour estimate, so the Manager reviewing it in ManagerMdfJournal.tsx sets the
 * real м² rate here, same as ManagerJournal's price-calculation step for a ЛДСП order. Moves the
 * order to WAITING_PAYMENT so recordPayment/enterMdfProduction can take over from there.
 */
export async function publishMdfPrice(
  db: Firestore,
  actor: Actor,
  order: Order,
  input: { areaM2: number; pricePerM2Tiyn: number; filmColor: string; packaging: boolean },
): Promise<void> {
  const totals = computeMdfOrderTotal({
    areaM2: input.areaM2,
    pricePerM2Tiyn: input.pricePerM2Tiyn,
    extraServicesTiyn: order.extraServicesTiyn ?? 0,
    deliveryCostTiyn: order.deliveryCostTiyn ?? 0,
    discountTiyn: order.discountTiyn ?? 0,
    paidTiyn: order.paidTiyn,
  });

  await updateDoc(doc(db, "orders", order.id), {
    mdfAreaM2: input.areaM2,
    mdfPricePerM2Tiyn: input.pricePerM2Tiyn,
    mdfFilmColor: input.filmColor.trim(),
    mdfPackaging: input.packaging,
    totalTiyn: totals.totalTiyn,
    debtTiyn: totals.debtTiyn,
    paymentStatus: totals.paymentStatus,
    pricePublished: true,
    pricePublishedAt: serverTimestamp(),
    pricePublishedByUid: actor.user.uid,
    pricePublishedByName: actor.userData.name,
    productionStatus: "waiting_payment",
    assignedManagerId: actor.user.uid,
    assignedManagerName: actor.userData.name,
    updatedAt: serverTimestamp(),
  });

  await logAudit(db, actor, {
    action: "order.mdf_price_published",
    entityType: "order",
    entityId: order.id,
    after: { totalTiyn: totals.totalTiyn },
  });
}

/**
 * Creates a walk-in МДФ order typed straight into the journal — mirrors journalOrders.ts's
 * createJournalOrder. Lands in WAITING_PAYMENT with the price already published (the Manager
 * priced it face to face); recording payment then lets enterMdfProduction take over.
 */
export async function createMdfJournalOrder(db: Firestore, actor: Actor, draft: MdfJournalDraft): Promise<string> {
  const totals = computeMdfOrderTotal(totalsInputFor(draft, 0));
  const orderRef = doc(collection(db, "orders"));
  const orderNumber = await generateOrderNumber(db);
  const linkedId = await findCustomerIdByPhone(db, draft.customerPhone);

  await setDoc(orderRef, {
    orderNumber,
    orderKind: "mdf_wrap",
    ...(linkedId ? { customerId: linkedId } : {}),
    customerName: draft.customerName.trim() || "Клиент",
    customerPhone: draft.customerPhone.trim(),
    materialId: "",
    materialSnapshot: MDF_MATERIAL_SNAPSHOT,
    mdfAreaM2: draft.areaM2,
    mdfPatternName: draft.patternName.trim(),
    mdfFinish: draft.finish,
    mdfPricePerM2Tiyn: draft.pricePerM2Tiyn,
    mdfFilmColor: draft.filmColor.trim(),
    mdfPackaging: draft.packaging,
    productionStatus: "waiting_payment",
    paymentStatus: "unpaid",
    priority: 0,
    estimatedSheets: 0,
    pvcMetersTotal: 0,
    materialCostTiyn: 0,
    cuttingCostTiyn: 0,
    pvcCostTiyn: 0,
    hdfCostTiyn: 0,
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
    action: "order.mdf_journal_create",
    entityType: "order",
    entityId: orderRef.id,
    after: { orderNumber, totalTiyn: totals.totalTiyn, customerName: draft.customerName },
  });

  return orderRef.id;
}
