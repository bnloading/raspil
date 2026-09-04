import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { getDocs, collection } from "firebase/firestore";
import type { User } from "firebase/auth";
import { db } from "../../firebase";
import { useAuth } from "../../AuthContext";
import { Spinner, Toast } from "../../components";
import { AppShell } from "../../components/layout/AppShell";
import { PaymentStatusBadge } from "../../components/StatusBadge";
import { useAllOrders } from "../../hooks/useOrders";
import { useToast } from "../../hooks";
import { computeMdfOrderTotal, formatMdfArea } from "../../lib/mdfJournal";
import {
  createMdfJournalOrder,
  emptyMdfJournalDraft,
  mdfDraftHasContent,
  publishMdfPrice,
  type MdfJournalDraft,
} from "../../lib/mdfJournalOrders";
import { enterMdfProduction } from "../../lib/mdfOrderStatus";
import { recordPayment } from "../../lib/payments";
import { formatMoney } from "../../lib/money";
import { formatDateDMY } from "../../lib/dates";
import { formatPhone } from "../../lib/phone";
import { exportCsv } from "../../lib/exportTable";
import { isAdmin, methodVisibleTo } from "../../lib/rbac";
import { MDF_STAGE_LABELS } from "../../types/domain";
import type { Order, PaymentMethodDef, UserDoc } from "../../types/domain";

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
  const [showNewOrder, setShowNewOrder] = useState(false);
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
        "м²": Math.round((o.mdfAreaM2 ?? 0) * 100) / 100,
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
          <button className="btn btn-primary btn-sm" onClick={() => setShowNewOrder(true)}>
            + Жаңа заказ
          </button>
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

      {showNewOrder && (
        <NewMdfOrderForm
          actor={actor}
          onClose={() => setShowNewOrder(false)}
          onCreated={() => {
            setShowNewOrder(false);
            showToast("✅ Жаңа заказ қосылды");
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
                  <span>{formatMdfArea(o.mdfAreaM2)} · {o.mdfFilmColor || "—"}</span>
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

function NewMdfOrderForm({
  actor,
  onClose,
  onCreated,
  onError,
}: {
  actor: Actor;
  onClose: () => void;
  onCreated: () => void;
  onError: (msg: string) => void;
}) {
  const [draft, setDraft] = useState<MdfJournalDraft>(emptyMdfJournalDraft());
  const [busy, setBusy] = useState(false);

  const preview = computeMdfOrderTotal({
    areaM2: draft.areaM2,
    pricePerM2Tiyn: draft.pricePerM2Tiyn,
    extraServicesTiyn: draft.extraServicesTiyn,
    deliveryCostTiyn: draft.deliveryCostTiyn,
    discountTiyn: draft.discountTiyn,
    paidTiyn: 0,
  });

  const handleClose = () => {
    if (mdfDraftHasContent(draft) && !confirm("Жазылған деректер жоғалады. Жабу керек пе?")) return;
    onClose();
  };

  const handleCreate = async () => {
    setBusy(true);
    try {
      await createMdfJournalOrder(db, actor, draft);
      onCreated();
    } catch (err: unknown) {
      onError("Қате: " + (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel-card">
      <div className="panel-head">
        <h3>Жаңа МДФ заказ</h3>
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
        <label>Ауданы (м²)</label>
        <input
          type="number"
          className="form-input"
          value={draft.areaM2 || ""}
          onChange={(e) => setDraft({ ...draft, areaM2: Number(e.target.value) || 0 })}
        />
      </div>
      <div className="form-group">
        <label>Пленка түсі</label>
        <input
          className="form-input"
          value={draft.filmColor}
          onChange={(e) => setDraft({ ...draft, filmColor: e.target.value })}
        />
      </div>
      <div className="form-group">
        <label>м² бағасы (₸)</label>
        <input
          type="number"
          className="form-input"
          value={draft.pricePerM2Tiyn ? draft.pricePerM2Tiyn / 100 : ""}
          onChange={(e) => setDraft({ ...draft, pricePerM2Tiyn: Math.round((Number(e.target.value) || 0) * 100) })}
        />
      </div>
      <div className="track-card-meta-row">
        <span>Жалпы сома</span>
        <strong>{formatMoney(preview.totalTiyn)}</strong>
      </div>
      <button className="btn btn-primary btn-full" disabled={busy} onClick={handleCreate}>
        {busy ? "Сақталуда..." : "Құру"}
      </button>
    </section>
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
          {methods.filter((m) => m.active).map((m) => (
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
