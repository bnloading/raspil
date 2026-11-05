import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../../AuthContext";
import { Spinner } from "../../components";
import { AppShell } from "../../components/layout/AppShell";
import { CustomerOrderCard } from "../../components/CustomerOrderCard";
import { WorkshopActivityBoard } from "../../components/WorkshopActivityBoard";
import { useCustomerOrders } from "../../hooks/useOrders";
import { useCustomerDebts } from "../../hooks/useCustomerDebts";
import { formatMoney } from "../../lib/money";
import { customerOrderCode } from "../../lib/orderCode";
import { formatPhone } from "../../lib/phone";
import type { Order } from "../../types/domain";

/** How many cards a section shows before it hands over to the full list. */
const SECTION_LIMIT = 4;

/**
 * The customer's home: what they owe, what is ready to collect, and what is still in the shop.
 *
 * Rebuilt 05.11 on the owner's ask («клиент жағынан UI/UX қателерді жөндеп, drill қосып, соңғы
 * үлгідегі қылып істе; клиенттерге өз қарыздары көрінсін»): the debt leads, and every figure opens
 * what is behind it — the debt card the «Қарыз» page with each order's lines, a count its list,
 * a card its order. A customer whose orders the shop typed under their phone finds them here (the
 * journal attaches them, hooks/useCustomerAutoLink.ts); one who sees nothing is told the one thing
 * that fixes it — give the counter this phone.
 */
export default function CustomerDashboard() {
  const { user, userData } = useAuth();
  const { orders, loading } = useCustomerOrders(user?.uid);
  const { debtOf, owing, totals } = useCustomerDebts(orders);

  const placed = useMemo(() => orders.filter((o) => o.productionStatus !== "draft" && o.productionStatus !== "cancelled"), [orders]);
  const ready = placed.filter((o) => o.productionStatus === "ready");
  const inWork = placed.filter((o) => o.productionStatus !== "ready" && o.productionStatus !== "delivered");
  const drafts = orders.filter((o) => o.productionStatus === "draft");

  if (!user || !userData) return <Spinner />;

  return (
    <AppShell title="Басты бет" subtitle={`Сәлем, ${userData.name}!`} fab={{ to: "/order/new", label: "Жаңа заказ" }}>
      {loading ? (
        <Spinner />
      ) : placed.length === 0 ? (
        // Nothing to owe on and nothing to show — but "Бәрі төленген" here would be a claim the
        // page cannot make: the orders may simply not be under this phone yet.
        <section className="cust-empty is-welcome">
          <div className="icon">📭</div>
          <p><strong>Әзірге заказыңыз көрінбейді</strong></p>
          <p>
            Цехқа келгенде менеджерге осы телефон нөміріңізді айтыңыз
            {userData.phone && <> — <b className="cust-phone">{formatPhone(userData.phone)}</b></>}.
            Сол нөмірмен жазылған заказдарыңыз бен қарызыңыз осы жерде өзі шығады.
          </p>
        </section>
      ) : (
        <>
          <Link to="/debt" className={`cust-hero${totals.debtTiyn > 0 ? " is-owing" : " is-clear"}`}>
            <span className="cust-hero-label">{totals.debtTiyn > 0 ? "Қарызыңыз" : "Қарызыңыз жоқ"}</span>
            <strong className="cust-hero-amount">{totals.debtTiyn > 0 ? formatMoney(totals.debtTiyn) : "Бәрі төленген ✓"}</strong>
            {totals.cuttingDebtTiyn > 0 && totals.mdfDebtTiyn > 0 && (
              <span className="cust-hero-split">
                Распил {formatMoney(totals.cuttingDebtTiyn)} · МДФ {formatMoney(totals.mdfDebtTiyn)}
              </span>
            )}
            <span className="cust-hero-link">
              {totals.debtTiyn > 0 ? `${owing.length} заказ бойынша — толығырақ` : "Төлемдер тарихы"} →
            </span>
          </Link>

          <nav className="cust-stats" aria-label="Заказдарым">
            <Link to="/orders?bucket=active" className="cust-stat">
              <strong>{inWork.length}</strong><span>Жұмыста</span>
            </Link>
            <Link to="/orders?bucket=ready" className={`cust-stat${ready.length > 0 ? " is-ready" : ""}`}>
              <strong>{ready.length}</strong><span>Дайын</span>
            </Link>
            <Link to="/orders" className="cust-stat">
              <strong>{placed.length}</strong><span>Барлығы</span>
            </Link>
          </nav>

          <OrderSection title="Дайын — алып кетуге болады" tone="ready" orders={ready} debtOf={debtOf} more="/orders?bucket=ready" />
          <OrderSection title="Жұмыста" orders={inWork} debtOf={debtOf} more="/orders?bucket=active" />
        </>
      )}

      {/* The live board: the shop at work now, the customer's own orders picked out on it. */}
      <WorkshopActivityBoard myOrders={orders} />

      {drafts.length > 0 && (
        <section className="cust-section">
          <h2 className="cust-section-title">Жобалар <span>{drafts.length}</span></h2>
          <div className="cust-drafts">
            {drafts.map((o) => (
              <Link key={o.id} to={`/order/new?edit=${o.id}`} className="cust-draft">
                <strong>{customerOrderCode(o.orderNumber)}</strong>
                <span>Жалғастыру →</span>
              </Link>
            ))}
          </div>
        </section>
      )}

      <section className="cust-actions" aria-label="Онлайн тапсырыс">
        <Link to="/order/new" className="btn btn-primary">📐 Онлайн размер беру</Link>
        <Link to="/order/new?scan=1" className="btn btn-outline">📷 Фото арқылы енгізу</Link>
        <Link to="/order/mdf/new" className="btn btn-outline">🪵 МДФ тапсырыс беру</Link>
      </section>
    </AppShell>
  );
}

/** A titled run of order cards; past SECTION_LIMIT it hands over to the list, filtered the same. */
function OrderSection({
  title,
  orders,
  debtOf,
  more,
  tone,
}: {
  title: string;
  orders: Order[];
  debtOf: (o: Order) => number;
  more: string;
  tone?: "ready";
}) {
  if (orders.length === 0) return null;
  const shown = orders.slice(0, SECTION_LIMIT);
  return (
    <section className={`cust-section${tone ? ` is-${tone}` : ""}`}>
      <h2 className="cust-section-title">{title} <span>{orders.length}</span></h2>
      <div className="ocards">
        {shown.map((o) => <CustomerOrderCard key={o.id} order={o} debtTiyn={debtOf(o)} />)}
      </div>
      {orders.length > shown.length && (
        <Link to={more} className="cust-more">Тағы {orders.length - shown.length} заказ →</Link>
      )}
    </section>
  );
}
