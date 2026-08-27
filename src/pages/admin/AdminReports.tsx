import { useMemo, useState, type FormEvent } from "react";
import { db } from "../../firebase";
import { Spinner, Toast } from "../../components";
import { AppShell } from "../../components/layout/AppShell";
import { useAllOrders } from "../../hooks/useOrders";
import { useAllPayments, useAllInventoryMovements } from "../../hooks/useReports";
import { useMaterials } from "../../hooks/useMaterials";
import { useExpenseCategories } from "../../hooks/useExpenseCategories";
import { useToast } from "../../hooks";
import { BarChart } from "../../components/BarChart";
import { formatMoney, tengeToTiyn } from "../../lib/money";
import { exportCsv, exportXlsx } from "../../lib/exportTable";
import { PRODUCTION_STATUS_LABELS } from "../../lib/statuses";
import { addExpenseCategory, deleteExpenseCategory, updateExpenseCategory } from "../../lib/expenseCategories";
import type { ExpenseCategory } from "../../types/domain";
import {
  computeCutterProductivity,
  computeKpis,
  computeLowStock,
  computeMaterialCutBreakdown,
  computeMethodBreakdown,
  computeMonthlyRevenue,
  computePaymentSummary,
  computePvcProductivity,
} from "../../lib/dashboardStats";

type Tab = "dashboard" | "sales" | "payments" | "production" | "warehouse" | "expenses";

export default function AdminReports() {
  const [tab, setTab] = useState<Tab>("dashboard");
  const { orders, loading: ordersLoading } = useAllOrders();
  const { payments, loading: paymentsLoading } = useAllPayments();
  const { movements, loading: movementsLoading } = useAllInventoryMovements();
  const { materials } = useMaterials(false);
  const { categories, loading: categoriesLoading } = useExpenseCategories();
  const { message, visible, showToast } = useToast();

  const loading = ordersLoading || paymentsLoading || movementsLoading;

  return (
    <AppShell title="Есептер" subtitle="Сату, төлемдер, өндіріс, қойма есептері">
      <div className="tab-pill-row">
        {(["dashboard", "sales", "payments", "production", "warehouse", "expenses"] as Tab[]).map((t) => (
          <button key={t} className={`tab-pill${tab === t ? " active" : ""}`} onClick={() => setTab(t)}>
            {tabLabel(t)}
          </button>
        ))}
      </div>

      {loading ? (
        <Spinner />
      ) : (
        <>
          {tab === "dashboard" && <DashboardTab orders={orders} payments={payments} movements={movements} materials={materials} />}
          {tab === "sales" && <SalesTab orders={orders} />}
          {tab === "payments" && <PaymentsTab payments={payments} />}
          {tab === "production" && <ProductionTab orders={orders} movements={movements} materials={materials} />}
          {tab === "warehouse" && <WarehouseTab movements={movements} materials={materials} />}
          {tab === "expenses" && (
            <ExpenseCategoriesTab categories={categories} loading={categoriesLoading} showToast={showToast} />
          )}
        </>
      )}

      <Toast message={message} visible={visible} />
    </AppShell>
  );
}

function tabLabel(t: Tab): string {
  return {
    dashboard: "Дашборд",
    sales: "Сату",
    payments: "Төлемдер",
    production: "Өндіріс",
    warehouse: "Қойма",
    expenses: "Шығын санаттары",
  }[t];
}

