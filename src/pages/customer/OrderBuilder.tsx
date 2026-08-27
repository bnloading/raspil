import { useEffect, useMemo, useState, type ChangeEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  setDoc,
  writeBatch,
} from "firebase/firestore";
import * as XLSX from "xlsx";
import { db } from "../../firebase";
import { useAuth } from "../../AuthContext";
import { Toast, Spinner } from "../../components";
import { AppShell } from "../../components/layout/AppShell";
import { useToast } from "../../hooks";
import { useMaterials, usePvcTypes } from "../../hooks/useMaterials";
import { useAppSettings } from "../../hooks/useAppSettings";
import { MoneyInput } from "../../components/MoneyInput";
import { DimensionScanner } from "../../components/DimensionScanner";
import { BulkPartsEditor } from "../../components/BulkPartsEditor";
import { formatMoney } from "../../lib/money";
import { generateOrderNumber } from "../../lib/orderNumber";
import {
  computeOrderTotals,
  computePvcBreakdown,
  estimateSheets,
  partFitsSheet,
  totalPvcMeters,
} from "../../lib/pricing";
import { EDGE_KEYS } from "../../types/domain";
import type { CuttingPart } from "../../types/domain";

const EMPTY_EDGES = (): CuttingPart["edges"] => ({
  A: { pvc: false },
  B: { pvc: false },
  C: { pvc: false },
  D: { pvc: false },
});

function newPart(): CuttingPart {
  return {
    id: crypto.randomUUID(),
    name: "",
    lengthMm: 0,
    widthMm: 0,
    qty: 1,
    grainDirection: "any",
    rotationAllowed: false,
    note: "",
    edges: EMPTY_EDGES(),
  };
}

// Dimensions and PVC edges are one step, not two: the bulk editor marks edges for many parts at
// once, so forcing a separate pass over every part afterwards would be exactly the
// one-part-at-a-time workflow it exists to replace.
const STEP_LABELS = ["Материал", "Размерлер + ПВХ", "Растау"];

