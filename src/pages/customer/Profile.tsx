import { useState, type FormEvent } from "react";
import { doc, updateDoc } from "firebase/firestore";
import { updatePassword } from "firebase/auth";
import { db } from "../../firebase";
import { useAuth } from "../../AuthContext";
import { Spinner, Toast } from "../../components";
import { AppShell } from "../../components/layout/AppShell";
import { PhoneInput } from "../../components/PhoneInput";
import { useToast } from "../../hooks";
import { normalizePhone } from "../../lib/phone";

export default function Profile() {
  const { user, userData } = useAuth();
  const { message, visible, showToast } = useToast();
  const [name, setName] = useState(userData?.name ?? "");
  const [phone, setPhone] = useState(userData?.phone ?? "");
  const [email, setEmail] = useState(userData?.email ?? "");
  const [newPassword, setNewPassword] = useState("");
  const [savingProfile, setSavingProfile] = useState(false);
  const [savingPassword, setSavingPassword] = useState(false);

  if (!user || !userData) return <Spinner />;

  const handleSaveProfile = async (e: FormEvent) => {
    e.preventDefault();
    const normalized = normalizePhone(phone);
    if (!name.trim() || !normalized) {
      showToast("Атыңыз бен телефоныңызды дұрыс толтырыңыз");
      return;
    }
    setSavingProfile(true);
    try {
      await updateDoc(doc(db, "users", user.uid), {
        name: name.trim(),
        phone: normalized,
        email: email.trim() || null,
      });
      showToast("✅ Профиль жаңартылды");
    } catch (err: unknown) {
      showToast("Қате: " + (err as Error).message);
    }
    setSavingProfile(false);
  };

  const handleChangePassword = async (e: FormEvent) => {
    e.preventDefault();
    if (newPassword.length < 6) {
      showToast("Құпия сөз кемінде 6 таңба болуы керек");
      return;
    }
    setSavingPassword(true);
    try {
      await updatePassword(user, newPassword);
      showToast("✅ Құпия сөз өзгертілді");
      setNewPassword("");
    } catch {
      showToast("Қате: қайта кіріп көріңіз, содан кейін қайталаңыз");
    }
    setSavingPassword(false);
  };

  return (
    <AppShell title="Профиль">
      <div className="profile-panels">
        <div className="panel-card">
          <div className="panel-head">
            <h3>Профиль мәліметтері</h3>
          </div>
          <form onSubmit={handleSaveProfile} className="form-grid">
            <div className="form-group">
              <label>Атыңыз</label>
              <input className="form-input" value={name} onChange={(e) => setName(e.target.value)} required />
            </div>
            <div className="form-group">
              <label>Телефон</label>
              <PhoneInput value={phone} onChange={setPhone} required />
            </div>
            <div className="form-group span-2">
              <label>Email (міндетті емес)</label>
              <input type="email" className="form-input" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <button type="submit" className="btn btn-primary btn-full span-2" disabled={savingProfile}>
              Сақтау
            </button>
          </form>
        </div>

        <div className="panel-card">
          <div className="panel-head">
            <h3>Құпия сөзді өзгерту</h3>
          </div>
          <form onSubmit={handleChangePassword} className="form-grid">
            <div className="form-group span-2">
              <label>Жаңа құпия сөз</label>
              <input
                type="password"
                className="form-input"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                minLength={6}
                required
              />
            </div>
            <button type="submit" className="btn btn-outline btn-full span-2" disabled={savingPassword}>
              Өзгерту
            </button>
          </form>
        </div>
      </div>

      <Toast message={message} visible={visible} />
    </AppShell>
  );
}
