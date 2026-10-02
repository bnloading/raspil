import { useEffect, useMemo, useState, type FormEvent } from "react";
import { arrayRemove, arrayUnion, collection, deleteField, doc, getDocs, setDoc, updateDoc } from "firebase/firestore";
import { db } from "../../firebase";
import { useAuth } from "../../AuthContext";
import { Spinner, Toast } from "../../components";
import { AppShell } from "../../components/layout/AppShell";
import { MoneyInput } from "../../components/MoneyInput";
import { NumberField } from "../../components/NumberField";
import { useToast } from "../../hooks";
import { useAllOrders } from "../../hooks/useOrders";
import { useAllPayments } from "../../hooks/usePayments";
import { useAppSettings } from "../../hooks/useAppSettings";
import { useExpenses } from "../../hooks/useExpenses";
import { useRentPayments } from "../../hooks/useRentPayments";
import { useMaterials } from "../../hooks/useMaterials";
import { useAllInventoryMovements } from "../../hooks/useReports";
import { addExpense, deleteExpense, expenseDefaultDate, expensesByWeek, payWorkerFromCashbox, type ExpenseWeek } from "../../lib/expenses";
import { advancePeriodKey } from "../../lib/advances";
import { periodLabel, shiftPeriod } from "../../lib/salaryPeriod";
import { useStaff } from "../../hooks/useStaff";
import {
  accountForExpense,
  computeCashbox,
  expensesInPeriod,
  groupExpensesByName,
  CASH_ACCOUNTS,
  CASH_ACCOUNT_HINTS,
  CASH_ACCOUNT_LABELS,
  accountForMethod,
} from "../../lib/cashbox";
import { computeSheetsCutByPeriod } from "../../lib/dashboardStats";
import { availableMonths } from "../../lib/finance";
import { formatMoney, parseMoneyInput } from "../../lib/money";
import { logAudit } from "../../lib/audit";
import { dayKey, formatDateDMY, monthLabel } from "../../lib/dates";
import { exportCsv, exportXlsx } from "../../lib/exportTable";
import { DEPARTMENT_LABELS, departmentOf, departmentOfOrder, methodVisibleTo } from "../../lib/rbac";
import { shortOrderNumber } from "../../lib/orderCode";
import type { CashAccount, CashAdjustment, Department, Expense, PaymentMethodDef, UserRole } from "../../types/domain";
import type { CashboxSummary } from "../../lib/cashbox";

/**
 * "Касса" — where the shop's money is, and what left it.
 *
 * Two pots, because the owner keeps them apart in real life: the deposit account every transfer
 * lands on (Нұр, Kaspi, Pay, Бәлім) and the cash in the drawer. Money in is read straight from the
 * payments ledger — nothing is typed twice — and money out is the expense log the Manager keeps
 * here: "мусорға 15 000", "лист алуға 20 000".
 *
 * The Manager owns this page because the Manager is the person standing at the counter when the
 * rubbish is taken away and the sheets are bought. The margin side of the books (purchase prices,
 * the percentage allocations, net profit) stays on the Admin's Есептер page, so recording what was
 * spent never means being shown what was earned.
 */
