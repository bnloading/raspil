import { useEffect, useState } from "react";
import { collection, onSnapshot, query, where } from "firebase/firestore";
import { db } from "../firebase";
import type { Invoice } from "../types/domain";

/** Every invoice version for one order, newest version first. */
export function useOrderInvoices(orderId: string | undefined) {
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!orderId) {
      setInvoices([]);
      setLoading(false);
      return;
    }
    const unsub = onSnapshot(
      query(collection(db, "invoices"), where("orderId", "==", orderId)),
      (snap) => {
        const list = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Invoice, "id">) }));
        setInvoices(list.sort((a, b) => b.version - a.version));
        setLoading(false);
      },
      () => setLoading(false),
    );
    return unsub;
  }, [orderId]);

  return { invoices, loading };
}

/**
 * A customer's own invoices. Scoped by customerId AND sentToCustomer so the query matches what
 * firestore.rules allows — a draft the Manager hasn't sent yet must stay invisible.
 */
export function useCustomerInvoices(customerId: string | undefined) {
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!customerId) {
      setInvoices([]);
      setLoading(false);
      return;
    }
    const unsub = onSnapshot(
      query(
        collection(db, "invoices"),
        where("customerId", "==", customerId),
        where("sentToCustomer", "==", true),
      ),
      (snap) => {
        const list = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Invoice, "id">) }));
        setInvoices(list.sort((a, b) => (b.issuedAt?.toMillis() ?? 0) - (a.issuedAt?.toMillis() ?? 0)));
        setLoading(false);
      },
      () => setLoading(false),
    );
    return unsub;
  }, [customerId]);

  return { invoices, loading };
}
