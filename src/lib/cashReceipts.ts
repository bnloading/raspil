import type { CashReceipt, Order, Payment, PaymentMethodDef } from "../types/domain";
import { accountForMethod } from "./cashbox";
import { dayKey } from "./dates";
import { normalizePhone } from "./phone";
import { paymentNote } from "./payments";

/**
 * «Нал ақша алдым» against the journal.
 *
 * The counter writes cash into the journal when the customer pays — «Нал, Ерболға берілді». Ербол
 * writes on his phone what he actually took in hand and from whom. The two are matched by the
 * customer: the same name (or the same phone, when both have one) and the same money, so each of
 * his entries reads as either «журналмен сәйкес» or as something to ask about.
 *
 * Nothing here moves money. The cash was counted on Касса when the journal took it; an entry only
 * says which of that cash reached him.
 */

/** One cash payment from the journal, as the check reads it. */
export interface JournalCash {
  paymentId: string;
  orderId: string;
  orderNumber: string;
  customerName: string;
  customerPhone: string;
  amountTiyn: number;
  /** "YYYY-MM-DD" in Asia/Almaty. */
  day: string;
  atMs: number;
  byName: string;
  note: string;
}

/**
 * ok — the journal has this customer's cash for exactly this sum (one payment, or several taken
 *      together); diff — it has their cash nearby, but for another sum; none — it has none;
 * obnal — cash from «обнал», which no journal row stands for: written down, never checked.
 */
export type ReceiptStatus = "ok" | "diff" | "none" | "obnal";

/** Cash from «обнал» — not a customer's payment, so not matched against the journal. */
export function isObnal(receipt: Pick<CashReceipt, "kind">): boolean {
  return receipt.kind === "obnal";
}

export interface ReceiptCheck {
  receipt: CashReceipt;
  status: ReceiptStatus;
  /** ok: the journal payments it came to. diff: the customer's journal cash nearby that no other
   *  entry took. none: empty. */
  payments: JournalCash[];
  /** Sum of `payments`. */
  journalTiyn: number;
}

export interface CashReceiptsCheck {
  /** Newest first, as the phone lists them. */
  checks: ReceiptCheck[];
  /** Journal cash from the first entry's day on that no entry accounts for — still at the counter,
   *  or taken without being written down. Newest first. */
  unclaimed: JournalCash[];
}

/**
 * How far back an entry looks for the journal's cash. Cash is usually handed over the same day or
 * within the week; a month covers a late hand-over without reaching an old payment of the same sum.
 */
export const LOOKBACK_DAYS = 31;
/** The journal row is sometimes written the morning after the cash was handed over. */
const LOOKAHEAD_DAYS = 1;
/** Above this many candidate payments the "taken together" search stops (2^n subsets). */
const MAX_SUBSET = 12;

const FOLD: Record<string, string> = {
  ә: "а", ғ: "г", қ: "к", ң: "н", ө: "о", ұ: "у", ү: "у", һ: "х", і: "и", ё: "е",
};

/**
 * A name as the check compares it: case, spacing and punctuation ignored, and the Kazakh letters
 * folded onto their Russian look-alikes — the journal has «Нұрик» and «Нурик» for one person, and
 * the phone keyboard picks whichever it likes.
 */
export function nameKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[әғқңөұүһіё]/g, (c) => FOLD[c] ?? c)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Same customer: the same phone when both have one, otherwise the same name. */
export function sameCustomer(
  a: { customerName: string; customerPhone?: string },
  b: { customerName: string; customerPhone?: string },
): boolean {
  const pa = normalizePhone(a.customerPhone ?? "");
  const pb = normalizePhone(b.customerPhone ?? "");
  if (pa && pb && pa === pb) return true;
  const na = nameKey(a.customerName);
  return na !== "" && na === nameKey(b.customerName);
}

/** "2026-11-06" → a day number, for "how many days apart". */
function dayNumber(day: string): number {
  return Math.round(Date.parse(`${day}T00:00:00Z`) / 86_400_000);
}

/**
 * The journal's cash: every live payment whose method lands in the cash pot (the same
 * accountForMethod Касса reads), on one of the orders passed in. The caller passes its own line's
 * orders (lib/rbac.ts departmentOfOrder), so the other line's cash is never matched.
 */
