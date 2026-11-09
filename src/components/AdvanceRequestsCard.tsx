import { useMemo, useState } from "react";
import { db } from "../firebase";
import { useAuth } from "../AuthContext";
import { NumberField } from "./NumberField";
import { useAdvanceRequests } from "../hooks/useAdvanceRequests";
import { useCashAccountLabels } from "../hooks/useCashAccountLabels";
import { approveAdvanceRequest, declineAdvanceRequest, pendingForLine } from "../lib/advanceRequests";
import { cashReceiptErrorText } from "../lib/cashReceiptsWrite";
import { CASH_ACCOUNTS } from "../lib/cashbox";
import { formatDateTimeDMY } from "../lib/dates";
import { formatMoney } from "../lib/money";
import { ROLE_LABELS } from "../lib/rbac";
import type { AdvanceRequest, CashAccount, Department } from "../types/domain";

/**
 * «Аванс сұраулары» on the Касса page — the workers of this line who asked for an advance from
 * their phone (the owner, 09.11). «Иә, беремін» writes it as the Касса's own «<аты> — аванс»
 * expense and takes it off their pay, in one go (lib/advanceRequests.ts); «Жоқ» moves nothing.
 * Shown only while something waits.
 */
export function AdvanceRequestsCard({ department, onToast }: { department: Department; onToast: (msg: string) => void }) {
  const { requests, error } = useAdvanceRequests({ pending: true });
  const waiting = useMemo(() => pendingForLine(requests, department), [requests, department]);
  if (error) return <p className="adv-note is-warn">Аванс сұраулары оқылмады: {cashReceiptErrorText({ message: error })}</p>;
  if (waiting.length === 0) return null;
  return (
    <section className="panel-card adv-card" aria-labelledby="adv-card-title">
      <div className="panel-head">
        <h3 id="adv-card-title">💵 Аванс сұраулары · {waiting.length}</h3>
      </div>
      <ul className="adv-list">
        {waiting.map((r) => <AdvanceRequestRow key={r.id} request={r} onToast={onToast} />)}
      </ul>
    </section>
  );
}

function AdvanceRequestRow({ request, onToast }: { request: AdvanceRequest; onToast: (msg: string) => void }) {
  const { user, userData } = useAuth();
  const { labels: accountLabels } = useCashAccountLabels();
  const [amountTenge, setAmountTenge] = useState(request.amountTiyn / 100);
  const [account, setAccount] = useState<CashAccount>("cash");
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  if (!user || !userData) return null;
  const actor = { user, userData };

  const approve = async () => {
    const amountTiyn = Math.round(amountTenge * 100);
    if (amountTiyn <= 0) return onToast("Соманы жазыңыз");
    if (!confirm(`${request.userName}: ${formatMoney(amountTiyn)} аванс беріледі (${accountLabels[account]}). Растайсыз ба?`)) return;
    setBusy(true);
    try {
      await approveAdvanceRequest(db, actor, request, { amountTiyn, account });
      onToast(`✅ ${request.userName} — ${formatMoney(amountTiyn)} аванс берілді, кассадан шығын болып жазылды`);
    } catch (err: unknown) {
      onToast("Берілмеді: " + cashReceiptErrorText(err));
      setBusy(false);
    }
  };

  const decline = async () => {
    setBusy(true);
    try {
      await declineAdvanceRequest(db, actor, request, reason);
      onToast(`${request.userName}: аванс берілмеді`);
    } catch (err: unknown) {
      onToast("Қате: " + cashReceiptErrorText(err));
      setBusy(false);
    }
  };

  return (
    <li className="adv-row is-pending">
      <div className="adv-row-top">
        <span className="adv-who">
          {request.userName}
          <small> · {ROLE_LABELS[request.role] ?? request.role}</small>
        </span>
        <strong>{formatMoney(request.amountTiyn)}</strong>
      </div>
      <div className="adv-meta">
        {request.createdAt ? formatDateTimeDMY(request.createdAt) : "жаңа ғана"}
        {request.comment ? ` · 💬 ${request.comment}` : ""}
      </div>
      {declining ? (
        <div className="adv-decide">
          <input className="form-input" value={reason} maxLength={120} placeholder="Себебі (міндетті емес)"
            aria-label="Бас тарту себебі" onChange={(e) => setReason(e.target.value)} />
          <div className="adv-actions">
            <button type="button" className="btn btn-outline" disabled={busy} onClick={() => setDeclining(false)}>Артқа</button>
            <button type="button" className="btn btn-danger" disabled={busy} onClick={decline}>Жоқ, бермеймін</button>
          </div>
        </div>
      ) : (
        <div className="adv-decide">
          <div className="adv-fields">
            <label>
              <span>Беретін сома</span>
              <NumberField value={amountTenge} min={0} onChange={setAmountTenge} ariaLabel="Беретін сома" />
            </label>
            <label>
              <span>Қайдан</span>
              <select className="form-input" value={account} onChange={(e) => setAccount(e.target.value as CashAccount)}>
                {CASH_ACCOUNTS.map((a) => <option key={a} value={a}>{accountLabels[a]}</option>)}
              </select>
            </label>
          </div>
          <div className="adv-actions">
            <button type="button" className="btn btn-outline" disabled={busy} onClick={() => setDeclining(true)}>Жоқ</button>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={approve}>
              {busy ? "Жазылуда…" : "✓ Иә, беремін"}
            </button>
          </div>
        </div>
      )}
    </li>
  );
}
