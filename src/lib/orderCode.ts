/**
 * How an order number is shown to a customer.
 *
 * Internally an order is "ORD-2026-000021" — the prefix and year matter for the ledger, exports
 * and support, so the stored value never changes. But a customer only ever needs to say "my order
 * twenty-one", and the prefix is noise on a phone card where space is scarce.
 */

/** "ORD-2026-000021" → "21". Falls back to the whole string when there is no trailing number. */
export function shortOrderNumber(orderNumber: string | undefined): string {
  const digits = (orderNumber ?? "").match(/(\d+)\s*$/)?.[1];
  if (!digits) return orderNumber ?? "";
  const trimmed = digits.replace(/^0+/, "");
  return trimmed || "0";
}

/** The same, prefixed for display: "№21". */
export function customerOrderCode(orderNumber: string | undefined): string {
  const short = shortOrderNumber(orderNumber);
  return short ? `№${short}` : "";
}
