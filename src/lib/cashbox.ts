import { dayKey, monthKey } from "./dates";
import type {
  CashAccount,
  Expense,
  Order,
  Payment,
  PaymentMethodDef,
  CashAdjustment,
} from "../types/domain";

/**
 * The shop's two money pots — "Касса".
 *
 * The owner keeps the workshop's money in two places that are genuinely separate: a deposit
 * account, where every transfer lands (Нұр, Kaspi, Pay, Бәлім), and the cash in the drawer. One
 * combined "revenue" number answers neither of the questions actually asked at closing time —
 * how much is on the card, and how much is in the box — so this keeps them apart from the start.
 *
 * Everything here is pure and derived: money in comes from the payments ledger, money out from
 * the logged expenses. No balance is ever typed in and stored, which is the same rule the debt
 * ledger follows — a stored total is a total that can silently go wrong.
 */
// can nfdsn fsn kh fs
// ls = offers if (offers>journal.length){console.log("it's just been a test offers never been more than joutnal length")} else {console.log("it's done just trolling lol xxaxaaxaxax")}
export const CASH_ACCOUNTS: CashAccount[] = ["deposit", "pay", "cash"];

/** "deposit" is Нұр — the id is older than the split, and every record already written under it
 *  is Нұр money (the period reconciled to the tiyn against that account). "Kaspi" and "Pay" are
 *  two names the shop uses for the same account, so they share one pot and stay told apart by the
 *  per-method breakdown inside it. */
export const CASH_ACCOUNT_LABELS: Record<CashAccount, string> = {
  deposit: "Нұр",
  pay: "Kaspi / Pay",
  cash: "Қолма-қол",
};

/** For the account cards — one per real place the money sits, so each can be read against its own
 *  statement. They used to be one "Депозит" card, which is why it never matched anything. */
export const CASH_ACCOUNT_HINTS: Record<CashAccount, string> = {
  deposit: "Нұр шотына аударыммен түскен ақша",
  pay: "Kaspi/Pay шотына түскен ақша",
  cash: "Қолма-қол алынған ақша",
};

/**
 * The method id the seed gives cash ("Нал / Қолма-қол"). Every other method is a transfer, so the
 * default below is "cash is cash, everything else is a deposit" — the rule the shop already runs
 * on. A method that does not follow it carries its own `account` and overrides this.
 */
const CASH_METHOD_ID = "cash";

/** Which pot a method's money lands in. */
export function accountForMethod(
  method: Pick<PaymentMethodDef, "id" | "account"> | undefined,
): CashAccount {
  if (method?.account) return method.account;
  if (method?.id === CASH_METHOD_ID) return "cash";
  // An unknown method (deleted from the catalogue, or a payment recorded before it existed) is
  // read as a transfer: money the shop cannot see in the drawer is money it must look for on the
  // account, and the alternative — counting it as cash — would overstate what is physically there.
  return "deposit";
}

/** An expense with no account recorded predates the split and was paid out of the drawer. */
export function accountForExpense(
  expense: Pick<Expense, "account">,
): CashAccount {
  return expense.account ?? "cash";
}

export interface MethodTotal {
  methodId: string;
  methodName: string;
  amountTiyn: number;
}

export interface AccountSummary {
  account: CashAccount;
  /** Payments received into this pot in the period. */
  inTiyn: number;
  /** Expenses paid out of this pot in the period. */
  outTiyn: number;
  /** Signed sum of the pot's dated corrections in the period (ApplicationSettings.cashAdjustments). */
  adjustTiyn: number;
  /** in − out ± corrections (+ opening, all-time only). Negative is real and is shown: you can
   *  spend a drawer past what came in that month. */
  balanceTiyn: number;
  /** The split behind `inTiyn`, biggest first — "Нұр 195 200 · Kaspi 42 480". */
  byMethod: MethodTotal[];
  expenseCount: number;
}

/** A payment left out of the pots because the order it settles predates the restart. */
export interface ExcludedPayment {
  paymentId: string;
  orderNumber: string;
  /** "YYYY-MM-DD" the order was created, and the payment recorded. */
  orderDay: string;
  paymentDay: string;
  amountTiyn: number;
  methodName: string;
  /** The pot it would otherwise have landed in. */
  account: CashAccount;
}

