import { collection, getDocs, limit, query, where, type Firestore } from "firebase/firestore";
import { normalizePhone } from "./phone";
import type { Order } from "../types/domain";

/**
 * Ties a walk-in order typed into the journal to the customer's own account.
 *
 * The journal records a name and a phone; a customer signs in to an account that holds the same
 * phone. Until these were joined the two never met — a customer who registered saw an empty
 * "Заказдарым" while the shop's ledger had six of their orders, because every customer-facing
 * query is `where("customerId", "==", uid)` and a journal row carried no customerId at all.
 *
 * Matched on the PHONE, never on the name. Names collide, get abbreviated and get typed three
 * ways; the phone is the same key the debt ledger and the merge check already use, and it is
 * stored normalised on both sides (Register.tsx writes normalizePhone(), and so does this).
 */

/** Which orders are worth trying to link: a phone to match on, and nobody attached yet. */
export function needsCustomerLink(order: Pick<Order, "customerId" | "customerPhone">): boolean {
  if (order.customerId) return false;
  return normalizePhone(order.customerPhone ?? "") !== null;
}

/**
 * The uid of the customer account holding this phone, or null.
 *
 * Deliberately a targeted query rather than a list held in memory: the journal would otherwise
 * read every customer account on every page load, and this only has to run when a row is saved.
 * The `role` filter is not decoration — firestore.rules only lets a Manager list users when every
 * candidate document is a customer, so dropping it makes the whole query permission-denied.
 *
 * Returns null rather than throwing when the lookup fails: a walk-in whose account cannot be found
 * (no account, an unreadable phone, or an offline moment) is still a valid order, and refusing to
 * save it would be far worse than leaving it unlinked for now.
 */
export async function findCustomerIdByPhone(db: Firestore, rawPhone: string): Promise<string | null> {
  const digits = normalizePhone(rawPhone ?? "");
  if (!digits) return null;

  try {
    const snap = await getDocs(
      query(
        collection(db, "users"),
        where("role", "==", "customer"),
        where("phone", "==", digits),
        limit(1),
      ),
    );
    return snap.empty ? null : snap.docs[0].id;
  } catch {
    return null;
  }
}
