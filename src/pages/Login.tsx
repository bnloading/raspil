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
import moderaLogo from "../assets/modera-logo.png";

export default function Login() {
  const { user, userData, loading } = useAuth();
  const navigate = useNavigate();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [shake, setShake] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
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
        // Customers who registered with an email sign in with that email, not their number, so a
        // failed phone attempt is most often the wrong identifier rather than the wrong password.
        msg = identifier.includes("@")
          ? "Email немесе құпия сөз қате"
          : "Телефон немесе құпия сөз қате. Тіркелгенде email жазған болсаңыз, сол email арқылы кіріңіз.";
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
      <div className="login-shell">
        {/* Brand panel — desktop only. On a phone it would push the form below the fold, which is
            the one thing this page must never do. */}
        <aside className="login-brand">
          {/* One asset for both panels: the mark is black, and the CSS inverts it here rather
              than the repo carrying a second, white copy to keep in step with the first. */}
          <img src={moderaLogo} alt="MODERA Interior Objects" className="brand-logo is-inverted" />
          <h2>Цех Трекер</h2>
          <p className="login-brand-lead">
            Жиһаз цехының заказдарын қабылдаудан клиентке тапсырғанға дейін бір жерден бақылаңыз.
          </p>
          <ul className="login-brand-list">
            <li><span>📐</span> Размерді онлайн жіберу</li>
            <li><span>🪚</span> Распил және ПВХ кезегі</li>
            <li><span>💰</span> Төлем, қарыз және есеп</li>
            <li><span>📊</span> Айлық пайда мен жалақы</li>
          </ul>
        </aside>

        <div className="login-card">
          <div className="login-logo">
            <img src={moderaLogo} alt="MODERA Interior Objects" className="brand-logo" />
            <h1>Қош келдіңіз</h1>
            <p>Аккаунтыңызға кіріңіз</p>
          </div>

          <form onSubmit={handleSubmit} className={shake ? "shake" : ""}>
            <div className="form-group">
              <label>Email немесе телефон</label>
              <input
                type="text"
                className="form-input"
                placeholder="email@example.com немесе +7 777 123 4567"
                autoComplete="username"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                required
              />
            </div>
            <div className="form-group">
              <label>Құпия сөз</label>
              {/* A reveal toggle, because a mistyped password on a phone keyboard is otherwise
                  invisible and reads to the user as "the site won't let me in". */}
              <div className="input-with-affix">
                <input
                  type={showPassword ? "text" : "password"}
                  className="form-input"
                  placeholder="••••••••"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
                <button
                  type="button"
                  className="input-affix-btn"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? "Құпия сөзді жасыру" : "Құпия сөзді көрсету"}
                >
                  {showPassword ? "🙈" : "👁"}
                </button>
              </div>
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
      </div>

      <Toast message={message} visible={visible} />
    </div>
  );
}
