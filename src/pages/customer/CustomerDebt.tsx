import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../../AuthContext";
import { Spinner } from "../../components";
import { AppShell } from "../../components/layout/AppShell";
import { CustomerOrderBreakdown } from "../../components/CustomerOrderBreakdown";
import { useCustomerOrders } from "../../hooks/useOrders";
import { useCustomerDebts } from "../../hooks/useCustomerDebts";
import { formatMoney } from "../../lib/money";
import { customerOrderCode } from "../../lib/orderCode";
import { formatDateDMY, formatDateTimeDMY } from "../../lib/dates";

/**
 * "Қарыз" for the logged-in customer only — what they owe, and on which orders.
 *
 * Every figure comes from their own orders and the payments against them, the way the journal
 * works its own «Қарыз» out (hooks/useCustomerDebts.ts), so the two never disagree. Each owing
 * order opens in place — the drill-down the owner asked for (05.11): its lines at their prices,
 * the payments made on it, and the link to the full order page.
 */
export default function CustomerDebt() {
  const { user, userData } = useAuth();
  const { orders, loading } = useCustomerOrders(user?.uid);
  const [open, setOpen] = useState<string | null>(null);

  const { billable, owing, payments, paymentsByOrder, paidOf, debtOf, totals } = useCustomerDebts(orders);
  const history = useMemo(
    () => payments
      .filter((p) => !p.reversed)
      .map((p) => ({ payment: p, order: billable.find((o) => o.id === p.orderId) }))
      .sort((a, b) => (b.payment.paymentDate?.toMillis() ?? 0) - (a.payment.paymentDate?.toMillis() ?? 0)),
    [payments, billable],
  );

  if (!user || !userData) return <Spinner />;
  if (loading) return <Spinner />;

  return (
    <AppShell title="Қарыз" subtitle={userData.name} back="/dashboard">
      <section className={`cust-hero${totals.debtTiyn > 0 ? " is-owing" : " is-clear"}`}>
        <span className="cust-hero-label">{totals.debtTiyn > 0 ? "Жалпы қарызыңыз" : "Қарызыңыз жоқ"}</span>
        <strong className="cust-hero-amount">{totals.debtTiyn > 0 ? formatMoney(totals.debtTiyn) : "Бәрі төленген ✓"}</strong>
        {totals.cuttingDebtTiyn > 0 && totals.mdfDebtTiyn > 0 && (
          <span className="cust-hero-split">Распил {formatMoney(totals.cuttingDebtTiyn)} · МДФ {formatMoney(totals.mdfDebtTiyn)}</span>
        )}
        <dl className="cust-hero-facts">
          <div><dt>Заказ сомасы</dt><dd>{formatMoney(totals.orderedTiyn)}</dd></div>
          <div><dt>Төленгені</dt><dd>{formatMoney(totals.paidTiyn)}</dd></div>
          <div><dt>Төленбеген</dt><dd>{owing.length} заказ</dd></div>
        </dl>
      </section>

      <section className="cust-section">
        <h2 className="cust-section-title">Заказ бойынша қарыз</h2>
        {owing.length === 0 ? (
          <div className="cust-empty">
            <div className="icon">✅</div>
            <p>Барлық заказ толық төленген.</p>
          </div>
        ) : (
          owing.map((o) => {
            const expanded = open === o.id;
            const own = (paymentsByOrder.get(o.id) ?? []).filter((p) => !p.reversed);
            return (
              <article key={o.id} className={`cust-debt-row${expanded ? " is-open" : ""}`}>
                <button type="button" className="cust-debt-head" aria-expanded={expanded}
                  onClick={() => setOpen(expanded ? null : o.id)}>
                  <span className="cust-debt-id">
                    <strong>{customerOrderCode(o.orderNumber)}</strong>
                    {o.orderKind === "mdf_wrap" && <span className="jt-pill jt-tone-muted">МДФ</span>}
                    {o.createdAt && <small>{formatDateDMY(o.createdAt)}</small>}
                  </span>
                  <span className="cust-debt-sum">
                    <strong>{formatMoney(debtOf(o))}</strong>
                    <small>{formatMoney(o.totalTiyn)} заказдан</small>
                  </span>
                  <span className="cust-debt-chevron" aria-hidden="true">{expanded ? "▾" : "▸"}</span>
                </button>
                {expanded && (
                  <div className="cust-debt-body">
                    <CustomerOrderBreakdown order={o} paidTiyn={paidOf(o)} />
                    {own.length > 0 && (
                      <ul className="cust-pay-list">
                        {own.map((p) => (
                          <li key={p.id}>
                            <span>{p.paymentDate ? formatDateTimeDMY(p.paymentDate) : "—"} · {p.methodName}</span>
                            <strong>{formatMoney(p.amountTiyn)}</strong>
                          </li>
                        ))}
                      </ul>
                    )}
                    <Link to={`/order/${o.id}`} className="btn btn-outline btn-sm">Заказды ашу →</Link>
                  </div>
                )}
              </article>
            );
          })
        )}
      </section>

      <section className="cust-section">
        <h2 className="cust-section-title">Төлем тарихы</h2>
        {history.length === 0 ? (
          <div className="cust-empty">
            <div className="icon">🧾</div>
            <p>Әзірге төлем жоқ</p>
          </div>
        ) : (
          <ul className="cust-pay-list is-history">
            {history.map(({ payment, order }) => (
              <li key={payment.id}>
                <span>
                  {payment.paymentDate ? formatDateTimeDMY(payment.paymentDate) : "—"} · {payment.methodName}
                  {order && <small>{customerOrderCode(order.orderNumber)}</small>}
                </span>
                <strong>{formatMoney(payment.amountTiyn)}</strong>
              </li>
            ))}
          </ul>
        )}
      </section>
    </AppShell>
  );
}
