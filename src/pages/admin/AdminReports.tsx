import { useMemo, useState, type FormEvent } from "react";
import { db } from "../../firebase";
import { Spinner, Toast } from "../../components";
import { AppShell } from "../../components/layout/AppShell";
import { useAllOrders } from "../../hooks/useOrders";
import { useAllPayments, useAllInventoryMovements } from "../../hooks/useReports";
import { useMaterials, usePvcTypes } from "../../hooks/useMaterials";
import { useExpenseCategories } from "../../hooks/useExpenseCategories";
import { useMaterialCosts } from "../../hooks/useMaterialCosts";
import { useToast } from "../../hooks";
import { BarChart } from "../../components/BarChart";
import { formatMoney, tengeToTiyn } from "../../lib/money";
import { exportCsv, exportXlsx } from "../../lib/exportTable";
import { PRODUCTION_STATUS_LABELS } from "../../lib/statuses";
import { addExpenseCategory, deleteExpenseCategory, updateExpenseCategory } from "../../lib/expenseCategories";
import { useAuth } from "../../AuthContext";
import { computePvcUsage } from "../../lib/pvcUsage";
import {
  availableMonths,
  computeFinanceSummary,
  MACHINE_WASTE_PCT,
  type FinanceSummary,
} from "../../lib/finance";
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

type Tab = "dashboard" | "finance" | "pvc" | "sales" | "payments" | "production" | "warehouse" | "expenses";

