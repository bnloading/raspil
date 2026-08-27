import { useEffect, useState } from "react";
import { collection, doc, onSnapshot, orderBy, query, where } from "firebase/firestore";
import { db } from "../firebase";
import type { CuttingPart, Order, Payment, StatusHistoryEntry } from "../types/domain";

export function useOrderDetail(orderId: string | undefined) {
  const [order, setOrder] = useState<Order | null | undefined>(undefined); // undefined = loading, null = not found
  const [parts, setParts] = useState<CuttingPart[]>([]);
  const [statusHistory, setStatusHistory] = useState<StatusHistoryEntry[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);

  useEffect(() => {
    if (!orderId) return;
    setOrder(undefined);
    const unsubOrder = onSnapshot(
      doc(db, "orders", orderId),
      (snap) => {
        // A handful of `orders` docs predate this schema (clientName/items[] instead of
        // orderNumber/productionStatus) — treat those as not-found rather than render garbage.
        const data = snap.data();
        const isCurrentSchema = !!data && typeof data.orderNumber === "string" && typeof data.productionStatus === "string";
        setOrder(isCurrentSchema ? ({ id: snap.id, ...(data as Omit<Order, "id">) }) : null);
      },
      () => setOrder(null),
    );
    const unsubParts = onSnapshot(collection(db, "orders", orderId, "parts"), (snap) => {
      const list: CuttingPart[] = [];
      snap.forEach((d) => list.push({ id: d.id, ...(d.data() as Omit<CuttingPart, "id">) }));
      setParts(list);
    });
    const unsubHistory = onSnapshot(
      query(collection(db, "orders", orderId, "statusHistory"), orderBy("createdAt", "asc")),
      (snap) => {
        const list: StatusHistoryEntry[] = [];
        snap.forEach((d) => list.push({ id: d.id, ...(d.data() as Omit<StatusHistoryEntry, "id">) }));
        setStatusHistory(list);
      },
    );
    const unsubPayments = onSnapshot(
      query(collection(db, "payments"), where("orderId", "==", orderId), orderBy("createdAt", "desc")),
      (snap) => {
        const list: Payment[] = [];
        snap.forEach((d) => list.push({ id: d.id, ...(d.data() as Omit<Payment, "id">) }));
        setPayments(list);
      },
    );

    return () => {
      unsubOrder();
      unsubParts();
      unsubHistory();
      unsubPayments();
    };
  }, [orderId]);

  return { order, parts, statusHistory, payments, loading: order === undefined };
}
