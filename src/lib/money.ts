// Money is always stored/passed around as integer tiyn (1 ₸ = 100 tiyn) to avoid float rounding errors.

export function tengeToTiyn(tenge: number): number {
  return Math.round(tenge * 100);
}

export function tiynToTenge(tiyn: number): number {
  return tiyn / 100;
}

export function formatMoney(tiyn: number | undefined | null): string {
  const value = Math.round((tiyn ?? 0) / 100);
  return `${value.toLocaleString("ru-RU")} ₸`;
}

/**
 * The same figure without the currency suffix, for dense money columns.
 *
 * In a ledger every cell in a column is tenge and the header already says so, so repeating "₸"
 * costs about 18px per column — which at 16 columns is the difference between a readable table and
 * one that clips mid-number.
 */
export function formatMoneyBare(tiyn: number | undefined | null): string {
  return Math.round((tiyn ?? 0) / 100).toLocaleString("ru-RU");
}

/** For inputs where the user types whole tenge, not tiyn. */
export function parseMoneyInput(raw: string): number {
  const cleaned = raw.replace(/[^\d.-]/g, "");
  const value = parseFloat(cleaned);
  return Number.isFinite(value) ? tengeToTiyn(value) : 0;
}
