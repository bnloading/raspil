import { useEffect, useState } from "react";
import { collection, onSnapshot, orderBy, query } from "firebase/firestore";
import { db } from "../firebase";
import type { Expense } from "../types/domain";

/**
 * Every logged expense, newest first. Admin/Manager only (see firestore.rules): the Manager writes
 * these on the Касса page, and the Admin's Есептер subtracts the same rows from net profit.
 */
export function useExpenses() {
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const q = query(collection(db, "expenses"), orderBy("date", "desc"));
    const unsub = onSnapshot(
      q,
      (snap) => {
        const list: Expense[] = [];
        snap.forEach((d) => list.push({ id: d.id, ...(d.data() as Omit<Expense, "id">) }));
        setExpenses(list);
        setLoading(false);
      },
      () => setLoading(false),
    );
    return unsub;
  }, []);

  return { expenses, loading };
}
