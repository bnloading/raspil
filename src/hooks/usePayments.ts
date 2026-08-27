import { useEffect, useMemo, useState } from "react";
import { collection, onSnapshot, query, where } from "firebase/firestore";
import { db } from "../firebase";
import { groupPaymentsByOrder } from "../lib/journal";
import type { Payment } from "../types/domain";

/**
 * Every payment in the system, grouped by order — the Manager journal's per-method columns
 * (Нал/Kaspi/Pay/Нұр/Бәлім) need one payments read for the whole page rather than one query per
 * visible row. Admin/Manager only: firestore.rules restricts an unfiltered `payments` list to them.
 */
export function useAllPayments() {
  const [payments, setPayments] = useState<Payment[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsub = onSnapshot(
      collection(db, "payments"),
      (snap) => {
        setPayments(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Payment, "id">) })));
        setLoading(false);
      },
      () => setLoading(false),
    );
    return unsub;
  }, []);

  const byOrder = useMemo(() => groupPaymentsByOrder(payments), [payments]);
  return { payments, byOrder, loading };
}

/** Firestore caps an `in` filter at 30 values, so a customer with more orders needs several queries. */
const IN_CHUNK = 30;

/**
 * Payments for a specific set of orders, grouped by order.
 *
 * A customer must NOT use useAllPayments(): firestore.rules only lets them list payments whose
 * parent order they own, and an unfiltered collection query fails outright if even one candidate
 * document would be denied. Filtering by their own order ids is what makes the query provable.
 */
export function usePaymentsForOrders(orderIds: string[]) {
  const [payments, setPayments] = useState<Payment[]>([]);
  const [loading, setLoading] = useState(true);

  // Join the ids so the effect re-runs on membership change, not on every array identity change.
  const key = orderIds.join(",");

  useEffect(() => {
    const ids = key ? key.split(",") : [];
    if (ids.length === 0) {
      setPayments([]);
      setLoading(false);
      return;
    }
    setLoading(true);

    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += IN_CHUNK) chunks.push(ids.slice(i, i + IN_CHUNK));

    const perChunk: Payment[][] = chunks.map(() => []);
    let settled = 0;
    const unsubs = chunks.map((chunk, i) =>
      onSnapshot(
        query(collection(db, "payments"), where("orderId", "in", chunk)),
        (snap) => {
          perChunk[i] = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Payment, "id">) }));
          setPayments(perChunk.flat());
          if (settled < chunks.length) {
            settled += 1;
            if (settled === chunks.length) setLoading(false);
          }
        },
        () => {
          if (settled < chunks.length) {
            settled += 1;
            if (settled === chunks.length) setLoading(false);
          }
        },
      ),
    );
    return () => unsubs.forEach((u) => u());
  }, [key]);

  const byOrder = useMemo(() => groupPaymentsByOrder(payments), [payments]);
  return { payments, byOrder, loading };
}

/** One order's payments — used by the order-detail payment history. */
export function useOrderPayments(orderId: string | undefined) {
  const [payments, setPayments] = useState<Payment[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!orderId) {
      setPayments([]);
      setLoading(false);
      return;
    }
    const unsub = onSnapshot(
      query(collection(db, "payments"), where("orderId", "==", orderId)),
      (snap) => {
        setPayments(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Payment, "id">) })));
        setLoading(false);
      },
      () => setLoading(false),
    );
    return unsub;
  }, [orderId]);

  return { payments, loading };
}
