import { useMemo, useState } from "react";
import { useAuth } from "../AuthContext";
import { Spinner } from "../components";
import { AppShell } from "../components/layout/AppShell";
import { useSalaryEntries, useSalaryAdjustments } from "../hooks/useSalary";
import { formatMoney } from "../lib/money";
import { formatDateTimeDMY, monthKey, monthLabel } from "../lib/dates";
import { SALARY_MODE_LABELS, SALARY_STATUS_LABELS } from "../types/domain";

const STATUS_TONE: Record<string, string> = {
  calculating: "muted",
  calculated: "blue",
  confirmed: "amber",
  paid: "green",
};

/**
 * "Менің айлығым" — a worker's own payslip, and only their own: the queries are scoped to their
 * uid and firestore.rules refuses any salary document belonging to somebody else.
 */
export default function MySalary() {
  const { user, userData } = useAuth();
  const { entries, loading } = useSalaryEntries(user?.uid);
  const { adjustments } = useSalaryAdjustments(user?.uid);
  const [period, setPeriod] = useState<string>(monthKey(new Date()));

  const periods = useMemo(() => {
    const keys = new Set<string>([monthKey(new Date()), ...entries.map((e) => e.periodKey)]);
    return [...keys].sort().reverse();
  }, [entries]);

  const entry = entries.find((e) => e.periodKey === period);
  const periodAdjustments = adjustments.filter((a) => a.periodKey === period);

  if (!user || !userData) return <Spinner />;
  if (loading) return <Spinner />;

  return (
    <AppShell title="Менің айлығым" subtitle={userData.name}>
      <div className="form-group" style={{ maxWidth: 260 }}>
        <label>Айы</label>
        <select className="form-input" value={period} onChange={(e) => setPeriod(e.target.value)}>
          {periods.map((p) => (
            <option key={p} value={p}>
              {monthLabel(p)}
            </option>
          ))}
        </select>
      </div>

      {!entry ? (
        <div className="empty-state">
          <div className="icon">🧾</div>
          <p>
            {monthLabel(period)} айына айлық әлі есептелмеген.
            <br />
            Есептелген соң осы жерде көрінеді.
          </p>
        </div>
      ) : (
        <>
          <div className="panel-card salary-hero">
            <span className="worker-field-label">Айлық сомасы</span>
            <div className="salary-total">{formatMoney(entry.finalTiyn)}</div>
            <span className={`jt-pill jt-tone-${STATUS_TONE[entry.status] ?? "muted"}`}>
              {SALARY_STATUS_LABELS[entry.status]}
            </span>
            {entry.paidAt && (
              <div className="worker-field-label" style={{ marginTop: 8 }}>
                Төленген күні: {formatDateTimeDMY(entry.paidAt)}
              </div>
            )}
          </div>

          <section className="panel-card">
            <div className="panel-head">
              <h3>Есептеу тәртібі</h3>
              <span className="jt-pill jt-tone-muted">{SALARY_MODE_LABELS[entry.mode]}</span>
            </div>
            <div className="confirm-summary">
              <div className="confirm-row"><span>Негізгі сома</span><strong>{formatMoney(entry.baseTiyn)}</strong></div>
              {entry.bonusTiyn > 0 && (
                <div className="confirm-row"><span>Бонус</span><strong>+{formatMoney(entry.bonusTiyn)}</strong></div>
              )}
              {entry.adjustmentTiyn !== 0 && (
                <div className="confirm-row">
                  <span>Түзетулер</span>
                  <strong>{entry.adjustmentTiyn > 0 ? "+" : "−"}{formatMoney(Math.abs(entry.adjustmentTiyn))}</strong>
                </div>
              )}
              {entry.deductionTiyn > 0 && (
                <div className="confirm-row"><span>Ұстамалар</span><strong>−{formatMoney(entry.deductionTiyn)}</strong></div>
              )}
              <div className="confirm-row confirm-total"><span>Қорытынды</span><strong>{formatMoney(entry.finalTiyn)}</strong></div>
            </div>
          </section>

          <section className="panel-card">
            <div className="panel-head">
              <h3>Орындалған жұмыс</h3>
            </div>
            <div className="confirm-summary">
              <div className="confirm-row"><span>Кесілген лист</span><strong>{entry.sheetsCut}</strong></div>
              {/* Only shown when the shop actually cut more than one category this month —
                  otherwise it is noise on a payslip that is entirely ЛДСП. */}
              {(entry.hdfSheets || entry.countertopSheets) ? (
                <>
                  <div className="confirm-row"><span>— ЛДСП</span><strong>{entry.ldspSheets ?? 0}</strong></div>
                  <div className="confirm-row"><span>— ХДФ</span><strong>{entry.hdfSheets ?? 0}</strong></div>
                  <div className="confirm-row"><span>— Столешница</span><strong>{entry.countertopSheets ?? 0}</strong></div>
                </>
              ) : null}
              <div className="confirm-row"><span>ПВХ метрі</span><strong>{entry.pvcMeters.toFixed(2)} м</strong></div>
              <div className="confirm-row"><span>Аяқталған заказ</span><strong>{entry.ordersCompleted}</strong></div>
              <div className="confirm-row"><span>Жұмыс күні</span><strong>{entry.presentDays}</strong></div>
              <div className="confirm-row"><span>Келмеген күн</span><strong>{entry.absentDays}</strong></div>
              <div className="confirm-row"><span>Жұмыс сағаты</span><strong>{entry.workedHours.toFixed(1)} сағ</strong></div>
            </div>
          </section>

          {periodAdjustments.length > 0 && (
            <section className="panel-card">
              <div className="panel-head">
                <h3>Түзетулер</h3>
              </div>
              <div className="data-list">
                {periodAdjustments.map((a) => (
                  <div key={a.id} className="data-row">
                    <div className="data-row-main">
                      <strong>
                        {a.amountTiyn > 0 ? "+" : "−"}
                        {formatMoney(Math.abs(a.amountTiyn))}
                      </strong>
                      <span>{a.reason}</span>
                      <span>
                        {a.createdByName}
                        {a.createdAt ? ` · ${formatDateTimeDMY(a.createdAt)}` : ""}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </AppShell>
  );
}
