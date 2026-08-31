import { useEffect, useState } from "react";
import { collection, doc, getDocs, query, updateDoc, where } from "firebase/firestore";
import type { User } from "firebase/auth";
import { db } from "../firebase";
import { MoneyInput } from "./MoneyInput";
import { formatMoney } from "../lib/money";
import { canEnterCuttingQueue } from "../lib/statuses";
import {
  startManagerReview,
  calculatePrice,
  publishPrice,
  enterCuttingQueue,
  markDelivered,
  cancelOrder,
  assignWorkers,
} from "../lib/orderStatus";
import { recordPayment, reversePayment } from "../lib/payments";
import { logAudit } from "../lib/audit";
import type { CuttingPart, Order, Payment, PaymentMethodDef, UserDoc } from "../types/domain";

type Actor = { user: User; userData: UserDoc };

interface StaffUser extends UserDoc {
  id: string;
}

const QUEUE_STAGE_STATUSES: Order["productionStatus"][] = ["waiting_payment", "partially_paid", "paid"];

/**
 * The Manager-role action rail shared by AdminOrderDetail and ManagerOrderDetail — Admin gets an
 * extra manual status-override dropdown of its own (rendered by the caller, not here) since that's
 * an Admin-only correction tool, not part of the Manager's normal workflow.
 */
