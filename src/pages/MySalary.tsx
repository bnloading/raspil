import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../AuthContext";
import { Spinner } from "../components";
import { AppShell } from "../components/layout/AppShell";
import { useSalaryEntries, useSalaryAdjustments, useSalaryRule, useAttendance } from "../hooks/useSalary";
import { useCutterOrders, usePvcOrders, useMdfOrders } from "../hooks/useOrders";
import { useMaterials } from "../hooks/useMaterials";
import { useAdvances } from "../hooks/useAdvances";
import { summariseAdvances } from "../lib/advances";
import { measureWork, computeSalaryBase } from "../lib/salary";
import { currentPeriodKey, periodLabel, salaryPeriodKind, shiftPeriod } from "../lib/salaryPeriod";
import { formatDateDMY, formatDateTimeDMY } from "../lib/dates";
import { formatMoney } from "../lib/money";
import { SALARY_STATUS_LABELS, type SalaryStatus } from "../types/domain";

const STATUS_TONE: Record<SalaryStatus, string> = {
  calculating: "muted",
  calculated: "blue",
  confirmed: "amber",
  paid: "green",
};

/**
 * "Менің айлығым" — every worker's own payslip, in the same shape regardless of how their rule
 * actually computes it (per-sheet, per-m², fixed, …). Before an Admin has run "Қайта есептеу" for
 * the current month, the headline figure is a live estimate from the worker's own rule and their
 * own completed work (the same idea WorkerSalaryTeaser used) — so this page is never just empty
 * for most of the month. The queries are scoped to the caller's own uid, and firestore.rules
 * refuses any salary document belonging to somebody else.
 */
