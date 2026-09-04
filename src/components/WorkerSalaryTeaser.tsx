import { Link } from "react-router-dom";
import { useSalaryEntries, useSalaryRule, useAttendance } from "../hooks/useSalary";
import { useMaterials } from "../hooks/useMaterials";
import { monthKey } from "../lib/dates";
import { formatMoney } from "../lib/money";
import { computeSalaryBase, measureWork } from "../lib/salary";
import type { Order } from "../types/domain";

/**
 * "Осы айдағы айлық" on a worker's own panel — the first thing they should see after signing in.
 *
 * An Admin's recalculation writes an authoritative salaryEntry, and that always wins. But that
 * only happens at month end, so before it the card computes the same figure live from the worker's
 * own rule and their own completed orders. Without that fallback a worker sees nothing at all for
 * most of the month, which is what they actually complained about.
 *
 * Everything read here is readable by the worker themselves under firestore.rules: their own
 * salaryRule (`get` on their uid), their own attendance and entries, and the orders already loaded
 * by the dashboard. Nothing here can show another worker's pay.
 */
export function WorkerSalaryTeaser({
  uid,
  orders = [],
  hideSalary = false,
}: {
  uid: string;
  orders?: Order[];
  hideSalary?: boolean;
}) {
  const { entries } = useSalaryEntries(uid);
  const { rule } = useSalaryRule(uid);
  const { records } = useAttendance(uid);
  const { materials } = useMaterials(false);

  if (hideSalary) return null;

  const period = monthKey(new Date());
  const entry = entries.find((e) => e.periodKey === period);

  const categoryByMaterialId = new Map(materials.map((m) => [m.id, m.category ?? "ldsp"] as const));
  const work = measureWork(orders, records, uid, period, categoryByMaterialId);
  const live = computeSalaryBase(rule, work);

  // Confirmed figure if there is one; otherwise the live estimate, which is only worth showing
  // once a rule exists — a MANUAL worker has no formula, so there is nothing honest to display.
  const amountTiyn = entry ? entry.finalTiyn : live.baseTiyn - live.deductionTiyn;
  const isEstimate = !entry;
  if (!entry && (!rule || rule.mode === "MANUAL")) return null;

  const detail =
    rule?.mode === "FIXED_MONTHLY"
      ? "Тұрақты айлық"
      : work.mdfM2Processed > 0
        ? `${work.mdfM2Processed} м² МДФ өңделді`
        : work.sheetsCut > 0
          ? `${work.sheetsCut} лист кесілді`
          : "Әзірге жұмыс жоқ";

  return (
    <Link to="/salary" className="worker-stat-card worker-salary-teaser">
      <div>
        <div className="worker-stat-cap">
          Осы айдағы айлық{isEstimate && <span className="worker-salary-est"> · болжам</span>}
        </div>
        <div className="worker-salary-amount">{formatMoney(amountTiyn)}</div>
        <div className="worker-salary-detail">{detail}</div>
        <span className="worker-salary-link">Толығырақ →</span>
      </div>
    </Link>
  );
}