export interface CashboxSummary {
  /** YYYY-MM in Asia/Almaty, or null for all time. */
  monthKey: string | null;
  accounts: AccountSummary[];
  totalInTiyn: number;
  totalOutTiyn: number;
  totalAdjustTiyn: number;
  totalBalanceTiyn: number;
  /** Payments on pre-restart orders, oldest payment first — shown, never counted (see `orders`). */
  excludedOldOrders: ExcludedPayment[];
  /** The corrections counted in this period, oldest first. */
  adjustments: CashAdjustment[];
}

function emptyAccount(account: CashAccount): AccountSummary {
  return {
    account,
    inTiyn: 0,
    outTiyn: 0,
    adjustTiyn: 0,
    balanceTiyn: 0,
    byMethod: [],
    expenseCount: 0,
  };
}

/**
 * Money in and out of each pot for one month, or for all time when `period` is null.
 *
 * A payment is dated by `paymentDate` (when the money actually arrived), not by the order it
 * settles — an order billed in March and paid in April is April's cash, and the drawer knows it.
 * The one exception is the accounting restart: given `orders`, a payment on an order created
 * before `startDate` belongs to the closed books and is listed in `excludedOldOrders` instead.
 * Reversed payments never count: the money went back.
 *
 * `openingBalanceTiyn` is what was already in a pot before this app started tracking money —
 * folded into that account's Қалдық only when `period` is null (a specific month reports flow
 * *during* that month, which an opening balance from before the app existed has no part in).
 */
export function computeCashbox({
  payments,
  expenses,
  methods,
  period,
  openingBalanceTiyn = {},
  startDate = null,
  orders,
  adjustments = [],
}: {
  payments: Payment[];
  expenses: Expense[];
  methods: PaymentMethodDef[];
  period: string | null;
  openingBalanceTiyn?: Partial<Record<CashAccount, number>>;
  /**
   * "YYYY-MM-DD" the accounting restarts on — money that moved before it is not counted here at
   * all, in any period (see ApplicationSettings.cashStartDate). This is what lets the shop start
   * its cash figures over mid-month without deleting payments the orders still depend on.
   */
  startDate?: string | null;
  /**
   * The orders the payments settle, so a payment can be dated by its order as well. With a
   * `startDate`, a payment on an order CREATED before it is left out of every pot even when it was
   * recorded after — the owner's rule: the books closed on the restart, and marking a 07.09 order
   * paid on the 25th must not add to today's deposit. Such payments are reported in
   * `excludedOldOrders` instead of vanishing — unless an Admin marked the payment
   * `countsInCurrentBooks`. Omitted, every payment is dated by itself alone.
   */
  orders?: readonly Pick<Order, "id" | "orderNumber" | "createdAt">[];
  /** This line's dated corrections (ApplicationSettings.cashAdjustments), filtered by date like an
   *  expense: nothing before `startDate`, and only the chosen month's when `period` is set. */
  adjustments?: readonly CashAdjustment[];
}): CashboxSummary {
  const methodById = new Map(methods.map((m) => [m.id, m]));
  const orderById = new Map((orders ?? []).map((o) => [o.id, o]));
  const excludedOldOrders: ExcludedPayment[] = [];
  const summaries = new Map<CashAccount, AccountSummary>(
    CASH_ACCOUNTS.map((a) => [a, emptyAccount(a)]),
  );
  // Per account, so the same method appearing in both pots (it never should, but data drifts)
  // still adds up rather than overwriting.
  const byMethod = new Map<CashAccount, Map<string, MethodTotal>>(
    CASH_ACCOUNTS.map((a) => [a, new Map()]),
  );

  for (const payment of payments) {
    if (payment.reversed) continue;
    if (
      startDate &&
      (!payment.paymentDate || dayKey(payment.paymentDate) < startDate)
    )
      continue;
    if (
      period !== null &&
      (!payment.paymentDate || monthKey(payment.paymentDate) !== period)
    )
      continue;

    const account = accountForMethod(
      methodById.get(payment.methodId) ?? { id: payment.methodId },
    );
    // Settles an order from before the restart: the old books, not today's money.
    const order = orderById.get(payment.orderId);
    if (startDate && order?.createdAt && dayKey(order.createdAt) < startDate && !payment.countsInCurrentBooks) {
      excludedOldOrders.push({
        paymentId: payment.id,
        orderNumber: order.orderNumber,
        orderDay: dayKey(order.createdAt),
        paymentDay: dayKey(payment.paymentDate),
        amountTiyn: payment.amountTiyn,
        methodName: methodById.get(payment.methodId)?.name ?? payment.methodName ?? payment.methodId,
        account,
      });
      continue;
    }
    const summary = summaries.get(account)!;
    summary.inTiyn += payment.amountTiyn;

    const bucket = byMethod.get(account)!;
    const existing = bucket.get(payment.methodId);
    if (existing) existing.amountTiyn += payment.amountTiyn;
    else {
      bucket.set(payment.methodId, {
        methodId: payment.methodId,
        methodName:
          methodById.get(payment.methodId)?.name ??
          payment.methodName ??
          payment.methodId,
        amountTiyn: payment.amountTiyn,
      });
    }
  }

  for (const expense of expenses) {
    if (startDate && expense.date < startDate) continue;
    if (period !== null && !expense.date.startsWith(period)) continue;
    const summary = summaries.get(accountForExpense(expense))!;
    summary.outTiyn += expense.amountTiyn;
    summary.expenseCount += 1;
  }

  // Dated corrections ("Банкпен теңестіру"), filtered exactly like an expense.
  const counted = adjustments
    .filter((a) => (!startDate || a.date >= startDate) && (period === null || a.date.startsWith(period)))
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date));
  for (const adjustment of counted) summaries.get(adjustment.account)!.adjustTiyn += adjustment.amountTiyn;

  const accounts = CASH_ACCOUNTS.map((account) => {
    const summary = summaries.get(account)!;
    const opening = period === null ? (openingBalanceTiyn[account] ?? 0) : 0;
    return {
      ...summary,
      balanceTiyn: summary.inTiyn - summary.outTiyn + summary.adjustTiyn + opening,
      byMethod: [...byMethod.get(account)!.values()].sort(
        (a, b) => b.amountTiyn - a.amountTiyn,
      ),
    };
  });

  return {
    monthKey: period,
    accounts,
    totalInTiyn: accounts.reduce((s, a) => s + a.inTiyn, 0),
    totalOutTiyn: accounts.reduce((s, a) => s + a.outTiyn, 0),
    totalAdjustTiyn: accounts.reduce((s, a) => s + a.adjustTiyn, 0),
    totalBalanceTiyn: accounts.reduce((s, a) => s + a.balanceTiyn, 0),
    excludedOldOrders: excludedOldOrders.sort((a, b) => a.paymentDay.localeCompare(b.paymentDay)),
    adjustments: counted,
  };
}

