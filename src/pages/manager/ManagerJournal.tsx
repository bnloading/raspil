import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { collection, getDocs } from "firebase/firestore";
import { db } from "../../firebase";
import { useAuth } from "../../AuthContext";
import { Spinner, Toast } from "../../components";
import { AppShell } from "../../components/layout/AppShell";
import { useToast } from "../../hooks";
import { useAllOrders } from "../../hooks/useOrders";
import { useAllPayments } from "../../hooks/usePayments";
import { useMaterials } from "../../hooks/useMaterials";
import { NumberField } from "../../components/NumberField";
import { formatMoney, formatMoneyBare } from "../../lib/money";
import { dayKey, formatDateDMY, startOfDayAlmaty } from "../../lib/dates";
import { formatPhone } from "../../lib/phone";
import { exportCsv, exportXlsx } from "../../lib/exportTable";
import { computeJournalRowTotals, netPaidTiyn, paidByMethod } from "../../lib/journal";
import {
  createJournalOrder,
  draftFromOrder,
  emptyJournalDraft,
  saveJournalRow,
  type JournalDraft,
} from "../../lib/journalOrders";
import { recordPayment } from "../../lib/payments";
import { PAYMENT_STATUS_LABELS, PAYMENT_STATUS_SHORT, PRODUCTION_STATUS_ORDER } from "../../lib/statuses";
import type { Material, Order, PaymentMethodDef } from "../../types/domain";

const PAGE_SIZES = [25, 50, 100];

/**
 * The methods that get their own column in the CSV/XLSX export. The on-screen journal collapsed
 * these into one "Төлем түрі" dropdown, but an export is read in Excel where a column per method
 * is what the accountant sums — so the wide shape is kept here deliberately.
 */
const METHOD_COLUMNS: { id: string; label: string }[] = [
  { id: "cash", label: "Нал" },
  { id: "kaspi", label: "Kaspi" },
  { id: "pay", label: "Pay" },
  { id: "nur", label: "Нұр" },
  { id: "balim", label: "Бәлім" },
];

type DateFilter = "all" | "today" | "week" | "month";
type PayFilter = "all" | "unpaid" | "partial" | "paid";

/** "Today" means today in Asia/Almaty (the shop's clock), not the browser's local midnight. */
function startOfToday(): number {
  return startOfDayAlmaty().getTime();
}

interface StageIndicator {
  label: string;
  tone: "green" | "blue" | "amber" | "emerald" | "red" | "muted";
}

/**
 * Cutting / PVC / "ready" indicators for the three status columns at the right of the journal.
 * Each collapses the 16-value ProductionStatus down to one stage's own progress, so a single
 * order shows three independent traffic lights rather than one combined status — which is what
 * lets cutting go green while PVC is still amber.
 */
function stageStates(order: Order): { cutting: StageIndicator; pvc: StageIndicator; ready: StageIndicator } {
  const s = order.productionStatus;
  const rank = (status: Order["productionStatus"]) => PRODUCTION_STATUS_ORDER.indexOf(status);
  // "cancelled" sorts last in PRODUCTION_STATUS_ORDER but is not "furthest along" — exclude it
  // from every ordering comparison rather than letting it read as past every milestone.
  const reached = (milestone: Order["productionStatus"]) => s !== "cancelled" && rank(s) >= rank(milestone);

  const cutting: StageIndicator =
    s === "cancelled" ? { label: "—", tone: "muted" }
    : reached("cutting_completed") ? { label: "Кесілді", tone: "green" }
    : s === "cutting_started" ? { label: "Кесіліп жатыр", tone: "blue" }
    : s === "cutting_queue" ? { label: "Распил кезегінде", tone: "amber" }
    : { label: "Күтілуде", tone: "muted" };

  const pvc: StageIndicator =
    order.pvcMetersTotal <= 0 ? { label: "ПВХ жоқ", tone: "muted" }
    : s === "cancelled" ? { label: "—", tone: "muted" }
    : reached("pvc_completed") ? { label: "ПВХ дайын", tone: "green" }
    : s === "pvc_started" ? { label: "Жасалып жатыр", tone: "blue" }
    : s === "pvc_queue" ? { label: "ПВХ кезегінде", tone: "amber" }
    : { label: "Распил күтілуде", tone: "muted" };

  const ready: StageIndicator =
    s === "delivered" ? { label: "Клиентке берілді", tone: "emerald" }
    : s === "ready" ? { label: "Дайын", tone: "green" }
    : s === "cancelled" ? { label: "Бас тартылды", tone: "red" }
    : { label: "Дайын емес", tone: "amber" };

  return { cutting, pvc, ready };
}

