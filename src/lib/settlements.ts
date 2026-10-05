import { accountForMethod, isBeforeRestart, CASH_ACCOUNTS } from "./cashbox";
import { dayKey } from "./dates";
import type { CashAccount, Expense, Order, Payment, PaymentMethodDef, Settlement } from "../types/domain";

/**
 * «Расчет» — the owner settling the books for a run of orders (05.10).
 *
 * "№281-ден №300-ге дейін расчет істедім": the money that came in on those orders, less the
 * expenses since the last settlement, is what it comes to. The journal draws a line under №300,
 * and the expenses it took read "№281–№300 расчетта есептелді", so the next one does not take
 * them again. Касса carries on — a settlement closes a stretch of the books, it does not restart a
 * balance (the 30.09 restart did that once, and stays as it was).
 *
 * Nothing is marked record by record. A settlement keeps the last order it covers and the moment it
 * was made, and that pair says which settlement took any record:
 * - an expense belongs to the first settlement made after it was recorded;
 * - a payment belongs to the first settlement made after it was recorded that reaches its order —
 *   so money that comes in late for an order already settled goes to the next one, and money paid
 *   ahead for an order past the line waits for the settlement that reaches it.
 * "Recorded" is when the record was entered, not the day it is dated: an expense typed in after a
 * settlement but dated before it has still not been settled.
 *
 * Records change after they are settled — a «Төленді» figure retyped, a payment reversed by
 * «Қарыз», an expense deleted and typed again, an old order's payment brought into Касса, two rows
 * merged — and a settlement keeps the totals it came to. So each new settlement also carries the
 * difference between what the earlier ones stored and what their records add up to now
 * («түзету»). However the records move, the settlements together always come to what Касса counts.
 */

type Recorded = { createdAt?: { toMillis(): number } | null };
type LineOrder = Pick<Order, "id" | "orderNumber" | "createdAt" | "productionStatus" | "mergedIntoOrderId">;

/**
 * When a record was entered (server time, whole milliseconds — the web SDK has fractions, the admin
 * SDK does not). A write still being saved reads `null` until the server stamps it, and is newer
 * than any settlement; a record from before the field existed has none at all and is placed by `legacy`.
 */
function recordedMs(record: Recorded, legacy: () => number): number {
  if (record.createdAt === null) return Number.POSITIVE_INFINITY;
  return Math.floor(record.createdAt?.toMillis() ?? legacy());
}
const paymentRecordedMs = (p: Payment) => recordedMs(p, () => p.paymentDate?.toMillis() ?? Number.POSITIVE_INFINITY);
const expenseRecordedMs = (e: Expense) => recordedMs(e, () => Date.parse(`${e.date}T12:00:00+05:00`));

const noAccounts = () => Object.fromEntries(CASH_ACCOUNTS.map((a) => [a, 0])) as Record<CashAccount, number>;
const isLiveOrder = (o: LineOrder) => o.productionStatus !== "cancelled" && o.productionStatus !== "draft" && !o.mergedIntoOrderId;

/** A line's settlements, oldest first (made in that order; two made with nothing new between keep theirs). */
export function settlementsInOrder(settlements: readonly Settlement[] | undefined): Settlement[] {
  return [...(settlements ?? [])].sort((a, b) => a.atMs - b.atMs);
}

/**
 * The settlements made under the Касса restart in force. A restart (ApplicationSettings.cashStartDate
 * / cashStartOrderNumber) changes which money is the old books', so the settlements made before it
 * are history: carrying their records against the new books would read as a correction that never
 * happened, and the next settlement starts where the new books do.
 */
export function currentSettlements(
  settlements: readonly Settlement[] | undefined,
  startDate: string | null,
  startOrderNumber: string | null,
): Settlement[] {
  return settlementsInOrder(settlements).filter(
    (s) => (s.startDate ?? null) === startDate && (s.startOrderNumber ?? null) === startOrderNumber,
  );
}

/** "ORD-2026-000300" → "ORD-2026-000301". */
export function nextOrderNumber(orderNumber: string): string {
  const m = /^(.*?)(\d+)$/.exec(orderNumber);
  if (!m) return orderNumber;
  return `${m[1]}${String(Number(m[2]) + 1).padStart(m[2].length, "0")}`;
}

/** "ORD-2027-000004" + 20 → "ORD-2027-000020": a number typed on its own, in the year of the sample. */
export function orderNumberLike(sample: string, seq: number): string {
  const m = /^(.*?)(\d+)$/.exec(sample);
  return m ? `${m[1]}${String(seq).padStart(m[2].length, "0")}` : String(seq);
}

