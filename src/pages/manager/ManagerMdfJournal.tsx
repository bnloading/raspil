import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { collection, doc, getDocs, query, updateDoc, where } from "firebase/firestore";
import type { User } from "firebase/auth";
import { db } from "../../firebase";
import { useAuth } from "../../AuthContext";
import { Spinner, Toast } from "../../components";
import { AppShell } from "../../components/layout/AppShell";
import { IconLayers, IconReports } from "../../components/layout/icons";
import { NumberField } from "../../components/NumberField";
import { RowMenu } from "../../components/RowMenu";
import { CustomerNameInput } from "../../components/CustomerNameInput";
import {
  AUTOSAVE_MS,
  PaymentDialog,
  ProgressSteps,
  SAVE_GLYPHS,
  SAVE_TITLES,
  journalStatusLabel,
  type SaveState,
} from "../../components/JournalShared";
import { useToast } from "../../hooks";
import { useAllOrders } from "../../hooks/useOrders";
import { useAllPayments } from "../../hooks/usePayments";
import { useAppSettings } from "../../hooks/useAppSettings";
import {
  computeMdfOrderTotal,
  findMdfPatternTemplate,
  formatMdfArea,
  formatMdfAreaInput,
  MDF_QUICK_FILTERS,
  mdfJournalProgress,
  mdfMatchesQuickFilter,
  mdfPatternOf,
  mdfPatternTemplates,
  mdfStationLabel,
  mdfTemplatesProblem,
  parseMdfArea,
  type MdfQuickFilter,
} from "../../lib/mdfJournal";
import {
  createMdfJournalOrder,
  draftFromMdfOrder,
  emptyMdfJournalDraft,
  mdfDraftHasContent,
  mdfDraftTotals,
  mdfTotalOverride,
  publishMdfPrice,
  saveMdfJournalRow,
  type MdfJournalDraft,
} from "../../lib/mdfJournalOrders";
import { enterMdfProduction } from "../../lib/mdfOrderStatus";
import { cancelOrder } from "../../lib/orderStatus";
import { accountForMethod } from "../../lib/cashbox";
import { netPaidTiyn, paidByMethod } from "../../lib/journal";
import { methodIdOf, methodLabelOf, methodTone } from "../../lib/journalColumns";
import { SHOW_ALL, pageWindow } from "../../lib/journalPaging";
import { customerDirectory, mergeCustomerSources, type CustomerSuggestion } from "../../lib/customerSuggest";
import { correctPaymentAmount, paymentNotes, recordPayment, reversePayment } from "../../lib/payments";
import { canEnterCuttingQueue, computePaymentStatus } from "../../lib/statuses";
import { logAudit } from "../../lib/audit";
import { formatMoney, formatMoneyBare } from "../../lib/money";
import { dayKey, formatDateDMY, startOfDayAlmaty } from "../../lib/dates";
import { formatPhone } from "../../lib/phone";
import { exportCsv, exportXlsx } from "../../lib/exportTable";
import { isAdmin, methodVisibleTo } from "../../lib/rbac";
import type { MdfPatternTemplate, Order, Payment, PaymentMethodDef, UserDoc } from "../../types/domain";

type Actor = { user: User; userData: UserDoc };
type DateFilter = "all" | "today" | "week" | "month";

const PAGE_SIZES = [25, 50, 100, SHOW_ALL];
const DAY_MS = 86_400_000;
/** The stages an order still has to be pushed out of into production. */
const PRE_PRODUCTION: Order["productionStatus"][] = ["waiting_payment", "partially_paid", "paid"];
/** One <datalist> of the «Узор» templates, shared by every pattern cell on the page. */
const PATTERN_LIST_ID = "mdf-pattern-templates";
/** Every column of the МДФ ledger — for the colSpan of a row that spans them all. */
const COLUMN_COUNT = 10;

/** "ORD-2026-000558" → "558". */
function shortOrderNumber(orderNumber: string): string {
  return orderNumber.match(/(\d+)$/)?.[1]?.replace(/^0+/, "") ?? orderNumber;
}

/** Paper-ledger order, as the ЛДСП journal runs: oldest first, the order number settling a tie. */
function byLedgerOrder(a: Order, b: Order): number {
  const at = a.createdAt?.seconds ?? 0;
  const bt = b.createdAt?.seconds ?? 0;
  if (at !== bt) return at - bt;
  return a.orderNumber.localeCompare(b.orderNumber);
}

/** Enter steps down a column and Shift+Enter up it, as in the ЛДСП ledger. */
function moveFocusVertically(from: HTMLElement, direction: 1 | -1): void {
  const cell = from.closest("td");
  const row = from.closest("tr");
  if (!cell || !row) return;
  const column = cell.cellIndex;
  let next = direction === 1 ? row.nextElementSibling : row.previousElementSibling;
  while (next instanceof HTMLTableRowElement) {
    const target = next.cells[column]?.querySelector<HTMLElement>("input:not([disabled]), select:not([disabled])");
    if (target) {
      target.focus();
      if (target instanceof HTMLInputElement) target.select();
      return;
    }
    next = direction === 1 ? next.nextElementSibling : next.previousElementSibling;
  }
}

/** Picking — or typing — a template's name fills its м² rate in; any other name leaves the rate alone. */
function patternPatch(templates: readonly MdfPatternTemplate[], patternName: string): Partial<MdfJournalDraft> {
  const template = findMdfPatternTemplate(templates, patternName);
  return { patternName, ...(template ? { pricePerM2Tiyn: template.pricePerM2Tiyn } : {}) };
}

/**
 * "МДФ — ТАПСЫРЫС ЖУРНАЛЫ" — the МДФ counter's ledger, built like the ЛДСП one (the owner, 26.10:
 * «дизайны ЛДСП сияқты жинақы ықшамды болсын»): the same toolbar, chips, phone cards and table,
 * typed straight into and saved as it is typed. Its columns are the ones a МДФ order is written
 * down by — the «Узор», the м², the м² rate, typed by hand (a template's name fills the rate in) —
 * and money is taken through the same payment dialog, so the МДФ Касса is fed exactly as ЛДСП's is.
 */
