import type {
  AttendanceRecord,
  MaterialCategory,
  Order,
  SalaryEntry,
  SalaryMode,
  SalaryRule,
} from "../types/domain";
import { MDF_STAGES } from "../types/domain";
import { monthKey, dayKey } from "./dates";
import { jobsOf } from "./orderLines";

/**
 * Configurable salary engine.
 *
 * MANUAL remains the default for any worker with no rule configured: the engine
 * measures the work and attendance honestly but computes a base of zero and waits for an Admin to
 * enter the amount. No formula is invented. The other modes are wired and ready to switch on per
 * worker once the real rules arrive, without touching this code.
 */

export interface SalaryWorkTotals {
  sheetsCut: number;
  /** sheetsCut split by material category — each category has its own piece rate. */
  ldspSheets: number;
  hdfSheets: number;
  countertopSheets: number;
  mdfSheets: number;
  pvcMeters: number;
  /** m² of МДФ wrap production this worker finished a station on this period — the separate
   *  production line (cnc/sanding/painting/vacuum roles), unrelated to mdfSheets above (which is
   *  a распил-line cutter cutting an МДФ-category sheet — see SalaryRule.perMdfM2Tiyn). */
  mdfM2Processed: number;
  ordersCompleted: number;
  presentDays: number;
  absentDays: number;
  workedHours: number;
}

export const EMPTY_WORK_TOTALS: SalaryWorkTotals = {
  sheetsCut: 0,
  ldspSheets: 0,
  hdfSheets: 0,
  countertopSheets: 0,
  mdfSheets: 0,
  pvcMeters: 0,
  mdfM2Processed: 0,
  ordersCompleted: 0,
  presentDays: 0,
  absentDays: 0,
  workedHours: 0,
};

/**
 * Measures one worker's output for one month from the orders they actually completed.
 *
 * Cutting work is credited on `cuttingCompletedAt` and PVC work on `pvcCompletedAt` — the date the
 * work happened, never the order's creation or payment date, so a January order finished in
 * February counts in February. New months therefore appear on their own, with no month list to
 * maintain anywhere.
 */
export function measureWork(
  orders: Order[],
  attendance: AttendanceRecord[],
  userId: string,
  periodKey: string,
  /** Material category per materialId. Anything missing counts as ЛДСП, the common case. */
  categoryByMaterialId: Map<string, MaterialCategory> = new Map(),
): SalaryWorkTotals {
  let sheetsCut = 0;
  let ldspSheets = 0;
  let hdfSheets = 0;
  let countertopSheets = 0;
  let mdfSheets = 0;
  let pvcMeters = 0;
  let mdfM2Processed = 0;
  let ordersCompleted = 0;

  for (const order of orders) {
    // Per material line, not per order: a merged order ("10 лист ЛДСП + 3 лист ХДФ") pays the
    // ЛДСП rate on 10 sheets and the ХДФ rate on 3, and each line credits whichever worker's uid
    // is actually on it — two cutters splitting one merged order each get only their own sheets.
    // jobsOf() derives lines for an order that predates this tracking (see its doc comment), so
    // history from before per-line jobs existed still counts here exactly as it always did.
    let touchedThisOrder = false;
    for (const job of jobsOf(order)) {
      if (
        job.cuttingByUid === userId &&
        job.cuttingCompletedAt &&
        monthKey(job.cuttingCompletedAt.toDate()) === periodKey
      ) {
        const sheets = job.confirmedSheets ?? job.sheetQty ?? 0;
        sheetsCut += sheets;
        const category = categoryByMaterialId.get(job.materialId) ?? "ldsp";
        if (category === "hdf") hdfSheets += sheets;
        else if (category === "countertop") countertopSheets += sheets;
        else if (category === "mdf") mdfSheets += sheets;
        else ldspSheets += sheets;
        touchedThisOrder = true;
      }
      if (
        job.pvcByUid === userId &&
        job.pvcCompletedAt &&
        monthKey(job.pvcCompletedAt.toDate()) === periodKey
      ) {
        pvcMeters += job.pvcMeters ?? 0;
        touchedThisOrder = true;
      }
    }
    // Distinct from jobsOf() above — a МДФ order has no material lines at all, just up to 4
    // station jobs on the order itself (see MdfStage's doc comment in types/domain.ts).
    if (order.orderKind === "mdf_wrap" && order.mdfStageJobs) {
      for (const stage of MDF_STAGES) {
        const job = order.mdfStageJobs[stage];
        if (job?.byUid === userId && job.completedAt && monthKey(job.completedAt.toDate()) === periodKey) {
          mdfM2Processed += order.mdfAreaM2 ?? 0;
          touchedThisOrder = true;
        }
      }
    }
    // One completed order counts once, however many of its own lines this worker touched.
    if (touchedThisOrder) ordersCompleted += 1;
  }

  let presentDays = 0;
  let absentDays = 0;
  let workedHours = 0;
  for (const record of attendance) {
    if (record.userId !== userId || !record.date.startsWith(periodKey)) continue;
    if (record.status === "present" || record.status === "late") {
      presentDays += 1;
      workedHours += record.workedHours ?? 0;
    } else if (record.status === "absent") {
      absentDays += 1;
    }
    // "dayoff" and "sick" count as neither worked nor absent-for-deduction.
  }

  return {
    sheetsCut, ldspSheets, hdfSheets, countertopSheets, mdfSheets,
    pvcMeters, mdfM2Processed, ordersCompleted, presentDays, absentDays, workedHours,
  };
}

