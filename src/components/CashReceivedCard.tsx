import { useMemo, useState, type FormEvent } from "react";
import { db } from "../firebase";
import { useAuth } from "../AuthContext";
import { useCashReceipts } from "../hooks/useCashReceipts";
import { useExpenses } from "../hooks/useExpenses";
import { CustomerNameInput } from "./CustomerNameInput";
import { NumberField } from "./NumberField";
import { customerDirectory } from "../lib/customerSuggest";
import {
  checkCashReceipts, journalCash, kassaObnal, nearbyCash, nearbyObnal, LOOKBACK_DAYS, OBNAL_DAYS,
  type JournalCash, type KassaObnal, type ReceiptCheck,
} from "../lib/cashReceipts";
import { addCashReceipt, cashReceiptErrorText, deleteCashReceipt } from "../lib/cashReceiptsWrite";
import { formatMoney } from "../lib/money";
import { dayKey, formatDateDMY } from "../lib/dates";
import type { CashReceipt, CashReceiptKind, Department, Order, Payment, PaymentMethodDef } from "../types/domain";

/** How many days the list opens on; older entries are one tap away. */
const DAYS_SHOWN = 30;
const NO_OBNAL: readonly KassaObnal[] = [];

/** "ORD-2026-000558" → "558". */
function shortNumber(orderNumber: string): string {
  return orderNumber.match(/(\d+)$/)?.[1]?.replace(/^0+/, "") ?? orderNumber;
}

/** "2026-11-03" → "03.11.2026", read on the Almaty calendar day it names. */
function dayLabel(day: string): string {
  return formatDateDMY(new Date(`${day}T12:00:00+05:00`));
}

function numbers(list: readonly JournalCash[]): string {
  return [...new Set(list.map((j) => `№${shortNumber(j.orderNumber)}`))].join(", ");
}

/** An entry's heading: the customer, or «Обнал · Ақжол». */
function entryTitle(r: Pick<CashReceipt, "kind" | "customerName">): string {
  if (r.kind !== "obnal") return r.customerName;
  return r.customerName.trim() ? `Обнал · ${r.customerName.trim()}` : "Обнал";
}

/** What the form writes — the writer, the line and the time are added by the caller. */
export interface CashReceiptDraft {
  kind: CashReceiptKind;
  customerName: string;
  customerPhone: string;
  amountTiyn: number;
  date: string;
  comment: string;
}

/**
 * «Нал ақша алдым» — the Admin's own note of the cash he took in hand, on the phone home, and
 * what the journal says about each one (the owner, 06.11: «Ербол алған ақшасын жазып отырады, ол
 * Журналмен сәйкеседі клиенттің атымен»). This half reads and writes Firestore; CashReceivedView
 * draws it.
 */
export function CashReceivedCard({
  orders,
  payments,
  methods,
  department,
}: {
  /** This line's orders (lib/rbac.ts departmentOfOrder) — the journal the entries are checked against. */
  orders: readonly Order[];
  /** Their payments. */
  payments: readonly Payment[];
  methods: readonly PaymentMethodDef[];
  department: Department;
}) {
  const { user, userData } = useAuth();
  const { receipts: allReceipts, loading, error } = useCashReceipts();
  // Касса's «Обнал» expenses, which an обнал entry is checked against (the owner, 07.11).
  const { expenses } = useExpenses();
  const obnal = useMemo(() => kassaObnal(expenses, department), [expenses, department]);
  const receipts = useMemo(
    () => allReceipts.filter((r) => (r.department ?? "ldsp") === department),
    [allReceipts, department],
  );
  const actor = user && userData ? { user, userData } : null;
  return (
    <CashReceivedView
      orders={orders}
      payments={payments}
      methods={methods}
      obnal={obnal}
      receipts={receipts}
      loading={loading}
      error={error}
      myUid={user?.uid ?? null}
      onAdd={actor ? (d) => addCashReceipt(db, actor, { ...d, department }).then(() => undefined) : null}
      onDelete={actor ? (r) => deleteCashReceipt(db, actor, r) : null}
    />
  );
}