export default function ManagerMdfJournal() {
  const { user, userData } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { orders: allOrders, loading } = useAllOrders();
  const { byOrder: paymentsByOrder, loading: paymentsLoading } = useAllPayments();
  const { settings } = useAppSettings();
  const templates = useMemo(() => mdfPatternTemplates(settings), [settings]);
  const { message, visible, showToast } = useToast();
  const [methods, setMethods] = useState<PaymentMethodDef[]>([]);
  const [accounts, setAccounts] = useState<CustomerSuggestion[]>([]);
  // Seeded from ?q= so «Заказдарын көру →» on the debt ledger lands here pre-filtered.
  const [search, setSearch] = useState(() => searchParams.get("q") ?? "");
  const [dateFilter, setDateFilter] = useState<DateFilter>("all");
  const [quickFilter, setQuickFilter] = useState<MdfQuickFilter>("all");
  const [mobileTable, setMobileTable] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [pageSize, setPageSize] = useState(50);
  const [pinnedPage, setPinnedPage] = useState<number | null>(null);
  const [newRow, setNewRow] = useState<MdfJournalDraft | null>(null);
  const newRowNameRef = useRef<HTMLInputElement>(null);
  const [saving, setSaving] = useState(false);
  const [payFor, setPayFor] = useState<Order | null>(null);
  const [priceFor, setPriceFor] = useState<Order | null>(null);
  const [sheetFor, setSheetFor] = useState<Order | null>(null);
  const [showTemplates, setShowTemplates] = useState(false);
  /** Orders a production send is already in flight for — a double tap must not send twice. */
  const pending = useRef(new Set<string>());

  useEffect(() => {
    getDocs(collection(db, "paymentMethods"))
      .then((snap) =>
        setMethods(
          snap.docs
            .map((d) => ({ id: d.id, ...(d.data() as Omit<PaymentMethodDef, "id">) }))
            .filter((m) => methodVisibleTo(m, "mdf")),
        ),
      )
      .catch(() => setMethods([]));
  }, []);

  useEffect(() => {
    // firestore.rules lets a Manager list users only when every candidate is a customer.
    getDocs(query(collection(db, "users"), where("role", "==", "customer")))
      .then((snap) =>
        setAccounts(
          snap.docs
            .map((d) => {
              const u = d.data() as { name?: string; phone?: string };
              return { name: (u.name ?? "").trim(), phone: (u.phone ?? "").trim(), orderCount: 0, lastOrderSeconds: 0 };
            })
            .filter((a) => a.name !== ""),
        ),
      )
      .catch(() => setAccounts([]));
  }, []);

  // Keyed on "is the row open", not on the draft: the draft changes on every keystroke.
  const newRowOpen = newRow !== null;
  useEffect(() => {
    if (newRowOpen) newRowNameRef.current?.focus();
  }, [newRowOpen]);

  const orders = useMemo(
    () => allOrders.filter((o) => o.orderKind === "mdf_wrap" && o.productionStatus !== "cancelled").sort(byLedgerOrder),
    [allOrders],
  );
  const customerDir = useMemo(() => mergeCustomerSources(customerDirectory(orders), accounts), [orders, accounts]);
  const paidOf = useCallback((orderId: string) => netPaidTiyn(paymentsByOrder.get(orderId) ?? []), [paymentsByOrder]);

  // Search and date first — the chips then count what is left, as the ЛДСП chips do.
  const searched = useMemo(() => {
    const q = search.trim().toLowerCase();
    const number = q.replace(/^№/, "");
    const digits = q.replace(/\D/g, "");
    const today = startOfDayAlmaty().getTime();
    const since = dateFilter === "today" ? today
      : dateFilter === "week" ? today - 6 * DAY_MS
      : dateFilter === "month" ? today - 29 * DAY_MS
      : 0;
    return orders.filter((o) => {
      if (since && (o.createdAt?.seconds ?? 0) * 1000 < since) return false;
      if (!q) return true;
      return o.customerName.toLowerCase().includes(q)
        || o.orderNumber.toLowerCase().includes(q)
        || shortOrderNumber(o.orderNumber) === number
        || mdfPatternOf(o).toLowerCase().includes(q)
        || (digits.length >= 3 && (o.customerPhone ?? "").replace(/\D/g, "").includes(digits));
    });
  }, [orders, search, dateFilter]);
  const chipCounts = useMemo(() => {
    const counts = {} as Record<MdfQuickFilter, number>;
    for (const chip of MDF_QUICK_FILTERS) {
      counts[chip.id] = searched.filter((o) => mdfMatchesQuickFilter(o, paidOf(o.id), chip.id)).length;
    }
    return counts;
  }, [searched, paidOf]);
  const filtered = useMemo(
    () => searched.filter((o) => mdfMatchesQuickFilter(o, paidOf(o.id), quickFilter)),
    [searched, quickFilter, paidOf],
  );

  const summary = useMemo(() => {
    const today = startOfDayAlmaty().getTime();
    let totalTiyn = 0;
    let paidTiyn = 0;
    let debtTiyn = 0;
    for (const o of filtered) {
      const paid = paidOf(o.id);
      totalTiyn += o.totalTiyn;
      paidTiyn += paid;
      debtTiyn += Math.max(0, o.totalTiyn - paid);
    }
    return {
      todayCount: orders.filter((o) => (o.createdAt?.seconds ?? 0) * 1000 >= today).length,
      shownCount: filtered.length,
      totalTiyn,
      paidTiyn,
      debtTiyn,
    };
  }, [filtered, orders, paidOf]);

  const pageView = pageWindow(filtered.length, pageSize, pinnedPage);
  const safePage = pageView.page;
  const pageItems = pageView.to === 0 ? [] : filtered.slice(pageView.from - 1, pageView.to);

  if (!user || !userData) return <Spinner />;
  const actor: Actor = { user, userData };
  const livePaymentsFor = (orderId: string) => (paymentsByOrder.get(orderId) ?? []).filter((p) => !p.reversed);

  const openNewRow = () => {
    // The row lives in the table, which a phone hides behind the cards — show the table with it.
    if (typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches) setMobileTable(true);
    if (newRow) {
      newRowNameRef.current?.focus();
      newRowNameRef.current?.scrollIntoView({ block: "center" });
      return;
    }
    setNewRow(emptyMdfJournalDraft());
  };

  /** ✕ and Escape both land here, so neither can silently drop a row with typing in it. */
  const cancelNewRow = () => {
    if (newRow && mdfDraftHasContent(newRow) && !confirm("Толтырылған жол сақталмай өшеді. Болдырмайсыз ба?")) return;
    setNewRow(null);
  };

  const commitNewRow = async () => {
    if (!newRow || saving) return;
    if (!mdfDraftHasContent(newRow)) {
      setNewRow(null);
      return;
    }
    setSaving(true);
    try {
      await createMdfJournalOrder(db, actor, newRow);
      setNewRow(null);
      setPinnedPage(null); // the newest rows are on the last page — show it
      showToast("✅ Жаңа заказ қосылды");
    } catch (err: unknown) {
      showToast("Қате: " + (err as Error).message);
    }
    setSaving(false);
  };

  /** One or more legs — «Аралас» records one payment per real method, sharing a groupId. */
  const handleAddPayment = async (order: Order, legs: { methodId: string; amountTiyn: number }[], note = "") => {
    const resolved = legs
      .map((leg) => ({ ...leg, method: methods.find((m) => m.id === leg.methodId) }))
      .filter((leg) => leg.method && leg.amountTiyn > 0);
    if (resolved.length === 0) {
      showToast(legs.some((l) => l.amountTiyn > 0) ? "Төлем түрі табылмады" : "Сома дұрыс емес");
      return;
    }
    const groupId = resolved.length > 1 ? crypto.randomUUID() : undefined;
    try {
      for (const leg of resolved) {
        await recordPayment(db, actor, {
          orderId: order.id,
          amountTiyn: leg.amountTiyn,
          methodId: leg.method!.id,
          methodName: leg.method!.name,
          // What was typed for the cash goes on the cash leg; every other leg keeps the app's tag.
          comment: note && accountForMethod(leg.method!) === "cash" ? note : "Журнал арқылы",
          ...(groupId ? { groupId } : {}),
        });
      }
      showToast(`✅ Төлем тіркелді — ${resolved.length > 1 ? "Аралас" : resolved[0].method!.name}`);
      setPayFor(null);
    } catch (err: unknown) {
      showToast("Қате: " + (err as Error).message);
    }
  };

  /** Relabels which method money came in by — no money moves (firestore.rules allows a Manager this). */
  const handleChangeMethod = async (payment: Payment, methodId: string) => {
    const method = methods.find((m) => m.id === methodId);
    if (!method || payment.methodId === methodId) return;
    try {
      await updateDoc(doc(db, "payments", payment.id), { methodId: method.id, methodName: method.name });
      await logAudit(db, actor, {
        action: "payment.method_changed",
        entityType: "payment",
        entityId: payment.id,
        before: { methodId: payment.methodId, methodName: payment.methodName },
        after: { methodId: method.id, methodName: method.name },
      });
      showToast(`✅ Төлем түрі — ${method.name}`);
    } catch (err: unknown) {
      showToast("Қате: " + (err as Error).message);
    }
  };

  /** A mistyped amount — the order's paid and debt are recomputed, nothing is reversed. */
  const handleChangeAmount = async (payment: Payment, amountTiyn: number) => {
    if (amountTiyn <= 0 || payment.amountTiyn === amountTiyn) return;
    try {
      await correctPaymentAmount(db, actor, { paymentId: payment.id, amountTiyn });
      showToast(`✅ Сома түзетілді — ${formatMoney(amountTiyn)}`);
    } catch (err: unknown) {
      showToast("Қате: " + (err as Error).message);
    }
  };

  /**
   * «Өндіріске жіберу» — onto ЧПУ, the first station. A settled order goes straight on; one still
   * owing goes on credit, exactly as «Распилға жіберу · қарызға» does on ЛДСП: one click, with the
   * override and the amount still owed written into the order and the audit.
   */
  const handleSendToProduction = async (order: Order) => {
    if (pending.current.has(order.id)) return;
    pending.current.add(order.id);
    const owed = Math.max(0, order.totalTiyn - netPaidTiyn(livePaymentsFor(order.id)));
    const settled = canEnterCuttingQueue(order.paymentStatus);
    try {
      await enterMdfProduction(db, actor, order, settled
        ? { isAdmin: false, queuePosition: 0 }
        : { isAdmin: true, overrideReason: `Журналдан қарызға жіберілді — қалдық ${formatMoney(owed)}`, queuePosition: 0 });
      showToast(settled
        ? `✅ ${order.orderNumber} өндіріске жіберілді`
        : `⚠️ Қарызға жіберілді — ${formatMoney(owed)} қарыз (аудитте тіркелді)`);
    } catch (err: unknown) {
      showToast("Қате: " + (err as Error).message);
    } finally {
      pending.current.delete(order.id);
    }
  };

  /** «Қарыз» — every live payment reversed, so the order owes its full sum again. */
  const handleMarkUnpaid = async (order: Order) => {
    const live = livePaymentsFor(order.id);
    if (live.length === 0) return;
    if (!confirm(`${order.orderNumber}: тіркелген ${formatMoney(netPaidTiyn(live))} қайтарылып, заказ қарыз болады. Жалғастырасыз ба?`)) return;
    try {
      for (const p of live) {
        await reversePayment(db, actor, { paymentId: p.id, reason: "Журналда «Қарыз» деп белгіленді" });
      }
      showToast(`✅ Қарыз — ${live.length} төлем қайтарылды`);
    } catch (err: unknown) {
      showToast("Қате: " + (err as Error).message);
    }
  };

  /**
   * «🗑 Жолды өшіру» — a row written down for a job that never came in. Refused while money is on
   * it, as on ЛДСП: struck off with payments live, that money would sit in Касса with nothing
   * pointing at it. «Қарыз деп белгілеу» in the row's menu takes the money off first.
   */
  const handleDeleteOrder = async (order: Order) => {
    const paid = netPaidTiyn(livePaymentsFor(order.id));
    if (paid > 0) {
      showToast(`⚠️ ${order.orderNumber}: ${formatMoney(paid)} төлем тіркелген. Алдымен «Қарыз деп белгілеу» арқылы төлемді қайтарыңыз — содан кейін ғана өшіруге болады.`);
      return;
    }
    if (!confirm(
      `${order.orderNumber} — ${order.customerName}\n\n`
      + (order.productionStatus === "mdf_production" ? "Бұл заказ өндірісте тұр. " : "")
      + "Осы жолды өшіресіз бе?",
    )) return;
    try {
      await cancelOrder(db, actor, order, "Журналдан өшірілді — клиент келмеді");
      showToast(`🗑 ${order.orderNumber} өшірілді`);
    } catch (err: unknown) {
      showToast("Қате: " + (err as Error).message);
    }
  };

  const methodLabelFor = (orderId: string) => {
    const payments = paymentsByOrder.get(orderId) ?? [];
    const methodId = methodIdOf([...paidByMethod(payments).keys()]);
    return methodLabelOf(methodId, methods, payments.find((p) => !p.reversed && p.methodId === methodId)?.methodName);
  };

  const exportRows = () =>
    filtered.map((o) => {
      const paid = paidOf(o.id);
      return {
        "№": o.orderNumber,
        "Клиент аты": o.customerName,
        Телефон: o.customerPhone,
        Узор: mdfPatternOf(o),
        "м²": Math.round((o.mdfAreaM2 ?? 0) * 100) / 100,
        "м² бағасы": (o.mdfPricePerM2Tiyn ?? 0) / 100,
        "Пленка түсі": o.mdfFilmColor ?? "",
        "Жалпы сома": o.totalTiyn / 100,
        Төленді: paid / 100,
        Қарыз: Math.max(0, o.totalTiyn - paid) / 100,
        "Төлем түрі": methodLabelFor(o.id),
        Өндіріс: mdfStationLabel(o),
        Күні: o.createdAt ? formatDateDMY(o.createdAt) : "",
      };
    });

  return (
    <AppShell
      title="МДФ — Тапсырыс журналы"
      subtitle="Заказдарды тіркеу және өндіріске жіберу"
      contentWidth="full"
      autoCollapse
      fab={{ onClick: openNewRow, label: "Жаңа заказ" }}
    >
      <datalist id={PATTERN_LIST_ID}>
        {templates.map((t) => (
          <option key={t.name} value={t.name}>{formatMoney(t.pricePerM2Tiyn)}/м²</option>
        ))}
      </datalist>

      <div className="journal-toolbar">
        <button className="btn btn-success btn-sm" onClick={openNewRow}>
          ＋ Жаңа заказ
        </button>
        <input
          className="journal-search"
          placeholder="Клиент, телефон, узор немесе заказ №"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPinnedPage(null);
          }}
        />
        <select className="journal-select" value={dateFilter}
          onChange={(e) => { setDateFilter(e.target.value as DateFilter); setPinnedPage(null); }}>
          <option value="all">Барлық күн</option>
          <option value="today">Бүгін</option>
          <option value="week">7 күн</option>
          <option value="month">30 күн</option>
        </select>
        {isAdmin(userData.role) && (
          <button className="btn btn-outline btn-sm" onClick={() => setShowTemplates(true)}>
            Узор шаблондары
          </button>
        )}
        <div className="journal-menu">
          <button className="btn btn-outline btn-sm" aria-haspopup="menu" aria-expanded={exportOpen}
            onClick={() => setExportOpen((v) => !v)}>
            ⭳ Экспорт ▾
          </button>
          {exportOpen && (
            <>
              <button className="journal-menu-scrim" aria-label="Мәзірді жабу" onClick={() => setExportOpen(false)} />
              <div className="journal-menu-list" role="menu">
                <button role="menuitem" onClick={() => { exportCsv("мдф-журналы", exportRows()); setExportOpen(false); }}>
                  CSV жүктеу
                </button>
                <button role="menuitem" onClick={() => { exportXlsx("мдф-журналы", exportRows()); setExportOpen(false); }}>
                  Excel жүктеу
                </button>
              </div>
            </>
          )}
        </div>
        <button className="btn btn-outline btn-sm journal-view-toggle" onClick={() => setMobileTable((v) => !v)}>
          {mobileTable ? "▤ Карта" : "▦ Кесте"}
        </button>
      </div>

      <div className="journal-chips" role="tablist" aria-label="Жылдам сүзгі">
        {MDF_QUICK_FILTERS.map((chip) => (
          <button
            key={chip.id}
            role="tab"
            aria-selected={quickFilter === chip.id}
            className={`journal-chip${quickFilter === chip.id ? " is-active" : ""}`}
            onClick={() => { setQuickFilter(chip.id); setPinnedPage(null); }}
          >
            {chip.label}
            <span className="journal-chip-count">{chipCounts[chip.id]}</span>
          </button>
        ))}
      </div>

      {/* The phone reads cards, the same as ЛДСП's; the table is one tap away via ▦ Кесте. */}
      <div className={`journal-cards${mobileTable ? " is-hidden" : ""}`}>
        {loading || paymentsLoading ? (
          <Spinner />
        ) : (
          <>
            <div className="journal-card-summary">
              <div className="journal-card-stat">
                <span>Бүгін</span>
                <strong>{summary.todayCount} заказ</strong>
              </div>
              <div className="journal-card-stat">
                <span>Жалпы</span>
                <strong>{formatMoney(summary.totalTiyn)}</strong>
              </div>
              <div className="journal-card-stat">
                <span>Төленді</span>
                <strong className="is-paid">{formatMoney(summary.paidTiyn)}</strong>
              </div>
              <div className="journal-card-stat">
                <span>Қарыз</span>
                <strong className="is-debt">{formatMoney(summary.debtTiyn)}</strong>
              </div>
            </div>
            {pageItems.length === 0 ? (
              <div className="empty-state"><div className="icon">📭</div><p>МДФ заказы табылмады</p></div>
            ) : (
              pageItems.map((order) => (
                <MdfJournalCard
                  key={order.id}
                  order={order}
                  payments={paymentsByOrder.get(order.id) ?? []}
                  methods={methods}
                  onOpenSheet={() => setSheetFor(order)}
                  onAddPayment={() => setPayFor(order)}
                  onPrice={() => setPriceFor(order)}
                  onSend={() => handleSendToProduction(order)}
                  onDelete={() => handleDeleteOrder(order)}
                />
              ))
            )}
          </>
        )}
      </div>

      <div className="journal-main">
        <div className={`journal-wrap${mobileTable ? " is-mobile-visible" : ""}`}>
          <div className="journal-scroll">
            <table className="journal-table is-mdf">
              <thead>
                <tr>
                  <th className="jt-w-who">Заказ / Клиент</th>
                  <th className="jt-w-pattern">Узор</th>
                  <th className="jt-w-area jt-num">м²</th>
                  <th className="jt-w-rate jt-num">м² бағасы</th>
                  <th className="jt-w-total jt-num">Жалпы сома</th>
                  <th className="jt-w-pay">Төлем</th>
                  <th className="jt-w-method">Төлем түрі</th>
                  <th className="jt-w-progress">Өндіріс барысы</th>
                  <th className="jt-w-date">Күні</th>
                  <th className="jt-w-act">Әрекет</th>
                </tr>
              </thead>
              <tbody
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  const el = e.target as HTMLElement;
                  if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement)) return;
                  // The unsaved new row commits on Enter — that is its own handler's job.
                  if (el.closest("tr")?.classList.contains("is-new")) return;
                  e.preventDefault();
                  moveFocusVertically(el, e.shiftKey ? -1 : 1);
                }}
              >
                {loading || paymentsLoading ? (
                  <tr><td colSpan={COLUMN_COUNT} className="jt-empty">Жүктелуде…</td></tr>
                ) : pageItems.length === 0 && !newRow ? (
                  <tr><td colSpan={COLUMN_COUNT} className="jt-empty">МДФ заказы табылмады</td></tr>
                ) : (
                  pageItems.map((order) => (
                    <MdfJournalRow
                      key={order.id}
                      order={order}
                      payments={paymentsByOrder.get(order.id) ?? []}
                      methods={methods}
                      templates={templates}
                      directory={customerDir}
                      actor={actor}
                      onOpenSheet={() => setSheetFor(order)}
                      onOpenFull={() => navigate(`/manager/order/${order.id}`)}
                      onAddPayment={() => setPayFor(order)}
                      onPrice={() => setPriceFor(order)}
                      onSend={() => handleSendToProduction(order)}
                      onMarkUnpaid={() => handleMarkUnpaid(order)}
                      onDelete={() => handleDeleteOrder(order)}
                      onError={showToast}
                    />
                  ))
                )}
                {newRow && (
                  <NewMdfJournalRow
                    draft={newRow}
                    setDraft={setNewRow}
                    directory={customerDir}
                    templates={templates}
                    nameRef={newRowNameRef}
                    saving={saving}
                    onSave={commitNewRow}
                    onCancel={cancelNewRow}
                  />
                )}
              </tbody>
            </table>
          </div>

          {!newRow && (
            <button className="journal-add-row" onClick={openNewRow}>
              ＋ Жаңа жол қосу
            </button>
          )}

          <p className="journal-keys">
            Кез келген ұяшықты басып жазыңыз — өзі сақталады. <kbd>Enter</kbd> — төменгі жол,{" "}
            <kbd>Shift</kbd>+<kbd>Enter</kbd> — жоғарғы жол. Узорды таңдасаңыз, м² бағасы өзі қойылады —
            қолмен өзгертуге болады. м²-ді бөліктерімен қосып жазуға болады: <b>2,5+3,1</b>.
          </p>

          <div className="journal-foot">
            <div className="journal-summary">
              <div className="journal-summary-item">
                <span className="journal-summary-label">Бүгін</span>
                <strong>{summary.todayCount} заказ</strong>
              </div>
              <span className="journal-summary-sep" aria-hidden="true" />
              <div className="journal-summary-item is-scope">
                <span className="journal-summary-label">Тізімде</span>
                <strong>{summary.shownCount} заказ</strong>
              </div>
              <div className="journal-summary-item">
                <span className="journal-summary-label">Жалпы</span>
                <strong>{formatMoney(summary.totalTiyn)}</strong>
              </div>
              <div className="journal-summary-item is-paid">
                <span className="journal-summary-label">Төленді</span>
                <strong>{formatMoney(summary.paidTiyn)}</strong>
              </div>
              <div className="journal-summary-item is-debt">
                <span className="journal-summary-label">Қарыз</span>
                <strong>{formatMoney(summary.debtTiyn)}</strong>
              </div>
            </div>

            <div className="journal-pagination">
              <span className="journal-page-info">
                {filtered.length === 0 ? "0" : `${pageView.from}–${pageView.to}`} / {filtered.length} заказ
              </span>
              <div className="journal-page-buttons">
                <button className="journal-page-btn" disabled={safePage <= 1} onClick={() => setPinnedPage(1)} aria-label="Бірінші бет">«</button>
                <button className="journal-page-btn" disabled={safePage <= 1} onClick={() => setPinnedPage(safePage - 1)} aria-label="Алдыңғы бет">‹</button>
                <span className="journal-page-current">{safePage}</span>
                <button className="journal-page-btn" disabled={safePage >= pageView.totalPages} onClick={() => setPinnedPage(safePage + 1)} aria-label="Келесі бет">›</button>
                <button className="journal-page-btn" disabled={safePage >= pageView.totalPages} onClick={() => setPinnedPage(null)} aria-label="Соңғы бет">»</button>
              </div>
              <select className="journal-select" value={pageSize}
                onChange={(e) => { setPageSize(Number(e.target.value)); setPinnedPage(null); }}>
                {PAGE_SIZES.map((n) => (
                  <option key={n} value={n}>{n === SHOW_ALL ? "Барлығы" : `${n} / бет`}</option>
                ))}
              </select>
            </div>
          </div>
        </div>
      </div>

      {payFor && (
        <PaymentDialog
          order={payFor}
          methods={methods}
          payments={livePaymentsFor(payFor.id)}
          remainingTiyn={Math.max(0, payFor.totalTiyn - netPaidTiyn(livePaymentsFor(payFor.id)))}
          onChangeMethod={handleChangeMethod}
          onChangeAmount={handleChangeAmount}
          onClose={() => setPayFor(null)}
          onSubmit={(legs, note) => handleAddPayment(payFor, legs, note)}
        />
      )}

      {priceFor && (
        <MdfPriceDialog order={priceFor} actor={actor} onClose={() => setPriceFor(null)} onToast={showToast} />
      )}

      {sheetFor && (
        <MdfOrderSheet
          key={sheetFor.id}
          order={orders.find((o) => o.id === sheetFor.id) ?? sheetFor}
          templates={templates}
          directory={customerDir}
          actor={actor}
          onClose={() => setSheetFor(null)}
          onSaved={(saved) => {
            setSheetFor(null);
            showToast(saved);
          }}
          onError={showToast}
        />
      )}

      {showTemplates && (
        <MdfTemplatesDialog templates={templates} actor={actor} onClose={() => setShowTemplates(false)} onToast={showToast} />
      )}

      <Toast message={message} visible={visible} />
    </AppShell>
  );
}