export default function ManagerJournal() {
  const { user, userData } = useAuth();
  const navigate = useNavigate();
  const { orders, loading } = useAllOrders();
  const { byOrder, loading: paymentsLoading } = useAllPayments();
  const { materials } = useMaterials(false);
  const { message, visible, showToast } = useToast();

  const [searchParams] = useSearchParams();
  const [methods, setMethods] = useState<PaymentMethodDef[]>([]);
  // Seeded from ?q= so "Заказдарын көру →" on the debt ledger lands here pre-filtered.
  const [search, setSearch] = useState(() => searchParams.get("q") ?? "");
  const [dateFilter, setDateFilter] = useState<DateFilter>("all");
  const [payFilter, setPayFilter] = useState<PayFilter>("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  // Only the "add a new order" row still has an explicit save; existing rows write themselves.
  const [saving, setSaving] = useState(false);

  // Phone-only view choice, remembered so a manager who prefers the ledger isn't re-toggling it
  // on every visit. Ignored entirely above the tablet breakpoint, where both classes are inert.
  const [mobileTable, setMobileTable] = useState(() => localStorage.getItem("journalMobileTable") === "1");
  useEffect(() => {
    localStorage.setItem("journalMobileTable", mobileTable ? "1" : "0");
  }, [mobileTable]);

  /** Order whose payment dialog is open. */
  const [payFor, setPayFor] = useState<Order | null>(null);

  const [newRow, setNewRow] = useState<JournalDraft | null>(null);
  const newRowNameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    getDocs(collection(db, "paymentMethods"))
      .then((snap) => setMethods(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<PaymentMethodDef, "id">) }))))
      .catch(() => setMethods([]));
  }, []);

  useEffect(() => {
    if (newRow) newRowNameRef.current?.focus();
  }, [newRow]);

  const materialsById = useMemo(() => new Map(materials.map((m) => [m.id, m])), [materials]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const todayStart = startOfToday();
    const cutoff =
      dateFilter === "today" ? todayStart
      : dateFilter === "week" ? todayStart - 6 * 86400000
      : dateFilter === "month" ? todayStart - 29 * 86400000
      : null;

    return orders.filter((o) => {
      if (o.productionStatus === "draft") return false; // never submitted — not journal material
      if (q && !(o.orderNumber.toLowerCase().includes(q) || o.customerName.toLowerCase().includes(q) || o.customerPhone.includes(q))) {
        return false;
      }
      if (cutoff !== null) {
        const ms = o.createdAt ? o.createdAt.toMillis() : 0;
        if (ms < cutoff) return false;
      }
      if (payFilter !== "all") {
        if (payFilter === "paid" && o.paymentStatus !== "paid" && o.paymentStatus !== "overpaid") return false;
        if (payFilter === "partial" && o.paymentStatus !== "partial") return false;
        if (payFilter === "unpaid" && o.paymentStatus !== "unpaid") return false;
      }
      return true;
    });
  }, [orders, search, dateFilter, payFilter]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageItems = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);

  const summary = useMemo(() => {
    const todayStart = startOfToday();
    return {
      todayCount: filtered.filter((o) => (o.createdAt?.toMillis() ?? 0) >= todayStart).length,
      totalTiyn: filtered.reduce((s, o) => s + o.totalTiyn, 0),
      paidTiyn: filtered.reduce((s, o) => s + o.paidTiyn, 0),
      debtTiyn: filtered.reduce((s, o) => s + Math.max(0, o.debtTiyn), 0),
    };
  }, [filtered]);

  if (!user || !userData) return <Spinner />;
  const actor = { user, userData };

  const commitNewRow = async () => {
    if (!newRow) return;
    if (!newRow.customerName.trim()) {
      showToast("Клиент атын енгізіңіз");
      return;
    }
    setSaving(true);
    try {
      await createJournalOrder(db, actor, newRow, materialsById.get(newRow.materialId));
      showToast("✅ Жаңа заказ қосылды");
      setNewRow(emptyJournalDraft());
    } catch (err: unknown) {
      showToast("Қате: " + (err as Error).message);
    }
    setSaving(false);
  };

  const handleAddPayment = async (order: Order, methodId: string, amountTiyn: number) => {
    const method = methods.find((m) => m.id === methodId);
    if (!method) {
      showToast("Төлем түрі табылмады");
      return;
    }
    if (amountTiyn <= 0) {
      showToast("Сома дұрыс емес");
      return;
    }
    try {
      await recordPayment(db, actor, {
        orderId: order.id,
        amountTiyn,
        methodId: method.id,
        methodName: method.name,
        comment: "Журнал арқылы",
      });
      showToast("✅ Төлем тіркелді");
      setPayFor(null);
    } catch (err: unknown) {
      showToast("Қате: " + (err as Error).message);
    }
  };

  const exportRows = () =>
    filtered.map((o) => {
      const pays = byOrder.get(o.id) ?? [];
      const byMethod = paidByMethod(pays);
      const stages = stageStates(o);
      return {
        "№": o.orderNumber,
        "Клиент аты": o.customerName,
        Телефон: o.customerPhone,
        "Лист түрі": o.materialSnapshot.name,
        "Лист саны": o.confirmedSheets ?? o.estimatedSheets,
        "Лист бағасы": o.materialSnapshot.sellingPriceTiyn / 100,
        "ПВХ, м": o.pvcMetersTotal,
        "ПВХ 1 м бағасы": (o.pvcPricePerMeterTiyn ?? 0) / 100,
        "Жалпы ПВХ": o.pvcCostTiyn / 100,
        "Есептелген сома": o.totalTiyn / 100,
        Статус: PAYMENT_STATUS_LABELS[o.paymentStatus],
        Күні: o.createdAt ? formatDateDMY(o.createdAt) : "",
        ...Object.fromEntries(METHOD_COLUMNS.map((m) => [m.label, (byMethod.get(m.id) ?? 0) / 100])),
        Қалдық: Math.max(0, o.debtTiyn) / 100,
        Распил: stages.cutting.label,
        ПВХ: stages.pvc.label,
        Дайын: stages.ready.label,
      };
    });

  const toolbar = (
    <div className="journal-toolbar">
      <button className="btn btn-success btn-sm" onClick={() => setNewRow(newRow ? null : emptyJournalDraft())}>
        ＋ Жаңа заказ қосу
      </button>
      <input
        className="journal-search"
        placeholder="Клиент немесе заказ №"
        value={search}
        onChange={(e) => {
          setSearch(e.target.value);
          setPage(1);
        }}
      />
      <select className="journal-select" value={dateFilter} onChange={(e) => { setDateFilter(e.target.value as DateFilter); setPage(1); }}>
        <option value="all">Барлық күн</option>
        <option value="today">Бүгін</option>
        <option value="week">7 күн</option>
        <option value="month">30 күн</option>
      </select>
      <select className="journal-select" value={payFilter} onChange={(e) => { setPayFilter(e.target.value as PayFilter); setPage(1); }}>
        <option value="all">Барлық төлем</option>
        <option value="unpaid">Төленбеді</option>
        <option value="partial">Жартылай</option>
        <option value="paid">Төленді</option>
      </select>
      <button className="btn btn-outline btn-sm" onClick={() => exportCsv("тапсырыс-журналы", exportRows())}>
        ⭳ CSV жүктеу
      </button>
      <button className="btn btn-outline btn-sm" onClick={() => exportXlsx("тапсырыс-журналы", exportRows())}>
        ⭳ Excel жүктеу
      </button>
      <button className="btn btn-outline btn-sm no-print" onClick={() => window.print()}>
        🖨
      </button>
      {/* Phone-only: the card list is the readable default, but the full ledger has to be
          reachable on a phone too — this swaps to the real table, scrolled sideways. */}
      <button
        className="btn btn-outline btn-sm journal-view-toggle"
        onClick={() => setMobileTable((v) => !v)}
      >
        {mobileTable ? "▤ Карта" : "▦ Кесте"}
      </button>
    </div>
  );

  return (
    <AppShell title="ЛДСП — ТАПСЫРЫС ЖУРНАЛЫ" navKey="manager-journal" contentWidth="full">
      {toolbar}

      {/* Phones get compact cards instead of a 23-column spreadsheet; tapping one opens the
          full-screen order editor. The table below is hidden at the same breakpoint in CSS. */}
      <div className={`journal-cards${mobileTable ? " is-hidden" : ""}`}>
        {loading || paymentsLoading ? (
          <Spinner />
        ) : pageItems.length === 0 ? (
          <div className="empty-state"><div className="icon">📭</div><p>Заказдар табылмады</p></div>
        ) : (
          pageItems.map((order) => {
            const stages = stageStates(order);
            return (
              <button key={order.id} className="journal-card" onClick={() => navigate(`/manager/order/${order.id}`)}>
                <div className="journal-card-top">
                  <strong>{order.orderNumber}</strong>
                  <span className={`jt-pill jt-pay-${order.paymentStatus}`}>
                    {PAYMENT_STATUS_LABELS[order.paymentStatus]}
                  </span>
                </div>
                <div className="journal-card-client">{order.customerName}</div>
                <div className="journal-card-meta">
                  {order.materialSnapshot.name} · {order.confirmedSheets ?? order.estimatedSheets} лист
                  {order.pvcMetersTotal > 0 && ` · ${order.pvcMetersTotal} м ПВХ`}
                </div>
                <div className="journal-card-money">
                  <span>{formatMoney(order.totalTiyn)}</span>
                  {order.debtTiyn > 0 && <span className="jt-debt">Қарыз {formatMoney(order.debtTiyn)}</span>}
                </div>
                <div className="journal-card-stages">
                  <span className={`jt-pill jt-tone-${stages.cutting.tone}`}>{stages.cutting.label}</span>
                  <span className={`jt-pill jt-tone-${stages.pvc.tone}`}>{stages.pvc.label}</span>
                  <span className={`jt-pill jt-tone-${stages.ready.tone}`}>{stages.ready.label}</span>
                </div>
              </button>
            );
          })
        )}
      </div>

      <div className={`journal-wrap${mobileTable ? " is-mobile-visible" : ""}`}>
        <div className="journal-scroll">
          <table className="journal-table">
            <thead>
              <tr>
                {/* Headers are abbreviated so the fixed-width columns hold real values rather
                    than being sized by their own titles. Each carries its full text as a title. */}
                <th className="jt-sticky jt-col-num">№</th>
                <th className="jt-sticky jt-col-name">Клиент</th>
                <th className="jt-w-phone">Телефон</th>
                <th className="jt-tint-material jt-w-mat">Материал</th>
                <th className="jt-tint-material jt-num jt-w-qty" title="Лист саны">Саны</th>
                <th className="jt-tint-material jt-num jt-w-money" title="Лист бағасы">Баға</th>
                <th className="jt-tint-pvc jt-num jt-w-qty" title="ПВХ метр">м</th>
                <th className="jt-tint-pvc jt-num jt-w-money" title="ПВХ 1 метр бағасы">ПВХ баға</th>
                <th className="jt-tint-pvc jt-num jt-w-money" title="Жалпы ПВХ сомасы">ПВХ сома</th>
                <th className="jt-tint-total jt-num jt-w-money" title="Есептелген сома">Сома</th>
                <th className="jt-w-status">Статус</th>
                <th className="jt-w-date">Күні</th>
                <th className="jt-tint-pay jt-w-method">Төлем түрі</th>
                <th className="jt-tint-pay jt-num jt-w-money">Төленген</th>
                <th className="jt-tint-debt jt-num jt-w-money">Қалдық</th>
                {/* Распил / ПВХ / Дайын dropped: three wide pill columns were what pushed the
                    ledger past the viewport, and the same information is already in the Статус
                    column and on the order page. The CSV export still carries all three. */}
                <th className="jt-w-act" title="Әрекет">⋯</th>
              </tr>
            </thead>
            <tbody>
              {loading || paymentsLoading ? (
                <tr><td colSpan={16} className="jt-empty">Жүктелуде…</td></tr>
              ) : pageItems.length === 0 && !newRow ? (
                <tr><td colSpan={16} className="jt-empty">Заказдар табылмады</td></tr>
              ) : (
                pageItems.map((order) => (
                  <JournalRow
                    key={order.id}
                    order={order}
                    materials={materials}
                    methods={methods}
                    payments={byOrder.get(order.id) ?? []}
                    actor={actor}
                    onOpen={() => navigate(`/manager/order/${order.id}`)}
                    onAddPayment={() => setPayFor(order)}
                    onError={showToast}
                  />
                ))
              )}

              {newRow && (
                <NewJournalRow
                  draft={newRow}
                  setDraft={setNewRow}
                  materials={materials}
                  saving={saving}
                  onSave={commitNewRow}
                  onCancel={() => setNewRow(null)}
                />
              )}
            </tbody>
          </table>
        </div>

        {!newRow && (
          <button className="journal-add-row" onClick={() => setNewRow(emptyJournalDraft())}>
            ＋ Жаңа жол қосу
          </button>
        )}

        <div className="journal-pagination">
          <span className="journal-page-info">
            {filtered.length === 0 ? "0" : `${(safePage - 1) * pageSize + 1}–${Math.min(safePage * pageSize, filtered.length)}`} / {filtered.length} заказ
          </span>
          <div className="journal-page-buttons">
            <button className="journal-page-btn" disabled={safePage <= 1} onClick={() => setPage(1)}>«</button>
            <button className="journal-page-btn" disabled={safePage <= 1} onClick={() => setPage((p) => p - 1)}>‹</button>
            <span className="journal-page-current">{safePage}</span>
            <button className="journal-page-btn" disabled={safePage >= totalPages} onClick={() => setPage((p) => p + 1)}>›</button>
            <button className="journal-page-btn" disabled={safePage >= totalPages} onClick={() => setPage(totalPages)}>»</button>
          </div>
          <select
            className="journal-select"
            value={pageSize}
            onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}
          >
            {PAGE_SIZES.map((n) => <option key={n} value={n}>{n} / бет</option>)}
          </select>
        </div>
      </div>

      <div className="journal-summary">
        <div className="journal-summary-item">
          <span className="journal-summary-label">Бүгін</span>
          <strong>{summary.todayCount} заказ</strong>
        </div>
        <div className="journal-summary-item">
          <span className="journal-summary-label">Жалпы</span>
          <strong>{formatMoney(summary.totalTiyn)}</strong>
        </div>
        <div className="journal-summary-item is-paid">
          <span className="journal-summary-label">Төленгені</span>
          <strong>{formatMoney(summary.paidTiyn)}</strong>
        </div>
        <div className="journal-summary-item is-debt">
          <span className="journal-summary-label">Қарыз</span>
          <strong>{formatMoney(summary.debtTiyn)}</strong>
        </div>
        <button className="btn btn-primary journal-summary-cta" onClick={() => navigate("/manager/cutting")}>
          Распил кезегін ашу →
        </button>
      </div>

      {payFor && (
        <PaymentDialog
          order={payFor}
          methods={methods}
          onClose={() => setPayFor(null)}
          onSubmit={(methodId, amountTiyn) => handleAddPayment(payFor, methodId, amountTiyn)}
        />
      )}

      <Toast message={message} visible={visible} />
    </AppShell>
  );
}

