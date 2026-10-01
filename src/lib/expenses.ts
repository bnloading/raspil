import { addDoc, collection, deleteDoc, doc, serverTimestamp, writeBatch, type Firestore } from "firebase/firestore";
import type { User } from "firebase/auth";
import type { CashAccount, Department, Expense, UserDoc } from "../types/domain";
import { dayKey, monthKey } from "./dates";
import { logAudit } from "./audit";

type Actor = { user: User; userData: UserDoc };

/**
 * The day a new expense should be dated, given whichever period the Касса page is showing.
 *
 * Following the period picker is right for a past month: choosing Тамыз and being handed today's
 * date would mean correcting every backdated entry by hand. But it used to hand back the FIRST of
 * the month for the current one too, so an expense written this afternoon was filed on the 1st.
 * That was merely untidy until the accounting restart — now anything dated before it is left out
 * of every Касса figure, so seven expenses typed in a row landed where nothing would ever show
 * them. The current month gets today; only a month that is genuinely over falls back to its 1st.
 */
export function expenseDefaultDate(period: string | null, now: Date = new Date()): string {
  if (!period || period === monthKey(now)) return dayKey(now);
  return `${period}-01`;
}

/**
 * Logs one real, named expense — "Мусор — 15 000 ₸", "Лист алуға — 20 000 ₸".
 *
 * `account` says which pot it came out of, so the Касса page can take it off the right balance;
 * it defaults to cash, which is what an expense with no account recorded always was. `department`
 * says which line's касса it belongs to (see lib/cashbox.ts) and defaults to "ldsp" the same way.
 */
export async function addExpense(
  db: Firestore,
  actor: Actor,
  data: {
    name: string;
    amountTiyn: number;
    date: string;
    comment?: string;
    account?: CashAccount;
    department?: Department;
  },
): Promise<string> {
  const ref = await addDoc(collection(db, "expenses"), {
    name: data.name,
    amountTiyn: data.amountTiyn,
    date: data.date,
    account: data.account ?? "cash",
    department: data.department ?? "ldsp",
    comment: data.comment ?? "",
    createdByUid: actor.user.uid,
    createdByName: actor.userData.name,
    createdAt: serverTimestamp(),
  });
  await logAudit(db, actor, {
    action: "expense.create",
    entityType: "expense",
    entityId: ref.id,
    after: data,
  });
  return ref.id;
}

/**
 * Money handed to a worker out of a Касса pot — "Олжас — аванс 300 000 ₸", or last week's pay.
 *
 * One action, two records, written together: the expense takes the money off the pot it left, and
 * a SalaryAdvance against the worker's pay period takes it off what their payslip still owes. The
 * counter used to record only the first, so Олжас's 300 000 ₸ of 29.09 never reached his week,
 * which went on reading 232 800 ₸ still to pay. Each record names the other, and deleting the
 * expense reverses the advance (deleteExpense).
 */
export async function payWorkerFromCashbox(
  db: Firestore,
  actor: Actor,
  data: {
    name: string;
    amountTiyn: number;
    date: string;
    comment: string;
    account: CashAccount;
    department: Department;
    worker: { uid: string; name: string };
    /** The pay period it comes off — this week/month for an advance, the last one for its pay. */
    periodKey: string;
  },
): Promise<string> {
  const expenseRef = doc(collection(db, "expenses"));
  const advanceRef = doc(collection(db, "advances"));
  const batch = writeBatch(db);
  batch.set(expenseRef, {
    name: data.name,
    amountTiyn: data.amountTiyn,
    date: data.date,
    account: data.account,
    department: data.department,
    comment: data.comment,
    paidToUid: data.worker.uid,
    paidToName: data.worker.name,
    payPeriodKey: data.periodKey,
    advanceId: advanceRef.id,
    createdByUid: actor.user.uid,
    createdByName: actor.userData.name,
    createdAt: serverTimestamp(),
  });
  batch.set(advanceRef, {
    userId: data.worker.uid,
    userName: data.worker.name,
    periodKey: data.periodKey,
    amountTiyn: data.amountTiyn,
    note: `Касса: ${data.name}${data.comment ? ` · ${data.comment}` : ""}`,
    paidAt: serverTimestamp(),
    recordedByUid: actor.user.uid,
    recordedByName: actor.userData.name,
    reversed: false,
    expenseId: expenseRef.id,
    createdAt: serverTimestamp(),
  });
  await batch.commit();
  await logAudit(db, actor, {
    action: "expense.create",
    entityType: "expense",
    entityId: expenseRef.id,
    after: { name: data.name, amountTiyn: data.amountTiyn, date: data.date, paidTo: data.worker.name, periodKey: data.periodKey },
  });
  return expenseRef.id;
}