/**
 * The м² cell. Typed as text — «13,34» with a comma, or the pieces it was measured in, «2,5+3,1» —
 * and shown back as the sum once the cell is left. A half-typed figure never reaches the row.
 */
function AreaInput({
  value,
  onChange,
  className = "jt-input jt-input-num",
  placeholder = "—",
}: {
  value: number;
  onChange: (areaM2: number) => void;
  className?: string;
  placeholder?: string;
}) {
  const [text, setText] = useState(() => formatMdfAreaInput(value));
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!editing) setText(formatMdfAreaInput(value));
  }, [value, editing]);

  return (
    <input
      className={className}
      inputMode="decimal"
      value={text}
      placeholder={placeholder}
      aria-label="Ауданы (м²)"
      title="Бөліктерін қосып жазуға болады: 2,5+3,1"
      onFocus={(e) => {
        setEditing(true);
        e.currentTarget.select();
      }}
      onBlur={() => {
        setEditing(false);
        setText(formatMdfAreaInput(value));
      }}
      onChange={(e) => {
        setText(e.target.value);
        const parsed = parseMdfArea(e.target.value);
        if (parsed !== null) onChange(parsed);
      }}
    />
  );
}

/**
 * One МДФ ledger row — typed straight into and saved a moment after the last keystroke, as an ЛДСП
 * row is. What is typed is what a МДФ order is written down by: who, the «Узор», the м², the rate.
 */
