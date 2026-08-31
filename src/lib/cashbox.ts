import { monthKey } from "./dates";
import type { CashAccount, Expense, Payment, PaymentMethodDef } from "../types/domain";

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

export const CASH_ACCOUNTS: CashAccount[] = ["deposit", "cash"];

export const CASH_ACCOUNT_LABELS: Record<CashAccount, string> = {
  deposit: "Депозит",
  cash: "Қолма-қол",
};

/** For the account cards — the deposit is the "kept" money, the drawer is the working float. */
export const CASH_ACCOUNT_HINTS: Record<CashAccount, string> = {
  deposit: "Аударыммен түскен ақша (Нұр, Kaspi, Pay, Бәлім)",
  cash: "Қолма-қол алынған ақша",
};

/**
 * The method id the seed gives cash ("Нал / Қолма-қол"). Every other method is a transfer, so the
 * default below is "cash is cash, everything else is a deposit" — the rule the shop already runs
 * on. A method that does not follow it carries its own `account` and overrides this.
 */
const CASH_METHOD_ID = "cash";

/** Which pot a method's money lands in. */
export function accountForMethod(method: Pick<PaymentMethodDef, "id" | "account"> | undefined): CashAccount {
  if (method?.account) return method.account;
  if (method?.id === CASH_METHOD_ID) return "cash";
  // An unknown method (deleted from the catalogue, or a payment recorded before it existed) is
  // read as a transfer: money the shop cannot see in the drawer is money it must look for on the
  // account, and the alternative — counting it as cash — would overstate what is physically there.
  return "deposit";
}

/** An expense with no account recorded predates the split and was paid out of the drawer. */
export function accountForExpense(expense: Pick<Expense, "account">): CashAccount {
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
  /** in − out. Negative is real and is shown: you can spend a drawer past what came in that month. */
  balanceTiyn: number;
  /** The split behind `inTiyn`, biggest first — "Нұр 195 200 · Kaspi 42 480". */
  byMethod: MethodTotal[];
  expenseCount: number;
}

export interface CashboxSummary {
  /** YYYY-MM in Asia/Almaty, or null for all time. */
  monthKey: string | null;
  accounts: AccountSummary[];
  totalInTiyn: number;
  totalOutTiyn: number;
  totalBalanceTiyn: number;
}

function emptyAccount(account: CashAccount): AccountSummary {
  return { account, inTiyn: 0, outTiyn: 0, balanceTiyn: 0, byMethod: [], expenseCount: 0 };
}

/**
 * Money in and out of each pot for one month, or for all time when `period` is null.
 *
 * A payment is dated by `paymentDate` (when the money actually arrived), not by the order it
 * settles — an order billed in March and paid in April is April's cash, and the drawer knows it.
 * Reversed payments never count: the money went back.
 */
export function computeCashbox({
  payments,
  expenses,
  methods,
  period,
}: {
  payments: Payment[];
  expenses: Expense[];
  methods: PaymentMethodDef[];
  period: string | null;
}): CashboxSummary {
  const methodById = new Map(methods.map((m) => [m.id, m]));
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
    if (period !== null && (!payment.paymentDate || monthKey(payment.paymentDate) !== period)) continue;

    const account = accountForMethod(methodById.get(payment.methodId) ?? { id: payment.methodId });
    const summary = summaries.get(account)!;
    summary.inTiyn += payment.amountTiyn;

    const bucket = byMethod.get(account)!;
    const existing = bucket.get(payment.methodId);
    if (existing) existing.amountTiyn += payment.amountTiyn;
    else {
      bucket.set(payment.methodId, {
        methodId: payment.methodId,
        methodName: methodById.get(payment.methodId)?.name ?? payment.methodName ?? payment.methodId,
        amountTiyn: payment.amountTiyn,
      });
    }
  }

  for (const expense of expenses) {
    if (period !== null && !expense.date.startsWith(period)) continue;
    const summary = summaries.get(accountForExpense(expense))!;
    summary.outTiyn += expense.amountTiyn;
    summary.expenseCount += 1;
  }

  const accounts = CASH_ACCOUNTS.map((account) => {
    const summary = summaries.get(account)!;
    return {
      ...summary,
      balanceTiyn: summary.inTiyn - summary.outTiyn,
      byMethod: [...byMethod.get(account)!.values()].sort((a, b) => b.amountTiyn - a.amountTiyn),
    };
  });

  return {
    monthKey: period,
    accounts,
    totalInTiyn: accounts.reduce((s, a) => s + a.inTiyn, 0),
    totalOutTiyn: accounts.reduce((s, a) => s + a.outTiyn, 0),
    totalBalanceTiyn: accounts.reduce((s, a) => s + a.balanceTiyn, 0),
  };
}

/**
 * Expenses of one month, newest first — what the Шығындар list shows.
 *
 * Ties break on the entry's own id so a day with three expenses holds a stable order instead of
 * reshuffling on every snapshot, the same reason the journal sorts on the order number.
 */
export function expensesInPeriod(expenses: Expense[], period: string | null): Expense[] {
  return expenses
    .filter((e) => period === null || e.date.startsWith(period))
    .sort((a, b) => (a.date === b.date ? a.id.localeCompare(b.id) : b.date.localeCompare(a.date)));
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
      byName.set(key, { name: expense.name.trim(), amountTiyn: expense.amountTiyn, count: 1 });
    }
  }
  return [...byName.values()].sort((a, b) => b.amountTiyn - a.amountTiyn);
}
