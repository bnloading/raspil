import { useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../../AuthContext";
import { Spinner } from "../../components";
import { AppShell } from "../../components/layout/AppShell";
import { AttendanceTodayCard } from "../../components/AttendanceTodayCard";
import { DonutChart } from "../../components/charts/DonutChart";
import { LineChart } from "../../components/charts/LineChart";
import { ProductionStatusBadge } from "../../components/StatusBadge";
import {
  IconOrders,
  IconWarehouse,
  IconReports,
  IconUsers,
  IconAudit,
  IconCut,
} from "../../components/layout/icons";
import { useAllOrders } from "../../hooks/useOrders";
import { useAllPayments, useAllInventoryMovements } from "../../hooks/useReports";
import { useMaterials } from "../../hooks/useMaterials";
import { useExpenseCategories } from "../../hooks/useExpenseCategories";
import { useExpenses } from "../../hooks/useExpenses";
import { useMaterialCosts } from "../../hooks/useMaterialCosts";
import { useAppSettings } from "../../hooks/useAppSettings";
import { formatMoney } from "../../lib/money";
import { formatDateDMY } from "../../lib/dates";
import { exportCsv } from "../../lib/exportTable";
import {
  computeIncomeAllocation,
  computeKpis,
  computeLowStock,
  computeMonthlyRevenue,
  computeProductionBreakdown,
  computePaymentSummary,
  computeQueueOrders,
} from "../../lib/dashboardStats";
import { computeFinanceSummary } from "../../lib/finance";
import { departmentOf, departmentOfOrder } from "../../lib/rbac";

export default function AdminHome() {
  const { userData } = useAuth();
  const myDepartment = userData ? departmentOf(userData) : "ldsp";
  // Cut sheets and sheet stock are распил concepts — the МДФ line wraps panels by m² and keeps no
  // sheet inventory, so these read as ЛДСП figures no matter who is looking. Hidden rather than
  // zeroed for a МДФ viewer, exactly as AdminReports.tsx hides its ЛДСП-only tabs.
  const isLdsp = myDepartment === "ldsp";
  const navigate = useNavigate();
  const { orders: allOrders, loading: ordersLoading } = useAllOrders();
  const { payments: allPayments, loading: paymentsLoading } = useAllPayments();
  // Home page stays scoped to the viewer's own line, same as ManagerDashboard — a МДФ admin's home
  // never shows ЛДСП revenue/queue and vice versa (lib/rbac.ts departmentOf()/departmentOfOrder()).
  const orders = useMemo(() => allOrders.filter((o) => departmentOfOrder(o) === myDepartment), [allOrders, myDepartment]);
  const orderDeptById = useMemo(() => new Map(allOrders.map((o) => [o.id, departmentOfOrder(o)])), [allOrders]);
  const payments = useMemo(
    () => allPayments.filter((p) => (orderDeptById.get(p.orderId) ?? "ldsp") === myDepartment),
    [allPayments, orderDeptById, myDepartment],
  );
  const { movements, loading: movementsLoading } = useAllInventoryMovements();
  const { materials, loading: materialsLoading } = useMaterials(false);
  const { categories: expenseCategories, loading: expenseCategoriesLoading } = useExpenseCategories();
  const { expenses: allExpenses, loading: expensesLoading } = useExpenses();
  const expenses = useMemo(
    () => allExpenses.filter((e) => (e.department ?? "ldsp") === myDepartment),
    [allExpenses, myDepartment],
  );
  // Таза пайда needs the shop's purchase prices, which firestore.rules keeps Admin-only — this
  // page is already Admin-only, so the listen always succeeds, but the same available flag
  // AdminReports.tsx checks is read here too rather than assumed, in case that ever changes.
  const { costs: purchaseByMaterialId, available: netProfitVisible, loading: costsLoading } = useMaterialCosts();
  const { settings } = useAppSettings();

  const loading = ordersLoading || paymentsLoading || movementsLoading || materialsLoading
    || expenseCategoriesLoading || expensesLoading || costsLoading;

  const kpis = useMemo(
    () => computeKpis({ orders, payments, movements, materials }),
    [orders, payments, movements, materials],
  );
  const lowStock = useMemo(() => computeLowStock(materials).slice(0, 6), [materials]);
  const monthlyRevenue = useMemo(() => computeMonthlyRevenue(orders), [orders]);
  const breakdown = useMemo(() => computeProductionBreakdown(orders), [orders]);
  const paymentSummary = useMemo(() => computePaymentSummary(orders), [orders]);
  const queueOrders = useMemo(() => computeQueueOrders(orders, 8), [orders]);
  const breakdownTotal = breakdown.reduce((s, b) => s + b.value, 0);
  const incomeAllocation = useMemo(
    () => computeIncomeAllocation(expenseCategories, kpis.monthRevenueTiyn),
    [expenseCategories, kpis.monthRevenueTiyn],
  );
  // Барлық уақыт, not the current month — same reasoning as AdminReports.tsx's Қаржы tab: the
  // owner reads Таза пайда as a running total, so a month-scoped figure here would just be a
  // second, differently-answered "how much have we made" sitting next to Бүгінгі табыс.
  const netProfit = useMemo(
    () => computeFinanceSummary({
      orders, payments, purchaseByMaterialId, categories: expenseCategories, expenses,
      period: null, startDate: settings.cashStartDate ?? null,
    }),
    [orders, payments, purchaseByMaterialId, expenseCategories, expenses, settings.cashStartDate],
  );

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
    <AppShell title="Басты бет" subtitle={`Сәлем, ${userData.name || "Админ"}`}>
      {loading ? (
        <Spinner />
      ) : (
        <>
          <div className="stat-grid">
            <div className="stat-card">
              <div className="stat-card-icon">
                <IconOrders />
              </div>
              <div className="number">{kpis.todayOrders}</div>
              <div className="label">Бүгінгі заказ</div>
            </div>
            <div className="stat-card">
              <div className="stat-card-icon">
                <IconAudit />
              </div>
              <div className="number">{kpis.queueCount}</div>
              <div className="label">Кезекте</div>
            </div>
            <div className="stat-card">
              <div className="stat-card-icon">
                <IconReports />
              </div>
              <div className="number">{formatMoney(kpis.todayRevenueTiyn)}</div>
              <div className="label">Бүгінгі табыс</div>
            </div>
            <div className="stat-card">
              <div className="stat-card-icon">
                <IconWarehouse />
              </div>
              <div className="number">{formatMoney(kpis.totalDebtTiyn)}</div>
              <div className="label">Қарыз</div>
            </div>
            {isLdsp && (
              <div className="stat-card">
                <div className="stat-card-icon">
                  <IconCut />
                </div>
                <div className="number">{kpis.sheetsMonth}</div>
                <div className="label">Кесілген лист</div>
              </div>
            )}
            {/* Material purchase prices are Admin-only (firestore.rules) — this page already is,
                so netProfitVisible is normally true, but the card still hides itself on the flag
                rather than ever showing revenue mislabelled as profit. See useMaterialCosts.ts. */}
            {netProfitVisible && (
              <div className="stat-card">
                <div className="stat-card-icon">
                  <IconReports />
                </div>
                <div className="number">{formatMoney(netProfit.netProfitTiyn)}</div>
                <div className="label">Таза пайда (барлық уақыт)</div>
                {/* Billed, not collected — an order cut on credit counts here the day it is
                    written. Without this line the card reads as cash in hand. */}
                {netProfit.debtTiyn > 0 && (
                  <div className="stat-card-note">
                    оның {formatMoney(netProfit.debtTiyn)} — әлі төленбеген
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Ahead of the charts: the register is a thing to do this morning, the charts are
              things to read whenever. */}
          <AttendanceTodayCard />

          <div className="dashboard-grid">
            <div className="panel-card span-2">
              <div className="chart-card-head">
                <h3>Айлық табыс динамикасы</h3>
              </div>
              <LineChart data={monthlyRevenue} valueFormatter={(v) => formatMoney(Math.round(v * 100))} />
            </div>

            <div className="panel-card">
              <div className="chart-card-head">
                <h3>Өндіріс статусы</h3>
              </div>
              <DonutChart data={breakdown} centerLabel="Барлығы" centerValue={breakdownTotal} />
            </div>

            <div className="panel-card">
              <div className="chart-card-head">
                <h3>Кіріс бөлінісі</h3>
              </div>
              <DonutChart data={incomeAllocation} centerLabel="Айлық" centerValue={formatMoney(kpis.monthRevenueTiyn)} />
            </div>

            {isLdsp && (
            <div className="panel-card">
              <div className="panel-head">
                <h3>Материал қоры</h3>
                <Link to="/admin/materials" className="link-button">
                  Барлығы →
                </Link>
              </div>
              {lowStock.length === 0 ? (
                <p className="chart-empty">Тапшылық жоқ</p>
              ) : (
                <div className="stock-list">
                  {lowStock.map((m) => {
                    const available = m.qtyOnHand - m.reservedQty;
                    const pct = m.minStock > 0 ? Math.min(100, Math.max(4, (available / m.minStock) * 100)) : 4;
                    return (
                      <div key={m.id} className="stock-row">
                        <div className="stock-row-head">
                          <span>{m.name}</span>
                          <strong className={available <= 0 ? "warehouse-low" : undefined}>
                            {available} / {m.minStock}
                          </strong>
                        </div>
                        <div className="stock-bar">
                          <div className="stock-bar-fill" style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            )}

            <div className="panel-card span-2">
              <div className="panel-head">
                <h3>Қазіргі заказдар кезегі</h3>
                <Link to="/admin/orders" className="link-button">
                  Барлығы →
                </Link>
              </div>
              {queueOrders.length === 0 ? (
                <p className="chart-empty">Кезекте заказ жоқ</p>
              ) : (
                <div className="data-table-wrap">
                  <table className="data-table stack-mobile stack-compact">
                    <thead>
                      <tr>
                        <th>№</th>
                        <th>Клиент</th>
                        <th>Материал</th>
                        <th className="num">Сома</th>
                        <th>Статус</th>
                        <th>Күні</th>
                      </tr>
                    </thead>
                    <tbody>
                      {queueOrders.map((o) => (
                        <tr key={o.id} className="clickable" onClick={() => navigate(`/admin/order/${o.id}`)}>
                          <td data-label="№">{o.orderNumber}</td>
                          <td data-label="Клиент">{o.customerName}</td>
                          <td data-label="Материал">{o.materialSnapshot?.name ?? "—"}</td>
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
                <h3>Төлемдер жағдайы</h3>
              </div>
              <div className="payment-summary-list">
                <div className="progress-row">
                  <div className="progress-row-head">
                    <span>Төленген</span>
                    <span>{paymentSummary.paidCount}</span>
                  </div>
                  <div className="progress-bar">
                    <div
                      className="progress-bar-fill green"
                      style={{ width: `${pct(paymentSummary.paidCount, paymentSummary)}%` }}
                    />
                  </div>
                </div>
                <div className="progress-row">
                  <div className="progress-row-head">
                    <span>Жартылай</span>
                    <span>{paymentSummary.partialCount}</span>
                  </div>
                  <div className="progress-bar">
                    <div
                      className="progress-bar-fill amber"
                      style={{ width: `${pct(paymentSummary.partialCount, paymentSummary)}%` }}
                    />
                  </div>
                </div>
                <div className="progress-row">
                  <div className="progress-row-head">
                    <span>Төленбеген</span>
                    <span>{paymentSummary.unpaidCount}</span>
                  </div>
                  <div className="progress-bar">
                    <div
                      className="progress-bar-fill red"
                      style={{ width: `${pct(paymentSummary.unpaidCount, paymentSummary)}%` }}
                    />
                  </div>
                </div>
                <div className="summary-row">
                  <span>Түскен сома</span>
                  <strong>{formatMoney(paymentSummary.totalReceivedTiyn)}</strong>
                </div>
                <div className="summary-row">
                  <span>Жалпы қарыз</span>
                  <strong>{formatMoney(paymentSummary.debtTiyn)}</strong>
                </div>
              </div>
            </div>

            <div className="panel-card">
              <div className="panel-head">
                <h3>Жылдам әрекеттер</h3>
              </div>
              <div className="quick-actions">
                <Link className="quick-action-btn" to="/admin/materials">
                  <IconWarehouse />
                  Қойма
                </Link>
                <Link className="quick-action-btn" to="/admin/reports">
                  <IconReports />
                  Есептер
                </Link>
                <Link className="quick-action-btn" to="/setup">
                  <IconUsers />
                  Клиенттер
                </Link>
                <button type="button" className="quick-action-btn" onClick={handleExportOrders}>
                  <IconReports />
                  CSV экспорт
                </button>
                <Link className="quick-action-btn" to="/admin/audit-log">
                  <IconAudit />
                  Аудит
                </Link>
              </div>
            </div>
          </div>
        </>
      )}
    </AppShell>
  );
}

function pct(count: number, summary: { paidCount: number; partialCount: number; unpaidCount: number }): number {
  const total = summary.paidCount + summary.partialCount + summary.unpaidCount;
  return total > 0 ? Math.round((count / total) * 100) : 0;
}
