import { Link } from "react-router-dom";
import { formatMoney } from "../lib/money";
import { formatDateDMY } from "../lib/dates";
import { CASH_ACCOUNT_LABELS } from "../lib/cashbox";
import type { CashboxSummary } from "../lib/cashbox";
import type { ProfitSummary } from "../lib/orderProfit";
import { ProfitCard } from "./ProfitCard";
import type { CashAccount } from "../types/domain";

/**
 * The owner's phone home: what they earned, how much was cut, and where the money is — nothing
 * else. The desktop home keeps its charts and tables; on a phone those were a scroll of reports
 * to get past before reaching the three numbers actually opened it for.
 *
 * Every figure is shown with the sum behind it, because a number that cannot be checked on the
 * screen is a number that gets asked about. The Касса cards this replaces said "Қалдық 3 743 047
 * (оның ішінде бастапқы 4 253 791)" — a balance that "includes" a larger number — when what it
 * meant was бастапқы + түсті − шықты. That sum is what is drawn here.
 */
export function AdminPhoneSummary({
  profit,
  cashbox,
  openingBalanceTiyn,
  sheetsCut,
  startDate,
}: {
  /** Null when the purchase prices cannot be read (firestore.rules keeps them Admin-only) —
   *  there is no honest profit without them. */
  profit: ProfitSummary | null;
  /** All-time, so each balance is what is in that account now. */
  cashbox: CashboxSummary;
  openingBalanceTiyn: Partial<Record<CashAccount, number>>;
  /** ЛДСП only — the МДФ line cuts no sheets. */
  sheetsCut: { week: number; month: number } | null;
  /** ApplicationSettings.cashStartDate — the money figures count from it. */
  startDate: string | null;
}) {
  const since = startDate ? `${formatDateDMY(new Date(`${startDate}T12:00:00+05:00`))} бастап` : "Барлық уақыт";
  const totalOpening = cashbox.accounts.reduce((s, a) => s + (openingBalanceTiyn[a.account] ?? 0), 0);

  return (
    <div className="aps">
      {profit && <ProfitCard summary={profit} link />}

      {sheetsCut && (
        <section className="aps-sheets" aria-label="Кесілген лист">
          <div className="aps-card aps-tile">
            <span>Осы аптада кесілді</span>
            <strong>{sheetsCut.week} лист</strong>
          </div>
          <div className="aps-card aps-tile">
            <span>Осы айда кесілді</span>
            <strong>{sheetsCut.month} лист</strong>
          </div>
        </section>
      )}

      <section className="aps-card aps-money" aria-labelledby="aps-money-title">
        <div className="aps-head">
          <h2 id="aps-money-title">Қазір бізде бар ақша</h2>
          <span>{since}</span>
        </div>
        {cashbox.accounts.map((acc) => (
          <MoneyRow
            key={acc.account}
            className={`is-${acc.account}`}
            name={CASH_ACCOUNT_LABELS[acc.account]}
            balanceTiyn={acc.balanceTiyn}
            openingTiyn={openingBalanceTiyn[acc.account] ?? 0}
            inTiyn={acc.inTiyn}
            outTiyn={acc.outTiyn}
            detail={acc.byMethod.length > 1
              ? acc.byMethod.map((m) => `${m.methodName} ${formatMoney(m.amountTiyn)}`).join(" · ")
              : undefined}
          />
        ))}
        <MoneyRow
          className="is-total"
          name="Барлығы"
          balanceTiyn={cashbox.totalBalanceTiyn}
          openingTiyn={totalOpening}
          inTiyn={cashbox.totalInTiyn}
          outTiyn={cashbox.totalOutTiyn}
        />
      </section>

      <nav className="aps-links" aria-label="Толығырақ">
        <Link to="/manager/cashbox" className="btn btn-outline">Касса және шығындар</Link>
        {/* Заказдар left the phone bar for Таза пайда, and a phone has no side menu — this is the
            way to the orders from here. */}
        <Link to="/admin/orders" className="btn btn-outline">Заказдар</Link>
      </nav>
    </div>
  );
}

/** "Нұр 3 743 047 ₸" over the sum that makes it: бастапқы + түсті − шықты. */
function MoneyRow({
  className,
  name,
  balanceTiyn,
  openingTiyn,
  inTiyn,
  outTiyn,
  detail,
}: {
  className: string;
  name: string;
  balanceTiyn: number;
  openingTiyn: number;
  inTiyn: number;
  outTiyn: number;
  detail?: string;
}) {
  return (
    <div className={`aps-account ${className}`}>
      <div className="aps-account-head">
        <span>{name}</span>
        <strong className={balanceTiyn < 0 ? "is-negative" : undefined}>{formatMoney(balanceTiyn)}</strong>
      </div>
      <dl className="aps-flow">
        {openingTiyn > 0 && (
          <div>
            <dt>Бастапқы</dt>
            <dd>{formatMoney(openingTiyn)}</dd>
          </div>
        )}
        <div>
          <dt>+ Түсті</dt>
          <dd className="is-in">{formatMoney(inTiyn)}</dd>
        </div>
        <div>
          <dt>− Шықты</dt>
          <dd className={outTiyn > 0 ? "is-out" : undefined}>{formatMoney(outTiyn)}</dd>
        </div>
      </dl>
      {detail && <p className="aps-detail">{detail}</p>}
    </div>
  );
}
