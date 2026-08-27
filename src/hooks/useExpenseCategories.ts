import { useEffect, useState } from "react";
import { collection, onSnapshot, orderBy, query } from "firebase/firestore";
import { db } from "../firebase";
import type { ExpenseCategory } from "../types/domain";

/** Admin-only collection (see firestore.rules) — this hook is meant to be used from admin pages. */
export function useExpenseCategories() {
  const [categories, setCategories] = useState<ExpenseCategory[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const q = query(collection(db, "expenseCategories"), orderBy("name", "asc"));
    const unsub = onSnapshot(
      q,
      (snap) => {
        const list: ExpenseCategory[] = [];
        snap.forEach((d) => list.push({ id: d.id, ...(d.data() as Omit<ExpenseCategory, "id">) }));
        setCategories(list);
        setLoading(false);
      },
      () => setLoading(false),
    );
    return unsub;
  }, []);

  return { categories, loading };
}
