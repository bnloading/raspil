import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
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
import { journalDefaultsFor } from "../../lib/journalPricing";
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
  totalsInputFor,
  type JournalDraft,
  type JournalDraftLine,
} from "../../lib/journalOrders";
import { logAudit } from "../../lib/audit";
import { reattachPayments, recordPayment, reversePayment } from "../../lib/payments";
import { enterCuttingQueue } from "../../lib/orderStatus";
import {
  canEnterCuttingQueue,
  computePaymentStatus,
  PAYMENT_STATUS_LABELS,
  PRODUCTION_STATUS_ORDER,
} from "../../lib/statuses";
import type { Material, Order, Payment, PaymentMethodDef, PvcType } from "../../types/domain";

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

/** What the Статус cell offers. "Қарыз" is the shop's word for an unpaid row, and picking it is
 *  what puts the order on the debt ledger. */
type PaymentChoice = "paid" | "partial" | "unpaid";
// Spelled out, not abbreviated. "Жарт." saved four characters and cost the column its meaning:
// the one thing a payment status has to do is say, unmistakably, whether money is still owed.
// The column is wider now (jt-w-status in index.css) to hold the whole word.
const PAYMENT_CHOICES: { value: PaymentChoice; label: string }[] = [
  { value: "paid", label: "Толық" },
  { value: "partial", label: "Жартылай" },
  { value: "unpaid", label: "Қарыз" },
];

