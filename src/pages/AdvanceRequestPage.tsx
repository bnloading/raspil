import { useMemo, useState, type FormEvent } from "react";
import { db } from "../firebase";
import { useAuth } from "../AuthContext";
import { Spinner } from "../components";
import { AppShell } from "../components/layout/AppShell";
import { NumberField } from "../components/NumberField";
import { useAdvanceRequests } from "../hooks/useAdvanceRequests";
import { cancelAdvanceRequest, ownRequests, requestAdvance } from "../lib/advanceRequests";
import { cashReceiptErrorText } from "../lib/cashReceiptsWrite";
import { formatDateTimeDMY } from "../lib/dates";
import { formatMoney } from "../lib/money";
import type { AdvanceRequest } from "../types/domain";

const STATUS_TEXT: Record<AdvanceRequest["status"], string> = {
  pending: "Күтілуде",
  approved: "Берілді",
  declined: "Берілмеді",
  cancelled: "Қайтарып алдыңыз",
};

/**
 * «Аванс сұрау» — a worker of either line asks for an advance from their phone (the owner, 09.11).
 * One request waits at a time; the Manager answers it on the Касса page, and «Иә, беремін» is what
 * takes the money out of the Касса and off this worker's pay (lib/advanceRequests.ts).
 */
export default function AdvanceRequestPage() {
  const { user, userData } = useAuth();
  const { requests, loading, error } = useAdvanceRequests({ userId: user?.uid });
  const { pending, history } = useMemo(() => ownRequests(requests), [requests]);
  const [amountTenge, setAmountTenge] = useState(0);
  const [comment, setComment] = useState("");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  if (!user || !userData) return <Spinner />;
  const actor = { user, userData };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const amountTiyn = Math.round(amountTenge * 100);
    if (amountTiyn <= 0) return setStatus("Соманы жазыңыз");
    setSaving(true);
    try {
      await requestAdvance(db, actor, { amountTiyn, comment });
      setStatus(`✅ Жіберілді: ${formatMoney(amountTiyn)} — менеджер жауап бергенде хабарлама келеді`);
      setAmountTenge(0);
      setComment("");
    } catch (err: unknown) {
      setStatus("Жіберілмеді: " + cashReceiptErrorText(err));
    }
    setSaving(false);
  };

  const takeBack = async (r: AdvanceRequest) => {
    if (!confirm(`${formatMoney(r.amountTiyn)} аванс сұрауын қайтарып аласыз ба?`)) return;
    try {
      await cancelAdvanceRequest(db, r);
      setStatus("Сұрау қайтарылды");
    } catch (err: unknown) {
      setStatus("Қайтарылмады: " + cashReceiptErrorText(err));
    }
  };

  return (
    <AppShell title="Аванс сұрау" subtitle={userData.name}>
      <div className="adv-page">
        {error && <p className="adv-note is-warn">Сұраулар оқылмады: {cashReceiptErrorText({ message: error })}</p>}

        {loading ? (
          <Spinner />
        ) : pending ? (
          <section className="panel-card adv-pending" aria-live="polite">
            <span className="adv-badge is-pending">⏳ Менеджердің жауабын күтуде</span>
            <strong className="adv-amount">{formatMoney(pending.amountTiyn)}</strong>
            <span className="adv-meta">
              {pending.createdAt ? formatDateTimeDMY(pending.createdAt) : "жаңа ғана"}
              {pending.comment ? ` · ${pending.comment}` : ""}
            </span>
            <button type="button" className="btn btn-outline" onClick={() => takeBack(pending)}>Сұрауды қайтарып алу</button>
          </section>
        ) : (
          <section className="panel-card adv-ask">
            <h3>Аванс сұрау</h3>
            <p className="adv-lead">
              Соманы жазып жіберіңіз. Менеджер «Иә, беремін» десе, ақша кассадан беріледі және айлығыңыздан
              шегеріледі.
            </p>
            <form onSubmit={submit} className="adv-form">
              <div className="form-group">
                <label>Сома (₸)</label>
                <NumberField value={amountTenge} min={0} onChange={setAmountTenge} ariaLabel="Аванс сомасы" />
              </div>
              <div className="form-group">
                <label htmlFor="adv-note">Ескертпе (міндетті емес)</label>
                <input id="adv-note" className="form-input" value={comment} maxLength={120}
                  onChange={(e) => setComment(e.target.value)} placeholder="Мысалы: үйге керек" />
              </div>
              <button type="submit" className="btn btn-primary btn-full" disabled={saving}>
                {saving ? "Жіберілуде…" : "💵 Сұрау жіберу"}
              </button>
            </form>
          </section>
        )}

        {status && <p className="adv-note" role="status">{status}</p>}

        {history.length > 0 && (
          <section className="panel-card">
            <div className="panel-head"><h3>Бұрынғы сұраулар</h3></div>
            <ul className="adv-list">
              {history.map((r) => (
                <li key={r.id} className={`adv-row is-${r.status}`}>
                  <div className="adv-row-top">
                    <span className={`adv-badge is-${r.status}`}>{STATUS_TEXT[r.status]}</span>
                    <strong>{formatMoney(r.status === "approved" ? r.approvedTiyn ?? r.amountTiyn : r.amountTiyn)}</strong>
                  </div>
                  <div className="adv-meta">
                    {r.createdAt ? formatDateTimeDMY(r.createdAt) : ""}
                    {r.status === "approved" && r.approvedTiyn !== undefined && r.approvedTiyn !== r.amountTiyn
                      ? ` · сұрағаныңыз ${formatMoney(r.amountTiyn)}` : ""}
                    {r.decidedByName ? ` · ${r.decidedByName}` : ""}
                    {r.status === "declined" && r.declineReason ? ` · «${r.declineReason}»` : ""}
                    {r.comment ? ` · 💬 ${r.comment}` : ""}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </AppShell>
  );
}
