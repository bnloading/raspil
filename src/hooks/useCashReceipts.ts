import { useEffect, useState } from "react";
import { collection, onSnapshot, orderBy, query } from "firebase/firestore";
import { db } from "../firebase";
import { useAuth } from "../AuthContext";
import { cashReceiptErrorText } from "../lib/cashReceiptsWrite";
import type { CashReceipt } from "../types/domain";

/**
 * Every «Нал ақша алдым» entry, newest day first — the Admin's alone, as firestore.rules has it.
 *
 * Anyone else gets an empty list and no listener. `error` is set when the read is refused (the
 * rules for this collection not yet deployed, say), so the card can say so instead of showing an
 * empty list as if nothing had been taken.
 */
export function useCashReceipts() {
  const { userData } = useAuth();
  const canRead = userData?.role === "admin";
  const [receipts, setReceipts] = useState<CashReceipt[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setReceipts([]);
    setError(null);
    if (!canRead) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const q = query(collection(db, "cashReceipts"), orderBy("date", "desc"));
    return onSnapshot(
      q,
      (snap) => {
        const list: CashReceipt[] = [];
        snap.forEach((d) => list.push({ id: d.id, ...(d.data() as Omit<CashReceipt, "id">) }));
        setReceipts(list);
        setLoading(false);
      },
      (err) => {
        setError(cashReceiptErrorText(err));
        setLoading(false);
      },
    );
  }, [canRead]);

  return { receipts, loading, error };
}