/**
 * Expenses of one month, newest first — what the Шығындар list shows.
 *
 * Ties break on the entry's own id so a day with three expenses holds a stable order instead of
 * reshuffling on every snapshot, the same reason the journal sorts on the order number.
 *
 * `startDate` is applied here too, so the list can never show a row the totals above it are not
 * counting — an expense from before the accounting restart is history, not part of this ledger.
 */
export function expensesInPeriod(
  expenses: Expense[],
  period: string | null,
  startDate: string | null = null,
): Expense[] {
  return expenses
    .filter(
      (e) =>
        (period === null || e.date.startsWith(period)) &&
        (!startDate || e.date >= startDate),
    )
    .sort((a, b) =>
      a.date === b.date
        ? a.id.localeCompare(b.id)
        : b.date.localeCompare(a.date),
    );
}

/** Expenses grouped by name, biggest first — "Лист алуға 240 000 ₸ (12 рет)". */
export interface ExpenseGroup {
  name: string;
  amountTiyn: number;
  count: number;
}

export function groupExpensesByName(expenses: Expense[]): ExpenseGroup[] {
  const byName = new Map<string, ExpenseGroup>();
  for (const expense of expenses) {
    const key = expense.name.trim().toLowerCase();
    const existing = byName.get(key);
    if (existing) {
      existing.amountTiyn += expense.amountTiyn;
      existing.count += 1;
    } else {
      byName.set(key, {
        name: expense.name.trim(),
        amountTiyn: expense.amountTiyn,
        count: 1,
      });
    }
  }
  return [...byName.values()].sort((a, b) => b.amountTiyn - a.amountTiyn);
}