/**
 * The first order the next settlement covers: the first live order after the last settlement's —
 * which across New Year is ORD-2027-000001, not ORD-2026-000501 — or where the books start.
 */
export function nextSettlementStart(
  settlements: readonly Settlement[] | undefined,
  startOrderNumber: string | null,
  orders: readonly LineOrder[] = [],
): string | null {
  const last = settlementsInOrder(settlements).at(-1);
  if (!last) return startOrderNumber;
  const after = orders.filter((o) => isLiveOrder(o) && o.orderNumber > last.toOrderNumber).map((o) => o.orderNumber).sort();
  return after[0] ?? nextOrderNumber(last.toOrderNumber);
}

/** The settlement that took an expense, or null while it waits for the next one. */
export function settlementOfExpense(
  expense: Expense,
  settlements: readonly Settlement[] | undefined,
  startDate: string | null,
): Settlement | null {
  if (startDate && expense.date < startDate) return null; // the old books' — never this ledger's
  const at = expenseRecordedMs(expense);
  return settlementsInOrder(settlements).find((s) => at <= s.atMs) ?? null;
}

export interface SettlementInput {
  /** This line's payments, expenses and orders — the caller splits ЛДСП from МДФ, as Касса does. */
  payments: readonly Payment[];
  expenses: readonly Expense[];
  orders: readonly LineOrder[];
  methods: readonly PaymentMethodDef[];
  /** This line's settlements so far. */
  settlements: readonly Settlement[] | undefined;
  /** Касса's restart (ApplicationSettings.cashStartDate / cashStartOrderNumber): money it leaves out, a settlement does too. */
  startDate: string | null;
  startOrderNumber: string | null;
}

export interface SettlementPlan {
  fromOrderNumber: string;
  toOrderNumber: string;
  /** The Касса restart it is made under (see currentSettlements). */
  startDate: string | null;
  startOrderNumber: string | null;
  /** The moment it settles up to: the newest record on screen (server time, so a device clock cannot move it), never before the last settlement's. */
  atMs: number;
  payments: Payment[];
  expenses: Expense[];
  incomeTiyn: number;
  incomeByAccount: Record<CashAccount, number>;
  /** Of incomeTiyn: money on orders before fromOrderNumber that came in after they were settled. */
  lateIncomeTiyn: number;
  /** Money already in for orders after toOrderNumber — left for the settlement that reaches them. */
  deferredTiyn: number;
  expenseTiyn: number;
  /** What the earlier settlements' payments and expenses add up to now, less what they stored — see the module comment. */
  carriedIncomeTiyn: number;
  carriedByAccount: Record<CashAccount, number>;
  carriedExpenseTiyn: number;
  /** income + carried income − expenses − carried expenses. */
  resultTiyn: number;
}

/**
 * What a settlement up to `toOrderNumber` would take, made now.
 *
 * A payment counts only if Касса counts it — not reversed, dated from the restart, and not an old
 * order's unless an Admin brought it in (countsInCurrentBooks) — so a settlement never holds money
 * Касса does not. Rent and corrections are not order money and are left out.
 */