export interface SalaryComputation {
  mode: SalaryMode;
  baseTiyn: number;
  deductionTiyn: number;
}

/**
 * Piece-rate pay for cut sheets, charged per material category. ХДФ, countertops and МДФ fall
 * back to the plain sheet rate only when no category-specific rate is configured, so a shop that
 * pays one flat rate still works without setting every field — and the shop's actual rule (МДФ
 * priced the same as ЛДСП) is exactly what that fallback gives for free.
 */
function pieceRateTotal(rule: SalaryRule | undefined, work: SalaryWorkTotals): number {
  const base = rule?.perSheetTiyn ?? 0;
  const hdf = rule?.perHdfSheetTiyn ?? base;
  const countertop = rule?.perCountertopTiyn ?? base;
  const mdf = rule?.perMdfSheetTiyn ?? base;

  const categorised = work.ldspSheets + work.hdfSheets + work.countertopSheets + work.mdfSheets;
  // Totals measured before categories existed carry only sheetsCut. Paying 0 for them would
  // silently underpay, so an uncategorised total is treated as ЛДСП — the same fallback
  // measureWork() applies to a material with no category set.
  if (categorised === 0) return work.sheetsCut * base;

  return (
    work.ldspSheets * base + work.hdfSheets * hdf + work.countertopSheets * countertop + work.mdfSheets * mdf
  );
}

/**
 * Turns measured work into a base amount according to the worker's rule. Returns 0 for MANUAL —
 * the deliberate "no formula invented" default, where the final figure comes from an Admin
 * adjustment instead.
 */
