import { addDoc, collection, deleteDoc, doc, serverTimestamp, type Firestore } from "firebase/firestore";
import type { User } from "firebase/auth";
import type { CashAccount, Expense, UserDoc } from "../types/domain";
import { logAudit } from "./audit";

type Actor = { user: User; userData: UserDoc };

/**
 * Logs one real, named expense — "Мусор — 15 000 ₸", "Лист алуға — 20 000 ₸".
 *
 * `account` says which pot it came out of, so the Касса page can take it off the right balance;
 * it defaults to cash, which is what an expense with no account recorded always was.
 */
export async function addExpense(
  db: Firestore,
  actor: Actor,
  data: { name: string; amountTiyn: number; date: string; comment?: string; account?: CashAccount },
): Promise<string> {
  const ref = await addDoc(collection(db, "expenses"), {
    name: data.name,
    amountTiyn: data.amountTiyn,
    date: data.date,
    account: data.account ?? "cash",
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
export function monthlyExpensesTotal(expenses: Expense[], period: string | null): number {
  return expenses
    .filter((e) => period === null || e.date.startsWith(period))
    .reduce((s, e) => s + e.amountTiyn, 0);
}
