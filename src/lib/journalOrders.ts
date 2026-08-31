import { collection, doc, serverTimestamp, setDoc, Timestamp, updateDoc, type Firestore } from "firebase/firestore";
import type { User } from "firebase/auth";
import { computeJournalRowTotals } from "./journal";
import { linesOf } from "./orderMerge";
import { generateOrderNumber } from "./orderNumber";
import { logAudit } from "./audit";
import type { Material, Order, OrderMaterialLine, PvcType, PvcUsage, UserDoc } from "../types/domain";

type Actor = { user: User; userData: UserDoc };

/**
 * One material line of a journal row, as the cells edit it.
 *
 * `materialName` is carried alongside `materialId` so a merged line still names itself in the
 * ledger when its material has since been deleted from the catalogue.
 */
export interface JournalDraftLine {
  materialId: string;
  materialName: string;
  sheetQty: number;
  sheetPriceTiyn: number;
  pvcMeters: number;
  pvcPricePerMeterTiyn: number;
  /** Which edge-banding colour these metres came off, so the roll can be counted down by colour. */
  pvcTypeId: string;
  pvcColorName: string;
}

/**
 * The editable subset of an order that the journal's inline cells own.
 *
 * Always at least one line. A merged order is simply a draft with several — which is what makes
 * its sheets, prices and metres editable in the ledger instead of being a read-only "2 материал"
 * badge whose cells silently repriced the whole order at the first line's rate.
 */
export interface JournalDraft {
  customerName: string;
  customerPhone: string;
  lines: JournalDraftLine[];
  hdfCostTiyn: number;
  cuttingCostTiyn: number;
  extraServicesTiyn: number;
  deliveryCostTiyn: number;
  discountTiyn: number;
  orderDate: Date;
}

/**
 * A blank line: every number starts at zero, which the ledger's cells render as an empty box.
 *
 * The sheet count used to start at 1 — a guess at the common case that cost more than it saved,
 * because the cell then sat there with a figure nobody typed and the manager had to clear it
 * before entering the real one. A new row now shows nothing until something is written in it.
 */
export function emptyJournalLine(): JournalDraftLine {
  return {
    materialId: "",
    materialName: "",
    sheetQty: 0,
    sheetPriceTiyn: 0,
    pvcMeters: 0,
    pvcPricePerMeterTiyn: 0,
    pvcTypeId: "",
    pvcColorName: "",
  };
}

/**
 * Has anything been typed into a new-order row yet?
 *
 * Guards the two ways a half-written row can be thrown away — the ✕ button and Escape — so that
 * only a row with nothing in it disappears without a word. `orderDate` is excluded: it is filled
 * in for you and carries no typing worth protecting.
 */
export function draftHasContent(draft: JournalDraft): boolean {
  const empty = emptyJournalDraft();
  const blank = emptyJournalLine();
  const lineTouched = (line: JournalDraftLine) =>
    line.materialId !== "" ||
    line.sheetQty !== blank.sheetQty ||
    line.sheetPriceTiyn !== blank.sheetPriceTiyn ||
    line.pvcMeters !== blank.pvcMeters ||
    line.pvcPricePerMeterTiyn !== blank.pvcPricePerMeterTiyn ||
    line.pvcTypeId !== blank.pvcTypeId;

  return (
    draft.customerName.trim() !== "" ||
    draft.customerPhone.trim() !== "" ||
    draft.lines.length > 1 ||
    draft.lines.some(lineTouched) ||
    draft.hdfCostTiyn !== empty.hdfCostTiyn ||
    draft.cuttingCostTiyn !== empty.cuttingCostTiyn ||
    draft.extraServicesTiyn !== empty.extraServicesTiyn ||
    draft.deliveryCostTiyn !== empty.deliveryCostTiyn ||
    draft.discountTiyn !== empty.discountTiyn
  );
}

