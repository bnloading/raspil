import { useEffect, useState } from "react";
import { collection, onSnapshot, orderBy, query } from "firebase/firestore";
import { db } from "../firebase";
import { useAuth } from "../AuthContext";
import type { RentPayment } from "../types/domain";

/**
 * Every rent entry ("Аренда"), newest first — for the Admin only, as firestore.rules has it.
 *
 * Anyone else gets an empty list and no listener: a Manager's Касса counts the shop's money alone,
 * and a listener the rules refuse would only hold that page's figures up. `error` is set when the
 * Admin's own read is refused — the rules for this collection not yet deployed, say — so the
 * Аренда page can say so instead of showing an empty list as if nothing had been paid.
 */
export function useRentPayments() {
  const { userData } = useAuth();
  const isAdmin = userData?.role === "admin";
  const [rentPayments, setRentPayments] = useState<RentPayment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setRentPayments([]);
    setError(null);
    if (!isAdmin) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const q = query(collection(db, "rentPayments"), orderBy("date", "desc"));
    return onSnapshot(
      q,
      (snap) => {
        const list: RentPayment[] = [];
        snap.forEach((d) => list.push({ id: d.id, ...(d.data() as Omit<RentPayment, "id">) }));
        setRentPayments(list);
        setLoading(false);
      },
      (err) => {
        setError(err.message);
        setLoading(false);
      },
    );
  }, [isAdmin]);

  return { rentPayments, loading, error };
}
