import { useState, type FormEvent } from "react";
import { useNavigate, Link } from "react-router-dom";
import {
  signInWithEmailAndPassword,
  setPersistence,
  browserLocalPersistence,
  browserSessionPersistence,
  sendPasswordResetEmail,
} from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { auth, db } from "../firebase";
import { Toast, Spinner } from "../components";
import { useAuth } from "../AuthContext";
import { useToast } from "../hooks";
import { normalizePhone, phoneToSyntheticEmail } from "../lib/phone";
import { roleHome } from "../lib/rbac";
import type { UserDoc } from "../types/domain";

export default function Login() {
  const { user, userData, loading } = useAuth();
  const navigate = useNavigate();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [shake, setShake] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);
  const { message, visible, showToast } = useToast();

  if (!loading && user && userData) {
    navigate(roleHome(userData.role), { replace: true });
    return null;
  }

  if (loading) return <Spinner />;

  // Staff sign in with their real email; customers sign in with their phone number, which we map
  // to the deterministic synthetic email used at registration time (src/lib/phone.ts).
  const resolveAuthEmail = (raw: string): string | null => {
    const trimmed = raw.trim();
    if (trimmed.includes("@")) return trimmed;
    const normalized = normalizePhone(trimmed);
    return normalized ? phoneToSyntheticEmail(normalized) : null;
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();

    const authEmail = resolveAuthEmail(identifier);
    if (!authEmail) {
      showToast("Телефон нөмірін дұрыс енгізіңіз (мыс: +7 777 123 45 67)");
      setShake(true);
      setTimeout(() => setShake(false), 400);
      return;
    }

    setSubmitting(true);

    try {
      await setPersistence(
        auth,
        rememberMe ? browserLocalPersistence : browserSessionPersistence,
      );
      const cred = await signInWithEmailAndPassword(auth, authEmail, password);
      const snap = await getDoc(doc(db, "users", cred.user.uid));

      if (!snap.exists()) {
        showToast("Рөл табылмады. Әкімшіге хабарласыңыз.");
        await auth.signOut();
        setSubmitting(false);
        return;
      }

      const data = snap.data() as UserDoc;
      if (data.blocked) {
        showToast("Аккаунт бұғатталған. Әкімшіге хабарласыңыз.");
        await auth.signOut();
        setSubmitting(false);
        return;
      }

      navigate(roleHome(data.role));
    } catch (err: unknown) {
      const fireErr = err as { code?: string };
      let msg = "Қате болды";
      if (
        fireErr.code === "auth/user-not-found" ||
        fireErr.code === "auth/wrong-password" ||
        fireErr.code === "auth/invalid-credential"
      ) {
        msg = "Телефон/email немесе құпия сөз қате";
      } else if (fireErr.code === "auth/too-many-requests") {
        msg = "Тым көп әрекет. Кейінірек қайталаңыз";
      }
      showToast(msg);
      setShake(true);
      setTimeout(() => setShake(false), 400);
      setSubmitting(false);
    }
  };

  const handleForgotPassword = async () => {
    const authEmail = resolveAuthEmail(identifier);
    if (!authEmail || authEmail.endsWith("@customers.workshop.local")) {
      showToast("Құпия сөзді қалпына келтіру үшін email керек. Әкімшіге хабарласыңыз.");
      return;
    }
    try {
      await sendPasswordResetEmail(auth, authEmail);
      showToast("Құпия сөзді қалпына келтіру хаты жіберілді");
    } catch {
      showToast("Хат жіберілмеді. Email-ді тексеріңіз.");
    }
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-logo">
          <div className="icon">🏭</div>
          <h1>Цех Трекер</h1>
          <p>Заказдарды онлайн бақылау жүйесі</p>
        </div>

        <form onSubmit={handleSubmit} className={shake ? "shake" : ""}>
          <div className="form-group">
            <label>Email немесе телефон</label>
            <input
              type="text"
              className="form-input"
              placeholder="email@example.com немесе +7 777 123 4567"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              required
            />
          </div>
          <div className="form-group">
            <label>Құпия сөз</label>
            <input
              type="password"
              className="form-input"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          <label className="remember-me">
            <input
              type="checkbox"
              checked={rememberMe}
              onChange={(e) => setRememberMe(e.target.checked)}
            />
            <span className="remember-check">{rememberMe ? "✓" : ""}</span>
            <span>Мені есте сақта</span>
          </label>

          <button type="submit" className="btn btn-primary btn-full" disabled={submitting}>
            {submitting ? "Кіру..." : "Кіру"}
          </button>
        </form>

        <div className="nav-links">
          <button type="button" className="link-button" onClick={handleForgotPassword}>
            Құпия сөзді ұмыттыңыз ба?
          </button>
          <Link to="/register">📝 Клиент ретінде тіркелу</Link>
        </div>
      </div>

      <Toast message={message} visible={visible} />
    </div>
  );
}
