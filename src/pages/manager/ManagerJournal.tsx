import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { collection, doc, getDoc, getDocs, updateDoc, writeBatch } from "firebase/firestore";
import { db } from "../../firebase";
import { useAuth } from "../../AuthContext";
import { Spinner, Toast } from "../../components";
import { AppShell } from "../../components/layout/AppShell";
import { useToast } from "../../hooks";
import { useAllOrders } from "../../hooks/useOrders";
import { useAllPayments } from "../../hooks/usePayments";
import { useMaterials, usePvcTypes } from "../../hooks/useMaterials";
import { NumberField } from "../../components/NumberField";
import { formatMoney, formatMoneyBare } from "../../lib/money";
import { dayKey, formatDateDMY, startOfDayAlmaty } from "../../lib/dates";
import { formatPhone } from "../../lib/phone";
import { exportCsv, exportXlsx } from "../../lib/exportTable";
import { computeJournalRowTotals, netPaidTiyn, paidByMethod } from "../../lib/journal";
import { isHdfMaterial, journalDefaultsFor, pvcDefaultsFor } from "../../lib/journalPricing";
import {
  JOURNAL_QUICK_FILTERS,
  awaitingCutting,
  journalProgress,
  matchesQuickFilter,
  quickFilterCounts,
  type JournalQuickFilter,
  type ProgressStep,
} from "../../lib/journalFilters";
import {
  JOURNAL_COLUMNS,
  JOURNAL_COLUMNS_KEY,
  journalColumnCount,
  methodIdOf,
  methodLabelOf,
  methodTone,
  parseHiddenColumns,
  pvcSummary,
  sheetSummary,
  toggleHiddenColumn,
  type JournalColumnId,
} from "../../lib/journalColumns";
import { SHOW_ALL, pageWindow } from "../../lib/journalPaging";
import {
  absorbedOrdersOf,
  groupTone,
  linePrice,
  mergeChildrenByParent,
  withRangePicked,
} from "../../lib/journalGroups";
import {
  planMerge,
  describeLines,
  linesOf,
  findStrandedPayments,
  liveOrderIdFor,
  type StrandedPayment,
} from "../../lib/orderMerge";
import {
  createJournalOrder,
  draftFromOrder,
  draftHasContent,
  emptyJournalDraft,
  emptyJournalLine,
  saveJournalRow,
  totalOverrideFor,
  totalsInputFor,
  type JournalDraft,
  type JournalDraftLine,
} from "../../lib/journalOrders";
import { RowMenu } from "../../components/RowMenu";
import { CustomerNameInput } from "../../components/CustomerNameInput";
import { customerDirectory, type CustomerSuggestion } from "../../lib/customerSuggest";
import { IconCut, IconLayers, IconPvc } from "../../components/layout/icons";
import { logAudit } from "../../lib/audit";
import { reattachPayments, recordPayment, reversePayment } from "../../lib/payments";
import { enterCuttingQueue } from "../../lib/orderStatus";
import {
  canEnterCuttingQueue,
  computePaymentStatus,
  PAYMENT_STATUS_LABELS,
  PRODUCTION_STATUS_ORDER,
} from "../../lib/statuses";
import type { Material, Order, Payment, PaymentMethodDef, PaymentStatus, PvcType } from "../../types/domain";

// SHOW_ALL last: the escape hatch for "just show me everything", which is what a manager
// reaches for the first time they notice the ledger has more pages than they expected.
const PAGE_SIZES = [25, 50, 100, SHOW_ALL];

/** "ORD-2026-000008" → "8". The year and the padding are the same on every row of the page. */
function shortOrderNumber(orderNumber: string): string {
  return orderNumber.match(/(\d+)$/)?.[1]?.replace(/^0+/, "") ?? orderNumber;
}

/** Stable empty list, so an ordinary row never re-renders for a new array of nothing. */
const EMPTY_ORDERS: Order[] = [];

/** Stable empty set, so "everything visible" never re-renders the table for a new object. */
const NOTHING_HIDDEN: ReadonlySet<JournalColumnId> = new Set<JournalColumnId>();

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

/** What the Статус cell offers. "Қарыз" is the shop's word for an unpaid row, and picking it is
 *  what puts the order on the debt ledger. */
type PaymentChoice = "paid" | "partial" | "unpaid";
/**
 * Spelled out, not abbreviated. "Жарт." saved four characters and cost the column its meaning:
 * the one thing a payment status has to do is say, unmistakably, whether money is still owed.
 *
 * These are the journal's own words, deliberately blunter than PAYMENT_STATUS_LABELS: "Қарыз" is
 * what the shop calls an unpaid row and what the debt ledger is titled, where the shared label
 * says the softer "Төленбеді". The phone card reads from the same map so one order does not
 * describe itself two ways on two screens.
 */
const JOURNAL_STATUS_LABELS: Partial<Record<PaymentStatus, string>> = {
  paid: "Толық төленді",
  partial: "Жартылай төленді",
  unpaid: "Қарыз",
};

function journalStatusLabel(status: PaymentStatus): string {
  return JOURNAL_STATUS_LABELS[status] ?? PAYMENT_STATUS_LABELS[status];
}

const PAYMENT_CHOICES: { value: PaymentChoice; label: string }[] = [
  { value: "paid", label: JOURNAL_STATUS_LABELS.paid! },
  { value: "partial", label: JOURNAL_STATUS_LABELS.partial! },
  { value: "unpaid", label: JOURNAL_STATUS_LABELS.unpaid! },
];

type DateFilter = "all" | "today" | "week" | "month";

/** Same shape as OrderActionPanels.tsx's own constant — the stages a row still has to be pushed
 *  out of before it reaches the cutting queue by any route. */
const QUEUE_STAGE_STATUSES: Order["productionStatus"][] = ["waiting_payment", "partially_paid", "paid"];

/** "Today" means today in Asia/Almaty (the shop's clock), not the browser's local midnight. */
function startOfToday(): number {
  return startOfDayAlmaty().getTime();
}

/**
 * Paper-ledger order: oldest first, №1 at the top.
 *
 * Every journal row of a given day carries the same 12:00 stamp (the manager picks a date, not a
 * time), so a date-only sort leaves same-day rows in whatever order the live query happened to
 * deliver them — which is why the list used to reshuffle on every update. The order number is
 * sequential and unique, so it settles the tie and pins the row for good.
 */
function byLedgerOrder(a: Order, b: Order): number {
  const at = a.createdAt?.seconds ?? 0;
  const bt = b.createdAt?.seconds ?? 0;
  if (at !== bt) return at - bt;
  return a.orderNumber.localeCompare(b.orderNumber);
}

