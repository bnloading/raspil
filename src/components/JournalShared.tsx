import { Fragment, useEffect, useState } from "react";
import { NumberField } from "./NumberField";
import { accountForMethod } from "../lib/cashbox";
import { formatMoney } from "../lib/money";
import { paymentNote } from "../lib/payments";
import { PAYMENT_STATUS_LABELS } from "../lib/statuses";
import type { ProgressStep } from "../lib/journalFilters";
import type { Order, Payment, PaymentMethodDef, PaymentStatus } from "../types/domain";

/*
 * The pieces both order journals are built from — the ЛДСП ledger (ManagerJournal) and the МДФ one
 * (ManagerMdfJournal) — so the two read alike and take money the same way: the same status words,
 * the same three-dot progress, the same payment dialog, the same autosave mark on a row.
 */

/**
 * Spelled out, not abbreviated. "Жарт." saved four characters and cost the column its meaning:
 * the one thing a payment status has to do is say, unmistakably, whether money is still owed.
 *
 * These are the journal's own words, deliberately blunter than PAYMENT_STATUS_LABELS: "Қарыз" is
 * what the shop calls an unpaid row and what the debt ledger is titled, where the shared label
 * says the softer "Төленбеді". The phone card reads from the same map so one order does not
 * describe itself two ways on two screens.
 */
export const JOURNAL_STATUS_LABELS: Partial<Record<PaymentStatus, string>> = {
  paid: "Толық төленді",
  partial: "Жартылай төленді",
  unpaid: "Қарыз",
};

export function journalStatusLabel(status: PaymentStatus): string {
  return JOURNAL_STATUS_LABELS[status] ?? PAYMENT_STATUS_LABELS[status];
}

/**
 * The three-dot progress read-out: money in, sheets cut, order finished.
 *
 * Shared by the ledger row and the phone card so both tell the same story. Each dot carries its
 * own label rather than relying on colour alone — a red and a green circle look identical to a
 * colour-blind reader, and this is the column the shop scans fastest.
 */
