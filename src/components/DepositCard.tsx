import { formatMoney } from "../lib/money";
import { monthLabel } from "../lib/dates";
import { formatStartDate } from "../lib/orderProfit";
import type { AccountSummary } from "../lib/cashbox";

/**
 * "Нұрдағы ақша" — what is on the deposit account right now, big, at the head of the Таза пайда
 * page: the owner reads the two together, what was earned and what is actually there.
 *
 * The balance is the Касса page's own "Қазір бізде бар" for Нұр, with the sum under it —
 * бастапқы + түсті − шықты — so it can be checked against the bank. The current month's own flow
 * is added only when it differs from that sum, i.e. once the books span more than one month.
 */
export function DepositCard({
  now,
  month,
  monthKey,
  openingTiyn,
  startDate,
}: {
  /** Нұр, all time from the accounting restart. */
  now: AccountSummary;
  /** Нұр, this month only. */
  month: AccountSummary;
  monthKey: string;
  openingTiyn: number;
  startDate: string | null;
}) {
  const monthIsEverything = month.inTiyn === now.inTiyn && month.outTiyn === now.outTiyn;

  return (
    <section className="aps-card aps-deposit" aria-labelledby="aps-deposit-title">
      <div className="aps-head">
        <h2 id="aps-deposit-title">Нұрдағы ақша</h2>
        <span>Депозит</span>
      </div>
      <strong className={`aps-big is-money${now.balanceTiyn < 0 ? " is-negative" : ""}`}>
        {formatMoney(now.balanceTiyn)}
      </strong>
      <p className="aps-sub">
        {startDate ? `${formatStartDate(startDate)} бастап` : "Барлық уақыт"}
        {monthIsEverything ? ` · ${monthLabel(monthKey)}` : ""}
      </p>
      <dl className="aps-flow">
        {openingTiyn > 0 && (
          <div>
            <dt>Бастапқы</dt>
            <dd>{formatMoney(openingTiyn)}</dd>
          </div>
        )}
        <div>
          <dt>+ Түсті</dt>
          <dd className="is-in">{formatMoney(now.inTiyn)}</dd>
        </div>
        <div>
          <dt>− Шықты</dt>
          <dd className={now.outTiyn > 0 ? "is-out" : undefined}>{formatMoney(now.outTiyn)}</dd>
        </div>
      </dl>
      {!monthIsEverything && (
        <p className="aps-detail">
          {monthLabel(monthKey)}: түсті {formatMoney(month.inTiyn)} · шықты {formatMoney(month.outTiyn)}
        </p>
      )}
    </section>
  );
}