export function OrderActionPanels({
  order,
  parts,
  payments,
  actor,
  isAdmin,
  canOverrideCuttingGate,
  allOrders,
  showToast,
}: {
  order: Order;
  parts: CuttingPart[];
  payments: Payment[];
  actor: Actor;
  isAdmin: boolean;
  /**
   * Whether this viewer may send an unpaid/partially-paid order to cutting anyway ("кесуге
   * жіберу — қарызға") — the shop cuts on credit for a trusted customer sometimes. Separate from
   * `isAdmin`: the owner wants Manager to have this too, unlike payment reversal below, which
   * stays Admin-only regardless. Every override still requires a typed reason and is audited
   * (firestore.rules enforces this for both roles).
   */
  canOverrideCuttingGate: boolean;
  allOrders: Order[];
  showToast: (msg: string) => void;
}) {
  const [staff, setStaff] = useState<StaffUser[]>([]);
  const [methods, setMethods] = useState<PaymentMethodDef[]>([]);

  const [materialCostTiyn, setMaterialCostTiyn] = useState(0);
  const [hdfCostTiyn, setHdfCostTiyn] = useState(0);
  const [pvcCostTiyn, setPvcCostTiyn] = useState(0);
  const [cuttingCostTiyn, setCuttingCostTiyn] = useState(0);
  const [extraServicesTiyn, setExtraServicesTiyn] = useState(0);
  const [deliveryCostTiyn, setDeliveryCostTiyn] = useState(0);
  const [discountTiyn, setDiscountTiyn] = useState(0);
  const [priceReason, setPriceReason] = useState("");

  const [adminNote, setAdminNote] = useState("");
  const [priority, setPriority] = useState("0");

  const [payAmount, setPayAmount] = useState(0);
  const [payMethodId, setPayMethodId] = useState("");
  const [payComment, setPayComment] = useState("");
  const [payReceipt, setPayReceipt] = useState("");

  useEffect(() => {
    // Independent queries — one failing (e.g. a role without list permission on `users`) must
    // never block the other from populating.
    getDocs(query(collection(db, "users"), where("role", "in", ["raspil", "pvh"])))
      .then((staffSnap) => setStaff(staffSnap.docs.map((d) => ({ id: d.id, ...(d.data() as UserDoc) }))))
      .catch(() => setStaff([]));
    getDocs(collection(db, "paymentMethods"))
      .then((methodsSnap) =>
        setMethods(methodsSnap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<PaymentMethodDef, "id">) }))),
      )
      .catch(() => setMethods([]));
  }, []);

  useEffect(() => {
    setMaterialCostTiyn(order.materialCostTiyn ?? 0);
    setHdfCostTiyn(order.hdfCostTiyn ?? 0);
    setPvcCostTiyn(order.pvcCostTiyn ?? 0);
    setCuttingCostTiyn(order.cuttingCostTiyn ?? 0);
    setExtraServicesTiyn(order.extraServicesTiyn ?? 0);
    setDeliveryCostTiyn(order.deliveryCostTiyn ?? 0);
    setDiscountTiyn(order.discountTiyn ?? 0);
    setAdminNote(order.adminNote ?? "");
    setPriority(String(order.priority ?? 0));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order.id]);

  useEffect(() => {
    if (!payMethodId && methods.length > 0) setPayMethodId(methods[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [methods.length]);

  const cutters = staff.filter((s) => s.role === "raspil");
  const pvcWorkers = staff.filter((s) => s.role === "pvh");
  const needsPvc = parts.some((p) => (["A", "B", "C", "D"] as const).some((e) => p.edges[e]?.pvc));

  const computedTotal =
    materialCostTiyn + hdfCostTiyn + pvcCostTiyn + cuttingCostTiyn + extraServicesTiyn + deliveryCostTiyn - discountTiyn;

  // ── Accept / reject ──

  const handleAccept = async () => {
    try {
      await startManagerReview(db, actor, order);
      showToast("✅ Заказ қабылданды");
    } catch (err: unknown) {
      showToast("Қате: " + (err as Error).message);
    }
  };

  const handleReject = async () => {
    const reason = prompt("Бас тарту себебі (міндетті):");
    if (reason === null) return;
    if (!reason.trim()) {
      showToast("Себепсіз бас тартуға болмайды");
      return;
    }
    try {
      await cancelOrder(db, actor, order, reason.trim());
      showToast("❌ Заказ бас тартылды");
    } catch (err: unknown) {
      showToast("Қате: " + (err as Error).message);
    }
  };

  // ── Price calculation ──

  const handleCalculatePrice = async () => {
    try {
      await calculatePrice(
        db,
        actor,
        order,
        {
          materialCostTiyn,
          hdfCostTiyn,
          pvcCostTiyn,
          cuttingCostTiyn,
          extraServicesTiyn,
          deliveryCostTiyn,
          discountTiyn,
          totalTiyn: computedTotal,
        },
        priceReason.trim() || undefined,
      );
      showToast("✅ Баға есептелді");
      setPriceReason("");
    } catch (err: unknown) {
      showToast("Қате: " + (err as Error).message);
    }
  };

  const handlePublishPrice = async () => {
    if (!confirm(`Клиентке ${formatMoney(computedTotal)} сомасын жариялайсыз ба? Бұл әрекетті кейін қайтару қиын.`)) return;
    try {
      await publishPrice(db, actor, order);
      showToast("✅ Баға клиентке жіберілді");
    } catch (err: unknown) {
      showToast("Қате: " + (err as Error).message);
    }
  };

  // ── Payments ──

  const handleRecordPayment = async () => {
    const method = methods.find((m) => m.id === payMethodId);
    if (!method || payAmount <= 0) {
      showToast("Соманы және төлем әдісін таңдаңыз");
      return;
    }
    try {
      await recordPayment(db, actor, {
        orderId: order.id,
        amountTiyn: payAmount,
        methodId: method.id,
        methodName: method.name,
        comment: payComment.trim(),
        receiptNumber: payReceipt.trim(),
      });
      await logAudit(db, actor, {
        action: "payment.create",
        entityType: "payment",
        entityId: order.id,
        after: { amountTiyn: payAmount, methodName: method.name },
      });
      showToast("✅ Төлем тіркелді");
      setPayAmount(0);
      setPayComment("");
      setPayReceipt("");
    } catch (err: unknown) {
      showToast("Қате: " + (err as Error).message);
    }
  };

  const handleReversePayment = async (paymentId: string) => {
    const reason = prompt("Қайтару себебі (міндетті):");
    if (!reason || !reason.trim()) {
      showToast("Себепсіз қайтару жасалмайды");
      return;
    }
    try {
      await reversePayment(db, actor, { paymentId, reason: reason.trim() });
      await logAudit(db, actor, {
        action: "payment.reverse",
        entityType: "payment",
        entityId: paymentId,
        comment: reason.trim(),
      });
      showToast("✅ Төлем қайтарылды");
    } catch (err: unknown) {
      showToast("Қате: " + (err as Error).message);
    }
  };

  // ── Queue ──

  const cuttingQueueCount = allOrders.filter((o) => o.productionStatus === "cutting_queue" && o.id !== order.id).length;
  const nextQueuePosition = cuttingQueueCount + 1;
  const gateOk = canEnterCuttingQueue(order.paymentStatus);

  const handleEnterQueue = async () => {
    try {
      await enterCuttingQueue(db, actor, order, { isAdmin: false, queuePosition: nextQueuePosition });
      showToast("✅ Распил кезегіне жіберілді");
    } catch (err: unknown) {
      showToast("Қате: " + (err as Error).message);
    }
  };

  const handleOverrideQueue = async () => {
    if (
      !confirm(
        "Бұл заказ толық төленбеген. Соған қарамастан распил кезегіне жібересіз бе? Бұл әрекет аудит журналына тіркеледі.",
      )
    )
      return;
    const reason = prompt("Себебін міндетті түрде жазыңыз:");
    if (!reason || !reason.trim()) {
      showToast("Себепсіз жіберуге болмайды");
      return;
    }
    try {
      await enterCuttingQueue(db, actor, order, {
        isAdmin: true,
        overrideReason: reason.trim(),
        queuePosition: nextQueuePosition,
      });
      showToast("⚠️ Қарызға кесуге жіберілді (аудитте тіркелді)");
    } catch (err: unknown) {
      showToast("Қате: " + (err as Error).message);
    }
  };

  // ── Assignment / priority / note ──

  const handleAssign = async (kind: "cutter" | "pvc", staffId: string) => {
    const person = staff.find((s) => s.id === staffId);
    try {
      if (kind === "cutter") {
        await assignWorkers(db, actor, order.id, { cutterId: staffId, cutterName: person?.name ?? "" });
      } else {
        await assignWorkers(db, actor, order.id, { pvcId: staffId, pvcName: person?.name ?? "" });
      }
      showToast("✅ Тағайындалды");
    } catch (err: unknown) {
      showToast("Қате: " + (err as Error).message);
    }
  };

  const handleSavePriority = async () => {
    try {
      await updateDoc(doc(db, "orders", order.id), { priority: parseInt(priority, 10) || 0 });
      showToast("✅ Приоритет сақталды");
    } catch (err: unknown) {
      showToast("Қате: " + (err as Error).message);
    }
  };

  const handleSaveNote = async () => {
    try {
      await updateDoc(doc(db, "orders", order.id), { adminNote: adminNote.trim() });
      showToast("✅ Ескертпе сақталды");
    } catch (err: unknown) {
      showToast("Қате: " + (err as Error).message);
    }
  };

  // ── Delivery ──

  const handleMarkDelivered = async () => {
    try {
      await markDelivered(db, actor, order);
      showToast("✅ Заказ клиентке берілді деп белгіленді");
    } catch (err: unknown) {
      showToast("Қате: " + (err as Error).message);
    }
  };

  const showPriceCalc =
    order.productionStatus === "manager_review" || (order.productionStatus === "price_calculated" && !order.pricePublished);
  const showPayment = order.productionStatus === "waiting_payment" || order.productionStatus === "partially_paid";
  const showQueue = QUEUE_STAGE_STATUSES.includes(order.productionStatus);
  const showDeliver = order.productionStatus === "ready";
  const showAcceptReject = order.productionStatus === "submitted";
  const showRejectOnly = order.productionStatus === "manager_review";

  return (
    <>
      {showAcceptReject && (
        <section className="panel-card">
          <div className="panel-head">
            <h3>Растау</h3>
          </div>
          <div className="wizard-actions">
            <button className="btn btn-primary" onClick={handleAccept}>
              ✅ Қабылдау
            </button>
            <button className="btn btn-danger-outline" onClick={handleReject}>
              ❌ Бас тарту
            </button>
          </div>
        </section>
      )}

      {showRejectOnly && (
        <section className="panel-card">
          <div className="panel-head">
            <h3>Бас тарту</h3>
          </div>
          <button className="btn btn-danger-outline btn-full" onClick={handleReject}>
            ❌ Заказдан бас тарту
          </button>
        </section>
      )}

      {showPriceCalc && (
        <section className="panel-card">
          <div className="panel-head">
            <h3>Баға есептеу</h3>
          </div>
          <div className="form-group">
            <label>Материал (₸)</label>
            <MoneyInput valueTiyn={materialCostTiyn} onChange={setMaterialCostTiyn} />
          </div>
          <div className="form-group">
            <label>ХДФ (₸)</label>
            <MoneyInput valueTiyn={hdfCostTiyn} onChange={setHdfCostTiyn} />
          </div>
          <div className="form-group">
            <label>ПВХ (₸)</label>
            <MoneyInput valueTiyn={pvcCostTiyn} onChange={setPvcCostTiyn} />
          </div>
          <div className="form-group">
            <label>Кесу (₸)</label>
            <MoneyInput valueTiyn={cuttingCostTiyn} onChange={setCuttingCostTiyn} />
          </div>
          <div className="form-group">
            <label>Қосымша қызмет (₸)</label>
            <MoneyInput valueTiyn={extraServicesTiyn} onChange={setExtraServicesTiyn} />
          </div>
          <div className="form-group">
            <label>Жеткізу (₸)</label>
            <MoneyInput valueTiyn={deliveryCostTiyn} onChange={setDeliveryCostTiyn} />
          </div>
          <div className="form-group">
            <label>Жеңілдік (₸)</label>
            <MoneyInput valueTiyn={discountTiyn} onChange={setDiscountTiyn} />
          </div>
          <div className="form-group">
            <label>Түзету себебі (баға өзгерсе)</label>
            <input className="form-input" value={priceReason} onChange={(e) => setPriceReason(e.target.value)} />
          </div>
          <div className="confirm-row confirm-total">
            <span>Жалпы сома</span>
            <strong>{formatMoney(computedTotal)}</strong>
          </div>
          <button className="btn btn-outline btn-full" onClick={handleCalculatePrice} style={{ marginTop: 8 }}>
            🧮 Есептеу
          </button>
          {order.productionStatus === "price_calculated" && (
            <button className="btn btn-success btn-full" onClick={handlePublishPrice} style={{ marginTop: 8 }}>
              ✅ Бағаны клиентке жіберу
            </button>
          )}
        </section>
      )}

      {showPayment && (
        <section className="panel-card">
          <div className="panel-head">
            <h3>Төлем қабылдау</h3>
          </div>
          <div className="form-group">
            <label>Сома (₸)</label>
            <MoneyInput valueTiyn={payAmount} onChange={setPayAmount} />
          </div>
          <div className="form-group">
            <label>Төлем әдісі</label>
            <select className="form-input" value={payMethodId} onChange={(e) => setPayMethodId(e.target.value)}>
              {methods.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label>Чек нөмірі (міндетті емес)</label>
            <input className="form-input" value={payReceipt} onChange={(e) => setPayReceipt(e.target.value)} />
          </div>
          <div className="form-group">
            <label>Түсініктеме</label>
            <input className="form-input" value={payComment} onChange={(e) => setPayComment(e.target.value)} />
          </div>
          <button className="btn btn-primary btn-full" onClick={handleRecordPayment}>
            💰 Төлем тіркеу
          </button>
          {isAdmin && payments.filter((p) => !p.reversed).length > 0 && (
            <div className="data-list" style={{ marginTop: 12 }}>
              {payments
                .filter((p) => !p.reversed)
                .map((p) => (
                  <div key={p.id} className="data-row">
                    <div className="data-row-main">
                      <strong>
                        {formatMoney(p.amountTiyn)} · {p.methodName}
                      </strong>
                    </div>
                    <button className="btn btn-danger-outline btn-sm" onClick={() => handleReversePayment(p.id)}>
                      Қайтару
                    </button>
                  </div>
                ))}
            </div>
          )}
        </section>
      )}

      <section className="panel-card">
        <div className="panel-head">
          <h3>Тағайындау</h3>
        </div>
        <div className="form-group">
          <label>Распилшы</label>
          <select className="form-input" value={order.assignedCutterId ?? ""} onChange={(e) => handleAssign("cutter", e.target.value)}>
            <option value="">Тағайындалмаған</option>
            {cutters.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        {needsPvc && (
          <div className="form-group">
            <label>ПВХ жұмысшысы</label>
            <select className="form-input" value={order.assignedPvcId ?? ""} onChange={(e) => handleAssign("pvc", e.target.value)}>
              <option value="">Тағайындалмаған</option>
              {pvcWorkers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        )}
      </section>

      {showQueue && (
        <section className="panel-card">
          <div className="panel-head">
            <h3>Распил кезегі</h3>
          </div>
          <p>Кезектегі болжамды орын: №{nextQueuePosition}</p>
          {gateOk ? (
            <button className="btn btn-primary btn-full" onClick={handleEnterQueue}>
              📦 Кезекке жіберу
            </button>
          ) : canOverrideCuttingGate ? (
            <button className="btn btn-danger-outline btn-full" onClick={handleOverrideQueue}>
              ⚠️ Қарызға кесуге жіберу
            </button>
          ) : (
            <p className="chart-empty">Кезекке жіберу үшін заказ толық төленуі керек</p>
          )}
        </section>
      )}

      <section className="panel-card">
        <div className="panel-head">
          <h3>Приоритет (кіші сан — жоғары кезек)</h3>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <input type="number" className="form-input" value={priority} onChange={(e) => setPriority(e.target.value)} />
          <button className="btn btn-outline btn-sm" onClick={handleSavePriority}>
            Сақтау
          </button>
        </div>
      </section>

      <section className="panel-card">
        <div className="panel-head">
          <h3>Ішкі ескертпе (клиентке көрінбейді)</h3>
        </div>
        <div className="form-group">
          <textarea className="form-input" value={adminNote} onChange={(e) => setAdminNote(e.target.value)} rows={2} />
        </div>
        <button className="btn btn-outline btn-sm" onClick={handleSaveNote}>
          Сақтау
        </button>
      </section>

      {showDeliver && (
        <section className="panel-card">
          <div className="panel-head">
            <h3>Жеткізу</h3>
          </div>
          <button className="btn btn-primary btn-full" onClick={handleMarkDelivered}>
            📬 Клиентке берілді
          </button>
        </section>
      )}
    </>
  );
}
