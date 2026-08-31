import { useMemo, useState } from "react";
import { useAuth } from "../AuthContext";
import { Spinner } from "../components";
import { AppShell } from "../components/layout/AppShell";
import { useCutterOrders } from "../hooks/useOrders";
import { buildCutterHistory, type CutHistoryEntry } from "../lib/cutterHistory";
import { dayKey, formatDateDMY, monthKey, monthLabel, weekKey, weekLabel } from "../lib/dates";

/** One week's entries, already split into day-groups sorted newest first. */
interface WeekGroup {
  key: string;
  days: { key: string; entries: CutHistoryEntry[] }[];
}

/**
 * "Тарих" — every order this cutter has actually finished cutting, grouped by week and then by
 * day within it, each level carrying its own totals. Replaces trying to reconstruct "how much did
 * I cut this week" by scrolling the queue, which only ever shows what's still ahead.
 */
export default function CutterHistory() {
  const { user, userData } = useAuth();
  const { orders, loading } = useCutterOrders(user?.uid);

  const allEntries = useMemo(() => (user ? buildCutterHistory(orders, user.uid) : []), [orders, user]);

  const periods = useMemo(() => {
    const keys = new Set([monthKey(new Date()), ...allEntries.map((e) => monthKey(e.completedAt))]);
    return [...keys].sort().reverse();
  }, [allEntries]);
  const [period, setPeriod] = useState(() => periods[0] ?? monthKey(new Date()));

  const monthEntries = useMemo(
    () => allEntries.filter((e) => monthKey(e.completedAt) === period),
    [allEntries, period],
  );

  const weeks = useMemo<WeekGroup[]>(() => {
    const byWeek = new Map<string, Map<string, CutHistoryEntry[]>>();
    for (const entry of monthEntries) {
      const wKey = weekKey(entry.completedAt);
      const dKey = dayKey(entry.completedAt);
      if (!byWeek.has(wKey)) byWeek.set(wKey, new Map());
      const byDay = byWeek.get(wKey)!;
      if (!byDay.has(dKey)) byDay.set(dKey, []);
      byDay.get(dKey)!.push(entry);
    }
    return [...byWeek.entries()]
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .map(([wKey, byDay]) => ({
        key: wKey,
        days: [...byDay.entries()]
          .sort((a, b) => (a[0] < b[0] ? 1 : -1))
          .map(([dKey, entries]) => ({ key: dKey, entries })),
      }));
  }, [monthEntries]);

  const monthTotals = useMemo(
    () => ({ sheets: monthEntries.reduce((s, e) => s + e.sheets, 0), orders: monthEntries.length }),
    [monthEntries],
  );

  if (!user || !userData) return <Spinner />;

  return (
    <AppShell title="Тарих" subtitle="Кесілген заказдар — күн және апта бойынша">
      <div className="form-group" style={{ maxWidth: 260 }}>
        <label>Айы</label>
        <select className="form-input" value={period} onChange={(e) => setPeriod(e.target.value)}>
          {periods.map((p) => (
            <option key={p} value={p}>{monthLabel(p)}</option>
          ))}
        </select>
      </div>

      <div className="stats-bar">
        <div className="stat-card">
          <div className="number">{monthTotals.sheets}</div>
          <div className="label">Лист ({monthLabel(period)})</div>
        </div>
        <div className="stat-card">
          <div className="number">{monthTotals.orders}</div>
          <div className="label">Заказ</div>
        </div>
      </div>

      {loading ? (
        <Spinner />
      ) : weeks.length === 0 ? (
        <div className="empty-state">
          <div className="icon">📭</div>
          <p>Бұл айда кесілген заказ жоқ</p>
        </div>
      ) : (
        weeks.map((week) => {
          const weekSheets = week.days.reduce((s, d) => s + d.entries.reduce((s2, e) => s2 + e.sheets, 0), 0);
          const weekOrders = week.days.reduce((s, d) => s + d.entries.length, 0);
          return (
            <section className="panel-card" key={week.key}>
              <div className="panel-head">
                <h3>Апта: {weekLabel(week.key)}</h3>
                <span className="otable-sub">{weekSheets} лист · {weekOrders} заказ</span>
              </div>

              {week.days.map((day) => {
                const daySheets = day.entries.reduce((s, e) => s + e.sheets, 0);
                return (
                  <div className="cutter-history-day" key={day.key}>
                    <div className="cutter-history-day-head">
                      <strong>{formatDateDMY(day.entries[0].completedAt)}</strong>
                      <span className="otable-sub">{daySheets} лист · {day.entries.length} заказ</span>
                    </div>
                    <div className="data-list">
                      {day.entries.map((e) => (
                        <div className="data-row" key={e.orderId}>
                          <div className="data-row-main">
                            <strong>{e.orderNumber}</strong>
                            <span>{e.customerName} · {e.materials.join(", ")}</span>
                          </div>
                          <span className="otable-strong">{e.sheets} лист</span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </section>
          );
        })
      )}
    </AppShell>
  );
}