function MdfJournalRow({
  order, payments, methods, templates, directory, actor,
  onOpenSheet, onOpenFull, onAddPayment, onPrice, onSend, onMarkUnpaid, onDelete, onError,
}: {
  order: Order;
  /** Every payment on the order, reversed ones included — the helpers below skip those. */
  payments: Payment[];
  methods: PaymentMethodDef[];
  templates: MdfPatternTemplate[];
  directory: readonly CustomerSuggestion[];
  actor: Actor;
  onOpenSheet: () => void;
  onOpenFull: () => void;
  onAddPayment: () => void;
  onPrice: () => void;
  onSend: () => void;
  onMarkUnpaid: () => void;
  onDelete: () => void;
  onError: (message: string) => void;
}) {
  const [draft, setDraft] = useState<MdfJournalDraft>(() => draftFromMdfOrder(order));
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const dirtyRef = useRef(false);

  useEffect(() => {
    if (!dirtyRef.current) setDraft(draftFromMdfOrder(order));
  }, [order]);

  useEffect(() => {
    if (!dirtyRef.current) return;
    const handle = setTimeout(async () => {
      setSaveState("saving");
      try {
        await saveMdfJournalRow(db, actor, order, draft);
        dirtyRef.current = false;
        setSaveState("saved");
      } catch (err: unknown) {
        setSaveState("error");
        onError("Сақталмады: " + (err as Error).message);
      }
    }, AUTOSAVE_MS);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  const patch = (p: Partial<MdfJournalDraft>) => {
    dirtyRef.current = true;
    setSaveState("dirty");
    setDraft((prev) => ({ ...prev, ...p }));
  };

  const paid = netPaidTiyn(payments);
  const preview = mdfDraftTotals(draft, paid);
  const byMethod = paidByMethod(payments);
  const methodId = methodIdOf([...byMethod.keys()]);
  const methodLabel = methodLabelOf(methodId, methods, payments.find((p) => !p.reversed && p.methodId === methodId)?.methodName);
  const methodBreakdown = [...byMethod.entries()]
    .map(([id, amount]) => `${payments.find((p) => !p.reversed && p.methodId === id)?.methodName ?? id}: ${formatMoney(amount)}`)
    .join(" · ");
  const notes = paymentNotes(payments);
  const priced = order.pricePublished !== false;
  const onGate = priced && PRE_PRODUCTION.includes(order.productionStatus);
  const settled = canEnterCuttingQueue(order.paymentStatus);
  const finished = order.productionStatus === "ready" || order.productionStatus === "delivered";
  const steps = mdfJournalProgress({ productionStatus: order.productionStatus, totalTiyn: preview.totalTiyn }, paid);

  return (
    <tr className={`jt-row is-${finished ? "cut" : "uncut"}`}>
      <td className="jt-w-who">
        <div className="jt-who-head">
          <button className="jt-num-link" onClick={onOpenSheet} title="Толығырақ ашу"
            aria-label={`${order.orderNumber} — толығырақ`}>№{shortOrderNumber(order.orderNumber)}</button>
        </div>
        <CustomerNameInput
          className="jt-input jt-who-name"
          value={draft.customerName}
          directory={directory}
          ariaLabel="Клиент аты"
          onChange={(name) => patch({ customerName: name })}
          onPick={(c) => patch({ customerName: c.name, ...(c.phone ? { customerPhone: c.phone } : {}) })}
        />
        <input className="jt-input jt-who-phone" value={draft.customerPhone} aria-label="Телефон"
          placeholder={order.customerPhone ? formatPhone(order.customerPhone) : "телефон"}
          onChange={(e) => patch({ customerPhone: e.target.value })} />
      </td>

      <td className="jt-w-pattern">
        <input className="jt-input" list={PATTERN_LIST_ID} value={draft.patternName} placeholder="Узор"
          aria-label="Узор" onChange={(e) => patch(patternPatch(templates, e.target.value))} />
        <input className="jt-input jt-who-phone" value={draft.filmColor} placeholder="пленка түсі"
          aria-label="Пленка түсі" onChange={(e) => patch({ filmColor: e.target.value })} />
      </td>

      <td className="jt-w-area jt-num">
        <AreaInput value={draft.areaM2} onChange={(areaM2) => patch({ areaM2 })} />
      </td>

      <td className="jt-w-rate jt-num">
        <NumberField className="jt-input jt-input-num" value={draft.pricePerM2Tiyn / 100} min={0} placeholder="—"
          ariaLabel="м² бағасы" onChange={(v) => patch({ pricePerM2Tiyn: Math.round(v * 100) })} />
      </td>

      {/* Typed by hand when the shop agrees a round figure — kept as a discount or a surcharge, so
          the area and the rate stay what they really were (lib/mdfJournalOrders.ts). */}
      <td className="jt-w-total jt-num">
        <NumberField className="jt-input jt-input-num jt-total" value={preview.totalTiyn / 100} min={0}
          ariaLabel="Жалпы сома" onChange={(v) => patch(mdfTotalOverride(draft, Math.round(v * 100)))} />
      </td>

      <td className="jt-w-pay">
        {!priced ? (
          // A customer's own order from the site arrives unpriced — the counter prices it first.
          <button className="btn btn-primary btn-sm jt-cut-btn" onClick={onPrice}>💰 Баға белгілеу</button>
        ) : (
          <>
            <button type="button" className={`jt-pay-toggle jt-pay-${preview.paymentStatus}`} onClick={onAddPayment}
              title={preview.debtTiyn > 0 ? `Қалдық ${formatMoney(preview.debtTiyn)} — төлем тіркеу` : "Төлемдер"}>
              {journalStatusLabel(preview.paymentStatus)}
            </button>
            <div className="jt-pay-note" title={methodBreakdown}>
              <span className="jt-pay-note-label">Төленді:</span>
              <span className={paid > 0 ? "jt-pay-paid is-paid" : "jt-pay-paid"}>{paid > 0 ? formatMoneyBare(paid) : "—"}</span>
              <span className="jt-pay-note-cur">₸</span>
            </div>
            {notes.length > 0 && <div className="jt-pay-comment" title={notes.join("\n")}>💬 {notes.join(" · ")}</div>}
            {preview.debtTiyn > 0 && <div className="jt-pay-owing">Қарыз: {formatMoneyBare(preview.debtTiyn)} ₸</div>}
            {preview.debtTiyn < 0 && <div className="jt-pay-owing is-over">Артық: {formatMoneyBare(-preview.debtTiyn)} ₸</div>}
          </>
        )}
      </td>

      <td className="jt-w-method">
        <button className={`jt-method-pill is-${methodTone(methodId)}`} onClick={onAddPayment} disabled={!priced}
          title={methodBreakdown || "Төлем тіркеу"}>
          {methodLabel}
        </button>
      </td>

      <td className="jt-w-progress">
        <ProgressSteps steps={steps} />
        <div className="jt-fact-note">{mdfStationLabel(order)}</div>
        {onGate && (settled ? (
          <button className="btn btn-primary btn-sm jt-cut-btn" onClick={onSend}>Өндіріске жіберу</button>
        ) : (
          <button className="btn btn-danger-outline btn-sm jt-cut-btn" onClick={onSend}
            title={`Қарызға жіберу — қалдық ${formatMoney(Math.max(0, preview.debtTiyn))}`}>
            Өндіріске жіберу · қарызға
          </button>
        ))}
      </td>

      <td className="jt-w-date">
        <input type="date" className="jt-input jt-input-date" value={dayKey(draft.orderDate)} aria-label="Заказ күні"
          onChange={(e) => patch({
            orderDate: e.target.value ? new Date(`${e.target.value}T12:00:00+05:00`) : draft.orderDate,
          })} />
      </td>

      <td className="jt-actions">
        <span className={`jt-save-dot is-${saveState}`} title={SAVE_TITLES[saveState]} aria-live="polite">
          {SAVE_GLYPHS[saveState]}
        </span>
        <button className="jt-icon-btn" onClick={onOpenSheet} title="Толығырақ" aria-label="Толығырақ ашу">›</button>
        <RowMenu
          items={[
            { label: "Толығырақ", onClick: onOpenSheet },
            { label: "Толық бетті ашу", onClick: onOpenFull },
            ...(priced ? [{ label: "Төлем тіркеу", onClick: onAddPayment }] : []),
            ...(onGate ? [{ label: settled ? "Өндіріске жіберу" : "Қарызға жіберу", onClick: onSend, danger: !settled }] : []),
            ...(paid > 0 ? [{ label: "Қарыз деп белгілеу — төлемді қайтару", onClick: onMarkUnpaid, danger: true }] : []),
            { label: "🗑 Жолды өшіру", onClick: onDelete, danger: true },
          ]}
        />
      </td>
    </tr>
  );
}

/** The new-order row, in the same columns as every saved one; ✓ or Enter adds it. */
function NewMdfJournalRow({
  draft, setDraft, directory, templates, nameRef, saving, onSave, onCancel,
}: {
  draft: MdfJournalDraft;
  setDraft: (d: MdfJournalDraft) => void;
  directory: readonly CustomerSuggestion[];
  templates: MdfPatternTemplate[];
  nameRef: RefObject<HTMLInputElement | null>;
  saving: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  const patch = (p: Partial<MdfJournalDraft>) => setDraft({ ...draft, ...p });
  const preview = mdfDraftTotals(draft, 0);

  return (
    <tr className="jt-row is-new"
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); onSave(); }
        if (e.key === "Escape") { e.preventDefault(); onCancel(); }
      }}>
      <td className="jt-w-who">
        <span className="jt-num-link is-new">жаңа</span>
        <CustomerNameInput
          className="jt-input jt-who-name"
          placeholder="Клиент аты"
          value={draft.customerName}
          directory={directory}
          inputRef={nameRef}
          ariaLabel="Клиент аты"
          onChange={(name) => patch({ customerName: name })}
          onPick={(c) => patch({ customerName: c.name, ...(c.phone ? { customerPhone: c.phone } : {}) })}
        />
        <input className="jt-input jt-who-phone" placeholder="+7 (___) ___-__-__" value={draft.customerPhone}
          aria-label="Телефон" onChange={(e) => patch({ customerPhone: e.target.value })} />
      </td>

      <td className="jt-w-pattern">
        <input className="jt-input" list={PATTERN_LIST_ID} placeholder="Узор" value={draft.patternName}
          aria-label="Узор" onChange={(e) => patch(patternPatch(templates, e.target.value))} />
        <input className="jt-input jt-who-phone" placeholder="пленка түсі" value={draft.filmColor}
          aria-label="Пленка түсі" onChange={(e) => patch({ filmColor: e.target.value })} />
      </td>

      <td className="jt-w-area jt-num">
        <AreaInput value={draft.areaM2} placeholder="м²" onChange={(areaM2) => patch({ areaM2 })} />
      </td>

      <td className="jt-w-rate jt-num">
        <NumberField className="jt-input jt-input-num" value={draft.pricePerM2Tiyn / 100} min={0} placeholder="баға"
          ariaLabel="м² бағасы" onChange={(v) => patch({ pricePerM2Tiyn: Math.round(v * 100) })} />
      </td>

      <td className="jt-w-total jt-num">
        <NumberField className="jt-input jt-input-num jt-total" value={preview.totalTiyn / 100} min={0}
          ariaLabel="Жалпы сома" onChange={(v) => patch(mdfTotalOverride(draft, Math.round(v * 100)))} />
      </td>

      {/* Money and production both need the order to exist first. */}
      <td className="jt-w-pay jt-muted">төлем — сақтағаннан кейін</td>
      <td className="jt-w-method jt-muted">—</td>

      <td className="jt-w-progress">
        {/* Never the customer's price — only the vacuum worker's pay (lib/salary.ts). */}
        <label className="jt-pvc-jointed" title="Вакуумшының айлығына бонус қосады">
          <input type="checkbox" checked={draft.packaging} onChange={(e) => patch({ packaging: e.target.checked })} />
          <span>Упаковка</span>
        </label>
      </td>

      <td className="jt-w-date">
        <input type="date" className="jt-input jt-input-date" value={dayKey(draft.orderDate)} aria-label="Заказ күні"
          onChange={(e) => patch({ orderDate: e.target.value ? new Date(`${e.target.value}T12:00:00+05:00`) : new Date() })} />
      </td>

      <td className="jt-actions">
        <button className="jt-icon-btn is-ok" disabled={saving} onClick={onSave} title="Қосу" aria-label="Жаңа заказды қосу">✓</button>
        <button className="jt-icon-btn" disabled={saving} onClick={onCancel} title="Болдырмау" aria-label="Жаңа жолды болдырмау">✕</button>
      </td>
    </tr>
  );
}

