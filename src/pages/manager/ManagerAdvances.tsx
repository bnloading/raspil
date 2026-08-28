import { useMemo, useState, type FormEvent } from "react";
import { db } from "../../firebase";
import { useAuth } from "../../AuthContext";
import { Spinner, Toast } from "../../components";
import { AppShell } from "../../components/layout/AppShell";
import { NumberField } from "../../components/NumberField";
import { useToast } from "../../hooks";
import { useStaff } from "../../hooks/useStaff";
import { useAdvances } from "../../hooks/useAdvances";
import { recordAdvance, reverseAdvance } from "../../lib/advancesWrite";
import { advancesFor, currentPeriodKey, totalAdvancesTiyn } from "../../lib/advances";
import { formatMoney } from "../../lib/money";
import { formatDateDMY } from "../../lib/dates";
import { ROLE_LABELS } from "../../lib/rbac";

const MONTHS_KK = [
  "Қаңтар", "Ақпан", "Наурыз", "Сәуір", "Мамыр", "Маусым",
  "Шілде", "Тамыз", "Қыркүйек", "Қазан", "Қараша", "Желтоқсан",
];
const monthName = (key: string) => {
  const [y, m] = key.split("-");
  return `${MONTHS_KK[Number(m) - 1] ?? m} ${y}`;
};

/**
 * "Аванс" — money handed to a worker before payday.
 *
 * The Manager records it here because that is who is at the counter when the cash changes hands;
 * the worker sees the same figures on their own Айлығым page. Reversing a mistake is Admin-only
 * (firestore.rules), so a Manager who mis-types has to ask — which is the right friction for a
 * money record.
 */