export function emptyJournalDraft(): JournalDraft {
  return {
    customerName: "",
    customerPhone: "",
    lines: [emptyJournalLine()],
    hdfCostTiyn: 0,
    cuttingCostTiyn: 0,
    extraServicesTiyn: 0,
    deliveryCostTiyn: 0,
    discountTiyn: 0,
    orderDate: new Date(),
  };
}

/** Reads an existing order back into the journal's editable shape, one entry per material line. */
export function draftFromOrder(order: Order): JournalDraft {
  // The AGREED quantity, not the one the cutter counted.
  //
  // These two numbers are allowed to differ — 6 sheets were sold, 5 came off the saw — and each
  // has its own job. `lineJobs[].confirmedSheets` (and the order-level mirror of it) is what the
  // warehouse and the salary engine settle against; `items[].sheetQty` is what the customer was
  // billed for. Reading the cutter's count back into the ledger made a paid, untouched row read
  // as "Артық төленді" the moment the cut came in short, and the next keystroke on that row would
  // have repriced the order without anyone deciding to. Billing the smaller count is a decision,
  // so it is made by typing it into the journal (see saveJournalRow).
  const lines = linesOf(order).map((line, index) => ({
    materialId: line.materialId ?? "",
    materialName: line.materialName ?? "",
    sheetQty: line.sheetQty ?? 0,
    sheetPriceTiyn: line.sheetPriceTiyn ?? 0,
    pvcMeters: line.pvcMeters ?? 0,
    // Older single-material orders (built through OrderBuilder from per-part PVC edges) have no
    // blended rate stored — derive it back out of the cost/metres they do have so the cell isn't
    // blank. Only the first line can be that order: a merged one always carries its own rates.
    pvcPricePerMeterTiyn:
      line.pvcPricePerMeterTiyn ||
      (index === 0 && order.pvcMetersTotal > 0 ? Math.round(order.pvcCostTiyn / order.pvcMetersTotal) : 0),
    pvcTypeId: line.pvcTypeId ?? "",
    pvcColorName: line.pvcColorName ?? "",
  }));

  return {
    customerName: order.customerName,
    customerPhone: order.customerPhone,
    lines: lines.length > 0 ? lines : [emptyJournalLine()],
    hdfCostTiyn: order.hdfCostTiyn ?? 0,
    cuttingCostTiyn: order.cuttingCostTiyn ?? 0,
    extraServicesTiyn: order.extraServicesTiyn ?? 0,
    deliveryCostTiyn: order.deliveryCostTiyn ?? 0,
    discountTiyn: order.discountTiyn ?? 0,
    orderDate: order.createdAt ? order.createdAt.toDate() : new Date(),
  };
}

/** The draft's lines in the shape an order stores them (`Order.items`). */
export function itemsFromDraft(draft: JournalDraft, materials: Map<string, Material>): OrderMaterialLine[] {
  return draft.lines.map((line) => ({
    materialId: line.materialId,
    materialName: materials.get(line.materialId)?.name || line.materialName || "",
    sheetQty: line.sheetQty,
    sheetPriceTiyn: line.sheetPriceTiyn,
    pvcMeters: line.pvcMeters,
    pvcPricePerMeterTiyn: line.pvcPricePerMeterTiyn,
    pvcTypeId: line.pvcTypeId,
    pvcColorName: line.pvcColorName,
  }));
}

/**
 * The order-level ПВХ breakdown, one entry per colour, summed across the row's material lines.
 *
 * This is the field the rest of the app already reads to answer "қай өңнен қанша метр кетті"
 * (lib/pvcUsage.ts) and to draw the roll down when the edging job is finished (lib/pvcStock.ts's
 * pvcConsumption). Until the journal asked for a colour, only orders built through the customer's
 * OrderBuilder had it — so the shop's own walk-in rows, which are most of its work, showed up as
 * "Түрі көрсетілмеген" and never touched the ПВХ stock. Writing it here is what makes both real.
 *
 * A line with metres but no colour picked contributes nothing rather than being folded into
 * whichever colour happened to be first: guessing which roll it came off would corrupt the stock
 * figures, and the report already has an honest place to put those metres.
 */
