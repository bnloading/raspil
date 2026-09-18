import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { collection, getDocs, query, where } from "firebase/firestore";
import { db } from "../firebase";
import { useAuth } from "../AuthContext";
import { useAttendance } from "../hooks/useSalary";
import { markAttendance } from "../lib/salaryWrite";
import { dayKey } from "../lib/dates";
import type { UserDoc } from "../types/domain";

interface StaffUser extends UserDoc {
  id: string;
}

/**
 * "Жұмысқа келу" on the Admin's and Manager's own home screen.
 *
 * The register is a morning job, and a morning job that lives three taps away in a side menu is a
 * morning job that gets done at lunchtime. So the state of today — and the one button that
 * finishes it on an ordinary day — sit on the first screen either of them opens.
 *
 * Everything it writes goes through the same markAttendance the full page uses, so a day marked
 * from here is indistinguishable from one marked there.
 */
export function AttendanceTodayCard() {
  const { user, userData } = useAuth();
  const { records } = useAttendance();
  const [staff, setStaff] = useState<StaffUser[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getDocs(query(collection(db, "users"), where("role", "in", ["manager", "raspil", "pvh", "cnc", "sanding", "painting", "vacuum"])))
      .then((snap) => setStaff(snap.docs.map((d) => ({ id: d.id, ...(d.data() as UserDoc) }))))
      .catch(() => setStaff([]));
  }, []);

  const today = dayKey(new Date());
  const tally = useMemo(() => {
    const byUid = new Map(records.filter((r) => r.date === today).map((r) => [r.userId, r]));
    let present = 0;
    let late = 0;
    let away = 0;
    for (const member of staff) {
      const status = byUid.get(member.id)?.status;
      if (status === "present") present += 1;
      else if (status === "late") late += 1;
      else if (status) away += 1;
    }
    return {
      present, late, away,
      pending: staff.filter((m) => !byUid.has(m.id)),
    };
  }, [records, staff, today]);

  if (!user || !userData || staff.length === 0) return null;

  /** Only the people with no answer yet, so pressing it never overwrites a marked absence. */
  const markRest = async () => {
    setBusy(true);
    setError(null);
    try {
      for (const member of tally.pending) {
        await markAttendance(db, { user, userData }, {
          userId: member.id,
          userName: member.name,
          date: today,
          status: "present",
        });
      }
    } catch (err: unknown) {
      setError((err as Error).message);
    }
    setBusy(false);
  };

  const done = tally.pending.length === 0;

  return (
    <section className="panel-card att-today">
      <div className="panel-head">
        <h3>Жұмысқа келу</h3>
        <Link to="/attendance" className="att-today-link">Бәрін ашу ›</Link>
      </div>

      <div className="att-tally">
        <span className="att-tally-item is-green"><b>{tally.present}</b> келді</span>
        <span className="att-tally-item is-amber"><b>{tally.late}</b> кешікті</span>
        <span className="att-tally-item is-red"><b>{tally.away}</b> жоқ</span>
        <span className="att-tally-item"><b>{tally.pending.length}</b> белгіленбеген</span>
      </div>

      {done ? (
        <p className="att-today-done">✓ Бүгінгі белгі толық қойылған</p>
      ) : (
        <button type="button" className="att-bulk" disabled={busy} onClick={markRest}>
          ✓ Қалған {tally.pending.length} адамды «Келді» деп белгілеу
        </button>
      )}
      {error && <p className="att-today-error">Қате: {error}</p>}
    </section>
  );
}
