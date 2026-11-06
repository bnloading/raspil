import type { InventoryMovement, Material } from "../types/domain";
import { dayKey, inRange, startOfMonthAlmaty, startOfWeekAlmaty } from "./dates";

/** What «+ Қабылдау» writes when nothing is said about the delivery — every receipt before 06.11. */
export const DEFAULT_RECEIPT_COMMENT = "Жеткізушіден қабылданды";

/** One delivery taken onto the rack, as the Қойма page lists it. */
export interface StockReceipt {
  id: string;
  materialId: string;
  materialName: string;
  qty: number;
  userName: string;
  atMs: number;
  /** "YYYY-MM-DD" in Asia/Almaty. */
  day: string;
  balanceBefore: number;
  balanceAfter: number;
  /** What was written about it — who brought it, the delivery note — or "" for the default. */
  note: string;
}

export interface StockReceiptDay {
  day: string;
  qty: number;
  receipts: StockReceipt[];
}

/**
 * Every «+ Қабылдау» on this line's materials, newest first (the owner, 06.11: «Қойма қабылдау
 * дегендегі қанша лист қалай қабылданды дегенді шығар»). `materials` is the page's own list — the
 * МДФ Қойма passes only «МДФ бізден» — so the other line's deliveries never show. A receipt still
 * pending on the server (no createdAt yet) is left out until it lands.
 */
export function stockReceipts(movements: readonly InventoryMovement[], materials: readonly Material[]): StockReceipt[] {
  const names = new Map(materials.map((m) => [m.id, m.name]));
  const out: StockReceipt[] = [];
  for (const m of movements) {
    if (m.type !== "receipt" || !names.has(m.materialId) || !m.createdAt) continue;
    const note = (m.comment ?? "").trim();
    out.push({
      id: m.id,
      materialId: m.materialId,
      materialName: names.get(m.materialId)!,
      qty: m.qty,
      userName: m.userName,
      atMs: m.createdAt.seconds * 1000,
      day: dayKey(m.createdAt),
      balanceBefore: m.balanceBefore,
      balanceAfter: m.balanceAfter,
      note: note === DEFAULT_RECEIPT_COMMENT ? "" : note,
    });
  }
  return out.sort((a, b) => b.atMs - a.atMs);
}

/** The receipts by Almaty calendar day, newest day first, each with its sheets added up. */
export function receiptsByDay(receipts: readonly StockReceipt[]): StockReceiptDay[] {
  const days = new Map<string, StockReceiptDay>();
  for (const r of receipts) {
    const d = days.get(r.day) ?? { day: r.day, qty: 0, receipts: [] };
    d.qty += r.qty;
    d.receipts.push(r);
    days.set(r.day, d);
  }
  return [...days.values()].sort((a, b) => b.day.localeCompare(a.day));
}

/** Sheets received this week (from Monday) and this month, on the Almaty calendar. */
export function sheetsReceivedByPeriod(receipts: readonly StockReceipt[], now: Date = new Date()): { week: number; month: number } {
  const weekStart = startOfWeekAlmaty(now);
  const monthStart = startOfMonthAlmaty(now);
  return {
    week: receipts.filter((r) => inRange(r.atMs, weekStart)).reduce((s, r) => s + r.qty, 0),
    month: receipts.filter((r) => inRange(r.atMs, monthStart)).reduce((s, r) => s + r.qty, 0),
  };
}