export default function ManagerAdvances() {
  const { user, userData } = useAuth();
  const { staff, loading: staffLoading } = useStaff();
  const { advances, loading } = useAdvances();
  const { message, visible, showToast } = useToast();

  const period = currentPeriodKey();
  const [userId, setUserId] = useState("");
  const [amountTenge, setAmountTenge] = useState(0);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  /** Only people who draw a salary — a customer never takes an advance. */
  const payable = useMemo(() => staff.filter((s) => s.role !== "customer" && !s.blocked), [staff]);

  const thisMonth = useMemo(
    () => advances.filter((a) => a.periodKey === period && !a.reversed),
    [advances, period],
  );
  const totalThisMonth = totalAdvancesTiyn(thisMonth);

  const perWorker = useMemo(
    () =>
      payable
        .map((w) => ({ worker: w, taken: totalAdvancesTiyn(advancesFor(advances, w.id, period)) }))
        .sort((a, b) => b.taken - a.taken),
    [payable, advances, period],
  );

  const history = useMemo(
    () => [...advances].sort((a, b) => (b.paidAt?.seconds ?? 0) - (a.paidAt?.seconds ?? 0)).slice(0, 30),
    [advances],
  );

  if (!user || !userData) return <Spinner />;
  const actor = { user, userData };
  const isAdmin = userData.role === "admin";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const worker = payable.find((w) => w.id === userId);
    if (!worker) {
      showToast("Қызметкерді таңдаңыз");
      return;
    }
    const amountTiyn = Math.round(amountTenge * 100);
    if (amountTiyn <= 0) {
      showToast("Соманы енгізіңіз");
      return;
    }
    setSaving(true);
    try {
      await recordAdvance(db, actor, {
        userId: worker.id,
        userName: worker.name,
        periodKey: period,
        amountTiyn,
        note,
      });
      showToast(`✅ ${worker.name}: ${formatMoney(amountTiyn)} аванс жазылды`);
      setAmountTenge(0);
      setNote("");
    } catch (err: unknown) {
      showToast("Қате: " + (err as Error).message);
    }
    setSaving(false);
  };

  const undo = async (advanceId: string) => {
    const reason = prompt("Қайтару себебі:");
    if (!reason || !reason.trim()) return;
    try {
      await reverseAdvance(db, actor, { advanceId, reason });
      showToast("✅ Аванс қайтарылды");
    } catch (err: unknown) {
      showToast("Қате: " + (err as Error).message);
    }
  };

  return (
    <AppShell title="Аванс" subtitle={`${monthName(period)} — қызметкерлерге берілген ақша`} back="/manager">
      <div className="kpi-row">
        <div className="kpi-card">
          <div className="kpi-text">
            <div className="kpi-label">Осы айда берілді</div>
            <div className="kpi-value">{formatMoney(totalThisMonth)}</div>
          </div>
          <span className="kpi-icon is-red">💸</span>
        </div>
        <div className="kpi-card">
          <div className="kpi-text">
            <div className="kpi-label">Аванс алғандар</div>
            <div className="kpi-value">{perWorker.filter((p) => p.taken > 0).length}</div>
          </div>
          <span className="kpi-icon is-blue">👤</span>
        </div>
      </div>

      <section className="panel-card">
        <div className="panel-head">
          <h3>Аванс беру</h3>
        </div>
        <form onSubmit={submit}>
          <div className="form-group">
            <label>Қызметкер</label>
            <select className="form-input" value={userId} onChange={(e) => setUserId(e.target.value)} required>
              <option value="">Таңдаңыз…</option>
              {payable.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name} — {ROLE_LABELS[w.role]}
                </option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label>Сома (₸)</label>
            <NumberField value={amountTenge} min={0} onChange={setAmountTenge} ariaLabel="Аванс сомасы" />
          </div>
          <div className="form-group">
            <label>Ескертпе (міндетті емес)</label>
            <input className="form-input" value={note} onChange={(e) => setNote(e.target.value)}
              placeholder="Мысалы: жол ақысына" />
          </div>
          <button type="submit" className="btn btn-primary btn-full" disabled={saving}>
            {saving ? "Сақталуда…" : "💸 Аванс жазу"}
          </button>
        </form>
      </section>

      <section className="panel-card">
        <div className="panel-head">
          <h3>{monthName(period)} бойынша</h3>
        </div>
        {staffLoading || loading ? (
          <Spinner />
        ) : perWorker.length === 0 ? (
          <div className="empty-state">
            <div className="icon">👥</div>
            <p>Қызметкер жоқ</p>
          </div>
        ) : (
          <div className="data-table-wrap">
            <table className="data-table stack-mobile stack-compact">
              <thead>
                <tr>
                  <th>Қызметкер</th>
                  <th>Рөлі</th>
                  <th className="num">Осы айда алды</th>
                </tr>
              </thead>
              <tbody>
                {perWorker.map(({ worker, taken }) => (
                  <tr key={worker.id}>
                    <td data-label="Қызметкер"><strong>{worker.name}</strong></td>
                    <td data-label="Рөлі" className="wh-sub">{ROLE_LABELS[worker.role]}</td>
                    <td className="num" data-label="Осы айда алды">
                      {taken > 0 ? <span className="jt-debt">{formatMoney(taken)}</span> : <span className="jt-muted">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel-card">
        <div className="panel-head">
          <h3>Соңғы жазбалар</h3>
        </div>
        {history.length === 0 ? (
          <div className="empty-state">
            <div className="icon">📭</div>
            <p>Аванс жазылмаған</p>
            <p className="empty-state-hint">Жоғарыдағы формадан алғашқы авансты жазыңыз.</p>
          </div>
        ) : (
          <div className="data-table-wrap">
            <table className="data-table stack-mobile stack-compact">
              <thead>
                <tr>
                  <th>Күні</th>
                  <th>Қызметкер</th>
                  <th className="num">Сома</th>
                  <th>Кім берді</th>
                  {isAdmin && <th>Әрекет</th>}
                </tr>
              </thead>
              <tbody>
                {history.map((a) => (
                  <tr key={a.id} className={a.reversed ? "blocked" : undefined}>
                    <td data-label="Күні">{a.paidAt ? formatDateDMY(a.paidAt) : "—"}</td>
                    <td data-label="Қызметкер">
                      <strong>{a.userName}</strong>
                      {a.note && <div className="wh-sub">{a.note}</div>}
                      {a.reversed && <div className="wh-sub">Қайтарылды: {a.reversalReason}</div>}
                    </td>
                    <td className="num" data-label="Сома">{formatMoney(a.amountTiyn)}</td>
                    <td data-label="Кім берді" className="wh-sub">{a.recordedByName}</td>
                    {isAdmin && (
                      <td data-label="Әрекет">
                        {!a.reversed && (
                          <button className="btn btn-outline btn-sm" onClick={() => undo(a.id)}>
                            Қайтару
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <Toast message={message} visible={visible} />
    </AppShell>
  );
}
