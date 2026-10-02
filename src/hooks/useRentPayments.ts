import { useEffect, useState } from "react";
import { collection, onSnapshot, orderBy, query } from "firebase/firestore";
import { db } from "../firebase";
import { useAuth } from "../AuthContext";
import type { RentPayment } from "../types/domain";

/**
 * Every rent entry ("Аренда"), newest first — for the Admin and the Manager, as firestore.rules has
 * it, so both see the same Касса.
 *
 * Anyone else gets an empty list and no listener: a listener the rules refuse would only hold the
 * page's figures up. `error` is set when the read is refused — the rules for this collection not
 * yet deployed, say — so the Аренда page can say so instead of showing an empty list as if nothing
 * had been paid.
 */
export function useRentPayments() {
  const { userData } = useAuth();
  const canRead = userData?.role === "admin" || userData?.role === "manager";
  const [rentPayments, setRentPayments] = useState<RentPayment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setRentPayments([]);
    setError(null);
    if (!canRead) {
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
  }, [canRead]);

  return { rentPayments, loading, error };
}