function ExpenseCategoriesTab({
  categories,
  loading,
  showToast,
}: {
  categories: ExpenseCategory[];
  loading: boolean;
  showToast: (msg: string) => void;
}) {
  const [editing, setEditing] = useState<ExpenseCategory | "new" | null>(null);

  const activeTotalPct = categories.filter((c) => c.active).reduce((s, c) => s + c.percentage, 0);

  const handleDelete = async (category: ExpenseCategory) => {
    if (!confirm(`"${category.name}" санатын жоюды қалайсыз ба?`)) return;
    try {
      await deleteExpenseCategory(db, category.id);
      showToast("✅ Санат жойылды");
    } catch (err: unknown) {
      showToast("Қате: " + (err as Error).message);
    }
  };

  return (
    <div className="panel-card">
      <div className="panel-head">
        <h3>Шығын санаттары</h3>
        <button className="btn btn-primary btn-sm" onClick={() => setEditing("new")}>
          + Санат қосу
        </button>
      </div>

      {loading ? (
        <Spinner />
      ) : categories.length === 0 ? (
        <div className="empty-state">
          <div className="icon">📭</div>
          <p>Шығын санаттары жоқ</p>
        </div>
      ) : (
        <div className="data-table-wrap">
          <table className="data-table stack-mobile">
            <thead>
              <tr>
                <th>Атауы</th>
                <th className="num">Пайыз (%)</th>
                <th>Белсенді</th>
                <th>Әрекеттер</th>
              </tr>
            </thead>
            <tbody>
              {categories.map((c) => (
                <tr key={c.id} className={!c.active ? "blocked" : undefined}>
                  <td data-label="Атауы">
                    <strong>{c.name}</strong>
                  </td>
                  <td className="num" data-label="Пайыз (%)">
                    {c.percentage}%
                  </td>
                  <td data-label="Белсенді">{c.active ? "Иә" : "Жоқ"}</td>
                  <td data-label="Әрекеттер">
                    <div className="data-row-actions">
                      <button className="btn btn-outline btn-sm" onClick={() => setEditing(c)}>
                        Өзгерту
                      </button>
                      <button className="btn btn-outline btn-sm" onClick={() => handleDelete(c)}>
                        Жою
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="summary-row" style={{ marginTop: 12 }}>
        <span>Барлығы</span>
        <strong>
          {activeTotalPct}% (қалғаны {Math.max(0, 100 - activeTotalPct)}% — таза пайда)
        </strong>
      </div>

      {editing && (
        <ExpenseCategoryModal
          category={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          showToast={showToast}
        />
      )}
    </div>
  );
}

function ExpenseCategoryModal({
  category,
  onClose,
  showToast,
}: {
  category: ExpenseCategory | null;
  onClose: () => void;
  showToast: (msg: string) => void;
}) {
  const [name, setName] = useState(category?.name ?? "");
  const [percentage, setPercentage] = useState(String(category?.percentage ?? 0));
  const [active, setActive] = useState(category?.active ?? true);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSubmitting(true);
    try {
      const payload = {
        name: name.trim(),
        percentage: parseFloat(percentage) || 0,
        active,
      };
      if (category) {
        await updateExpenseCategory(db, category.id, payload);
      } else {
        await addExpenseCategory(db, payload);
      }
      showToast(category ? "✅ Санат жаңартылды" : "✅ Санат қосылды");
      onClose();
    } catch (err: unknown) {
      showToast("Қате: " + (err as Error).message);
    }
    setSubmitting(false);
  };

  return (
    <div className="modal-overlay active" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-handle" />
        <h2>{category ? "✎ Санатты өзгерту" : "➕ Жаңа санат"}</h2>
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>Атауы</label>
            <input className="form-input" value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div className="form-group">
            <label>Пайыз (%)</label>
            <input
              type="number"
              className="form-input"
              value={percentage}
              onChange={(e) => setPercentage(e.target.value)}
              min={0}
              max={100}
              step="0.1"
              required
            />
          </div>
          <label className="remember-me">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
            <span className="remember-check">{active ? "✓" : ""}</span>
            <span>Белсенді</span>
          </label>
          <div className="modal-actions">
            <button type="button" className="btn btn-outline" onClick={onClose}>
              Болдырмау
            </button>
            <button type="submit" className="btn btn-primary" disabled={submitting}>
              Сақтау
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function DashboardTab({
  orders,
  payments,
  movements,
  materials,
}: {
  orders: ReturnType<typeof useAllOrders>["orders"];
  payments: ReturnType<typeof useAllPayments>["payments"];
  movements: ReturnType<typeof useAllInventoryMovements>["movements"];
  materials: ReturnType<typeof useMaterials>["materials"];
}) {
  const kpis = computeKpis({ orders, payments, movements, materials });

  const cards = [
    { label: "Бүгінгі заказдар", value: kpis.todayOrders },
    { label: "Кезекте", value: kpis.queueCount },
    { label: "Кесіліп жатыр", value: kpis.cuttingCount },
    { label: "ПВХ күтуде", value: kpis.pvcPendingCount },
    { label: "Дайын", value: kpis.readyCount },
    { label: "Бүгінгі табыс", value: formatMoney(kpis.todayRevenueTiyn) },
    { label: "Апталық табыс", value: formatMoney(kpis.weekRevenueTiyn) },
    { label: "Айлық табыс", value: formatMoney(kpis.monthRevenueTiyn) },
    { label: "Төленбеген сома", value: formatMoney(kpis.unpaidTotalTiyn) },
    { label: "Жалпы қарыз", value: formatMoney(kpis.totalDebtTiyn) },
    { label: "Аз қалдық материалдар", value: kpis.lowStockCount },
    { label: "Бүгін кесілген лист", value: kpis.sheetsToday },
    { label: "Осы ай кесілген лист", value: kpis.sheetsMonth },
  ];

  return (
    <div className="stat-grid">
      {cards.map((c) => (
        <div key={c.label} className="stat-card">
          <div className="number">{c.value}</div>
          <div className="label">{c.label}</div>
        </div>
      ))}
    </div>
  );
}

function SalesTab({ orders }: { orders: ReturnType<typeof useAllOrders>["orders"] }) {
  const [dateField, setDateField] = useState<"createdAt" | "approvedAt">("createdAt");
  const nonDraft = orders.filter((o) => o.productionStatus !== "draft"); // for CSV export rows only

  const chartData = useMemo(() => computeMonthlyRevenue(orders, dateField), [orders, dateField]);
  const summary = useMemo(() => computePaymentSummary(orders), [orders]);

  const totalOrders = nonDraft.length;
  const { totalValueTiyn: totalValue, totalReceivedTiyn: totalReceived, paidCount, partialCount, unpaidCount, debtTiyn: debt, avgOrderTiyn: avgOrder, discountsTiyn: discounts } = summary;

  const exportRows = () =>
    nonDraft.map((o) => ({
      "Заказ №": o.orderNumber,
      Клиент: o.customerName,
      Мәртебе: PRODUCTION_STATUS_LABELS[o.productionStatus],
      Сома: o.totalTiyn / 100,
      Төленді: o.paidTiyn / 100,
      Қарыз: o.debtTiyn / 100,
    }));

  return (
    <div>
      <div className="panel-card">
        <div className="chart-card-head">
          <h3>Айлық сату динамикасы</h3>
          <select className="form-select-material" value={dateField} onChange={(e) => setDateField(e.target.value as typeof dateField)}>
            <option value="createdAt">Құрылған күні</option>
            <option value="approvedAt">Бекітілген күні</option>
          </select>
        </div>
        <BarChart data={chartData} valueFormatter={(v) => `${Math.round(v / 1000)}к`} />
      </div>
      <div className="stat-grid" style={{ marginTop: 16 }}>
        <div className="stat-card"><div className="number">{totalOrders}</div><div className="label">Заказдар саны</div></div>
        <div className="stat-card"><div className="number">{formatMoney(totalValue)}</div><div className="label">Жалпы сома</div></div>
        <div className="stat-card"><div className="number">{formatMoney(totalReceived)}</div><div className="label">Түскен төлем</div></div>
        <div className="stat-card"><div className="number">{paidCount}</div><div className="label">Төленген</div></div>
        <div className="stat-card"><div className="number">{partialCount}</div><div className="label">Жартылай</div></div>
        <div className="stat-card"><div className="number">{unpaidCount}</div><div className="label">Төленбеген</div></div>
        <div className="stat-card"><div className="number">{formatMoney(debt)}</div><div className="label">Қарыз</div></div>
        <div className="stat-card"><div className="number">{formatMoney(avgOrder)}</div><div className="label">Орташа заказ</div></div>
        <div className="stat-card"><div className="number">{formatMoney(discounts)}</div><div className="label">Жеңілдіктер</div></div>
      </div>
      <div className="wizard-actions" style={{ marginTop: 12 }}>
        <button className="btn btn-outline btn-sm" onClick={() => exportCsv("sales-report", exportRows())}>
          📄 CSV экспорт
        </button>
        <button className="btn btn-outline btn-sm" onClick={() => exportXlsx("sales-report", exportRows())}>
          📊 XLSX экспорт
        </button>
      </div>
    </div>
  );
}

const METHOD_LABELS = ["Нал / Қолма-қол", "Kaspi", "Pay", "Нұр", "Бәлім", "Аралас"];

function PaymentsTab({ payments }: { payments: ReturnType<typeof useAllPayments>["payments"] }) {
  const valid = payments.filter((p) => !p.reversed);
  const reversed = payments.filter((p) => p.reversed);

  const chartData = useMemo(() => computeMethodBreakdown(payments), [payments]);
  const byMethod = useMemo(() => new Map(chartData.map((r) => [r.label, tengeToTiyn(r.value)])), [chartData]);

  const totalReceived = valid.reduce((s, p) => s + p.amountTiyn, 0);
  const totalReversed = reversed.reduce((s, p) => s + p.amountTiyn, 0);

  const exportRows = () =>
    valid.map((p) => ({
      Сома: p.amountTiyn / 100,
      Әдіс: p.methodName,
      Кім: p.recordedByName,
      Күні: p.paymentDate ? new Date(p.paymentDate.seconds * 1000).toISOString() : "",
    }));

  return (
    <div>
      <div className="panel-card">
        <div className="chart-card-head">
          <h3>Төлем әдістері бойынша</h3>
        </div>
        <BarChart data={chartData} valueFormatter={(v) => `${Math.round(v / 1000)}к`} />
      </div>
      <div className="stat-grid" style={{ marginTop: 16 }}>
        {METHOD_LABELS.map((m) => (
          <div key={m} className="stat-card">
            <div className="number">{formatMoney(byMethod.get(m) || 0)}</div>
            <div className="label">{m}</div>
          </div>
        ))}
        <div className="stat-card"><div className="number">{formatMoney(totalReceived)}</div><div className="label">Барлығы түсті</div></div>
        <div className="stat-card"><div className="number">{formatMoney(totalReversed)}</div><div className="label">Қайтарылған</div></div>
      </div>
      <div className="wizard-actions" style={{ marginTop: 12 }}>
        <button className="btn btn-outline btn-sm" onClick={() => exportCsv("payments-report", exportRows())}>
          📄 CSV экспорт
        </button>
        <button className="btn btn-outline btn-sm" onClick={() => exportXlsx("payments-report", exportRows())}>
          📊 XLSX экспорт
        </button>
      </div>
    </div>
  );
}

function ProductionTab({
  orders,
  movements,
  materials,
}: {
  orders: ReturnType<typeof useAllOrders>["orders"];
  movements: ReturnType<typeof useAllInventoryMovements>["movements"];
  materials: ReturnType<typeof useMaterials>["materials"];
}) {
  const totalSheetsCut = useMemo(
    () => computeKpis({ orders, payments: [], movements, materials }).totalSheetsCut,
    [orders, movements, materials],
  );

  const byMaterial = useMemo(() => computeMaterialCutBreakdown(movements, materials), [movements, materials]);

  const cutOrders = orders.filter((o) => o.cuttingConsumedAt);
  const completedOrders = orders.filter((o) => o.productionStatus === "delivered");
  const totalPvcMeters = cutOrders.reduce((s, o) => s + (o.pvcMetersTotal || 0), 0);

  const cutterProductivity = useMemo(() => computeCutterProductivity(orders), [orders]);
  const pvcProductivity = useMemo(() => computePvcProductivity(orders), [orders]);

  return (
    <div>
      <div className="stat-grid">
        <div className="stat-card"><div className="number">{totalSheetsCut}</div><div className="label">Барлық кесілген лист</div></div>
        <div className="stat-card"><div className="number">{cutOrders.length}</div><div className="label">Кесілген заказдар</div></div>
        <div className="stat-card"><div className="number">{completedOrders.length}</div><div className="label">Аяқталған заказдар</div></div>
        <div className="stat-card"><div className="number">{totalPvcMeters.toFixed(1)}</div><div className="label">ПВХ жалпы (м)</div></div>
      </div>
      <div className="panel-card" style={{ marginTop: 16 }}>
        <div className="chart-card-head">
          <h3>Материал бойынша кесілген лист</h3>
        </div>
        <BarChart data={byMaterial} />
      </div>
      <div className="panel-card" style={{ marginTop: 16 }}>
        <div className="panel-head">
          <h3>Распилшы өнімділігі</h3>
        </div>
        <div className="data-list">
          {[...cutterProductivity.entries()].map(([name, count]) => (
            <div key={name} className="data-row">
              <div className="data-row-main"><strong>{name}</strong></div>
              <span>{count} заказ</span>
            </div>
          ))}
        </div>
      </div>
      <div className="panel-card" style={{ marginTop: 16 }}>
        <div className="panel-head">
          <h3>ПВХ жұмысшысы өнімділігі</h3>
        </div>
        <div className="data-list">
          {[...pvcProductivity.entries()].map(([name, count]) => (
            <div key={name} className="data-row">
              <div className="data-row-main"><strong>{name}</strong></div>
              <span>{count} заказ</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function WarehouseTab({
  movements,
  materials,
}: {
  movements: ReturnType<typeof useAllInventoryMovements>["movements"];
  materials: ReturnType<typeof useMaterials>["materials"];
}) {
  const lowStock = computeLowStock(materials);

  const exportRows = () =>
    materials.map((m) => ({
      Материал: m.name,
      "Бастапқы қалдық": m.initialQty,
      "Қазіргі қалдық": m.qtyOnHand,
      Брондалған: m.reservedQty,
      Қолжетімді: m.qtyOnHand - m.reservedQty,
      "Мин. қалдық": m.minStock,
    }));

  return (
    <div>
      {lowStock.length > 0 && (
        <div className="stat-card" style={{ marginBottom: 16, borderColor: "var(--danger)" }}>
          <div className="number warehouse-low">{lowStock.length}</div>
          <div className="label">Аз қалдық материалдар: {lowStock.map((m) => m.name).join(", ")}</div>
        </div>
      )}
      <div className="panel-card">
        <div className="panel-head">
          <h3>Материалдар қалдығы</h3>
        </div>
        <div className="data-list">
          {materials.map((m) => (
            <div key={m.id} className="data-row">
              <div className="data-row-main">
                <strong>{m.name}</strong>
                <span>
                  Бастапқы: {m.initialQty} · Қазіргі: {m.qtyOnHand} · Брондалған: {m.reservedQty} · Қолжетімді:{" "}
                  {m.qtyOnHand - m.reservedQty}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="panel-card" style={{ marginTop: 16 }}>
        <div className="panel-head">
          <h3>Соңғы қозғалыстар</h3>
        </div>
        <div className="data-list">
          {movements.slice(0, 30).map((mv) => (
            <div key={mv.id} className="data-row">
              <div className="data-row-main">
                <strong>{materials.find((m) => m.id === mv.materialId)?.name ?? mv.materialId}</strong>
                <span>{mv.type} · {mv.qty > 0 ? "+" : ""}{mv.qty}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="wizard-actions" style={{ marginTop: 12 }}>
        <button className="btn btn-outline btn-sm" onClick={() => exportCsv("warehouse-report", exportRows())}>
          📄 CSV экспорт
        </button>
        <button className="btn btn-outline btn-sm" onClick={() => exportXlsx("warehouse-report", exportRows())}>
          📊 XLSX экспорт
        </button>
      </div>
    </div>
  );
}