export function journalCash({
  payments,
  orders,
  methods,
}: {
  payments: readonly Payment[];
  orders: readonly Order[];
  methods: readonly PaymentMethodDef[];
}): JournalCash[] {
  const orderById = new Map(orders.map((o) => [o.id, o]));
  const methodById = new Map(methods.map((m) => [m.id, m]));
  const out: JournalCash[] = [];
  for (const p of payments) {
    if (p.reversed || p.amountTiyn <= 0) continue;
    const order = orderById.get(p.orderId);
    if (!order) continue;
    if (accountForMethod(methodById.get(p.methodId) ?? { id: p.methodId }) !== "cash") continue;
    const when = p.paymentDate ?? p.createdAt;
    if (!when) continue; // still pending on the server
    out.push({
      paymentId: p.id,
      orderId: order.id,
      orderNumber: order.orderNumber,
      customerName: order.customerName ?? "",
      customerPhone: order.customerPhone ?? "",
      amountTiyn: p.amountTiyn,
      day: dayKey(when),
      atMs: when.seconds * 1000,
      byName: p.recordedByName,
      note: paymentNote(p) ?? "",
    });
  }
  return out;
}

/** The journal's cash an entry may stand for: this customer's, not yet taken by another entry, near its day. */
export function nearbyCash(
  receipt: Pick<CashReceipt, "customerName" | "customerPhone" | "date">,
  cash: readonly JournalCash[],
  used: ReadonlySet<string> = new Set(),
): JournalCash[] {
  const d = dayNumber(receipt.date);
  return cash
    .filter((j) => {
      if (used.has(j.paymentId) || !sameCustomer(receipt, j)) return false;
      const jd = dayNumber(j.day);
      return jd >= d - LOOKBACK_DAYS && jd <= d + LOOKAHEAD_DAYS;
    })
    .sort((a, b) => b.atMs - a.atMs);
}

/**
 * The payments one entry came to: a single payment of exactly its sum (the nearest to its day), or
 * failing that the fewest payments that add up to it — the customer paid twice and Ербол took both
 * at once. Null when no such set exists.
 */
function pickPayments(near: readonly JournalCash[], amountTiyn: number, day: number): JournalCash[] | null {
  const distance = (j: JournalCash) => {
    const jd = dayNumber(j.day);
    // A payment written after the hand-over is the less likely one; it costs a little extra.
    return jd <= day ? day - jd : (jd - day) * 2 + 0.5;
  };
  const singles = near.filter((j) => j.amountTiyn === amountTiyn).sort((a, b) => distance(a) - distance(b));
  if (singles.length > 0) return [singles[0]];
  if (near.length < 2 || near.length > MAX_SUBSET) return null;
  let best: { set: JournalCash[]; cost: number } | null = null;
  for (let mask = 1; mask < 1 << near.length; mask++) {
    let sum = 0;
    const set: JournalCash[] = [];
    for (let i = 0; i < near.length; i++) if (mask & (1 << i)) { sum += near[i].amountTiyn; set.push(near[i]); }
    if (sum !== amountTiyn || set.length < 2) continue;
    const cost = set.length * 1000 + set.reduce((s, j) => s + distance(j), 0);
    if (!best || cost < best.cost) best = { set, cost };
  }
  return best?.set ?? null;
}

/**
 * Every entry against the journal. Entries are matched oldest first, and a payment matched once is
 * never matched again — two hand-overs of 50 000 ₸ need two payments of it in the journal.
 */
export function checkCashReceipts(receipts: readonly CashReceipt[], cash: readonly JournalCash[]): CashReceiptsCheck {
  const order = receipts.slice().sort(
    (a, b) => a.date.localeCompare(b.date) || (a.createdAt?.seconds ?? 0) - (b.createdAt?.seconds ?? 0),
  );
  const used = new Set<string>();
  const checks: ReceiptCheck[] = [];
  for (const receipt of order) {
    if (isObnal(receipt)) {
      // Never takes a journal payment — a customer who happens to share the name keeps theirs.
      checks.push({ receipt, status: "obnal", payments: [], journalTiyn: 0 });
      continue;
    }
    const near = nearbyCash(receipt, cash, used);
    const picked = pickPayments(near, receipt.amountTiyn, dayNumber(receipt.date));
    if (picked) {
      picked.forEach((j) => used.add(j.paymentId));
      checks.push({ receipt, status: "ok", payments: picked, journalTiyn: receipt.amountTiyn });
    } else {
      checks.push({
        receipt,
        status: near.length > 0 ? "diff" : "none",
        payments: near,
        journalTiyn: near.reduce((s, j) => s + j.amountTiyn, 0),
      });
    }
  }
  // Shown beside an entry that differs, so not listed a second time below.
  const beside = new Set(checks.filter((c) => c.status === "diff").flatMap((c) => c.payments.map((j) => j.paymentId)));
  const first = order[0]?.date;
  const unclaimed = first
    ? cash.filter((j) => j.day >= first && !used.has(j.paymentId) && !beside.has(j.paymentId)).sort((a, b) => b.atMs - a.atMs)
    : [];
  checks.sort((a, b) => b.receipt.date.localeCompare(a.receipt.date)
    || (b.receipt.createdAt?.seconds ?? 0) - (a.receipt.createdAt?.seconds ?? 0));
  return { checks, unclaimed };
}
