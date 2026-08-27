// CRUD for the admin-managed `expenseCategories` collection (small config data — not a financial
// ledger like payments/inventory, so a hard delete is fine here, no soft-delete/audit trail).

import { addDoc, collection, deleteDoc, doc, serverTimestamp, updateDoc, type Firestore } from "firebase/firestore";

export async function addExpenseCategory(
  db: Firestore,
  data: { name: string; percentage: number; active: boolean },
): Promise<string> {
  const ref = await addDoc(collection(db, "expenseCategories"), {
    ...data,
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

export async function updateExpenseCategory(
  db: Firestore,
  id: string,
  data: Partial<{ name: string; percentage: number; active: boolean }>,
): Promise<void> {
  await updateDoc(doc(db, "expenseCategories", id), data);
}

export async function deleteExpenseCategory(db: Firestore, id: string): Promise<void> {
  await deleteDoc(doc(db, "expenseCategories", id));
}