export default function AdminReports() {
  const { userData } = useAuth();
  const isAdmin = userData?.role === "admin";
  const [tab, setTab] = useState<Tab>("dashboard");
  const { orders, loading: ordersLoading } = useAllOrders();
  const { payments, loading: paymentsLoading } = useAllPayments();
  const { movements, loading: movementsLoading } = useAllInventoryMovements();
  const { materials } = useMaterials(false);
  const { pvcTypes } = usePvcTypes(false);
  const { categories, loading: categoriesLoading } = useExpenseCategories();
  const { message, visible, showToast } = useToast();

  const loading = ordersLoading || paymentsLoading || movementsLoading;

  return (
    <AppShell title="Есептер" subtitle="Сату, төлемдер, өндіріс, қойма есептері">
      <div className="tab-pill-row">
        {/* Editing the allocation percentages writes to an Admin-only collection, so a Manager
            sees the resulting numbers on Қаржы but is not offered the settings tab. */}
        {(["dashboard", "finance", "pvc", "sales", "payments", "production", "warehouse", ...(isAdmin ? ["expenses"] : [])] as Tab[]).map((t) => (
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
          {tab === "finance" && <FinanceTab orders={orders} payments={payments} categories={categories} />}
          {tab === "pvc" && <PvcTab orders={orders} pvcTypes={pvcTypes} />}
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
    finance: "Қаржы",
    pvc: "ПВХ",
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

/**
 * "Жалпы біздегі сумма" — the shop's money in one place, for a month or for all time, ending in
 * the standing rule that a slice of each month's profit is set aside for the machine and waste.
 */
function FinanceTab({
  orders,
  payments,
  categories,
}: {
  orders: ReturnType<typeof useAllOrders>["orders"];
  payments: ReturnType<typeof useAllPayments>["payments"];
  categories: ExpenseCategory[];
}) {
  const months = useMemo(() => availableMonths(orders), [orders]);
  const [period, setPeriod] = useState<string | null>(() => months[0] ?? null);
  const { costs: purchaseByMaterialId, available: costsVisible } = useMaterialCosts();

  const s = useMemo(
    () => computeFinanceSummary({ orders, payments, purchaseByMaterialId, categories, period }),
    [orders, payments, purchaseByMaterialId, categories, period],
  );
  const allTime = useMemo(
    () => computeFinanceSummary({ orders, payments, purchaseByMaterialId, categories, period: null }),
    [orders, payments, purchaseByMaterialId, categories],
  );

  const periodName = period ? monthName(period) : "Барлық уақыт";

  const exportRows = () => [
    { Көрсеткіш: "Есептелген сома", Сома: s.billedTiyn / 100 },
    { Көрсеткіш: "Түскен төлем", Сома: s.receivedTiyn / 100 },
    { Көрсеткіш: "Қарыз", Сома: s.debtTiyn / 100 },
    { Көрсеткіш: "Материал өзіндік құны", Сома: s.costTiyn / 100 },
    { Көрсеткіш: "Жалпы пайда", Сома: s.grossProfitTiyn / 100 },
    ...s.allocations.map((a) => ({ Көрсеткіш: `${a.name} (${a.percentage}%)`, Сома: a.amountTiyn / 100 })),
    { Көрсеткіш: "Таза пайда", Сома: s.netProfitTiyn / 100 },
  ];

  return (
    <div>
      <div className="panel-card">
        <div className="chart-card-head">
          <h3>Кезең: {periodName}</h3>
          <select
            className="form-select-material"
            value={period ?? "all"}
            onChange={(e) => setPeriod(e.target.value === "all" ? null : e.target.value)}
          >
            <option value="all">Барлық уақыт</option>
            {months.map((m) => (
              <option key={m} value={m}>{monthName(m)}</option>
            ))}
          </select>
        </div>

        <div className="stat-grid">
          <div className="stat-card">
            <div className="number">{formatMoney(s.billedTiyn)}</div>
            <div className="label">Есептелген сома ({s.orderCount} заказ)</div>
          </div>
          <div className="stat-card">
            <div className="number">{formatMoney(s.receivedTiyn)}</div>
            <div className="label">Түскен төлем</div>
          </div>
          <div className="stat-card">
            <div className="number">{formatMoney(s.debtTiyn)}</div>
            <div className="label">Қарыз</div>
          </div>
          {costsVisible && (
            <div className="stat-card">
              <div className="number">{formatMoney(s.costTiyn)}</div>
              <div className="label">Материал өзіндік құны</div>
            </div>
          )}
        </div>
      </div>

      {/* Purchase prices are Admin-only (firestore.rules), so a Manager gets the money summary
          above and the standing 5% rule, but not the margin the profit split would reveal. */}
      {costsVisible ? (
        <div className="panel-card finance-profit">
          <div className="panel-head">
            <h3>Пайданы бөлу — {periodName}</h3>
          </div>

          <div className="summary-row">
            <span>Жалпы пайда (есептелген сома − материал құны)</span>
            <strong className={s.grossProfitTiyn < 0 ? "jt-debt" : "jt-total"}>
              {formatMoney(s.grossProfitTiyn)}
            </strong>
          </div>

          {s.allocations.map((a) => (
            <div key={a.name} className="summary-row">
              <span>{a.name} — {a.percentage}%</span>
              <strong>−{formatMoney(a.amountTiyn)}</strong>
            </div>
          ))}

          <div className="summary-row is-final">
            <span>Таза пайда</span>
            <strong>{formatMoney(s.netProfitTiyn)}</strong>
          </div>

          <p className="finance-note">
            ℹ️ Жалпы айлық пайданың {machineWastePct(categories)}% — станокқа, мусорға және цехтың
            шығындарына арналады. {periodName} үшін бұл{" "}
            <strong>{formatMoney(machineWasteAmount(s))}</strong> құрайды.
          </p>
        </div>
      ) : (
        <div className="panel-card finance-profit">
          <div className="panel-head">
            <h3>Пайданы бөлу</h3>
          </div>
          <p className="finance-note">
            ℹ️ Жалпы айлық пайданың {machineWastePct(categories)}% — станокқа, мусорға және цехтың
            шығындарына арналады. Пайданың нақты сомасы материалдың сатып алу бағасына байланысты,
            оны тек әкімші (Admin) көре алады.
          </p>
        </div>
      )}

      <div className="panel-card">
        <div className="panel-head">
          <h3>Барлық уақыт</h3>
        </div>
        <div className="summary-row">
          <span>Барлық есептелген сома</span>
          <strong className="jt-total">{formatMoney(allTime.billedTiyn)}</strong>
        </div>
        <div className="summary-row">
          <span>Барлық түскен төлем</span>
          <strong>{formatMoney(allTime.receivedTiyn)}</strong>
        </div>
        <div className="summary-row">
          <span>Барлық қарыз</span>
          <strong className="jt-debt">{formatMoney(allTime.debtTiyn)}</strong>
        </div>
      </div>

      <div className="wizard-actions" style={{ marginTop: 12 }}>
        <button className="btn btn-outline btn-sm" onClick={() => exportCsv(`қаржы-${period ?? "барлығы"}`, exportRows())}>
          📄 CSV экспорт
        </button>
        <button className="btn btn-outline btn-sm" onClick={() => exportXlsx(`қаржы-${period ?? "барлығы"}`, exportRows())}>
          📊 XLSX экспорт
        </button>
      </div>
    </div>
  );
}

const MONTH_NAMES_KK = [
  "Қаңтар", "Ақпан", "Наурыз", "Сәуір", "Мамыр", "Маусым",
  "Шілде", "Тамыз", "Қыркүйек", "Қазан", "Қараша", "Желтоқсан",
];

/** "2026-08" → "Тамыз 2026". */
function monthName(key: string): string {
  const [year, month] = key.split("-");
  return `${MONTH_NAMES_KK[Number(month) - 1] ?? month} ${year}`;
}

/** The machine/waste rate actually in force — the configured category if there is one. */
function machineWastePct(categories: ExpenseCategory[]): number {
  const row = categories.find((c) => c.active && c.name.toLowerCase().includes("станок"));
  return row?.percentage ?? MACHINE_WASTE_PCT;
}

function machineWasteAmount(s: FinanceSummary): number {
  const row = s.allocations.find((a) => a.name.toLowerCase().includes("станок"));
  return row?.amountTiyn ?? Math.round((s.grossProfitTiyn * MACHINE_WASTE_PCT) / 100);
}

/**
 * "ПВХ шығыны" — metres and cost of each edge-banding colour, for a month or all time.
 * Answers "қайсыдан қанша метр кетті" directly.
 */
function PvcTab({
  orders,
  pvcTypes,
}: {
  orders: ReturnType<typeof useAllOrders>["orders"];
  pvcTypes: ReturnType<typeof usePvcTypes>["pvcTypes"];
}) {
  const months = useMemo(() => availableMonths(orders), [orders]);
  const [period, setPeriod] = useState<string | null>(() => months[0] ?? null);

  const usage = useMemo(
    () => computePvcUsage({ orders, pvcTypes, period }),
    [orders, pvcTypes, period],
  );

  const periodName = period ? monthName(period) : "Барлық уақыт";

  const exportRows = () => [
    ...usage.rows.map((r) => ({
      Түсі: r.colorName,
      "Қалыңдығы, мм": r.thicknessMm,
      "Метр": Number(r.meters.toFixed(2)),
      "1 м бағасы": r.pricePerMeterTiyn / 100,
      Сомасы: r.costTiyn / 100,
      Заказ: r.orderCount,
    })),
    ...(usage.unattributedMeters > 0
      ? [{ Түсі: "Түрі көрсетілмеген", "Қалыңдығы, мм": "", Метр: Number(usage.unattributedMeters.toFixed(2)), "1 м бағасы": "", Сомасы: "", Заказ: usage.unattributedOrderCount }]
      : []),
  ];

  return (
    <div>
      <div className="panel-card">
        <div className="chart-card-head">
          <h3>ПВХ шығыны — {periodName}</h3>
          <select
            className="form-select-material"
            value={period ?? "all"}
            onChange={(e) => setPeriod(e.target.value === "all" ? null : e.target.value)}
          >
            <option value="all">Барлық уақыт</option>
            {months.map((m) => (
              <option key={m} value={m}>{monthName(m)}</option>
            ))}
          </select>
        </div>

        <div className="stat-grid">
          <div className="stat-card">
            <div className="number">{usage.totalMeters.toFixed(1)} м</div>
            <div className="label">Барлық ПВХ</div>
          </div>
          <div className="stat-card">
            <div className="number">{formatMoney(usage.totalCostTiyn)}</div>
            <div className="label">ПВХ сомасы</div>
          </div>
          <div className="stat-card">
            <div className="number">{usage.rows.length}</div>
            <div className="label">Қолданылған түс</div>
          </div>
        </div>
      </div>

      <div className="panel-card">
        <div className="panel-head">
          <h3>Түсі бойынша</h3>
        </div>
        {usage.rows.length === 0 && usage.unattributedMeters === 0 ? (
          <div className="empty-state">
            <div className="icon">📭</div>
            <p>Бұл кезеңде ПВХ қолданылмаған</p>
          </div>
        ) : (
          <div className="data-table-wrap">
            <table className="data-table stack-mobile stack-compact">
              <thead>
                <tr>
                  <th>Түсі</th>
                  <th className="num">Метр</th>
                  <th className="num">1 м бағасы</th>
                  <th className="num">Сомасы</th>
                  <th className="num">Заказ</th>
                </tr>
              </thead>
              <tbody>
                {usage.rows.map((r) => (
                  <tr key={r.pvcTypeId}>
                    <td data-label="Түсі">
                      <strong>{r.colorName}</strong> <span className="jt-muted">{r.thicknessMm} мм</span>
                    </td>
                    <td className="num" data-label="Метр">{r.meters.toFixed(2)} м</td>
                    <td className="num" data-label="1 м бағасы">{formatMoney(r.pricePerMeterTiyn)}</td>
                    <td className="num" data-label="Сомасы">{formatMoney(r.costTiyn)}</td>
                    <td className="num" data-label="Заказ">{r.orderCount}</td>
                  </tr>
                ))}
                {usage.unattributedMeters > 0 && (
                  <tr>
                    <td data-label="Түсі">
                      <strong>Түрі көрсетілмеген</strong>
                    </td>
                    <td className="num" data-label="Метр">{usage.unattributedMeters.toFixed(2)} м</td>
                    <td className="num" data-label="1 м бағасы">—</td>
                    <td className="num" data-label="Сомасы">—</td>
                    <td className="num" data-label="Заказ">{usage.unattributedOrderCount}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {usage.unattributedMeters > 0 && (
          <p className="finance-note">
            ℹ️ «Түрі көрсетілмеген» — журналға қолмен енгізілген заказдар: оларда жалпы метр ғана
            жазылған, ПВХ түсі таңдалмаған. Түсін көрсету үшін заказды толық ашып, бөлшектердің
            қырларына ПВХ түрін таңдаңыз.
          </p>
        )}
      </div>

      <div className="wizard-actions" style={{ marginTop: 12 }}>
        <button className="btn btn-outline btn-sm" onClick={() => exportCsv(`пвх-${period ?? "барлығы"}`, exportRows())}>
          📄 CSV экспорт
        </button>
        <button className="btn btn-outline btn-sm" onClick={() => exportXlsx(`пвх-${period ?? "барлығы"}`, exportRows())}>
          📊 XLSX экспорт
        </button>
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
