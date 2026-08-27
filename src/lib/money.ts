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

/** For inputs where the user types whole tenge, not tiyn. */
export function parseMoneyInput(raw: string): number {
  const cleaned = raw.replace(/[^\d.-]/g, "");
  const value = parseFloat(cleaned);
  return Number.isFinite(value) ? tengeToTiyn(value) : 0;
}
