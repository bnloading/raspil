import { useState, type FormEvent } from "react";
import { useNavigate, Link } from "react-router-dom";
import {
  signInWithEmailAndPassword,
  setPersistence,
  browserLocalPersistence,
  browserSessionPersistence,
} from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { auth, db } from "../firebase";
import { Toast, Spinner } from "../components";
import { useAuth } from "../AuthContext";
import { useToast } from "../hooks";

export default function Login() {
  const { user, userData, loading } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [shake, setShake] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);
  const { message, visible, showToast } = useToast();

  // Redirect if already logged in
  if (!loading && user && userData) {
    if (userData.role === "admin") {
      navigate("/admin", { replace: true });
    } else {
      navigate("/worker", { replace: true });
    }
    return null;
  }

  if (loading) return <Spinner />;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);

    try {
      await setPersistence(
        auth,
        rememberMe ? browserLocalPersistence : browserSessionPersistence,
      );
      const cred = await signInWithEmailAndPassword(
        auth,
        email.trim(),
        password,
      );
      const snap = await getDoc(doc(db, "users", cred.user.uid));

      if (!snap.exists()) {
        showToast("Рөл табылмады. Setup бетін ашыңыз.");
        await auth.signOut();
        setSubmitting(false);
        return;
      }

      const role = snap.data().role;
      if (role === "admin") {
        navigate("/admin");
      } else {
        navigate("/worker");
      }
    } catch (err: unknown) {
      const fireErr = err as { code?: string };
      let msg = "Қате болды";
      if (
        fireErr.code === "auth/user-not-found" ||
        fireErr.code === "auth/wrong-password" ||
        fireErr.code === "auth/invalid-credential"
      ) {
        msg = "Email немесе құпия сөз қате";
      } else if (fireErr.code === "auth/too-many-requests") {
        msg = "Тым көп әрекет. Кейінірек қайталаңыз";
      }
      showToast(msg);
      setShake(true);
      setTimeout(() => setShake(false), 400);
      setSubmitting(false);
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
            <label>Email</label>
            <input
              type="email"
              className="form-input"
              placeholder="email@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
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

          <button
            type="submit"
            className="btn btn-primary btn-full"
            disabled={submitting}
          >
            {submitting ? "Кіру..." : "Кіру"}
          </button>
        </form>

        <div className="nav-links">
          <Link to="/">📦 Заказды бақылау</Link>
        </div>
      </div>

      <Toast message={message} visible={visible} />
    </div>
  );
}
