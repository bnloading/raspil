import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../../AuthContext";
import { Spinner } from "../../components";
import { AppShell } from "../../components/layout/AppShell";
import { PaymentStatusBadge } from "../../components/StatusBadge";
import { useCustomerOrders } from "../../hooks/useOrders";
import { usePaymentsForOrders } from "../../hooks/usePayments";
import { formatMoney } from "../../lib/money";
import { formatDateDMY, formatDateTimeDMY } from "../../lib/dates";

/**
 * "Қарыз" for the logged-in customer only. Every figure is derived from their own orders and
 * payments — nothing is stored as a hand-typed debt value that could drift out of sync with the
 * Manager journal, order details or reports.
 */
export default function CustomerDebt() {
  const { user, userData } = useAuth();
  const { orders, loading } = useCustomerOrders(user?.uid);

  const billable = useMemo(
    () => orders.filter((o) => o.productionStatus !== "cancelled" && o.productionStatus !== "draft"),
    [orders],
  );
  // Scoped to this customer's own order ids — see usePaymentsForOrders for why an unfiltered
  // payments query would be rejected outright for a customer.
  const { byOrder } = usePaymentsForOrders(useMemo(() => billable.map((o) => o.id), [billable]));
  const unpaid = useMemo(() => billable.filter((o) => o.debtTiyn > 0), [billable]);
  const totals = useMemo(
    () => ({
      ordered: billable.reduce((s, o) => s + o.totalTiyn, 0),
      paid: billable.reduce((s, o) => s + o.paidTiyn, 0),
      debt: billable.reduce((s, o) => s + Math.max(0, o.debtTiyn), 0),
    }),
    [billable],
  );

  const history = useMemo(() => {
    const rows = billable.flatMap((o) =>
      (byOrder.get(o.id) ?? []).map((p) => ({ payment: p, orderNumber: o.orderNumber })),
    );
    return rows.sort(
      (a, b) => (b.payment.paymentDate?.toMillis() ?? 0) - (a.payment.paymentDate?.toMillis() ?? 0),
    );
  }, [billable, byOrder]);

  if (!user || !userData) return <Spinner />;
  if (loading) return <Spinner />;

  return (
    <AppShell title="Қарыз" subtitle={userData.name} back="/dashboard">
      <div className="panel-card customer-debt-hero">
        <span className="customer-debt-label">Жалпы қарызыңыз</span>
        <div className={`customer-debt-total${totals.debt > 0 ? " is-owing" : " is-clear"}`}>
          {formatMoney(totals.debt)}
        </div>
        <div className="customer-debt-breakdown">
          <div><span>Жалпы заказ сомасы</span><strong>{formatMoney(totals.ordered)}</strong></div>
          <div><span>Төленгені</span><strong>{formatMoney(totals.paid)}</strong></div>
          <div><span>Төленбеген заказ</span><strong>{unpaid.length}</strong></div>
        </div>
      </div>

      <div className="orders-section">
        <div className="section-title-row">
          <div className="section-title">Заказ бойынша қарыз</div>
        </div>
        {unpaid.length === 0 ? (
          <div className="empty-state">
            <div className="icon">✅</div>
            <p>Қарызыңыз жоқ. Барлық заказ толық төленген.</p>
          </div>
        ) : (
          unpaid.map((o) => (
            <Link key={o.id} to={`/order/${o.id}`} className="track-card">
              <div className="track-card-header">
                <span className="track-card-num">{o.orderNumber}</span>
                <PaymentStatusBadge status={o.paymentStatus} />
              </div>
              <div className="track-card-meta-row">
                <span>Сомасы: {formatMoney(o.totalTiyn)}</span>
                <span>Төленді: {formatMoney(o.paidTiyn)}</span>
              </div>
              <div className="track-card-meta-row">
                <strong className="jt-debt">Қалдық: {formatMoney(o.debtTiyn)}</strong>
                {o.createdAt && <span>{formatDateDMY(o.createdAt)}</span>}
              </div>
            </Link>
          ))
        )}
      </div>

      <div className="orders-section">
        <div className="section-title-row">
          <div className="section-title">Төлем тарихы</div>
        </div>
        {history.length === 0 ? (
          <div className="empty-state">
            <div className="icon">🧾</div>
            <p>Төлем тарихы бос</p>
          </div>
        ) : (
          <div className="data-list">
            {history.map(({ payment, orderNumber }) => (
              <div key={payment.id} className={`data-row${payment.reversed ? " blocked" : ""}`}>
                <div className="data-row-main">
                  <strong>
                    {formatMoney(payment.amountTiyn)} · {payment.methodName}
                  </strong>
                  <span>
                    {orderNumber}
                    {payment.paymentDate ? ` · ${formatDateTimeDMY(payment.paymentDate)}` : ""}
                  </span>
                  {payment.reversed && <span>❌ Қайтарылды: {payment.reversalReason}</span>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}
