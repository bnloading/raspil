import { useEffect, useRef, useState } from "react";
import { collection, onSnapshot, query, where } from "firebase/firestore";
import { db } from "../firebase";
import { useAuth } from "../AuthContext";
import { linkCustomerOrders, planCustomerLinks } from "../lib/customerLink";
import type { Order, UserDoc } from "../types/domain";

/**
 * Attaches orders to the customer accounts their phones belong to, whenever the counter has the
 * journal open — so a customer who registers today sees in «Заказдарым» and «Қарыз» the orders
 * typed under their phone before they had an account (lib/customerLink.ts planCustomerLinks).
 *
 * Runs on the Admin's or the Manager's screen because only they may write an order's customerId
 * (firestore.rules); each order is tried once per page visit, so a failed write never loops. The
 * accounts are listened to, not read once: the journal stays open all day, and a customer who
 * registers at the counter should find their orders straight away, not after the next reload.
 */
export function useCustomerAutoLink(orders: readonly Order[]): void {
  const { user, userData } = useAuth();
  const staff = userData?.role === "admin" || userData?.role === "manager";
  const [accounts, setAccounts] = useState<{ id: string; phone?: string }[] | null>(null);
  const tried = useRef(new Set<string>());

  useEffect(() => {
    if (!staff) return;
    // The role filter is what firestore.rules lets a Manager list users by.
    return onSnapshot(
      query(collection(db, "users"), where("role", "==", "customer")),
      (snap) => setAccounts(snap.docs.map((d) => ({ id: d.id, phone: (d.data() as UserDoc).phone }))),
      () => setAccounts([]),
    );
  }, [staff]);

  useEffect(() => {
    if (!accounts || !user || !userData || !staff) return;
    const links = planCustomerLinks(orders, accounts).filter((l) => !tried.current.has(l.orderId));
    if (links.length === 0) return;
    for (const l of links) tried.current.add(l.orderId);
    linkCustomerOrders(db, { user, userData }, links).catch(() => {
      // Left unlinked for now; the next visit tries again.
    });
  }, [orders, accounts, user, userData, staff]);
}
