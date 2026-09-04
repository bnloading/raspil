import { useEffect, useState, type FormEvent } from "react";
import { collection, doc, onSnapshot, orderBy, query, setDoc, updateDoc } from "firebase/firestore";
import { db, createUserWithoutSigningIn } from "../../firebase";
import { useAuth } from "../../AuthContext";
import { Toast, Spinner } from "../../components";
import { AppShell } from "../../components/layout/AppShell";
import { PhoneInput } from "../../components/PhoneInput";
import { useToast } from "../../hooks";
import { formatPhone } from "../../lib/phone";
import { ROLE_LABELS, departmentOf, DEPARTMENT_LABELS } from "../../lib/rbac";
import { logAudit } from "../../lib/audit";
import type { Department, UserDoc, UserRole } from "../../types/domain";

interface UserRow extends UserDoc {
  id: string;
}

const STAFF_ROLES: UserRole[] = ["admin", "manager", "raspil", "pvh", "cnc", "sanding", "painting", "vacuum"];

/** Only these roles have an "Айлығым" page at all (see navConfig.ts's worker nav builders) — the
 *  hide-salary toggle is meaningless, so hidden, for admin/manager. */
const WORKER_ROLES: UserRole[] = ["raspil", "pvh", "cnc", "sanding", "painting", "vacuum"];

/**
 * Which roles an admin/manager of one line may create or reassign staff into — the two lines now
 * run as separate businesses (see lib/rbac.ts departmentOf()), so a МДФ admin manages the МДФ
 * team only, and a ЛДСП admin manages the ЛДСП team only.
 */
const ROLES_FOR_DEPARTMENT: Record<Department, UserRole[]> = {
  ldsp: ["admin", "manager", "raspil", "pvh"],
  mdf: ["admin", "manager", "cnc", "sanding", "painting", "vacuum"],
};

const ROLE_OPTION_LABELS: Partial<Record<UserRole, string>> = {
  admin: "👑 Админ",
  manager: "🗂 Менеджер",
  raspil: "🪚 Распилшик",
  pvh: "🪟 ПВХ жабыстырушы",
  cnc: "🖥 ЧПУ операторы",
  sanding: "🧽 Шкуркалаушы",
  painting: "🎨 Бояушы",
  vacuum: "📦 Вакуумшы",
};