/**
 * Removes a logged expense — the admin fixing a typo, not a reversal flow. Money that went to a
 * worker takes its advance with it (reversed, not deleted — advances are never deleted), or the
 * payslip would keep a payment the Касса no longer shows. Reversing is Admin-only in the rules.
 */
export async function deleteExpense(db: Firestore, actor: Actor, expense: Expense): Promise<void> {
  if (expense.advanceId) {
    const batch = writeBatch(db);
    batch.delete(doc(db, "expenses", expense.id));
    batch.update(doc(db, "advances", expense.advanceId), {
      reversed: true,
      reversalReason: "Касса шығыны өшірілді",
      reversedByName: actor.userData.name,
    });
    await batch.commit();
  } else {
    await deleteDoc(doc(db, "expenses", expense.id));
  }
  await logAudit(db, actor, {
    action: "expense.delete",
    entityType: "expense",
    entityId: expense.id,
    before: { name: expense.name, amountTiyn: expense.amountTiyn, date: expense.date },
  });
}

/** One week of the expense log — Monday to Sunday, as the shop counts a week. */
export interface ExpenseWeek {
  /** Monday, "YYYY-MM-DD". */
  start: string;
  /** Sunday, "YYYY-MM-DD". */
  end: string;
  totalTiyn: number;
  /** Newest first, ties by id — the order the Шығындар list reads in. */
  expenses: Expense[];
}

const shiftDay = (day: string, days: number): string => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/** The Monday of the week a "YYYY-MM-DD" day falls in. Pure date arithmetic, no time zone. */
export function weekStartOf(day: string): string {
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return shiftDay(day, -((weekday + 6) % 7));
}

/**
 * Every expense ever logged, week by week, newest week first — "Шығындар тарихы" on Касса.
 *
 * The accounting restart leaves anything spent before it out of every Касса figure, and the
 * Шығындар list with it — so after 30.09 the September expenses looked gone, though not one was
 * deleted. This is where they are kept to be read, a week to a line.
 */
export function expensesByWeek(expenses: readonly Expense[]): ExpenseWeek[] {
  const weeks = new Map<string, Expense[]>();
  for (const expense of expenses) {
    const start = weekStartOf(expense.date);
    const list = weeks.get(start);
    if (list) list.push(expense);
    else weeks.set(start, [expense]);
  }
  return [...weeks]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([start, list]) => ({
      start,
      end: shiftDay(start, 6),
      totalTiyn: list.reduce((s, e) => s + e.amountTiyn, 0),
      expenses: list.sort((a, b) => (a.date === b.date ? a.id.localeCompare(b.id) : b.date.localeCompare(a.date))),
    }));
}

/** Sum of logged expenses in one month (YYYY-MM), or every expense ever logged when period is null. */
export function monthlyExpensesTotal(
  expenses: Expense[],
  period: string | null,
  /** Accounting restart day — anything spent before it is history, not part of this ledger.
   *  See ApplicationSettings.cashStartDate and lib/cashbox.ts, which filters the same way. */
  startDate: string | null = null,
): number {
  return expenses
    .filter((e) => (period === null || e.date.startsWith(period)) && (!startDate || e.date >= startDate))
    .reduce((s, e) => s + e.amountTiyn, 0);
}
