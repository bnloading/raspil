import { useMemo, useState } from "react";
import { useAuth } from "../AuthContext";
import { Spinner } from "../components";
import { AppShell } from "../components/layout/AppShell";
import { useSalaryEntries, useSalaryAdjustments } from "../hooks/useSalary";
import { formatMoney } from "../lib/money";
import { useAdvances } from "../hooks/useAdvances";
import { summariseAdvances } from "../lib/advances";
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
  const { advances } = useAdvances(user?.uid);
  const advanceInfo = summariseAdvances({
    advances,
    userId: user?.uid ?? "",
    periodKey: period,
    earnedTiyn: entry?.finalTiyn ?? 0,
  });
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

      {/* Advances are shown whether or not the month has been calculated yet: they are handed over
          mid-month, so a worker asking "how much have I already taken?" must get an answer before
          payday, not only after the Admin runs the calculation. */}
        {advanceInfo.entries.length > 0 && (
          <section className="panel-card">
            <div className="panel-head">
              <h3>Алынған аванс</h3>
              <strong>{formatMoney(advanceInfo.totalTiyn)}</strong>
            </div>
            <div className="data-list">
              {advanceInfo.entries.map((a) => (
                <div key={a.id} className="data-row">
                  <div className="data-row-main">
                    <strong>{formatMoney(a.amountTiyn)}</strong>
                    <span>
                      {a.paidAt ? formatDateTimeDMY(a.paidAt) : ""}
                      {a.note ? ` · ${a.note}` : ""}
                    </span>
                  </div>
                  <span className="jt-muted">{a.recordedByName}</span>
                </div>
              ))}
            </div>
          </section>
        )}

      {!entry ? (
        <div className="empty-state">
          <div className="icon">🧾</div>
          <p>
            {monthLabel(period)} айына айлық әлі есептелмеген.
            {advanceInfo.totalTiyn > 0 && (
              <>
                <br />
                Бұл айда {formatMoney(advanceInfo.totalTiyn)} аванс алдыңыз.
              </>
            )}
            <br />
            Есептелген соң осы жерде көрінеді.
          </p>
        </div>
      ) : (
        <>
          <div className="panel-card salary-hero">
            {/* The headline is what is still coming, because that is the question a worker who has
                already drawn an advance is actually asking. The earned figure stays visible below
                it — an advance reduces what is owed, never what was earned. */}
            <span className="worker-field-label">
              {advanceInfo.totalTiyn > 0 ? "Қолға тиетін сома" : "Айлық сомасы"}
            </span>
            <div className="salary-total">{formatMoney(advanceInfo.remainingTiyn)}</div>
            {advanceInfo.totalTiyn > 0 && (
              <div className="worker-field-label">
                Айлық {formatMoney(entry.finalTiyn)} − аванс {formatMoney(advanceInfo.totalTiyn)}
              </div>
            )}
            {advanceInfo.overdrawn && (
              <div className="salary-overdrawn">
                Алынған аванс айлықтан асып тұр — менеджерге хабарласыңыз
              </div>
            )}
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
              <div className="confirm-row"><span>Қорытынды айлық</span><strong>{formatMoney(entry.finalTiyn)}</strong></div>
              {advanceInfo.totalTiyn > 0 && (
                <div className="confirm-row"><span>Алынған аванс</span><strong>−{formatMoney(advanceInfo.totalTiyn)}</strong></div>
              )}
              <div className="confirm-row confirm-total"><span>Қолға тиеді</span><strong>{formatMoney(advanceInfo.remainingTiyn)}</strong></div>
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