export default function AdminUsers() {
  const auth = useAuth();
  const { userData } = auth;
  const myDepartment = userData ? departmentOf(userData) : "ldsp";
  const myRoles = ROLES_FOR_DEPARTMENT[myDepartment];
  const { message, visible, showToast } = useToast();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(true);

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<UserRole>(myRoles[myRoles.length - 1]);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const q = query(collection(db, "users"), orderBy("createdAt", "desc"));
    const unsub = onSnapshot(
      q,
      (snap) => {
        const list: UserRow[] = [];
        snap.forEach((d) => list.push({ id: d.id, ...(d.data() as UserDoc) }));
        setUsers(list);
        setLoadingUsers(false);
      },
      () => setLoadingUsers(false),
    );
    return unsub;
  }, []);

  const staff = users.filter((u) => STAFF_ROLES.includes(u.role) && departmentOf(u) === myDepartment);
  const customers = users.filter((u) => u.role === "customer");

  const handleCreateStaff = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !email.trim() || password.length < 6) {
      showToast("Барлық өрістерді дұрыс толтырыңыз (құпия сөз мин. 6 таңба)");
      return;
    }
    setSubmitting(true);
    try {
      const uid = await createUserWithoutSigningIn(email.trim(), password);
      await setDoc(doc(db, "users", uid), {
        name: name.trim(),
        phone: phone.trim(),
        email: email.trim(),
        authEmail: email.trim(),
        role,
        // Only admin/manager carry an explicit department — raspil/pvh/cnc/sanding/painting/vacuum
        // already imply one from the role itself (see lib/rbac.ts departmentOf()).
        ...(role === "admin" || role === "manager" ? { department: myDepartment } : {}),
        blocked: false,
        createdAt: new Date(),
      });
      if (auth.user && auth.userData) {
        await logAudit(db, { user: auth.user, userData: auth.userData }, {
          action: "user.create",
          entityType: "user",
          entityId: uid,
          after: { name: name.trim(), email: email.trim(), role },
        });
      }
      showToast(`✅ ${name.trim()} (${ROLE_LABELS[role]}) құрылды`);
      setName("");
      setEmail("");
      setPhone("");
      setPassword("");
    } catch (err: unknown) {
      const fireErr = err as { code?: string; message?: string };
      let msg = "Қате: " + (fireErr.message || "");
      if (fireErr.code === "auth/email-already-in-use") msg = "Бұл email бұрыннан тіркелген";
      else if (fireErr.code === "auth/weak-password") msg = "Құпия сөз тым қысқа (мин. 6 таңба)";
      showToast(msg);
    }
    setSubmitting(false);
  };

  const handleToggleBlocked = async (target: UserRow) => {
    try {
      await updateDoc(doc(db, "users", target.id), { blocked: !target.blocked });
      if (auth.user && auth.userData) {
        await logAudit(db, { user: auth.user, userData: auth.userData }, {
          action: target.blocked ? "user.unblock" : "user.block",
          entityType: "user",
          entityId: target.id,
          before: { blocked: target.blocked },
          after: { blocked: !target.blocked },
        });
      }
      showToast(target.blocked ? "🔓 Бұғаттан шығарылды" : "🔒 Бұғатталды");
    } catch (err: unknown) {
      showToast("Қате: " + (err as Error).message);
    }
  };

  const handleToggleHideSalary = async (target: UserRow) => {
    try {
      await updateDoc(doc(db, "users", target.id), { hideSalary: !target.hideSalary });
      if (auth.user && auth.userData) {
        await logAudit(db, { user: auth.user, userData: auth.userData }, {
          action: target.hideSalary ? "user.show_salary" : "user.hide_salary",
          entityType: "user",
          entityId: target.id,
          before: { hideSalary: !!target.hideSalary },
          after: { hideSalary: !target.hideSalary },
        });
      }
      showToast(target.hideSalary ? "👁 Айлығы қайта көрсетілді" : "🙈 Айлығы жасырылды");
    } catch (err: unknown) {
      showToast("Қате: " + (err as Error).message);
    }
  };

  const handleChangeRole = async (target: UserRow, newRole: UserRole) => {
    if (newRole === target.role) return;
    try {
      await updateDoc(doc(db, "users", target.id), {
        role: newRole,
        // Reassigning into admin/manager here only ever happens within the acting admin's own
        // department list (myRoles), so the promoted account inherits that same department.
        ...(newRole === "admin" || newRole === "manager" ? { department: myDepartment } : {}),
      });
      if (auth.user && auth.userData) {
        await logAudit(db, { user: auth.user, userData: auth.userData }, {
          action: "user.role_change",
          entityType: "user",
          entityId: target.id,
          before: { role: target.role },
          after: { role: newRole },
        });
      }
      showToast(`✅ Рөл өзгертілді: ${ROLE_LABELS[newRole]}`);
    } catch (err: unknown) {
      showToast("Қате: " + (err as Error).message);
    }
  };

  if (!userData) return <Spinner />;

  return (
    <AppShell title="Клиенттер" subtitle="Қолданушылар мен клиенттерді басқару">
      <div className="panel-card">
        <div className="panel-head">
          <h3>👤 Жаңа қызметкер қосу</h3>
        </div>
        <form onSubmit={handleCreateStaff} className="form-grid">
          <div className="form-group">
            <label>Аты</label>
            <input
              type="text"
              className="form-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>
          <div className="form-group">
            <label>Email</label>
            <input
              type="email"
              className="form-input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div className="form-group">
            <label>Телефон (міндетті емес)</label>
            <PhoneInput value={phone} onChange={setPhone} />
          </div>
          <div className="form-group">
            <label>Құпия сөз (мин. 6 таңба)</label>
            <input
              type="password"
              className="form-input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={6}
            />
          </div>
          <div className="form-group">
            <label>Рөл ({DEPARTMENT_LABELS[myDepartment]})</label>
            <select
              className="form-input"
              value={role}
              onChange={(e) => setRole(e.target.value as UserRole)}
            >
              {myRoles.map((r) => (
                <option key={r} value={r}>{ROLE_OPTION_LABELS[r]}</option>
              ))}
            </select>
          </div>
          <button type="submit" className="btn btn-primary btn-full span-2" disabled={submitting}>
            {submitting ? "Құрылуда..." : "Қызметкер құру"}
          </button>
        </form>
      </div>

      <div className="panel-card">
        <div className="panel-head">
          <h3>👷 Персонал — {DEPARTMENT_LABELS[myDepartment]}</h3>
          <span>{staff.length}</span>
        </div>
        {loadingUsers ? (
          <Spinner />
        ) : (
          <div className="data-table-wrap">
            <table className="data-table stack-mobile stack-compact">
              <thead>
                <tr>
                  <th>Аты</th>
                  <th>Телефон</th>
                  <th>Рөл</th>
                  <th>Әрекеттер</th>
                </tr>
              </thead>
              <tbody>
                {staff.map((u) => (
                  <tr key={u.id} className={u.blocked ? "blocked" : undefined}>
                    <td data-label="Аты">
                      <strong>{u.name}</strong>
                      <div>{u.email}</div>
                    </td>
                    <td data-label="Телефон">{u.phone ? formatPhone(u.phone) : "—"}</td>
                    <td data-label="Рөл">
                      <select
                        className="form-select-material"
                        value={u.role}
                        onChange={(e) => handleChangeRole(u, e.target.value as UserRole)}
                      >
                        {myRoles.map((r) => (
                          <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                        ))}
                      </select>
                    </td>
                    <td data-label="Әрекеттер">
                      <div className="data-row-actions">
                        <button
                          type="button"
                          className={`btn btn-outline btn-sm${u.blocked ? "" : " btn-danger-outline"}`}
                          onClick={() => handleToggleBlocked(u)}
                        >
                          {u.blocked ? "Бұғаттан шығару" : "Бұғаттау"}
                        </button>
                        {WORKER_ROLES.includes(u.role) && (
                          <button
                            type="button"
                            className="btn btn-outline btn-sm"
                            onClick={() => handleToggleHideSalary(u)}
                            title="Айлығым бетін көрсету/жасыру"
                          >
                            {u.hideSalary ? "Айлықты көрсету" : "Айлықты жасыру"}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="panel-card">
        <div className="panel-head">
          <h3>🧑‍🤝‍🧑 Клиенттер</h3>
          <span>{customers.length}</span>
        </div>
        {loadingUsers ? (
          <Spinner />
        ) : customers.length === 0 ? (
          <div className="empty-state">
            <div className="icon">📭</div>
            <p>Тіркелген клиент жоқ</p>
          </div>
        ) : (
          <div className="data-table-wrap">
            <table className="data-table stack-mobile stack-compact">
              <thead>
                <tr>
                  <th>Аты</th>
                  <th>Телефон</th>
                  <th>Email</th>
                  <th>Әрекеттер</th>
                </tr>
              </thead>
              <tbody>
                {customers.map((u) => (
                  <tr key={u.id} className={u.blocked ? "blocked" : undefined}>
                    <td data-label="Аты"><strong>{u.name}</strong></td>
                    <td data-label="Телефон">{formatPhone(u.phone)}</td>
                    <td data-label="Email">{u.email || "—"}</td>
                    <td data-label="Әрекеттер">
                      <button
                        type="button"
                        className={`btn btn-outline btn-sm${u.blocked ? "" : " btn-danger-outline"}`}
                        onClick={() => handleToggleBlocked(u)}
                      >
                        {u.blocked ? "Бұғаттан шығару" : "Бұғаттау"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Toast message={message} visible={visible} />
    </AppShell>
  );
}
