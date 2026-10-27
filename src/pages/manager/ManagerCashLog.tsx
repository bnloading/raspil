import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { collection, getDocs } from "firebase/firestore";
import { db } from "../../firebase";
import { useAuth } from "../../AuthContext";
import { Spinner, Toast } from "../../components";
import { AppShell } from "../../components/layout/AppShell";
import { NumberField } from "../../components/NumberField";
import { useToast } from "../../hooks";
import { useAllOrders } from "../../hooks/useOrders";
import { useAllPayments } from "../../hooks/usePayments";
import { useExpenses } from "../../hooks/useExpenses";
import { useDepartmentCashbox } from "../../hooks/useDepartmentCashbox";
import { accountForMethod } from "../../lib/cashbox";
import { cashBookDays, cashBookEntries } from "../../lib/cashBook";
import { netPaidTiyn } from "../../lib/journal";
import { recordPayment } from "../../lib/payments";
import { formatMoney } from "../../lib/money";
import { dayKey, formatDateDMY } from "../../lib/dates";
import { departmentOf, departmentOfOrder, methodVisibleTo } from "../../lib/rbac";
import type { Order, PaymentMethodDef } from "../../types/domain";

/** How many days the book opens on — a month of a small counter's cash fits a phone screen or two. */
const DAYS_SHOWN = 30;

/** "ORD-2026-000558" → "558". */
function shortNumber(orderNumber: string): string {
  return orderNumber.match(/(\d+)$/)?.[1]?.replace(/^0+/, "") ?? orderNumber;
}

/** "2026-10-27" → "27.10.2026", read on the Almaty calendar day it names. */
function dayLabel(day: string): string {
  return formatDateDMY(new Date(`${day}T12:00:00+05:00`));
}

/**
 * «Қолма-қол» — the cash the counter takes, written down where it is taken.
 *
 * The owner asked for it on the МДФ line in Аренда's place (26.10): Ахжол takes cash in hand, and
 * what he holds has to be readable without opening the whole Касса. The top says what should be in
 * hand now — the Касса's own Қолма-қол figure — and the form takes cash on an order straight away,
 * with a word on who it went to. Below is the book: every cash payment and every expense paid out
 * of the drawer, by day. Nothing here is stored apart from the payments themselves (lib/cashBook.ts),
 * so it can never disagree with the Касса.
 */