/** One order on the phone — the same card the ЛДСП journal draws, with the МДФ facts on it. */
function MdfJournalCard({
  order, payments, methods, onOpenSheet, onAddPayment, onPrice, onSend, onDelete,
}: {
  order: Order;
  payments: Payment[];
  methods: PaymentMethodDef[];
  onOpenSheet: () => void;
  onAddPayment: () => void;
  onPrice: () => void;
  onSend: () => void;
  onDelete: () => void;
}) {
  const paid = netPaidTiyn(payments);
  const debt = order.totalTiyn - paid;
  const status = computePaymentStatus(order.totalTiyn, paid);
  const methodId = methodIdOf([...paidByMethod(payments).keys()]);
  const methodLabel = methodLabelOf(methodId, methods, payments.find((p) => !p.reversed)?.methodName);
  const notes = paymentNotes(payments);
  const priced = order.pricePublished !== false;
  const onGate = priced && PRE_PRODUCTION.includes(order.productionStatus);
  const finished = order.productionStatus === "ready" || order.productionStatus === "delivered";

  return (
    <div className={`journal-card is-${finished ? "cut" : "uncut"}`}>
      <button className="journal-card-main" onClick={onOpenSheet}>
        <div className="journal-card-top">
          <strong>{order.orderNumber}</strong>
          <span className="journal-card-date">{order.createdAt ? formatDateDMY(order.createdAt) : "—"}</span>
        </div>
        <div className="journal-card-client">{order.customerName}</div>
        <div className="journal-card-facts">
          <span className="journal-card-fact">
            <IconLayers className="journal-card-fact-icon" />
            <span className="journal-card-fact-text">
              <b>{mdfPatternOf(order) || "Узор жазылмаған"}</b>
              <small>{order.mdfFilmColor || "пленка —"}</small>
            </span>
          </span>
          <span className="journal-card-fact">
            <IconReports className="journal-card-fact-icon" />
            <span className="journal-card-fact-text">
              <b>{formatMdfArea(order.mdfAreaM2)}</b>
              <small>{order.mdfPricePerM2Tiyn ? `× ${formatMoney(order.mdfPricePerM2Tiyn)}` : "баға —"}</small>
            </span>
          </span>
        </div>
        <div className="journal-card-money">
          <span className="journal-card-total">{formatMoney(order.totalTiyn)}</span>
          <span className={`jt-pill jt-pay-${status}`}>{journalStatusLabel(status)}</span>
          <span className={`jt-method-pill is-${methodTone(methodId)}`}>{methodLabel}</span>
        </div>
        {notes.length > 0 && <div className="journal-card-note">💬 {notes.join(" · ")}</div>}
        {debt > 0 && <div className="journal-card-owing">Қарыз: {formatMoney(debt)}</div>}
        {debt < 0 && <div className="journal-card-owing is-over">Артық: {formatMoney(-debt)}</div>}
        <ProgressSteps steps={mdfJournalProgress(order, paid)} compact />
        <div className="journal-card-meta"><span className="journal-card-badge">{mdfStationLabel(order)}</span></div>
        <span className="journal-card-chevron" aria-hidden="true">›</span>
      </button>

      {!priced && (
        <button className="btn btn-primary btn-full journal-card-action" onClick={onPrice}>💰 Баға белгілеу</button>
      )}
      {priced && debt > 0 && (
        <button className="btn btn-primary btn-full journal-card-action" onClick={onAddPayment}>
          💰 Төлем қабылдау · {formatMoney(debt)}
        </button>
      )}
      {onGate && (canEnterCuttingQueue(order.paymentStatus) ? (
        <button className={`btn ${debt > 0 ? "btn-outline" : "btn-primary"} btn-full journal-card-action`} onClick={onSend}>
          Өндіріске жіберу
        </button>
      ) : (
        <button className="btn btn-danger-outline btn-full journal-card-action" onClick={onSend}>
          Өндіріске жіберу · қарызға
        </button>
      ))}
      <button className="btn btn-outline btn-full journal-card-action journal-card-delete" onClick={onDelete}>
        🗑 Жолды өшіру
      </button>
    </div>
  );
}

