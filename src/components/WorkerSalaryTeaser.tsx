import { Link } from "react-router-dom";
import { useSalaryEntries } from "../hooks/useSalary";
import { monthKey } from "../lib/dates";
import { formatMoney } from "../lib/money";

/**
 * The "Осы айдағы айлық" card on a worker's panel. Renders nothing until a salary entry for the
 * current month actually exists, so a shop that hasn't configured salaries yet simply doesn't see
 * the card rather than seeing a hollow "0 ₸".
 */
export function WorkerSalaryTeaser({ uid }: { uid: string }) {
  const { entries } = useSalaryEntries(uid);
  const period = monthKey(new Date());
  const entry = entries.find((e) => e.periodKey === period);

  if (!entry) return null;

  return (
    <Link to="/salary" className="worker-stat-card worker-salary-teaser">
      <div>
        <div className="worker-stat-cap">Осы айдағы айлық</div>
        <div className="worker-salary-amount">{formatMoney(entry.finalTiyn)}</div>
        <span className="worker-salary-link">Толығырақ →</span>
      </div>
    </Link>
  );
}