export default function MySalary() {
  const { user, userData } = useAuth();
  const role = userData?.role;
  // The dark, card-based look is for the shop floor's own page — Admin/Manager can open this
  // same page for themselves, but they live in the light theme everywhere else, so it would be a
  // jarring one-page swap rather than a look their workflow already speaks.
  const isWorkerRole = role === "raspil" || role === "pvh" || role === "cnc" || role === "sanding" || role === "painting" || role === "vacuum";
  const { entries, loading } = useSalaryEntries(user?.uid);
  const { adjustments } = useSalaryAdjustments(user?.uid);
  const { advances } = useAdvances(user?.uid);
  const { records: attendance } = useAttendance(user?.uid);
  const { rule } = useSalaryRule(user?.uid);
  const { materials } = useMaterials(false);

  // Every role's own order feed, called unconditionally (Rules of Hooks) — only the one matching
  // this worker's role is ever actually populated with anything relevant.
  const { orders: cutterOrders } = useCutterOrders(role === "raspil" ? user?.uid : undefined);
  const { orders: pvcOrders } = usePvcOrders(role === "pvh" ? user?.uid : undefined);
  const { orders: mdfOrders } = useMdfOrders();
  const orders = useMemo(() => {
    if (role === "raspil") return cutterOrders;
    if (role === "pvh") return pvcOrders;
    if (role === "cnc" || role === "sanding" || role === "painting" || role === "vacuum") return mdfOrders;
    return [];
  }, [role, cutterOrders, pvcOrders, mdfOrders]);

  // A распилшик is paid weekly and everyone else monthly, so the navigator below steps whichever
  // one this worker is actually settled on (see lib/salaryPeriod.ts).
  const periodKind = salaryPeriodKind(role);
  const [period, setPeriod] = useState<string>(() => currentPeriodKey(periodKind));
  // `role` arrives a beat after the first render, so the period has to follow it once: without
  // this a раздспилшік would open on a month key and see his week's pay read as a whole month's.
  useEffect(() => setPeriod(currentPeriodKey(periodKind)), [periodKind]);
  // Off by default on every visit — money is only ever plain-visible after a deliberate tap, not
  // whoever happens to glance at the phone screen next to a worker in the workshop.
  const [revealed, setRevealed] = useState(false);

  const entry = entries.find((e) => e.periodKey === period);
  const categoryByMaterialId = useMemo(
    () => new Map(materials.map((m) => [m.id, m.category ?? "ldsp"] as const)),
    [materials],
  );
  // Confirmed figure if there is one; otherwise a live estimate from the worker's own rule — the
  // same fallback WorkerSalaryTeaser uses, so a month with no formula (MANUAL) or nothing cut yet
  // just reads as zero rather than a dead end.
  const work = useMemo(
    () => measureWork(orders, attendance, user?.uid ?? "", period, categoryByMaterialId),
    [orders, attendance, user?.uid, period, categoryByMaterialId],
  );
  const live = computeSalaryBase(rule, work, periodKind);
  const liveFinalTiyn = Math.max(0, live.baseTiyn - live.deductionTiyn);
  const finalTiyn = entry?.finalTiyn ?? liveFinalTiyn;
  const isEstimate = !entry;

  const advanceInfo = summariseAdvances({
    advances,
    userId: user?.uid ?? "",
    periodKey: period,
    earnedTiyn: finalTiyn,
  });
  const periodAdjustments = adjustments.filter((a) => a.periodKey === period);

  const pastEntries = useMemo(
    () => [...entries].filter((e) => e.periodKey !== period).sort((a, b) => b.periodKey.localeCompare(a.periodKey)).slice(0, 6),
    [entries, period],
  );

  const paymentHistory = useMemo(() => {
    const rows = advanceInfo.entries.map((a) => ({
      key: `adv-${a.id}`,
      dateSeconds: a.paidAt?.seconds ?? 0,
      label: "Аванс" + (a.note ? ` · ${a.note}` : ""),
      amountTiyn: a.amountTiyn,
      date: a.paidAt,
    }));
    if (entry?.status === "paid" && entry.paidAt) {
      rows.push({
        key: "final",
        dateSeconds: entry.paidAt.seconds,
        label: "Айлық есеп айырысу",
        amountTiyn: advanceInfo.remainingTiyn,
        date: entry.paidAt,
      });
    }
    return rows.sort((a, b) => b.dateSeconds - a.dateSeconds);
  }, [advanceInfo, entry]);

  const hasAnythingToShow = advanceInfo.entries.length > 0 || !!entry || finalTiyn > 0;
  const canGoNext = period < currentPeriodKey(periodKind);
  const backLabel = periodKind === "week" ? "Алдыңғы апта" : "Алдыңғы ай";
  const nextLabel = periodKind === "week" ? "Келесі апта" : "Келесі ай";

  if (!user || !userData) return <Spinner />;
  if (loading) return <Spinner />;

  return (
    <AppShell title="Менің айлығым" subtitle={userData.name} variant={isWorkerRole ? "station" : "default"}>
      <div className="salary-month-nav">
        <button type="button" className="salary-month-arrow" onClick={() => setPeriod(shiftPeriod(period, -1))} aria-label={backLabel}>‹</button>
        <button type="button" className="salary-month-label" onClick={() => setPeriod(currentPeriodKey(periodKind))}>
          {periodLabel(period)} <span aria-hidden="true">📅</span>
        </button>
        <button type="button" className="salary-month-arrow" disabled={!canGoNext} onClick={() => setPeriod(shiftPeriod(period, 1))} aria-label={nextLabel}>›</button>
      </div>
      <p className="salary-asof">{formatDateDMY(new Date())} күнгі есеп</p>

      {!revealed && hasAnythingToShow ? (
        <div className="panel-card empty-state">
          <div className="icon">🔒</div>
          <p>Айлық сомасы жасырылған</p>
          <button type="button" className="btn btn-primary" style={{ marginTop: 12 }} onClick={() => setRevealed(true)}>
            👁 Айлықты көрсету
          </button>
        </div>
      ) : (
        <>
          <section className="panel-card salary-hero">
            <span className="worker-field-label">
              Есептелген айлық{isEstimate && <span className="worker-salary-est"> · болжам</span>}
            </span>
            <div className="salary-total">{formatMoney(finalTiyn)}</div>
            {entry && (
              <span className={`jt-pill jt-tone-${STATUS_TONE[entry.status]}`}>{SALARY_STATUS_LABELS[entry.status]}</span>
            )}

            <div className="rdash-subfigures salary-subfigures">
              <div className="is-green"><span>Алынғаны</span><strong>{formatMoney(advanceInfo.totalTiyn)}</strong></div>
              <div className="is-blue"><span>Алуға қалды</span><strong>{formatMoney(advanceInfo.remainingTiyn)}</strong></div>
            </div>
            {advanceInfo.overdrawn && (
              <div className="salary-overdrawn">Алынған аванс айлықтан асып тұр — менеджерге хабарласыңыз</div>
            )}
          </section>

          <div className="rdash-tiles salary-work-tiles">
            <div className="rdash-tile"><b>{entry?.presentDays ?? work.presentDays}</b><span>Жұмыс күні</span></div>
            <div className="rdash-tile is-blue"><b>{entry?.sheetsCut ?? work.sheetsCut}</b><span>Кесілген лист</span></div>
            <div className="rdash-tile is-green"><b>{entry?.ordersCompleted ?? work.ordersCompleted}</b><span>Заказдар</span></div>
          </div>

          {paymentHistory.length > 0 && (
            <section className="panel-card">
              <div className="panel-head"><h3>Төлем тарихы</h3></div>
              <div className="data-list">
                {paymentHistory.map((p) => (
                  <div key={p.key} className="data-row">
                    <div className="data-row-main">
                      <strong>{formatMoney(p.amountTiyn)}</strong>
                      <span>{p.date ? formatDateTimeDMY(p.date) : ""} · {p.label}</span>
                    </div>
                    <span className="jt-pill jt-tone-green">Төленді</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {periodAdjustments.length > 0 && (
            <section className="panel-card">
              <div className="panel-head"><h3>Түзетулер</h3></div>
              <div className="data-list">
                {periodAdjustments.map((a) => (
                  <div key={a.id} className="data-row">
                    <div className="data-row-main">
                      <strong>{a.amountTiyn > 0 ? "+" : "−"}{formatMoney(Math.abs(a.amountTiyn))}</strong>
                      <span>{a.reason}{a.createdAt ? ` · ${formatDateDMY(a.createdAt)}` : ""}</span>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {pastEntries.length > 0 && (
            <section className="panel-card">
              <div className="panel-head"><h3>Өткен айлар</h3></div>
              <div className="data-list">
                {pastEntries.map((e) => (
                  <button key={e.id} type="button" className="data-row salary-past-row" onClick={() => setPeriod(e.periodKey)}>
                    <div className="data-row-main">
                      <strong>{periodLabel(e.periodKey)}</strong>
                      <span>{formatMoney(e.finalTiyn)}</span>
                    </div>
                    <span className={`jt-pill jt-tone-${STATUS_TONE[e.status]}`}>{SALARY_STATUS_LABELS[e.status]}</span>
                  </button>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </AppShell>
  );
}
