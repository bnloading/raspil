import { useEffect, useState } from "react";
import { collection, onSnapshot, orderBy, query } from "firebase/firestore";
import { db } from "../firebase";
import type { InventoryMovement, Payment } from "../types/domain";

export function useAllPayments() {
  const [payments, setPayments] = useState<Payment[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const q = query(collection(db, "payments"), orderBy("createdAt", "desc"));
    const unsub = onSnapshot(
      q,
      (snap) => {
        const list: Payment[] = [];
        snap.forEach((d) => list.push({ id: d.id, ...(d.data() as Omit<Payment, "id">) }));
        setPayments(list);
        setLoading(false);
      },
      () => setLoading(false),
    );
    return unsub;
  }, []);

  return { payments, loading };
}

export function useAllInventoryMovements() {
  const [movements, setMovements] = useState<InventoryMovement[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const q = query(collection(db, "inventoryMovements"), orderBy("createdAt", "desc"));
    const unsub = onSnapshot(
      q,
      (snap) => {
        const list: InventoryMovement[] = [];
        snap.forEach((d) => list.push({ id: d.id, ...(d.data() as Omit<InventoryMovement, "id">) }));
        setMovements(list);
        setLoading(false);
      },
      () => setLoading(false),
    );
    return unsub;
  }, []);

  return { movements, loading };
}
