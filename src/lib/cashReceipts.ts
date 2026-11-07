import type { CashReceipt, Department, Expense, Order, Payment, PaymentMethodDef } from "../types/domain";
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
 * Обнал is the other way cash reaches him: Нұр sends a transfer from his account and the one who
 * took it hands over cash. No customer paid that, so the journal has nothing to say about it — it
 * is checked instead against the «Обнал» expense Нұр writes on Касса for the transfer (the owner,
 * 07.11), by the sum, the day and, when both name one, who handed it over.
 *
 * Nothing here moves money. The cash was counted on Касса when the journal took it, or when Касса
 * booked the transfer; an entry only says which of that cash reached him.
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

/** One «Обнал» expense on Касса — the transfer an обнал entry's cash came for. */
export interface KassaObnal {
  expenseId: string;
  /** As Нұр wrote it: «Акжол 100 000 · Обнал». */
  label: string;
  /** Who took the transfer, read out of the label — «Акжол»; empty when the label names no one. */
  who: string;
  amountTiyn: number;
  /** "YYYY-MM-DD", as Касса dates it. */
  day: string;
  byName: string;
}

/**
 * For a customer's cash, against the journal; for обнал, against Касса's «Обнал» expenses.
 * ok — the record has it for exactly this sum (for a customer, one payment or several taken
 *      together); diff — it has something nearby, but for another sum; none — it has nothing.
 */
export type ReceiptStatus = "ok" | "diff" | "none";

/** Cash from «обнал» — not a customer's payment: checked against Касса, never the journal. */
export function isObnal(receipt: Pick<CashReceipt, "kind">): boolean {
  return receipt.kind === "obnal";
}

export interface ReceiptCheck {
  receipt: CashReceipt;
  status: ReceiptStatus;
  /** A customer's entry. ok: the journal payments it came to. diff: the customer's journal cash
   *  nearby that no other entry took. none, or обнал: empty. */
  payments: JournalCash[];
  /** An обнал entry. ok: the Касса expense it came for. diff: the nearest one, of another sum.
   *  none, or a customer's: empty. */
  obnal: KassaObnal[];
  /** What the record says: the sum of `payments`, or of `obnal`. */
  recordTiyn: number;
}

