import { addDoc, collection, deleteDoc, doc, serverTimestamp, type Firestore } from "firebase/firestore";
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

/** Removes a logged expense — the admin fixing a typo, not a reversal flow: nothing else in the
 *  app references an expense by id, so there is no ledger integrity to preserve by keeping it. */
export async function deleteExpense(db: Firestore, actor: Actor, expense: Expense): Promise<void> {
  await deleteDoc(doc(db, "expenses", expense.id));
  await logAudit(db, actor, {
    action: "expense.delete",
    entityType: "expense",
    entityId: expense.id,
    before: { name: expense.name, amountTiyn: expense.amountTiyn, date: expense.date },
  });
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