/**
 * "Төлем тіркеу" — pick the method, confirm the amount.
 *
 * Replaces a window.prompt(): the amount defaults to what the order still owes, so the common case
 * (customer settles in full) is two taps, and the method is picked from the shop's configured list
 * rather than being one of five fixed columns.
 */
function PaymentDialog({
  order,
  methods,
  onClose,
  onSubmit,
}: {
  order: Order;
  methods: PaymentMethodDef[];
  onClose: () => void;
  onSubmit: (methodId: string, amountTiyn: number) => Promise<void> | void;
}) {
  const remaining = Math.max(0, order.debtTiyn);
  const [methodId, setMethodId] = useState(() => methods[0]?.id ?? "");
  const [amountTenge, setAmountTenge] = useState(remaining > 0 ? remaining / 100 : 0);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    await onSubmit(methodId, Math.round(amountTenge * 100));
    setBusy(false);
  };

  return (
    <div className="modal-overlay active" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-handle" />
        <h2>💰 Төлем тіркеу</h2>
        <p className="scan-hint">
          {order.orderNumber} · {order.customerName}
          {remaining > 0 && <> · қалдық <strong>{formatMoney(remaining)}</strong></>}
        </p>

        <div className="form-group">
          <label>Төлем түрі</label>
          <div className="pay-method-grid">
            {methods.map((m) => (
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

        <div className="form-group">
          <label>Сома (₸)</label>
          <NumberField value={amountTenge} min={0} onChange={setAmountTenge} ariaLabel="Төлем сомасы" />
        </div>

        <div className="modal-actions">
          <button type="button" className="btn btn-outline" onClick={onClose}>Болдырмау</button>
          <button type="button" className="btn btn-primary" disabled={busy || !methodId || amountTenge <= 0}
            onClick={submit}>
            {busy ? "Сақталуда…" : "✅ Тіркеу"}
          </button>
        </div>
      </div>
    </div>
  );
}

type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";

const SAVE_GLYPHS: Record<SaveState, string> = { idle: "", dirty: "•", saving: "⋯", saved: "✓", error: "!" };
const SAVE_TITLES: Record<SaveState, string> = {
  idle: "",
  dirty: "Өзгертілді — сақталуда",
  saving: "Сақталуда…",
  saved: "Сақталды",
  error: "Сақталмады — қайта көріңіз",
};

/** How long after the last keystroke the row commits itself. Long enough to type a whole number. */
const AUTOSAVE_MS = 900;

/**
 * One ledger row, always editable.
 *
 * There is no edit mode: every cell is a live input, and the row writes itself back a beat after
 * you stop typing, the way a spreadsheet does. Each row owns its own draft rather than the page
 * holding one shared "currently editing" draft, which is what makes editing several rows in a row
 * — or leaving one half-typed while you look at another — behave sensibly.
 */
function JournalRow({
  order, materials, payments, actor, onOpen, onAddPayment, onError,
}: {
  order: Order;
  materials: Material[];
  methods: PaymentMethodDef[];
  payments: import("../../types/domain").Payment[];
  actor: Parameters<typeof saveJournalRow>[1];
  onOpen: () => void;
  /** Opens the payment dialog for this row; the method and amount are chosen there. */
  onAddPayment: () => void;
  onError: (message: string) => void;
}) {
  const byMethod = paidByMethod(payments);
  const paid = netPaidTiyn(payments);

  const [draft, setDraft] = useState<JournalDraft>(() => draftFromOrder(order));
  const [saveState, setSaveState] = useState<SaveState>("idle");
  // `dirty` gates the two effects below: one must not save a row nobody touched, and the other
  // must not overwrite what is being typed with the snapshot Firestore just echoed back.
  const dirtyRef = useRef(false);

  // Adopt server-side changes (someone else's edit, or our own write coming back) only while this
  // row is not mid-edit.
  useEffect(() => {
    if (!dirtyRef.current) setDraft(draftFromOrder(order));
  }, [order]);

  useEffect(() => {
    if (!dirtyRef.current) return;
    const handle = setTimeout(async () => {
      setSaveState("saving");
      try {
        await saveJournalRow(db, actor, order, draft, materials.find((m) => m.id === draft.materialId));
        dirtyRef.current = false;
        setSaveState("saved");
      } catch (err: unknown) {
        // Leave the row dirty so the next keystroke retries rather than silently losing the edit.
        setSaveState("error");
        onError("Сақталмады: " + (err as Error).message);
      }
    }, AUTOSAVE_MS);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  const patch = (p: Partial<JournalDraft>) => {
    dirtyRef.current = true;
    setSaveState("dirty");
    setDraft((prev) => ({ ...prev, ...p }));
  };

  // "Төлем түрі": the single method used, or "Аралас" once more than one method has paid into
  // this order — which is exactly what a mixed payment looks like once its legs are recorded.
  const usedMethods = [...byMethod.keys()];
  const methodLabel =
    usedMethods.length === 0 ? null
    : usedMethods.length > 1 ? "Аралас"
    : (payments.find((p) => !p.reversed && p.methodId === usedMethods[0])?.methodName ?? usedMethods[0]);

  // The per-method split lost its own columns; it survives as the paid cell's tooltip so a mixed
  // payment is still auditable without reopening the order.
  const methodBreakdown = [...byMethod.entries()]
    .map(([id, amount]) => {
      const name = payments.find((p) => !p.reversed && p.methodId === id)?.methodName ?? id;
      return `${name}: ${formatMoney(amount)}`;
    })
    .join(" · ");

  // Totals always come from the draft, so a figure updates as it is typed rather than only after
  // the save lands.
  const preview = computeJournalRowTotals({
    sheetQty: draft.sheetQty,
    sheetPriceTiyn: draft.sheetPriceTiyn,
    pvcMeters: draft.pvcMeters,
    pvcPricePerMeterTiyn: draft.pvcPricePerMeterTiyn,
    hdfCostTiyn: draft.hdfCostTiyn,
    cuttingCostTiyn: draft.cuttingCostTiyn,
    extraServicesTiyn: draft.extraServicesTiyn,
    deliveryCostTiyn: draft.deliveryCostTiyn,
    discountTiyn: draft.discountTiyn,
    paidTiyn: paid,
  });

  const shortNum = order.orderNumber.match(/(\d+)$/)?.[1]?.replace(/^0+/, "") ?? order.orderNumber;

  return (
    <tr className="jt-row">
      <td className="jt-sticky jt-col-num">
        <button className="jt-num-link" onClick={onOpen} title={order.orderNumber}>{shortNum}</button>
      </td>

      <td className="jt-sticky jt-col-name">
        <input className="jt-input" value={draft.customerName} onChange={(e) => patch({ customerName: e.target.value })} />
      </td>

      <td>
        <input
          className="jt-input"
          value={draft.customerPhone}
          onChange={(e) => patch({ customerPhone: e.target.value })}
          placeholder={order.customerPhone ? formatPhone(order.customerPhone) : "—"}
        />
      </td>

      <td className="jt-tint-material">
        <select
          className="jt-input"
          value={draft.materialId}
          onChange={(e) => {
            const m = materials.find((x) => x.id === e.target.value);
            patch({ materialId: e.target.value, sheetPriceTiyn: m?.sellingPriceTiyn ?? draft.sheetPriceTiyn });
          }}
        >
          <option value="">{order.materialSnapshot.name || "Лист түрі"}</option>
          {materials.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
      </td>

      <td className="jt-tint-material jt-num">
        <NumberField className="jt-input jt-input-num" value={draft.sheetQty} min={0}
          onChange={(v) => patch({ sheetQty: v })} ariaLabel="Лист саны" />
      </td>

      <td className="jt-tint-material jt-num">
        <NumberField className="jt-input jt-input-num" value={draft.sheetPriceTiyn / 100} min={0}
          onChange={(v) => patch({ sheetPriceTiyn: Math.round(v * 100) })} ariaLabel="Лист бағасы" />
      </td>

      <td className="jt-tint-pvc jt-num">
        <NumberField className="jt-input jt-input-num" value={draft.pvcMeters} min={0}
          onChange={(v) => patch({ pvcMeters: v })} ariaLabel="ПВХ метр" />
      </td>

      <td className="jt-tint-pvc jt-num">
        <NumberField className="jt-input jt-input-num" value={draft.pvcPricePerMeterTiyn / 100} min={0}
          onChange={(v) => patch({ pvcPricePerMeterTiyn: Math.round(v * 100) })} ariaLabel="ПВХ 1 м бағасы" />
      </td>

      <td className="jt-tint-pvc jt-num">{formatMoneyBare(preview.pvcCostTiyn)}</td>

      <td className="jt-tint-total jt-num jt-total">{formatMoneyBare(preview.totalTiyn)}</td>

      <td title={PAYMENT_STATUS_LABELS[preview.paymentStatus]}>
        <span className={`jt-pill jt-pay-${preview.paymentStatus}`}>
          {PAYMENT_STATUS_SHORT[preview.paymentStatus]}
        </span>
      </td>

      <td className="jt-muted jt-nowrap">{order.createdAt ? formatDateDMY(order.createdAt) : "—"}</td>

      {/* One dropdown instead of a money column per method. Picking a method opens the payment
          dialog for it, so the ledger reads like a spreadsheet cell and is five columns narrower. */}
      <td className="jt-tint-pay jt-nowrap">
        {/* A button, not a <select>. Driving an action from a select's change event proved
            unreliable here — the picked value was reset before the handler could act on it, so
            choosing a method silently recorded nothing. A button opening the picker below is
            unambiguous, works the same on a phone, and replaces the old window.prompt(). */}
        <button className={`jt-method-btn${methodLabel ? " has-value" : ""}`} onClick={onAddPayment}
          title="Төлем тіркеу">
          {methodLabel ?? "＋ төлем"}
        </button>
      </td>

      <td className="jt-tint-pay jt-num">
        {paid > 0
          ? <span className="jt-paid" title={methodBreakdown}>{formatMoneyBare(paid)}</span>
          : <span className="jt-muted">—</span>}
      </td>

      <td className="jt-tint-debt jt-num">
        <span className={Math.max(0, preview.debtTiyn) > 0 ? "jt-debt" : "jt-muted"}>
          {formatMoneyBare(Math.max(0, preview.debtTiyn))}
        </span>
      </td>

      <td className="jt-actions">
        <span className={`jt-save-dot is-${saveState}`} title={SAVE_TITLES[saveState]} aria-live="polite">
          {SAVE_GLYPHS[saveState]}
        </span>
        <button className="jt-icon-btn" onClick={onOpen} title="Толық ашу">↗</button>
      </td>
    </tr>
  );
}

function NewJournalRow({
  draft, setDraft, materials, saving, onSave, onCancel,
}: {
  draft: JournalDraft;
  setDraft: (d: JournalDraft) => void;
  materials: Material[];
  saving: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  const patch = (p: Partial<JournalDraft>) => setDraft({ ...draft, ...p });
  const preview = computeJournalRowTotals({
    sheetQty: draft.sheetQty,
    sheetPriceTiyn: draft.sheetPriceTiyn,
    pvcMeters: draft.pvcMeters,
    pvcPricePerMeterTiyn: draft.pvcPricePerMeterTiyn,
    hdfCostTiyn: draft.hdfCostTiyn,
    cuttingCostTiyn: draft.cuttingCostTiyn,
    extraServicesTiyn: draft.extraServicesTiyn,
    deliveryCostTiyn: draft.deliveryCostTiyn,
    discountTiyn: draft.discountTiyn,
    paidTiyn: 0,
  });

  return (
    <tr className="jt-row is-new"
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); onSave(); }
        if (e.key === "Escape") { e.preventDefault(); onCancel(); }
      }}>
      <td className="jt-sticky jt-col-num jt-muted">жаңа</td>
      <td className="jt-sticky jt-col-name">
        <input className="jt-input" placeholder="Клиент аты" value={draft.customerName}
          onChange={(e) => patch({ customerName: e.target.value })} />
      </td>
      <td>
        <input className="jt-input" placeholder="+7 (___) ___-__-__" value={draft.customerPhone}
          onChange={(e) => patch({ customerPhone: e.target.value })} />
      </td>
      <td className="jt-tint-material">
        <select className="jt-input" value={draft.materialId}
          onChange={(e) => {
            const m = materials.find((x) => x.id === e.target.value);
            patch({ materialId: e.target.value, sheetPriceTiyn: m?.sellingPriceTiyn ?? draft.sheetPriceTiyn });
          }}>
          <option value="">Лист түрін таңдаңыз</option>
          {materials.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
      </td>
      <td className="jt-tint-material jt-num">
        <input type="number" min={0} className="jt-input jt-input-num" value={draft.sheetQty}
          onChange={(e) => patch({ sheetQty: Number(e.target.value) || 0 })} />
      </td>
      <td className="jt-tint-material jt-num">
        <input type="number" min={0} className="jt-input jt-input-num" value={draft.sheetPriceTiyn / 100}
          onChange={(e) => patch({ sheetPriceTiyn: Math.round((Number(e.target.value) || 0) * 100) })} />
      </td>
      <td className="jt-tint-pvc jt-num">
        <input type="number" min={0} step="0.01" className="jt-input jt-input-num" value={draft.pvcMeters}
          onChange={(e) => patch({ pvcMeters: Number(e.target.value) || 0 })} />
      </td>
      <td className="jt-tint-pvc jt-num">
        <input type="number" min={0} className="jt-input jt-input-num" value={draft.pvcPricePerMeterTiyn / 100}
          onChange={(e) => patch({ pvcPricePerMeterTiyn: Math.round((Number(e.target.value) || 0) * 100) })} />
      </td>
      <td className="jt-tint-pvc jt-num">{formatMoneyBare(preview.pvcCostTiyn)}</td>
      <td className="jt-tint-total jt-num jt-total">{formatMoneyBare(preview.totalTiyn)}</td>
      <td><span className="jt-pill jt-pay-unpaid">{PAYMENT_STATUS_LABELS.unpaid}</span></td>
      <td>
        {/* dayKey() renders the Almaty calendar day, so the picker never shows "yesterday"
            for an evening order the way a UTC-sliced ISO string would. */}
        <input type="date" className="jt-input" value={dayKey(draft.orderDate)}
          onChange={(e) => patch({ orderDate: e.target.value ? new Date(`${e.target.value}T12:00:00+05:00`) : new Date() })} />
      </td>
      {/* Payment method and amounts stay empty until the order exists — every tenge is recorded
          through the transactional recordPayment path, never typed straight onto a new order. */}
      <td className="jt-muted">—</td>
      <td className="jt-tint-pay jt-num jt-muted">—</td>
      <td className="jt-tint-debt jt-num jt-debt">{formatMoneyBare(preview.totalTiyn)}</td>
      <td className="jt-actions">
        <button className="jt-icon-btn is-ok" disabled={saving} onClick={onSave} title="Қосу">✓</button>
        <button className="jt-icon-btn" disabled={saving} onClick={onCancel} title="Болдырмау">✕</button>
      </td>
    </tr>
  );
}
