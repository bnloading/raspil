import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../../AuthContext";
import { Spinner } from "../../components";
import { AppShell } from "../../components/layout/AppShell";
import { ProductionStatusBadge } from "../../components/StatusBadge";
import { getCustomerStageLabel } from "../../components/CustomerStatusCard";
import { WorkshopActivityBoard } from "../../components/WorkshopActivityBoard";
import { useCustomerOrders } from "../../hooks/useOrders";
import { formatMoney } from "../../lib/money";
import { formatDateDMY } from "../../lib/dates";

export default function CustomerDashboard() {
  const { user, userData } = useAuth();
  const { orders, loading } = useCustomerOrders(user?.uid);

  const drafts = useMemo(() => orders.filter((o) => o.productionStatus === "draft"), [orders]);
  const active = useMemo(
    () => orders.filter((o) => !["draft", "delivered", "cancelled"].includes(o.productionStatus)),
    [orders],
  );
  const ready = useMemo(() => orders.filter((o) => o.productionStatus === "ready"), [orders]);
  // Debt only counts orders that can still be collected on — a cancelled order owes nothing.
  const totalDebt = useMemo(
    () =>
      orders
        .filter((o) => o.productionStatus !== "cancelled" && o.productionStatus !== "draft")
        .reduce((sum, o) => sum + Math.max(0, o.debtTiyn || 0), 0),
    [orders],
  );
  const myOrderNumbers = useMemo(() => orders.map((o) => o.orderNumber), [orders]);

  if (!user || !userData) return <Spinner />;

  return (
    <AppShell title="Басты бет" subtitle={`Сәлем, ${userData.name}!`} fab={{ to: "/order/new", label: "Жаңа заказ" }}>
      <div className="stats-bar">
        <div className="stat-card">
          <div className="number">{active.length}</div>
          <div className="label">Белсенді</div>
        </div>
        <div className="stat-card">
          <div className="number">{ready.length}</div>
          <div className="label">Дайын</div>
        </div>
        <div className="stat-card">
          <div className="number">{formatMoney(totalDebt)}</div>
          <div className="label">Қарыз</div>
        </div>
      </div>

      {totalDebt > 0 && (
        <Link to="/debt" className="panel-card customer-debt-card">
          <span className="customer-debt-label">Жалпы қарызыңыз</span>
          <strong className="customer-debt-amount">{formatMoney(totalDebt)}</strong>
          <span className="customer-debt-link">Толығырақ →</span>
        </Link>
      )}

      {/* The workshop board leads: a customer who never places an order online still gets a
          useful page — live shop progress, their own orders highlighted. Submitting dimensions
          is offered below as an option, never forced. */}
      <WorkshopActivityBoard myOrderNumbers={myOrderNumbers} />

      <div className="orders-section customer-optional-actions">
        <Link to="/order/new" className="btn btn-primary">
          📐 Онлайн размер беру
        </Link>
        <Link to="/order/new?scan=1" className="btn btn-outline">
          📷 Фото арқылы енгізу
        </Link>
      </div>

      {drafts.length > 0 && (
        <div className="orders-section">
          <div className="section-title-row">
            <div className="section-title">Жобалар</div>
            <span>{drafts.length}</span>
          </div>
          {drafts.map((o) => (
            <Link key={o.id} to={`/order/${o.id}`} className="track-card">
              <div className="track-card-header">
                <span className="track-card-num">{o.orderNumber}</span>
                <ProductionStatusBadge status={o.productionStatus} />
              </div>
            </Link>
          ))}
        </div>
      )}

      <div className="orders-section">
        <div className="section-title-row">
          <div className="section-title">Менің заказдарым</div>
          <Link to="/orders">Барлығы →</Link>
        </div>
        {loading ? (
          <Spinner />
        ) : orders.length === 0 ? (
          <div className="empty-state">
            <div className="icon">📭</div>
            <p>
              Сізде әлі заказ жоқ
              <br />
              Цехтағы жұмысты жоғарыдан бақылай аласыз
            </p>
          </div>
        ) : (
          orders.slice(0, 5).map((o) => (
            <Link key={o.id} to={`/order/${o.id}`} className="track-card">
              <div className="track-card-header">
                <span className="track-card-num">{o.orderNumber}</span>
                <ProductionStatusBadge status={o.productionStatus} />
              </div>
              <div className="track-card-meta-row">
                <span>{getCustomerStageLabel(o.productionStatus, o.pvcMetersTotal > 0)}</span>
                {o.pricePublished ? <span>{formatMoney(o.totalTiyn)}</span> : <span>Баға есептелуде...</span>}
                {o.createdAt && <span>{formatDateDMY(o.createdAt)}</span>}
              </div>
            </Link>
          ))
        )}
      </div>
    </AppShell>
  );
}