/**
 * Excel's vertical movement, which a grid of inputs does not get for free.
 *
 * Enter steps down the same column, Shift+Enter steps up — so a whole column of sheet counts is
 * typed without ever reaching for the mouse. Tab already walks across a row, and the arrow keys
 * are deliberately left alone: inside a number input they nudge the value, and stealing them
 * would make the ledger fight the person typing in it.
 */
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
  const { payments, loading: paymentsLoading } = useAllPayments();
  const { materials } = useMaterials(false);
  // Active colours only: the journal is where new work is priced, and a retired roll should not be
  // offered for it. An order already carrying a retired colour still names it (see the cell).
  const { pvcTypes } = usePvcTypes(true);
  const { message, visible, showToast } = useToast();

  const [searchParams] = useSearchParams();
  const [methods, setMethods] = useState<PaymentMethodDef[]>([]);
  // Seeded from ?q= so "Заказдарын көру →" on the debt ledger lands here pre-filtered.
  const [search, setSearch] = useState(() => searchParams.get("q") ?? "");
  const [dateFilter, setDateFilter] = useState<DateFilter>("all");
  const [quickFilter, setQuickFilter] = useState<JournalQuickFilter>("all");
  /** Which row the detail panel is showing, if any. */
  const [openId, setOpenId] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [columnsOpen, setColumnsOpen] = useState(false);
  /**
   * Which columns this manager has put away, remembered between visits.
   *
   * Splitting Құрамы into Лист саны and ПВХ, and pulling Төлем түрі out of the payment cell, made
   * the ledger wide enough to be worth pruning — a manager who never takes ПВХ work should not
   * scroll past that column all day. Identity, money and the action button are not hideable, so
   * no setting can leave a row that cannot be read or acted on.
   */
  const [hiddenColumns, setHiddenColumns] = useState<ReadonlySet<JournalColumnId>>(
    () => parseHiddenColumns(localStorage.getItem(JOURNAL_COLUMNS_KEY)),
  );
  useEffect(() => {
    localStorage.setItem(JOURNAL_COLUMNS_KEY, JSON.stringify([...hiddenColumns]));
  }, [hiddenColumns]);
  /** "Барлық төлем" — narrows to how the money actually came in, which the chips do not cover. */
  const [methodFilter, setMethodFilter] = useState("all");
  // Null means "wherever the newest rows are". With the oldest order first, that is the last page —
  // a ledger opens at today, not at the day it was started. Paging by hand pins a page until the
  // filters change.
  const [pinnedPage, setPinnedPage] = useState<number | null>(null);
  /**
   * Remembered, so "барлығын көрсету" is a decision made once rather than every morning.
   * Validated against PAGE_SIZES: a stale value from an older build must not leave the ledger
   * paging by some size the dropdown can no longer show.
   */
  const [pageSize, setPageSize] = useState(() => {
    const stored = Number(localStorage.getItem("journalPageSize"));
    return PAGE_SIZES.includes(stored) ? stored : 50;
  });
  useEffect(() => {
    localStorage.setItem("journalPageSize", String(pageSize));
  }, [pageSize]);

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
  /** Method the Статус toggle reuses, so settling an order is one tap after the first time. */
  const [defaultMethodId, setDefaultMethodId] = useState(
    () => localStorage.getItem("journalDefaultMethod") ?? "",
  );

  /**
   * Rows opened up to show their material lines at their own prices.
   *
   * This is what the customer at the counter is shown — "Ақ: 8 лист × 16 000 ₸" — and what makes a
   * merged order readable again: its lines still name the row each was typed on, so the orders
   * folded into it can be read back off the survivor instead of vanishing with it.
   */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const toggleExpanded = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  /** Rows ticked for merging into one order. */
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  /** Where the last tick happened, so Shift can take everything from there to here. */
  const [pickAnchor, setPickAnchor] = useState<string | null>(null);
  const togglePick = (id: string) => {
    setPickAnchor(id);
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  /**
   * Shift-click: everything from the last tick to this one, the way a spreadsheet does it.
   *
   * A walk-in's rows are typed one after another, so the set to merge is almost always a run —
   * ticking six boxes one at a time was the slow way to say "these six". With no anchor yet this
   * is an ordinary tick.
   */
  const pickRangeTo = (id: string, pageIds: string[]) => {
    if (!pickAnchor) {
      togglePick(id);
      return;
    }
    setPicked((prev) => withRangePicked(prev, pageIds, pickAnchor, id));
    setPickAnchor(id);
  };

  const [newRow, setNewRow] = useState<JournalDraft | null>(null);
  const newRowNameRef = useRef<HTMLInputElement>(null);
  const newRowOpen = newRow !== null;

  /**
   * Opening the new-order row is additive, never destructive.
   *
   * This button used to toggle: pressing it with a half-typed row already open threw the typing
   * away without asking. Pressing it again is now simply "take me to the row I am filling in".
   */
  const openNewRow = () => {
    // The row is a row of the ledger table, which a phone hides in favour of the card list — open
    // it there and the button would look broken. Switching views is what actually shows the row.
    if (typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches) {
      setMobileTable(true);
    }
    if (newRow) {
      newRowNameRef.current?.focus();
      newRowNameRef.current?.scrollIntoView({ block: "center" });
      return;
    }
    setNewRow(emptyJournalDraft());
  };

  /** ✕ and Escape both land here, so neither can silently drop a row with typing in it. */
  const cancelNewRow = () => {
    if (newRow && draftHasContent(newRow) && !confirm("Толтырылған жол сақталмай өшеді. Болдырмайсыз ба?")) {
      return;
    }
    setNewRow(null);
  };

  useEffect(() => {
    getDocs(collection(db, "paymentMethods"))
      .then((snap) => setMethods(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<PaymentMethodDef, "id">) }))))
      .catch(() => setMethods([]));
  }, []);

  // Keyed on "is the row open", not on the draft object: the draft is replaced on every keystroke,
  // so depending on it would yank the cursor back to the name field mid-typing.
  useEffect(() => {
    if (newRowOpen) newRowNameRef.current?.focus();
  }, [newRowOpen]);

  const materialsById = useMemo(() => new Map(materials.map((m) => [m.id, m])), [materials]);
  const pvcTypesById = useMemo(() => new Map(pvcTypes.map((p) => [p.id, p])), [pvcTypes]);
  const catalog = useMemo(() => ({ materials: materialsById, pvcTypes: pvcTypesById }), [materialsById, pvcTypesById]);


  /**
   * Every customer the ledger has ever written down, for the name cell to complete from.
   *
   * Built from the whole order history rather than the filtered page: a customer who last came in
   * six months ago is exactly the one whose name nobody remembers how to spell.
   */
  const customerDir = useMemo(() => customerDirectory(orders), [orders]);

  /** absorbed order id → the order it was folded into, for every merge the ledger has seen. */
  const mergedInto = useMemo(() => {
    const map = new Map<string, string>();
    for (const o of orders) if (o.mergedIntoOrderId) map.set(o.id, o.mergedIntoOrderId);
    return map;
  }, [orders]);

  /**
   * Payments grouped by the order that is actually live.
   *
   * Merging cancels the absorbed rows and hides them, so a payment still attached to one is money
   * the ledger cannot see — which is what made three fully-settled rows report 105 500 ₸ of debt
   * that the page footer disagreed with. Rolling up through `mergedIntoOrderId` makes every figure
   * on screen right immediately; `stranded` below is the same problem in the stored data, and
   * `attachPayments` is what fixes that for good.
   */
  const paymentsByOrder = useMemo(() => {
    const map = new Map<string, Payment[]>();
    for (const p of payments) {
      const id = liveOrderIdFor(p.orderId, mergedInto);
      const list = map.get(id);
      if (list) list.push(p);
      else map.set(id, [p]);
    }
    return map;
  }, [payments, mergedInto]);

  const stranded = useMemo(() => findStrandedPayments(orders, payments), [orders, payments]);

  const livePaymentsFor = (orderId: string) =>
    (paymentsByOrder.get(orderId) ?? []).filter((p) => !p.reversed);


  /**
   * Everything the date box and the search box let through — the population the chips count.
   *
   * Split from `filtered` deliberately: a chip that said "Қарыз 4" only when Қарыз was already
   * selected would be useless, so the counts are taken before the chip narrows anything.
   */
  const inScope = useMemo(() => {
    const q = search.trim().toLowerCase();
    const todayStart = startOfToday();
    const cutoff =
      dateFilter === "today" ? todayStart
      : dateFilter === "week" ? todayStart - 6 * 86400000
      : dateFilter === "month" ? todayStart - 29 * 86400000
      : null;

    return orders.filter((o) => {
      if (o.productionStatus === "draft") return false; // never submitted — not journal material
      // Folded into another order by "Біріктіру": kept in the database, but it is that order's
      // business now, not a row of its own.
      if (o.mergedIntoOrderId) return false;
      if (q && !(o.orderNumber.toLowerCase().includes(q) || o.customerName.toLowerCase().includes(q) || o.customerPhone.includes(q))) {
        return false;
      }
      if (cutoff !== null) {
        const ms = o.createdAt ? o.createdAt.toMillis() : 0;
        if (ms < cutoff) return false;
      }
      if (methodFilter !== "all") {
        // Judged on the payments, like every other figure here — a row's stored method would be
        // wrong the moment a payment is reversed or re-filed by a merge.
        const id = methodIdOf([...paidByMethod(paymentsByOrder.get(o.id) ?? []).keys()]);
        if (methodFilter === "none" ? id !== null : id !== methodFilter) return false;
      }
      return true;
    }).sort(byLedgerOrder);
  }, [orders, search, dateFilter, methodFilter, paymentsByOrder]);

  const paidFor = useCallback(
    (order: Order) => netPaidTiyn(paymentsByOrder.get(order.id) ?? []),
    [paymentsByOrder],
  );

  const chipCounts = useMemo(() => quickFilterCounts(inScope, paidFor), [inScope, paidFor]);

  const filtered = useMemo(
    () => (quickFilter === "all" ? inScope : inScope.filter((o) => matchesQuickFilter(o, paidFor(o), quickFilter))),
    [inScope, quickFilter, paidFor],
  );

  /**
   * The row the detail panel is showing, resolved from the live order list rather than kept as a
   * snapshot — an edit made in the panel has to come straight back to it. Looked up across every
   * order, not just the filtered page, so changing a chip does not slam the panel shut on the row
   * being worked on.
   */
  const openOrder = useMemo(
    () => (openId ? (orders.find((o) => o.id === openId) ?? null) : null),
    [orders, openId],
  );

  // Not named `window`: this component also asks the real one about the phone breakpoint.
  const pageView = pageWindow(filtered.length, pageSize, pinnedPage);
  const { page: safePage, totalPages } = pageView;
  const pageItems = pageView.to === 0 ? EMPTY_ORDERS : filtered.slice(pageView.from - 1, pageView.to);
  /** In screen order, so a Shift-click range follows what the eye sees. */
  const pageIds = useMemo(() => pageItems.map((o) => o.id), [pageItems]);

  /**
   * Which rows were folded into each surviving order.
   *
   * Built once for the page rather than per row: `orders` holds the absorbed rows too (only
   * `inScope` hides them), so this is the record of every merge the ledger has ever made.
   */
  const absorbedByParent = useMemo(() => {
    const children = mergeChildrenByParent(orders);
    const map = new Map<string, Order[]>();
    for (const o of pageItems) {
      const absorbed = absorbedOrdersOf(o.id, children);
      if (absorbed.length > 0) map.set(o.id, absorbed);
    }
    return map;
  }, [pageItems, orders]);

  /**
   * The footer totals, summed from the same numbers the rows show.
   *
   * They used to read `order.paidTiyn` while each row derived its own figure from the payments —
   * so a merged row could show 48 000 ₸ owing while the footer, counting the same order's stored
   * total, said the day was settled. One source now: the payments, rolled up per live order.
   */
  const summary = useMemo(() => {
    const todayStart = startOfToday();
    let paidTiyn = 0;
    let debtTiyn = 0;
    for (const o of filtered) {
      const paid = netPaidTiyn(paymentsByOrder.get(o.id) ?? []);
      paidTiyn += paid;
      debtTiyn += Math.max(0, o.totalTiyn - paid);
    }
    return {
      todayCount: filtered.filter((o) => (o.createdAt?.toMillis() ?? 0) >= todayStart).length,
      totalTiyn: filtered.reduce((s, o) => s + o.totalTiyn, 0),
      paidTiyn,
      debtTiyn,
    };
  }, [filtered, paymentsByOrder]);

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
      await createJournalOrder(db, actor, newRow, catalog);
      showToast("✅ Жаңа заказ қосылды");
      setNewRow(emptyJournalDraft());
    } catch (err: unknown) {
      showToast("Қате: " + (err as Error).message);
    }
    setSaving(false);
  };

  /**
   * Files any payment still attached to a row that was merged away onto the order that is live.
   *
   * The ledger already *shows* the rolled-up figure, so this is not what makes the screen right —
   * it is what makes the stored data right, and it runs before anything reverses or replaces a
   * payment: reversing a payment updates whichever order the payment itself points at, so acting
   * on a stranded one would credit a cancelled row and leave the live one wrong.
   */
  const attachPayments = async (moves: StrandedPayment[]): Promise<void> => {
    if (moves.length === 0) return;
    const netPaidByOrderId = new Map<string, number>();
    for (const id of new Set(moves.map((m) => m.toOrderId))) {
      netPaidByOrderId.set(id, netPaidTiyn(paymentsByOrder.get(id) ?? []));
    }
    await reattachPayments(db, actor, { moves, netPaidByOrderId });
  };

  const handleRepairPayments = async () => {
    try {
      await attachPayments(stranded);
      showToast(`✅ ${stranded.length} төлем өз заказына қайтарылды`);
    } catch (err: unknown) {
      showToast("Қате: " + (err as Error).message);
    }
  };

  /**
   * The Статус cell is a choice, not a read-out — whatever is picked, the money is made to match:
   *
   *   Қарыз      every live payment is reversed, so the order owes its full sum again and shows up
   *              on the debt ledger immediately
   *   Төленді    the remainder is recorded; an overpaid row is rewritten as exactly the total,
   *              which is what made "Артық төленді" impossible to correct from here before
   *   Жартылай   opens the payment dialog to type what actually came in
   *
   * Reversal writes a reason and an audit entry exactly as an Admin's would (firestore.rules lets
   * a Manager set `reversed`, never clear it).
   */
  const reverseLivePayments = async (order: Order, reason: string): Promise<number> => {
    // Anything the merge left behind has to be re-filed first, or it survives the reversal and
    // the row springs back to "paid" the moment the query refreshes.
    await attachPayments(stranded.filter((m) => m.toOrderId === order.id));
    const live = livePaymentsFor(order.id);
    for (const p of live) {
      await reversePayment(db, actor, { paymentId: p.id, reason });
    }
    return live.length;
  };

  const handleSetPaymentState = async (order: Order, choice: PaymentChoice) => {
    const paid = netPaidTiyn(livePaymentsFor(order.id));
    const remaining = order.totalTiyn - paid;
    try {
      if (choice === "unpaid") {
        const reversed = await reverseLivePayments(order, "Журналда «Қарыз» деп белгіленді");
        showToast(reversed > 0 ? `✅ Қарыз — ${reversed} төлем қайтарылды` : "✅ Қарыз деп белгіленді");
        return;
      }

      if (choice === "paid") {
        if (remaining < 0) {
          if (!confirm(
            `Артық төленген: ${formatMoney(-remaining)}. Тіркелген төлемдер қайтарылып, орнына дәл ${formatMoney(order.totalTiyn)} жазылады. Жалғастырасыз ба?`,
          )) return;
          // Keep the money where it came in by: the correction is about the amount, not the method.
          const live = livePaymentsFor(order.id);
          const methodId = live[live.length - 1]?.methodId ?? defaultMethodId;
          const method = methods.find((m) => m.id === methodId);
          await reverseLivePayments(order, "Артық төлем түзетілді");
          if (order.totalTiyn > 0 && method) {
            await recordPayment(db, actor, {
              orderId: order.id,
              amountTiyn: order.totalTiyn,
              methodId: method.id,
              methodName: method.name,
              comment: "Артық төлем түзетілді",
            });
          }
          showToast("✅ Артық төлем түзетілді");
          return;
        }

        if (remaining <= 0) return; // already settled to the tenge
        const remembered = methods.find((m) => m.id === defaultMethodId);
        if (!remembered) {
          setPayFor(order); // first use — let the method be chosen, then remember it
          return;
        }
        await handleAddPayment(order, remembered.id, remaining);
        return;
      }

      // Жартылай: a part payment replaces whatever is on the order, so a settled row is cleared
      // first and the manager types the real figure into the dialog.
      if (paid > 0 && remaining <= 0) {
        if (!confirm("Тіркелген төлемдер қайтарылып, жаңа сома жазылады. Жалғастырасыз ба?")) return;
        await reverseLivePayments(order, "Жартылай төлемге өзгертілді");
      }
      setPayFor(order);
    } catch (err: unknown) {
      showToast("Қате: " + (err as Error).message);
    }
  };

  /**
   * The Төленген cell, typed into directly — "бәрі қолмен жөнделетіндей".
   *
   * Excel lets you correct a figure in place, and this is the closest an audited ledger can get to
   * that. Typing MORE records the difference as a new payment, which is the ordinary case: a
   * customer came back and paid the rest. Typing LESS cannot un-take money that was recorded, so
   * it reverses what is on the order and re-records the typed figure — the same correction the
   * "Жартылай" choice already performs, minus the dialog. Both leave the full trail.
   */
  const handleSetPaid = async (order: Order, targetTiyn: number) => {
    const live = livePaymentsFor(order.id);
    const paid = netPaidTiyn(live);
    if (targetTiyn === paid) return;

    const method =
      methods.find((m) => m.id === live[live.length - 1]?.methodId) ??
      methods.find((m) => m.id === defaultMethodId);
    if (!method) {
      // Nothing has ever been taken on this order and no method is remembered — the dialog is
      // where that gets chosen, and it opens with the typed amount already in it.
      setPayFor(order);
      return;
    }

    try {
      if (targetTiyn > paid) {
        await handleAddPayment(order, method.id, targetTiyn - paid);
        return;
      }
      if (!confirm(
        `Тіркелген ${formatMoney(paid)} қайтарылып, орнына ${formatMoney(targetTiyn)} жазылады. Жалғастырасыз ба?`,
      )) return;
      await reverseLivePayments(order, "Журналда төленген сома түзетілді");
      if (targetTiyn > 0) {
        await recordPayment(db, actor, {
          orderId: order.id,
          amountTiyn: targetTiyn,
          methodId: method.id,
          methodName: method.name,
          comment: "Журналда түзетілді",
        });
      }
      showToast("✅ Төленген сома түзетілді");
    } catch (err: unknown) {
      showToast("Қате: " + (err as Error).message);
    }
  };

  /**
   * "Біріктіру" — folds the ticked rows into one order.
   *
   * The journal is a row-per-material ledger, so a walk-in buying Ақ + ХДФ + Кашемир produces
   * three rows and, before this, three separate orders reaching the cutter. Merging keeps the
   * earliest row (so the customer keeps the number they were told), moves the rest in as material
   * lines, and cancels the absorbed rows rather than deleting them — a number that was quoted to
   * a customer should stay findable, and deleting financial records is not something this app does.
   */
  const handleMerge = async () => {
    const rows = orders.filter((o) => picked.has(o.id));
    const result = planMerge(rows);
    if ("refusal" in result) {
      showToast(result.refusal);
      return;
    }
    const { plan } = result;
    const keep = rows.find((o) => o.id === plan.keepId);
    const summary = describeLines(plan.update.items);
    if (!confirm(`${rows.length} жол «${keep?.orderNumber}» заказына біріктіріледі:\n\n${summary}\n\nЖалғастырасыз ба?`)) return;

    setSaving(true);
    try {
      const batch = writeBatch(db);
      batch.update(doc(db, "orders", plan.keepId), plan.update);
      for (const id of plan.absorbedIds) {
        batch.update(doc(db, "orders", id), {
          productionStatus: "cancelled",
          cancelReason: `${keep?.orderNumber} заказына біріктірілді`,
          mergedIntoOrderId: plan.keepId,
        });
        // The money follows the order. plan.update already sums the absorbed rows' paidTiyn onto
        // the survivor, so leaving the payment documents pointing at a cancelled row is what used
        // to make a settled merged order read as still owing.
        for (const p of paymentsByOrder.get(id) ?? []) {
          // `p.orderId`, not `id`: a row being merged may itself hold payments still filed under a
          // row IT absorbed earlier, and the trail has to name where the payment actually sits —
          // which is also the exact equality firestore.rules checks before allowing the move.
          batch.update(doc(db, "payments", p.id), { orderId: plan.keepId, mergedFromOrderId: p.orderId });
        }
      }
      await batch.commit();
      setPicked(new Set());
      setPickAnchor(null);
      // Opened straight away: a merge that made three rows become one used to look like two rows
      // being deleted. The survivor now unfolds into the orders it was made of, in its own colour.
      setExpanded((prev) => new Set(prev).add(plan.keepId));
      showToast(`✅ ${rows.length} жол біріктірілді — «${keep?.orderNumber}» ішінен көріңіз`);
    } catch (err: unknown) {
      showToast("Қате: " + (err as Error).message);
    }
    setSaving(false);
  };

  /**
   * A journal row is a walk-in the manager has already agreed and just took the money for, so
   * nothing is left to review: settling it here sends the order straight on to the shop floor
   * instead of leaving it parked one manual step short of the cutting queue. The PVC worker sees
   * the same order the moment it is queued (PVC_VISIBLE_STATUSES in hooks/useOrders.ts), so both
   * stages pick it up at once — PVC starts its own work when the cutter is done, as before.
   *
   * Returns what to append to the payment toast, and never throws: a queue problem must not read
   * as a failed payment, because the money is already recorded by the time this runs.
   */
  const queueAfterPayment = async (orderId: string): Promise<string> => {
    try {
      const snap = await getDoc(doc(db, "orders", orderId));
      if (!snap.exists()) return "";
      const fresh = { id: snap.id, ...(snap.data() as Omit<Order, "id">) };
      // Anything already on the shop floor, or still short of full payment, stays where it is.
      if (fresh.productionStatus !== "paid" || !canEnterCuttingQueue(fresh.paymentStatus)) return "";
      // Queueing reserves the sheets, which needs a real material — a row typed without one is
      // paid but cannot be cut yet, and the manager has to say what it is made of first.
      if (!fresh.materialId) return " · лист түрі таңдалмаған, кезекке қосылмады";

      const queuePosition = orders.filter((o) => o.productionStatus === "cutting_queue").length + 1;
      await enterCuttingQueue(db, actor, fresh, { isAdmin: false, queuePosition });
      return fresh.pvcMetersTotal > 0 ? " · распил мен ПВХ кезегінде" : " · распил кезегінде";
    } catch (err: unknown) {
      return " · кезекке қосылмады: " + (err as Error).message;
    }
  };

  const computeQueuePosition = (orderId: string) =>
    orders.filter((o) => o.productionStatus === "cutting_queue" && o.id !== orderId).length + 1;

  /** "📦 Кесуге" — the order is already fully paid, so nothing more needs to be asked. */
  const handleQueueOrder = async (order: Order) => {
    try {
      await enterCuttingQueue(db, actor, order, { isAdmin: false, queuePosition: computeQueuePosition(order.id) });
      // One button covers both stations: cutting_queue is in PVC_VISIBLE_STATUSES, so the ПВХ
      // worker has the order from the same moment the cutter does and starts once the saw is
      // done. Saying so is the point — the manager was asking for a second button for it.
      showToast(order.pvcMetersTotal > 0
        ? "✅ Распил және ПВХ кезегіне жіберілді"
        : "✅ Распил кезегіне жіберілді");
    } catch (err: unknown) {
      showToast("Қате: " + (err as Error).message);
    }
  };

  /**
   * "⚠️ Қарызға жіберу" — one click, no dialogs.
   *
   * Cutting on credit for a trusted customer is an everyday decision at this counter, not an
   * exception to be talked out of: a confirm plus a typed reason meant three interruptions for
   * something the manager had already decided by the time they reached for the button. The trail
   * is unchanged — `paymentGateOverride` and a reason are still written on the order (firestore
   * .rules requires both), plus a status-history entry and an audit entry naming who did it and
   * how much was outstanding. The reason is now filled in rather than asked for; a manager who
   * wants to record something specific still types it on the order page.
   */
  const handleOverrideQueueOrder = async (order: Order) => {
    const owed = Math.max(0, order.totalTiyn - netPaidTiyn(livePaymentsFor(order.id)));
    try {
      await enterCuttingQueue(db, actor, order, {
        isAdmin: true,
        overrideReason: `Журналдан қарызға жіберілді — қалдық ${formatMoney(owed)}`,
        queuePosition: computeQueuePosition(order.id),
      });
      showToast(`⚠️ Қарызға жіберілді — ${formatMoney(owed)} қарыз (аудитте тіркелді)`);
    } catch (err: unknown) {
      showToast("Қате: " + (err as Error).message);
    }
  };

  /**
   * Corrects which method a recorded payment came in by — cash entered as Kaspi, a transfer that
   * turned out to be Бәлім. No money moves, so this is not a reversal and does not wait for an
   * Admin: firestore.rules lets a Manager change these two fields and nothing else.
   */
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
      const queued = await queueAfterPayment(order.id);
      // Remembered so the Статус toggle can settle the next order without asking again.
      setDefaultMethodId(method.id);
      localStorage.setItem("journalDefaultMethod", method.id);
      showToast(`✅ Төлем тіркелді — ${method.name}${queued}`);
      setPayFor(null);
    } catch (err: unknown) {
      showToast("Қате: " + (err as Error).message);
    }
  };

  /**
   * One export row per MATERIAL LINE, not per order.
   *
   * A merged order exported as a single row had to pick one material name and one sheet price for
   * what were two different sheets at two different rates — unreadable in Excel and impossible to
   * sum. Each line now gets its own row carrying the order's number and customer, and the
   * order-level money (total, paid, debt) is written once, on the first of its lines, so a column
   * sum in Excel is still the day's real figure.
   */
  const exportRows = () =>
    filtered.flatMap((o) => {
      const byMethod = paidByMethod(paymentsByOrder.get(o.id) ?? []);
      const paid = netPaidTiyn(paymentsByOrder.get(o.id) ?? []);
      const stages = stageStates(o);
      const lines = linesOf(o);
      return lines.map((line, index) => ({
        "№": o.orderNumber,
        "Клиент аты": o.customerName,
        Телефон: o.customerPhone,
        "Лист түрі": line.materialName || o.materialSnapshot.name,
        "Лист саны": line.sheetQty,
        "Лист бағасы": line.sheetPriceTiyn / 100,
        "ПВХ, м": line.pvcMeters,
        // The colour is per line, so it belongs on the line's own row — this is what makes the
        // export sum by colour in Excel as well as on the ПВХ report.
        "ПВХ түсі": line.pvcColorName ?? "",
        "ПВХ 1 м бағасы": line.pvcPricePerMeterTiyn / 100,
        "Жалпы ПВХ": Math.round(line.pvcMeters * line.pvcPricePerMeterTiyn) / 100,
        // Order-level figures belong to the order, so only its first line carries them.
        "Есептелген сома": index === 0 ? o.totalTiyn / 100 : "",
        Статус: index === 0 ? PAYMENT_STATUS_LABELS[o.paymentStatus] : "",
        Күні: o.createdAt ? formatDateDMY(o.createdAt) : "",
        ...Object.fromEntries(
          METHOD_COLUMNS.map((m) => [m.label, index === 0 ? (byMethod.get(m.id) ?? 0) / 100 : ""]),
        ),
        Төленген: index === 0 ? paid / 100 : "",
        Қалдық: index === 0 ? Math.max(0, o.totalTiyn - paid) / 100 : "",
        Распил: index === 0 ? stages.cutting.label : "",
        ПВХ: index === 0 ? stages.pvc.label : "",
        Дайын: index === 0 ? stages.ready.label : "",
      }));
    });

  /**
   * Which columns are actually on screen right now.
   *
   * The unsaved "жаңа заказ" row is typed straight into these cells, so a hidden ПВХ column would
   * mean a walk-in with edge banding could not be entered at all. Opening that row reveals every
   * column for as long as it is open; the manager's own choice comes back the moment it closes.
   */
  const activeHidden = newRow ? NOTHING_HIDDEN : hiddenColumns;
  const shownColumns = JOURNAL_COLUMNS.filter((col) => !activeHidden.has(col.id));
  const bodyColSpan = journalColumnCount(activeHidden);

  const toolbar = (
    <>
      <div className="journal-toolbar">
        <button className="btn btn-success btn-sm" onClick={openNewRow}>
          ＋ Жаңа заказ
        </button>
        {stranded.length > 0 && (
          <button className="btn btn-danger-outline btn-sm journal-repair" disabled={saving} onClick={handleRepairPayments}
            title="Біріктірілген заказдардың төлемдері өз жолында тұрмаған — бір рет басып түзетіңіз">
            ⚠ {stranded.length} төлемді орнына қайтару
          </button>
        )}
        {picked.size > 0 && (
          <>
            <button className="btn btn-primary btn-sm" disabled={saving} onClick={handleMerge}>
              ⧉ {picked.size} жолды біріктіру
            </button>
            <button className="btn btn-outline btn-sm" onClick={() => setPicked(new Set())}>
              Таңдауды алу
            </button>
          </>
        )}
        <input
          className="journal-search"
          placeholder="Клиент, телефон немесе заказ №"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPinnedPage(null);
          }}
        />
        <select className="journal-select" value={dateFilter} onChange={(e) => { setDateFilter(e.target.value as DateFilter); setPinnedPage(null); }}>
          <option value="all">Барлық күн</option>
          <option value="today">Бүгін</option>
          <option value="week">7 күн</option>
          <option value="month">30 күн</option>
        </select>

        {/* Not a second copy of the Қарыз chip: that one asks whether money is still owed, this
            one asks which pot it landed in — the question behind "how much came in on Kaspi
            today?", which the chips never answered. */}
        <select className="journal-select" value={methodFilter}
          onChange={(e) => { setMethodFilter(e.target.value); setPinnedPage(null); }}
          aria-label="Төлем түрі бойынша сүзу">
          <option value="all">Барлық төлем</option>
          {methods.filter((m) => !m.isMixed).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          <option value="mixed">Аралас</option>
          <option value="none">Таңдалмаған</option>
        </select>

        {/* Ten columns fit the shop that does sheets and ПВХ and takes money five ways. A shop
            that does not can put the rest away here, and it stays away. */}
        <div className="journal-menu">
          <button className="btn btn-outline btn-sm" aria-haspopup="menu" aria-expanded={columnsOpen}
            onClick={() => setColumnsOpen((v) => !v)}>
            ▦ Бағандар
          </button>
          {columnsOpen && (
            <>
              <button className="journal-menu-scrim" aria-label="Мәзірді жабу" onClick={() => setColumnsOpen(false)} />
              <div className="journal-menu-list is-checks" role="menu">
                {JOURNAL_COLUMNS.map((col) => (
                  <label key={col.id} className={`journal-col-toggle${col.locked ? " is-locked" : ""}`}
                    title={col.locked ? "Бұл баған әрқашан көрінеді" : undefined}>
                    <input type="checkbox" checked={!hiddenColumns.has(col.id)} disabled={col.locked}
                      onChange={() => setHiddenColumns((prev) => toggleHiddenColumn(prev, col.id))} />
                    {col.label}
                  </label>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Three separate download buttons cost more toolbar width than they earn — exporting is a
            once-a-month action sitting next to things done every minute. */}
        <div className="journal-menu">
          <button className="btn btn-outline btn-sm" aria-haspopup="menu" aria-expanded={exportOpen}
            onClick={() => setExportOpen((v) => !v)}>
            ⭳ Экспорт ▾
          </button>
          {exportOpen && (
            <>
              <button className="journal-menu-scrim" aria-label="Мәзірді жабу" onClick={() => setExportOpen(false)} />
              <div className="journal-menu-list" role="menu">
                <button role="menuitem" onClick={() => { exportCsv("тапсырыс-журналы", exportRows()); setExportOpen(false); }}>
                  CSV жүктеу
                </button>
                <button role="menuitem" onClick={() => { exportXlsx("тапсырыс-журналы", exportRows()); setExportOpen(false); }}>
                  Excel жүктеу
                </button>
                <button role="menuitem" className="no-print" onClick={() => { setExportOpen(false); window.print(); }}>
                  Басып шығару
                </button>
              </div>
            </>
          )}
        </div>

        {/* Phone-only: the card list is the readable default, but the full ledger has to be
            reachable on a phone too — this swaps to the real table, scrolled sideways. */}
        <button
          className="btn btn-outline btn-sm journal-view-toggle"
          onClick={() => setMobileTable((v) => !v)}
        >
          {mobileTable ? "▤ Карта" : "▦ Кесте"}
        </button>
      </div>

      {/* The counted chips. A dropdown hides both the options and the size of each one behind a
          click; these answer "how many are still owing?" before anyone touches anything, which is
          the question this page is usually opened with. */}
      <div className="journal-chips" role="tablist" aria-label="Жылдам сүзгі">
        {JOURNAL_QUICK_FILTERS.map((chip) => (
          <button
            key={chip.id}
            role="tab"
            aria-selected={quickFilter === chip.id}
            className={`journal-chip${quickFilter === chip.id ? " is-active" : ""} is-${chip.id}`}
            onClick={() => { setQuickFilter(chip.id); setPinnedPage(null); }}
          >
            {chip.label}
            <span className="journal-chip-count">{chipCounts[chip.id]}</span>
          </button>
        ))}
      </div>
    </>
  );

  return (
    <AppShell
      title="ЛДСП — Тапсырыс журналы"
      subtitle="Заказдарды тіркеу және өндіріске жіберу"
      navKey="manager-journal"
      contentWidth="full"
      autoCollapse
      /* On a phone the toolbar's "Жаңа заказ" is below the fold by the time the list is scrolled;
         the same action sits on the bar that never scrolls away. */
      fab={{ onClick: openNewRow, label: "Жаңа заказ" }}
    >
      {toolbar}

      {/* Phones get cards instead of the ledger. Same figures, same three-dot progress, same
          action button — read down the card instead of across a row. The table is still one tap
          away via the ▦ Кесте toggle, and is hidden here at the same breakpoint in CSS. */}
      <div className={`journal-cards${mobileTable ? " is-hidden" : ""}`}>
        {loading || paymentsLoading ? (
          <Spinner />
        ) : (
          <>
            {/* The day in one line, above the list — on a phone the desktop footer would be a
                scroll away, and this is the number the owner opens the app for. */}
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
              <div className="empty-state"><div className="icon">📭</div><p>Заказдар табылмады</p></div>
            ) : (
              pageItems.map((order) => {
                // Same money the ledger row shows: derived from the payments, not from the order's
                // stored debt, so a merged order never reads as owing on the phone either.
                const cardPaid = netPaidTiyn(paymentsByOrder.get(order.id) ?? []);
                const cardDebt = order.totalTiyn - cardPaid;
                const cardStatus = computePaymentStatus(order.totalTiyn, cardPaid);
                const cardMethodId = methodIdOf([...paidByMethod(paymentsByOrder.get(order.id) ?? []).keys()]);
                const cardMethodLabel = methodLabelOf(
                  cardMethodId,
                  methods,
                  (paymentsByOrder.get(order.id) ?? []).find((p) => !p.reversed)?.methodName,
                );
                const lines = linesOf(order);
                const cardAbsorbed = absorbedByParent.get(order.id) ?? EMPTY_ORDERS;
                const cardSheets = sheetSummary(lines);
                const cardPvc = pvcSummary(lines, pvcTypesById);
                const onGate = QUEUE_STAGE_STATUSES.includes(order.productionStatus);

                return (
                  <div key={order.id} className={`journal-card${awaitingCutting(order) ? " is-awaiting" : ""}`}>
                    <button className="journal-card-main" onClick={() => navigate(`/manager/order/${order.id}`)}>
                      <div className="journal-card-top">
                        <strong>{order.orderNumber}</strong>
                        <span className="journal-card-date">
                          {order.createdAt ? formatDateDMY(order.createdAt) : "—"}
                        </span>
                      </div>
                      <div className="journal-card-client">{order.customerName}</div>
                      {/* The same two columns the ledger grew, stacked as tiles: what is on the
                          saw and what is on the ПВХ machine, each with the roll or board named
                          under it. On a phone this is the whole reason to open the card. */}
                      <div className="journal-card-facts">
                        <span className="journal-card-fact">
                          <IconLayers className="journal-card-fact-icon" />
                          <span className="journal-card-fact-text">
                            <b>{cardSheets.headline}</b>
                            <small>{cardSheets.detail || "материал таңдау"}</small>
                          </span>
                        </span>
                        <span className="journal-card-fact">
                          <IconPvc className="journal-card-fact-icon" />
                          <span className="journal-card-fact-text">
                            <b>{cardPvc.headline === "—" ? "ПВХ жоқ" : `${cardPvc.headline} ПВХ`}</b>
                            <small>{cardPvc.detail || "—"}</small>
                          </span>
                        </span>
                      </div>
                      {(lines.length > 1 || cardAbsorbed.length > 0) && (
                        <div className="journal-card-meta">
                          {/* Merging is not a deletion, and on a phone the absorbed rows are just
                              as gone as they are on the ledger — this is what says where they went. */}
                          {cardAbsorbed.length > 0 && (
                            <span className={`journal-card-badge is-group jt-tone-${groupTone(order.id)}`}>
                              ⧉ {cardAbsorbed.length + 1} заказ біріктірілген
                            </span>
                          )}
                          {lines.length > 1 && <span className="journal-card-badge">{lines.length} материал</span>}
                        </div>
                      )}
                      <div className="journal-card-money">
                        <span className="journal-card-total">{formatMoney(order.totalTiyn)}</span>
                        <span className={`jt-pill jt-pay-${cardStatus}`}>{journalStatusLabel(cardStatus)}</span>
                        <span className={`jt-method-pill is-${methodTone(cardMethodId)}`}>{cardMethodLabel}</span>
                      </div>
                      {cardDebt > 0 && <div className="journal-card-owing">Қарыз: {formatMoney(cardDebt)}</div>}
                      {cardDebt < 0 && <div className="journal-card-owing is-over">Артық: {formatMoney(-cardDebt)}</div>}
                      <ProgressSteps steps={journalProgress(order, cardPaid)} compact />
                      <span className="journal-card-chevron" aria-hidden="true">›</span>
                    </button>

                    {onGate && (
                      canEnterCuttingQueue(order.paymentStatus) ? (
                        <button className="btn btn-primary btn-full journal-card-action"
                          onClick={() => handleQueueOrder(order)}>
                          Распилге жіберу
                        </button>
                      ) : (
                        <button className="btn btn-danger-outline btn-full journal-card-action"
                          onClick={() => handleOverrideQueueOrder(order)}>
                          ⚠️ Қарызға жіберу
                        </button>
                      )
                    )}
                  </div>
                );
              })
            )}
          </>
        )}
      </div>

      <div className={`journal-main${openOrder ? " has-panel" : ""}`}>
        <div className={`journal-wrap${mobileTable ? " is-mobile-visible" : ""}`}>
          <div className="journal-scroll">
            <table className="journal-table">
              <thead>
                <tr>
                  <th className="jt-w-pick" title="Біріктіру үшін таңдау"></th>
                  <th className="jt-w-who">Заказ / Клиент</th>
                  {/* Driven off JOURNAL_COLUMNS so the header, the cells and the colSpan of an
                      empty row can never drift apart as columns are switched on and off. */}
                  {shownColumns.map((col) => (
                    <th key={col.id} className={`jt-w-${col.id}${col.id === "total" ? " jt-num" : ""}`}>
                      {col.label}
                    </th>
                  ))}
                  <th className="jt-w-act">Әрекет</th>
                </tr>
              </thead>
              <tbody
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  const el = e.target as HTMLElement;
                  if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement)) return;
                  // The unsaved "жаңа заказ" row commits on Enter — that is its own handler's job.
                  if (el.closest("tr")?.classList.contains("is-new")) return;
                  e.preventDefault();
                  moveFocusVertically(el, e.shiftKey ? -1 : 1);
                }}
              >
                {loading || paymentsLoading ? (
                  <tr><td colSpan={bodyColSpan} className="jt-empty">Жүктелуде…</td></tr>
                ) : pageItems.length === 0 && !newRow ? (
                  <tr><td colSpan={bodyColSpan} className="jt-empty">Заказдар табылмады</td></tr>
                ) : (
                  <>
                  {/* The ledger runs oldest first and opens on the last page, so on a busy month
                      everything before today sits above the window. Left to the pager alone that
                      reads as "my old orders are gone" — so the table says how many there are and
                      offers the two ways to reach them. */}
                  {pageView.olderCount > 0 && (
                    <HiddenRowsNotice
                      colSpan={bodyColSpan}
                      direction="older"
                      count={pageView.olderCount}
                      onStep={() => setPinnedPage(safePage - 1)}
                      onShowAll={() => { setPageSize(SHOW_ALL); setPinnedPage(null); }}
                    />
                  )}
                  {pageItems.map((order) => (
                    <JournalRow
                      key={order.id}
                      order={order}
                      hidden={activeHidden}
                      pvcTypesById={pvcTypesById}
                      directory={customerDir}
                      absorbed={absorbedByParent.get(order.id) ?? EMPTY_ORDERS}
                      isExpanded={expanded.has(order.id)}
                      onToggleExpand={() => toggleExpanded(order.id)}
                      onPickRange={() => pickRangeTo(order.id, pageIds)}
                      materials={materials}
                      methods={methods}
                      payments={paymentsByOrder.get(order.id) ?? []}
                      actor={actor}
                      selected={picked.has(order.id)}
                      isOpen={openId === order.id}
                      onToggleSelect={() => togglePick(order.id)}
                      onOpenPanel={() => setOpenId(order.id)}
                      onOpen={() => navigate(`/manager/order/${order.id}`)}
                      onAddPayment={() => setPayFor(order)}
                      onSetPaymentState={(choice) => handleSetPaymentState(order, choice)}
                      onSetPaid={(amountTiyn) => handleSetPaid(order, amountTiyn)}
                      onQueue={() => handleQueueOrder(order)}
                      onOverrideQueue={() => handleOverrideQueueOrder(order)}
                      onError={showToast}
                    />
                  ))}
                  {pageView.newerCount > 0 && (
                    <HiddenRowsNotice
                      colSpan={bodyColSpan}
                      direction="newer"
                      count={pageView.newerCount}
                      onStep={() => setPinnedPage(safePage + 1)}
                      onShowAll={() => { setPageSize(SHOW_ALL); setPinnedPage(null); }}
                    />
                  )}
                  </>
                )}

                {newRow && (
                  <NewJournalRow
                    draft={newRow}
                    setDraft={setNewRow}
                    directory={customerDir}
                    materials={materials}
                    pvcTypes={pvcTypes}
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

          {/* The ledger is a keyboard tool first — say so once, quietly, rather than leaving the
              navigation to be discovered. */}
          <p className="journal-keys">
            Кез келген ұяшықты басып жазыңыз — өзі сақталады. <kbd>Enter</kbd> — төменгі жол,{" "}
            <kbd>Shift</kbd>+<kbd>Enter</kbd> — жоғарғы жол, <kbd>Tab</kbd> — келесі баған.{" "}
            <kbd>Ctrl</kbd>+шерту — жолды таңдау, <kbd>Shift</kbd>+құсбелгі — аралықты таңдау.{" "}
            <b>▸</b> — әр листтің бағасын ашады.
          </p>

          {/* The day's totals and the pager are one footer, the way a paper ledger foots a page:
              the figures the manager checks before closing, next to the control that turns it. */}
          <div className="journal-foot">
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
              <button className="journal-page-btn" disabled={safePage >= totalPages} onClick={() => setPinnedPage(safePage + 1)} aria-label="Келесі бет">›</button>
              <button className="journal-page-btn" disabled={safePage >= totalPages} onClick={() => setPinnedPage(null)} aria-label="Соңғы бет">»</button>
            </div>
            <select
              className="journal-select"
              value={pageSize}
              onChange={(e) => { setPageSize(Number(e.target.value)); setPinnedPage(null); }}
            >
              {PAGE_SIZES.map((n) => (
                <option key={n} value={n}>{n === SHOW_ALL ? "Барлығы" : `${n} / бет`}</option>
              ))}
            </select>
            </div>
          </div>
        </div>

        {openOrder && (
          <JournalDetailPanel
            order={openOrder}
            materials={materials}
            pvcTypes={pvcTypes}
            payments={paymentsByOrder.get(openOrder.id) ?? []}
            actor={actor}
            structuralEditsAllowed={QUEUE_STAGE_STATUSES.includes(openOrder.productionStatus)}
            onClose={() => setOpenId(null)}
            onOpenFull={() => navigate(`/manager/order/${openOrder.id}`)}
            onQueue={() => handleQueueOrder(openOrder)}
            onOverrideQueue={() => handleOverrideQueueOrder(openOrder)}
            onError={showToast}
          />
        )}
      </div>

      {payFor && (
        <PaymentDialog
          payments={livePaymentsFor(payFor.id)}
          remainingTiyn={Math.max(0, payFor.totalTiyn - netPaidTiyn(livePaymentsFor(payFor.id)))}
          onChangeMethod={handleChangeMethod}
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
  payments,
  remainingTiyn,
  onChangeMethod,
  onClose,
  onSubmit,
}: {
  order: Order;
  methods: PaymentMethodDef[];
  /** Live (non-reversed) payments on this order — each one's method stays editable. */
  payments: Payment[];
  /**
   * What is still outstanding, worked out by the caller from those payments rather than read off
   * the order's own `debtTiyn` — a merged order's stored debt can be a merge behind the money.
   */
  remainingTiyn: number;
  onChangeMethod: (payment: Payment, methodId: string) => Promise<void> | void;
  onClose: () => void;
  onSubmit: (methodId: string, amountTiyn: number) => Promise<void> | void;
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

  const overpaying = adding && Math.round(amountTenge * 100) > remaining;

  const submit = async () => {
    setBusy(true);
    await onSubmit(methodId, Math.round(amountTenge * 100));
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
              <div key={p.id} className="pay-recorded-row">
                <span className="pay-recorded-sum">{formatMoney(p.amountTiyn)}</span>
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
            ))}
            {/* Says outright what the select does, because the consequence is invisible: the sum
                on the left does not move, and the order's paid total does not change. */}
            <p className="pay-hint">
              Түрін ауыстырсаңыз ақша қозғалмайды — тек қай әдіспен түскені түзетіледі. Бірден
              сақталады.
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

            {/* The mistake this dialog invites is adding a second payment to a settled order while
                meaning to correct the first one's method. It is allowed — a customer really can
                overpay — but never silently. */}
            {overpaying && (
              <p className="pay-warn">
                ⚠️ Бұл сома қалдықтан {formatMoney(Math.round(amountTenge * 100) - remaining)} артық.
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
              <button type="button" className="btn btn-primary" disabled={busy || !methodId || amountTenge <= 0}
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
 * "There are more orders this way" — a row of the table rather than a note beside it.
 *
 * The pager at the foot of the page was already telling the truth ("51–63 / 63 заказ"), and it
 * was still being read as data loss: it is small, it is below the fold on a full screen, and
 * nothing where the rows stop says that rows were cut off. This sits exactly where the missing
 * orders would have been.
 */
function HiddenRowsNotice({
  colSpan, direction, count, onStep, onShowAll,
}: {
  colSpan: number;
  /** Which way the hidden rows lie: older is up the ledger, newer is down it. */
  direction: "older" | "newer";
  count: number;
  /** One page towards them. */
  onStep: () => void;
  /** All of them, on one page. */
  onShowAll: () => void;
}) {
  return (
    <tr className={`jt-more is-${direction}`}>
      <td colSpan={colSpan}>
        <span className="jt-more-text">
          {direction === "older" ? "↑ Бұдан ескі" : "↓ Бұдан кейінгі"} <b>{count}</b> заказ жасырылған
        </span>
        <button type="button" className="jt-more-btn" onClick={onStep}>
          {direction === "older" ? "алдыңғы бет" : "келесі бет"}
        </button>
        <button type="button" className="jt-more-btn is-strong" onClick={onShowAll}>
          барлығын көрсету
        </button>
      </td>
    </tr>
  );
}

/**
 * The three-dot progress read-out: money in, sheets cut, order finished.
 *
 * Shared by the ledger row and the phone card so both tell the same story. Each dot carries its
 * own label rather than relying on colour alone — a red and a green circle look identical to a
 * colour-blind reader, and this is the column the shop scans fastest.
 */
function ProgressSteps({ steps, compact = false }: { steps: ProgressStep[]; compact?: boolean }) {
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
 * One ledger row.
 *
 * Eighteen columns fitted the data and nothing else: every cell was three characters wide and the
 * page read as a spreadsheet dump rather than a day's work. This is the same information in eight
 * columns — the identity, what it is made of, what it costs, what came in, where it is, when, and
 * the one action that moves it — with the per-material detail moved to the panel that opens
 * beside it.
 *
 * What stays typed straight into the row is what actually gets corrected at a counter: the
 * customer's name and phone, the agreed total, the amount paid, the date. Sheet counts, prices,
 * ПВХ metres and colours are edited in the panel, where they have room to be read.
 */
function JournalRow({
  order, hidden, pvcTypesById, directory, absorbed, isExpanded, onToggleExpand, onPickRange,
  materials, methods, payments, actor, selected, isOpen,
  onToggleSelect, onOpenPanel, onOpen,
  onAddPayment, onSetPaymentState, onSetPaid, onQueue, onOverrideQueue, onError,
}: {
  order: Order;
  /** Columns the manager has put away — the header and the colSpan are driven off the same set. */
  hidden: ReadonlySet<JournalColumnId>;
  /** Resolves a line's colour to its thickness, so the ПВХ cell can name the actual roll. */
  pvcTypesById: ReadonlyMap<string, PvcType>;
  /** Past customers, for the name cell to complete from. */
  directory: readonly CustomerSuggestion[];
  /** The journal rows folded into this order, if any — empty for an ordinary row. */
  absorbed: Order[];
  /** Opened up to show each material line at its own price. */
  isExpanded: boolean;
  onToggleExpand: () => void;
  /** Shift-clicked: take everything from the last tick down to this row. */
  onPickRange: () => void;
  materials: Material[];
  methods: PaymentMethodDef[];
  payments: Payment[];
  actor: Parameters<typeof saveJournalRow>[1];
  selected: boolean;
  /** Highlighted because the detail panel is showing this order. */
  isOpen: boolean;
  onToggleSelect: () => void;
  onOpenPanel: () => void;
  /** The full-screen order page, for everything the panel does not cover. */
  onOpen: () => void;
  onAddPayment: () => void;
  onSetPaymentState: (choice: PaymentChoice) => void;
  onSetPaid: (amountTiyn: number) => void;
  onQueue: () => void;
  onOverrideQueue: () => void;
  onError: (message: string) => void;
}) {
  const materialsById = useMemo(() => new Map(materials.map((m) => [m.id, m])), [materials]);
  const byMethod = paidByMethod(payments);
  const paid = netPaidTiyn(payments);

  const [draft, setDraft] = useState<JournalDraft>(() => draftFromOrder(order));
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const dirtyRef = useRef(false);

  useEffect(() => {
    if (!dirtyRef.current) setDraft(draftFromOrder(order));
  }, [order]);

  useEffect(() => {
    if (!dirtyRef.current) return;
    const handle = setTimeout(async () => {
      setSaveState("saving");
      try {
        await saveJournalRow(db, actor, order, draft, { materials: materialsById, pvcTypes: new Map() });
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

  const patch = (p: Partial<JournalDraft>) => {
    dirtyRef.current = true;
    setSaveState("dirty");
    setDraft((prev) => ({ ...prev, ...p }));
  };

  const preview = computeJournalRowTotals(totalsInputFor(draft, paid));

  const usedMethods = [...byMethod.keys()];
  const methodId = methodIdOf(usedMethods);
  const methodLabel = methodLabelOf(
    methodId,
    methods,
    payments.find((p) => !p.reversed && p.methodId === methodId)?.methodName,
  );
  const methodBreakdown = [...byMethod.entries()]
    .map(([id, amount]) => {
      const name = payments.find((p) => !p.reversed && p.methodId === id)?.methodName ?? id;
      return `${name}: ${formatMoney(amount)}`;
    })
    .join(" · ");

  const shortNum = shortOrderNumber(order.orderNumber);
  /**
   * A merged order and the lines it is made of wear one colour down the ledger.
   *
   * Merging used to look like two rows being deleted; the stripe and the "⧉ 3 заказ" badge are
   * what say "these belong together" at a glance, and the same tone is repeated on every line the
   * row unfolds into. Colour is never the only signal — the badge counts the group in words and
   * each line names the order it came from.
   */
  const tone = absorbed.length > 0 ? groupTone(order.id) : null;
  const groupClass = tone === null ? "" : ` is-group jt-tone-${tone}`;

  /** Each line at its own price — what the customer is shown when they ask what a sheet costs. */
  const linePrices = draft.lines.map(linePrice);
  /**
   * Everything the total holds that no material line does: cutting, ХДФ, delivery, extra services,
   * less any discount. Shown as its own line rather than left as an unexplained gap — a breakdown
   * that does not add up to the total is worse than no breakdown at all.
   */
  const extrasTiyn = preview.totalTiyn - linePrices.reduce((sum, l) => sum + l.sheetsAndPvcTiyn, 0);
  // Summarised from the draft, not the saved order, so a sheet count typed in the panel shows in
  // the cell before the autosave has landed.
  const sheets = sheetSummary(draft.lines);
  const pvc = pvcSummary(draft.lines, pvcTypesById);
  const steps = journalProgress(order, paid);
  const onGate = QUEUE_STAGE_STATUSES.includes(order.productionStatus);
  const show = (id: JournalColumnId) => !hidden.has(id);

  return (
    <>
    <tr
      className={`jt-row${selected ? " is-picked" : ""}${isOpen ? " is-open" : ""}${groupClass}${
        awaitingCutting(order) ? " is-awaiting" : ""
      }`}
      /* Ctrl/⌘ + click anywhere on the row ticks it, so a run of rows can be gathered without
         aiming at six small boxes. preventDefault on mousedown is what stops the click also
         landing in whichever cell was under the cursor. */
      onMouseDown={(e) => {
        if (!(e.ctrlKey || e.metaKey)) return;
        e.preventDefault();
        onToggleSelect();
      }}
    >
      <td className="jt-w-pick">
        <input type="checkbox" className="jt-pick" checked={selected} onChange={onToggleSelect}
          onClick={(e) => {
            if (!e.shiftKey) return;
            e.preventDefault(); // the range handler owns this click, not the box's own toggle
            onPickRange();
          }}
          title="Shift — аралықты таңдау, Ctrl — жолды таңдау"
          aria-label={`${order.orderNumber} — біріктіру үшін таңдау`} />
      </td>

      {/* Number, name and phone in one column. They are one fact — who this row is — and reading
          them as three separate columns was what pushed everything else off the screen. */}
      <td className="jt-w-who">
        <div className="jt-who-head">
          <button className="jt-expand" onClick={onToggleExpand} aria-expanded={isExpanded}
            title={isExpanded ? "Жию" : "Әр листтің бағасын көрсету"}
            aria-label={`${order.orderNumber} — құрамын ${isExpanded ? "жию" : "ашу"}`}>
            {isExpanded ? "▾" : "▸"}
          </button>
          <button className="jt-num-link" onClick={onOpenPanel} title="Толығырақ ашу"
            aria-label={`${order.orderNumber} — толығырақ`}>№{shortNum}</button>
          {absorbed.length > 0 && (
            <button className="jt-group-badge" onClick={onToggleExpand}
              title={`Біріктірілген: ${absorbed.map((o) => o.orderNumber).join(", ")}`}>
              ⧉ {absorbed.length + 1} заказ
            </button>
          )}
        </div>
        {/* Picking a past customer brings their phone with it — the debt ledger and the merge
            check both key on the number, so a returning customer typed afresh each visit is how
            one person ends up as three. */}
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

      {/* Sheets and ПВХ are counted by two different people at two different machines, so each
          gets a column: the figure read at a glance, over what it is actually made of. Both open
          the panel, which is where the per-material numbers are edited. */}
      {show("sheets") && (
        <td className="jt-w-sheets">
          <button className="jt-fact" onClick={onOpenPanel} title="Материалдарды ашу"
            aria-label={`Лист саны — ${sheets.headline}`}>
            <span className="jt-fact-value">{sheets.headline}</span>
            <span className="jt-fact-note">
              {sheets.detail
                || materialsById.get(draft.lines[0]?.materialId ?? "")?.name
                || "материал таңдау"}
            </span>
          </button>
        </td>
      )}

      {show("pvc") && (
        <td className="jt-w-pvc">
          <button className="jt-fact" onClick={onOpenPanel} title="ПВХ-ны ашу"
            aria-label={`ПВХ — ${pvc.headline}`}>
            <span className="jt-fact-value">{pvc.headline}</span>
            <span className="jt-fact-note">{pvc.detail || "ПВХ жоқ"}</span>
          </button>
        </td>
      )}

      {/* Typed by hand: this shop negotiates, and the difference from the lines is recorded as a
          discount or a surcharge rather than left floating (see totalOverrideFor). */}
      <td className="jt-w-total jt-num">
        <NumberField className="jt-input jt-input-num jt-total" value={preview.totalTiyn / 100} min={0}
          ariaLabel="Жалпы сома"
          onChange={(v) => patch(totalOverrideFor(draft, Math.round(v * 100)))} />
      </td>

      <td className="jt-w-pay">
        <select
          className={`jt-pay-toggle jt-pay-select jt-pay-${preview.paymentStatus}`}
          value={preview.paymentStatus}
          onChange={(e) => onSetPaymentState(e.target.value as PaymentChoice)}
          title={
            preview.debtTiyn > 0 ? `${journalStatusLabel(preview.paymentStatus)} — қалдық ${formatMoney(preview.debtTiyn)}`
            : preview.debtTiyn < 0 ? `${journalStatusLabel(preview.paymentStatus)} — артық ${formatMoney(-preview.debtTiyn)}`
            : journalStatusLabel(preview.paymentStatus)
          }
        >
          {preview.paymentStatus === "overpaid" && <option value="overpaid">Артық</option>}
          {preview.paymentStatus === "refunded" && <option value="refunded">Қайтарылды</option>}
          {PAYMENT_CHOICES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
        {/* The figure under the pill reads as plain text and is still typed into: correcting what
            actually came in is the most common edit at this counter, and sending it to the panel
            would cost a click on every one of them. */}
        <div className="jt-pay-note">
          <span className="jt-pay-note-label">Төленді:</span>
          <PaidCell paidTiyn={paid} title={methodBreakdown} onCommit={onSetPaid} />
          <span className="jt-pay-note-cur">₸</span>
        </div>
        {preview.debtTiyn > 0 && (
          <div className="jt-pay-owing">Қарыз: {formatMoneyBare(preview.debtTiyn)} ₸</div>
        )}
        {preview.debtTiyn < 0 && (
          <div className="jt-pay-owing is-over">Артық: {formatMoneyBare(-preview.debtTiyn)} ₸</div>
        )}
      </td>

      {/* Which pot the money landed in, in the colour the counter already calls it by. Clicking
          records a payment — this cell is how a row gets settled, not just a label on one. */}
      {show("method") && (
        <td className="jt-w-method">
          <button className={`jt-method-pill is-${methodTone(methodId)}`} onClick={onAddPayment}
            title={methodBreakdown || "Төлем тіркеу"}>
            {methodLabel}
          </button>
        </td>
      )}

      {/* Where the order is, and the one button that moves it on. */}
      {show("progress") && (
        <td className="jt-w-progress">
          <ProgressSteps steps={steps} />
          {onGate && (
            canEnterCuttingQueue(order.paymentStatus) ? (
              <button className="btn btn-primary btn-sm jt-cut-btn" onClick={onQueue}>Распилге жіберу</button>
            ) : (
              <button className="btn btn-danger-outline btn-sm jt-cut-btn" onClick={onOverrideQueue}
                title={`Қарызға жіберу — қалдық ${formatMoney(Math.max(0, preview.debtTiyn))}`}>
                ⚠️ Қарызға жіберу
              </button>
            )
          )}
        </td>
      )}

      {show("date") && (
        <td className="jt-w-date">
          <input type="date" className="jt-input jt-input-date" value={dayKey(draft.orderDate)}
            aria-label="Заказ күні"
            onChange={(e) => patch({
              orderDate: e.target.value ? new Date(`${e.target.value}T12:00:00+05:00`) : draft.orderDate,
            })} />
        </td>
      )}

      {/* One visible action — open the row — with the rest folded away, so ten columns of data
          are not competing with four buttons for the same width. */}
      <td className="jt-actions">
        <span className={`jt-save-dot is-${saveState}`} title={SAVE_TITLES[saveState]} aria-live="polite">
          {SAVE_GLYPHS[saveState]}
        </span>
        {/* The saw, next to the row's other actions. Which of the two paths it takes is decided by
            the payment gate, exactly as the wide button in the progress column does: a settled
            order goes straight on, an owing one goes on credit and is written into the audit. */}
        {onGate && (
          canEnterCuttingQueue(order.paymentStatus) ? (
            <button className="jt-icon-btn is-cut" onClick={onQueue} aria-label="Распилге жіберу"
              title={order.pvcMetersTotal > 0 ? "Распил + ПВХ кезегіне жіберу" : "Распилге жіберу"}>
              <IconCut />
            </button>
          ) : (
            <button className="jt-icon-btn is-cut-debt" onClick={onOverrideQueue} aria-label="Қарызға жіберу"
              title={`Қарызға жіберу — қалдық ${formatMoney(Math.max(0, preview.debtTiyn))}`}>
              <IconCut />
            </button>
          )
        )}
        <button className="jt-icon-btn" onClick={onOpenPanel} title="Толығырақ" aria-label="Толығырақ ашу">›</button>
        <RowMenu
          items={[
            { label: "Толық бетті ашу", onClick: onOpen },
            { label: "Төлем тіркеу", onClick: onAddPayment },
            ...(onGate
              ? [canEnterCuttingQueue(order.paymentStatus)
                  ? { label: "Распилге жіберу", onClick: onQueue }
                  : { label: "Қарызға жіберу", onClick: onOverrideQueue, danger: true }]
              : []),
          ]}
        />
      </td>
    </tr>

    {/* Unfolded: one line per material, priced the way the customer asks about it — this many
        sheets at this much each. A merged order's lines still name the row each was typed on, so
        the orders folded in here can be read straight off the survivor. */}
    {isExpanded && draft.lines.map((line, index) => {
      const price = linePrices[index];
      return (
        <tr key={index} className={`jt-subrow${groupClass}`}>
          <td className="jt-w-pick" />
          <td className="jt-w-who">
            <span className="jt-sub-material">{line.materialName || "материал таңдалмаған"}</span>
            {line.sourceOrderNumber && line.sourceOrderNumber !== order.orderNumber && (
              <span className="jt-sub-source" title={line.sourceOrderNumber}>
                №{shortOrderNumber(line.sourceOrderNumber)} ішінен
              </span>
            )}
          </td>
          {show("sheets") && (
            <td className="jt-w-sheets">
              <span className="jt-fact-value">{line.sheetQty > 0 ? `${line.sheetQty} лист` : "—"}</span>
              {line.sheetQty > 0 && (
                <span className="jt-fact-note">× {formatMoneyBare(line.sheetPriceTiyn)} ₸</span>
              )}
            </td>
          )}
          {show("pvc") && (
            <td className="jt-w-pvc">
              <span className="jt-fact-value">{line.pvcMeters > 0 ? `${Math.round(line.pvcMeters)} м` : "—"}</span>
              {line.pvcMeters > 0 && (
                <span className="jt-fact-note">× {formatMoneyBare(line.pvcPricePerMeterTiyn)} ₸</span>
              )}
            </td>
          )}
          <td className="jt-w-total jt-num jt-sub-total">{formatMoneyBare(price.sheetsAndPvcTiyn)} ₸</td>
          <td className="jt-w-pay" />
          {show("method") && <td className="jt-w-method" />}
          {show("progress") && <td className="jt-w-progress" />}
          {show("date") && <td className="jt-w-date" />}
          <td className="jt-actions" />
        </tr>
      );
    })}

    {/* Cutting, ХДФ, delivery and any discount, so the lines above add up to the row's total. */}
    {isExpanded && extrasTiyn !== 0 && (
      <tr className={`jt-subrow is-extras${groupClass}`}>
        <td className="jt-w-pick" />
        <td className="jt-w-who">
          <span className="jt-sub-material">{extrasTiyn > 0 ? "Қосымша (кесу, ХДФ, жеткізу)" : "Жеңілдік"}</span>
        </td>
        {show("sheets") && <td className="jt-w-sheets" />}
        {show("pvc") && <td className="jt-w-pvc" />}
        <td className="jt-w-total jt-num jt-sub-total">
          {extrasTiyn > 0 ? "+" : "−"}{formatMoneyBare(Math.abs(extrasTiyn))} ₸
        </td>
        <td className="jt-w-pay" />
        {show("method") && <td className="jt-w-method" />}
        {show("progress") && <td className="jt-w-progress" />}
        {show("date") && <td className="jt-w-date" />}
        <td className="jt-actions" />
      </tr>
    )}
    </>
  );
}

/**
 * The detail panel that opens beside the ledger.
 *
 * This is where the per-material numbers live now — sheet counts, prices, ПВХ metres and colours —
 * with room to read them, which eight cramped columns never gave them. It keeps its own draft and
 * autosaves exactly as a row does, so an edit here and an edit in the row behave identically.
 */
function JournalDetailPanel({
  order, materials, pvcTypes, payments, actor, structuralEditsAllowed,
  onClose, onOpenFull, onQueue, onOverrideQueue, onError,
}: {
  order: Order;
  materials: Material[];
  pvcTypes: PvcType[];
  payments: Payment[];
  actor: Parameters<typeof saveJournalRow>[1];
  structuralEditsAllowed: boolean;
  onClose: () => void;
  onOpenFull: () => void;
  onQueue: () => void;
  onOverrideQueue: () => void;
  onError: (message: string) => void;
}) {
  const materialsById = useMemo(() => new Map(materials.map((m) => [m.id, m])), [materials]);
  const pvcTypesById = useMemo(() => new Map(pvcTypes.map((p) => [p.id, p])), [pvcTypes]);
  const catalog = useMemo(() => ({ materials: materialsById, pvcTypes: pvcTypesById }), [materialsById, pvcTypesById]);

  const paid = netPaidTiyn(payments);
  const [draft, setDraft] = useState<JournalDraft>(() => draftFromOrder(order));
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const dirtyRef = useRef(false);

  // A different row was clicked — take its draft, and drop any half-typed state with it.
  useEffect(() => {
    dirtyRef.current = false;
    setSaveState("idle");
    setDraft(draftFromOrder(order));
  }, [order.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!dirtyRef.current) setDraft(draftFromOrder(order));
  }, [order]);

  useEffect(() => {
    if (!dirtyRef.current) return;
    const handle = setTimeout(async () => {
      setSaveState("saving");
      try {
        await saveJournalRow(db, actor, order, draft, catalog);
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

  const touch = () => {
    dirtyRef.current = true;
    setSaveState("dirty");
  };
  const patchLine = (index: number, p: Partial<JournalDraftLine>) => {
    touch();
    setDraft((prev) => ({ ...prev, lines: prev.lines.map((l, i) => (i === index ? { ...l, ...p } : l)) }));
  };

  const pickMaterial = (index: number, materialId: string) => {
    const m = materialsById.get(materialId);
    const rates = journalDefaultsFor(m);
    touch();
    setDraft((prev) => {
      const lines = prev.lines.map((line, i) => {
        if (i !== index) return line;
        // The edge follows the board: Ақ board, Ақ edge. ХДФ takes none at all, so its ПВХ
        // fields are cleared rather than left carrying a rate for work the shop cannot do.
        const pvc = pvcDefaultsFor(m, pvcTypes, line);
        return {
          ...line,
          materialId,
          materialName: m?.name ?? "",
          sheetPriceTiyn: m?.sellingPriceTiyn ?? line.sheetPriceTiyn,
          pvcTypeId: pvc.pvcTypeId,
          pvcColorName: pvc.pvcColorName,
          pvcPricePerMeterTiyn: pvc.pvcPricePerMeterTiyn,
          ...(pvc.pvcMeters !== undefined ? { pvcMeters: pvc.pvcMeters } : {}),
        };
      });
      const sheets = lines.reduce((sum, l) => sum + l.sheetQty, 0);
      return {
        ...prev,
        lines,
        ...(rates.cuttingPerSheetTiyn > 0 ? { cuttingCostTiyn: rates.cuttingPerSheetTiyn * sheets } : {}),
      };
    });
  };

  const pickPvcType = (index: number, pvcTypeId: string) => {
    const type = pvcTypesById.get(pvcTypeId);
    const line = draft.lines[index];
    patchLine(index, {
      pvcTypeId,
      pvcColorName: type?.colorName ?? "",
      ...(line.pvcPricePerMeterTiyn === 0 && type ? { pvcPricePerMeterTiyn: type.pricePerMeterTiyn } : {}),
    });
  };

  const addLine = () => {
    if (!structuralEditsAllowed) return;
    touch();
    setDraft((prev) => ({ ...prev, lines: [...prev.lines, emptyJournalLine()] }));
  };

  const removeLine = (index: number) => {
    if (!structuralEditsAllowed || draft.lines.length <= 1) return;
    if (!confirm(`«${draft.lines[index].materialName || "материал"}» жолы өшіріледі. Жалғастырасыз ба?`)) return;
    touch();
    setDraft((prev) => ({ ...prev, lines: prev.lines.filter((_, i) => i !== index) }));
  };

  const preview = computeJournalRowTotals(totalsInputFor(draft, paid));
  const onGate = QUEUE_STAGE_STATUSES.includes(order.productionStatus);

  return (
    <aside className="journal-panel" aria-label={`${order.orderNumber} — толығырақ`}>
      <header className="journal-panel-head">
        <div>
          <h3>Заказ {order.orderNumber}</h3>
          <span className={`jt-save-dot is-${saveState}`} title={SAVE_TITLES[saveState]}>{SAVE_GLYPHS[saveState]}</span>
        </div>
        <button className="jt-icon-btn" onClick={onClose} title="Жабу" aria-label="Панельді жабу">✕</button>
      </header>

      <div className="journal-panel-body">
        <dl className="journal-panel-facts">
          <div><dt>Клиент</dt><dd>{order.customerName || "—"}</dd></div>
          <div><dt>Телефон</dt><dd>{order.customerPhone ? formatPhone(order.customerPhone) : "—"}</dd></div>
        </dl>

        <section>
          <div className="journal-panel-section-head">
            <h4>Материалдар</h4>
            <button className="btn btn-outline btn-sm" onClick={addLine} disabled={!structuralEditsAllowed}
              title={structuralEditsAllowed ? "Материал қосу" : "Заказ өндіріске кеткен — материал қосуға болмайды"}>
              ＋ материал
            </button>
          </div>

          {draft.lines.map((line, index) => (
            <div className="journal-line" key={index}>
              <div className="journal-line-top">
                <select className="form-input" value={line.materialId} aria-label="Материал"
                  onChange={(e) => pickMaterial(index, e.target.value)}>
                  <option value="">{line.materialName || "Лист түрі"}</option>
                  {materials.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
                {draft.lines.length > 1 && (
                  <button className="jt-icon-btn" onClick={() => removeLine(index)} disabled={!structuralEditsAllowed}
                    title="Материалды өшіру" aria-label={`${index + 1}-материалды өшіру`}>✕</button>
                )}
              </div>

              <div className="journal-line-grid">
                <label>
                  <span>Лист саны</span>
                  <NumberField className="form-input" value={line.sheetQty} min={0} ariaLabel="Лист саны"
                    onChange={(v) => patchLine(index, { sheetQty: v })} />
                </label>
                <label>
                  <span>Лист бағасы</span>
                  <NumberField className="form-input" value={line.sheetPriceTiyn / 100} min={0} ariaLabel="Лист бағасы"
                    onChange={(v) => patchLine(index, { sheetPriceTiyn: Math.round(v * 100) })} />
                </label>
                {/* ХДФ is the panel behind the cabinet — nobody edge-bands it, so the cells that
                    would price that work are not offered at all. */}
                {isHdfMaterial(materialsById.get(line.materialId)) ? (
                  <p className="jt-no-pvc">ХДФ — ПВХ жүрмейді</p>
                ) : (
                  <>
                    <label>
                      <span>ПВХ, м</span>
                      <NumberField className="form-input" value={line.pvcMeters} min={0} ariaLabel="ПВХ метр"
                        onChange={(v) => patchLine(index, { pvcMeters: v })} />
                    </label>
                    <label>
                      <span>ПВХ бағасы</span>
                      <NumberField className="form-input" value={line.pvcPricePerMeterTiyn / 100} min={0}
                        ariaLabel="ПВХ 1 м бағасы"
                        onChange={(v) => patchLine(index, { pvcPricePerMeterTiyn: Math.round(v * 100) })} />
                    </label>
                    <label className="is-wide">
                      <span>ПВХ түсі</span>
                      <PvcColorSelect pvcTypes={pvcTypes} line={line} onPick={(id) => pickPvcType(index, id)} />
                    </label>
                  </>
                )}
              </div>

              <div className="journal-line-sum">
                {formatMoney(preview.lineTotals[index]?.lineTotalTiyn ?? 0)}
              </div>
            </div>
          ))}
        </section>

        <section className="journal-panel-money">
          <h4>Төлем</h4>
          <div className="journal-money-row"><span>Жалпы</span><strong>{formatMoney(preview.totalTiyn)}</strong></div>
          <div className="journal-money-row"><span>Төленді</span><strong className="is-paid">{formatMoney(paid)}</strong></div>
          <div className="journal-money-row">
            <span>Қарыз</span>
            <strong className={preview.debtTiyn > 0 ? "is-debt" : preview.debtTiyn < 0 ? "is-over" : ""}>
              {preview.debtTiyn < 0 ? `+${formatMoney(-preview.debtTiyn)}` : formatMoney(Math.max(0, preview.debtTiyn))}
            </strong>
          </div>
          {(draft.cuttingCostTiyn > 0 || draft.hdfCostTiyn > 0 || draft.deliveryCostTiyn > 0
            || draft.extraServicesTiyn > 0 || draft.discountTiyn > 0) && (
            <div className="journal-money-extras">
              {draft.cuttingCostTiyn > 0 && <span>Кесу: {formatMoneyBare(draft.cuttingCostTiyn)}</span>}
              {draft.hdfCostTiyn > 0 && <span>ХДФ: {formatMoneyBare(draft.hdfCostTiyn)}</span>}
              {draft.deliveryCostTiyn > 0 && <span>Жеткізу: {formatMoneyBare(draft.deliveryCostTiyn)}</span>}
              {draft.extraServicesTiyn > 0 && <span>Қосымша: {formatMoneyBare(draft.extraServicesTiyn)}</span>}
              {draft.discountTiyn > 0 && <span>Жеңілдік: −{formatMoneyBare(draft.discountTiyn)}</span>}
            </div>
          )}
        </section>
      </div>

      {/* The action that moves the order on, at the bottom of the panel where it stays put while
          the material lines above it scroll. It queues both stations at once when the order has
          edging on it, which is what the label now says rather than leaving it to be discovered. */}
      <footer className="journal-panel-foot">
        <button className="btn btn-outline btn-full" onClick={onOpenFull}>Толық бетті ашу</button>
        {onGate && (
          canEnterCuttingQueue(order.paymentStatus) ? (
            <button className="btn btn-primary btn-full" onClick={onQueue}>
              {order.pvcMetersTotal > 0 ? "Распил + ПВХ кезегіне жіберу" : "Распилге жіберу"}
            </button>
          ) : (
            <button className="btn btn-danger-outline btn-full" onClick={onOverrideQueue}>⚠️ Қарызға жіберу</button>
          )
        )}
        {onGate && order.pvcMetersTotal > 0 && (
          <p className="journal-panel-note">
            ПВХ шебері де осы кезектен көреді — распил біткен соң кірісе береді.
          </p>
        )}
      </footer>
    </aside>
  );
}

/**
 * "ПВХ түсі" — which roll a line's metres came off.
 *
 * A colour retired from the catalogue since the row was written still names itself here: the
 * select only offers active colours, so without an option of its own the cell would read blank
 * and the next autosave would drop the colour off an order that really did use it.
 */
function PvcColorSelect({
  pvcTypes, line, onPick,
}: {
  pvcTypes: PvcType[];
  line: JournalDraftLine;
  onPick: (pvcTypeId: string) => void;
}) {
  const retired = line.pvcTypeId !== "" && !pvcTypes.some((p) => p.id === line.pvcTypeId);
  return (
    <select
      className="jt-input"
      value={line.pvcTypeId}
      onChange={(e) => onPick(e.target.value)}
      aria-label="ПВХ түсі"
      title={line.pvcColorName || "ПВХ түсі таңдалмаған"}
    >
      {/* Prompts only on a line that actually has metres on it — an empty ПВХ cell has no colour
          to ask for, and a row of "таңдаңыз" on every sheet-only line would be noise. */}
      <option value="">{line.pvcMeters > 0 ? "— түсін таңдаңыз —" : "—"}</option>
      {retired && <option value={line.pvcTypeId}>{line.pvcColorName || line.pvcTypeId}</option>}
      {pvcTypes.map((p) => (
        <option key={p.id} value={p.id}>{p.colorName} · {p.thicknessMm}мм</option>
      ))}
    </select>
  );
}

/**
 * The Төленген cell.
 *
 * Kept as its own component with its own local text so a keystroke cannot fire a payment: the
 * figure is committed on Enter or on leaving the cell, once, and only when it differs from what is
 * already recorded. Every other cell autosaves as you type, but money is not a field that can be
 * written eleven times on the way to "110 000".
 */
function PaidCell({
  paidTiyn, title, onCommit,
}: {
  paidTiyn: number;
  title: string;
  onCommit: (amountTiyn: number) => void;
}) {
  const [text, setText] = useState(() => String(paidTiyn / 100));
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!editing) setText(String(paidTiyn / 100));
  }, [paidTiyn, editing]);

  const commit = () => {
    setEditing(false);
    const parsed = Number(text.trim());
    if (!Number.isFinite(parsed) || parsed < 0) {
      setText(String(paidTiyn / 100));
      return;
    }
    const target = Math.round(parsed * 100);
    if (target !== paidTiyn) onCommit(target);
  };

  return (
    <input
      type="number"
      inputMode="decimal"
      min={0}
      className={`jt-input jt-input-num${paidTiyn > 0 ? " is-paid" : ""}`}
      aria-label="Төленген сома"
      title={title}
      value={editing ? text : (paidTiyn > 0 ? String(paidTiyn / 100) : "")}
      placeholder="—"
      onFocus={(e) => { setEditing(true); setText(paidTiyn > 0 ? String(paidTiyn / 100) : ""); e.currentTarget.select(); }}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") { setText(String(paidTiyn / 100)); setEditing(false); e.currentTarget.blur(); }
      }}
    />
  );
}

/**
 * The "жаңа заказ" row, in the same columns as every saved row.
 *
 * Every column is on screen while this row is open — see `activeHidden` — so a walk-in can always
 * be typed in full, whatever the manager has put away for reading.
 *
 * Only the first material is typed here — a walk-in is one sheet type nine times out of ten, and
 * the rest are added in the detail panel once the order exists. That keeps the row a single line
 * to fill in rather than a form pretending to be a row.
 */
function NewJournalRow({
  draft, setDraft, directory, materials, pvcTypes, nameRef, saving, onSave, onCancel,
}: {
  draft: JournalDraft;
  setDraft: (d: JournalDraft) => void;
  /** Past customers, so a returning walk-in is picked rather than retyped. */
  directory: readonly CustomerSuggestion[];
  materials: Material[];
  pvcTypes: PvcType[];
  /** Focused when the row opens, and again if "Жаңа заказ" is pressed while it is open. */
  nameRef: RefObject<HTMLInputElement | null>;
  saving: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  const patch = (p: Partial<JournalDraft>) => setDraft({ ...draft, ...p });
  const line = draft.lines[0];
  const edgeBanded = !isHdfMaterial(materials.find((m) => m.id === line.materialId));
  const patchLine = (p: Partial<JournalDraftLine>) =>
    setDraft({ ...draft, lines: [{ ...line, ...p }, ...draft.lines.slice(1)] });
  const preview = computeJournalRowTotals(totalsInputFor(draft, 0));

  return (
    <tr className="jt-row is-new"
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); onSave(); }
        if (e.key === "Escape") { e.preventDefault(); onCancel(); }
      }}>
      <td className="jt-w-pick" />

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
          onChange={(e) => patch({ customerPhone: e.target.value })} />
      </td>

      {/* The board and its count, under the same header the saved rows use. */}
      <td className="jt-w-sheets">
        <select className="jt-input" value={line.materialId} aria-label="Лист түрі"
          onChange={(e) => {
            const m = materials.find((x) => x.id === e.target.value);
            // Picking a material fills in the shop's standing rates: ПВХ 200 for Ақ, 220 for the
            // rest, and 1600/лист + 160/м of labour on a customer's own board. It also picks the
            // edge to match the board — Ақ board, Ақ edge — and clears ПВХ entirely for ХДФ.
            // All of it stays editable.
            const rates = journalDefaultsFor(m);
            const pvc = pvcDefaultsFor(m, pvcTypes, line);
            setDraft({
              ...draft,
              lines: [{
                ...line,
                materialId: e.target.value,
                materialName: m?.name ?? "",
                sheetPriceTiyn: m?.sellingPriceTiyn ?? line.sheetPriceTiyn,
                pvcTypeId: pvc.pvcTypeId,
                pvcColorName: pvc.pvcColorName,
                pvcPricePerMeterTiyn: pvc.pvcPricePerMeterTiyn,
                ...(pvc.pvcMeters !== undefined ? { pvcMeters: pvc.pvcMeters } : {}),
              }, ...draft.lines.slice(1)],
              cuttingCostTiyn: rates.cuttingPerSheetTiyn * (line.sheetQty || 0),
            });
          }}>
          <option value="">Лист түрін таңдаңыз</option>
          {materials.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
        <div className="jt-new-grid">
          <NumberField className="jt-input jt-input-num" value={line.sheetQty} min={0} ariaLabel="Лист саны"
            placeholder="лист" onChange={(v) => patchLine({ sheetQty: v })} />
          <NumberField className="jt-input jt-input-num" value={line.sheetPriceTiyn / 100} min={0}
            ariaLabel="Лист бағасы" placeholder="баға" onChange={(v) => patchLine({ sheetPriceTiyn: Math.round(v * 100) })} />
        </div>
      </td>

      {/* The roll and its metres. Colour first: it is what decides the price per metre, and
          picking it fills that in on a line that has not been priced yet. Filled in already if
          the board named a colour the shop stocks — and absent entirely for ХДФ. */}
      <td className="jt-w-pvc">
        {!edgeBanded ? (
          <span className="jt-no-pvc">ХДФ — ПВХ жүрмейді</span>
        ) : (
        <>
        <PvcColorSelect
          pvcTypes={pvcTypes}
          line={line}
          onPick={(id) => {
            const t = pvcTypes.find((x) => x.id === id);
            patchLine({
              pvcTypeId: id,
              pvcColorName: t?.colorName ?? "",
              ...(line.pvcPricePerMeterTiyn === 0 && t ? { pvcPricePerMeterTiyn: t.pricePerMeterTiyn } : {}),
            });
          }}
        />
        <div className="jt-new-grid">
          <NumberField className="jt-input jt-input-num" value={line.pvcMeters} min={0} ariaLabel="ПВХ метр"
            placeholder="ПВХ м" onChange={(v) => patchLine({ pvcMeters: v })} />
          <NumberField className="jt-input jt-input-num" value={line.pvcPricePerMeterTiyn / 100} min={0}
            ariaLabel="ПВХ 1 м бағасы" placeholder="ПВХ баға"
            onChange={(v) => patchLine({ pvcPricePerMeterTiyn: Math.round(v * 100) })} />
        </div>
        </>
        )}
      </td>

      <td className="jt-w-total jt-num jt-total">{formatMoneyBare(preview.totalTiyn)}</td>

      {/* Payment and the saw both need the order to exist first — every tenge goes through the
          transactional recordPayment path, never typed straight onto a row that is not saved. */}
      <td className="jt-w-pay jt-muted">төлем — сақтағаннан кейін</td>

      <td className="jt-w-method jt-muted">—</td>

      <td className="jt-w-progress jt-muted">—</td>

      <td className="jt-w-date">
        {/* dayKey() renders the Almaty calendar day, so the picker never shows "yesterday"
            for an evening order the way a UTC-sliced ISO string would. */}
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
