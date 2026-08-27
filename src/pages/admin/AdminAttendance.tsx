import { useEffect, useMemo, useState } from "react";
import { collection, getDocs, query, where } from "firebase/firestore";
import { db } from "../../firebase";
import { useAuth } from "../../AuthContext";
import { Spinner, Toast } from "../../components";
import { AppShell } from "../../components/layout/AppShell";
import { useToast } from "../../hooks";
import { useAttendance } from "../../hooks/useSalary";
import { markAttendance, hoursBetween } from "../../lib/salaryWrite";
import { dayKey, formatDateDMY, monthLabel, monthKey } from "../../lib/dates";
import { ROLE_LABELS } from "../../lib/rbac";
import { ATTENDANCE_LABELS, type AttendanceStatus, type UserDoc } from "../../types/domain";

interface StaffUser extends UserDoc {
  id: string;
}

const STATUSES: AttendanceStatus[] = ["present", "late", "absent", "dayoff", "sick"];
const TONE: Record<AttendanceStatus, string> = {
  present: "green",
  late: "amber",
  absent: "red",
  dayoff: "muted",
  sick: "blue",
};

/** "Жұмысқа қатысу" — Admin's daily register plus a per-employee monthly summary. */
export default function AdminAttendance() {
  const { user, userData } = useAuth();
  const { records, loading } = useAttendance();
  const { message, visible, showToast } = useToast();

  const [staff, setStaff] = useState<StaffUser[]>([]);
  const [date, setDate] = useState(dayKey(new Date()));
  const [busyUid, setBusyUid] = useState<string | null>(null);

  useEffect(() => {
    getDocs(query(collection(db, "users"), where("role", "in", ["manager", "raspil", "pvh"])))
      .then((snap) => setStaff(snap.docs.map((d) => ({ id: d.id, ...(d.data() as UserDoc) }))))
      .catch(() => setStaff([]));
  }, []);

  const byUidForDate = useMemo(() => {
    const map = new Map<string, (typeof records)[number]>();
    for (const r of records) if (r.date === date) map.set(r.userId, r);
    return map;
  }, [records, date]);

  const period = date.slice(0, 7);
  const monthSummary = useMemo(() => {
    const map = new Map<string, { present: number; late: number; absent: number; hours: number }>();
    for (const r of records) {
      if (!r.date.startsWith(period)) continue;
      const entry = map.get(r.userId) ?? { present: 0, late: 0, absent: 0, hours: 0 };
      if (r.status === "present") entry.present += 1;
      if (r.status === "late") entry.late += 1;
      if (r.status === "absent") entry.absent += 1;
      entry.hours += r.workedHours ?? 0;
      map.set(r.userId, entry);
    }
    return map;
  }, [records, period]);

  if (!user || !userData) return <Spinner />;
  const actor = { user, userData };

  const mark = async (member: StaffUser, status: AttendanceStatus) => {
    setBusyUid(member.id);
    try {
      const existing = byUidForDate.get(member.id);
      await markAttendance(db, actor, {
        userId: member.id,
        userName: member.name,
        date,
        status,
        checkIn: existing?.checkIn ?? undefined,
        checkOut: existing?.checkOut ?? undefined,
        comment: existing?.comment,
      });
      showToast(`✅ ${member.name}: ${ATTENDANCE_LABELS[status]}`);
    } catch (err: unknown) {
      showToast("Қате: " + (err as Error).message);
    }
    setBusyUid(null);
  };

  const setTime = async (member: StaffUser, field: "checkIn" | "checkOut", value: string) => {
    const existing = byUidForDate.get(member.id);
    const checkIn = field === "checkIn" ? value : existing?.checkIn ?? undefined;
    const checkOut = field === "checkOut" ? value : existing?.checkOut ?? undefined;
    try {
      await markAttendance(db, actor, {
        userId: member.id,
        userName: member.name,
        date,
        status: existing?.status ?? "present",
        checkIn,
        checkOut,
        comment: existing?.comment,
      });
    } catch (err: unknown) {
      showToast("Қате: " + (err as Error).message);
    }
  };

  return (
    <AppShell title="Жұмысқа қатысу" subtitle={formatDateDMY(new Date(`${date}T12:00:00+05:00`))}>
      <div className="form-group" style={{ maxWidth: 240 }}>
        <label>Күні</label>
        <input type="date" className="form-input" value={date} onChange={(e) => setDate(e.target.value || dayKey(new Date()))} />
      </div>

      {loading ? (
        <Spinner />
      ) : staff.length === 0 ? (
        <div className="empty-state">
          <div className="icon">👥</div>
          <p>Қызметкер жоқ</p>
        </div>
      ) : (
        <section className="panel-card">
          <div className="panel-head">
            <h3>Күнделікті белгі</h3>
          </div>
          <div className="data-list">
            {staff.map((member) => {
              const record = byUidForDate.get(member.id);
              const hours = hoursBetween(record?.checkIn ?? undefined, record?.checkOut ?? undefined);
              return (
                <div key={member.id} className="data-row attendance-row">
                  <div className="data-row-main">
                    <strong>{member.name}</strong>
                    <span>{ROLE_LABELS[member.role]}</span>
                  </div>

                  <div className="attendance-times">
                    <input
                      type="time"
                      className="form-input jt-input"
                      value={record?.checkIn ?? ""}
                      onChange={(e) => setTime(member, "checkIn", e.target.value)}
                      aria-label="Келген уақыты"
                    />
                    <input
                      type="time"
                      className="form-input jt-input"
                      value={record?.checkOut ?? ""}
                      onChange={(e) => setTime(member, "checkOut", e.target.value)}
                      aria-label="Кеткен уақыты"
                    />
                    {hours !== undefined && <span className="jt-muted">{hours.toFixed(1)} сағ</span>}
                  </div>

                  <div className="attendance-buttons">
                    {STATUSES.map((s) => (
                      <button
                        key={s}
                        disabled={busyUid === member.id}
                        className={`attendance-btn${record?.status === s ? ` is-active tone-${TONE[s]}` : ""}`}
                        onClick={() => mark(member, s)}
                      >
                        {ATTENDANCE_LABELS[s]}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <section className="panel-card" style={{ marginTop: 18 }}>
        <div className="panel-head">
          <h3>{monthLabel(period)} қорытындысы</h3>
          {period === monthKey(new Date()) && <span className="jt-muted">ағымдағы ай</span>}
        </div>
        <div className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Қызметкер</th>
                <th>Келді</th>
                <th>Кешікті</th>
                <th>Келмеді</th>
                <th>Сағат</th>
              </tr>
            </thead>
            <tbody>
              {staff.map((member) => {
                const s = monthSummary.get(member.id) ?? { present: 0, late: 0, absent: 0, hours: 0 };
                return (
                  <tr key={member.id}>
                    <td>{member.name}</td>
                    <td>{s.present}</td>
                    <td>{s.late}</td>
                    <td>{s.absent}</td>
                    <td>{s.hours.toFixed(1)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <Toast message={message} visible={visible} />
    </AppShell>
  );
}