/**
 * The whole order on a phone, where the table's cells are a sideways scroll away: the same fields,
 * typed by hand, saved with one button. It re-prices the order and leaves its payments alone.
 */
function MdfOrderSheet({
  order, templates, directory, actor, onClose, onSaved, onError,
}: {
  order: Order;
  templates: MdfPatternTemplate[];
  directory: readonly CustomerSuggestion[];
  actor: Actor;
  onClose: () => void;
  onSaved: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [draft, setDraft] = useState<MdfJournalDraft>(() => draftFromMdfOrder(order));
  const [busy, setBusy] = useState(false);
  const patch = (p: Partial<MdfJournalDraft>) => setDraft((prev) => ({ ...prev, ...p }));
  const preview = mdfDraftTotals(draft, order.paidTiyn);
  const template = findMdfPatternTemplate(templates, draft.patternName);

  const save = async () => {
    setBusy(true);
    try {
      await saveMdfJournalRow(db, actor, order, draft);
      onSaved(`✅ ${order.orderNumber} сақталды`);
    } catch (err: unknown) {
      onError("Қате: " + (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay active" onClick={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal">
        <div className="modal-handle" />
        <h2>{order.orderNumber}</h2>
        <p className="scan-hint">{mdfStationLabel(order)}</p>
        <div className="form-group">
          <label>Клиент аты</label>
          <CustomerNameInput
            value={draft.customerName}
            directory={directory}
            ariaLabel="Клиент аты"
            onChange={(name) => patch({ customerName: name })}
            onPick={(c) => patch({ customerName: c.name, ...(c.phone ? { customerPhone: c.phone } : {}) })}
          />
        </div>
        <div className="form-group">
          <label>Телефон</label>
          <input className="form-input" value={draft.customerPhone} onChange={(e) => patch({ customerPhone: e.target.value })} />
        </div>
        <div className="form-group">
          <label>Узор</label>
          <input className="form-input" list={PATTERN_LIST_ID} value={draft.patternName} placeholder="Модерн, Рифленка…"
            onChange={(e) => patch(patternPatch(templates, e.target.value))} />
        </div>
        <div className="mdf-sheet-grid">
          <div className="form-group">
            <label>Ауданы (м²)</label>
            <AreaInput className="form-input" value={draft.areaM2} placeholder="13,34" onChange={(areaM2) => patch({ areaM2 })} />
          </div>
          <div className="form-group">
            <label>м² бағасы (₸)</label>
            <NumberField value={draft.pricePerM2Tiyn / 100} min={0} ariaLabel="м² бағасы"
              onChange={(v) => patch({ pricePerM2Tiyn: Math.round(v * 100) })} />
          </div>
        </div>
        {template && draft.pricePerM2Tiyn !== template.pricePerM2Tiyn && (
          <p className="form-hint">Шаблонда {formatMoney(template.pricePerM2Tiyn)} — бұл заказға қолмен өзгертілді</p>
        )}
        <div className="form-group">
          <label>Жалпы сома (₸)</label>
          <NumberField value={preview.totalTiyn / 100} min={0} ariaLabel="Жалпы сома"
            onChange={(v) => patch(mdfTotalOverride(draft, Math.round(v * 100)))} />
        </div>
        <div className="form-group">
          <label>Пленка түсі</label>
          <input className="form-input" value={draft.filmColor} onChange={(e) => patch({ filmColor: e.target.value })} />
        </div>
        <div className="form-group">
          <label>Күні</label>
          <input type="date" className="form-input" value={dayKey(draft.orderDate)}
            onChange={(e) => patch({ orderDate: e.target.value ? new Date(`${e.target.value}T12:00:00+05:00`) : draft.orderDate })} />
        </div>
        {/* Клиент бағасын өзгертпейді — тек вакуумшының айлығына бонус қосады (lib/salary.ts). */}
        <label className="remember-me">
          <input type="checkbox" checked={draft.packaging} onChange={(e) => patch({ packaging: e.target.checked })} />
          <span className="remember-check">{draft.packaging ? "✓" : ""}</span>
          <span>Упаковка</span>
        </label>
        <div className="track-card-meta-row">
          <span>{formatMdfArea(draft.areaM2)} × {formatMoney(draft.pricePerM2Tiyn)}</span>
          <strong>{formatMoney(preview.totalTiyn)}</strong>
        </div>
        <div className="wizard-actions">
          <button className="btn btn-outline" disabled={busy} onClick={onClose}>Бас тарту</button>
          <button className="btn btn-primary" disabled={busy} onClick={save}>
            {busy ? "Сақталуда..." : "Сақтау"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * «Узор шаблондары» — the price list the journal fills an order's м² rate from. Admin-only, as
 * firestore.rules keeps applicationSettings; a rate changed here applies to orders written from now
 * on, and never re-prices one already in the journal (each order keeps its own rate).
 */
function MdfTemplatesDialog({
  templates,
  actor,
  onClose,
  onToast,
}: {
  templates: MdfPatternTemplate[];
  actor: Actor;
  onClose: () => void;
  onToast: (msg: string) => void;
}) {
  const [rows, setRows] = useState(() => templates.map((t) => ({ name: t.name, price: String(t.pricePerM2Tiyn / 100) })));
  const [busy, setBusy] = useState(false);
  const list: MdfPatternTemplate[] = rows.map((r) => ({
    name: r.name.trim(),
    pricePerM2Tiyn: Math.round((parseFloat(r.price.replace(",", ".")) || 0) * 100),
  }));
  const problem = mdfTemplatesProblem(list);
  const patch = (index: number, change: Partial<(typeof rows)[number]>) =>
    setRows(rows.map((r, i) => (i === index ? { ...r, ...change } : r)));

  const save = async () => {
    if (problem) return;
    setBusy(true);
    try {
      await updateDoc(doc(db, "applicationSettings", "global"), { mdfPatternTemplates: list });
      await logAudit(db, actor, {
        action: "settings.mdf_pattern_templates",
        entityType: "settings",
        entityId: "global",
        before: { mdfPatternTemplates: templates },
        after: { mdfPatternTemplates: list },
      });
      onToast("✅ Узор шаблондары сақталды");
      onClose();
    } catch (err: unknown) {
      onToast("Қате: " + (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay active" onClick={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal">
        <div className="modal-handle" />
        <h2>Узор шаблондары</h2>
        <p className="scan-hint">Журналда узор таңдалғанда м² бағасы осы жерден қойылады.</p>
        {rows.map((r, index) => (
          <div key={index} className="mdf-template-row">
            <input className="form-input" aria-label="Узор аты" placeholder="Узор аты" value={r.name}
              onChange={(e) => patch(index, { name: e.target.value })} />
            <input className="form-input" aria-label="м² бағасы (₸)" placeholder="м² бағасы" inputMode="decimal" value={r.price}
              onChange={(e) => patch(index, { price: e.target.value })} />
            <button type="button" className="btn btn-outline btn-sm" aria-label="Өшіру"
              onClick={() => setRows(rows.filter((_, i) => i !== index))}>✕</button>
          </div>
        ))}
        <button type="button" className="btn btn-outline btn-sm" onClick={() => setRows([...rows, { name: "", price: "" }])}>
          + Узор қосу
        </button>
        {problem && <p className="form-hint">{problem}</p>}
        <div className="wizard-actions">
          <button className="btn btn-outline" disabled={busy} onClick={onClose}>Бас тарту</button>
          <button className="btn btn-primary" disabled={busy || !!problem} onClick={save}>
            {busy ? "Сақталуда..." : "Сақтау"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Prices a customer-submitted МДФ order (area/colour given, no rate yet) before it can be paid. */
function MdfPriceDialog({
  order,
  actor,
  onClose,
  onToast,
}: {
  order: Order;
  actor: Actor;
  onClose: () => void;
  onToast: (msg: string) => void;
}) {
  const [areaM2, setAreaM2] = useState(String(order.mdfAreaM2 ?? ""));
  const [filmColor, setFilmColor] = useState(order.mdfFilmColor ?? "");
  const [priceTenge, setPriceTenge] = useState(order.mdfPricePerM2Tiyn ? order.mdfPricePerM2Tiyn / 100 : 0);
  const [packaging, setPackaging] = useState(order.mdfPackaging ?? false);
  const [busy, setBusy] = useState(false);

  const area = parseMdfArea(areaM2) ?? 0;
  const preview = computeMdfOrderTotal({
    areaM2: area,
    pricePerM2Tiyn: Math.round(priceTenge * 100),
    extraServicesTiyn: order.extraServicesTiyn ?? 0,
    deliveryCostTiyn: order.deliveryCostTiyn ?? 0,
    discountTiyn: order.discountTiyn ?? 0,
    paidTiyn: 0,
  });

  const submit = async () => {
    if (area <= 0 || priceTenge <= 0) return;
    setBusy(true);
    try {
      await publishMdfPrice(db, actor, order, {
        areaM2: area,
        pricePerM2Tiyn: Math.round(priceTenge * 100),
        filmColor,
        packaging,
      });
      onToast(`✅ ${order.orderNumber} бағаланды`);
      onClose();
    } catch (err: unknown) {
      onToast("Қате: " + (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay active" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-handle" />
        <h2>💰 Баға белгілеу</h2>
        <p className="scan-hint">
          {order.orderNumber} · {order.customerName}
        </p>
        <div className="form-group">
          <label>Ауданы (м²)</label>
          <input className="form-input" inputMode="decimal" value={areaM2} onChange={(e) => setAreaM2(e.target.value)} />
        </div>
        <div className="form-group">
          <label>Пленка түсі</label>
          <input className="form-input" value={filmColor} onChange={(e) => setFilmColor(e.target.value)} />
        </div>
        <div className="form-group">
          <label>м² бағасы (₸)</label>
          <NumberField value={priceTenge} min={0} ariaLabel="м² бағасы" onChange={setPriceTenge} />
        </div>
        {/* Клиент бағасын өзгертпейді — тек вакуумшының айлығына бонус қосады (lib/salary.ts). */}
        <label className="remember-me">
          <input type="checkbox" checked={packaging} onChange={(e) => setPackaging(e.target.checked)} />
          <span className="remember-check">{packaging ? "✓" : ""}</span>
          <span>Упаковка</span>
        </label>
        <div className="track-card-meta-row">
          <span>Жалпы сома</span>
          <strong>{formatMoney(preview.totalTiyn)}</strong>
        </div>
        <div className="wizard-actions">
          <button className="btn btn-outline" onClick={onClose}>Бас тарту</button>
          <button className="btn btn-primary" disabled={busy || area <= 0 || priceTenge <= 0} onClick={submit}>
            {busy ? "Сақталуда..." : "Жариялау"}
          </button>
        </div>
      </div>
    </div>
  );
}