export function ProgressSteps({ steps, compact = false }: { steps: ProgressStep[]; compact?: boolean }) {
  return (
    <div className={`jt-steps${compact ? " is-compact" : ""}`}>
      {steps.map((step, i) => (
        <div key={step.key} className={`jt-step is-${step.state}`}>
          {i > 0 && <span className="jt-step-line" aria-hidden="true" />}
          <span className="jt-step-dot" aria-hidden="true">
            {step.state === "done" ? "✓" : step.state === "blocked" ? "!" : ""}
          </span>
          <span className="jt-step-label">{step.label}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * "Төлем тіркеу" — pick the method, confirm the amount.
 *
 * Replaces a window.prompt(): the amount defaults to what the order still owes, so the common case
 * (customer settles in full) is two taps, and the method is picked from the shop's configured list
 * rather than being one of five fixed columns.
 */
export function PaymentDialog({
  order,
  methods,
  payments,
  remainingTiyn,
  initialNote = "",
  onChangeMethod,
  onChangeAmount,
  onClose,
  onSubmit,
}: {
  order: Order;
  methods: PaymentMethodDef[];
  /** What the cash note opens on — the note of the money «Жартылай» just reversed, to keep or retype. */
  initialNote?: string;
  /** Live (non-reversed) payments on this order — each one's method and amount stay editable. */
  payments: Payment[];
  /**
   * What is still outstanding, worked out by the caller from those payments rather than read off
   * the order's own `debtTiyn` — a merged order's stored debt can be a merge behind the money.
   */
  remainingTiyn: number;
  onChangeMethod: (payment: Payment, methodId: string) => Promise<void> | void;
  /** Corrects a mistyped amount — never a reversal, the order's totals are just recomputed. */
  onChangeAmount: (payment: Payment, amountTiyn: number) => Promise<void> | void;
  onClose: () => void;
  /** One call, one or more legs — "Аралас" submits every non-empty leg in a single batch, each a
   *  real method with its own amount (500 нал + 500 Нұр), not one lump "Аралас" figure. `note` is
   *  what was typed for the cash, if any — it goes on the cash legs only. */
  onSubmit: (legs: { methodId: string; amountTiyn: number }[], note: string) => Promise<void> | void;
}) {
  const remaining = remainingTiyn;
  /**
   * Nothing is pre-picked, deliberately.
   *
   * This grid used to open with `methods[0]` highlighted — whichever payment method Firestore
   * happened to return first. Sitting under a list of the order's real payments, that blue
   * selection read as "this order was paid by Бәлім" while the row above it said Нал, and money
   * could be recorded under a method nobody chose. The grid now only ever shows what the person
   * standing here has just picked.
   */
  const [methodId, setMethodId] = useState("");
  const [amountTenge, setAmountTenge] = useState(remaining > 0 ? remaining / 100 : 0);
  // Only used once "Аралас" is picked — each leg is a real method (never "Аралас" itself) plus its
  // own amount. Starts at two rows, matching the shop's actual case ("500 нал, 500 Нұрға кетті").
  const [mixedLegs, setMixedLegs] = useState<{ id: string; methodId: string; amountTenge: number }[]>([
    { id: crypto.randomUUID(), methodId: "", amountTenge: 0 },
    { id: crypto.randomUUID(), methodId: "", amountTenge: 0 },
  ]);
  const [busy, setBusy] = useState(false);
  /**
   * Is the "add new money" half open?
   *
   * Closed whenever the order already has payments on it. This dialog does two jobs that look
   * alike and are not alike: correcting which method money came in by (no money moves) and taking
   * new money (the order's paid total goes up). Reached from the Төлем түрі cell, the first is
   * usually what was meant — so the second has to be asked for, rather than sitting there as the
   * biggest, brightest control on the screen waiting to be pressed by mistake.
   */
  const [adding, setAdding] = useState(payments.length === 0);

  const isMixed = methodId === "mixed";
  const mixedTotalTiyn = mixedLegs.reduce((s, l) => s + Math.round((l.amountTenge || 0) * 100), 0);
  const totalTiyn = isMixed ? mixedTotalTiyn : Math.round(amountTenge * 100);
  const overpaying = adding && totalTiyn > remaining;

  /**
   * Cash asks for a word — "Ерболға берілді", "сейфке салынды". A transfer leaves its own trail in
   * the bank; cash taken at the counter has nothing but what is written here, so the box appears
   * the moment the cash method is picked (or a cash leg of an Аралас split), and stays optional.
   */
  const [note, setNote] = useState(initialNote);
  const isCash = (id: string) => {
    const method = methods.find((m) => m.id === id);
    return !!method && accountForMethod(method) === "cash";
  };
  const wantsNote = isMixed ? mixedLegs.some((l) => isCash(l.methodId)) : isCash(methodId);

  const patchLeg = (id: string, patch: Partial<{ methodId: string; amountTenge: number }>) =>
    setMixedLegs((rows) => rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const addLeg = () => setMixedLegs((rows) => [...rows, { id: crypto.randomUUID(), methodId: "", amountTenge: 0 }]);
  const removeLeg = (id: string) => setMixedLegs((rows) => rows.filter((r) => r.id !== id));

  const submit = async () => {
    setBusy(true);
    const legs = isMixed
      ? mixedLegs.map((l) => ({ methodId: l.methodId, amountTiyn: Math.round((l.amountTenge || 0) * 100) }))
      : [{ methodId, amountTiyn: Math.round(amountTenge * 100) }];
    await onSubmit(legs, wantsNote ? note.trim() : "");
    setBusy(false);
  };

  return (
    <div className="modal-overlay active" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-handle" />
        <h2>{payments.length > 0 ? "💰 Заказдың төлемдері" : "💰 Төлем тіркеу"}</h2>
        <p className="scan-hint">
          {order.orderNumber} · {order.customerName}
          {remaining > 0 ? <> · қалдық <strong>{formatMoney(remaining)}</strong></>
            : remaining < 0 ? <> · артық <strong>{formatMoney(-remaining)}</strong></>
            : payments.length > 0 ? <> · <strong>толық төленген</strong></>
            : null}
        </p>

        {payments.length > 0 && (
          <div className="pay-block">
            <label>Тіркелген төлем</label>
            {payments.map((p) => (
              <Fragment key={p.id}>
                <div className="pay-recorded-row">
                  <RecordedAmountInput payment={p} onChangeAmount={onChangeAmount} />
                  <select
                    className="form-input"
                    value={p.methodId}
                    onChange={(e) => onChangeMethod(p, e.target.value)}
                    aria-label={`${formatMoney(p.amountTiyn)} — қандай әдіспен түскені`}
                  >
                    {/* A method that has since been archived still has to show its own name here,
                        otherwise the row would silently read as some other method. */}
                    {!methods.some((m) => m.id === p.methodId) && (
                      <option value={p.methodId}>{p.methodName}</option>
                    )}
                    {methods.map((m) => (
                      <option key={m.id} value={m.id}>{m.name}</option>
                    ))}
                  </select>
                </div>
                {paymentNote(p) && <p className="pay-note">💬 {paymentNote(p)}</p>}
              </Fragment>
            ))}
            {/* Says outright what each field does, because the consequence is invisible: changing
                the method moves no money, only relabels it — changing the sum DOES recompute the
                order's paid/debt total, it is a correction, not a new payment. */}
            <p className="pay-hint">
              Түрін ауыстырсаңыз ақша қозғалмайды — тек қай әдіспен түскені түзетіледі. Соманы
              өзгертсеңіз — заказдың төленген сомасы қайта есептеледі. Бірден сақталады.
            </p>
          </div>
        )}

        {/* Taking new money is the other job, and it is opt-in when the order already has some. */}
        {!adding ? (
          <button type="button" className="pay-add-toggle" onClick={() => setAdding(true)}>
            ＋ Үстіне жаңа төлем қосу
          </button>
        ) : (
          <div className={payments.length > 0 ? "pay-block is-new" : ""}>
            {payments.length > 0 && <label>Жаңа төлем — заказдың төленгеніне қосылады</label>}

            <div className="form-group">
              <label>{payments.length > 0 ? "Жаңа төлемнің түрі" : "Төлем түрі"}</label>
              {/* Only methods the shop still takes money through. A retired one (active: false)
                  has to keep existing — historical payments are filed under it and the Касса
                  still has to classify them — but offering it here would let it come back. */}
              <div className="pay-method-grid">
                {methods.filter((m) => m.active !== false).map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    className={`pay-method-option${methodId === m.id ? " is-active" : ""}`}
                    onClick={() => setMethodId(m.id)}
                  >
                    {m.name}
                  </button>
                ))}
              </div>
            </div>

            {isMixed ? (
              <div className="form-group">
                <label>Әдіс бойынша сомалар</label>
                {mixedLegs.map((leg) => (
                  <div key={leg.id} className="mdf-panel-row">
                    <select
                      className="form-input"
                      aria-label="Аралас төлем әдісі"
                      value={leg.methodId}
                      onChange={(e) => patchLeg(leg.id, { methodId: e.target.value })}
                    >
                      <option value="">Әдісті таңдаңыз</option>
                      {methods.filter((m) => !m.isMixed && m.active !== false).map((m) => (
                        <option key={m.id} value={m.id}>{m.name}</option>
                      ))}
                    </select>
                    <NumberField
                      value={leg.amountTenge}
                      min={0}
                      onChange={(v) => patchLeg(leg.id, { amountTenge: v })}
                      ariaLabel="Аралас төлем сомасы"
                    />
                    {mixedLegs.length > 2 && (
                      <button type="button" className="btn btn-outline btn-sm" aria-label="Жолды өшіру"
                        onClick={() => removeLeg(leg.id)}>
                        ✕
                      </button>
                    )}
                  </div>
                ))}
                <button type="button" className="btn btn-outline btn-sm" onClick={addLeg}>
                  + Әдіс қосу
                </button>
                <div className="track-card-meta-row">
                  <span>Барлығы</span>
                  <strong>{formatMoney(mixedTotalTiyn)}</strong>
                </div>
              </div>
            ) : (
              <div className="form-group">
                <label>Сома (₸)</label>
                <NumberField value={amountTenge} min={0} onChange={setAmountTenge} ariaLabel="Төлем сомасы" />
              </div>
            )}

            {wantsNote && (
              <div className="form-group">
                <label>Түсініктеме — қолма-қол (міндетті емес)</label>
                <input className="form-input" value={note} onChange={(e) => setNote(e.target.value)}
                  placeholder="Кімге берілді, қайда салынды…" aria-label="Қолма-қол төлемге түсініктеме" />
              </div>
            )}

            {/* The mistake this dialog invites is adding a second payment to a settled order while
                meaning to correct the first one's method. It is allowed — a customer really can
                overpay — but never silently. */}
            {overpaying && (
              <p className="pay-warn">
                ⚠️ Бұл сома қалдықтан {formatMoney(totalTiyn - remaining)} артық.
                Заказ артық төленген болып жазылады.
              </p>
            )}
          </div>
        )}

        <div className="modal-actions">
          {adding ? (
            <>
              <button type="button" className="btn btn-outline"
                onClick={() => (payments.length > 0 ? setAdding(false) : onClose())}>
                Болдырмау
              </button>
              <button type="button" className="btn btn-primary" disabled={busy || !methodId || totalTiyn <= 0}
                onClick={submit}>
                {busy ? "Сақталуда…" : overpaying ? "⚠️ Артық төлем тіркеу" : "✅ Тіркеу"}
              </button>
            </>
          ) : (
            // Method changes above have already been written, so there is nothing here to confirm.
            <button type="button" className="btn btn-primary" onClick={onClose}>Дайын</button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * One recorded payment's amount, editable in place — commits on blur/Enter rather than per
 * keystroke, so typing "18000" fires one correction, not five. Local text so a keystroke never
 * round-trips through Firestore before the field is done being typed into.
 */
function RecordedAmountInput({
  payment,
  onChangeAmount,
}: {
  payment: Payment;
  onChangeAmount: (payment: Payment, amountTiyn: number) => Promise<void> | void;
}) {
  const [text, setText] = useState(String(payment.amountTiyn / 100));

  useEffect(() => setText(String(payment.amountTiyn / 100)), [payment.amountTiyn]);

  const commit = () => {
    const tenge = parseFloat(text.replace(",", "."));
    if (!Number.isFinite(tenge) || tenge <= 0) {
      setText(String(payment.amountTiyn / 100)); // not a usable number — snap back rather than save junk
      return;
    }
    onChangeAmount(payment, Math.round(tenge * 100));
  };

  return (
    <input
      type="number"
      className="form-input pay-recorded-sum"
      min={0}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
      aria-label={`${formatMoney(payment.amountTiyn)} — сомасы`}
    />
  );
}

export type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";

export const SAVE_GLYPHS: Record<SaveState, string> = { idle: "", dirty: "•", saving: "⋯", saved: "✓", error: "!" };
export const SAVE_TITLES: Record<SaveState, string> = {
  idle: "",
  dirty: "Өзгертілді — сақталуда",
  saving: "Сақталуда…",
  saved: "Сақталды",
  error: "Сақталмады — қайта көріңіз",
};

/** How long after the last keystroke the row commits itself. Long enough to type a whole number. */
export const AUTOSAVE_MS = 900;
