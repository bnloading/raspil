import { useState, type FormEvent } from "react";
import { useNavigate, Link } from "react-router-dom";
import { createUserWithEmailAndPassword } from "firebase/auth";
import { doc, setDoc, serverTimestamp } from "firebase/firestore";
import { auth, db } from "../firebase";
import { Toast, Spinner } from "../components";
import { PhoneInput } from "../components/PhoneInput";
import { useAuth } from "../AuthContext";
import { useToast } from "../hooks";
import { normalizePhone, phoneToSyntheticEmail } from "../lib/phone";
import { roleHome } from "../lib/rbac";

export default function Register() {
  const { user, userData, loading } = useAuth();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const { message, visible, showToast } = useToast();

  if (!loading && user && userData) {
    navigate(roleHome(userData.role), { replace: true });
    return null;
  }
  if (loading) return <Spinner />;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const normalized = normalizePhone(phone);
    if (!name.trim()) {
      showToast("Атыңызды енгізіңіз");
      return;
    }
    if (!normalized) {
      showToast("Телефон нөмірін дұрыс енгізіңіз");
      return;
    }
    if (password.length < 6) {
      showToast("Құпия сөз кемінде 6 таңба болуы керек");
      return;
    }
    if (password !== confirm) {
      showToast("Құпия сөздер сәйкес келмейді");
      return;
    }

    setSubmitting(true);
    try {
      const synthEmail = phoneToSyntheticEmail(normalized);
      const cred = await createUserWithEmailAndPassword(auth, synthEmail, password);
      await setDoc(doc(db, "users", cred.user.uid), {
        name: name.trim(),
        phone: normalized,
        email: email.trim() || null,
        authEmail: synthEmail,
        role: "customer",
        blocked: false,
        createdAt: serverTimestamp(),
      });
      navigate("/dashboard", { replace: true });
    } catch (err: unknown) {
      const fireErr = err as { code?: string };
      let msg = "Тіркелу кезінде қате шықты";
      if (fireErr.code === "auth/email-already-in-use") {
        msg = "Бұл телефон нөмірі бұрыннан тіркелген";
      } else if (fireErr.code === "auth/weak-password") {
        msg = "Құпия сөз тым қысқа (мин. 6 таңба)";
      }
      showToast(msg);
      setSubmitting(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-logo">
          <div className="icon">🏭</div>
          <h1>Цех Трекер</h1>
          <p>Клиент ретінде тіркелу</p>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>Атыңыз</label>
            <input
              type="text"
              className="form-input"
              placeholder="Мысалы: Алмас"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>
          <div className="form-group">
            <label>Телефон нөмірі</label>
            <PhoneInput value={phone} onChange={setPhone} required />
            {/* Sign-in is by phone, so registration mints a synthetic auth address from the number
                (see lib/phone.ts). People who also enter a real email were reading that synthetic
                address in the Firebase console as "my email was changed" — saying so up front. */}
            <p className="form-hint">
              Сайтқа осы нөмір арқылы кіресіз. Жүйе оны ішкі мекенжайға айналдырады
              («…@customers.workshop.local») — бұл қалыпты жағдай, сіздің email-іңіз өзгермейді.
            </p>
          </div>
          <div className="form-group">
            <label>Email (міндетті емес, құпия сөзді қалпына келтіру үшін)</label>
            <input
              type="email"
              className="form-input"
              placeholder="email@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="form-group">
            <label>Құпия сөз</label>
            <input
              type="password"
              className="form-input"
              placeholder="кемінде 6 таңба"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={6}
            />
          </div>
          <div className="form-group">
            <label>Құпия сөзді қайталаңыз</label>
            <input
              type="password"
              className="form-input"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
              minLength={6}
            />
          </div>
          <button type="submit" className="btn btn-primary btn-full" disabled={submitting}>
            {submitting ? "Тіркелуде..." : "Тіркелу"}
          </button>
        </form>

        <div className="nav-links">
          <Link to="/login">🔐 Кіру бетіне</Link>
        </div>
      </div>

      <Toast message={message} visible={visible} />
    </div>
  );
}
