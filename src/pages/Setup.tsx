import { useState, useEffect, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { createUserWithEmailAndPassword } from "firebase/auth";
import {
  doc,
  setDoc,
  collection,
  onSnapshot,
  serverTimestamp,
} from "firebase/firestore";
import { auth, db } from "../firebase";
import { Toast, Spinner } from "../components";
import { useAuth } from "../AuthContext";
import { useToast } from "../hooks";

interface UserRecord {
  name: string;
  email: string;
  role: string;
}

export default function Setup() {
  const { user, userData, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const [userName, setUserName] = useState("");
  const [userEmail, setUserEmail] = useState("");
  const [userPassword, setUserPassword] = useState("");
  const [userRole, setUserRole] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ msg: string; error: boolean } | null>(
    null,
  );
  const [users, setUsers] = useState<UserRecord[]>([]);
  const { message, visible, showToast } = useToast();

  useEffect(() => {
    if (!authLoading) {
      if (!user || !userData || userData.role !== "admin") {
        navigate("/login", { replace: true });
      }
    }
  }, [authLoading, user, userData, navigate]);

  if (authLoading) return <Spinner />;
  if (!user || !userData || userData.role !== "admin") return null;

  useEffect(() => {
    const unsub = onSnapshot(collection(db, "users"), (snap) => {
      const list: UserRecord[] = [];
      snap.forEach((d) => list.push(d.data() as UserRecord));
      setUsers(list);
    });
    return unsub;
  }, []);

  const roleNames: Record<string, string> = {
    admin: "👑 Админ",
    raspil: "🪚 Распил",
    pvh: "🪟 ПВХ",
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!userName.trim() || !userEmail.trim() || !userPassword || !userRole) {
      setResult({ msg: "Барлық өрістерді толтырыңыз", error: true });
      return;
    }
    setSubmitting(true);

    try {
      const cred = await createUserWithEmailAndPassword(
        auth,
        userEmail.trim(),
        userPassword,
      );
      await setDoc(doc(db, "users", cred.user.uid), {
        name: userName.trim(),
        email: userEmail.trim(),
        role: userRole,
        createdAt: serverTimestamp(),
      });
      setResult({
        msg: `✅ ${userName.trim()} (${userRole}) сәтті тіркелді!`,
        error: false,
      });
      showToast("✅ Қолданушы құрылды!");
      setUserName("");
      setUserEmail("");
      setUserPassword("");
      setUserRole("");
      await auth.signOut();
    } catch (err: unknown) {
      const fireErr = err as { code?: string; message?: string };
      let msg = "Қате: " + (fireErr.message || "");
      if (fireErr.code === "auth/email-already-in-use")
        msg = "Бұл email бұрыннан тіркелген";
      else if (fireErr.code === "auth/weak-password")
        msg = "Құпия сөз тым қысқа (мин. 6 таңба)";
      setResult({ msg, error: true });
    }

    setSubmitting(false);
  };

  return (
    <div className="setup-page">
      <div className="setup-card">
        <h1>⚙️ Алғашқы баптау</h1>
        <p>
          Жүйені баптау үшін Firebase-те 3 қолданушы құрып, рөлдерін
          тағайындаңыз
        </p>

        <div className="setup-step">
          <h3>📌 1-қадам: Firebase жобасын құру</h3>
          <p>
            <a
              href="https://console.firebase.google.com"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: "var(--primary)" }}
            >
              Firebase Console
            </a>{" "}
            → Жаңа жоба құру → Authentication → Email/Password қосу → Firestore
            Database құру
          </p>
        </div>

        <div className="setup-step">
          <h3>📌 2-қадам: firebase.ts жаңарту</h3>
          <p>
            Firebase Console → Project Settings → Web App → конфигурацияны{" "}
            <strong>src/firebase.ts</strong> файлына көшіріңіз
          </p>
        </div>

        <div className="setup-step">
          <h3>📌 3-қадам: Қолданушыларды тіркеу</h3>
          <p>Астыңғы формамен 3 қолданушы құрыңыз</p>
        </div>

        <hr
          style={{
            margin: "24px 0",
            border: "none",
            borderTop: "1px solid var(--border)",
          }}
        />

        <h2>👤 Қолданушы құру</h2>
        <form onSubmit={handleSubmit} style={{ marginTop: 16 }}>
          <div className="form-group">
            <label>Аты</label>
            <input
              type="text"
              className="form-input"
              placeholder="Мысалы: Алмас"
              value={userName}
              onChange={(e) => setUserName(e.target.value)}
              required
            />
          </div>
          <div className="form-group">
            <label>Email</label>
            <input
              type="email"
              className="form-input"
              placeholder="admin@ceh.kz"
              value={userEmail}
              onChange={(e) => setUserEmail(e.target.value)}
              required
            />
          </div>
          <div className="form-group">
            <label>Құпия сөз (мин. 6 таңба)</label>
            <input
              type="password"
              className="form-input"
              placeholder="••••••••"
              value={userPassword}
              onChange={(e) => setUserPassword(e.target.value)}
              required
              minLength={6}
            />
          </div>
          <div className="form-group">
            <label>Рөл</label>
            <select
              className="form-input"
              value={userRole}
              onChange={(e) => setUserRole(e.target.value)}
              required
            >
              <option value="">Рөлді таңдаңыз</option>
              <option value="admin">👑 Админ — заказды басқарады</option>
              <option value="raspil">🪚 Распил — распил жұмысшысы</option>
              <option value="pvh">🪟 ПВХ — ПВХ жұмысшысы</option>
            </select>
          </div>
          <button
            type="submit"
            className="btn btn-primary btn-full"
            disabled={submitting}
          >
            {submitting ? "Тіркелуде..." : "Тіркеу"}
          </button>
        </form>

        {result && (
          <div
            className={`setup-result ${result.error ? "error" : "success"}`}
            style={{ display: "block" }}
          >
            {result.msg}
          </div>
        )}

        <div style={{ marginTop: 24 }}>
          <h3>✅ Тіркелген қолданушылар</h3>
          <div style={{ marginTop: 12 }}>
            {users.length === 0 ? (
              <p style={{ color: "var(--text-light)", fontSize: "0.85rem" }}>
                Әлі қолданушы жоқ
              </p>
            ) : (
              users.map((u, i) => (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "10px 12px",
                    background: "#f8fafc",
                    borderRadius: 8,
                    marginBottom: 8,
                  }}
                >
                  <div>
                    <strong>{u.name || "Белгісіз"}</strong>
                    <span
                      style={{
                        color: "var(--text-light)",
                        fontSize: "0.8rem",
                        marginLeft: 8,
                      }}
                    >
                      {u.email || ""}
                    </span>
                  </div>
                  <span style={{ fontSize: "0.8rem", fontWeight: 600 }}>
                    {roleNames[u.role] || u.role}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="nav-links" style={{ marginTop: 24 }}>
          <Link to="/login">🔐 Кіру бетіне</Link>
          <Link to="/track">📦 Заказды бақылау</Link>
        </div>
      </div>

      <Toast message={message} visible={visible} />
    </div>
  );
}