export function computeSalaryBase(rule: SalaryRule | undefined, work: SalaryWorkTotals): SalaryComputation {
  const mode: SalaryMode = rule?.mode ?? "MANUAL";
  const round = (n: number) => Math.round(n);

  let baseTiyn = 0;
  switch (mode) {
    case "MANUAL":
      baseTiyn = 0;
      break;
    case "FIXED_MONTHLY":
      baseTiyn = rule?.fixedMonthlyTiyn ?? 0;
      break;
    case "PER_SHEET":
      baseTiyn = round(pieceRateTotal(rule, work));
      break;
    case "PER_PVC_METER":
      baseTiyn = round(work.pvcMeters * (rule?.perPvcMeterTiyn ?? 0));
      break;
    case "PER_MDF_M2":
      baseTiyn = round(work.mdfM2Processed * (rule?.perMdfM2Tiyn ?? 0));
      break;
    case "PER_ORDER":
      baseTiyn = round(work.ordersCompleted * (rule?.perOrderTiyn ?? 0));
      break;
    case "HOURLY":
      baseTiyn = round(work.workedHours * (rule?.hourlyTiyn ?? 0));
      break;
    case "MIXED":
      // Every configured component adds up; unset components contribute nothing.
      baseTiyn =
        (rule?.fixedMonthlyTiyn ?? 0) +
        round(pieceRateTotal(rule, work)) +
        round(work.pvcMeters * (rule?.perPvcMeterTiyn ?? 0)) +
        round(work.mdfM2Processed * (rule?.perMdfM2Tiyn ?? 0)) +
        round(work.ordersCompleted * (rule?.perOrderTiyn ?? 0)) +
        round(work.workedHours * (rule?.hourlyTiyn ?? 0));
      break;
  }

  // Attendance deductions never apply to MANUAL — an Admin typing the final number is already
  // accounting for absences themselves, and double-counting them would be wrong.
  const deductionTiyn =
    mode === "MANUAL" ? 0 : round(work.absentDays * (rule?.absentDayDeductionTiyn ?? 0));

  return { mode, baseTiyn, deductionTiyn };
}

/** base + bonus + adjustments − deductions, floored at zero (a payslip is never negative). */
export function computeFinalSalary(input: {
  baseTiyn: number;
  bonusTiyn: number;
  deductionTiyn: number;
  adjustmentTiyn: number;
}): number {
  return Math.max(0, input.baseTiyn + input.bonusTiyn + input.adjustmentTiyn - input.deductionTiyn);
}

/** Builds the full entry for one worker/month from rules, orders, attendance and adjustments. */
export function buildSalaryEntry(params: {
  userId: string;
  userName: string;
  periodKey: string;
  rule: SalaryRule | undefined;
  orders: Order[];
  attendance: AttendanceRecord[];
  categoryByMaterialId?: Map<string, MaterialCategory>;
  bonusTiyn?: number;
  adjustmentTiyn?: number;
}): Omit<SalaryEntry, "id" | "status"> {
  const work = measureWork(
    params.orders,
    params.attendance,
    params.userId,
    params.periodKey,
    params.categoryByMaterialId,
  );
  const { mode, baseTiyn, deductionTiyn } = computeSalaryBase(params.rule, work);
  const bonusTiyn = params.bonusTiyn ?? 0;
  const adjustmentTiyn = params.adjustmentTiyn ?? 0;

  return {
    userId: params.userId,
    userName: params.userName,
    periodKey: params.periodKey,
    mode,
    baseTiyn,
    ...work,
    bonusTiyn,
    deductionTiyn,
    adjustmentTiyn,
    finalTiyn: computeFinalSalary({ baseTiyn, bonusTiyn, deductionTiyn, adjustmentTiyn }),
  };
}

/**
 * Every month that has any activity, newest first — derived from the data itself so a new month
 * appears automatically. Always includes the current month so a fresh period is selectable before
 * any work has been recorded in it.
 */
export function availablePeriods(orders: Order[], attendance: AttendanceRecord[], now: Date = new Date()): string[] {
  const keys = new Set<string>([monthKey(now)]);
  for (const o of orders) {
    if (o.cuttingCompletedAt) keys.add(monthKey(o.cuttingCompletedAt.toDate()));
    if (o.pvcCompletedAt) keys.add(monthKey(o.pvcCompletedAt.toDate()));
    if (o.orderKind === "mdf_wrap" && o.mdfStageJobs) {
      for (const stage of MDF_STAGES) {
        const completedAt = o.mdfStageJobs[stage]?.completedAt;
        if (completedAt) keys.add(monthKey(completedAt.toDate()));
      }
    }
  }
  for (const a of attendance) keys.add(a.date.slice(0, 7));
  return [...keys].sort().reverse();
}

/** Today's date key in the shop's timezone — the id suffix for an attendance record. */
export function todayKey(): string {
  return dayKey(new Date());
}
