import { useMemo, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { collection, doc, serverTimestamp, setDoc } from "firebase/firestore";
import { db } from "../../firebase";
import { useAuth } from "../../AuthContext";
import { Toast, Spinner } from "../../components";
import { AppShell } from "../../components/layout/AppShell";
import { useToast } from "../../hooks";
import { generateOrderNumber } from "../../lib/orderNumber";
import { MDF_MATERIAL_SNAPSHOT } from "../../lib/mdfJournalOrders";
import { computeMdfPanelsAreaM2, computeMdfPanelsCostTiyn, formatMdfArea, mdfPanelCostTiyn } from "../../lib/mdfJournal";
import { formatMoney } from "../../lib/money";
import { computePaymentStatus } from "../../lib/statuses";
import { MDF_PATTERNS, MDF_PATTERN_LABELS } from "../../types/domain";
import type { MdfPanel, MdfPattern } from "../../types/domain";

/** One panel row as the form edits it — text inputs, so a field can sit empty mid-typing rather
 *  than snapping to 0. Converted to a real MdfPanel (numbers, a stable id) only on submit. */
interface PanelDraft {
  id: string;
  lengthMm: string;
  widthMm: string;
  qty: string;
  pattern: MdfPattern;
}

function emptyPanel(): PanelDraft {
  return { id: crypto.randomUUID(), lengthMm: "", widthMm: "", qty: "1", pattern: MDF_PATTERNS[0] };
}

/** A panel with all three dimensions typed in — the only rows that count toward the total or get submitted. */
function isPanelFilled(p: PanelDraft): boolean {
  return Number(p.lengthMm) > 0 && Number(p.widthMm) > 0 && Number(p.qty) > 0;
}

/**
 * Customer self-service МДФ order form — one row per panel size (ұзындығы/ені/саны/өрнек), the
 * same "measure what you actually want" shape as OrderBuilder.tsx's parts list, just far lighter:
 * no per-part edging, no material catalogue, just dimensions, quantity and a face pattern. The
 * total area is always derived from these rows (computeMdfPanelsAreaM2), never typed directly.
 *
 * Every pattern except "Басқа" has a fixed shop price per m² (lib/mdfJournal.ts's
 * MDF_PATTERN_PRICE_TIYN), so a normal order prices itself live as the customer fills it in and
 * submits straight through to WAITING_PAYMENT — no Manager review step in between. The one
 * exception is "Басқа" (a pattern outside the fixed list): the moment any panel uses it, the whole
 * order's cost is unknown and falls back to the old flow (pricePublished stays false, SUBMITTED,
 * the Manager quotes it by hand in ManagerMdfJournal).
 */
export default function MdfOrderBuilder() {
  const { user, userData } = useAuth();
  const navigate = useNavigate();
  const { message, visible, showToast } = useToast();

  const [panels, setPanels] = useState<PanelDraft[]>([emptyPanel()]);
  const [filmColor, setFilmColor] = useState("");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const filledPanels = useMemo(() => panels.filter(isPanelFilled), [panels]);
  const filledMdfPanels = useMemo(
    () =>
      filledPanels.map((p) => ({
        lengthMm: Number(p.lengthMm),
        widthMm: Number(p.widthMm),
        qty: Number(p.qty),
        pattern: p.pattern,
      })),
    [filledPanels],
  );
  const totalAreaM2 = useMemo(() => computeMdfPanelsAreaM2(filledMdfPanels), [filledMdfPanels]);
  // undefined the moment any panel uses "Басқа" (or the legacy "vyborka") — see the file doc comment.
  const totalCostTiyn = useMemo(() => computeMdfPanelsCostTiyn(filledMdfPanels), [filledMdfPanels]);

  if (!user || !userData) return <Spinner />;

  const patchPanel = (id: string, patch: Partial<PanelDraft>) =>
    setPanels((rows) => rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const addPanel = () => setPanels((rows) => [...rows, emptyPanel()]);
  const removePanel = (id: string) => setPanels((rows) => rows.filter((r) => r.id !== id));

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (filledPanels.length === 0) {
      showToast("Кемінде бір бөлшектің ұзындығы, ені және санын енгізіңіз");
      return;
    }

    const mdfPanels: MdfPanel[] = filledPanels.map((p) => ({
      id: p.id,
      lengthMm: Number(p.lengthMm),
      widthMm: Number(p.widthMm),
      qty: Number(p.qty),
      pattern: p.pattern,
    }));

    // Every panel a known (fixed-price) pattern: price it now and send straight to payment — no
    // Manager review in between. Any "Басқа" panel: unpriced, same SUBMITTED flow as before.
    const priced = totalCostTiyn !== undefined;

    setSubmitting(true);
    try {
      const orderRef = doc(collection(db, "orders"));
      const orderNumber = await generateOrderNumber(db);
      await setDoc(orderRef, {
        orderNumber,
        orderKind: "mdf_wrap",
        customerId: user.uid,
        customerName: userData.name,
        customerPhone: userData.phone,
        materialId: "",
        materialSnapshot: MDF_MATERIAL_SNAPSHOT,
        mdfAreaM2: totalAreaM2,
        mdfPanels,
        mdfFilmColor: filmColor.trim(),
        productionStatus: priced ? "waiting_payment" : "submitted",
        paymentStatus: priced ? computePaymentStatus(totalCostTiyn, 0) : "unpaid",
        priority: 0,
        estimatedSheets: 0,
        pvcMetersTotal: 0,
        materialCostTiyn: 0,
        cuttingCostTiyn: 0,
        pvcCostTiyn: 0,
        hdfCostTiyn: 0,
        extraServicesTiyn: 0,
        deliveryCostTiyn: 0,
        discountTiyn: 0,
        totalTiyn: priced ? totalCostTiyn : 0,
        paidTiyn: 0,
        debtTiyn: priced ? totalCostTiyn : 0,
        ...(priced ? { mdfPricePerM2Tiyn: Math.round(totalCostTiyn / totalAreaM2) } : {}),
        pricePublished: priced,
        ...(priced ? { pricePublishedAt: serverTimestamp() } : {}),
        customerNote: note.trim(),
        isDraft: false,
        createdAt: serverTimestamp(),
        submittedAt: serverTimestamp(),
      });
      navigate(`/order/${orderRef.id}`, { replace: true });
    } catch (err: unknown) {
      showToast("Қате: " + (err as Error).message);
      setSubmitting(false);
    }
  };

  return (
    <AppShell title="МДФ тапсырыс беру" subtitle={userData.name} back="/dashboard">
      <form className="panel-card" onSubmit={handleSubmit}>
        <div className="form-group">
          <label>Бөлшектер</label>
          {panels.map((p, i) => (
            <div key={p.id} className="mdf-panel-row">
              <input
                type="text"
                inputMode="numeric"
                className="form-input"
                placeholder="Ұзындығы (мм)"
                aria-label="Ұзындығы (мм)"
                value={p.lengthMm}
                onChange={(e) => patchPanel(p.id, { lengthMm: e.target.value })}
              />
              <input
                type="text"
                inputMode="numeric"
                className="form-input"
                placeholder="Ені (мм)"
                aria-label="Ені (мм)"
                value={p.widthMm}
                onChange={(e) => patchPanel(p.id, { widthMm: e.target.value })}
              />
              <input
                type="text"
                inputMode="numeric"
                className="form-input"
                placeholder="Саны"
                aria-label="Саны"
                value={p.qty}
                onChange={(e) => patchPanel(p.id, { qty: e.target.value })}
              />
              <select
                className="form-input"
                aria-label="Өрнек"
                value={p.pattern}
                onChange={(e) => patchPanel(p.id, { pattern: e.target.value as MdfPattern })}
              >
                {MDF_PATTERNS.map((pattern) => (
                  <option key={pattern} value={pattern}>
                    {MDF_PATTERN_LABELS[pattern]}
                  </option>
                ))}
              </select>
              {panels.length > 1 && (
                <button
                  type="button"
                  className="btn btn-outline btn-sm"
                  aria-label="Бөлшекті өшіру"
                  onClick={() => removePanel(p.id)}
                >
                  ✕
                </button>
              )}
              {isPanelFilled(p) && (
                <span className="form-hint">
                  {formatMdfArea((Number(p.lengthMm) / 1000) * (Number(p.widthMm) / 1000) * Number(p.qty))}
                  {(() => {
                    const cost = mdfPanelCostTiyn({
                      lengthMm: Number(p.lengthMm),
                      widthMm: Number(p.widthMm),
                      qty: Number(p.qty),
                      pattern: p.pattern,
                    });
                    return cost !== undefined ? ` · ${formatMoney(cost)}` : "";
                  })()}
                </span>
              )}
              {i < panels.length - 1 && <hr className="mdf-panel-divider" />}
            </div>
          ))}
          <button type="button" className="btn btn-outline btn-sm" onClick={addPanel}>
            + Бөлшек қосу
          </button>
        </div>

        <div className="track-card-meta-row">
          <span>Жалпы аудан</span>
          <strong>{formatMdfArea(totalAreaM2)}</strong>
        </div>
        {filledPanels.length > 0 && totalCostTiyn !== undefined && (
          <div className="track-card-meta-row">
            <span>Жалпы бағасы</span>
            <strong>{formatMoney(totalCostTiyn)}</strong>
          </div>
        )}

        <div className="form-group">
          <label>Пленка түсі (білсеңіз)</label>
          <input
            type="text"
            className="form-input"
            placeholder="Мысалы: Ақ жылтыр"
            value={filmColor}
            onChange={(e) => setFilmColor(e.target.value)}
          />
        </div>
        <div className="form-group">
          <label>Ескертпе (міндетті емес)</label>
          <textarea
            className="form-input"
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        <p className="form-hint">
          {filledPanels.length === 0
            ? "Бөлшектің ұзындығы, ені және санын енгізіңіз."
            : totalCostTiyn !== undefined
              ? "Баға жоғарыда көрсетілді — тапсырыс тікелей төлемге өтеді, менеджер бағаны қайта есептемейді."
              : "«Басқа» өрнегінің бағасы белгіленбеген — оны менеджер есептеп, сізге жібереді."}
        </p>
        <button type="submit" className="btn btn-primary btn-full" disabled={submitting}>
          {submitting ? "Жіберілуде..." : "Тапсырыс беру"}
        </button>
      </form>
      <Toast message={message} visible={visible} />
    </AppShell>
  );
}
