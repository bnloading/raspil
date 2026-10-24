import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { getDocs, collection, doc, updateDoc } from "firebase/firestore";
import type { User } from "firebase/auth";
import { db } from "../../firebase";
import { useAuth } from "../../AuthContext";
import { Spinner, Toast } from "../../components";
import { AppShell } from "../../components/layout/AppShell";
import { PaymentStatusBadge } from "../../components/StatusBadge";
import { useAllOrders } from "../../hooks/useOrders";
import { useToast } from "../../hooks";
import { useAppSettings } from "../../hooks/useAppSettings";
import {
  computeMdfOrderTotal,
  findMdfPatternTemplate,
  formatMdfArea,
  mdfPatternOf,
  mdfPatternTemplates,
  mdfTemplatesProblem,
} from "../../lib/mdfJournal";
import {
  createMdfJournalOrder,
  draftFromMdfOrder,
  emptyMdfJournalDraft,
  mdfDraftHasContent,
  publishMdfPrice,
  saveMdfJournalRow,
  type MdfJournalDraft,
} from "../../lib/mdfJournalOrders";
import { logAudit } from "../../lib/audit";
import { enterMdfProduction } from "../../lib/mdfOrderStatus";
import { recordPayment } from "../../lib/payments";
import { formatMoney } from "../../lib/money";
import { formatDateDMY } from "../../lib/dates";
import { formatPhone } from "../../lib/phone";
import { exportCsv } from "../../lib/exportTable";
import { isAdmin, methodVisibleTo } from "../../lib/rbac";
import { MDF_STAGE_LABELS } from "../../types/domain";
import type { MdfPatternTemplate, Order, PaymentMethodDef, UserDoc } from "../../types/domain";

type Actor = { user: User; userData: UserDoc };
type Filter = "all" | "paid" | "unpaid" | "ready";

/** Production-side status text for one row's Өндіріс cell — the specific station once queued,
 *  matching the mockup's "ЧПУ кезегінде / Шкурада / Краскада / Вакуумда / Дайын / Жіберілмеді". */
function productionCell(order: Order): { label: string; tone: "muted" | "amber" | "green" } {
  if (order.productionStatus === "ready" || order.productionStatus === "delivered") {
    return { label: "Дайын", tone: "green" };
  }
  if (order.productionStatus === "mdf_production" && order.mdfStage) {
    return { label: `${MDF_STAGE_LABELS[order.mdfStage]}де`, tone: "amber" };
  }
  return { label: "Жіберілмеді", tone: "muted" };
}

/**
 * "МДФ — ТАПСЫРЫС ЖУРНАЛЫ" — the walk-in ledger for the МДФ line, parallel to ManagerJournal's
 * ЛДСП journal but without its multi-material-line/merge machinery: a МДФ order is always one
 * area × price job (see lib/mdfJournal.ts), so a card list stands in for the spreadsheet-style
 * editable table the ЛДСП journal needs for its richer row shape.
 */