export function planSettlement(input: SettlementInput, toOrderNumber: string): SettlementPlan {
  const settled = currentSettlements(input.settlements, input.startDate, input.startOrderNumber);
  const last = settled.at(-1);
  const fromOrderNumber = nextSettlementStart(settled, input.startOrderNumber, input.orders) ?? toOrderNumber;
  const methodById = new Map(input.methods.map((m) => [m.id, m]));
  const orderById = new Map(input.orders.map((o) => [o.id, o]));

  const known = [
    ...input.payments.map(paymentRecordedMs),
    ...input.expenses.map(expenseRecordedMs),
  ].filter(Number.isFinite);
  const atMs = Math.max(last?.atMs ?? Number.NEGATIVE_INFINITY, known.length > 0 ? Math.max(...known) : Math.floor(Date.now()));

  const incomeByAccount = noAccounts();
  const claimedByAccount = noAccounts();
  const payments: Payment[] = [];
  let lateIncomeTiyn = 0;
  let deferredTiyn = 0;
  let claimedIncome = 0;
  for (const p of input.payments) {
    if (p.reversed || !p.paymentDate) continue;
    if (input.startDate && dayKey(p.paymentDate) < input.startDate) continue;
    const order = orderById.get(p.orderId);
    // Касса counts a payment whose order it cannot find, so a settlement does too: it is placed by
    // when it was recorded alone, as if on the earliest order.
    if (order && isBeforeRestart(order, input.startDate, input.startOrderNumber) && !p.countsInCurrentBooks) continue;
    const orderNumber = order?.orderNumber ?? "";
    const at = paymentRecordedMs(p);
    const account = accountForMethod(methodById.get(p.methodId) ?? { id: p.methodId });
    if (settled.some((s) => at <= s.atMs && orderNumber <= s.toOrderNumber)) {
      claimedIncome += p.amountTiyn;
      claimedByAccount[account] += p.amountTiyn;
      continue;
    }
    if (at > atMs) continue;
    if (orderNumber > toOrderNumber) {
      deferredTiyn += p.amountTiyn;
      continue;
    }
    payments.push(p);
    incomeByAccount[account] += p.amountTiyn;
    if (orderNumber < fromOrderNumber) lateIncomeTiyn += p.amountTiyn;
  }

  const lastAt = last?.atMs ?? Number.NEGATIVE_INFINITY;
  const expenses: Expense[] = [];
  let claimedExpense = 0;
  for (const e of input.expenses) {
    if (input.startDate && e.date < input.startDate) continue;
    const at = expenseRecordedMs(e);
    if (at <= lastAt) claimedExpense += e.amountTiyn;
    else if (at <= atMs) expenses.push(e);
  }

  const carriedByAccount = noAccounts();
  for (const a of CASH_ACCOUNTS) {
    const stored = settled.reduce((s, x) => s + (x.incomeByAccount[a] ?? 0) + (x.carriedByAccount?.[a] ?? 0), 0);
    carriedByAccount[a] = claimedByAccount[a] - stored;
  }
  const carriedIncomeTiyn = claimedIncome - settled.reduce((s, x) => s + x.incomeTiyn + (x.carriedIncomeTiyn ?? 0), 0);
  const carriedExpenseTiyn = claimedExpense - settled.reduce((s, x) => s + x.expenseTiyn + (x.carriedExpenseTiyn ?? 0), 0);

  const incomeTiyn = payments.reduce((s, p) => s + p.amountTiyn, 0);
  const expenseTiyn = expenses.reduce((s, e) => s + e.amountTiyn, 0);
  return {
    fromOrderNumber,
    toOrderNumber,
    startDate: input.startDate,
    startOrderNumber: input.startOrderNumber,
    atMs,
    payments,
    expenses,
    incomeTiyn,
    incomeByAccount,
    lateIncomeTiyn,
    deferredTiyn,
    expenseTiyn,
    carriedIncomeTiyn,
    carriedByAccount,
    carriedExpenseTiyn,
    resultTiyn: incomeTiyn + carriedIncomeTiyn - expenseTiyn - carriedExpenseTiyn,
  };
}

/** Nothing to settle: no money, no expenses, and nothing earlier that moved. */
export function isEmptyPlan(plan: SettlementPlan): boolean {
  return plan.payments.length === 0 && plan.expenses.length === 0 && plan.carriedIncomeTiyn === 0
    && plan.carriedExpenseTiyn === 0 && CASH_ACCOUNTS.every((a) => plan.carriedByAccount[a] === 0);
}

/** The record to store for a plan — totals only, never the records themselves (see Settlement). */
export function settlementFromPlan(
  plan: SettlementPlan,
  id: string,
  by: { uid: string; name: string },
  now: Date = new Date(),
): Settlement {
  return {
    id,
    fromOrderNumber: plan.fromOrderNumber,
    toOrderNumber: plan.toOrderNumber,
    startDate: plan.startDate,
    startOrderNumber: plan.startOrderNumber,
    atMs: plan.atMs,
    date: dayKey(now),
    incomeTiyn: plan.incomeTiyn,
    incomeByAccount: plan.incomeByAccount,
    lateIncomeTiyn: plan.lateIncomeTiyn,
    paymentCount: plan.payments.length,
    expenseTiyn: plan.expenseTiyn,
    expenseCount: plan.expenses.length,
    carriedIncomeTiyn: plan.carriedIncomeTiyn,
    carriedByAccount: plan.carriedByAccount,
    carriedExpenseTiyn: plan.carriedExpenseTiyn,
    resultTiyn: plan.resultTiyn,
    byUid: by.uid,
    byName: by.name,
  };
}
