import type { Expense, Order, Payment, PaymentMethodDef } from "../types/domain";
import { accountForExpense, accountForMethod } from "./cashbox";
import { dayKey } from "./dates";
import { paymentNote } from "./payments";

/**
 * «Қолма-қол» — the cash book behind one line's drawer: every tenge of cash that came in on an
 * order, and every expense paid out of the drawer, newest first.
 *
 * Nothing is stored for it: an entry is a payment whose method lands in the cash pot (the same
 * accountForMethod the Касса reads) or an expense paid «Қайдан: Қолма-қол». So the book can never
 * disagree with the Касса's own Қолма-қол card — it is that card's figures, one line each.
 */
export interface CashBookEntry {
  kind: "in" | "out";
  id: string;
  /** "YYYY-MM-DD" in Asia/Almaty. */
  day: string;
  /** For ordering inside a day — a payment's own time; an expense, which has only a day, sorts last. */
  atMs: number;
  amountTiyn: number;
  /** «№558 · Мейрам» for a payment, the expense's own name for an expense. */
  title: string;
  /** What a person wrote on it — «Ербақытқа берілді» — never one of the app's own tags. */
  note: string;
  byName: string;
  orderId?: string;
}

export interface CashBookDay {
  day: string;
  inTiyn: number;
  outTiyn: number;
  entries: CashBookEntry[];
}

/** "ORD-2026-000558" → "558". */
function shortNumber(orderNumber: string): string {
  return orderNumber.match(/(\d+)$/)?.[1]?.replace(/^0+/, "") ?? orderNumber;
}

/**
 * The entries of one line's book. The caller passes that line's own orders and expenses (see
 * lib/rbac.ts departmentOfOrder): a payment on an order not in `orders` is the other line's money
 * and is left out, never guessed at.
 */
export function cashBookEntries({
  payments,
  expenses,
  orders,
  methods,
}: {
  payments: readonly Payment[];
  expenses: readonly Expense[];
  orders: readonly Order[];
  methods: readonly PaymentMethodDef[];
}): CashBookEntry[] {
  const orderById = new Map(orders.map((o) => [o.id, o]));
  const methodById = new Map(methods.map((m) => [m.id, m]));
  const entries: CashBookEntry[] = [];

  for (const p of payments) {
    if (p.reversed) continue;
    const order = orderById.get(p.orderId);
    if (!order) continue;
    // An unknown method is read the way the Касса reads it: a transfer, so never cash.
    if (accountForMethod(methodById.get(p.methodId) ?? { id: p.methodId }) !== "cash") continue;
    const when = p.paymentDate ?? p.createdAt;
    if (!when) continue; // a write still pending on the server — it shows once it lands
    entries.push({
      kind: "in",
      id: p.id,
      day: dayKey(when),
      atMs: when.seconds * 1000,
      amountTiyn: p.amountTiyn,
      title: `№${shortNumber(order.orderNumber)} · ${order.customerName}`,
      note: paymentNote(p) ?? "",
      byName: p.recordedByName,
      orderId: order.id,
    });
  }

  for (const e of expenses) {
    if (accountForExpense(e) !== "cash") continue;
    entries.push({
      kind: "out",
      id: e.id,
      day: e.date,
      atMs: 0,
      amountTiyn: e.amountTiyn,
      title: e.paidToName ? `${e.name} · ${e.paidToName}` : e.name,
      note: e.comment?.trim() ?? "",
      byName: e.createdByName,
    });
  }

  return entries.sort((a, b) => (a.day !== b.day ? b.day.localeCompare(a.day) : b.atMs - a.atMs));
}

/** The book folded into days, newest first, each with what came in and what went out that day. */
export function cashBookDays(entries: readonly CashBookEntry[]): CashBookDay[] {
  const days: CashBookDay[] = [];
  for (const entry of entries) {
    let current = days[days.length - 1];
    if (!current || current.day !== entry.day) {
      current = { day: entry.day, inTiyn: 0, outTiyn: 0, entries: [] };
      days.push(current);
    }
    current.entries.push(entry);
    if (entry.kind === "in") current.inTiyn += entry.amountTiyn;
    else current.outTiyn += entry.amountTiyn;
  }
  return days;
}