export default function ManagerCashLog() {
  const { user, userData } = useAuth();
  const department = userData ? departmentOf(userData) : "ldsp";
  const { message, visible, showToast } = useToast();
  const { orders: allOrders, loading: ordersLoading } = useAllOrders();
  const { payments, byOrder, loading: paymentsLoading } = useAllPayments();
  const { expenses: allExpenses } = useExpenses();
  const cash = useDepartmentCashbox({ orders: allOrders, department });
  const [methods, setMethods] = useState<PaymentMethodDef[]>([]);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    getDocs(collection(db, "paymentMethods"))
      .then((snap) => setMethods(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<PaymentMethodDef, "id">) }))))
      .catch(() => setMethods([]));
  }, []);

  const orders = useMemo(
    () => allOrders.filter((o) => departmentOfOrder(o) === department),
    [allOrders, department],
  );
  const expenses = useMemo(
    () => allExpenses.filter((e) => (e.department ?? "ldsp") === department),
    [allExpenses, department],
  );
  const days = useMemo(
    () => cashBookDays(cashBookEntries({ payments, expenses, orders, methods })),
    [payments, expenses, orders, methods],
  );
  const shownDays = showAll ? days : days.slice(0, DAYS_SHOWN);

  /** The one method cash is taken under on this line — «Нал / Қолма-қол». */
  const cashMethod = methods.find(
    (m) => m.active !== false && !m.isMixed && methodVisibleTo(m, department) && accountForMethod(m) === "cash",
  );
  /** Orders still owing, newest first — the ones cash is taken on. */
  const owing = useMemo(
    () =>
      orders
        .filter((o) => o.productionStatus !== "cancelled" && o.productionStatus !== "draft" && o.pricePublished !== false)
        .map((o) => ({ order: o, remainingTiyn: o.totalTiyn - netPaidTiyn(byOrder.get(o.id) ?? []) }))
        .filter((row) => row.remainingTiyn > 0)
        .sort((a, b) => (b.order.createdAt?.seconds ?? 0) - (a.order.createdAt?.seconds ?? 0)),
    [orders, byOrder],
  );

  const today = dayKey(new Date());
  const inHandTiyn = cash.now.accounts.find((a) => a.account === "cash")?.balanceTiyn ?? 0;
  const monthCash = cash.thisMonth.accounts.find((a) => a.account === "cash");
  const todayInTiyn = days.find((d) => d.day === today)?.inTiyn ?? 0;

  if (!user || !userData) return <Spinner />;
  const actor = { user, userData };

  return (
    <AppShell title="Қолма-қол" subtitle="Қолма-қол түскен және шыққан ақша">
      <div className="kpi-row">
        <div className="kpi-card">
          <div className="kpi-text">
            <div className="kpi-label">Қолда болуы керек</div>
            <div className="kpi-value">{cash.loading ? "…" : formatMoney(inHandTiyn)}</div>
          </div>
          <span className="kpi-icon is-green">💵</span>
        </div>
        <div className="kpi-card">
          <div className="kpi-text">
            <div className="kpi-label">Бүгін түсті</div>
            <div className="kpi-value">{formatMoney(todayInTiyn)}</div>
          </div>
          <span className="kpi-icon is-blue">⬇</span>
        </div>
        <div className="kpi-card">
          <div className="kpi-text">
            <div className="kpi-label">Осы айда түсті</div>
            <div className="kpi-value">{formatMoney(monthCash?.inTiyn ?? 0)}</div>
          </div>
          <span className="kpi-icon is-indigo">📥</span>
        </div>
        <div className="kpi-card">
          <div className="kpi-text">
            <div className="kpi-label">Осы айда шықты</div>
            <div className="kpi-value">{formatMoney(monthCash?.outTiyn ?? 0)}</div>
          </div>
          <span className="kpi-icon is-red">📤</span>
        </div>
      </div>

      <TakeCashForm
        actor={actor}
        owing={owing}
        cashMethod={cashMethod}
        methodsLoaded={methods.length > 0}
        onToast={showToast}
      />

      <section className="panel-card">
        <div className="panel-head">
          <h3>Қолма-қол кітабы</h3>
          <Link to="/manager/cashbox">Касса →</Link>
        </div>
        {ordersLoading || paymentsLoading ? (
          <Spinner />
        ) : days.length === 0 ? (
          <div className="empty-state">
            <div className="icon">💵</div>
            <p>Қолма-қол әлі түспеген</p>
          </div>
        ) : (
          <>
            {shownDays.map((d) => (
              <div key={d.day} className="cashlog-day">
                <div className="cashlog-day-head">
                  <strong>{d.day === today ? "Бүгін" : dayLabel(d.day)}</strong>
                  <span>
                    {d.inTiyn > 0 && <b className="is-in">+{formatMoney(d.inTiyn)}</b>}
                    {d.outTiyn > 0 && <b className="is-out">−{formatMoney(d.outTiyn)}</b>}
                  </span>
                </div>
                {d.entries.map((e) => (
                  <div key={`${e.kind}-${e.id}`} className={`cashlog-row is-${e.kind}`}>
                    <div className="cashlog-row-main">
                      <span className="cashlog-row-title">{e.title}</span>
                      {e.note && <span className="cashlog-row-note">💬 {e.note}</span>}
                      <span className="cashlog-row-by">
                        {e.kind === "in"
                          ? new Intl.DateTimeFormat("ru-RU", { timeZone: "Asia/Almaty", hour: "2-digit", minute: "2-digit" })
                            .format(new Date(e.atMs))
                          : "Шығын"}{" "}
                        · {e.byName}
                      </span>
                    </div>
                    <strong className="cashlog-row-sum">
                      {e.kind === "in" ? "+" : "−"}{formatMoney(e.amountTiyn)}
                    </strong>
                  </div>
                ))}
              </div>
            ))}
            {!showAll && days.length > DAYS_SHOWN && (
              <button type="button" className="btn btn-outline btn-full" onClick={() => setShowAll(true)}>
                Ертерек күндерді көрсету ({days.length - DAYS_SHOWN})
              </button>
            )}
          </>
        )}
      </section>

      <Toast message={message} visible={visible} />
    </AppShell>
  );
}

