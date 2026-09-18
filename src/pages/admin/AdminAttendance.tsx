import { useEffect, useMemo, useState } from "react";
import { collection, getDocs, query, where } from "firebase/firestore";
import { db } from "../../firebase";
import { useAuth } from "../../AuthContext";
import { Spinner, Toast } from "../../components";
import { AppShell } from "../../components/layout/AppShell";
import { useToast } from "../../hooks";
import { useAttendance } from "../../hooks/useSalary";
import { markAttendance, hoursBetween } from "../../lib/salaryWrite";
import { dayKey, formatDateDMY, monthLabel } from "../../lib/dates";
import { ROLE_LABELS } from "../../lib/rbac";
import {
  ATTENDANCE_LABELS,
  type AttendanceRecord,
  type AttendanceStatus,
  type UserDoc,
} from "../../types/domain";

interface StaffUser extends UserDoc {
  id: string;
}

/**
 * "Келді" leads because it is what nearly every tap is; the rest sit behind "Басқа" so the common
 * case is one button, not one of five. "Кешікті" earns its place next to it — a late arrival is
 * the one exception frequent enough to be worth a first-class tap.
 */
const PRIMARY: AttendanceStatus[] = ["present", "late"];
const OTHER: AttendanceStatus[] = ["absent", "dayoff", "sick"];
const TONE: Record<AttendanceStatus, string> = {
  present: "green",
  late: "amber",
  absent: "red",
  dayoff: "muted",
  sick: "blue",
};
const ICON: Record<AttendanceStatus, string> = {
  present: "✓",
  late: "🕐",
  absent: "✕",
  dayoff: "☾",
  sick: "✚",
};

