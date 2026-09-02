import { useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { db } from "../../firebase";
import { Spinner, Toast } from "../../components";
import { AppShell } from "../../components/layout/AppShell";
import { useAllOrders } from "../../hooks/useOrders";
import { useAllPayments, useAllInventoryMovements } from "../../hooks/useReports";
import { useMaterials, usePvcTypes } from "../../hooks/useMaterials";
import { useExpenseCategories } from "../../hooks/useExpenseCategories";
import { useExpenses } from "../../hooks/useExpenses";
import { useMaterialCosts } from "../../hooks/useMaterialCosts";
import { useToast } from "../../hooks";
import { BarChart } from "../../components/BarChart";
import { formatMoney } from "../../lib/money";
import { dayKey, formatDateDMY, monthKey } from "../../lib/dates";
import { exportCsv, exportXlsx } from "../../lib/exportTable";
import { PRODUCTION_STATUS_LABELS } from "../../lib/statuses";
import { addExpenseCategory, deleteExpenseCategory, updateExpenseCategory } from "../../lib/expenseCategories";
import { addExpense, deleteExpense } from "../../lib/expenses";
import { MoneyInput } from "../../components/MoneyInput";
import { useAuth } from "../../AuthContext";
import { computePvcUsage } from "../../lib/pvcUsage";
import {
  availableMonths,
  computeFinanceSummary,
  MACHINE_WASTE_PCT,
  type FinanceSummary,
} from "../../lib/finance";
import { CASH_ACCOUNTS, CASH_ACCOUNT_LABELS, accountForExpense } from "../../lib/cashbox";
import type { CashAccount, Expense, ExpenseCategory } from "../../types/domain";
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
import {
  PERIOD_LABELS,
  debtOverview,
  periodStart,
  pvcMetersSince,
  revenueFor,
  weeklyRevenue,
  type ReportPeriod,
} from "../../lib/reportsDashboard";

type Tab = "dashboard" | "finance" | "pvc" | "sales" | "payments" | "production" | "warehouse" | "expenses" | "expenselog";

export default function AdminReports() {
  const { userData } = useAuth();
  const isAdmin = userData?.role === "admin";
  const [tab, setTab] = useState<Tab>("dashboard");
  /** Which stretch of time the dashboard's figures cover. */
  const [period, setPeriod] = useState<ReportPeriod>("week");
  const { orders, loading: ordersLoading } = useAllOrders();
  const { payments, loading: paymentsLoading } = useAllPayments();
  const { movements, loading: movementsLoading } = useAllInventoryMovements();
  const { materials } = useMaterials(false);
  const { pvcTypes } = usePvcTypes(false);
  const { categories, loading: categoriesLoading } = useExpenseCategories();
  const { expenses, loading: expensesLoading } = useExpenses();
  const { message, visible, showToast } = useToast();

  const loading = ordersLoading || paymentsLoading || movementsLoading;

  return (
    <AppShell title="Есептер" subtitle="Қаржы және өндіріс қорытындысы">
      {/* Бүгін / Апта / Ай sits above the tabs because it qualifies all of them: the question is
          "how much", and it is meaningless without saying over what. */}
      <div className="report-period">
        {(Object.keys(PERIOD_LABELS) as ReportPeriod[]).map((p) => (
          <button
            key={p}
            className={`report-period-btn${period === p ? " is-active" : ""}`}
            onClick={() => setPeriod(p)}
          >
            {PERIOD_LABELS[p]}
          </button>
        ))}
      </div>

      <div className="tab-pill-row">
        {/* Editing the allocation percentages (or logging an expense) writes to an Admin-only
            collection, so a Manager sees the resulting numbers on Қаржы but is not offered either
            settings tab. */}
        {(["dashboard", "finance", "pvc", "sales", "payments", "production", "warehouse", ...(isAdmin ? ["expenses", "expenselog"] : [])] as Tab[]).map((t) => (
          <button key={t} className={`tab-pill${tab === t ? " active" : ""}`} onClick={() => setTab(t)}>
            {tabLabel(t)}
          </button>
        ))}
      </div>

      {loading ? (
        <Spinner />
      ) : (
        <>
          {tab === "dashboard" && (
            <DashboardTab
              orders={orders}
              payments={payments}
              movements={movements}
              materials={materials}
              period={period}
            />
          )}
          {tab === "finance" && <FinanceTab orders={orders} payments={payments} categories={categories} expenses={expenses} />}
          {tab === "pvc" && <PvcTab orders={orders} pvcTypes={pvcTypes} />}
          {tab === "sales" && <SalesTab orders={orders} />}
          {tab === "payments" && <PaymentsTab payments={payments} orders={orders} />}
          {tab === "production" && <ProductionTab orders={orders} movements={movements} materials={materials} />}
          {tab === "warehouse" && <WarehouseTab movements={movements} materials={materials} />}
          {tab === "expenses" && (
            <ExpenseCategoriesTab categories={categories} loading={categoriesLoading} showToast={showToast} />
          )}
          {tab === "expenselog" && (
            <ExpenseLogTab expenses={expenses} loading={expensesLoading} orders={orders} showToast={showToast} />
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
    expenselog: "Сыртқа шығын",
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
 * "Сыртқа шығын" — real, one-off costs the admin types in by hand (мусор, жөндеу, жеткізу…), each
 * on its own date. Unlike the percentage categories above, this is not a standing rule: it is a
 * dated log, and every entry here is subtracted from that month's net profit on Қаржы.
 */
function ExpenseLogTab({
  expenses,
  loading,
  orders,
  showToast,
}: {
  expenses: Expense[];
  loading: boolean;
  orders: ReturnType<typeof useAllOrders>["orders"];
  showToast: (msg: string) => void;
}) {
  const { userData, user } = useAuth();
  const [adding, setAdding] = useState(false);

  const months = useMemo(() => {
    // The picker always offers the current month, even before any order or expense exists in it.
    const set = new Set(availableMonths(orders));
    set.add(dayKey(new Date()).slice(0, 7));
    return [...set].sort().reverse();
  }, [orders]);
  const [period, setPeriod] = useState<string>(() => months[0]);

  const filtered = useMemo(
    () => expenses.filter((e) => e.date.startsWith(period)).sort((a, b) => b.date.localeCompare(a.date)),
    [expenses, period],
  );
  const totalTiyn = filtered.reduce((s, e) => s + e.amountTiyn, 0);

  const handleDelete = async (expense: Expense) => {
    if (!user || !userData) return;
    if (!confirm(`"${expense.name}" — ${formatMoney(expense.amountTiyn)} жазбасын өшіресіз бе?`)) return;
    try {
      await deleteExpense(db, { user, userData }, expense);
      showToast("✅ Жазба өшірілді");
    } catch (err: unknown) {
      showToast("Қате: " + (err as Error).message);
    }
  };

  return (
    <div className="panel-card">
      <div className="panel-head">
        <h3>Сыртқа шығын</h3>
        <button className="btn btn-primary btn-sm" onClick={() => setAdding(true)}>
          + Шығын қосу
        </button>
      </div>

      <div className="chart-card-head">
        <span>Кезең: {monthName(period)}</span>
        <select className="form-select-material" value={period} onChange={(e) => setPeriod(e.target.value)}>
          {months.map((m) => (
            <option key={m} value={m}>{monthName(m)}</option>
          ))}
        </select>
      </div>

      <div className="summary-row" style={{ marginBottom: 12 }}>
        <span>{monthName(period)} — барлық шығын</span>
        <strong className="jt-debt">{formatMoney(totalTiyn)}</strong>
      </div>

      {loading ? (
        <Spinner />
      ) : filtered.length === 0 ? (
        <div className="empty-state">
          <div className="icon">📭</div>
          <p>Бұл айда шығын жазылмаған</p>
        </div>
      ) : (
        <div className="data-table-wrap">
          <table className="data-table stack-mobile">
            <thead>
              <tr>
                <th>Күні</th>
                <th>Атауы</th>
                <th>Қай кассадан</th>
                <th className="num">Сомасы</th>
                <th>Себебі</th>
                <th>Кім жазды</th>
                <th>Әрекеттер</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((e) => (
                <tr key={e.id}>
                  <td data-label="Күні">{formatDateDMY(new Date(`${e.date}T12:00:00+05:00`))}</td>
                  <td data-label="Атауы"><strong>{e.name}</strong></td>
                  <td data-label="Қай кассадан">
                    <span className={`cashbox-tag is-${accountForExpense(e)}`}>
                      {CASH_ACCOUNT_LABELS[accountForExpense(e)]}
                    </span>
                  </td>
                  <td className="num jt-debt" data-label="Сомасы">−{formatMoney(e.amountTiyn)}</td>
                  <td data-label="Себебі" className="otable-sub">{e.comment || "—"}</td>
                  <td data-label="Кім жазды" className="otable-sub">{e.createdByName}</td>
                  <td data-label="Әрекеттер">
                    <button className="btn btn-outline btn-sm" onClick={() => handleDelete(e)}>
                      Жою
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {adding && <ExpenseModal onClose={() => setAdding(false)} showToast={showToast} />}
    </div>
  );
}

function ExpenseModal({
  onClose,
  showToast,
}: {
  onClose: () => void;
  showToast: (msg: string) => void;
}) {
  const { user, userData } = useAuth();
  const [name, setName] = useState("");
  const [amountTiyn, setAmountTiyn] = useState(0);
  const [date, setDate] = useState(() => dayKey(new Date()));
  const [account, setAccount] = useState<CashAccount>("cash");
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!user || !userData) return;
    if (!name.trim() || amountTiyn <= 0) {
      showToast("Атауы мен соманы дұрыс толтырыңыз");
      return;
    }
    setSubmitting(true);
    try {
      await addExpense(db, { user, userData }, { name: name.trim(), amountTiyn, date, account, comment: comment.trim() });
      showToast("✅ Шығын жазылды");
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
        <h2>➕ Жаңа шығын</h2>
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>Атауы</label>
            <input
              className="form-input"
              placeholder="Мусор, жөндеу, жеткізу…"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              required
            />
          </div>
          <div className="form-group">
            <label>Сомасы (₸)</label>
            <MoneyInput valueTiyn={amountTiyn} onChange={setAmountTiyn} />
          </div>
          {/* Which pot it came out of — the same field the Manager fills in on Касса, so an
              expense logged from either page lands on the right balance there. */}
          <div className="form-group">
            <label>Қай кассадан</label>
            <select className="form-input" value={account} onChange={(e) => setAccount(e.target.value as CashAccount)}>
              {CASH_ACCOUNTS.map((a) => <option key={a} value={a}>{CASH_ACCOUNT_LABELS[a]}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label>Күні</label>
            <input type="date" className="form-input" value={date} onChange={(e) => setDate(e.target.value)} required />
          </div>
          <div className="form-group">
            <label>Себебі (міндетті емес)</label>
            <input className="form-input" value={comment} onChange={(e) => setComment(e.target.value)} />
          </div>
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
  expenses,
}: {
  orders: ReturnType<typeof useAllOrders>["orders"];
  payments: ReturnType<typeof useAllPayments>["payments"];
  categories: ExpenseCategory[];
  expenses: Expense[];
}) {
  const months = useMemo(() => availableMonths(orders), [orders]);
  const [period, setPeriod] = useState<string | null>(() => months[0] ?? null);
  const { costs: purchaseByMaterialId, available: costsVisible } = useMaterialCosts();

  const s = useMemo(
    () => computeFinanceSummary({ orders, payments, purchaseByMaterialId, categories, expenses, period }),
    [orders, payments, purchaseByMaterialId, categories, expenses, period],
  );
  const allTime = useMemo(
    () => computeFinanceSummary({ orders, payments, purchaseByMaterialId, categories, expenses, period: null }),
    [orders, payments, purchaseByMaterialId, categories, expenses],
  );

  const periodName = period ? monthName(period) : "Барлық уақыт";

  const exportRows = () => [
    { Көрсеткіш: "Есептелген сома", Сома: s.billedTiyn / 100 },
    { Көрсеткіш: "Түскен төлем", Сома: s.receivedTiyn / 100 },
    { Көрсеткіш: "Қарыз", Сома: s.debtTiyn / 100 },
    { Көрсеткіш: "Материал өзіндік құны", Сома: s.costTiyn / 100 },
    { Көрсеткіш: "Жалпы пайда", Сома: s.grossProfitTiyn / 100 },
    ...s.allocations.map((a) => ({ Көрсеткіш: `${a.name} (${a.percentage}%)`, Сома: a.amountTiyn / 100 })),
    ...(s.fixedExpensesTiyn > 0 ? [{ Көрсеткіш: "Сыртқа шығын", Сома: s.fixedExpensesTiyn / 100 }] : []),
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

          {/* Only shown when the month actually has a logged expense — an admin who never uses
              "Сыртқа шығын" sees exactly the breakdown they always saw. */}
          {s.fixedExpensesTiyn > 0 && (
            <div className="summary-row">
              <span>Сыртқа шығын</span>
              <strong>−{formatMoney(s.fixedExpensesTiyn)}</strong>
            </div>
          )}

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

/**
 * The Дашборд tab: what came in, what the shop floor is doing, what is owed, and what today
 * actually produced — in that order, because that is the order the owner asks in.
 *
 * The thirteen identical stat cards this replaces gave every figure the same weight, so the one
 * being looked for had to be found by reading all of them.
 */
function DashboardTab({
  orders,
  payments,
  movements,
  materials,
  period,
}: {
  orders: ReturnType<typeof useAllOrders>["orders"];
  payments: ReturnType<typeof useAllPayments>["payments"];
  movements: ReturnType<typeof useAllInventoryMovements>["movements"];
  materials: ReturnType<typeof useMaterials>["materials"];
  period: ReportPeriod;
}) {
  const kpis = computeKpis({ orders, payments, movements, materials });
  const revenue = useMemo(() => revenueFor(payments, period), [payments, period]);
  const week = useMemo(() => weeklyRevenue(payments), [payments]);
  const debts = useMemo(() => debtOverview(orders), [orders]);
  const methods = useMemo(() => computeMethodBreakdown(payments), [payments]);
  const pvcToday = useMemo(() => pvcMetersSince(orders, periodStart("today", new Date())), [orders]);

  const methodTotal = methods.reduce((s, m) => s + m.value, 0);
  const stages = [
    { key: "queue", label: "Кезек", value: kpis.queueCount },
    { key: "cutting", label: "Распил", value: kpis.cuttingCount },
    { key: "pvc", label: "ПВХ", value: kpis.pvcPendingCount },
    { key: "ready", label: "Дайын", value: kpis.readyCount },
  ];
  const stageTotal = stages.reduce((s, x) => s + x.value, 0);

  return (
    <div className="rdash">
      <section className="panel-card rdash-income">
        <div className="rdash-income-head">
          <span className="rdash-income-icon" aria-hidden="true">💰</span>
          <span>Кіріс</span>
        </div>
        <div className="rdash-income-row">
          <div>
            <div className="rdash-big">{formatMoney(revenue.currentTiyn)}</div>
            <div className="rdash-cap">{PERIOD_LABELS[period]} табысы</div>
          </div>
          {/* No badge at all when there is nothing to compare with — see revenueFor. */}
          {revenue.changePct !== null && (
            <span className={`rdash-delta${revenue.changePct < 0 ? " is-down" : ""}`}>
              {revenue.changePct >= 0 ? "↗" : "↘"} {revenue.changePct > 0 ? "+" : ""}{revenue.changePct}%
              <small>өткен кезеңнен</small>
            </span>
          )}
        </div>

        <div className="rdash-subfigures">
          <div><span>Апталық</span><strong>{formatMoney(kpis.weekRevenueTiyn)}</strong></div>
          <div><span>Айлық</span><strong>{formatMoney(kpis.monthRevenueTiyn)}</strong></div>
        </div>

        <BarChart
          data={week.map((d) => ({ label: d.label, value: d.valueTiyn / 100 }))}
          valueFormatter={(v) => `${Math.round(v / 1000)}к`}
        />
      </section>

      <section className="panel-card">
        <div className="panel-head">
          <h3>Цех барысы</h3>
        </div>
        <div className="rdash-tiles">
          <div className="rdash-tile"><b>{kpis.todayOrders}</b><span>Бүгінгі заказ</span></div>
          <div className="rdash-tile is-blue"><b>{kpis.queueCount}</b><span>Кезекте</span></div>
          <div className="rdash-tile is-amber"><b>{kpis.pvcPendingCount}</b><span>ПВХ күтуде</span></div>
          <div className="rdash-tile is-green"><b>{kpis.readyCount}</b><span>Дайын</span></div>
        </div>

        {/* One bar for the whole floor: where the work is sitting, in proportion. */}
        {stageTotal > 0 && (
          <>
            <div className="rdash-stagebar" aria-hidden="true">
              {stages.map((st) => (
                <i key={st.key} className={`is-${st.key}`} style={{ flexGrow: st.value }} />
              ))}
            </div>
            <div className="rdash-stagekeys">
              {stages.map((st) => (
                <span key={st.key} className={`rdash-stagekey is-${st.key}`}>{st.label} {st.value}</span>
              ))}
            </div>
          </>
        )}
      </section>

      <div className="rdash-pair">
        <section className="panel-card rdash-debt">
          <div className="panel-head"><h3>Қарыздар</h3></div>
          <div className="rdash-big is-debt">{formatMoney(debts.totalTiyn)}</div>
          <div className="rdash-cap">
            {debts.customers} клиент
            {debts.overdue > 0 && <> · {debts.overdue} мерзімі өткен</>}
          </div>
          <Link to="/manager/debt" className="rdash-link">Қарыздарды ашу →</Link>
        </section>

        <section className="panel-card">
          <div className="panel-head"><h3>Төлем түрлері</h3></div>
          {methodTotal === 0 ? (
            <p className="jt-muted">Бұл кезеңде төлем жоқ</p>
          ) : (
            <>
              <div className="rdash-methodbar" aria-hidden="true">
                {methods.map((m, i) => (
                  <i key={m.label} className={`tone-${i % 5}`} style={{ flexGrow: m.value }} />
                ))}
              </div>
              <ul className="rdash-methods">
                {methods.map((m, i) => (
                  <li key={m.label}>
                    <span className={`rdash-dot tone-${i % 5}`} aria-hidden="true" />
                    {m.label}
                    <b>{Math.round((m.value / methodTotal) * 100)}%</b>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      </div>

      <section className="panel-card">
        <div className="panel-head"><h3>Бүгінгі қорытынды</h3></div>
        <ul className="rdash-today">
          <li><span>🪚 Кесілген лист</span><b>{kpis.sheetsToday}</b></li>
          <li><span>🧻 ПВХ жабыстырылды</span><b>{pvcToday} м</b></li>
          <li><span>📦 Қоймада аз қалған</span><b>{kpis.lowStockCount} материал</b></li>
        </ul>
      </section>
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

function PaymentsTab({
  payments,
  orders,
}: {
  payments: ReturnType<typeof useAllPayments>["payments"];
  orders: ReturnType<typeof useAllOrders>["orders"];
}) {
  const valid = useMemo(() => payments.filter((p) => !p.reversed), [payments]);

  const money = useMemo(() => {
    const today = dayKey(new Date());
    const month = monthKey(new Date());
    const on = (p: (typeof valid)[number]) => (p.paymentDate ? dayKey(p.paymentDate) : "");
    const inMonth = (p: (typeof valid)[number]) => (p.paymentDate ? monthKey(p.paymentDate) : "");
    const live = orders.filter((o) => o.productionStatus !== "draft" && o.productionStatus !== "cancelled");
    return {
      today: valid.filter((p) => on(p) === today).reduce((s, p) => s + p.amountTiyn, 0),
      month: valid.filter((p) => inMonth(p) === month).reduce((s, p) => s + p.amountTiyn, 0),
      unpaid: live.reduce((s, o) => s + Math.max(0, o.totalTiyn - o.paidTiyn), 0),
      debt: live.reduce((s, o) => s + Math.max(0, o.debtTiyn), 0),
      reversed: payments.filter((p) => p.reversed).reduce((s, p) => s + p.amountTiyn, 0),
    };
  }, [valid, payments, orders]);

  /* Share of income per method, largest first — the bar makes the split readable at a glance in a
     way a column of numbers does not. */
  const byMethod = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of valid) map.set(p.methodName, (map.get(p.methodName) ?? 0) + p.amountTiyn);
    const total = [...map.values()].reduce((s, v) => s + v, 0);
    return {
      total,
      rows: [...map.entries()]
        .map(([name, tiyn]) => ({ name, tiyn, pct: total > 0 ? (tiyn / total) * 100 : 0 }))
        .sort((a, b) => b.tiyn - a.tiyn),
    };
  }, [valid]);

  const ordersById = useMemo(() => new Map(orders.map((o) => [o.id, o])), [orders]);
  const recent = useMemo(
    () => [...valid].sort((a, b) => (b.paymentDate?.seconds ?? 0) - (a.paymentDate?.seconds ?? 0)).slice(0, 25),
    [valid],
  );

  const exportRows = () =>
    valid.map((p) => ({
      Күні: p.paymentDate ? formatDateDMY(p.paymentDate) : "",
      Заказ: ordersById.get(p.orderId)?.orderNumber ?? p.orderId,
      Клиент: ordersById.get(p.orderId)?.customerName ?? "",
      Сома: p.amountTiyn / 100,
      "Төлем түрі": p.methodName,
      Кім: p.recordedByName,
    }));

  return (
    <div>
      <div className="kpi-row">
        <div className="kpi-card">
          <div className="kpi-text">
            <div className="kpi-label">Бүгінгі кіріс</div>
            <div className="kpi-value">{formatMoney(money.today)}</div>
          </div>
          <span className="kpi-icon is-green">📈</span>
        </div>
        <div className="kpi-card">
          <div className="kpi-text">
            <div className="kpi-label">Айлық кіріс</div>
            <div className="kpi-value">{formatMoney(money.month)}</div>
          </div>
          <span className="kpi-icon is-blue">🗓</span>
        </div>
        <div className="kpi-card">
          <div className="kpi-text">
            <div className="kpi-label">Төленбеген</div>
            <div className="kpi-value is-danger">{formatMoney(money.unpaid)}</div>
          </div>
          <span className="kpi-icon is-red">🧾</span>
        </div>
        <div className="kpi-card">
          <div className="kpi-text">
            <div className="kpi-label">Жалпы қарыз</div>
            <div className="kpi-value is-danger">{formatMoney(money.debt)}</div>
          </div>
          <span className="kpi-icon is-red">⚠️</span>
        </div>
      </div>

      <div className="panel-card">
        <div className="panel-head">
          <h3>Төлем түрлері бойынша кіріс</h3>
          <span className="jt-muted">{formatMoney(byMethod.total)}</span>
        </div>
        {byMethod.rows.length === 0 ? (
          <div className="empty-state">
            <div className="icon">📭</div>
            <p>Төлем жоқ</p>
            <p className="empty-state-hint">Тіркелген төлемдер осында түр бойынша бөлініп көрсетіледі.</p>
          </div>
        ) : (
          <div className="mbreak">
            {byMethod.rows.map((r) => (
              <div className="mbreak-row" key={r.name}>
                <span className="mbreak-name">{r.name}</span>
                <span className="mbreak-track">
                  <span className="mbreak-fill" style={{ width: `${r.pct}%` }} />
                </span>
                <span className="mbreak-money">{formatMoney(r.tiyn)}</span>
                <span className="mbreak-pct">{Math.round(r.pct)}%</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="panel-card">
        <div className="panel-head">
          <h3>Соңғы төлемдер</h3>
          {money.reversed > 0 && <span className="jt-muted">Қайтарылған: {formatMoney(money.reversed)}</span>}
        </div>
        {recent.length === 0 ? (
          <div className="empty-state">
            <div className="icon">📭</div>
            <p>Төлем жоқ</p>
          </div>
        ) : (
          <div className="data-table-wrap">
            <table className="data-table stack-mobile stack-compact">
              <thead>
                <tr>
                  <th>Күні</th>
                  <th>Заказ / Клиент</th>
                  <th className="num">Сома</th>
                  <th>Төлем түрі</th>
                  <th>Кім тіркеді</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((p) => {
                  const o = ordersById.get(p.orderId);
                  return (
                    <tr key={p.id}>
                      <td data-label="Күні">{p.paymentDate ? formatDateDMY(p.paymentDate) : "—"}</td>
                      <td data-label="Заказ / Клиент">
                        <strong>{o?.orderNumber ?? "—"}</strong>
                        <div className="wh-sub">{o?.customerName ?? ""}</div>
                      </td>
                      <td className="num" data-label="Сома">
                        <span className="jt-paid">{formatMoney(p.amountTiyn)}</span>
                      </td>
                      <td data-label="Төлем түрі">{p.methodName}</td>
                      <td data-label="Кім тіркеді" className="wh-sub">{p.recordedByName}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="wizard-actions" style={{ marginTop: 12 }}>
          <button className="btn btn-outline btn-sm" onClick={() => exportCsv("payments-report", exportRows())}>
            📄 CSV экспорт
          </button>
          <button className="btn btn-outline btn-sm" onClick={() => exportXlsx("payments-report", exportRows())}>
            📊 XLSX экспорт
          </button>
        </div>
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
