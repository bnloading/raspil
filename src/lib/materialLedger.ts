import type { InventoryMovement, Order, OrderLineJob } from "../types/domain";
import { dayKey } from "./dates";
import { customerOrderCode } from "./orderCode";
import { DEFAULT_RECEIPT_COMMENT } from "./stockReceipts";

/**
 * One material's «Тарих», as the owner reads it (06.11: «тарихтан көру керек, тарихта қай
 * клиенттікі қалай кесілді көрінсін»): not "Кесу кезінде есептен шығару −3 лист", but whose order
 * the sheets left for and what then happened to them — cut on the saw, by whom and when, still in
 * the queue, or handed over whole.
 */

export type LedgerKind = "receipt" | "cut" | "return" | "correction" | "other";

/** What became of sheets taken out for an order, read from that order's line for this material. */
export type CutState =
  /** Sold whole — «распилсіз берілді». */
  | { state: "without" }
  | { state: "done"; byName: string; atMs: number; sheets: number }
  | { state: "cutting"; byName: string }
  | { state: "queued" }
  | { state: "cancelled"; merged: boolean }
  /** The order is not in the list (a deleted test order, say). */
  | { state: "unknown" };

export interface LedgerEntry {
  id: string;
  kind: LedgerKind;
  /** «Қабылдау», «Кесуге алынды», … — for kinds that have no order to name. */
  label: string;
  qty: number;
  atMs: number;
  /** "YYYY-MM-DD" in Asia/Almaty. */
  day: string;
  userName: string;
  balanceBefore: number;
  balanceAfter: number;
  /** What was written on the movement, minus the lines this page already says another way. */
  note: string;
  order?: { id: string; code: string; customerName: string };
  /** Set on a cut: what became of the sheets. */
  cut?: CutState;
  /** «қоймада 2 лист жетіспеді» — the stock ran short when the order was queued. */
  shortBy?: number;
}

const LABELS: Record<string, string> = {
  initial: "Бастапқы қалдық",
  receipt: "Қабылданды",
  reservation: "Брондалды",
  reservation_release: "Бронь босатылды",
  cutting_consumption: "Кесуге алынды",
  return: "Қоймаға қайтарылды",
  manual_correction: "Қолмен түзетілді",
  write_off: "Есептен шығарылды",
  reversal: "Кері қайтарылды",
};

function kindOf(m: InventoryMovement): LedgerKind {
  if (m.type === "receipt") return "receipt";
  if (m.type === "cutting_consumption") return "cut";
  if (m.type === "return") return "return";
  if (m.type === "manual_correction" || m.type === "write_off" || m.type === "reversal" || m.type === "initial") return "correction";
  return "other";
}

/**
 * The order's lines for this material — its own line jobs, or for an order older than them the
 * order-level cut (the same fallback as scripts/cutter-pay.mjs jobsOf).
 */
function jobsFor(order: Order, materialId: string): Partial<OrderLineJob>[] {
  if (order.lineJobs?.length) return order.lineJobs.filter((j) => j.materialId === materialId);
  return [{
    materialId: order.materialId,
    sheetQty: order.confirmedSheets ?? order.estimatedSheets,
    cuttingStartedAt: order.cuttingStartedAt,
    cuttingCompletedAt: order.cuttingCompletedAt,
    cuttingByName: order.assignedCutterName,
    confirmedSheets: order.confirmedSheets,
  }];
}

/** What became of the sheets this cut movement took out for its order. */
export function cutStateOf(movement: InventoryMovement, order: Order | undefined): CutState {
  if (movement.withoutCutting) return { state: "without" };
  if (!order) return { state: "unknown" };
  const jobs = jobsFor(order, movement.materialId);
  const done = jobs.filter((j) => j.cuttingCompletedAt);
  if (jobs.length > 0 && done.length === jobs.length) {
    return {
      state: "done",
      byName: [...new Set(done.map((j) => j.cuttingByName).filter(Boolean))].join(", "),
      atMs: Math.max(...done.map((j) => j.cuttingCompletedAt!.seconds * 1000)),
      sheets: done.reduce((s, j) => s + (j.confirmedSheets ?? j.sheetQty ?? 0), 0),
    };
  }
  // Struck off before the saw got to it: the sheets went back (a «Қоймаға қайтарылды» entry).
  if (order.productionStatus === "cancelled" || order.mergedIntoOrderId) {
    return { state: "cancelled", merged: !!order.mergedIntoOrderId && order.productionStatus !== "cancelled" };
  }
  const started = jobs.find((j) => j.cuttingStartedAt);
  if (started) return { state: "cutting", byName: started.cuttingByName ?? "" };
  return { state: "queued" };
}

/** «ORD-2026-000709 распил кезегіне қосылды — қоймада 2 лист жетіспеді» → 2. */
function shortage(comment: string): number | undefined {
  const m = comment.match(/қоймада (\d+) лист жетіспеді/);
  return m ? Number(m[1]) : undefined;
}

/**
 * The note worth showing: what someone typed («артық қосылған», «Эггер, накладная №512», «ХДФ:
 * расталған саны 17 → 16»), not the lines the app writes for itself and the entry already says.
 */
function noteOf(m: InventoryMovement): string {
  const c = (m.comment ?? "").trim();
  if (!c || c === DEFAULT_RECEIPT_COMMENT) return "";
  if (/^(ORD|WEB|QA)-[\w-]+ (распил кезегіне қосылды|распилсіз берілді)/.test(c)) return "";
  if (/кесу кезінде есептен шығарылды$/i.test(c)) return "";
  if (/^(ORD|WEB)-[\w-]+ бас тартылды — қоймаға қайтарылды$/.test(c)) return "Заказ өшірілді";
  return c;
}

/** Every movement of one material as the «Тарих» list reads it, newest first. */
export function materialLedger(movements: readonly InventoryMovement[], orders: readonly Order[]): LedgerEntry[] {
  const byId = new Map(orders.map((o) => [o.id, o]));
  const out: LedgerEntry[] = [];
  for (const m of movements) {
    if (!m.createdAt) continue; // still pending on the server
    const kind = kindOf(m);
    const order = m.orderId ? byId.get(m.orderId) : undefined;
    out.push({
      id: m.id,
      kind,
      label: m.withoutCutting ? "Распилсіз берілді" : LABELS[m.type] ?? m.type,
      qty: m.qty,
      atMs: m.createdAt.seconds * 1000,
      day: dayKey(m.createdAt),
      userName: m.userName,
      balanceBefore: m.balanceBefore,
      balanceAfter: m.balanceAfter,
      note: noteOf(m),
      ...(order ? { order: { id: order.id, code: customerOrderCode(order.orderNumber), customerName: order.customerName ?? "" } } : {}),
      ...(kind === "cut" ? { cut: cutStateOf(m, order) } : {}),
      ...(shortage(m.comment ?? "") ? { shortBy: shortage(m.comment ?? "") } : {}),
    });
  }
  return out.sort((a, b) => b.atMs - a.atMs);
}

/** Sheets in and out over a list — what «Тарих» sums above itself. */
export function ledgerTotals(entries: readonly LedgerEntry[]): { received: number; cut: number } {
  return {
    received: entries.filter((e) => e.kind === "receipt").reduce((s, e) => s + e.qty, 0),
    cut: entries.filter((e) => e.kind === "cut").reduce((s, e) => s - e.qty, 0),
  };
}