/** Yesterday/tomorrow from a "YYYY-MM-DD" key, in UTC so a shift can never slip two days. */
function shiftDay(day: string, delta: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/**
 * "Жұмысқа келу" — the register that gets filled in at the door every morning, by whoever is
 * standing there (Admin or Manager; see firestore.rules on /attendance).
 *
 * Built around the one fact that decides the whole layout: on a normal morning every tap is
 * "Келді". So the page opens on today, offers to mark everybody present at once, and gives each
 * worker a single wide button for the common answer — the other four statuses and the clock-in
 * times are a tap further in, where they belong given how rarely they are touched.
 */
export default function AdminAttendance() {
  const { user, userData } = useAuth();
  const { records, loading } = useAttendance();
  const { message, visible, showToast } = useToast();

  const [staff, setStaff] = useState<StaffUser[]>([]);
  const [date, setDate] = useState(dayKey(new Date()));
  const [busyUid, setBusyUid] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);

  useEffect(() => {
    getDocs(query(collection(db, "users"), where("role", "in", ["manager", "raspil", "pvh", "cnc", "sanding", "painting", "vacuum"])))
      .then((snap) => setStaff(snap.docs.map((d) => ({ id: d.id, ...(d.data() as UserDoc) }))))
      .catch(() => setStaff([]));
  }, []);

  const byUidForDate = useMemo(() => {
    const map = new Map<string, AttendanceRecord>();
    for (const r of records) if (r.date === date) map.set(r.userId, r);
    return map;
  }, [records, date]);

  const today = dayKey(new Date());
  const isToday = date === today;

  // The count that actually matters at the door: how many people are still unanswered.
  const tally = useMemo(() => {
    let present = 0;
    let late = 0;
    let away = 0;
    for (const member of staff) {
      const status = byUidForDate.get(member.id)?.status;
      if (status === "present") present += 1;
      else if (status === "late") late += 1;
      else if (status) away += 1;
    }
    return { present, late, away, unmarked: staff.length - present - late - away };
  }, [staff, byUidForDate]);

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

  /** One write for one employee-day; every button on this page funnels through here. */
  const write = (member: StaffUser, patch: Partial<AttendanceRecord>) => {
    const existing = byUidForDate.get(member.id);
    return markAttendance(db, actor, {
      userId: member.id,
      userName: member.name,
      date,
      status: patch.status ?? existing?.status ?? "present",
      checkIn: (patch.checkIn ?? existing?.checkIn) || undefined,
      checkOut: (patch.checkOut ?? existing?.checkOut) || undefined,
      comment: existing?.comment,
    });
  };

  const mark = async (member: StaffUser, status: AttendanceStatus) => {
    setBusyUid(member.id);
    try {
      await write(member, { status });
      // Marking somebody closes their expanded panel: the answer is given, the row is done.
      setExpanded(null);
    } catch (err: unknown) {
      showToast("Қате: " + (err as Error).message);
    }
    setBusyUid(null);
  };

  const setTime = async (member: StaffUser, field: "checkIn" | "checkOut", value: string) => {
    try {
      await write(member, { [field]: value } as Partial<AttendanceRecord>);
    } catch (err: unknown) {
      showToast("Қате: " + (err as Error).message);
    }
  };

  /**
   * "Бәрі келді" — the morning's real shortcut. Only the people with no answer yet are touched,
   * so it can be pressed after a couple of absences are already in without undoing them.
   */
  const markAllPresent = async () => {
    const pending = staff.filter((m) => !byUidForDate.has(m.id));
    if (pending.length === 0) return;
    setBulkBusy(true);
    try {
      for (const member of pending) await write(member, { status: "present" });
      showToast(`✅ ${pending.length} адам «Келді» деп белгіленді`);
    } catch (err: unknown) {
      showToast("Қате: " + (err as Error).message);
    }
    setBulkBusy(false);
  };

  return (
    <AppShell
      title="Жұмысқа келу"
      subtitle={formatDateDMY(new Date(`${date}T12:00:00+05:00`))}
      back={userData.role === "manager" ? "/manager" : "/admin"}
    >
      {/* Day picker: arrows for the neighbouring days, the label itself jumps back to today, and
          the native date input stays available for anything further away. */}
      <div className="att-daybar">
        <button type="button" className="att-day-arrow" onClick={() => setDate(shiftDay(date, -1))} aria-label="Алдыңғы күн">‹</button>
        <div className="att-day-mid">
          <button type="button" className="att-day-label" onClick={() => setDate(today)} disabled={isToday}>
            {isToday ? "Бүгін" : formatDateDMY(new Date(`${date}T12:00:00+05:00`))}
          </button>
          <input
            type="date"
            className="att-day-input"
            value={date}
            max={today}
            onChange={(e) => setDate(e.target.value || today)}
            aria-label="Күнін таңдау"
          />
        </div>
        <button
          type="button"
          className="att-day-arrow"
          onClick={() => setDate(shiftDay(date, 1))}
          disabled={isToday}
          aria-label="Келесі күн"
        >›</button>
      </div>

      <div className="att-tally">
        <span className="att-tally-item is-green"><b>{tally.present}</b> келді</span>
        <span className="att-tally-item is-amber"><b>{tally.late}</b> кешікті</span>
        <span className="att-tally-item is-red"><b>{tally.away}</b> жоқ</span>
        <span className="att-tally-item"><b>{tally.unmarked}</b> белгіленбеген</span>
      </div>

      {tally.unmarked > 0 && (
        <button type="button" className="att-bulk" disabled={bulkBusy} onClick={markAllPresent}>
          ✓ Қалған {tally.unmarked} адамды «Келді» деп белгілеу
        </button>
      )}

      {loading ? (
        <Spinner />
      ) : staff.length === 0 ? (
        <div className="empty-state">
          <div className="icon">👥</div>
          <p>Қызметкер жоқ</p>
        </div>
      ) : (
        <div className="att-list">
          {staff.map((member) => {
            const record = byUidForDate.get(member.id);
            const status = record?.status;
            const hours = hoursBetween(record?.checkIn ?? undefined, record?.checkOut ?? undefined);
            const isOpen = expanded === member.id;
            const busy = busyUid === member.id;
            return (
              <div key={member.id} className={`att-card${status ? ` is-${TONE[status]}` : ""}`}>
                <div className="att-card-head">
                  <div className="att-who">
                    <strong>{member.name}</strong>
                    <span>{ROLE_LABELS[member.role]}</span>
                  </div>
                  {status && (
                    <span className={`att-state tone-${TONE[status]}`}>
                      {ICON[status]} {ATTENDANCE_LABELS[status]}
                      {hours !== undefined && <em> · {hours.toFixed(1)} сағ</em>}
                    </span>
                  )}
                </div>

                <div className="att-actions">
                  {PRIMARY.map((s) => (
                    <button
                      key={s}
                      type="button"
                      disabled={busy}
                      aria-pressed={status === s}
                      className={`att-btn tone-${TONE[s]}${status === s ? " is-active" : ""}`}
                      onClick={() => mark(member, s)}
                    >
                      {ICON[s]} {ATTENDANCE_LABELS[s]}
                    </button>
                  ))}
                  <button
                    type="button"
                    className={`att-btn att-more${isOpen ? " is-active" : ""}`}
                    aria-expanded={isOpen}
                    onClick={() => setExpanded(isOpen ? null : member.id)}
                  >
                    Басқа
                  </button>
                </div>

                {isOpen && (
                  <div className="att-drawer">
                    <div className="att-actions">
                      {OTHER.map((s) => (
                        <button
                          key={s}
                          type="button"
                          disabled={busy}
                          aria-pressed={status === s}
                          className={`att-btn tone-${TONE[s]}${status === s ? " is-active" : ""}`}
                          onClick={() => mark(member, s)}
                        >
                          {ICON[s]} {ATTENDANCE_LABELS[s]}
                        </button>
                      ))}
                    </div>
                    {/* Times are optional everywhere except HOURLY pay, which is why they live in
                        here rather than on every row taking up space they rarely earn. */}
                    <div className="att-times">
                      <label>
                        <span>Келген</span>
                        <input
                          type="time"
                          className="form-input"
                          value={record?.checkIn ?? ""}
                          onChange={(e) => setTime(member, "checkIn", e.target.value)}
                        />
                      </label>
                      <label>
                        <span>Кеткен</span>
                        <input
                          type="time"
                          className="form-input"
                          value={record?.checkOut ?? ""}
                          onChange={(e) => setTime(member, "checkOut", e.target.value)}
                        />
                      </label>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Closed by default, and on every screen: marking today is the job this page exists for,
          and ten workers' stacked monthly rows underneath it push that job off the phone. The
          month total is something you come looking for, so it costs one tap. */}
      <details className="att-summary">
        <summary>{monthLabel(period)} қорытындысы</summary>
        <div className="data-table-wrap">
          <table className="data-table stack-mobile">
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
                    <td data-label="Қызметкер"><strong>{member.name}</strong></td>
                    <td data-label="Келді">{s.present}</td>
                    <td data-label="Кешікті">{s.late}</td>
                    <td data-label="Келмеді">{s.absent}</td>
                    <td data-label="Сағат">{s.hours.toFixed(1)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </details>

      <Toast message={message} visible={visible} />
    </AppShell>
  );
}