export default function ManagerMdfJournal() {
  const { user, userData } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { orders: allOrders, loading } = useAllOrders();
  const { message, visible, showToast } = useToast();
  const [methods, setMethods] = useState<PaymentMethodDef[]>([]);
  const [search, setSearch] = useState(searchParams.get("q") ?? "");
  const [filter, setFilter] = useState<Filter>("all");
  // The order form: `{}` for a new order, `{ order }` to correct one.
  const [form, setForm] = useState<{ order?: Order } | null>(null);
  const [showTemplates, setShowTemplates] = useState(false);
  const { settings } = useAppSettings();
  const templates = useMemo(() => mdfPatternTemplates(settings), [settings]);
  const [payFor, setPayFor] = useState<Order | null>(null);
  const [priceFor, setPriceFor] = useState<Order | null>(null);

  useEffect(() => {
    getDocs(collection(db, "paymentMethods")).then((snap) =>
      setMethods(
        snap.docs
          .map((d) => ({ id: d.id, ...(d.data() as Omit<PaymentMethodDef, "id">) }))
          .filter((m) => methodVisibleTo(m, "mdf")),
      ),
    );
  }, []);

  const orders = useMemo(() => allOrders.filter((o) => o.orderKind === "mdf_wrap"), [allOrders]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return orders.filter((o) => {
      if (filter === "paid" && o.paymentStatus !== "paid" && o.paymentStatus !== "overpaid") return false;
      if (filter === "unpaid" && o.paymentStatus !== "unpaid" && o.paymentStatus !== "partial") return false;
      if (filter === "ready" && o.productionStatus !== "ready" && o.productionStatus !== "delivered") return false;
      if (!q) return true;
      return o.customerName.toLowerCase().includes(q) || o.orderNumber.toLowerCase().includes(q);
    });
  }, [orders, search, filter]);

  const counts = useMemo(
    () => ({
      all: orders.length,
      paid: orders.filter((o) => o.paymentStatus === "paid" || o.paymentStatus === "overpaid").length,
      unpaid: orders.filter((o) => o.paymentStatus === "unpaid" || o.paymentStatus === "partial").length,
      ready: orders.filter((o) => o.productionStatus === "ready" || o.productionStatus === "delivered").length,
    }),
    [orders],
  );

  if (!user || !userData) return <Spinner />;
  const actor: Actor = { user, userData };

  const handleSendToProduction = async (order: Order) => {
    try {
      await enterMdfProduction(db, actor, order, { isAdmin: isAdmin(userData.role), queuePosition: 0 });
      showToast(`✅ ${order.orderNumber} өндіріске жіберілді`);
    } catch (err: unknown) {
      showToast("Қате: " + (err as Error).message);
    }
  };

  const handleExport = () =>
    exportCsv(
      "мдф-заказдар",
      filtered.map((o) => ({
        "Заказ №": o.orderNumber,
        Клиент: o.customerName,
        Телефон: o.customerPhone,
        Узор: mdfPatternOf(o),
        "м²": Math.round((o.mdfAreaM2 ?? 0) * 100) / 100,
        "м² бағасы": (o.mdfPricePerM2Tiyn ?? 0) / 100,
        "Пленка түсі": o.mdfFilmColor ?? "",
        Барлығы: o.totalTiyn / 100,
        Төленді: o.paidTiyn / 100,
        Қарыз: o.debtTiyn / 100,
        Өндіріс: productionCell(o).label,
        Күні: o.createdAt ? formatDateDMY(o.createdAt) : "",
      })),
    );

  return (
    <AppShell
      title="МДФ — Тапсырыс журналы"
      subtitle={`Сәлем, ${userData.name}`}
      search={{ value: search, onChange: setSearch, placeholder: "Клиент немесе заказ №..." }}
      actions={
        <>
          <button className="btn btn-primary btn-sm" onClick={() => setForm({})}>
            + Жаңа заказ
          </button>
          {isAdmin(userData.role) && (
            <button className="btn btn-outline btn-sm" onClick={() => setShowTemplates(true)}>
              Узор шаблондары
            </button>
          )}
          <button className="btn btn-outline btn-sm" onClick={handleExport}>
            CSV жүктеу
          </button>
        </>
      }
    >
      <div className="status-filter-row">
        <button className={`status-filter-btn${filter === "all" ? " active" : ""}`} onClick={() => setFilter("all")}>
          <span>Барлығы</span>
          <b>{counts.all}</b>
        </button>
        <button className={`status-filter-btn${filter === "paid" ? " active" : ""}`} onClick={() => setFilter("paid")}>
          <span>Төленді</span>
          <b>{counts.paid}</b>
        </button>
        <button className={`status-filter-btn${filter === "unpaid" ? " active" : ""}`} onClick={() => setFilter("unpaid")}>
          <span>Төленбеді</span>
          <b>{counts.unpaid}</b>
        </button>
        <button className={`status-filter-btn${filter === "ready" ? " active" : ""}`} onClick={() => setFilter("ready")}>
          <span>Дайын</span>
          <b>{counts.ready}</b>
        </button>
      </div>

      {form && (
        <MdfOrderForm
          key={form.order?.id ?? "new"}
          actor={actor}
          order={form.order}
          templates={templates}
          onClose={() => setForm(null)}
          onSaved={(saved) => {
            setForm(null);
            showToast(saved);
          }}
          onError={showToast}
        />
      )}

      <div className="orders-section">
        {loading ? (
          <Spinner />
        ) : filtered.length === 0 ? (
          <div className="empty-state">
            <div className="icon">📭</div>
            <p>МДФ заказы жоқ</p>
          </div>
        ) : (
          filtered.map((o) => {
            const production = productionCell(o);
            // recordPayment() already flips productionStatus to "paid" the moment paidTiyn covers
            // the total (lib/payments.ts's nextProductionStatusForPayment) — that's the same gate
            // enterMdfProduction re-checks, so "paid" is the one status this button needs to watch.
            const canSend = o.productionStatus === "paid";
            return (
              <div key={o.id} className="track-card">
                <div className="track-card-header">
                  <span className="track-card-num">{o.orderNumber} · {o.customerName}</span>
                  <strong>{formatMoney(o.totalTiyn)}</strong>
                </div>
                <div className="track-card-meta-row">
                  <span>{o.customerPhone ? formatPhone(o.customerPhone) : "—"}</span>
                  <span>{o.mdfFilmColor || "—"}</span>
                </div>
                {/* What the order is priced on: the «Узор», the area and the rate — the three
                    things the МДФ counter writes down. */}
                <div className="track-card-meta-row">
                  <span>{mdfPatternOf(o) || "Узор жазылмаған"}</span>
                  <span>
                    {formatMdfArea(o.mdfAreaM2)}
                    {o.mdfPricePerM2Tiyn ? ` × ${formatMoney(o.mdfPricePerM2Tiyn)}` : ""}
                  </span>
                </div>
                <div className="track-card-meta-row">
                  {o.pricePublished ? (
                    <button className="btn btn-outline btn-sm" onClick={() => setPayFor(o)}>
                      <PaymentStatusBadge status={o.paymentStatus} />
                    </button>
                  ) : (
                    <button className="btn btn-primary btn-sm" onClick={() => setPriceFor(o)}>
                      💰 Баға белгілеу
                    </button>
                  )}
                  <span className={`jt-pill jt-tone-${production.tone}`}>{production.label}</span>
                  {o.createdAt && <span>{formatDateDMY(o.createdAt)}</span>}
                </div>
                <div className="track-card-meta-row">
                  {canSend && (
                    <button className="btn btn-primary btn-sm" onClick={() => handleSendToProduction(o)}>
                      Өндіріске жіберу →
                    </button>
                  )}
                  {o.pricePublished && o.productionStatus !== "cancelled" && (
                    <button className="btn btn-outline btn-sm" onClick={() => setForm({ order: o })}>
                      Өзгерту
                    </button>
                  )}
                  <button className="btn btn-outline btn-sm" onClick={() => navigate(`/manager/order/${o.id}`)}>
                    Ашу →
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      {priceFor && (
        <MdfPriceDialog
          order={priceFor}
          actor={actor}
          onClose={() => setPriceFor(null)}
          onToast={showToast}
        />
      )}

      {showTemplates && (
        <MdfTemplatesDialog
          templates={templates}
          actor={actor}
          onClose={() => setShowTemplates(false)}
          onToast={showToast}
        />
      )}

      {payFor && (
        <MdfPaymentDialog
          order={payFor}
          methods={methods}
          actor={actor}
          onClose={() => setPayFor(null)}
          onToast={showToast}
        />
      )}

      <Toast message={message} visible={visible} />
    </AppShell>
  );
}

/** «Басқа» in the Узор select: the pattern is typed by hand, and so is its price. */
const OTHER_PATTERN = "__other";

/**
 * A МДФ order as the counter writes it down: who, which «Узор», how many м², at what rate.
 * Picking a template fills the rate in — it stays a figure the manager can still change — and
 * «Басқа» takes a name and a rate typed by hand. Opens empty for a new order, or on an existing one
 * to correct it, which re-prices it and leaves its payments alone (lib/mdfJournalOrders.ts).
 */
function MdfOrderForm({
  actor,
  order,
  templates,
  onClose,
  onSaved,
  onError,
}: {
  actor: Actor;
  /** The order being corrected; absent for a new one. */
  order?: Order;
  templates: MdfPatternTemplate[];
  onClose: () => void;
  onSaved: (message: string) => void;
  onError: (msg: string) => void;
}) {
  const [draft, setDraft] = useState<MdfJournalDraft>(() => (order ? draftFromMdfOrder(order) : emptyMdfJournalDraft()));
  // An order whose «Узор» is not on the list was typed by hand, and opens that way.
  const [custom, setCustom] = useState(
    () => !!order?.mdfPatternName?.trim() && !findMdfPatternTemplate(templates, order.mdfPatternName),
  );
  // Typed as text: «28,4» with a comma is how the area is written at this counter.
  const [areaText, setAreaText] = useState(() => (order?.mdfAreaM2 ? String(order.mdfAreaM2) : ""));
  const [busy, setBusy] = useState(false);

  const template = custom ? undefined : findMdfPatternTemplate(templates, draft.patternName);
  const preview = computeMdfOrderTotal({
    areaM2: draft.areaM2,
    pricePerM2Tiyn: draft.pricePerM2Tiyn,
    extraServicesTiyn: draft.extraServicesTiyn,
    deliveryCostTiyn: draft.deliveryCostTiyn,
    discountTiyn: draft.discountTiyn,
    paidTiyn: 0,
  });
  const missing =
    !draft.patternName.trim() ? (custom ? "Узор атын жазыңыз" : "Узор таңдаңыз")
    : draft.areaM2 <= 0 ? "м² жазыңыз"
    : draft.pricePerM2Tiyn <= 0 ? "м² бағасын жазыңыз"
    : null;

  const pickPattern = (value: string) => {
    if (value === OTHER_PATTERN) {
      setCustom(true);
      setDraft({ ...draft, patternName: "", pricePerM2Tiyn: 0 });
      return;
    }
    setCustom(false);
    const picked = templates.find((t) => t.name === value);
    setDraft({ ...draft, patternName: picked?.name ?? "", pricePerM2Tiyn: picked?.pricePerM2Tiyn ?? 0 });
  };

  const handleClose = () => {
    if (!order && mdfDraftHasContent(draft) && !confirm("Жазылған деректер жоғалады. Жабу керек пе?")) return;
    onClose();
  };

  const handleSave = async () => {
    if (missing) return;
    setBusy(true);
    try {
      if (order) {
        await saveMdfJournalRow(db, actor, order, draft);
        onSaved(`✅ ${order.orderNumber} өзгертілді`);
      } else {
        await createMdfJournalOrder(db, actor, draft);
        onSaved("✅ Жаңа заказ қосылды");
      }
    } catch (err: unknown) {
      onError("Қате: " + (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel-card">
      <div className="panel-head">
        <h3>{order ? `${order.orderNumber} — өзгерту` : "Жаңа МДФ заказ"}</h3>
        <button className="btn btn-outline btn-sm" onClick={handleClose}>✕</button>
      </div>
      <div className="form-group">
        <label>Клиент аты</label>
        <input
          className="form-input"
          value={draft.customerName}
          onChange={(e) => setDraft({ ...draft, customerName: e.target.value })}
        />
      </div>
      <div className="form-group">
        <label>Телефон</label>
        <input
          className="form-input"
          value={draft.customerPhone}
          onChange={(e) => setDraft({ ...draft, customerPhone: e.target.value })}
        />
      </div>
      <div className="form-group">
        <label>Узор</label>
        <select className="form-input" value={custom ? OTHER_PATTERN : template?.name ?? ""}
          onChange={(e) => pickPattern(e.target.value)}>
          <option value="" disabled>Таңдаңыз…</option>
          {templates.map((t) => (
            <option key={t.name} value={t.name}>{t.name} — {formatMoney(t.pricePerM2Tiyn)}/м²</option>
          ))}
          <option value={OTHER_PATTERN}>Басқа — қолмен жазу</option>
        </select>
      </div>
      {custom && (
        <div className="form-group">
          <label>Узор аты</label>
          <input
            className="form-input"
            value={draft.patternName}
            onChange={(e) => setDraft({ ...draft, patternName: e.target.value })}
          />
        </div>
      )}
      <div className="form-group">
        <label>Ауданы (м²)</label>
        <input
          className="form-input"
          inputMode="decimal"
          value={areaText}
          onChange={(e) => {
            setAreaText(e.target.value);
            setDraft({ ...draft, areaM2: Math.max(0, parseFloat(e.target.value.replace(",", ".")) || 0) });
          }}
        />
      </div>
      <div className="form-group">
        <label>м² бағасы (₸)</label>
        <input
          type="number"
          className="form-input"
          value={draft.pricePerM2Tiyn ? draft.pricePerM2Tiyn / 100 : ""}
          onChange={(e) => setDraft({ ...draft, pricePerM2Tiyn: Math.max(0, Math.round((Number(e.target.value) || 0) * 100)) })}
        />
        {template && draft.pricePerM2Tiyn !== template.pricePerM2Tiyn && (
          <span className="form-hint">Шаблонда {formatMoney(template.pricePerM2Tiyn)} — бұл заказға қолмен өзгертілді</span>
        )}
      </div>
      <div className="form-group">
        <label>Пленка түсі</label>
        <input
          className="form-input"
          value={draft.filmColor}
          onChange={(e) => setDraft({ ...draft, filmColor: e.target.value })}
        />
      </div>
      {/* Клиент бағасын өзгертпейді — тек вакуумшының айлығына бонус қосады (lib/salary.ts). */}
      <label className="remember-me">
        <input
          type="checkbox"
          checked={draft.packaging}
          onChange={(e) => setDraft({ ...draft, packaging: e.target.checked })}
        />
        <span className="remember-check">{draft.packaging ? "✓" : ""}</span>
        <span>Упаковка</span>
      </label>
      <div className="track-card-meta-row">
        <span>
          {formatMdfArea(draft.areaM2)} × {formatMoney(draft.pricePerM2Tiyn)}
          {preview.totalTiyn !== preview.areaCostTiyn ? " (жеткізу, жеңілдікпен)" : ""}
        </span>
        <strong>{formatMoney(preview.totalTiyn)}</strong>
      </div>
      {missing && <p className="form-hint">{missing}</p>}
      <button className="btn btn-primary btn-full" disabled={busy || !!missing} onClick={handleSave}>
        {busy ? "Сақталуда..." : order ? "Сақтау" : "Құру"}
      </button>
    </section>
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

  const area = parseFloat(areaM2.replace(",", ".")) || 0;
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
          <input type="number" className="form-input" value={areaM2} onChange={(e) => setAreaM2(e.target.value)} />
        </div>
        <div className="form-group">
          <label>Пленка түсі</label>
          <input className="form-input" value={filmColor} onChange={(e) => setFilmColor(e.target.value)} />
        </div>
        <div className="form-group">
          <label>м² бағасы (₸)</label>
          <input
            type="number"
            className="form-input"
            value={priceTenge || ""}
            onChange={(e) => setPriceTenge(Number(e.target.value) || 0)}
          />
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

function MdfPaymentDialog({
  order,
  methods,
  actor,
  onClose,
  onToast,
}: {
  order: Order;
  methods: PaymentMethodDef[];
  actor: Actor;
  onClose: () => void;
  onToast: (msg: string) => void;
}) {
  const remaining = Math.max(0, order.totalTiyn - order.paidTiyn);
  const [methodId, setMethodId] = useState("");
  const [amountTenge, setAmountTenge] = useState(remaining > 0 ? remaining / 100 : 0);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!methodId) return;
    const method = methods.find((m) => m.id === methodId);
    setBusy(true);
    try {
      await recordPayment(db, actor, {
        orderId: order.id,
        amountTiyn: Math.round(amountTenge * 100),
        methodId,
        methodName: method?.name ?? methodId,
      });
      onToast("✅ Төлем тіркелді");
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
        <h2>💰 Төлем тіркеу</h2>
        <p className="scan-hint">
          {order.orderNumber} · {order.customerName} · қалдық <strong>{formatMoney(remaining)}</strong>
        </p>
        <div className="pay-method-grid">
          {/* «Аралас» is left out: this dialog takes one method, and a lump «Аралас» payment
              would sit whole in one Касса pot whatever it was split into. Record each part on its own. */}
          {methods.filter((m) => m.active && !m.isMixed).map((m) => (
            <button
              key={m.id}
              className={`pay-method-option${methodId === m.id ? " is-active" : ""}`}
              onClick={() => setMethodId(m.id)}
            >
              {m.name}
            </button>
          ))}
        </div>
        <div className="form-group">
          <label>Сома (₸)</label>
          <input
            type="number"
            className="form-input"
            value={amountTenge || ""}
            onChange={(e) => setAmountTenge(Number(e.target.value) || 0)}
          />
        </div>
        <div className="wizard-actions">
          <button className="btn btn-outline" onClick={onClose}>Бас тарту</button>
          <button className="btn btn-primary" disabled={busy || !methodId || amountTenge <= 0} onClick={submit}>
            {busy ? "Сақталуда..." : "Тіркеу"}
          </button>
        </div>
      </div>
    </div>
  );
}
