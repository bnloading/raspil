import { useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../../AuthContext";
import { Spinner } from "../../components";
import { AppShell } from "../../components/layout/AppShell";
import { DonutChart } from "../../components/charts/DonutChart";
import { ProductionStatusBadge } from "../../components/StatusBadge";
import { IconOrders, IconReports, IconWarehouse, IconCut, IconPvc } from "../../components/layout/icons";
import { useAllOrders } from "../../hooks/useOrders";
import { useAllPayments } from "../../hooks/useReports";
import { formatMoney } from "../../lib/money";
import { formatDateDMY } from "../../lib/dates";
import { exportCsv } from "../../lib/exportTable";
import { computeKpis, computeProductionBreakdown, computeQueueOrders } from "../../lib/dashboardStats";

export default function ManagerDashboard() {
  const { userData } = useAuth();
  const navigate = useNavigate();
  const { orders, loading: ordersLoading } = useAllOrders();
  const { payments, loading: paymentsLoading } = useAllPayments();

  const loading = ordersLoading || paymentsLoading;

  const kpis = useMemo(
    () => computeKpis({ orders, payments, movements: [], materials: [] }),
    [orders, payments],
  );
  const breakdown = useMemo(() => computeProductionBreakdown(orders), [orders]);
  const breakdownTotal = breakdown.reduce((s, b) => s + b.value, 0);
  const recentOrders = useMemo(() => computeQueueOrders(orders, 8), [orders]);

  const counts = useMemo(() => {
    const submitted = orders.filter((o) => o.productionStatus === "submitted").length;
    const awaitingPrice = orders.filter((o) => o.productionStatus === "manager_review" && !o.pricePublished).length;
    const unpaid = orders.filter((o) => o.paymentStatus === "unpaid" && o.productionStatus !== "cancelled").length;
    const paid = orders.filter((o) => o.productionStatus === "paid").length;
    const cuttingQueue = orders.filter((o) => o.productionStatus === "cutting_queue").length;
    const pvcQueue = orders.filter((o) => o.productionStatus === "pvc_queue").length;
    const ready = orders.filter((o) => o.productionStatus === "ready").length;
    const totalDebtTiyn = orders.reduce((s, o) => s + (o.debtTiyn || 0), 0);
    return { submitted, awaitingPrice, unpaid, paid, cuttingQueue, pvcQueue, ready, totalDebtTiyn };
  }, [orders]);

  const handleExportOrders = () => {
    exportCsv(
      "заказдар",
      orders.map((o) => ({
        "Заказ №": o.orderNumber,
        Клиент: o.customerName,
        Телефон: o.customerPhone,
        Сома: o.totalTiyn / 100,
        Қарыз: o.debtTiyn / 100,
        Статус: o.productionStatus,
        Күні: o.createdAt ? formatDateDMY(o.createdAt) : "",
      })),
    );
  };

  if (!userData) return <Spinner />;

  return (
    <AppShell title="Басты бет" subtitle={`Сәлем, ${userData.name || "Менеджер"}`}>
      {loading ? (
        <Spinner />
      ) : (
        <>
          <div className="stat-grid">
            <div className="stat-card">
              <div className="stat-card-icon">
                <IconOrders />
              </div>
              <div className="number">{counts.submitted}</div>
              <div className="label">Жаңа заказдар</div>
            </div>
            <div className="stat-card">
              <div className="stat-card-icon">
                <IconReports />
              </div>
              <div className="number">{counts.awaitingPrice}</div>
              <div className="label">Баға күтуде</div>
            </div>
            <div className="stat-card">
              <div className="stat-card-icon">
                <IconWarehouse />
              </div>
              <div className="number">{counts.unpaid}</div>
              <div className="label">Төленбеген</div>
            </div>
            <div className="stat-card">
              <div className="stat-card-icon">
                <IconOrders />
              </div>
              <div className="number">{counts.paid}</div>
              <div className="label">Төленген (кезекке дайын)</div>
            </div>
            <div className="stat-card">
              <div className="stat-card-icon">
                <IconCut />
              </div>
              <div className="number">{counts.cuttingQueue}</div>
              <div className="label">Распил кезегінде</div>
            </div>
            <div className="stat-card">
              <div className="stat-card-icon">
                <IconPvc />
              </div>
              <div className="number">{counts.pvcQueue}</div>
              <div className="label">ПВХ кезегінде</div>
            </div>
            <div className="stat-card">
              <div className="stat-card-icon">
                <IconWarehouse />
              </div>
              <div className="number">{counts.ready}</div>
              <div className="label">Дайын</div>
            </div>
            <div className="stat-card">
              <div className="stat-card-icon">
                <IconReports />
              </div>
              <div className="number">{formatMoney(kpis.todayRevenueTiyn)}</div>
              <div className="label">Бүгінгі түсім</div>
            </div>
            <div className="stat-card">
              <div className="stat-card-icon">
                <IconWarehouse />
              </div>
              <div className="number">{formatMoney(counts.totalDebtTiyn)}</div>
              <div className="label">Жалпы қарыз</div>
            </div>
          </div>

          <div className="dashboard-grid">
            <div className="panel-card">
              <div className="chart-card-head">
                <h3>Өндіріс статусы</h3>
              </div>
              <DonutChart data={breakdown} centerLabel="Барлығы" centerValue={breakdownTotal} />
            </div>

            <div className="panel-card span-2">
              <div className="panel-head">
                <h3>Соңғы заказдар</h3>
                <Link to="/manager/orders" className="link-button">
                  Барлығы →
                </Link>
              </div>
              {recentOrders.length === 0 ? (
                <p className="chart-empty">Заказдар жоқ</p>
              ) : (
                <div className="data-table-wrap">
                  <table className="data-table stack-mobile stack-compact">
                    <thead>
                      <tr>
                        <th>№</th>
                        <th>Клиент</th>
                        <th className="num">Сома</th>
                        <th>Статус</th>
                        <th>Күні</th>
                      </tr>
                    </thead>
                    <tbody>
                      {recentOrders.map((o) => (
                        <tr key={o.id} className="clickable" onClick={() => navigate(`/manager/order/${o.id}`)}>
                          <td data-label="№">{o.orderNumber}</td>
                          <td data-label="Клиент">{o.customerName}</td>
                          <td className="num" data-label="Сома">
                            {formatMoney(o.totalTiyn)}
                          </td>
                          <td data-label="Статус">
                            <ProductionStatusBadge status={o.productionStatus} />
                          </td>
                          <td data-label="Күні">{o.createdAt ? formatDateDMY(o.createdAt) : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="panel-card">
              <div className="panel-head">
                <h3>Жылдам әрекеттер</h3>
              </div>
              <div className="quick-actions">
                <Link className="quick-action-btn" to="/manager/orders?status=manager_review">
                  <IconReports />
                  Баға есептеу
                </Link>
                <Link className="quick-action-btn" to="/manager/orders?status=waiting_payment">
                  <IconWarehouse />
                  Төлем енгізу
                </Link>
                <Link className="quick-action-btn" to="/manager/orders?status=paid">
                  <IconCut />
                  Кезекке жіберу
                </Link>
                <Link className="quick-action-btn" to="/manager/orders">
                  <IconOrders />
                  Барлық заказдар
                </Link>
                <button type="button" className="quick-action-btn" onClick={handleExportOrders}>
                  <IconReports />
                  CSV жүктеу
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </AppShell>
  );
}