export default function ManagerCashbox() {
  const { user, userData } = useAuth();
  const isAdmin = userData?.role === "admin";
  const myDepartment = userData ? departmentOf(userData) : "ldsp";
  const { orders, loading: ordersLoading } = useAllOrders();
  const { payments: allPayments, loading: paymentsLoading } = useAllPayments();
  const { expenses: allExpenses, loading: expensesLoading } = useExpenses();
  const { message, visible, showToast } = useToast();
  // Who can be paid out of the Касса — the same people the Аванс page lists.
  const { staff } = useStaff();
  const payable = useMemo(
    () => staff.filter((s) => s.role !== "customer" && !s.blocked).sort((a, b) => a.name.localeCompare(b.name, "kk")),
    [staff],
  );

  // Each line's касса is counted on its own orders/payments/expenses — never summed together, so
  // ЛДСП revenue never bleeds into the МДФ number or back (see lib/rbac.ts departmentOf()).
  const orderDeptById = useMemo(() => new Map(orders.map((o) => [o.id, departmentOfOrder(o)])), [orders]);
  const payments = useMemo(
    () => allPayments.filter((p) => (orderDeptById.get(p.orderId) ?? "ldsp") === myDepartment),
    [allPayments, orderDeptById, myDepartment],
  );
  const expenses = useMemo(
    () => allExpenses.filter((e) => (e.department ?? "ldsp") === myDepartment),
    [allExpenses, myDepartment],
  );
  const deptOrders = useMemo(() => orders.filter((o) => departmentOfOrder(o) === myDepartment), [orders, myDepartment]);

  // "Нақты кесілген" — actual cutting_consumption movements against this line's own materials, not
  // orders merely sitting in a queue. Category "mdf" is the МДФ line; every other category (or an
  // absent one, from before categories existed) is ЛДСП — same default lib/salary.ts already uses.
  const { materials: allMaterials } = useMaterials(false);
  const { movements } = useAllInventoryMovements();
  const deptMaterialIds = useMemo(
    () => new Set(allMaterials.filter((m) => (m.category === "mdf") === (myDepartment === "mdf")).map((m) => m.id)),
    [allMaterials, myDepartment],
  );
  const { settings, loading: settingsLoading } = useAppSettings();
  const openingBalanceTiyn = useMemo(
    () => settings.cashOpeningBalanceTiyn?.[myDepartment] ?? {},
    [settings.cashOpeningBalanceTiyn, myDepartment],
  );
  // This line's dated corrections ("Банкпен теңестіру") — see ApplicationSettings.cashAdjustments.
  const adjustments = useMemo(
    () => settings.cashAdjustments?.[myDepartment] ?? [],
    [settings.cashAdjustments, myDepartment],
  );
  // Rent the owner takes on the side ("Аренда") — counted on the Admin's and the Manager's Касса
  // alike, so the two show the same balance.
  const { rentPayments, loading: rentLoading } = useRentPayments();
  const rent = useMemo(
    () => rentPayments.filter((r) => (r.department ?? "ldsp") === myDepartment),
    [rentPayments, myDepartment],
  );

  const [methods, setMethods] = useState<PaymentMethodDef[]>([]);
  useEffect(() => {
    getDocs(collection(db, "paymentMethods"))
      .then((snap) => setMethods(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<PaymentMethodDef, "id">) }))))
      .catch(() => setMethods([]));
  }, []);

  const months = useMemo(() => {
    // The picker always offers this month, even before the first order or expense lands in it.
    const set = new Set(availableMonths(deptOrders));
    for (const e of expenses) set.add(e.date.slice(0, 7));
    set.add(dayKey(new Date()).slice(0, 7));
    return [...set].sort().reverse();
  }, [deptOrders, expenses]);

  /**
   * "" means all time — which, once the books have restarted, is the current books: everything
   * since the restart day. That is where the page opens. It used to open on the calendar month, so
   * on 1 October the 30.09 expenses — the first day of the new books — sat in September, out of
   * the list and out of "Шықты", beside a balance that did count them.
   */
  const [period, setPeriod] = useState<string>("");
  const effectivePeriod = period === "" ? null : period;

  // The day this line's money accounting starts over — everything before it stays in the order
  // history but is left out of every figure here (see ApplicationSettings.cashStartDate).
  const cashStartDate = settings.cashStartDate ?? null;
  // …and, when the owner closed the books at an order ("№281 заказға дейін расчет істелді"), the
  // first order of the new ones: orders before it are the old books' whatever day they carry.
  const cashStartOrderNumber = settings.cashStartOrderNumber ?? null;
  // The picker's all-time option, named for what it is once the books have restarted.
  const sinceLabel = cashStartDate ? `${dmy(cashStartDate)}-дан бері` : "Барлық уақыт";
  // Counted from the same day the money is: sheets cut before the restart belong to the old books.
  const sheetsCut = useMemo(
    () => computeSheetsCutByPeriod(movements, new Date(), deptMaterialIds, cashStartDate),
    [movements, deptMaterialIds, cashStartDate],
  );

  const cashbox = useMemo(
    () => computeCashbox({
      payments, expenses, methods, period: effectivePeriod, openingBalanceTiyn, startDate: cashStartDate,
      startOrderNumber: cashStartOrderNumber, orders, adjustments, rent,
    }),
    [payments, expenses, methods, effectivePeriod, openingBalanceTiyn, cashStartDate, cashStartOrderNumber, orders, adjustments, rent],
  );
  // "Қазір бізде бар" is what is in each account today — the all-time balance, opening included —
  // whichever month the picker shows. A month's own in − out is that month's flow, not money on
  // hand, and labelling it as the balance is how the card came to be read wrong.
  const cashboxNow = useMemo(
    () => computeCashbox({
      payments, expenses, methods, period: null, openingBalanceTiyn, startDate: cashStartDate,
      startOrderNumber: cashStartOrderNumber, orders, adjustments, rent,
    }),
    [payments, expenses, methods, openingBalanceTiyn, cashStartDate, cashStartOrderNumber, orders, adjustments, rent],
  );
  const rows = useMemo(
    () => expensesInPeriod(expenses, effectivePeriod, cashStartDate),
    [expenses, effectivePeriod, cashStartDate],
  );
  const groups = useMemo(() => groupExpensesByName(rows), [rows]);
  // Every expense this line ever logged, week by week — the restart takes the old ones out of the
  // figures above, never out of the record (see ExpenseHistory).
  const expenseWeeks = useMemo(() => expensesByWeek(expenses), [expenses]);

  // `cashStartDate`/`cashOpeningBalanceTiyn` (from settings) and each payment's department (from
  // orders) both feed computeCashbox below directly — settings defaults to no restart date at all
  // before its own listener resolves, so a page load used to compute and show one total (counting
  // from the very beginning, no restart applied) and then silently replace it with the real one the
  // moment settings caught up. Waiting on every input this page's own number depends on is what
  // makes the Spinner honest instead of a number that quietly changes under the reader.
  const loading = paymentsLoading || expensesLoading || ordersLoading || settingsLoading || rentLoading;

  const handleDelete = async (expense: Expense) => {
    if (!user || !userData) return;
    // Paid to a worker: deleting it reverses their advance too, which only an Admin may do.
    if (expense.advanceId && !isAdmin) {
      showToast(`Бұл — ${expense.paidToName ?? "қызметкерге"} берілген ақша. Өшіруді әкімші жасайды (аванс та бірге қайтарылады).`);
      return;
    }
    const extra = expense.advanceId ? `\n\n${expense.paidToName}-нің айлығындағы аванс та қайтарылады.` : "";
    if (!confirm(`"${expense.name}" — ${formatMoney(expense.amountTiyn)} жазбасын өшіресіз бе?${extra}`)) return;
    try {
      await deleteExpense(db, { user, userData }, expense);
      showToast("✅ Жазба өшірілді");
    } catch (err: unknown) {
      showToast("Қате: " + (err as Error).message);
    }
  };

  /** Admin: a payment on a pre-restart order that really was today's money — count it after all. */
  const handleCountPayment = async (paymentId: string) => {
    if (!user || !userData) return;
    const excluded = cashboxNow.excludedOldOrders.find((p) => p.paymentId === paymentId);
    try {
      await updateDoc(doc(db, "payments", paymentId), { countsInCurrentBooks: true });
      await logAudit(db, { user, userData }, {
        action: "payment.countsInCurrentBooks", entityType: "payment", entityId: paymentId,
        before: { countsInCurrentBooks: false }, after: { countsInCurrentBooks: true },
        comment: excluded ? `${excluded.orderNumber} ${formatMoney(excluded.amountTiyn)} ${excluded.methodName}` : undefined,
      }).catch(() => {});
      showToast(`✅ ${excluded?.orderNumber ?? "Төлем"} Кассаға қосылды`);
    } catch (err: unknown) {
      showToast("Қате: " + (err as Error).message);
    }
  };

  /** Admin: take back a correction entered by mistake. */
  const handleRemoveAdjustment = async (adjustment: CashAdjustment) => {
    if (!user || !userData) return;
    try {
      await updateDoc(doc(db, "applicationSettings", "global"), {
        [`cashAdjustments.${myDepartment}`]: arrayRemove(adjustment),
      });
      await logAudit(db, { user, userData }, {
        action: "cash.adjustment.remove", entityType: "applicationSettings", entityId: "global",
        before: { ...adjustment }, comment: adjustment.note,
      }).catch(() => {});
      showToast("✅ Түзету өшірілді");
    } catch (err: unknown) {
      showToast("Қате: " + (err as Error).message);
    }
  };

  const exportRows = () =>
    rows.map((e) => ({
      Күні: e.date,
      Атауы: e.name,
      Қайдан: CASH_ACCOUNT_LABELS[accountForExpense(e)],
      Сомасы: e.amountTiyn / 100,
      Түсініктеме: e.comment ?? "",
      "Кім жазды": e.createdByName,
    }));

  const exportName = `${myDepartment}-касса-шығын`;

  return (
    <AppShell
      title={`Касса — ${DEPARTMENT_LABELS[myDepartment]}`}
      subtitle={`${effectivePeriod ? monthLabel(effectivePeriod) : sinceLabel} — түсім және шығын`}
      back="/manager"
    >
      <div className="cashbox-toolbar">
        <select className="form-input cashbox-period" value={period} onChange={(e) => setPeriod(e.target.value)}
          aria-label="Кезең">
          <option value="">{sinceLabel}</option>
          {months.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
        </select>
        <button className="btn btn-outline btn-sm" onClick={() => exportCsv(exportName, exportRows())}>
          ⭳ CSV
        </button>
        <button className="btn btn-outline btn-sm" onClick={() => exportXlsx(exportName, exportRows())}>
          ⭳ Excel
        </button>
      </div>

      {loading ? (
        <Spinner />
      ) : (
        <>
          <div className="kpi-row">
            <div className="kpi-card">
              <div className="kpi-text">
                <div className="kpi-label">Осы аптада нақты кесілген</div>
                <div className="kpi-value">{sheetsCut.week} лист</div>
              </div>
              <span className="kpi-icon is-indigo">🪚</span>
            </div>
            <div className="kpi-card">
              <div className="kpi-text">
                <div className="kpi-label">Осы айда нақты кесілген</div>
                <div className="kpi-value">{sheetsCut.month} лист</div>
              </div>
              <span className="kpi-icon is-green">🪚</span>
            </div>
          </div>

          <CashboxAccounts cashbox={cashbox} cashboxNow={cashboxNow} openingBalanceTiyn={openingBalanceTiyn} period={effectivePeriod}
            startDate={cashStartDate}
            startOrderNumber={cashStartOrderNumber}
            onCountPayment={isAdmin ? handleCountPayment : undefined}
            onRemoveAdjustment={isAdmin ? handleRemoveAdjustment : undefined} />

          <ExpenseForm
            defaultDate={expenseDefaultDate(effectivePeriod)}
            cashStartDate={cashStartDate}
            department={myDepartment}
            staff={payable}
            onSaved={(name, amountTiyn) => showToast(`✅ ${name} — ${formatMoney(amountTiyn)} жазылды`)}
            onError={showToast}
          />

          <section className="panel-card">
            <div className="panel-head">
              <h3>Шығындар</h3>
              <span className="wh-sub">{rows.length} жазба</span>
            </div>
            {rows.length === 0 ? (
              <div className="empty-state">
                <div className="icon">🧾</div>
                <p>Бұл кезеңде шығын жазылмаған</p>
                <span>Жоғарыдағы жолға атауын, сомасын жазып қосыңыз.</span>
              </div>
            ) : (
              <div className="data-table-wrap">
                <table className="data-table stack-mobile stack-compact">
                  <thead>
                    <tr>
                      <th>Күні</th>
                      <th>Атауы</th>
                      <th>Қайдан</th>
                      <th className="num">Сомасы</th>
                      <th>Кім жазды</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((e) => (
                      <tr key={e.id}>
                        <td data-label="Күні" className="wh-sub">{formatDateDMY(new Date(`${e.date}T12:00:00+05:00`))}</td>
                        <td data-label="Атауы">
                          <strong>{e.name}</strong>
                          {e.comment && <div className="wh-sub">{e.comment}</div>}
                          {e.paidToName && e.payPeriodKey && (
                            <div className="wh-sub">👤 {e.paidToName} · {periodLabel(e.payPeriodKey)} айлығынан</div>
                          )}
                        </td>
                        <td data-label="Қайдан">
                          <span className={`cashbox-tag is-${accountForExpense(e)}`}>
                            {CASH_ACCOUNT_LABELS[accountForExpense(e)]}
                          </span>
                        </td>
                        <td className="num" data-label="Сомасы"><span className="jt-debt">{formatMoney(e.amountTiyn)}</span></td>
                        <td data-label="Кім жазды" className="wh-sub">{e.createdByName}</td>
                        <td className="num">
                          {/* firestore.rules lets a Manager remove only their own entry; anyone
                              else's is the Admin's to correct, so the button is hidden rather
                              than offered and then refused. */}
                          {(isAdmin || (e.createdByUid === user?.uid && !e.advanceId)) && (
                            <button className="jt-icon-btn" onClick={() => handleDelete(e)} title="Өшіру"
                              aria-label={`"${e.name}" жазбасын өшіру`}>✕</button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {groups.length > 1 && (
            <section className="panel-card">
              <div className="panel-head">
                <h3>Не көп кетті</h3>
              </div>
              <ul className="cashbox-groups">
                {groups.map((g) => (
                  <li key={g.name}>
                    <span className="cashbox-group-name">{g.name}</span>
                    <span className="wh-sub">{g.count} рет</span>
                    <strong>{formatMoney(g.amountTiyn)}</strong>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <ExpenseHistory weeks={expenseWeeks} startDate={cashStartDate} />

          {isAdmin && (
            <MethodAccounts methods={methods} setMethods={setMethods} department={myDepartment} onError={showToast} />
          )}

          {isAdmin && (
            <OpeningBalanceEditor
              department={myDepartment}
              openingBalanceTiyn={openingBalanceTiyn}
              cashStartDate={cashStartDate}
              cashStartOrderNumber={cashStartOrderNumber}
              onError={showToast}
            />
          )}

          {isAdmin && <ReconcileEditor department={myDepartment} cashboxNow={cashboxNow} onToast={showToast} />}
        </>
      )}

      <Toast message={message} visible={visible} />
    </AppShell>
  );
}

/**
 * The expense entry row.
 *
 * One line, not a modal: at this counter an expense is written down between two customers, and a
 * dialog that has to be opened and dismissed is the reason expenses stop being written down at
 * all. Everything it needs is on one row — atauy, sum, which pot, the day.
 */
function ExpenseForm({
  defaultDate,
  cashStartDate,
  department,
  staff,
  onSaved,
  onError,
}: {
  defaultDate: string;
  /** The accounting restart day — an expense dated before it is saved but never counted here. */
  cashStartDate: string | null;
  department: Department;
  /** People who draw pay — money handed to one of them is also their advance (payWorkerFromCashbox). */
  staff: { id: string; name: string; role: UserRole }[];
  onSaved: (name: string, amountTiyn: number) => void;
  onError: (message: string) => void;
}) {
  const { user, userData } = useAuth();
  const [name, setName] = useState("");
  const [amountTenge, setAmountTenge] = useState(0);
  const [account, setAccount] = useState<CashAccount>("cash");
  const [date, setDate] = useState(defaultDate);
  const [comment, setComment] = useState("");
  const [saving, setSaving] = useState(false);
  // "Қызметкерге": the pay period it comes off — this week/month as an advance, or the last one
  // as its pay. A cutter's period is a week, everyone else's a month (lib/advances.ts).
  const [workerId, setWorkerId] = useState("");
  const [forLastPeriod, setForLastPeriod] = useState(false);
  const worker = staff.find((s) => s.id === workerId);
  const thisPeriod = worker ? advancePeriodKey(worker.role) : "";
  const payPeriodKey = worker ? (forLastPeriod ? shiftPeriod(thisPeriod, -1) : thisPeriod) : "";

  // Following the period picker: choosing an older month should offer that month's dates, not
  // today's, or every backdated entry has to be corrected by hand.
  useEffect(() => setDate(defaultDate), [defaultDate]);

  const beforeStart = !!cashStartDate && date < cashStartDate;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!user || !userData) return;
    const amountTiyn = Math.round(amountTenge * 100);
    // Paid to a worker, the name can be left blank — the worker's own name is what it is.
    const title = name.trim() || worker?.name || "";
    if (!title || amountTiyn <= 0) {
      onError("Атауы мен соманы толтырыңыз");
      return;
    }
    setSaving(true);
    try {
      if (worker) {
        await payWorkerFromCashbox(db, { user, userData }, {
          name: title,
          amountTiyn,
          date,
          account,
          department,
          comment: comment.trim(),
          worker: { uid: worker.id, name: worker.name },
          periodKey: payPeriodKey,
        });
      } else {
        await addExpense(db, { user, userData }, {
          name: title,
          amountTiyn,
          date,
          account,
          department,
          comment: comment.trim(),
        });
      }
      onSaved(title, amountTiyn);
      setName("");
      setAmountTenge(0);
      setComment("");
      setWorkerId("");
      setForLastPeriod(false);
    } catch (err: unknown) {
      onError("Қате: " + (err as Error).message);
    }
    setSaving(false);
  };

  return (
    <section className="panel-card">
      <div className="panel-head">
        <h3>Шығын жазу</h3>
      </div>
      <form className="cashbox-form" onSubmit={submit}>
        <label className="cashbox-field is-wide">
          <span>Атауы</span>
          <input className="form-input" placeholder="Мусор, лист алуға, жөндеу…" value={name}
            onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="cashbox-field">
          <span>Сомасы (₸)</span>
          <NumberField value={amountTenge} min={0} onChange={setAmountTenge} ariaLabel="Шығын сомасы" />
        </label>
        <label className="cashbox-field">
          <span>Қайдан</span>
          <select className="form-input" value={account} onChange={(e) => setAccount(e.target.value as CashAccount)}>
            {CASH_ACCOUNTS.map((a) => <option key={a} value={a}>{CASH_ACCOUNT_LABELS[a]}</option>)}
          </select>
        </label>
        <label className="cashbox-field">
          <span>Күні</span>
          <input type="date" className="form-input" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className="cashbox-field is-wide">
          <span>Түсініктеме (міндетті емес)</span>
          <input className="form-input" placeholder="Кімге, не үшін" value={comment}
            onChange={(e) => setComment(e.target.value)} />
        </label>
        {/* Money to a worker goes on their payslip as well as off the Касса — written only here,
            Олжас's 300 000 ₸ advance of 29.09 never reached his week (payWorkerFromCashbox). */}
        <label className="cashbox-field">
          <span>Қызметкерге (аванс / айлық)</span>
          <select className="form-input" value={workerId} onChange={(e) => setWorkerId(e.target.value)}>
            <option value="">— жоқ —</option>
            {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        {worker && (
          <label className="cashbox-field">
            <span>Не үшін</span>
            <select className="form-input" value={forLastPeriod ? "last" : "this"}
              onChange={(e) => setForLastPeriod(e.target.value === "last")}>
              <option value="this">Аванс — {periodLabel(thisPeriod)}</option>
              <option value="last">Айлығы — {periodLabel(shiftPeriod(thisPeriod, -1))}</option>
            </select>
          </label>
        )}
        {worker && (
          <p className="form-hint is-wide">
            {worker.name}-нің {periodLabel(payPeriodKey)} айлығынан шегеріледі — «Айлығым» бетінде
            «Алынғаны» болып көрінеді.
          </p>
        )}
        {/* Said before the button, not after: an expense dated before the restart is written to
            the database and then left out of every figure on this page, so without this it looks
            for all the world like the save simply did nothing. */}
        {beforeStart && (
          <p className="cashbox-warn is-wide">
            ⚠️ Бұл күн есеп басталатын күннен ({formatDateDMY(new Date(`${cashStartDate}T12:00:00+05:00`))}) бұрын —
            шығын сақталады, бірақ Кассада көрінбейді және есепке кірмейді.
          </p>
        )}
        <button type="submit" className="btn btn-primary cashbox-submit" disabled={saving}>
          {saving ? "Сақталуда…" : "🧾 Шығынды жазу"}
        </button>
      </form>
    </section>
  );
}

/**
 * Which pot each payment method pays into — Admin only (firestore.rules: paymentMethods is an
 * Admin-write catalogue).
 *
 * The default rule ("cash is cash, every transfer is a deposit") is right for this shop today, but
 * it is a guess about how the money moves, and a guess about money should be correctable without
 * a developer. Changing a method here re-reads every past payment through the new mapping, because
 * the balances are derived rather than stored.
 */
function MethodAccounts({
  methods,
  setMethods,
  department,
  onError,
}: {
  methods: PaymentMethodDef[];
  setMethods: (next: PaymentMethodDef[]) => void;
  department: Department;
  onError: (message: string) => void;
}) {
  // `methods` stays the full list (computeCashbox above needs every method, both lines', to price
  // payments correctly) — only what's rendered here is scoped to the viewer's own line, and
  // `change()` must still map over the FULL array or an optimistic update would drop the other
  // line's methods from state until the next reload.
  const visible = methods.filter((m) => methodVisibleTo(m, department));

  const change = async (method: PaymentMethodDef, account: CashAccount) => {
    const next = methods.map((m) => (m.id === method.id ? { ...m, account } : m));
    setMethods(next); // optimistic: the balances above recompute as soon as the select changes
    try {
      await updateDoc(doc(db, "paymentMethods", method.id), { account });
    } catch (err: unknown) {
      setMethods(methods);
      onError("Қате: " + (err as Error).message);
    }
  };

  return (
    <section className="panel-card">
      <div className="panel-head">
        <h3>Төлем түрі қай кассаға түседі</h3>
      </div>
      <ul className="cashbox-mapping">
        {visible.map((m) => (
          <li key={m.id}>
            <span>{m.name}</span>
            <select className="form-input" value={accountForMethod(m)} onChange={(e) => change(m, e.target.value as CashAccount)}
              aria-label={`${m.name} — кассасы`}>
              {CASH_ACCOUNTS.map((a) => <option key={a} value={a}>{CASH_ACCOUNT_LABELS[a]}</option>)}
            </select>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The balance already sitting in each pot before this app started tracking money — Admin only,
 * one number per pot, applied only to "Барлық уақыт" (see lib/cashbox.ts computeCashbox). Written
 * straight to applicationSettings/global, scoped under the admin's own department: ЛДСП and МДФ
 * now run separate cash accounts, so a starting balance belongs to one line, not both.
 */
function OpeningBalanceEditor({
  department,
  openingBalanceTiyn,
  cashStartDate,
  cashStartOrderNumber,
  onError,
}: {
  department: Department;
  openingBalanceTiyn: Partial<Record<CashAccount, number>>;
  cashStartDate: string | null;
  cashStartOrderNumber: string | null;
  onError: (message: string) => void;
}) {
  const [saving, setSaving] = useState<CashAccount | null>(null);
  const [savingDate, setSavingDate] = useState(false);

  const change = async (account: CashAccount, valueTiyn: number) => {
    setSaving(account);
    try {
      await setDoc(
        doc(db, "applicationSettings", "global"),
        { cashOpeningBalanceTiyn: { [department]: { [account]: valueTiyn } } },
        { merge: true },
      );
    } catch (err: unknown) {
      onError("Қате: " + (err as Error).message);
    } finally {
      setSaving(null);
    }
  };

  // Shop-wide, not per line: "we start counting from this day" is one decision for the business.
  // A new day is a new restart, so it drops the order the last one was drawn at — left behind, that
  // order would quietly go on deciding which books every order since belongs to.
  const changeStartDate = async (value: string) => {
    setSavingDate(true);
    try {
      await setDoc(
        doc(db, "applicationSettings", "global"),
        { cashStartDate: value, cashStartOrderNumber: deleteField() },
        { merge: true },
      );
    } catch (err: unknown) {
      onError("Қате: " + (err as Error).message);
    } finally {
      setSavingDate(false);
    }
  };

  // "№281 заказға дейін расчет істелді" — the books closed at an order rather than at midnight.
  // Typed as the short number the journal shows; the year is the start date's, the way
  // lib/orderNumber.ts writes ORD-{year}-{seq:6}. Empty goes back to splitting by the order's day.
  const changeStartOrder = async (text: string) => {
    const seq = Number(text.replace(/\D/g, ""));
    const year = (cashStartDate ?? dayKey(new Date())).slice(0, 4);
    const value = seq > 0 ? `ORD-${year}-${String(seq).padStart(6, "0")}` : null;
    if (value === cashStartOrderNumber) return;
    setSavingDate(true);
    try {
      await setDoc(
        doc(db, "applicationSettings", "global"),
        { cashStartOrderNumber: value ?? deleteField() },
        { merge: true },
      );
    } catch (err: unknown) {
      onError("Қате: " + (err as Error).message);
    } finally {
      setSavingDate(false);
    }
  };

  return (
    <section className="panel-card">
      <div className="panel-head">
        <h3>Бастапқы сумма — {DEPARTMENT_LABELS[department]}</h3>
      </div>
      <p className="form-hint">
        Есеп басталатын күндегі кассада тұрған сома. Тек "Барлық уақыт" қалдығына қосылады.
      </p>
      <div className="form-group">
        <label>Есеп басталатын күн</label>
        <input
          type="date"
          className="form-input"
          value={cashStartDate ?? ""}
          onChange={(e) => changeStartDate(e.target.value)}
        />
        <p className="form-hint">
          Осы күннен бұрынғы төлемдер мен шығындар Кассада есептелмейді (заказдар тарихы
          сақталады).{savingDate ? " сақталуда…" : ""}
        </p>
      </div>
      <div className="form-group">
        <label>Қай заказдан басталады</label>
        <input
          key={cashStartOrderNumber ?? ""}
          className="form-input"
          inputMode="numeric"
          placeholder="Заказ күні бойынша"
          defaultValue={cashStartOrderNumber ? shortOrderNumber(cashStartOrderNumber) : ""}
          onBlur={(e) => changeStartOrder(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
          aria-label="Есеп басталатын заказ нөмірі"
        />
        <p className="form-hint">
          «№281 заказға дейін расчет істелді» деген сияқты: осы нөмірден бұрынғы заказдардың
          төлемдері Кассаға кірмейді, қай күні жазылса да, ал журналда осы заказдың үстіне сызық
          түседі. Бос болса, заказ күні бойынша бөлінеді. Күнді өзгертсеңіз, бұл өріс тазаланады.
        </p>
      </div>
      <ul className="cashbox-mapping">
        {CASH_ACCOUNTS.map((a) => (
          <li key={a}>
            <span>{CASH_ACCOUNT_LABELS[a]}</span>
            <MoneyInput
              valueTiyn={openingBalanceTiyn[a] ?? 0}
              onChange={(tiyn) => change(a, tiyn)}
              placeholder="0"
            />
            {saving === a && <span className="cashbox-count"> сақталуда…</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * One card per account and the total under them. Each card leads with "Қазір бізде бар" — the
 * all-time balance, which is the money actually in that account today — and shows the sum behind
 * it: бастапқы + түсті − шықты, or the chosen month's own түсті/шықты when a month is picked.
 * Pure, so tests/mobile-design-preview.tsx can draw it on sample figures.
 */
export function CashboxAccounts({
  cashbox,
  cashboxNow,
  openingBalanceTiyn,
  period: effectivePeriod,
  startDate = null,
  startOrderNumber = null,
  onCountPayment,
  onRemoveAdjustment,
}: {
  /** The picked period's flows. */
  cashbox: CashboxSummary;
  /** All time — what is in each account now. */
  cashboxNow: CashboxSummary;
  openingBalanceTiyn: Partial<Record<CashAccount, number>>;
  period: string | null;
  /** The accounting restart — names the date in the "left out" note. */
  startDate?: string | null;
  /** …or the order it was drawn at, which is what then decides what was left out. */
  startOrderNumber?: string | null;
  /** Admin only: count a left-out payment as today's money after all (Payment.countsInCurrentBooks). */
  onCountPayment?: (paymentId: string) => void;
  /** Admin only: take back a correction entered by mistake. */
  onRemoveAdjustment?: (adjustment: CashAdjustment) => void;
}) {
  const nowByAccount = new Map(cashboxNow.accounts.map((a) => [a.account, a.balanceTiyn]));
  const totalOpeningTiyn = CASH_ACCOUNTS.reduce((s, a) => s + (openingBalanceTiyn[a] ?? 0), 0);
  // Two taps for anything that moves a balance: the first arms the button ("Растау?"), the second
  // acts. Not window.confirm() — a phone draws that itself, and on an iPhone it showed only its edge.
  const [armed, setArmed] = useState<string | null>(null);
  const twoTap = (key: string, act: () => void) => () => {
    if (armed === key) {
      setArmed(null);
      act();
    } else setArmed(key);
  };

  return (
    <>
      {/* The answer first, above the accounts it adds up — the owner's choice (01.10): "Қазір бізде
          барлығы" is the real money, and it used to sit under the three cards, below the fold on a
          phone. The flows beside it are how it got there. */}
      <div className="cashbox-total is-head">
        <span className="cashbox-total-now">
          Қазір бізде барлығы <strong className={cashboxNow.totalBalanceTiyn < 0 ? "is-out" : undefined}>
            {formatMoney(cashboxNow.totalBalanceTiyn)}
          </strong>
        </span>
        {effectivePeriod === null && totalOpeningTiyn > 0 && (
          <span>Бастапқы <strong>{formatMoney(totalOpeningTiyn)}</strong></span>
        )}
        <span>
          {effectivePeriod === null ? "+ Түсті" : `${monthLabel(effectivePeriod)}: түсті`}{" "}
          <strong className="is-in">{formatMoney(cashbox.totalInTiyn)}</strong>
        </span>
        {(cashbox.totalRentTiyn ?? 0) > 0 && (
          <span>+ Аренда <strong className="is-in">{formatMoney(cashbox.totalRentTiyn ?? 0)}</strong></span>
        )}
        <span>− Шықты <strong className="is-out">{formatMoney(cashbox.totalOutTiyn)}</strong></span>
        {cashbox.totalAdjustTiyn !== 0 && <span>± Түзету <strong>{signed(cashbox.totalAdjustTiyn)}</strong></span>}
      </div>

      <div className="cashbox-accounts">
        {cashbox.accounts.map((acc) => (
          <section key={acc.account} className={`cashbox-card is-${acc.account}`}>
            <header>
              <h3>{CASH_ACCOUNT_LABELS[acc.account]}</h3>
              <p>{CASH_ACCOUNT_HINTS[acc.account]}</p>
            </header>
            <div className="cashbox-balance">
              <span className="cashbox-balance-label">Қазір бізде бар</span>
              <strong className={(nowByAccount.get(acc.account) ?? 0) < 0 ? "is-negative" : ""}>
                {formatMoney(nowByAccount.get(acc.account) ?? 0)}
              </strong>
            </div>
            {/* The sum behind the figure above: бастапқы + түсті (+ аренда) − шықты ± түзету. It used to read
                "Қалдық 3 195 507 (оның ішінде бастапқы 4 253 791)" — a balance that "includes"
                a larger number. For a single month it is that month's flow instead, named as such. */}
            {effectivePeriod !== null && <p className="cashbox-flow-title">{monthLabel(effectivePeriod)}</p>}
            <dl className="cashbox-flow">
              {effectivePeriod === null && (openingBalanceTiyn[acc.account] ?? 0) > 0 && (
                <div>
                  <dt>Бастапқы</dt>
                  <dd>{formatMoney(openingBalanceTiyn[acc.account])}</dd>
                </div>
              )}
              <div>
                <dt>+ Түсті</dt>
                <dd className="is-in">{formatMoney(acc.inTiyn)}</dd>
              </div>
              {/* The rent that landed in this account (Аренда page). */}
              {(acc.rentTiyn ?? 0) > 0 && (
                <div>
                  <dt>+ Аренда</dt>
                  <dd className="is-in">{formatMoney(acc.rentTiyn ?? 0)}</dd>
                </div>
              )}
              <div>
                <dt>− Шықты</dt>
                <dd className={acc.outTiyn > 0 ? "is-out" : undefined}>{formatMoney(acc.outTiyn)}</dd>
                {acc.expenseCount > 0 && <dd className="cashbox-count">{acc.expenseCount} жазба</dd>}
              </div>
              {acc.adjustTiyn !== 0 && (
                <div>
                  <dt>± Түзету</dt>
                  <dd>{signed(acc.adjustTiyn)}</dd>
                </div>
              )}
            </dl>
            {/* One method is the "Түсті" figure again; the split only says something when
                two methods share the account (Kaspi and Pay). */}
            {acc.byMethod.length > 1 && (
              <ul className="cashbox-methods">
                {acc.byMethod.map((m) => (
                  <li key={m.methodId}>
                    <span>{m.methodName}</span>
                    <strong>{formatMoney(m.amountTiyn)}</strong>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>

      {/* Every correction, with its date and reason — a balance brought in line with the bank has
          to say by how much and why, or the next person to read it cannot tell it was touched. */}
      {cashboxNow.adjustments.length > 0 && (
        <details className="cashbox-excluded cashbox-adjustments" open>
          <summary>
            Түзетулер: {cashboxNow.adjustments.length} — <strong>{signed(cashboxNow.totalAdjustTiyn)}</strong>
          </summary>
          <ul>
            {cashboxNow.adjustments.map((a) => (
              <li key={a.id}>
                <span>
                  {dmy(a.date)} · {CASH_ACCOUNT_LABELS[a.account]} · {a.note}{a.byName ? ` · ${a.byName}` : ""}
                </span>
                <strong>{signed(a.amountTiyn)}</strong>
                {onRemoveAdjustment && (
                  <button type="button" className={armed === `adj-${a.id}` ? "btn btn-outline btn-sm is-armed" : "jt-icon-btn"}
                    title="Өшіру" aria-label={`${a.note} түзетуін өшіру`}
                    onClick={twoTap(`adj-${a.id}`, () => onRemoveAdjustment(a))}>
                    {armed === `adj-${a.id}` ? "Өшіру?" : "✕"}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}

      {/* Money taken since the restart on orders from before it — left out of every figure above
          (lib/cashbox.ts computeCashbox), but listed, so a late payment on an old order is never
          simply gone: it is the old books', and this is where the owner can see it went. An Admin
          can count one in after all, when it was real money taken today. */}
      {cashboxNow.excludedOldOrders.length > 0 && (
        <details className="cashbox-excluded">
          <summary>
            {startOrderNumber
              ? `№${shortOrderNumber(startOrderNumber)} заказға дейінгі`
              : startDate ? `${dmy(startDate)}-ға дейінгі` : "Ескі"} заказдарға кейін түскен{" "}
            {cashboxNow.excludedOldOrders.length} төлем —{" "}
            <strong>{formatMoney(cashboxNow.excludedOldOrders.reduce((s, p) => s + p.amountTiyn, 0))}</strong>.
            Бұл Кассаға кірмейді.
          </summary>
          <ul>
            {cashboxNow.excludedOldOrders.map((p) => (
              <li key={p.paymentId}>
                <span>
                  {p.orderNumber} · заказ {dmy(p.orderDay)} · төленді {dmy(p.paymentDay)} · {p.methodName}
                </span>
                <strong>{formatMoney(p.amountTiyn)}</strong>
                {onCountPayment && (
                  <button type="button" className={`btn btn-outline btn-sm${armed === `pay-${p.paymentId}` ? " is-armed" : ""}`}
                    onClick={twoTap(`pay-${p.paymentId}`, () => onCountPayment(p.paymentId))}>
                    {armed === `pay-${p.paymentId}` ? "Растау?" : "Кассаға қосу"}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

/**
 * "Шығындар тарихы" — every expense ever written, a week to a line, opened with a tap.
 *
 * The restart takes everything spent before it out of the figures and the Шығындар list above,
 * which after 30.09 read as September's expenses having vanished. None was deleted; this is where
 * they are kept to be read — the whole week's total on the line, its entries underneath, and the
 * ones Касса no longer counts said so.
 */
function ExpenseHistory({ weeks, startDate }: { weeks: ExpenseWeek[]; startDate: string | null }) {
  if (weeks.length === 0) return null;
  const today = dayKey(new Date());
  return (
    <section className="panel-card">
      <div className="panel-head">
        <h3>Шығындар тарихы — апта бойынша</h3>
        <span className="wh-sub">{weeks.length} апта</span>
      </div>
      <div className="expense-weeks">
        {weeks.map((w) => {
          const settled = !!startDate && w.end < startDate;
          return (
            <details key={w.start} className="expense-week">
              <summary>
                <span className="expense-week-range">
                  {w.start.slice(8, 10)}.{w.start.slice(5, 7)} – {dmy(w.end)}
                  {w.start <= today && today <= w.end && <em> · осы апта</em>}
                </span>
                <span className="wh-sub">{w.expenses.length} жазба{settled ? " · есептен бұрын" : ""}</span>
                <strong>{formatMoney(w.totalTiyn)}</strong>
              </summary>
              <ul>
                {w.expenses.map((e) => (
                  <li key={e.id}>
                    <span className="wh-sub expense-week-day">{dmy(e.date)}</span>
                    <span className="expense-week-name">
                      {e.name}
                      {e.comment && <small> · {e.comment}</small>}
                      {!settled && startDate && e.date < startDate && <small> · Кассаға кірмейді</small>}
                    </span>
                    <span className={`cashbox-tag is-${accountForExpense(e)}`}>{CASH_ACCOUNT_LABELS[accountForExpense(e)]}</span>
                    <strong>{formatMoney(e.amountTiyn)}</strong>
                  </li>
                ))}
              </ul>
            </details>
          );
        })}
      </div>
    </section>
  );
}

/** "+1 385 385 ₸" / "−22 000 ₸" */
const signed = (tiyn: number) => (tiyn < 0 ? `−${formatMoney(-tiyn)}` : `+${formatMoney(tiyn)}`);

/**
 * "Банкпен теңестіру" — Admin types what the account really holds right now, and the difference
 * from what Касса computes is saved as one dated correction (ApplicationSettings.cashAdjustments).
 *
 * The opening balance is left alone on purpose: it says what the account held on the restart day,
 * and folding today's gap into it would rewrite that. A correction keeps the gap visible — how
 * much, when, and why — beside the figures it corrects, and can be taken back if it was wrong.
 */
function ReconcileEditor({
  department,
  cashboxNow,
  onToast,
}: {
  department: Department;
  /** All-time figures — the balance being brought in line. */
  cashboxNow: CashboxSummary;
  onToast: (message: string) => void;
}) {
  const { user, userData } = useAuth();
  const [account, setAccount] = useState<CashAccount>("deposit");
  const [actualText, setActualText] = useState("");
  const [note, setNote] = useState("Банкпен теңестіру");
  const [saving, setSaving] = useState(false);

  const computed = cashboxNow.accounts.find((a) => a.account === account)?.balanceTiyn ?? 0;
  const hasActual = actualText.trim() !== "";
  const actual = parseMoneyInput(actualText);
  const diff = hasActual ? actual - computed : 0;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!user || !userData || !hasActual || diff === 0) return;
    const adjustment: CashAdjustment = {
      id: crypto.randomUUID(),
      account,
      amountTiyn: diff,
      date: dayKey(new Date()),
      note: note.trim() || "Банкпен теңестіру",
      byUid: user.uid,
      byName: userData.name,
    };
    setSaving(true);
    try {
      await updateDoc(doc(db, "applicationSettings", "global"), {
        [`cashAdjustments.${department}`]: arrayUnion(adjustment),
      });
      await logAudit(db, { user, userData }, {
        action: "cash.adjustment.add", entityType: "applicationSettings", entityId: "global",
        before: { balanceTiyn: computed }, after: { ...adjustment, balanceTiyn: actual }, comment: adjustment.note,
      }).catch(() => {});
      onToast(`✅ ${CASH_ACCOUNT_LABELS[account]}: ${signed(diff)} түзету жазылды`);
      setActualText("");
    } catch (err: unknown) {
      onToast("Қате: " + (err as Error).message);
    }
    setSaving(false);
  };

  return (
    <section className="panel-card reconcile-card">
      <div className="panel-head">
        <h3>Банкпен теңестіру</h3>
      </div>
      <form onSubmit={handleSubmit}>
        <div className="form-group">
          <label htmlFor="reconcile-account">Шот</label>
          <select id="reconcile-account" className="form-input" value={account}
            onChange={(e) => setAccount(e.target.value as CashAccount)}>
            {CASH_ACCOUNTS.map((a) => <option key={a} value={a}>{CASH_ACCOUNT_LABELS[a]}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label htmlFor="reconcile-actual">Шотта қазір нақты қанша бар? (₸)</label>
          <input id="reconcile-actual" className="form-input" type="text" inputMode="numeric" autoComplete="off"
            value={actualText} placeholder="4 430 482" onChange={(e) => setActualText(e.target.value)} />
          <p className="form-hint">
            Кассада: {formatMoney(computed)}
            {hasActual ? (diff === 0 ? " · сәйкес, түзету керек емес" : ` · айырма ${signed(diff)}`) : ""}
          </p>
        </div>
        <div className="form-group">
          <label htmlFor="reconcile-note">Себебі</label>
          <input id="reconcile-note" className="form-input" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        <button type="submit" className="btn btn-primary" disabled={saving || !hasActual || diff === 0}>
          {hasActual && diff !== 0 ? `${signed(diff)} түзету жазу` : "Түзету жазу"}
        </button>
      </form>
    </section>
  );
}

/** "2026-09-22" → "22.09.2026" */
const dmy = (day: string) => formatDateDMY(new Date(`${day}T12:00:00+05:00`));