export default function OrderBuilder() {
  const { user, userData } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const editOrderId = params.get("edit");
  const duplicateFrom = params.get("duplicate");
  const { message, visible, showToast } = useToast();
  const { materials } = useMaterials(true);
  const { pvcTypes } = usePvcTypes(true);
  const { settings } = useAppSettings();

  const [step, setStep] = useState(1);
  const [loadingSource, setLoadingSource] = useState(!!editOrderId || !!duplicateFrom);
  const [materialId, setMaterialId] = useState("");
  /** null until the customer says whose sheet it is — the order form no longer opens on a
   *  "choose a material" wall; picking from the catalogue is one of two options. */
  const [materialSource, setMaterialSource] = useState<"shop" | "customer" | null>(null);
  const [customerMaterialName, setCustomerMaterialName] = useState("");
  const [parts, setParts] = useState<CuttingPart[]>([newPart()]);
  const [customerNote, setCustomerNote] = useState("");
  const [discountTenge, setDiscountTenge] = useState("0");
  const [extraServicesTenge, setExtraServicesTenge] = useState("0");
  const [deliveryTenge, setDeliveryTenge] = useState("0");
  const [submitting, setSubmitting] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);
  /** Gates autosave until the recovery prompt has run, so restoring a draft can't be
   *  immediately overwritten by an autosave of the empty initial state. */
  const [autosaveReady, setAutosaveReady] = useState(false);

  const material = materials.find((m) => m.id === materialId);
  const pvcTypesById = useMemo(() => new Map(pvcTypes.map((p) => [p.id, p])), [pvcTypes]);

  // Load source order for edit/duplicate.
  useEffect(() => {
    const sourceId = editOrderId || duplicateFrom;
    if (!sourceId) return;
    (async () => {
      const orderSnap = await getDoc(doc(db, "orders", sourceId));
      if (!orderSnap.exists()) {
        setLoadingSource(false);
        return;
      }
      const order = orderSnap.data();
      setMaterialId(order.materialId || "");
      // Orders created before materialSource existed always used a shop material.
      setMaterialSource(order.materialSource ?? "shop");
      setCustomerMaterialName(order.customerMaterialName || "");
      setCustomerNote(order.customerNote || "");
      setDiscountTenge(String((order.discountTiyn || 0) / 100));
      setExtraServicesTenge(String((order.extraServicesTiyn || 0) / 100));
      setDeliveryTenge(String((order.deliveryCostTiyn || 0) / 100));
      const partsSnap = await getDocs(collection(db, "orders", sourceId, "parts"));
      const loadedParts: CuttingPart[] = [];
      partsSnap.forEach((d) => {
        const data = d.data() as Omit<CuttingPart, "id">;
        loadedParts.push({ ...data, id: duplicateFrom ? crypto.randomUUID() : d.id });
      });
      if (loadedParts.length > 0) setParts(loadedParts);
      setLoadingSource(false);
    })();
  }, [editOrderId, duplicateFrom]);

  // ── Autosave / draft recovery ──
  // Dimension entry for 100–200 parts is too much work to lose to a closed tab, so the in-progress
  // list is mirrored to localStorage and offered back on return. This is a convenience cache only:
  // the order itself still lives in Firestore, and the draft is cleared once it is submitted.
  const autosaveKey = `orderbuilder-draft:${user?.uid ?? "anon"}:${editOrderId ?? duplicateFrom ?? "new"}`;

  useEffect(() => {
    if (loadingSource || !autosaveReady) return;
    const handle = setTimeout(() => {
      try {
        localStorage.setItem(autosaveKey, JSON.stringify({ materialId, parts, customerNote, savedAt: Date.now() }));
      } catch {
        // Quota exceeded or storage disabled — autosave is best-effort and must never block entry.
      }
    }, 600);
    return () => clearTimeout(handle);
  }, [autosaveKey, materialId, parts, customerNote, loadingSource, autosaveReady]);

  // Offer an existing draft back, once, on first mount for a brand-new order.
  useEffect(() => {
    if (editOrderId || duplicateFrom) {
      setAutosaveReady(true);
      return;
    }
    try {
      const raw = localStorage.getItem(autosaveKey);
      if (raw) {
        const saved = JSON.parse(raw) as { materialId?: string; parts?: CuttingPart[]; customerNote?: string };
        const savedParts = saved.parts?.filter((p) => p.lengthMm > 0 || p.widthMm > 0 || p.name) ?? [];
        if (savedParts.length > 0 && confirm(`Сақталған жоба табылды (${savedParts.length} бөлшек). Жалғастырасыз ба?`)) {
          if (saved.materialId) setMaterialId(saved.materialId);
          setParts(savedParts);
          if (saved.customerNote) setCustomerNote(saved.customerNote);
        } else {
          localStorage.removeItem(autosaveKey);
        }
      }
    } catch {
      // Corrupt or unreadable draft — start clean rather than failing the page.
    }
    setAutosaveReady(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!user || !userData) return <Spinner />;
  if (loadingSource) return <Spinner />;

  // Per-part editing (rename, resize, edge toggles, duplicate, delete) all lives inside
  // BulkPartsEditor now — this page only owns adding, importing and persisting.
  const addPart = () => setParts((prev) => [...prev, newPart()]);

  const handleScannedDimensions = ({ lengthMm, widthMm }: { lengthMm: number; widthMm: number }) => {
    const part = { ...newPart(), lengthMm, widthMm };
    setParts((prev) => [...prev, part]);
  };

  /**
   * Firestore rejects `undefined` outright, and an edge switched on before a PVC type is chosen
   * legitimately has no pvcTypeId — so strip those keys instead of writing them. Also drops any
   * `note: undefined`. Without this, submitting an order with PVC edges but no type selected
   * failed with "Unsupported field value: undefined ... edges.A.pvcTypeId".
   */
  const serializeEdges = (edges: CuttingPart["edges"]): CuttingPart["edges"] => {
    const out = {} as CuttingPart["edges"];
    for (const key of EDGE_KEYS) {
      const edge = edges[key];
      out[key] = {
        pvc: !!edge?.pvc,
        ...(edge?.pvcTypeId ? { pvcTypeId: edge.pvcTypeId } : {}),
        ...(edge?.note ? { note: edge.note } : {}),
      };
    }
    return out;
  };

  // --- bulk paste: rows of "name\tlength\twidth\tqty" pasted from Excel ---
  const handleBulkPaste = (text: string) => {
    const rows = text
      .split(/\r?\n/)
      .map((r) => r.trim())
      .filter(Boolean)
      .map((r) => r.split(/\t|;/).map((c) => c.trim()));
    const imported: CuttingPart[] = [];
    for (const row of rows) {
      const [name, lengthStr, widthStr, qtyStr] = row;
      const lengthMm = parseFloat(lengthStr);
      const widthMm = parseFloat(widthStr);
      const qty = parseInt(qtyStr, 10);
      if (!Number.isFinite(lengthMm) || !Number.isFinite(widthMm)) continue;
      imported.push({
        ...newPart(),
        name: name || `Бөлшек ${imported.length + 1}`,
        lengthMm,
        widthMm,
        qty: Number.isFinite(qty) && qty > 0 ? qty : 1,
      });
    }
    if (imported.length === 0) {
      showToast("Жолдарды тани алмадым. Формат: атауы, ұзындығы, ені, саны");
      return;
    }
    setParts((prev) => [...prev.filter((p) => p.name || p.lengthMm || p.widthMm), ...imported]);
    showToast(`✅ ${imported.length} бөлшек қосылды`);
  };

  const handleXlsxImport = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf);
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
    const imported: CuttingPart[] = [];
    for (const row of rows) {
      const name = String(row["Атауы"] ?? row["name"] ?? row["Name"] ?? "");
      const lengthMm = parseFloat(String(row["Ұзындығы"] ?? row["length"] ?? row["Length"] ?? ""));
      const widthMm = parseFloat(String(row["Ені"] ?? row["width"] ?? row["Width"] ?? ""));
      const qty = parseInt(String(row["Саны"] ?? row["qty"] ?? row["Qty"] ?? "1"), 10);
      if (!Number.isFinite(lengthMm) || !Number.isFinite(widthMm)) continue;
      imported.push({
        ...newPart(),
        name: name || `Бөлшек ${imported.length + 1}`,
        lengthMm,
        widthMm,
        qty: Number.isFinite(qty) && qty > 0 ? qty : 1,
      });
    }
    if (imported.length === 0) {
      showToast("Файлдан бөлшек табылмады. Бағандар: Атауы, Ұзындығы, Ені, Саны");
    } else {
      setParts((prev) => [...prev.filter((p) => p.name || p.lengthMm || p.widthMm), ...imported]);
      showToast(`✅ ${imported.length} бөлшек импортталды`);
    }
    e.target.value = "";
  };

  const usesOwnMaterial = materialSource === "customer";

  const validParts = parts.filter((p) => p.lengthMm > 0 && p.widthMm > 0 && p.qty > 0);
  // Only our own catalogue sheets have known dimensions to check a part against; a customer's
  // own sheet has no size on file, so there is nothing to validate against.
  const fittingErrors = material && !usesOwnMaterial
    ? validParts.filter((p) => !partFitsSheet(p, material)).length
    : 0;

  const canGoToStep2 = usesOwnMaterial ? customerMaterialName.trim().length > 0 : !!materialId;
  const canGoToStep3 = validParts.length > 0 && fittingErrors === 0;

  // A customer-supplied sheet has no catalogue price and no sheet size, so no total can honestly
  // be computed here — the Manager prices it. Only shop material produces a customer-side total.
  const totals = material && !usesOwnMaterial
    ? computeOrderTotals({
        parts: validParts,
        material,
        pvcTypesById,
        sheets: estimateSheets(validParts, material),
        cuttingPricePerSheetTiyn: settings.cuttingPricePerSheetTiyn,
        extraServicesTiyn: Math.round((parseFloat(extraServicesTenge) || 0) * 100),
        deliveryCostTiyn: Math.round((parseFloat(deliveryTenge) || 0) * 100),
        discountTiyn: Math.round((parseFloat(discountTenge) || 0) * 100),
      })
    : null;

  const pvcBreakdown = computePvcBreakdown(validParts, pvcTypesById);

  const persistOrder = async (asDraft: boolean) => {
    if (usesOwnMaterial ? !customerMaterialName.trim() : !material || !totals) {
      showToast("Алдымен листті таңдаңыз");
      return;
    }
    setSubmitting(true);
    try {
      const orderId = editOrderId || doc(collection(db, "orders")).id;
      const isNew = !editOrderId;
      const orderRef = doc(db, "orders", orderId);

      // A customer's own sheet has no catalogue entry: the snapshot carries the name they typed
      // and zeroed specs, which is what the Manager sees and prices.
      const materialSnapshot = usesOwnMaterial
        ? {
            name: customerMaterialName.trim(),
            article: "",
            color: "",
            thicknessMm: 0,
            sheetLengthMm: 0,
            sheetWidthMm: 0,
            sellingPriceTiyn: 0,
          }
        : {
            name: material!.name,
            article: material!.article,
            color: material!.color,
            thicknessMm: material!.thicknessMm,
            sheetLengthMm: material!.sheetLengthMm,
            sheetWidthMm: material!.sheetWidthMm,
            sellingPriceTiyn: material!.sellingPriceTiyn,
          };

      const basePayload = {
        customerId: user.uid,
        customerName: userData.name,
        customerPhone: userData.phone,
        materialSource: usesOwnMaterial ? "customer" : "shop",
        customerMaterialName: usesOwnMaterial ? customerMaterialName.trim() : "",
        materialId: usesOwnMaterial ? "" : material!.id,
        materialSnapshot,
        productionStatus: asDraft ? "draft" : "submitted",
        paymentStatus: "unpaid",
        priority: 0,
        estimatedSheets: totals?.estimatedSheets ?? 0,
        pvcMetersTotal: totals?.pvcMetersTotal ?? totalPvcMeters(validParts),
        materialCostTiyn: totals?.materialCostTiyn ?? 0,
        cuttingCostTiyn: totals?.cuttingCostTiyn ?? 0,
        pvcCostTiyn: totals?.pvcCostTiyn ?? 0,
        hdfCostTiyn: 0,
        extraServicesTiyn: Math.round((parseFloat(extraServicesTenge) || 0) * 100),
        deliveryCostTiyn: Math.round((parseFloat(deliveryTenge) || 0) * 100),
        discountTiyn: Math.round((parseFloat(discountTenge) || 0) * 100),
        totalTiyn: totals?.totalTiyn ?? 0,
        paidTiyn: 0,
        debtTiyn: totals?.totalTiyn ?? 0,
        // The customer's own arithmetic is never authoritative — the Manager publishes the real
        // price. Recorded explicitly so the customer UI shows "Баға есептелуде..." until then.
        pricePublished: false,
        customerNote: customerNote.trim(),
        isDraft: asDraft,
        updatedAt: serverTimestamp(),
      };

      if (isNew) {
        // The order doc must exist before the parts subcollection is written: firestore.rules'
        // parts-create check reads the parent order via get(), which — inside a single batch —
        // only sees state from BEFORE that batch, never sibling writes in the same commit. Two
        // sequential writes (order first, then parts) instead of one atomic batch.
        const orderNumber = await generateOrderNumber(db);
        await setDoc(orderRef, {
          ...basePayload,
          orderNumber,
          createdAt: serverTimestamp(),
          submittedAt: asDraft ? null : serverTimestamp(),
        });

        const partsBatch = writeBatch(db);
        for (const part of validParts) {
          const partRef = doc(collection(db, "orders", orderId, "parts"));
          partsBatch.set(partRef, {
            name: part.name || "Бөлшек",
            lengthMm: part.lengthMm,
            widthMm: part.widthMm,
            qty: part.qty,
            grainDirection: part.grainDirection,
            rotationAllowed: part.rotationAllowed,
            note: part.note || "",
            edges: serializeEdges(part.edges),
          });
        }
        await partsBatch.commit();
      } else {
        // Editing an already-existing order — the parent doc is already committed, so the parts
        // rule's get() on it resolves fine even inside one atomic batch.
        const batch = writeBatch(db);
        batch.set(orderRef, {
          ...basePayload,
          submittedAt: asDraft ? null : serverTimestamp(),
        }, { merge: true });
        const existingParts = await getDocs(collection(db, "orders", orderId, "parts"));
        existingParts.forEach((d) => batch.delete(d.ref));
        for (const part of validParts) {
          const partRef = doc(collection(db, "orders", orderId, "parts"));
          batch.set(partRef, {
            name: part.name || "Бөлшек",
            lengthMm: part.lengthMm,
            widthMm: part.widthMm,
            qty: part.qty,
            grainDirection: part.grainDirection,
            rotationAllowed: part.rotationAllowed,
            note: part.note || "",
            edges: serializeEdges(part.edges),
          });
        }
        await batch.commit();
      }
      // The order now lives in Firestore — the local recovery cache has done its job.
      try {
        localStorage.removeItem(autosaveKey);
      } catch {
        // Storage unavailable; nothing to clean up.
      }
      showToast(asDraft ? "💾 Жоба сақталды" : "✅ Заказ жіберілді");
      navigate("/orders");
    } catch (err: unknown) {
      showToast("Қате: " + (err as Error).message);
    }
    setSubmitting(false);
  };

  return (
    <AppShell title="Жаңа заказ" back="/orders" contentWidth="narrow">
      <div className="wizard-steps">
        {STEP_LABELS.map((label, i) => (
          <div key={label} className={`wizard-step${step === i + 1 ? " active" : step > i + 1 ? " done" : ""}`}>
            <div className="wizard-step-dot">{step > i + 1 ? "✓" : i + 1}</div>
            <div className="wizard-step-label">{label}</div>
          </div>
        ))}
      </div>

      <div className="orders-section">
        {step === 1 && (
          <div className="wizard-panel">
            <div className="section-title">Лист кімдікі?</div>
            <div className="source-pick-row">
              <button
                type="button"
                className={`source-pick-card${materialSource === "shop" ? " selected" : ""}`}
                onClick={() => setMaterialSource("shop")}
              >
                <strong>Лист бізден</strong>
                <span>Біздегі листтерден таңдайсыз</span>
              </button>
              <button
                type="button"
                className={`source-pick-card${materialSource === "customer" ? " selected" : ""}`}
                onClick={() => setMaterialSource("customer")}
              >
                <strong>Өз листім</strong>
                <span>Листті өзіңіз әкелесіз</span>
              </button>
            </div>

            {materialSource === "shop" && (
              <>
                <div className="section-title" style={{ marginTop: 18 }}>Листті таңдаңыз</div>
                <div className="material-pick-grid">
                  {materials.map((m) => {
                    const available = m.qtyOnHand - m.reservedQty;
                    return (
                      <button
                        type="button"
                        key={m.id}
                        className={`material-pick-card${materialId === m.id ? " selected" : ""}`}
                        onClick={() => setMaterialId(m.id)}
                      >
                        <strong>{m.name}</strong>
                        <span>{m.color} · {m.thicknessMm} мм</span>
                        <span>{m.sheetLengthMm}×{m.sheetWidthMm} мм</span>
                        <span>{formatMoney(m.sellingPriceTiyn)} / лист</span>
                        <span className={available > 0 ? "in-stock" : "out-of-stock"}>
                          {available > 0 ? "Қоймада бар" : "Қоймада жоқ"}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </>
            )}

            {materialSource === "customer" && (
              <div style={{ marginTop: 18 }}>
                <div className="form-group">
                  <label>Лист атауы</label>
                  <input
                    className="form-input"
                    placeholder="Мысалы: Ақ ЛДСП 16 мм"
                    value={customerMaterialName}
                    onChange={(e) => setCustomerMaterialName(e.target.value)}
                  />
                </div>
                <p className="wizard-hint">
                  Листтің бағасын менеджер есептейді. Тек кесу және ПВХ қызметі есептеледі.
                </p>
              </div>
            )}

            <div className="wizard-actions">
              <button className="btn btn-primary" disabled={!canGoToStep2} onClick={() => setStep(2)}>
                Келесі →
              </button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="wizard-panel">
            <div className="section-title">
              Размерлер мен ПВХ — {usesOwnMaterial ? customerMaterialName : material?.name}
            </div>
            <div className="parts-toolbar">
              <label className="btn btn-outline btn-sm">
                📥 XLSX импорт
                <input type="file" accept=".xlsx,.xls,.csv" onChange={handleXlsxImport} hidden />
              </label>
              <button
                type="button"
                className="btn btn-outline btn-sm"
                onClick={async () => {
                  const text = await navigator.clipboard.readText().catch(() => "");
                  if (text) handleBulkPaste(text);
                  else showToast("Алдымен Excel-ден көшіріңіз (Ctrl+C)");
                }}
              >
                📋 Excel-ден қою
              </button>
            </div>

            <BulkPartsEditor
              parts={parts}
              onChange={setParts}
              pvcTypes={pvcTypes}
              onAddPart={addPart}
              onOpenScanner={() => setScannerOpen(true)}
              onToast={showToast}
              warning={
                fittingErrors > 0 && material
                  ? `${fittingErrors} бөлшек листке сыймайды (${material.sheetLengthMm}×${material.sheetWidthMm} мм) — өлшемдерін тексеріңіз`
                  : undefined
              }
            />

            {pvcBreakdown.length > 0 && (
              <div className="pvc-summary">
                <div className="section-title">ПВХ қорытынды</div>
                {pvcBreakdown.map((row) => (
                  <div key={row.key} className="pvc-summary-row">
                    <span>{row.colorName} · {row.thicknessMm} мм</span>
                    <span>{row.meters.toFixed(2)} м</span>
                    <span>{formatMoney(row.costTiyn)}</span>
                  </div>
                ))}
              </div>
            )}

            <div className="wizard-actions">
              <button className="btn btn-outline" onClick={() => setStep(1)}>
                ← Артқа
              </button>
              <button className="btn btn-primary" disabled={!canGoToStep3} onClick={() => setStep(3)}>
                Келесі →
              </button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="wizard-panel">
            <div className="section-title">Растау</div>
            <div className="confirm-summary">
              <div className="confirm-row">
                <span>Клиент</span>
                <strong>{userData.name}</strong>
              </div>
              <div className="confirm-row">
                <span>Материал</span>
                <strong>
                  {usesOwnMaterial
                    ? `${customerMaterialName} (өз листіңіз)`
                    : `${material?.name} (${material?.color})`}
                </strong>
              </div>
              <div className="confirm-row">
                <span>Бөлшектер саны</span>
                <strong>{validParts.reduce((s, p) => s + p.qty, 0)}</strong>
              </div>
              {totals ? (
                <>
                  <div className="confirm-row">
                    <span>Болжамды лист саны</span>
                    <strong>{totals.estimatedSheets}</strong>
                  </div>
                  <div className="confirm-row">
                    <span>ПВХ метр</span>
                    <strong>{totals.pvcMetersTotal.toFixed(2)} м</strong>
                  </div>
                  <div className="confirm-row">
                    <span>Материал құны</span>
                    <strong>{formatMoney(totals.materialCostTiyn)}</strong>
                  </div>
                  <div className="confirm-row">
                    <span>Кесу қызметі</span>
                    <strong>{formatMoney(totals.cuttingCostTiyn)}</strong>
                  </div>
                  <div className="confirm-row">
                    <span>ПВХ құны</span>
                    <strong>{formatMoney(totals.pvcCostTiyn)}</strong>
                  </div>
                </>
              ) : (
                <div className="confirm-row">
                  <span>ПВХ метр</span>
                  <strong>{totalPvcMeters(validParts).toFixed(2)} м</strong>
                </div>
              )}
              <div className="form-grid">
                <div className="form-group">
                  <label>Қосымша қызмет (₸)</label>
                  <MoneyInput
                    valueTiyn={Math.round((parseFloat(extraServicesTenge) || 0) * 100)}
                    onChange={(t) => setExtraServicesTenge(String(t / 100))}
                  />
                </div>
                <div className="form-group">
                  <label>Жеткізу құны (₸)</label>
                  <MoneyInput
                    valueTiyn={Math.round((parseFloat(deliveryTenge) || 0) * 100)}
                    onChange={(t) => setDeliveryTenge(String(t / 100))}
                  />
                </div>
                <div className="form-group">
                  <label>Жеңілдік (₸)</label>
                  <MoneyInput
                    valueTiyn={Math.round((parseFloat(discountTenge) || 0) * 100)}
                    onChange={(t) => setDiscountTenge(String(t / 100))}
                  />
                </div>
              </div>
              <div className="confirm-row confirm-total">
                <span>Барлығы</span>
                <strong>{totals ? formatMoney(totals.totalTiyn) : "Менеджер есептейді"}</strong>
              </div>
              <div className="form-group">
                <label>Ескертпе</label>
                <textarea
                  className="form-input"
                  value={customerNote}
                  onChange={(e) => setCustomerNote(e.target.value)}
                  rows={3}
                />
              </div>
            </div>

            <div className="wizard-actions">
              <button className="btn btn-outline" onClick={() => setStep(2)}>
                ← Артқа
              </button>
              <button className="btn btn-outline" disabled={submitting} onClick={() => persistOrder(true)}>
                💾 Жоба ретінде сақтау
              </button>
              <button className="btn btn-primary" disabled={submitting} onClick={() => persistOrder(false)}>
                {submitting ? "Жіберілуде…" : "✅ Заказды жіберу"}
              </button>
            </div>
          </div>
        )}
      </div>

      <Toast message={message} visible={visible} />

      {scannerOpen && (
        <DimensionScanner
          onDetected={handleScannedDimensions}
          onClose={() => setScannerOpen(false)}
        />
      )}
    </AppShell>
  );
}
