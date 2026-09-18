import type { SalaryRule, UserDoc } from "../types/domain";

export const SALARY_POLICY_VERSION = "2026-09-11";

/** Current shop rates. A subsequently saved individual rule takes precedence. */
export function effectiveSalaryRule(userId: string, worker: Pick<UserDoc, "role" | "name"> | undefined, saved?: SalaryRule): SalaryRule | undefined {
  if (!worker || saved?.policyVersion === SALARY_POLICY_VERSION) return saved;
  let rates: Partial<SalaryRule> | undefined;
  if (worker.role === "cnc") rates = { mode: "PER_MDF_M2", perMdfM2Tiyn: 100_000 };
  if (worker.role === "sanding") rates = { mode: "PER_MDF_M2", perMdfM2Tiyn: 120_000 };
  // Упаковка (packaging) is a flat per-order bonus on top of the per-m² rate — see
  // lib/salary.ts's computeSalaryBase, which adds it regardless of mode.
  if (worker.role === "vacuum") rates = { mode: "PER_MDF_M2", perMdfM2Tiyn: 200_000, perPackagingOrderTiyn: 225_000 };
  if (worker.role === "pvh") rates = { mode: "FIXED_MONTHLY", fixedMonthlyTiyn: 35_000_000 };
  const names = worker.name.trim().toLocaleLowerCase().split(/\s+/);
  if (worker.role === "raspil" && names.some((name) => name === "олжас" || name === "olzhas")) {
    rates = { mode: "PER_SHEET", perSheetTiyn: 60_000, perMdfSheetTiyn: 60_000, perHdfSheetTiyn: 30_000, perCountertopTiyn: 30_000 };
  }
  if (!rates) return saved;
  return { id: userId, userId, mode: "MANUAL", ...saved, ...rates };
}