type DateFilter = "all" | "today" | "week" | "month";
type PayFilter = "all" | "unpaid" | "partial" | "paid";

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
  const [payFilter, setPayFilter] = useState<PayFilter>("all");
  // Null means "wherever the newest rows are". With the oldest order first, that is the last page —
  // a ledger opens at today, not at the day it was started. Paging by hand pins a page until the
  // filters change.
  const [pinnedPage, setPinnedPage] = useState<number | null>(null);
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
  /** Method the Статус toggle reuses, so settling an order is one tap after the first time. */
  const [defaultMethodId, setDefaultMethodId] = useState(
    () => localStorage.getItem("journalDefaultMethod") ?? "",
  );

  /** Rows ticked for merging into one order. */
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const togglePick = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

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
      if (payFilter !== "all") {
        if (payFilter === "paid" && o.paymentStatus !== "paid" && o.paymentStatus !== "overpaid") return false;
        if (payFilter === "partial" && o.paymentStatus !== "partial") return false;
        if (payFilter === "unpaid" && o.paymentStatus !== "unpaid") return false;
      }
      return true;
    }).sort(byLedgerOrder);
  }, [orders, search, dateFilter, payFilter]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(pinnedPage ?? totalPages, totalPages);
  const pageItems = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);

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
      showToast(`✅ ${rows.length} жол біріктірілді`);
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
      showToast("✅ Распил кезегіне жіберілді");
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

  const toolbar = (
    <div className="journal-toolbar">
      <button className="btn btn-success btn-sm" onClick={openNewRow}>
        ＋ Жаңа заказ қосу
      </button>
      {stranded.length > 0 && (
        <button className="btn btn-danger-outline btn-sm journal-repair" disabled={saving} onClick={handleRepairPayments}
          title="Біріктірілген заказдардың төлемдері өз жолында тұрмаған — бір рет басып түзетіңіз">
          ⚠ {stranded.length} төлемді өз орнына қайтару
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
        placeholder="Клиент немесе заказ №"
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
      <select className="journal-select" value={payFilter} onChange={(e) => { setPayFilter(e.target.value as PayFilter); setPinnedPage(null); }}>
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
      <button className="btn btn-outline btn-sm no-print" onClick={() => window.print()} aria-label="Журналды басып шығару" title="Басып шығару">
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
    <AppShell title="ЛДСП — ТАПСЫРЫС ЖУРНАЛЫ" navKey="manager-journal" contentWidth="full" autoCollapse>
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
            // Same money the ledger row shows: derived from the payments, not from the order's
            // stored debt, so a merged order never reads as owing on the phone either.
            const cardPaid = netPaidTiyn(paymentsByOrder.get(order.id) ?? []);
            const cardDebt = order.totalTiyn - cardPaid;
            const cardStatus = computePaymentStatus(order.totalTiyn, cardPaid);
            const lines = linesOf(order);
            return (
              <button key={order.id} className="journal-card" onClick={() => navigate(`/manager/order/${order.id}`)}>
                <div className="journal-card-top">
                  <strong>{order.orderNumber}</strong>
                  <span className={`jt-pill jt-pay-${cardStatus}`}>
                    {PAYMENT_STATUS_LABELS[cardStatus]}
                  </span>
                </div>
                <div className="journal-card-client">{order.customerName}</div>
                <div className="journal-card-meta">
                  {/* Every material, not just the first: a merged order named only its lead sheet
                      on the phone, which is where a manager checks what a customer ordered. */}
                  {describeLines(lines) || order.materialSnapshot.name}
                  {order.pvcMetersTotal > 0 && ` · ${order.pvcMetersTotal} м ПВХ`}
                </div>
                <div className="journal-card-money">
                  <span>{formatMoney(order.totalTiyn)}</span>
                  {cardDebt > 0 && <span className="jt-debt">Қарыз {formatMoney(cardDebt)}</span>}
                  {cardDebt < 0 && <span className="jt-over">Артық {formatMoney(-cardDebt)}</span>}
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
                <th className="jt-w-pick" title="Біріктіру үшін таңдау"></th>
                <th className="jt-sticky jt-col-num">№</th>
                <th className="jt-sticky jt-col-name">Клиент</th>
                <th className="jt-w-phone">Телефон</th>
                <th className="jt-tint-material jt-w-mat">Материал</th>
                <th className="jt-tint-material jt-num jt-w-qty" title="Лист саны">Саны</th>
                <th className="jt-tint-material jt-num jt-w-money" title="Лист бағасы">Баға</th>
                <th className="jt-tint-pvc jt-num jt-w-qty" title="ПВХ метр">м</th>
                {/* Which roll the metres came off. Without it the ПВХ report can only say how many
                    metres went out in total, and the per-colour stock never moves for a walk-in. */}
                <th className="jt-tint-pvc jt-w-pvc" title="ПВХ түсі — қай өңнен кетті">ПВХ түсі</th>
                <th className="jt-tint-pvc jt-num jt-w-money" title="ПВХ 1 метр бағасы">ПВХ баға</th>
                <th className="jt-tint-pvc jt-num jt-w-money" title="Жалпы ПВХ сомасы">ПВХ сома</th>
                <th className="jt-tint-total jt-num jt-w-money" title="Есептелген сома">Сома</th>
                <th className="jt-w-status">Статус</th>
                <th className="jt-w-date">Күні</th>
                <th className="jt-tint-pay jt-w-method">Төлем түрі</th>
                <th className="jt-tint-pay jt-num jt-w-money">Төленген</th>
                {/* Қалдық dropped: it was the same fact as the Статус beside it (a row owing money
                    reads "Қарыз" there) and the day's outstanding total is in the footer, so the
                    column spent 6% of the ledger repeating an answer. The exact figure lives on
                    the Статус cell's tooltip, and the CSV/Excel export still carries the column.
                    Распил / ПВХ / Дайын went the same way earlier. */}
                <th className="jt-w-cut" title="Распил кезегіне жіберу">Распилға жіберу</th>
                <th className="jt-w-act" title="Әрекет">⋯</th>
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
                <tr><td colSpan={18} className="jt-empty">Жүктелуде…</td></tr>
              ) : pageItems.length === 0 && !newRow ? (
                <tr><td colSpan={18} className="jt-empty">Заказдар табылмады</td></tr>
              ) : (
                pageItems.map((order) => (
                  <JournalRow
                    key={order.id}
                    order={order}
                    materials={materials}
                    pvcTypes={pvcTypes}
                    methods={methods}
                    payments={paymentsByOrder.get(order.id) ?? []}
                    actor={actor}
                    selected={picked.has(order.id)}
                    onToggleSelect={() => togglePick(order.id)}
                    onOpen={() => navigate(`/manager/order/${order.id}`)}
                    onAddPayment={() => setPayFor(order)}
                    onSetPaymentState={(choice) => handleSetPaymentState(order, choice)}
                    onSetPaid={(amountTiyn) => handleSetPaid(order, amountTiyn)}
                    onQueue={() => handleQueueOrder(order)}
                    onOverrideQueue={() => handleOverrideQueueOrder(order)}
                    onError={showToast}
                  />
                ))
              )}

              {newRow && (
                <NewJournalRow
                  draft={newRow}
                  setDraft={setNewRow}
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
          <kbd>Shift</kbd>+<kbd>Enter</kbd> — жоғарғы жол, <kbd>Tab</kbd> — келесі баған.
        </p>

        <div className="journal-pagination">
          <span className="journal-page-info">
            {filtered.length === 0 ? "0" : `${(safePage - 1) * pageSize + 1}–${Math.min(safePage * pageSize, filtered.length)}`} / {filtered.length} заказ
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

        {payments.length > 0 && (
          <div className="form-group">
            <label>Тіркелген төлемдер — түрін өзгертуге болады</label>
            {payments.map((p) => (
              <div key={p.id} className="pay-recorded-row">
                <span className="pay-recorded-sum">{formatMoney(p.amountTiyn)}</span>
                <select
                  className="form-input"
                  value={p.methodId}
                  onChange={(e) => onChangeMethod(p, e.target.value)}
                  aria-label="Төлем түрі"
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
          </div>
        )}

        <div className="form-group">
          <label>{payments.length > 0 ? "Жаңа төлем түрі" : "Төлем түрі"}</label>
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
 *
 * A merged order ("2 материал") renders as this row plus one sub-row per material. The sub-rows
 * are where its sheets, prices and metres are edited: the parent's own material cells would have
 * to answer "which line?" and, before this, answered by pricing every sheet in the order at the
 * first line's rate.
 */
function JournalRow({
  order, materials, pvcTypes, payments, actor, selected, onToggleSelect, onOpen, onAddPayment,
  onSetPaymentState, onSetPaid, onQueue, onOverrideQueue, onError,
}: {
  order: Order;
  materials: Material[];
  pvcTypes: PvcType[];
  methods: PaymentMethodDef[];
  payments: Payment[];
  actor: Parameters<typeof saveJournalRow>[1];
  selected: boolean;
  onToggleSelect: () => void;
  onOpen: () => void;
  /** Opens the payment dialog for this row; the method and amount are chosen there. */
  onAddPayment: () => void;
  /** Settles the order in full, or undoes that if it is already paid. */
  onSetPaymentState: (choice: PaymentChoice) => void;
  /** The Төленген cell, typed into directly — records or corrects to exactly this figure. */
  onSetPaid: (amountTiyn: number) => void;
  /** Sends a fully-paid row straight to the cutting queue. */
  onQueue: () => void;
  /** "Қарызға кесу" — sends an unpaid/partially-paid row to the queue anyway, reason required. */
  onOverrideQueue: () => void;
  onError: (message: string) => void;
}) {
  const materialsById = useMemo(() => new Map(materials.map((m) => [m.id, m])), [materials]);
  const pvcTypesById = useMemo(() => new Map(pvcTypes.map((p) => [p.id, p])), [pvcTypes]);
  const catalog = useMemo(() => ({ materials: materialsById, pvcTypes: pvcTypesById }), [materialsById, pvcTypesById]);
  const byMethod = paidByMethod(payments);
  const paid = netPaidTiyn(payments);

  const [draft, setDraft] = useState<JournalDraft>(() => draftFromOrder(order));
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [expanded, setExpanded] = useState(false);
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
        await saveJournalRow(db, actor, order, draft, catalog);
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

  /** Edits one material line in place; every other line is left exactly as it was. */
  const patchLine = (index: number, p: Partial<JournalDraftLine>) => {
    dirtyRef.current = true;
    setSaveState("dirty");
    setDraft((prev) => ({
      ...prev,
      lines: prev.lines.map((line, i) => (i === index ? { ...line, ...p } : line)),
    }));
  };

  /**
   * Picking a material fills in the shop's standing rates for that line; all stay editable.
   * Cutting labour is an order-level charge, so it is repriced from the whole row's sheets.
   */
  const pickMaterial = (index: number, materialId: string) => {
    const m = materialsById.get(materialId);
    const rates = journalDefaultsFor(m);
    dirtyRef.current = true;
    setSaveState("dirty");
    setDraft((prev) => {
      const lines = prev.lines.map((line, i) =>
        i === index
          ? {
              ...line,
              materialId,
              materialName: m?.name ?? "",
              sheetPriceTiyn: m?.sellingPriceTiyn ?? line.sheetPriceTiyn,
              pvcPricePerMeterTiyn: rates.pvcPricePerMeterTiyn,
            }
          : line,
      );
      const sheets = lines.reduce((sum, l) => sum + l.sheetQty, 0);
      return {
        ...prev,
        lines,
        ...(rates.cuttingPerSheetTiyn > 0 ? { cuttingCostTiyn: rates.cuttingPerSheetTiyn * sheets } : {}),
      };
    });
  };

  /**
   * Adding or removing a material is a structural change, and the cutting queue has already been
   * handed a job per line by the time an order leaves QUEUE_STAGE_STATUSES — a line added after
   * that would never reach the saw, and one removed would leave a job pointing at nothing. Prices
   * and quantities stay editable at every stage; only the shape of the order is frozen, which is
   * the same line "Біріктіру" refuses to cross (see planMerge's IN_PRODUCTION).
   */
  const structuralEditsAllowed = QUEUE_STAGE_STATUSES.includes(order.productionStatus);

  /**
   * Picking an edge-banding colour for one line.
   *
   * The rate is filled in from the colour's configured price only when the cell is still empty:
   * the shop prices ПВХ per deal (200 for Ақ, 220 for the rest, sometimes neither), and a colour
   * chosen afterwards must not quietly reprice a line the manager already agreed.
   */
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
    dirtyRef.current = true;
    setSaveState("dirty");
    setExpanded(true);
    setDraft((prev) => ({ ...prev, lines: [...prev.lines, emptyJournalLine()] }));
  };

  const removeLine = (index: number) => {
    if (!structuralEditsAllowed) return;
    if (draft.lines.length <= 1) return; // a row is always at least one material
    if (!confirm(`«${draft.lines[index].materialName || "материал"}» жолы өшіріледі. Жалғастырасыз ба?`)) return;
    dirtyRef.current = true;
    setSaveState("dirty");
    setDraft((prev) => ({ ...prev, lines: prev.lines.filter((_, i) => i !== index) }));
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
  const preview = computeJournalRowTotals(totalsInputFor(draft, paid));

  const shortNum = order.orderNumber.match(/(\d+)$/)?.[1]?.replace(/^0+/, "") ?? order.orderNumber;
  const multi = draft.lines.length > 1;
  const sheetTotal = draft.lines.reduce((sum, l) => sum + l.sheetQty, 0);
  const pvcTotal = draft.lines.reduce((sum, l) => sum + l.pvcMeters, 0);
  const linesLabel = draft.lines
    .map((l) => `${l.sheetQty} лист ${l.materialName || materialsById.get(l.materialId)?.name || "—"}`)
    .join(" · ");
  // A merged row cannot offer one colour picker for lines that may use two, so its parent names
  // the colours in use and leaves the picking to the sub-rows.
  const pvcSummary =
    [...new Set(draft.lines.filter((l) => l.pvcMeters > 0).map((l) => l.pvcColorName || "—"))].join(", ") || "—";

  return (
    <>
      <tr className={`jt-row${selected ? " is-picked" : ""}${multi ? " is-parent" : ""}`}>
        <td className="jt-w-pick">
          <input
            type="checkbox"
            className="jt-pick"
            checked={selected}
            onChange={onToggleSelect}
            aria-label={`${order.orderNumber} — біріктіру үшін таңдау`}
          />
        </td>
        <td className="jt-sticky jt-col-num">
          <button className="jt-num-link" onClick={onOpen} title={order.orderNumber}
          aria-label={`${order.orderNumber} — заказды ашу`}>{shortNum}</button>
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
          {multi ? (
            // The parent of a multi-material row names its lines and opens them; a dropdown here
            // would have to answer "which of the two?" and picking from it would discard the rest.
            <button className="jt-merged" onClick={() => setExpanded((v) => !v)} title={linesLabel}>
              {expanded ? "▾" : "▸"} {draft.lines.length} материал
            </button>
          ) : (
            <select
              className="jt-input"
              value={draft.lines[0].materialId}
              onChange={(e) => pickMaterial(0, e.target.value)}
            >
              <option value="">{draft.lines[0].materialName || order.materialSnapshot.name || "Лист түрі"}</option>
              {materials.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          )}
        </td>

        {multi ? (
          // Sheets and metres still add up across lines, so the parent shows the totals; the money
          // columns say "—" rather than a single price that is true of only one of the materials.
          <>
            <td className="jt-tint-material jt-num jt-agg" title="Барлық материалдың листі">{sheetTotal}</td>
            <td className="jt-tint-material jt-num jt-muted">—</td>
            <td className="jt-tint-pvc jt-num jt-agg">{pvcTotal || "—"}</td>
            <td className="jt-tint-pvc jt-muted">{pvcSummary}</td>
            <td className="jt-tint-pvc jt-num jt-muted">—</td>
          </>
        ) : (
          <>
            <td className="jt-tint-material jt-num">
              <NumberField className="jt-input jt-input-num" value={draft.lines[0].sheetQty} min={0}
                onChange={(v) => patchLine(0, { sheetQty: v })} ariaLabel="Лист саны" />
            </td>
            <td className="jt-tint-material jt-num">
              <NumberField className="jt-input jt-input-num" value={draft.lines[0].sheetPriceTiyn / 100} min={0}
                onChange={(v) => patchLine(0, { sheetPriceTiyn: Math.round(v * 100) })} ariaLabel="Лист бағасы" />
            </td>
            <td className="jt-tint-pvc jt-num">
              <NumberField className="jt-input jt-input-num" value={draft.lines[0].pvcMeters} min={0}
                onChange={(v) => patchLine(0, { pvcMeters: v })} ariaLabel="ПВХ метр" />
            </td>
            <td className="jt-tint-pvc">
              <PvcColorSelect pvcTypes={pvcTypes} line={draft.lines[0]} onPick={(id) => pickPvcType(0, id)} />
            </td>
            <td className="jt-tint-pvc jt-num">
              <NumberField className="jt-input jt-input-num" value={draft.lines[0].pvcPricePerMeterTiyn / 100} min={0}
                onChange={(v) => patchLine(0, { pvcPricePerMeterTiyn: Math.round(v * 100) })} ariaLabel="ПВХ 1 м бағасы" />
            </td>
          </>
        )}

        <td className="jt-tint-pvc jt-num">{formatMoneyBare(preview.pvcCostTiyn)}</td>

        <td className="jt-tint-total jt-num jt-total">{formatMoneyBare(preview.totalTiyn)}</td>

        {/* Pick the state, and the money is made to match (see handleSetPaymentState). "Артық
            төленді" only ever appears as the current value — choosing Төленді corrects it. */}
        <td>
          <select
            className={`jt-pay-toggle jt-pay-select jt-pay-${preview.paymentStatus}`}
            value={preview.paymentStatus}
            onChange={(e) => onSetPaymentState(e.target.value as PaymentChoice)}
            // The Қалдық column is gone, so the exact figure lives here — hovering a "Қарыз" or
            // "Жартылай" row still answers "how much?" without opening the order.
            title={
              preview.debtTiyn > 0 ? `${PAYMENT_STATUS_LABELS[preview.paymentStatus]} — қалдық ${formatMoney(preview.debtTiyn)}`
              : preview.debtTiyn < 0 ? `${PAYMENT_STATUS_LABELS[preview.paymentStatus]} — артық ${formatMoney(-preview.debtTiyn)}`
              : PAYMENT_STATUS_LABELS[preview.paymentStatus]
            }
          >
            {preview.paymentStatus === "overpaid" && <option value="overpaid">Артық</option>}
            {preview.paymentStatus === "refunded" && <option value="refunded">Қайтарылды</option>}
            {PAYMENT_CHOICES.map((c) => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
        </td>

        {/* A ledger row is dated the day the work was agreed, and a row typed up the next morning
            has to be movable back to it — so the date is a cell like any other. */}
        <td className="jt-w-date">
          <input type="date" className="jt-input jt-input-date" value={dayKey(draft.orderDate)}
            aria-label="Заказ күні"
            onChange={(e) => patch({
              orderDate: e.target.value ? new Date(`${e.target.value}T12:00:00+05:00`) : draft.orderDate,
            })} />
        </td>

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

        {/* Typed into directly: the figure you correct is the figure the order is paid. */}
        <td className="jt-tint-pay jt-num">
          <PaidCell paidTiyn={paid} title={methodBreakdown} onCommit={onSetPaid} />
        </td>

        {/* The column the Қалдық figure gave up its place to: the one action that actually moves a
            row forward. Once the order has left QUEUE_STAGE_STATUSES it already has an answer
            (queued, cutting, cut) and shows the same stage pill AdminOrders/CustomerOrders use;
            while it is still on the payment gate this is the button — a normal send once paid, or
            "Қарызға кесу" (reason required, audited) when it is not, because the shop does
            sometimes cut on credit for a trusted customer. */}
        <td className="jt-w-cut">
          {QUEUE_STAGE_STATUSES.includes(order.productionStatus) ? (
            canEnterCuttingQueue(order.paymentStatus) ? (
              <button className="btn btn-primary btn-sm jt-cut-btn" onClick={onQueue} title="Распил кезегіне жіберу">
                📦 Распилға жіберу
              </button>
            ) : (
              <button className="btn btn-danger-outline btn-sm jt-cut-btn" onClick={onOverrideQueue}
                title={`Қарызға кесуге жіберу — қалдық ${formatMoney(Math.max(0, preview.debtTiyn))}`}>
                ⚠️ Қарызға жіберу
              </button>
            )
          ) : (
            <span className={`jt-pill jt-tone-${stageStates(order).cutting.tone}`}>{stageStates(order).cutting.label}</span>
          )}
        </td>

        <td className="jt-actions">
          <span className={`jt-save-dot is-${saveState}`} title={SAVE_TITLES[saveState]} aria-live="polite">
            {SAVE_GLYPHS[saveState]}
          </span>
          <button className="jt-icon-btn" onClick={addLine} disabled={!structuralEditsAllowed}
            title={structuralEditsAllowed ? "Осы заказға тағы материал қосу" : "Заказ өндіріске кеткен — материал қосуға болмайды"}
            aria-label="Осы заказға тағы материал қосу">
            ＋
          </button>
          <button className="jt-icon-btn" onClick={onOpen} title="Толық ашу" aria-label="Заказды толық ашу">↗</button>
        </td>
      </tr>

      {multi && expanded && draft.lines.map((line, index) => (
        <tr key={index} className="jt-row jt-subrow">
          <td className="jt-w-pick" />
          <td className="jt-sticky jt-col-num jt-muted">└</td>
          <td className="jt-sticky jt-col-name jt-muted jt-subrow-label">{index + 1}-материал</td>
          <td />
          <td className="jt-tint-material">
            <select className="jt-input" value={line.materialId} onChange={(e) => pickMaterial(index, e.target.value)}>
              <option value="">{line.materialName || "Лист түрі"}</option>
              {materials.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </td>
          <td className="jt-tint-material jt-num">
            <NumberField className="jt-input jt-input-num" value={line.sheetQty} min={0}
              onChange={(v) => patchLine(index, { sheetQty: v })} ariaLabel="Лист саны" />
          </td>
          <td className="jt-tint-material jt-num">
            <NumberField className="jt-input jt-input-num" value={line.sheetPriceTiyn / 100} min={0}
              onChange={(v) => patchLine(index, { sheetPriceTiyn: Math.round(v * 100) })} ariaLabel="Лист бағасы" />
          </td>
          <td className="jt-tint-pvc jt-num">
            <NumberField className="jt-input jt-input-num" value={line.pvcMeters} min={0}
              onChange={(v) => patchLine(index, { pvcMeters: v })} ariaLabel="ПВХ метр" />
          </td>
          <td className="jt-tint-pvc">
            <PvcColorSelect pvcTypes={pvcTypes} line={line} onPick={(id) => pickPvcType(index, id)} />
          </td>
          <td className="jt-tint-pvc jt-num">
            <NumberField className="jt-input jt-input-num" value={line.pvcPricePerMeterTiyn / 100} min={0}
              onChange={(v) => patchLine(index, { pvcPricePerMeterTiyn: Math.round(v * 100) })} ariaLabel="ПВХ 1 м бағасы" />
          </td>
          <td className="jt-tint-pvc jt-num jt-muted">
            {formatMoneyBare(preview.lineTotals[index]?.pvcCostTiyn ?? 0)}
          </td>
          <td className="jt-tint-total jt-num jt-subtotal">
            {formatMoneyBare(preview.lineTotals[index]?.lineTotalTiyn ?? 0)}
          </td>
          {/* Status, date, payment and the cutting action belong to the order, never to one of its
              materials — the sub-row leaves them blank rather than repeating the parent's. */}
          <td colSpan={5} />
          <td className="jt-actions">
            <button className="jt-icon-btn" onClick={() => removeLine(index)} disabled={!structuralEditsAllowed}
              title={structuralEditsAllowed ? "Материалды өшіру" : "Заказ өндіріске кеткен — материалды өшіруге болмайды"}
              aria-label={`${index + 1}-материалды өшіру`}>
              ✕
            </button>
          </td>
        </tr>
      ))}
    </>
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

function NewJournalRow({
  draft, setDraft, materials, pvcTypes, nameRef, saving, onSave, onCancel,
}: {
  draft: JournalDraft;
  setDraft: (d: JournalDraft) => void;
  materials: Material[];
  pvcTypes: PvcType[];
  /** Focused when the row opens, and again if "Жаңа заказ қосу" is pressed while it is open. */
  nameRef: RefObject<HTMLInputElement | null>;
  saving: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  const patch = (p: Partial<JournalDraft>) => setDraft({ ...draft, ...p });
  const line = draft.lines[0];
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
      <td className="jt-sticky jt-col-num jt-muted">жаңа</td>
      <td className="jt-sticky jt-col-name">
        <input ref={nameRef} className="jt-input" placeholder="Клиент аты" value={draft.customerName}
          onChange={(e) => patch({ customerName: e.target.value })} />
      </td>
      <td>
        <input className="jt-input" placeholder="+7 (___) ___-__-__" value={draft.customerPhone}
          onChange={(e) => patch({ customerPhone: e.target.value })} />
      </td>
      <td className="jt-tint-material">
        <select className="jt-input" value={line.materialId}
          onChange={(e) => {
            const m = materials.find((x) => x.id === e.target.value);
            // Picking a material fills in the shop's standing rates: ПВХ 200 for Ақ, 220 for the
            // rest, and 1600/лист + 160/м of labour on a customer's own board. All stay editable.
            const rates = journalDefaultsFor(m);
            setDraft({
              ...draft,
              lines: [{
                ...line,
                materialId: e.target.value,
                materialName: m?.name ?? "",
                sheetPriceTiyn: m?.sellingPriceTiyn ?? line.sheetPriceTiyn,
                pvcPricePerMeterTiyn: rates.pvcPricePerMeterTiyn,
              }, ...draft.lines.slice(1)],
              cuttingCostTiyn: rates.cuttingPerSheetTiyn * (line.sheetQty || 0),
            });
          }}>
          <option value="">Лист түрін таңдаңыз</option>
          {materials.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
      </td>
      {/* NumberField, not a raw `value={n}` input, for the same reason the saved rows use it: a
          plain controlled number field snaps an emptied box straight back to "0", so the last
          digit can never be deleted and every untouched cell sits there showing a zero nobody
          typed. These stay blank until there is a real figure in them. */}
      <td className="jt-tint-material jt-num">
        <NumberField className="jt-input jt-input-num" value={line.sheetQty} min={0}
          onChange={(v) => patchLine({ sheetQty: v })} ariaLabel="Лист саны" />
      </td>
      <td className="jt-tint-material jt-num">
        <NumberField className="jt-input jt-input-num" value={line.sheetPriceTiyn / 100} min={0}
          onChange={(v) => patchLine({ sheetPriceTiyn: Math.round(v * 100) })} ariaLabel="Лист бағасы" />
      </td>
      <td className="jt-tint-pvc jt-num">
        <NumberField className="jt-input jt-input-num" value={line.pvcMeters} min={0}
          onChange={(v) => patchLine({ pvcMeters: v })} ariaLabel="ПВХ метр" />
      </td>
      <td className="jt-tint-pvc">
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
      </td>
      <td className="jt-tint-pvc jt-num">
        <NumberField className="jt-input jt-input-num" value={line.pvcPricePerMeterTiyn / 100} min={0}
          onChange={(v) => patchLine({ pvcPricePerMeterTiyn: Math.round(v * 100) })} ariaLabel="ПВХ 1 м бағасы" />
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
          through the transactional recordPayment path, never typed straight onto a new order. And
          nothing can be sent to the saw until it does, so the action cell is empty too. */}
      <td className="jt-muted">—</td>
      <td className="jt-tint-pay jt-num jt-muted">—</td>
      <td className="jt-w-cut jt-muted">—</td>
      <td className="jt-actions">
        <button className="jt-icon-btn is-ok" disabled={saving} onClick={onSave} title="Қосу" aria-label="Жаңа заказды қосу">✓</button>
        <button className="jt-icon-btn" disabled={saving} onClick={onCancel} title="Болдырмау" aria-label="Жаңа жолды болдырмау">✕</button>
      </td>
    </tr>
  );
}
