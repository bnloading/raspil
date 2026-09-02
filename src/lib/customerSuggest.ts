import type { Order } from "../types/domain";
import { normalizePhone } from "./phone";

/**
 * "Who is this?" answered from the shop's own history.
 *
 * Most of this counter's customers are returning ones, and every visit their name was being typed
 * out again from scratch — "Нурик" one week, "нурик" the next, "Нұрик" the week after. Three
 * spellings is three customers as far as the debt ledger is concerned, and merging two of their
 * rows is refused outright, because merging keys on the phone and the phone gets retyped too.
 *
 * Suggesting the customer instead of the string fixes both: picking one fills in the name AND the
 * phone exactly as they are already recorded, so a returning customer stays one customer.
 */

export interface CustomerSuggestion {
  /** As last recorded — the newest spelling wins, so a corrected name propagates forward. */
  name: string;
  phone: string;
  orderCount: number;
  /** `createdAt` of their most recent order, for ranking. */
  lastOrderSeconds: number;
}

/**
 * One entry per customer, newest spelling kept.
 *
 * Keyed on the phone when there is one, falling back to the name — the same rule orderMerge.ts
 * uses to decide whether two rows belong to one person, so what the ledger offers here and what
 * it will let you merge later cannot disagree.
 */
export function customerKeyOf(name: string, phone: string): string {
  const digits = normalizePhone(phone);
  if (digits) return `phone:${digits}`;
  return `name:${name.trim().toLowerCase()}`;
}

export function customerDirectory(orders: readonly Order[]): CustomerSuggestion[] {
  const byKey = new Map<string, CustomerSuggestion>();

  for (const order of orders) {
    const name = (order.customerName ?? "").trim();
    if (!name) continue;
    const phone = (order.customerPhone ?? "").trim();
    const seconds = order.createdAt?.seconds ?? 0;
    const key = customerKeyOf(name, phone);

    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { name, phone, orderCount: 1, lastOrderSeconds: seconds });
      continue;
    }
    existing.orderCount += 1;
    if (seconds >= existing.lastOrderSeconds) {
      existing.lastOrderSeconds = seconds;
      existing.name = name;
      // Only overwrite with a phone that exists: a later row typed without one must not erase the
      // number the customer is already reachable on.
      if (phone) existing.phone = phone;
    } else if (!existing.phone && phone) {
      existing.phone = phone;
    }
  }

  return [...byKey.values()];
}

/** Which tier a match landed in — lower is a better match, and they never interleave. */
const MATCH_NAME_PREFIX = 0;
const MATCH_WORD_PREFIX = 1;
const MATCH_NAME_ANYWHERE = 2;
const MATCH_PHONE = 3;
const NO_MATCH = 99;

function tierFor(customer: CustomerSuggestion, query: string, queryDigits: string): number {
  const name = customer.name.toLowerCase();
  if (name.startsWith(query)) return MATCH_NAME_PREFIX;
  // "цех" should find "Заказ Цех" — people type the distinguishing word, not the first one.
  if (name.split(/\s+/).some((word) => word.startsWith(query))) return MATCH_WORD_PREFIX;
  if (name.includes(query)) return MATCH_NAME_ANYWHERE;
  // Two digits is where a phone search starts being a search rather than every customer at once.
  if (queryDigits.length >= 2 && customer.phone.replace(/\D/g, "").includes(queryDigits)) {
    return MATCH_PHONE;
  }
  return NO_MATCH;
}

/**
 * The names to offer for what has been typed so far.
 *
 * Ranked by how well it matches first and by how recently they were here second: a customer who
 * came in this morning is a better guess than one who came once last year, and at a counter the
 * top suggestion is the one Tab will take without being read.
 *
 * An empty box offers nothing. Opening a list of every customer the moment the cell is focused
 * would cover the row below it on every single tab through the ledger.
 */
export function suggestCustomers(
  directory: readonly CustomerSuggestion[],
  rawQuery: string,
  limit = 6,
): CustomerSuggestion[] {
  const query = rawQuery.trim().toLowerCase();
  if (query === "") return [];
  const queryDigits = rawQuery.replace(/\D/g, "");

  return directory
    .map((customer) => ({ customer, tier: tierFor(customer, query, queryDigits) }))
    .filter((row) => row.tier !== NO_MATCH)
    .sort((a, b) =>
      a.tier - b.tier ||
      b.customer.lastOrderSeconds - a.customer.lastOrderSeconds ||
      b.customer.orderCount - a.customer.orderCount ||
      a.customer.name.localeCompare(b.customer.name),
    )
    .slice(0, limit)
    .map((row) => row.customer);
}

/**
 * Is what has been typed already exactly this customer?
 *
 * Used to close the list once there is nothing left to complete — leaving one suggestion hovering
 * under a finished name is just something else to dismiss before moving on.
 */
export function isExactly(customer: CustomerSuggestion, rawQuery: string): boolean {
  return customer.name.toLowerCase() === rawQuery.trim().toLowerCase();
}