/**
 * The card itself. The form takes who it came from, the sum and the day; under every entry is the
 * record's answer — for a customer the journal's cash payment it matches, for обнал Касса's
 * «Обнал» expense; a different sum, or nothing at all. Below the entries is the other direction:
 * cash the journal took, and обнал Касса booked, since the first entry that nobody has written
 * down here. Nothing on this card moves money (lib/cashReceipts.ts).
 */
export function CashReceivedView({
  orders,
  payments,
  methods,
  obnal = NO_OBNAL,
  receipts,
  loading,
  error,
  myUid,
  onAdd,
  onDelete,
}: {
  orders: readonly Order[];
  payments: readonly Payment[];
  methods: readonly PaymentMethodDef[];
  /** This line's «Обнал» expenses on Касса (lib/cashReceipts.ts kassaObnal). */
  obnal?: readonly KassaObnal[];
  /** This line's entries. */
  receipts: readonly CashReceipt[];
  loading: boolean;
  error: string | null;
  /** Entries written by this account can be deleted here. */
  myUid: string | null;
  /** Null until the signed-in account is known. */
  onAdd: ((draft: CashReceiptDraft) => Promise<void>) | null;
  onDelete: ((receipt: CashReceipt) => Promise<void>) | null;
}) {
  const cash = useMemo(() => journalCash({ payments, orders, methods }), [payments, orders, methods]);
  const { checks, unclaimed, unclaimedObnal } = useMemo(() => checkCashReceipts(receipts, cash, obnal), [receipts, cash, obnal]);
  const directory = useMemo(() => customerDirectory(orders), [orders]);

  const today = dayKey(new Date());
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<CashReceiptKind>("customer");
  const isObnal = kind === "obnal";
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [amountTenge, setAmountTenge] = useState(0);
  const [date, setDate] = useState(today);
  const [comment, setComment] = useState("");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  // The journal's cash for the customer being typed that no entry has matched yet — shown under
  // the name, and a tap fills the sum, so the common case is "pick the name, tap the sum".
  const matched = useMemo(
    () => new Set(checks.filter((c) => c.status === "ok").flatMap((c) => c.payments.map((j) => j.paymentId))),
    [checks],
  );
  const hint = useMemo(
    () => (!isObnal && name.trim() ? nearbyCash({ customerName: name, customerPhone: phone, date: date || today }, cash, matched).slice(0, 4) : []),
    [isObnal, name, phone, date, today, cash, matched],
  );
  // The same for обнал: Касса's «Обнал» around the day that no entry took — the same hand first.
  const matchedObnal = useMemo(
    () => new Set(checks.filter((c) => c.status === "ok").flatMap((c) => c.obnal.map((k) => k.expenseId))),
    [checks],
  );
  const obnalHint = useMemo(
    () => (isObnal ? nearbyObnal({ customerName: name, date: date || today }, obnal, matchedObnal).slice(0, 4) : []),
    [isObnal, name, date, today, obnal, matchedObnal],
  );

  const since = new Date(Date.parse(`${today}T00:00:00Z`) - DAYS_SHOWN * 86_400_000).toISOString().slice(0, 10);
  const recent = checks.filter((c) => c.receipt.date >= since);
  const shown = showAll ? checks : recent;
  const recentTiyn = recent.reduce((s, c) => s + c.receipt.amountTiyn, 0);
  const obnalTiyn = recent.filter((c) => c.receipt.kind === "obnal").reduce((s, c) => s + c.receipt.amountTiyn, 0);
  const unclaimedObnalTiyn = unclaimedObnal.reduce((s, k) => s + k.amountTiyn, 0);
  const toCheck = recent.filter((c) => c.status === "diff" || c.status === "none").length;
  const unclaimedTiyn = unclaimed.reduce((s, j) => s + j.amountTiyn, 0);

  const reset = () => {
    setKind("customer");
    setName("");
    setPhone("");
    setAmountTenge(0);
    setDate(today);
    setComment("");
  };

  const startFrom = (j: JournalCash) => {
    setKind("customer");
    setName(j.customerName);
    setPhone(j.customerPhone);
    setAmountTenge(j.amountTiyn / 100);
    setDate(today);
    setComment("");
    setStatus(null);
    setOpen(true);
    // The form sits above the list this was tapped in — bring it into view.
    requestAnimationFrame(() => document.getElementById("aps-recv-form")?.scrollIntoView({ block: "start", behavior: "smooth" }));
  };

  // Обнал changes hands when the transfer is made, so the entry takes Касса's day, not today's.
  const startFromObnal = (k: KassaObnal) => {
    setKind("obnal");
    setName(k.who);
    setPhone("");
    setAmountTenge(k.amountTiyn / 100);
    setDate(k.day > today ? today : k.day);
    setComment("");
    setStatus(null);
    setOpen(true);
    requestAnimationFrame(() => document.getElementById("aps-recv-form")?.scrollIntoView({ block: "start", behavior: "smooth" }));
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!onAdd) return;
    const amountTiyn = Math.round(amountTenge * 100);
    if (!isObnal && !name.trim()) return setStatus("Клиенттің атын жазыңыз");
    if (amountTiyn <= 0) return setStatus("Соманы жазыңыз");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > today) return setStatus("Күнін тексеріңіз");
    setSaving(true);
    try {
      await onAdd({ kind, customerName: name, customerPhone: isObnal ? "" : phone, amountTiyn, date, comment });
      setStatus(`✅ Жазылды: ${entryTitle({ kind, customerName: name })} — ${formatMoney(amountTiyn)}`);
      reset();
      setOpen(false);
    } catch (err: unknown) {
      setStatus("Сақталмады: " + cashReceiptErrorText(err));
    }
    setSaving(false);
  };

  const remove = async (c: ReceiptCheck) => {
    if (!onDelete) return;
    try {
      await onDelete(c.receipt);
      setStatus(`Өшірілді: ${entryTitle(c.receipt)} — ${formatMoney(c.receipt.amountTiyn)}`);
    } catch (err: unknown) {
      setStatus("Өшірілмеді: " + cashReceiptErrorText(err));
    }
    setConfirmId(null);
  };

  return (
    <section className="aps-card aps-recv" aria-labelledby="aps-recv-title">
      <div className="aps-head">
        <h2 id="aps-recv-title">Нал ақша алдым</h2>
        <span>{DAYS_SHOWN} күн</span>
      </div>
      <p className="aps-recv-lead">
        Алған налыңызды клиентімен жазыңыз — журналдағы сол клиенттің нал төлемімен салыстырылады.
        Обналды «Обнал» деп белгілеңіз — ол Кассадағы «Обнал» шығынымен салыстырылады. Кассаға екінші
        рет қосылмайды.
      </p>

      {error && (
        <p className="aps-note is-warn">Жазбалар оқылмады: {error}</p>
      )}

      {open ? (
        <form id="aps-recv-form" className="aps-recv-form" onSubmit={submit}>
          {/* Обнал is cash for a transfer someone cashed out — no customer paid it, so it is
              checked against Касса's «Обнал» expense, not the journal (the owner, 07.11). */}
          <div className="aps-recv-kind" role="radiogroup" aria-label="Нал қайдан келді">
            <button type="button" role="radio" aria-checked={!isObnal} className={!isObnal ? "is-active" : ""}
              onClick={() => setKind("customer")}>
              Клиенттен
            </button>
            <button type="button" role="radio" aria-checked={isObnal} className={isObnal ? "is-active" : ""}
              onClick={() => { setKind("obnal"); setPhone(""); }}>
              Обнал
            </button>
          </div>
          {isObnal ? (
            <>
              <div className="form-group">
                <label htmlFor="aps-recv-who">Кім берді (міндетті емес)</label>
                <input id="aps-recv-who" className="form-input" value={name} maxLength={60}
                  onChange={(e) => setName(e.target.value)} placeholder="Мысалы: Ақжол" />
              </div>
              {obnalHint.length > 0 ? (
                <div className="aps-recv-hint" aria-label="Кассадағы обнал">
                  <span>Кассада:</span>
                  {obnalHint.map((k) => (
                    <button key={k.expenseId} type="button" className="aps-recv-chip"
                      onClick={() => {
                        setAmountTenge(k.amountTiyn / 100);
                        if (!name.trim() && k.who) setName(k.who);
                      }}>
                      {k.who || "Обнал"} · {formatMoney(k.amountTiyn)} · {dayLabel(k.day).slice(0, 5)}
                    </button>
                  ))}
                </div>
              ) : (
                <p className="aps-recv-hint is-empty">Кассада {OBNAL_DAYS} күн ішінде «Обнал» жазылмаған</p>
              )}
            </>
          ) : (
            <div className="form-group">
              <label>Кімнен (клиент)</label>
              <CustomerNameInput
                value={name}
                directory={directory}
                placeholder="Журналдағы аты"
                ariaLabel="Клиенттің аты"
                onChange={(v) => {
                  setName(v);
                  setPhone("");
                }}
                onPick={(c) => {
                  setName(c.name);
                  setPhone(c.phone);
                }}
              />
            </div>
          )}
          {hint.length > 0 && (
            <div className="aps-recv-hint" aria-label="Журналдағы нал">
              <span>Журналда:</span>
              {hint.map((j) => (
                <button key={j.paymentId} type="button" className="aps-recv-chip"
                  onClick={() => setAmountTenge(j.amountTiyn / 100)}>
                  №{shortNumber(j.orderNumber)} · {formatMoney(j.amountTiyn)} · {dayLabel(j.day).slice(0, 5)}
                </button>
              ))}
            </div>
          )}
          {!isObnal && name.trim() && hint.length === 0 && (
            <p className="aps-recv-hint is-empty">Журналда бұл клиенттің {LOOKBACK_DAYS} күндегі налы жоқ</p>
          )}
          <div className="aps-recv-pair">
            <div className="form-group">
              <label>Сома (₸)</label>
              <NumberField value={amountTenge} min={0} onChange={setAmountTenge} ariaLabel="Алған сома" />
            </div>
            <div className="form-group">
              <label htmlFor="aps-recv-date">Күні</label>
              <input id="aps-recv-date" type="date" className="form-input" value={date} max={today}
                onChange={(e) => setDate(e.target.value)} />
            </div>
          </div>
          <div className="form-group">
            <label htmlFor="aps-recv-note">Ескертпе (міндетті емес)</label>
            <input id="aps-recv-note" className="form-input" value={comment} maxLength={120}
              onChange={(e) => setComment(e.target.value)} placeholder="Мысалы: кассадан алдым" />
          </div>
          <div className="aps-recv-actions">
            <button type="button" className="btn btn-outline" onClick={() => { setOpen(false); reset(); }}>
              Болдырмау
            </button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? "Сақталуда…" : "💵 Жазу"}
            </button>
          </div>
        </form>
      ) : (
        <button type="button" className="btn btn-primary btn-full" onClick={() => { setOpen(true); setStatus(null); }}>
          💵 Нал ақша алдым
        </button>
      )}

      {status && <p className="aps-recv-status" role="status">{status}</p>}

      {!loading && recent.length > 0 && (
        <p className="aps-recv-sum">
          {recent.length} жазба · <b>{formatMoney(recentTiyn)}</b>
          {obnalTiyn > 0 && <> · оның обнал <b>{formatMoney(obnalTiyn)}</b></>}
          {toCheck > 0 ? <> · <span className="is-warn">{toCheck} тексеру керек</span></> : <> · ✓ бәрі сәйкес</>}
        </p>
      )}

      {shown.length > 0 && (
        <ul className="aps-recv-list">
          {shown.map((c) => (
            <li key={c.receipt.id} className={`aps-recv-row is-${c.status}`}>
              <div className="aps-recv-top">
                <span className="aps-recv-name">{entryTitle(c.receipt)}</span>
                <strong>{formatMoney(c.receipt.amountTiyn)}</strong>
              </div>
              <div className="aps-recv-meta">
                {dayLabel(c.receipt.date)} · {c.receipt.createdByName}
                {c.receipt.comment ? <> · 💬 {c.receipt.comment}</> : null}
              </div>
              <div className="aps-recv-check">
                {c.receipt.kind === "obnal"
                  ? c.status === "ok"
                    ? <>✓ Кассамен сәйкес · «{c.obnal[0].label}», {dayLabel(c.obnal[0].day).slice(0, 5)}</>
                    : c.status === "diff"
                      ? <>≠ Кассада {formatMoney(c.recordTiyn)} («{c.obnal[0].label}», {dayLabel(c.obnal[0].day).slice(0, 5)}) · айырма {formatMoney(Math.abs(c.receipt.amountTiyn - c.recordTiyn))}</>
                      : <>Кассада бұл обнал жазылмаған</>
                  : c.status === "ok"
                  ? <>✓ Журналмен сәйкес · {numbers(c.payments)}{c.payments.length === 1 ? `, ${dayLabel(c.payments[0].day).slice(0, 5)}` : ""}</>
                  : c.status === "diff"
                    ? <>≠ Журналда {formatMoney(c.recordTiyn)} ({numbers(c.payments)}) · айырма {formatMoney(Math.abs(c.receipt.amountTiyn - c.recordTiyn))}</>
                    : <>Журналда бұл клиенттің налы жоқ</>}
              </div>
              {myUid && c.receipt.createdByUid === myUid && onDelete && (
                confirmId === c.receipt.id ? (
                  <div className="aps-recv-confirm">
                    <span>Өшіресіз бе?</span>
                    <button type="button" className="btn btn-outline btn-sm" onClick={() => setConfirmId(null)}>Жоқ</button>
                    <button type="button" className="btn btn-danger btn-sm" onClick={() => remove(c)}>Иә, өшіру</button>
                  </div>
                ) : (
                  <button type="button" className="aps-recv-del" onClick={() => setConfirmId(c.receipt.id)}
                    aria-label={`${entryTitle(c.receipt)}, ${formatMoney(c.receipt.amountTiyn)} — өшіру`}>
                    Өшіру
                  </button>
                )
              )}
            </li>
          ))}
        </ul>
      )}
      {!showAll && checks.length > recent.length && (
        <button type="button" className="btn btn-outline btn-full" onClick={() => setShowAll(true)}>
          Ертерек жазбалар ({checks.length - recent.length})
        </button>
      )}

      {unclaimed.length > 0 && (
        <details className="aps-recv-unclaimed">
          <summary>
            Журналда бар, мұнда жазылмаған нал: {unclaimed.length} · <b>{formatMoney(unclaimedTiyn)}</b>
          </summary>
          <ul>
            {unclaimed.map((j) => (
              <li key={j.paymentId}>
                <div className="aps-recv-top">
                  <span className="aps-recv-name">№{shortNumber(j.orderNumber)} · {j.customerName}</span>
                  <strong>{formatMoney(j.amountTiyn)}</strong>
                </div>
                <div className="aps-recv-meta">
                  {dayLabel(j.day)} · {j.byName}{j.note ? <> · 💬 {j.note}</> : null}
                </div>
                <button type="button" className="btn btn-outline btn-sm" onClick={() => startFrom(j)}>Алдым деп жазу</button>
              </li>
            ))}
          </ul>
        </details>
      )}

      {unclaimedObnal.length > 0 && (
        <details className="aps-recv-unclaimed">
          <summary>
            Кассада бар, мұнда жазылмаған обнал: {unclaimedObnal.length} · <b>{formatMoney(unclaimedObnalTiyn)}</b>
          </summary>
          <ul>
            {unclaimedObnal.map((k) => (
              <li key={k.expenseId}>
                <div className="aps-recv-top">
                  <span className="aps-recv-name">{k.who ? `Обнал · ${k.who}` : "Обнал"}</span>
                  <strong>{formatMoney(k.amountTiyn)}</strong>
                </div>
                <div className="aps-recv-meta">
                  {dayLabel(k.day)} · {k.byName} · 💬 {k.label}
                </div>
                <button type="button" className="btn btn-outline btn-sm" onClick={() => startFromObnal(k)}>Алдым деп жазу</button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
