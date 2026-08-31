import { useEffect, useMemo, useState, type FormEvent } from "react";
import { collection, doc, getDocs, updateDoc } from "firebase/firestore";
import { db } from "../../firebase";
import { useAuth } from "../../AuthContext";
import { Spinner, Toast } from "../../components";
import { AppShell } from "../../components/layout/AppShell";
import { NumberField } from "../../components/NumberField";
import { useToast } from "../../hooks";
import { useAllOrders } from "../../hooks/useOrders";
import { useAllPayments } from "../../hooks/usePayments";
import { useExpenses } from "../../hooks/useExpenses";
import { addExpense, deleteExpense } from "../../lib/expenses";
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
import { availableMonths } from "../../lib/finance";
import { formatMoney } from "../../lib/money";
import { dayKey, formatDateDMY, monthLabel } from "../../lib/dates";
import { exportCsv, exportXlsx } from "../../lib/exportTable";
import type { CashAccount, Expense, PaymentMethodDef } from "../../types/domain";

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
  const { orders } = useAllOrders();
  const { payments, loading: paymentsLoading } = useAllPayments();
  const { expenses, loading: expensesLoading } = useExpenses();
  const { message, visible, showToast } = useToast();

  const [methods, setMethods] = useState<PaymentMethodDef[]>([]);
  useEffect(() => {
    getDocs(collection(db, "paymentMethods"))
      .then((snap) => setMethods(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<PaymentMethodDef, "id">) }))))
      .catch(() => setMethods([]));
  }, []);

  const months = useMemo(() => {
    // The picker always offers this month, even before the first order or expense lands in it.
    const set = new Set(availableMonths(orders));
    for (const e of expenses) set.add(e.date.slice(0, 7));
    set.add(dayKey(new Date()).slice(0, 7));
    return [...set].sort().reverse();
  }, [orders, expenses]);

  /** "" means all time — the picker's first option, so a new shop sees something on day one. */
  const [period, setPeriod] = useState<string>(() => dayKey(new Date()).slice(0, 7));
  const effectivePeriod = period === "" ? null : period;

  const cashbox = useMemo(
    () => computeCashbox({ payments, expenses, methods, period: effectivePeriod }),
    [payments, expenses, methods, effectivePeriod],
  );
  const rows = useMemo(() => expensesInPeriod(expenses, effectivePeriod), [expenses, effectivePeriod]);
  const groups = useMemo(() => groupExpensesByName(rows), [rows]);

  const loading = paymentsLoading || expensesLoading;

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

  const exportRows = () =>
    rows.map((e) => ({
      Күні: e.date,
      Атауы: e.name,
      Қайдан: CASH_ACCOUNT_LABELS[accountForExpense(e)],
      Сомасы: e.amountTiyn / 100,
      Түсініктеме: e.comment ?? "",
      "Кім жазды": e.createdByName,
    }));

  return (
    <AppShell
      title="Касса"
      subtitle={`${effectivePeriod ? monthLabel(effectivePeriod) : "Барлық уақыт"} — түсім және шығын`}
      back="/manager"
    >
      <div className="cashbox-toolbar">
        <select className="form-input cashbox-period" value={period} onChange={(e) => setPeriod(e.target.value)}
          aria-label="Кезең">
          <option value="">Барлық уақыт</option>
          {months.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
        </select>
        <button className="btn btn-outline btn-sm" onClick={() => exportCsv("касса-шығын", exportRows())}>
          ⭳ CSV
        </button>
        <button className="btn btn-outline btn-sm" onClick={() => exportXlsx("касса-шығын", exportRows())}>
          ⭳ Excel
        </button>
      </div>

      {loading ? (
        <Spinner />
      ) : (
        <>
          <div className="cashbox-accounts">
            {cashbox.accounts.map((acc) => (
              <section key={acc.account} className={`cashbox-card is-${acc.account}`}>
                <header>
                  <h3>{CASH_ACCOUNT_LABELS[acc.account]}</h3>
                  <p>{CASH_ACCOUNT_HINTS[acc.account]}</p>
                </header>
                <div className="cashbox-balance">
                  <span className="cashbox-balance-label">Қалдық</span>
                  <strong className={acc.balanceTiyn < 0 ? "is-negative" : ""}>{formatMoney(acc.balanceTiyn)}</strong>
                </div>
                <dl className="cashbox-flow">
                  <div>
                    <dt>Түсті</dt>
                    <dd className="is-in">{formatMoney(acc.inTiyn)}</dd>
                  </div>
                  <div>
                    <dt>Шықты</dt>
                    <dd className="is-out">
                      {formatMoney(acc.outTiyn)}
                      {acc.expenseCount > 0 && <span className="cashbox-count"> · {acc.expenseCount} жазба</span>}
                    </dd>
                  </div>
                </dl>
                {acc.byMethod.length > 0 && (
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

          <div className="cashbox-total">
            <span>Барлығы түсті <strong className="is-in">{formatMoney(cashbox.totalInTiyn)}</strong></span>
            <span>Шықты <strong className="is-out">{formatMoney(cashbox.totalOutTiyn)}</strong></span>
            <span>Қолда <strong>{formatMoney(cashbox.totalBalanceTiyn)}</strong></span>
          </div>

          <ExpenseForm
            defaultDate={effectivePeriod ? `${effectivePeriod}-01` : dayKey(new Date())}
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
                          {(isAdmin || e.createdByUid === user?.uid) && (
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

          {isAdmin && <MethodAccounts methods={methods} setMethods={setMethods} onError={showToast} />}
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
  onSaved,
  onError,
}: {
  defaultDate: string;
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

  // Following the period picker: choosing an older month should offer that month's dates, not
  // today's, or every backdated entry has to be corrected by hand.
  useEffect(() => setDate(defaultDate), [defaultDate]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!user || !userData) return;
    const amountTiyn = Math.round(amountTenge * 100);
    if (!name.trim() || amountTiyn <= 0) {
      onError("Атауы мен соманы толтырыңыз");
      return;
    }
    setSaving(true);
    try {
      await addExpense(db, { user, userData }, {
        name: name.trim(),
        amountTiyn,
        date,
        account,
        comment: comment.trim(),
      });
      onSaved(name.trim(), amountTiyn);
      setName("");
      setAmountTenge(0);
      setComment("");
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
  onError,
}: {
  methods: PaymentMethodDef[];
  setMethods: (next: PaymentMethodDef[]) => void;
  onError: (message: string) => void;
}) {
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
        {methods.map((m) => (
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
