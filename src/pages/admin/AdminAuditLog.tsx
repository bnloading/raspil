import { useEffect, useState } from "react";
import { collection, limit, onSnapshot, orderBy, query } from "firebase/firestore";
import { db } from "../../firebase";
import { Spinner } from "../../components";
import { AppShell } from "../../components/layout/AppShell";
import { formatDateTimeDMY } from "../../lib/dates";
import type { AuditLogEntry } from "../../types/domain";

export default function AdminAuditLog() {
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionFilter, setActionFilter] = useState("all");

  useEffect(() => {
    const q = query(collection(db, "auditLogs"), orderBy("createdAt", "desc"), limit(200));
    const unsub = onSnapshot(q, (snap) => {
      const list: AuditLogEntry[] = [];
      snap.forEach((d) => list.push({ id: d.id, ...(d.data() as Omit<AuditLogEntry, "id">) }));
      setEntries(list);
      setLoading(false);
    });
    return unsub;
  }, []);

  const actions = ["all", ...Array.from(new Set(entries.map((e) => e.action)))];
  const filtered = actionFilter === "all" ? entries : entries.filter((e) => e.action === actionFilter);

  return (
    <AppShell title="Аудит журналы" subtitle="Барлық әрекеттер тарихы">
      <div className="filter-bar">
        <select className="form-input" value={actionFilter} onChange={(e) => setActionFilter(e.target.value)}>
          {actions.map((a) => (
            <option key={a} value={a}>
              {a === "all" ? "Барлық әрекеттер" : a}
            </option>
          ))}
        </select>
      </div>

      <div className="panel-card">
        {loading ? (
          <Spinner />
        ) : filtered.length === 0 ? (
          <div className="empty-state">
            <div className="icon">📭</div>
            <p>Жазба жоқ</p>
          </div>
        ) : (
          <div className="data-table-wrap">
            <table className="data-table stack-mobile stack-compact">
              <thead>
                <tr>
                  <th>Уақыты</th>
                  <th>Қолданушы</th>
                  <th>Әрекет</th>
                  <th>Мәлімет</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((e) => (
                  <tr key={e.id}>
                    <td data-label="Уақыты">{e.createdAt ? formatDateTimeDMY(e.createdAt) : "—"}</td>
                    <td data-label="Қолданушы">{e.userName}</td>
                    <td data-label="Әрекет"><strong>{e.action}</strong></td>
                    <td data-label="Мәлімет">
                      {e.entityType} · {e.entityId}
                      {e.comment && <div>💬 {e.comment}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </AppShell>
  );
}