export function pvcByTypeFromDraft(draft: JournalDraft, pvcTypes: Map<string, PvcType>): PvcUsage[] {
  const byType = new Map<string, PvcUsage>();
  for (const line of draft.lines) {
    if (!line.pvcTypeId || !(line.pvcMeters > 0)) continue;
    const type = pvcTypes.get(line.pvcTypeId);
    const costTiyn = Math.round(line.pvcMeters * line.pvcPricePerMeterTiyn);
    const existing = byType.get(line.pvcTypeId);
    if (existing) {
      existing.meters += line.pvcMeters;
      existing.costTiyn += costTiyn;
    } else {
      byType.set(line.pvcTypeId, {
        pvcTypeId: line.pvcTypeId,
        colorName: type?.colorName || line.pvcColorName || "",
        thicknessMm: type?.thicknessMm ?? 0,
        meters: line.pvcMeters,
        costTiyn,
      });
    }
  }
  return [...byType.values()];
}

/** The row-level money input the totals are computed from — the same object the preview uses. */
export function totalsInputFor(draft: JournalDraft, paidTiyn: number) {
  return {
    lines: draft.lines,
    hdfCostTiyn: draft.hdfCostTiyn,
    cuttingCostTiyn: draft.cuttingCostTiyn,
    extraServicesTiyn: draft.extraServicesTiyn,
    deliveryCostTiyn: draft.deliveryCostTiyn,
    discountTiyn: draft.discountTiyn,
    paidTiyn,
  };
}

/**
 * The two catalogues a journal write reads: sheet materials and edge-banding colours.
 *
 * Passed as maps rather than looked up here because the page already has both loaded live, and a
 * write that re-fetched them would be a round trip on every keystroke's autosave.
 */
export interface JournalCatalog {
  materials: Map<string, Material>;
  pvcTypes: Map<string, PvcType>;
}

/**
 * The order-level `materialSnapshot`, taken from the row's FIRST line.
 *
 * Every screen outside the journal still reads this one field to name an order's material, so a
 * merged row has to keep answering with something real. `describeLines(items)` is what shows the
 * rest; the snapshot names the line the order leads with, at the price that line is billed at.
 */
function snapshotFor(material: Material | undefined, line: JournalDraftLine): Order["materialSnapshot"] {
  return {
    name: material?.name || line.materialName || "—",
    article: material?.article ?? "",
    color: material?.color ?? "",
    thicknessMm: material?.thicknessMm ?? 0,
    sheetLengthMm: material?.sheetLengthMm ?? 0,
    sheetWidthMm: material?.sheetWidthMm ?? 0,
    // The journal's "Лист бағасы" cell overrides the catalog price for this order — a walk-in
    // deal can be struck at a different rate, and the snapshot is what the order is billed at.
    sellingPriceTiyn: line.sheetPriceTiyn,
  };
}

/**
 * The aggregate fields an order carries whatever its line count: totals every other screen, the
 * warehouse and the cutting queue read without knowing about `items`.
 */
function aggregatesFor(draft: JournalDraft, catalog: JournalCatalog) {
  const first = draft.lines[0] ?? emptyJournalLine();
  const sheets = draft.lines.reduce((s, l) => s + l.sheetQty, 0);
  const pvcMeters = draft.lines.reduce((s, l) => s + l.pvcMeters, 0);
  return {
    items: itemsFromDraft(draft, catalog.materials),
    // Per colour, for the ПВХ report and for drawing the roll down when the edging is done.
    pvcByType: pvcByTypeFromDraft(draft, catalog.pvcTypes),
    materialId: first.materialId,
    materialSnapshot: snapshotFor(catalog.materials.get(first.materialId), first),
    /** What was agreed and billed. `confirmedSheets` is the cutter's count and is set separately. */
    estimatedSheets: sheets,
    pvcMetersTotal: pvcMeters,
    pvcPricePerMeterTiyn: first.pvcPricePerMeterTiyn,
    hdfCostTiyn: draft.hdfCostTiyn,
    cuttingCostTiyn: draft.cuttingCostTiyn,
    extraServicesTiyn: draft.extraServicesTiyn,
    deliveryCostTiyn: draft.deliveryCostTiyn,
    discountTiyn: draft.discountTiyn,
  };
}

