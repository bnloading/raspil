import { useMemo, useState } from "react";
import { useAuth } from "../AuthContext";
import { Spinner } from "../components";
import { AppShell } from "../components/layout/AppShell";
import { useAttendance } from "../hooks/useSalary";
import { formatDateDMY, monthKey, monthLabel } from "../lib/dates";
import { ATTENDANCE_LABELS, type AttendanceStatus } from "../types/domain";

const TONE: Record<AttendanceStatus, string> = {
  present: "green",
  late: "amber",
  absent: "red",
  dayoff: "muted",
  sick: "blue",
};

/** "Қатысуым" — a worker's own attendance history. Scoped to their uid; rules enforce the rest. */
export default function MyAttendance() {
  const { user, userData } = useAuth();
  const { records, loading } = useAttendance(user?.uid);
  const [period, setPeriod] = useState(monthKey(new Date()));

  const periods = useMemo(() => {
    const keys = new Set<string>([monthKey(new Date()), ...records.map((r) => r.date.slice(0, 7))]);
    return [...keys].sort().reverse();
  }, [records]);

  const monthRecords = useMemo(
    () => records.filter((r) => r.date.startsWith(period)).sort((a, b) => (a.date < b.date ? 1 : -1)),
    [records, period],
  );

  const summary = useMemo(() => {
    const count = (s: AttendanceStatus) => monthRecords.filter((r) => r.status === s).length;
    return {
      present: count("present"),
      late: count("late"),
      absent: count("absent"),
      hours: monthRecords.reduce((sum, r) => sum + (r.workedHours ?? 0), 0),
    };
  }, [monthRecords]);

  if (!user || !userData) return <Spinner />;
  if (loading) return <Spinner />;

  return (
    <AppShell title="Жұмысқа қатысу" subtitle={userData.name}>
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

      <div className="stats-bar">
        <div className="stat-card">
          <div className="number">{summary.present}</div>
          <div className="label">Келді</div>
        </div>
        <div className="stat-card">
          <div className="number">{summary.late}</div>
          <div className="label">Кешікті</div>
        </div>
        <div className="stat-card">
          <div className="number">{summary.absent}</div>
          <div className="label">Келмеді</div>
        </div>
        <div className="stat-card">
          <div className="number">{summary.hours.toFixed(1)}</div>
          <div className="label">Сағат</div>
        </div>
      </div>

      <section className="panel-card">
        <div className="panel-head">
          <h3>{monthLabel(period)}</h3>
        </div>
        {monthRecords.length === 0 ? (
          <div className="empty-state">
            <div className="icon">📅</div>
            <p>Бұл айда белгі жоқ</p>
          </div>
        ) : (
          <div className="data-list">
            {monthRecords.map((r) => (
              <div key={r.id} className="data-row">
                <div className="data-row-main">
                  <strong>{formatDateDMY(new Date(`${r.date}T12:00:00+05:00`))}</strong>
                  {(r.checkIn || r.checkOut) && (
                    <span>
                      {r.checkIn ?? "—"} – {r.checkOut ?? "—"}
                      {r.workedHours !== undefined ? ` · ${r.workedHours.toFixed(1)} сағ` : ""}
                    </span>
                  )}
                  {r.comment && <span>{r.comment}</span>}
                </div>
                <div className="data-row-actions">
                  <span className={`jt-pill jt-tone-${TONE[r.status]}`}>{ATTENDANCE_LABELS[r.status]}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </AppShell>
  );
}
