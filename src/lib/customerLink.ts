import { collection, doc, getDocs, limit, query, where, writeBatch, type Firestore } from "firebase/firestore";
import type { User } from "firebase/auth";
import { logAudit } from "./audit";
import { normalizePhone } from "./phone";
import type { Order, UserDoc } from "../types/domain";

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

/**
 * The orders to attach to customer accounts now — every live order whose phone is an account's
 * phone and that nobody is attached to yet (the owner, 05.11: «клиенттер номер арқылы тіркеліп өз
 * қарыз, заказдарын көре алатындай»). Saving a journal row links it (findCustomerIdByPhone), but
 * only to an account that already existed then: a customer who registers after their orders were
 * typed would find «Заказдарым» empty. This is what catches those up.
 *
 * A phone two accounts both claim is left alone rather than guessed: attaching someone's orders
 * to the wrong account would show one customer another's debts.
 */
export function planCustomerLinks(
  orders: readonly Pick<Order, "id" | "customerId" | "customerPhone" | "productionStatus">[],
  accounts: readonly { id: string; phone?: string | null }[],
): { orderId: string; customerId: string }[] {
  const byPhone = new Map<string, string | null>();
  for (const account of accounts) {
    const phone = normalizePhone(account.phone ?? "");
    if (!phone) continue;
    byPhone.set(phone, byPhone.has(phone) && byPhone.get(phone) !== account.id ? null : account.id);
  }
  const links: { orderId: string; customerId: string }[] = [];
  for (const order of orders) {
    if (order.productionStatus === "cancelled" || !needsCustomerLink(order)) continue;
    const customerId = byPhone.get(normalizePhone(order.customerPhone ?? "")!);
    if (customerId) links.push({ orderId: order.id, customerId });
  }
  return links;
}

/**
 * Writes the links planCustomerLinks found, in batches, with one audit entry per customer — so a
 * wrong attachment (a phone typed on the wrong order) can be found and undone from the trail.
 */
export async function linkCustomerOrders(
  db: Firestore,
  actor: { user: User; userData: UserDoc },
  links: readonly { orderId: string; customerId: string }[],
): Promise<void> {
  for (let i = 0; i < links.length; i += 400) {
    const batch = writeBatch(db);
    for (const link of links.slice(i, i + 400)) {
      batch.update(doc(db, "orders", link.orderId), { customerId: link.customerId });
    }
    await batch.commit();
  }
  const byCustomer = new Map<string, string[]>();
  for (const link of links) byCustomer.set(link.customerId, [...(byCustomer.get(link.customerId) ?? []), link.orderId]);
  for (const [customerId, orderIds] of byCustomer) {
    await logAudit(db, actor, {
      action: "order.customer_linked",
      entityType: "user",
      entityId: customerId,
      after: { orderIds },
      comment: `${orderIds.length} заказ телефон нөмірі бойынша клиент аккаунтына қосылды`,
    }).catch(() => {});
  }
}