/**
 * Persists inline journal edits to an existing order, recomputing every derived money field from
 * the same pure function the row preview uses. `paidTiyn` is never written here — it only ever
 * changes through lib/payments.ts's transactional recordPayment/reversePayment.
 *
 * `createdAt` is written too: the Күні cell is editable, because a ledger row is dated the day the
 * work was agreed, and a row typed up the next morning has to be movable back to it.
 *
 * `confirmedSheets` is written only while the order is still upstream of the saw. Once a cut is
 * finished that field is the cutter's count — what the warehouse settled against and what the
 * salary engine pays on — and a Manager fixing a customer's name must not quietly restore the
 * planned figure over it. Editing the sheet quantity here still changes what is billed (`items`
 * and every money field below); it just no longer claims to change what was cut.
 */
export async function saveJournalRow(
  db: Firestore,
  actor: Actor,
  order: Order,
  draft: JournalDraft,
  catalog: JournalCatalog,
): Promise<void> {
  const totals = computeJournalRowTotals(totalsInputFor(draft, order.paidTiyn));
  const alreadyCut =
    !!order.cuttingCompletedAt || (order.lineJobs ?? []).some((job) => job.confirmedSheets !== undefined);

  await updateDoc(doc(db, "orders", order.id), {
    customerName: draft.customerName.trim(),
    customerPhone: draft.customerPhone.trim(),
    ...aggregatesFor(draft, catalog),
    ...(alreadyCut ? {} : { confirmedSheets: draft.lines.reduce((s, l) => s + l.sheetQty, 0) }),
    materialCostTiyn: totals.materialCostTiyn,
    pvcCostTiyn: totals.pvcCostTiyn,
    totalTiyn: totals.totalTiyn,
    debtTiyn: totals.debtTiyn,
    paymentStatus: totals.paymentStatus,
    createdAt: Timestamp.fromDate(draft.orderDate),
    updatedAt: serverTimestamp(),
  });

  await logAudit(db, actor, {
    action: "order.journal_edit",
    entityType: "order",
    entityId: order.id,
    before: { totalTiyn: order.totalTiyn, sheets: order.confirmedSheets ?? order.estimatedSheets },
    after: { totalTiyn: totals.totalTiyn, sheets: draft.lines.reduce((s, l) => s + l.sheetQty, 0) },
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
  catalog: JournalCatalog,
): Promise<string> {
  const totals = computeJournalRowTotals(totalsInputFor(draft, 0));
  const aggregates = aggregatesFor(draft, catalog);

  const orderRef = doc(collection(db, "orders"));
  const orderNumber = await generateOrderNumber(db);

  await setDoc(orderRef, {
    orderNumber,
    // No customerId: a walk-in has no account. computeCustomerDebts() keys these by phone so they
    // still roll up onto the right customer card.
    customerName: draft.customerName.trim() || "Клиент",
    customerPhone: draft.customerPhone.trim(),
    ...aggregates,
    productionStatus: "waiting_payment",
    paymentStatus: "unpaid",
    priority: 0,
    // Nothing has been cut yet, so the agreed count is also the confirmed one — the cutter
    // replaces it with the real figure when the job comes off the saw.
    confirmedSheets: aggregates.estimatedSheets,
    materialCostTiyn: totals.materialCostTiyn,
    pvcCostTiyn: totals.pvcCostTiyn,
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
