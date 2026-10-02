import { useEffect, useMemo, useState, type FormEvent } from "react";
import { collection, getDocs } from "firebase/firestore";
import { db } from "../../firebase";
import { useAuth } from "../../AuthContext";
import { Spinner, Toast } from "../../components";
import { AppShell } from "../../components/layout/AppShell";
import { NumberField } from "../../components/NumberField";
import { useToast } from "../../hooks";
import { useAppSettings } from "../../hooks/useAppSettings";
import { useRentPayments } from "../../hooks/useRentPayments";
import { addRentPayment, deleteRentPayment } from "../../lib/rent";
import { accountForMethod, CASH_ACCOUNTS, CASH_ACCOUNT_LABELS } from "../../lib/cashbox";
import { formatMoney } from "../../lib/money";
import { dayKey, formatDateDMY, monthLabel } from "../../lib/dates";
import { departmentOf, methodVisibleTo } from "../../lib/rbac";
import type { CashAccount, Department, PaymentMethodDef, RentPayment } from "../../types/domain";

const dmy = (day: string) => formatDateDMY(new Date(`${day}T12:00:00+05:00`));

/**
 * "Аренда" — rent the owner takes on the side, written down so Касса can count it.
 *
 * The money lands in the same accounts the shop's does — Нұр, Pay, the cash — and left out, the
 * Нұр balance on Касса never matched the bank. Each entry goes into the pot its method lands in, as
 * its own "+ Аренда" line beside the orders' "+ Түсті" (lib/cashbox.ts computeCashbox), dated by
 * its own day like an expense, so the accounting restart leaves out what came before it.
 * The Manager records rent here too (the owner, 02.10). They may delete only their own entry — a
 * typo of their own, as with an expense on Касса; anyone else's stays the owner's to correct
 * (App.tsx, firestore.rules).
 */