/**
 * «Қолма-қол қабылдау» — cash taken on an order, from this page. The same audited recordPayment
 * the journal uses, under the line's cash method, so the order's debt, the journal and the Касса
 * all move with it; the note is what is written on the cash in the journal too.
 */
function TakeCashForm({
  actor,
  owing,
  cashMethod,
  methodsLoaded,
  onToast,
}: {
  actor: Parameters<typeof recordPayment>[1];
  owing: { order: Order; remainingTiyn: number }[];
  cashMethod: PaymentMethodDef | undefined;
  methodsLoaded: boolean;
  onToast: (message: string) => void;
}) {
  const [orderId, setOrderId] = useState("");
  const [amountTenge, setAmountTenge] = useState(0);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const picked = owing.find((row) => row.order.id === orderId);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!picked) {
      onToast("Заказды таңдаңыз");
      return;
    }
    if (!cashMethod) {
      onToast("Қолма-қол төлем түрі табылмады");
      return;
    }
    const amountTiyn = Math.round(amountTenge * 100);
    if (amountTiyn <= 0) {
      onToast("Соманы енгізіңіз");
      return;
    }
    if (amountTiyn > picked.remainingTiyn
      && !confirm(`Бұл сома қарыздан ${formatMoney(amountTiyn - picked.remainingTiyn)} артық. Жалғастырасыз ба?`)) return;
    setSaving(true);
    try {
      await recordPayment(db, actor, {
        orderId: picked.order.id,
        amountTiyn,
        methodId: cashMethod.id,
        methodName: cashMethod.name,
        comment: note.trim() || "Қолма-қол беті арқылы",
      });
      onToast(`✅ №${shortNumber(picked.order.orderNumber)} · ${picked.order.customerName}: ${formatMoney(amountTiyn)} қолма-қол жазылды`);
      setOrderId("");
      setAmountTenge(0);
      setNote("");
    } catch (err: unknown) {
      onToast("Қате: " + (err as Error).message);
    }
    setSaving(false);
  };

  return (
    <section className="panel-card">
      <div className="panel-head">
        <h3>Қолма-қол қабылдау</h3>
      </div>
      {methodsLoaded && !cashMethod ? (
        <p className="form-hint">Бұл бөлімде «Қолма-қол» төлем түрі жоқ — Кассадағы төлем түрлерін тексеріңіз.</p>
      ) : (
        <form onSubmit={submit}>
          <div className="form-group">
            <label>Заказ</label>
            <select className="form-input" value={orderId} required
              onChange={(e) => {
                setOrderId(e.target.value);
                const row = owing.find((r) => r.order.id === e.target.value);
                setAmountTenge(row ? row.remainingTiyn / 100 : 0);
              }}>
              <option value="">{owing.length === 0 ? "Қарызы бар заказ жоқ" : "Таңдаңыз…"}</option>
              {owing.map(({ order, remainingTiyn }) => (
                <option key={order.id} value={order.id}>
                  №{shortNumber(order.orderNumber)} · {order.customerName} — қарыз {formatMoney(remainingTiyn)}
                </option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label>Сома (₸)</label>
            <NumberField value={amountTenge} min={0} onChange={setAmountTenge} ariaLabel="Қолма-қол сомасы" />
          </div>
          <div className="form-group">
            <label>Кімге берілді / ескертпе (міндетті емес)</label>
            <input className="form-input" value={note} onChange={(e) => setNote(e.target.value)}
              placeholder="Мысалы: Ербақытқа берілді" />
          </div>
          <button type="submit" className="btn btn-primary btn-full" disabled={saving || !picked}>
            {saving ? "Сақталуда…" : "💵 Қолма-қол жазу"}
          </button>
        </form>
      )}
    </section>
  );
}