export interface CashReceiptsCheck {
  /** Newest first, as the phone lists them. */
  checks: ReceiptCheck[];
  /** Journal cash from the first entry's day on that no entry accounts for — still at the counter,
   *  or taken without being written down. Newest first. */
  unclaimed: JournalCash[];
  /** Касса's «Обнал» from the first entry's day on that no обнал entry accounts for. Newest first. */
  unclaimedObnal: KassaObnal[];
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
/**
 * How far apart an обнал entry and its Касса expense may be dated, either way. The cash changes
 * hands when the transfer is made, but either of the two may be written down a few days late.
 */
export const OBNAL_DAYS = 7;

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

const OBNAL_WORD = /обнал|обнол|абнал/i;
/** Words in an «Обнал» label that are not a name: the word itself, how much, «здачамен 43320». */
const NOT_A_NAME = /(?<!\p{L})(?:обнал|обнол|абнал|миллион|млн|мың|тенге|тг|здачамен|сдачамен|сдача)\p{L}*/giu;

/** «40000 обнал Динко» → «Динко»; «Миллион обнал» → "". */
function whoIn(text: string): string {
  return text.replace(NOT_A_NAME, " ").replace(/[^\p{L}\s-]/gu, " ").replace(/\s+/g, " ").trim();
}

/**
 * Касса's «Обнал» expenses on this line — any expense whose name or note says обнал, the way Нұр
 * writes them: «Обнал», «Аман обнал», «Акжол 100 000» with «Обнал» in the note.
 */
export function kassaObnal(expenses: readonly Expense[], department: Department): KassaObnal[] {
  const out: KassaObnal[] = [];
  for (const e of expenses) {
    if ((e.department ?? "ldsp") !== department || e.amountTiyn <= 0) continue;
    const name = (e.name || "").trim();
    const comment = (e.comment || "").trim();
    if (!OBNAL_WORD.test(`${name} ${comment}`)) continue;
    out.push({
      expenseId: e.id,
      label: comment ? `${name} · ${comment}` : name,
      who: whoIn(name) || whoIn(comment),
      amountTiyn: e.amountTiyn,
      day: e.date,
      byName: e.createdByName,
    });
  }
  return out;
}

/** «Ақжол» and «Акжол Болат» are the same hand: one name holds the other, word for word. */
function sameWho(a: string, b: string): boolean {
  const ka = nameKey(a);
  const kb = nameKey(b);
  if (!ka || !kb) return false;
  return ka === kb || ` ${kb} `.includes(` ${ka} `) || ` ${ka} `.includes(` ${kb} `);
}

/**
 * Касса's обнал an entry may stand for: not yet taken by another entry, within OBNAL_DAYS of its day.
 * The ones naming the same hand come first, then the nearest.
 */
export function nearbyObnal(
  receipt: Pick<CashReceipt, "customerName" | "date">,
  obnal: readonly KassaObnal[],
  used: ReadonlySet<string> = new Set(),
): KassaObnal[] {
  const d = dayNumber(receipt.date);
  const rank = (k: KassaObnal) => (sameWho(receipt.customerName, k.who) ? 0 : 100) + Math.abs(dayNumber(k.day) - d);
  return obnal
    .filter((k) => !used.has(k.expenseId) && Math.abs(dayNumber(k.day) - d) <= OBNAL_DAYS)
    .sort((a, b) => rank(a) - rank(b) || b.day.localeCompare(a.day));
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
 * Every entry against its record: a customer's against the journal, обнал against Касса. Entries
 * are matched oldest first, and a payment or an expense matched once is never matched again — two
 * hand-overs of 50 000 ₸ need two payments of it in the journal.
 */
export function checkCashReceipts(
  receipts: readonly CashReceipt[],
  cash: readonly JournalCash[],
  obnal: readonly KassaObnal[] = [],
): CashReceiptsCheck {
  const order = receipts.slice().sort(
    (a, b) => a.date.localeCompare(b.date) || (a.createdAt?.seconds ?? 0) - (b.createdAt?.seconds ?? 0),
  );
  const used = new Set<string>();
  const usedObnal = new Set<string>();
  const checks: ReceiptCheck[] = [];
  for (const receipt of order) {
    if (isObnal(receipt)) {
      // Never takes a journal payment — a customer who happens to share the name keeps theirs.
      const near = nearbyObnal(receipt, obnal, usedObnal);
      const exact = near.find((k) => k.amountTiyn === receipt.amountTiyn);
      if (exact) {
        usedObnal.add(exact.expenseId);
        checks.push({ receipt, status: "ok", payments: [], obnal: [exact], recordTiyn: exact.amountTiyn });
        continue;
      }
      // Another sum is only worth showing when it is plainly the same обнал: the same hand, or
      // the day itself (or the next) — not any transfer of the week.
      const d = dayNumber(receipt.date);
      const close = near.find((k) => sameWho(receipt.customerName, k.who) || Math.abs(dayNumber(k.day) - d) <= 1);
      checks.push(close
        ? { receipt, status: "diff", payments: [], obnal: [close], recordTiyn: close.amountTiyn }
        : { receipt, status: "none", payments: [], obnal: [], recordTiyn: 0 });
      continue;
    }
    const near = nearbyCash(receipt, cash, used);
    const picked = pickPayments(near, receipt.amountTiyn, dayNumber(receipt.date));
    if (picked) {
      picked.forEach((j) => used.add(j.paymentId));
      checks.push({ receipt, status: "ok", payments: picked, obnal: [], recordTiyn: receipt.amountTiyn });
    } else {
      checks.push({
        receipt,
        status: near.length > 0 ? "diff" : "none",
        payments: near,
        obnal: [],
        recordTiyn: near.reduce((s, j) => s + j.amountTiyn, 0),
      });
    }
  }
  // Shown beside an entry that differs, so not listed a second time below.
  const beside = new Set(checks.filter((c) => c.status === "diff").flatMap((c) => c.payments.map((j) => j.paymentId)));
  const first = order[0]?.date;
  const unclaimed = first
    ? cash.filter((j) => j.day >= first && !used.has(j.paymentId) && !beside.has(j.paymentId)).sort((a, b) => b.atMs - a.atMs)
    : [];
  const besideObnal = new Set(checks.filter((c) => c.status === "diff").flatMap((c) => c.obnal.map((k) => k.expenseId)));
  const unclaimedObnal = first
    ? obnal.filter((k) => k.day >= first && !usedObnal.has(k.expenseId) && !besideObnal.has(k.expenseId))
      .sort((a, b) => b.day.localeCompare(a.day))
    : [];
  checks.sort((a, b) => b.receipt.date.localeCompare(a.receipt.date)
    || (b.receipt.createdAt?.seconds ?? 0) - (a.receipt.createdAt?.seconds ?? 0));
  return { checks, unclaimed, unclaimedObnal };
}