export default function AdminRent() {
  const { user, userData } = useAuth();
  const isAdmin = userData?.role === "admin";
  const canDelete = (r: RentPayment) => isAdmin || r.createdByUid === user?.uid;
  const department = userData ? departmentOf(userData) : "ldsp";
  const { rentPayments, loading, error } = useRentPayments();
  const { settings, loading: settingsLoading } = useAppSettings();
  const { message, visible, showToast } = useToast();

  const [methods, setMethods] = useState<PaymentMethodDef[]>([]);
  useEffect(() => {
    getDocs(collection(db, "paymentMethods"))
      .then((snap) => setMethods(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<PaymentMethodDef, "id">) }))))
      .catch(() => setMethods([]));
  }, []);
  const methodById = useMemo(() => new Map(methods.map((m) => [m.id, m])), [methods]);
  const accountOf = (r: RentPayment): CashAccount => accountForMethod(methodById.get(r.methodId) ?? { id: r.methodId });

  const rows = useMemo(
    () => rentPayments.filter((r) => (r.department ?? "ldsp") === department),
    [rentPayments, department],
  );
  const startDate = settings.cashStartDate ?? null;
  const thisMonth = dayKey(new Date()).slice(0, 7);
  const monthTotal = rows.filter((r) => r.date.startsWith(thisMonth)).reduce((s, r) => s + r.amountTiyn, 0);
  // What Касса counts: the same rows computeCashbox takes, split by the pot each landed in.
  const counted = rows.filter((r) => !startDate || r.date >= startDate);
  const countedByAccount = CASH_ACCOUNTS
    .map((account) => ({
      account,
      amountTiyn: counted.filter((r) => accountOf(r) === account).reduce((s, r) => s + r.amountTiyn, 0),
    }))
    .filter((a) => a.amountTiyn > 0);

  // Two taps, as on Касса: the first arms the button, the second deletes.
  const [armed, setArmed] = useState<string | null>(null);
  const handleDelete = async (r: RentPayment) => {
    if (!user || !userData) return;
    if (armed !== r.id) {
      setArmed(r.id);
      return;
    }
    setArmed(null);
    try {
      await deleteRentPayment(db, { user, userData }, r);
      showToast("✅ Жазба өшірілді");
    } catch (err: unknown) {
      showToast("Қате: " + (err as Error).message);
    }
  };

  return (
    <AppShell title="Аренда" subtitle="Жалға беруден түскен ақша — Кассаға қосылады">
      {error && (
        <p className="cashbox-warn rent-error">
          ⚠️ Аренда жазбалары оқылмады ({error}). firestore.rules әлі жаңартылмаған болуы мүмкін.
        </p>
      )}

      {loading || settingsLoading ? (
        <Spinner />
      ) : (
        <>
          <div className="kpi-row">
            <div className="kpi-card">
              <div className="kpi-text">
                <div className="kpi-label">{monthLabel(thisMonth)}</div>
                <div className="kpi-value">{formatMoney(monthTotal)}</div>
              </div>
              <span className="kpi-icon is-green">🏠</span>
            </div>
            <div className="kpi-card">
              <div className="kpi-text">
                <div className="kpi-label">Кассада{startDate ? ` (${dmy(startDate)} бастап)` : ""}</div>
                <div className="kpi-value">{formatMoney(counted.reduce((s, r) => s + r.amountTiyn, 0))}</div>
                {countedByAccount.length > 0 && (
                  <div className="kpi-sub">
                    {countedByAccount.map((a) => `${CASH_ACCOUNT_LABELS[a.account]} ${formatMoney(a.amountTiyn)}`).join(" · ")}
                  </div>
                )}
              </div>
              <span className="kpi-icon is-indigo">💰</span>
            </div>
          </div>

          <RentForm
            methods={methods.filter((m) => m.active !== false && !m.isMixed && methodVisibleTo(m, department))}
            department={department}
            startDate={startDate}
            onSaved={(name, amountTiyn) => showToast(`✅ ${name} — ${formatMoney(amountTiyn)} жазылды`)}
            onError={showToast}
          />

          <section className="panel-card">
            <div className="panel-head">
              <h3>Аренда төлемдері</h3>
              <span className="wh-sub">{rows.length} жазба</span>
            </div>
            {rows.length === 0 ? (
              <div className="empty-state">
                <div className="icon">🏠</div>
                <p>Әзірге аренда жазылмаған</p>
                <span>Жоғарыдағы жолға кімнен, қанша, қай шотқа түскенін жазыңыз.</span>
              </div>
            ) : (
              <div className="data-table-wrap">
                <table className="data-table stack-mobile stack-compact">
                  <thead>
                    <tr>
                      <th>Күні</th>
                      <th>Кімнен</th>
                      <th>Төлем түрі</th>
                      <th className="num">Сомасы</th>
                      <th>Кім жазды</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.id}>
                        <td data-label="Күні" className="wh-sub">{dmy(r.date)}</td>
                        <td data-label="Кімнен">
                          <strong>{r.payerName}</strong>
                          {r.comment && <div className="wh-sub">{r.comment}</div>}
                          {startDate && r.date < startDate && <div className="wh-sub">Есеп басталғанға дейін — Кассаға кірмейді</div>}
                        </td>
                        <td data-label="Төлем түрі">
                          <span className={`cashbox-tag is-${accountOf(r)}`}>{r.methodName}</span>
                        </td>
                        <td className="num" data-label="Сомасы"><strong>{formatMoney(r.amountTiyn)}</strong></td>
                        <td data-label="Кім жазды" className="wh-sub">{r.createdByName}</td>
                        <td className="num">
                          {canDelete(r) && (
                            <button type="button" className={armed === r.id ? "btn btn-outline btn-sm is-armed" : "jt-icon-btn"}
                              title="Өшіру" aria-label={`${r.payerName} — ${formatMoney(r.amountTiyn)} жазбасын өшіру`}
                              onClick={() => handleDelete(r)}>
                              {armed === r.id ? "Өшіру?" : "✕"}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}

      <Toast message={message} visible={visible} />
    </AppShell>
  );
}

/**
 * One row, as the expense form on Касса is: кімнен, қанша, қай шотқа, қай күні. The method is
 * picked from the shop's own list (Нұр, Pay, Нал…) because that is what decides the pot.
 */
function RentForm({
  methods,
  department,
  startDate,
  onSaved,
  onError,
}: {
  /** Already narrowed to this line's single-method options — "Аралас" splits an order, not rent. */
  methods: PaymentMethodDef[];
  department: Department;
  /** The accounting restart — an entry dated before it is saved but never counted on Касса. */
  startDate: string | null;
  onSaved: (name: string, amountTiyn: number) => void;
  onError: (message: string) => void;
}) {
  const { user, userData } = useAuth();
  const [payerName, setPayerName] = useState("");
  const [amountTenge, setAmountTenge] = useState(0);
  const [methodId, setMethodId] = useState("");
  const [date, setDate] = useState(() => dayKey(new Date()));
  const [comment, setComment] = useState("");
  const [saving, setSaving] = useState(false);

  // Нұр by default — the account the owner said this money goes to — until another is picked.
  const method = methods.find((m) => m.id === methodId)
    ?? methods.find((m) => accountForMethod(m) === "deposit")
    ?? methods[0];
  const beforeStart = !!startDate && date < startDate;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!user || !userData) return;
    const amountTiyn = Math.round(amountTenge * 100);
    if (!payerName.trim() || amountTiyn <= 0 || !method) {
      onError("Кімнен екенін, сомасын және төлем түрін толтырыңыз");
      return;
    }
    setSaving(true);
    try {
      await addRentPayment(db, { user, userData }, {
        payerName: payerName.trim(),
        amountTiyn,
        methodId: method.id,
        methodName: method.name,
        date,
        comment: comment.trim(),
        department,
      });
      onSaved(payerName.trim(), amountTiyn);
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
        <h3>Аренда жазу</h3>
      </div>
      <form className="cashbox-form" onSubmit={submit}>
        <label className="cashbox-field is-wide">
          <span>Кімнен</span>
          <input className="form-input" placeholder="Жалға алушы" value={payerName}
            onChange={(e) => setPayerName(e.target.value)} />
        </label>
        <label className="cashbox-field">
          <span>Сомасы (₸)</span>
          <NumberField value={amountTenge} min={0} onChange={setAmountTenge} ariaLabel="Аренда сомасы" />
        </label>
        <label className="cashbox-field">
          <span>Төлем түрі</span>
          <select className="form-input" value={method?.id ?? ""} onChange={(e) => setMethodId(e.target.value)}>
            {methods.map((m) => (
              <option key={m.id} value={m.id}>{m.name} — {CASH_ACCOUNT_LABELS[accountForMethod(m)]}</option>
            ))}
          </select>
        </label>
        <label className="cashbox-field">
          <span>Күні</span>
          <input type="date" className="form-input" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className="cashbox-field is-wide">
          <span>Түсініктеме (міндетті емес)</span>
          <input className="form-input" placeholder="Қай ай үшін, не үшін" value={comment}
            onChange={(e) => setComment(e.target.value)} />
        </label>
        {/* Said before the button: an entry dated before the restart is written and then left out
            of every Касса figure, which otherwise looks exactly like the save doing nothing. */}
        {beforeStart && (
          <p className="cashbox-warn is-wide">
            ⚠️ Бұл күн есеп басталатын күннен ({dmy(startDate!)}) бұрын — жазба сақталады, бірақ
            Кассаға кірмейді.
          </p>
        )}
        <button type="submit" className="btn btn-primary cashbox-submit" disabled={saving}>
          {saving ? "Сақталуда…" : "🏠 Аренданы жазу"}
        </button>
      </form>
    </section>
  );
}
