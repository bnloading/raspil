import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  addDoc,
  collection,
  doc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from "firebase/firestore";
import { db } from "../../firebase";
import { useAuth } from "../../AuthContext";
import { Toast, Spinner } from "../../components";
import { AppShell } from "../../components/layout/AppShell";
import { useToast } from "../../hooks";
import { useMaterials, usePvcTypes } from "../../hooks/useMaterials";
import { stockStatus, lowStockCount } from "../../lib/stockStatus";
import { pvcStockStatus } from "../../lib/pvcStock";
import { RowMenu } from "../../components/RowMenu";
import { MaterialThumb } from "../../components/MaterialThumb";
import { formatMoney, parseMoneyInput } from "../../lib/money";
import { formatDateTimeDMY } from "../../lib/dates";
import { logAudit } from "../../lib/audit";
import { canManageWarehouse } from "../../lib/rbac";
import { recordInventoryMovement } from "../../lib/warehouse";
import { MATERIAL_CATEGORY_LABELS } from "../../types/domain";
import type {
  InventoryMovement,
  LeftoverPiece,
  Material,
  MaterialCategory,
  MaterialCost,
  PvcType,
} from "../../types/domain";

type Tab = "materials" | "pvc" | "leftovers";

export default function AdminMaterials() {
  const auth = useAuth();
  const { message, visible, showToast } = useToast();
  const [tab, setTab] = useState<Tab>("materials");
  const { materials, loading: materialsLoading } = useMaterials(false);
  const { pvcTypes, loading: pvcLoading } = usePvcTypes(false);
  const [ledgerFor, setLedgerFor] = useState<Material | null>(null);
  const [editingMaterial, setEditingMaterial] = useState<Material | "new" | null>(null);
  const [editingPvc, setEditingPvc] = useState<PvcType | "new" | null>(null);
  // A Manager may look — stock, prices, movement history — but every write here stays Admin-only,
  // exactly as firestore.rules enforces it. Hiding the controls avoids offering buttons that would
  // come back "permission denied".
  const canEdit = canManageWarehouse(auth.userData?.role);

  const stockTotals = useMemo(
    () => ({
      materials: materials.length,
      sheets: materials.reduce((s, m) => s + (m.qtyOnHand ?? 0), 0),
      reserved: materials.reduce((s, m) => s + (m.reservedQty ?? 0), 0),
      low: lowStockCount(materials),
    }),
    [materials],
  );

  if (!auth.userData) return <Spinner />;

  return (
    <AppShell
      title="Қойма"
      subtitle="Материалдар мен қалдықтар"
      actions={
        canEdit && tab !== "leftovers" ? (
          <button
            className="btn btn-primary btn-sm"
            type="button"
            onClick={() => (tab === "pvc" ? setEditingPvc("new") : setEditingMaterial("new"))}
          >
            {tab === "pvc" ? "+ ПВХ түрі қосу" : "+ Материал қосу"}
          </button>
        ) : undefined
      }
    >
      <div className="kpi-row">
        <div className="kpi-card">
          <div className="kpi-text">
            <div className="kpi-label">Барлығы</div>
            <div className="kpi-value">{stockTotals.materials} материал</div>
          </div>
          <span className="kpi-icon is-indigo">📦</span>
        </div>
        <div className="kpi-card">
          <div className="kpi-text">
            <div className="kpi-label">Қоймада</div>
            <div className="kpi-value">{stockTotals.sheets} лист</div>
          </div>
          <span className="kpi-icon is-green">🧱</span>
        </div>
        <div className="kpi-card">
          <div className="kpi-text">
            <div className="kpi-label">Аз қалған</div>
            <div className={`kpi-value${stockTotals.low > 0 ? " is-danger" : ""}`}>{stockTotals.low}</div>
          </div>
          <span className="kpi-icon is-red">⚠️</span>
        </div>
        <div className="kpi-card">
          <div className="kpi-text">
            <div className="kpi-label">Резервте</div>
            <div className="kpi-value">{stockTotals.reserved} лист</div>
          </div>
          <span className="kpi-icon is-blue">🔖</span>
        </div>
      </div>

      <div className="tab-pill-row">
        <button className={`tab-pill${tab === "materials" ? " active" : ""}`} onClick={() => setTab("materials")}>
          Материалдар
        </button>
        <button className={`tab-pill${tab === "pvc" ? " active" : ""}`} onClick={() => setTab("pvc")}>
          ПВХ түрлері
        </button>
        {canEdit && (
          <button className={`tab-pill${tab === "leftovers" ? " active" : ""}`} onClick={() => setTab("leftovers")}>
            Қалдықтар
          </button>
        )}
      </div>

      {tab === "materials" && (
        <MaterialsTab
          materials={materials}
          loading={materialsLoading}
          canEdit={canEdit}
          onEdit={setEditingMaterial}
          onLedger={setLedgerFor}
          showToast={showToast}
        />
      )}
      {tab === "pvc" && (
        <PvcTab pvcTypes={pvcTypes} loading={pvcLoading} canEdit={canEdit} onEdit={setEditingPvc} showToast={showToast} />
      )}
      {tab === "leftovers" && canEdit && <LeftoversTab materials={materials} showToast={showToast} />}

      {editingMaterial && (
        <MaterialModal
          material={editingMaterial === "new" ? null : editingMaterial}
          onClose={() => setEditingMaterial(null)}
          showToast={showToast}
        />
      )}
      {editingPvc && (
        <PvcModal pvcType={editingPvc === "new" ? null : editingPvc} onClose={() => setEditingPvc(null)} showToast={showToast} />
      )}
      {ledgerFor && <LedgerModal material={ledgerFor} onClose={() => setLedgerFor(null)} />}

      <Toast message={message} visible={visible} />
    </AppShell>
  );
}

function MaterialsTab({
  materials,
  loading,
  canEdit,
  onEdit,
  onLedger,
  showToast,
}: {
  materials: Material[];
  loading: boolean;
  canEdit: boolean;
  onEdit: (m: Material | "new") => void;
  onLedger: (m: Material) => void;
  showToast: (msg: string) => void;
}) {
  const auth = useAuth();
  // Held by id, not by object: the modal then always reads the live row from `materials`, so a
  // balance that moves while the form is open is corrected against the new number, not a stale one.
  const [correctingId, setCorrectingId] = useState<string | null>(null);
  const correcting = materials.find((m) => m.id === correctingId) ?? null;

  const handleReceipt = async (material: Material) => {
    const qtyStr = prompt(`"${material.name}" қабылдау мөлшері (лист):`);
    if (qtyStr === null) return;
    const qty = parseInt(qtyStr, 10);
    if (!Number.isFinite(qty) || qty <= 0) return;
    if (!auth.user || !auth.userData) return;
    try {
      await recordInventoryMovement(db, { user: auth.user, userData: auth.userData }, {
        materialId: material.id,
        type: "receipt",
        qty,
        comment: "Жеткізушіден қабылданды",
      });
      showToast(`✅ +${qty} лист қабылданды`);
    } catch (err: unknown) {
      showToast("Қате: " + (err as Error).message);
    }
  };

  return (
    <div className="panel-card">
      {loading ? (
        <Spinner />
      ) : materials.length === 0 ? (
        <div className="empty-state">
          <div className="icon">📭</div>
          <p>Материал жоқ</p>
        </div>
      ) : (
        <div className="data-table-wrap">
          <table className="data-table stack-mobile stack-compact">
            <thead>
              <tr>
                <th>Материал</th>
                <th>Өлшемі</th>
                <th>Қоймада</th>
                <th className="num">Резерв</th>
                <th className="num">Мин. қор</th>
                <th className="num">Бағасы</th>
                <th>Күйі</th>
                <th>Әрекеттер</th>
              </tr>
            </thead>
            <tbody>
              {materials.map((m) => {
                const stock = stockStatus(m);
                return (
                  <tr key={m.id} className={!m.active ? "blocked" : undefined}>
                    <td data-label="Материал">
                      <div className="wh-material">
                        <MaterialThumb material={m} />
                        <span>
                          <strong>{m.name}</strong>
                          <span className="wh-sub">
                            {m.article || MATERIAL_CATEGORY_LABELS[m.category ?? "ldsp"]}
                          </span>
                        </span>
                      </div>
                    </td>
                    <td data-label="Өлшемі" className="wh-sub">
                      {m.sheetLengthMm}×{m.sheetWidthMm} · {m.thicknessMm} мм
                    </td>
                    <td data-label="Қоймада">
                      {m.stockTracked === false ? (
                        <div className="wh-qty wh-sub">—</div>
                      ) : (
                        <>
                          <div className="wh-qty">
                            <strong>{stock.available}</strong> <span className="wh-sub">лист</span>
                          </div>
                          {/* Bar repeats the Күйі pill in a form you can scan down a column. */}
                          <div className="wh-bar">
                            <span className={`wh-bar-fill is-${stock.level}`} style={{ width: `${stock.ratio * 100}%` }} />
                          </div>
                        </>
                      )}
                    </td>
                    <td className="num" data-label="Резерв">{m.reservedQty}</td>
                    <td className="num" data-label="Мин. қор">{m.minStock}</td>
                    <td className="num" data-label="Бағасы">
                      {formatMoney(m.sellingPriceTiyn)}
                    </td>
                    <td data-label="Күйі">
                      <span className={`wh-pill is-${stock.level}`}>{stock.label}</span>
                    </td>
                    {/* Receiving stock is the everyday action, so it stays visible; the rest fold
                        into the overflow menu rather than spending four buttons of width per row. */}
                    <td data-label="Әрекеттер">
                      {canEdit ? (
                        <RowMenu
                          items={[
                            { label: "Тарих", onClick: () => onLedger(m) },
                            { label: "Түзету · баға", onClick: () => setCorrectingId(m.id) },
                            { label: "Өзгерту", onClick: () => onEdit(m) },
                          ]}
                        >
                          <button className="btn btn-outline btn-sm" onClick={() => handleReceipt(m)}>
                            + Қабылдау
                          </button>
                        </RowMenu>
                      ) : (
                        <button className="btn btn-outline btn-sm" onClick={() => onLedger(m)}>
                          Тарих
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {correcting && (
        <StockCorrectionModal
          key={correcting.id}
          material={correcting}
          onClose={() => setCorrectingId(null)}
          showToast={showToast}
        />
      )}
    </div>
  );
}

/**
 * Counted balance and selling price in one form.
 *
 * Fixing a balance and repricing the same sheet are one errand — the admin is standing at the rack
 * with the delivery note in hand — so both are edited together and saved once. Only what actually
 * changed is written: an untouched price produces no update, an untouched quantity no ledger entry.
 *
 * The quantity is entered as the number counted on the rack, not as ±N: after a count that is the
 * figure the admin is holding, and the delta the ledger needs is arithmetic the form can do itself.
 */
function StockCorrectionModal({
  material,
  onClose,
  showToast,
}: {
  material: Material;
  onClose: () => void;
  showToast: (msg: string) => void;
}) {
  const auth = useAuth();
  const [countedText, setCountedText] = useState(String(material.qtyOnHand));
  const [priceText, setPriceText] = useState(String(material.sellingPriceTiyn / 100));
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const counted = parseInt(countedText, 10);
  const countedValid = Number.isFinite(counted) && counted >= 0;
  const delta = countedValid ? counted - material.qtyOnHand : 0;
  const priceTiyn = parseMoneyInput(priceText);
  const priceChanged = priceTiyn !== material.sellingPriceTiyn;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!auth.user || !auth.userData) return;
    if (!countedValid) {
      showToast("Қалдықты дұрыс енгізіңіз");
      return;
    }
    if (delta !== 0 && !reason.trim()) {
      showToast("Себепсіз түзету жасалмайды");
      return;
    }
    if (priceChanged && priceTiyn <= 0) {
      showToast("Баға 0-ден үлкен болуы керек");
      return;
    }
    if (delta === 0 && !priceChanged) {
      onClose();
      return;
    }

    const actor = { user: auth.user, userData: auth.userData };
    setSubmitting(true);
    try {
      if (priceChanged) {
        await updateDoc(doc(db, "materials", material.id), { sellingPriceTiyn: priceTiyn });
        await logAudit(db, actor, {
          action: "material.price",
          entityType: "material",
          entityId: material.id,
          before: { sellingPriceTiyn: material.sellingPriceTiyn },
          after: { sellingPriceTiyn: priceTiyn },
          comment: reason.trim() || undefined,
        });
      }
      if (delta !== 0) {
        // Signed delta, and negative balances stay blocked by the ledger itself — `allowNegative`
        // only lets an Admin's confirmed correction dip below zero, which is what this form is.
        await recordInventoryMovement(db, actor, {
          materialId: material.id,
          type: "manual_correction",
          qty: delta,
          comment: reason.trim(),
          allowNegative: true,
        });
        await logAudit(db, actor, {
          action: "warehouse.correction",
          entityType: "material",
          entityId: material.id,
          before: { qtyOnHand: material.qtyOnHand },
          after: { qtyOnHand: counted, delta, reason: reason.trim() },
        });
      }
      showToast(
        delta !== 0 && priceChanged
          ? "✅ Қалдық пен баға жаңартылды"
          : delta !== 0
            ? "✅ Қалдық түзетілді"
            : "✅ Баға жаңартылды",
      );
      onClose();
    } catch (err: unknown) {
      showToast("Қате: " + (err as Error).message);
    }
    setSubmitting(false);
  };

  return (
    <div className="modal-overlay active" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-handle" />
        <h2>🧮 {material.name}</h2>
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>Нақты қалдық (лист)</label>
            <input
              type="number"
              className="form-input"
              value={countedText}
              min={0}
              autoFocus
              onChange={(e) => setCountedText(e.target.value)}
            />
            <p className="form-hint">
              Қоймада: {material.qtyOnHand} лист
              {material.reservedQty > 0 ? ` (${material.reservedQty} бронда)` : ""}
              {delta !== 0 ? ` · айырма ${delta > 0 ? "+" : ""}${delta}` : " · өзгеріссіз"}
            </p>
          </div>
          <div className="form-group">
            <label>Сату бағасы (лист үшін, ₸)</label>
            <input
              type="number"
              className="form-input"
              value={priceText}
              min={0}
              onChange={(e) => setPriceText(e.target.value)}
            />
            <p className="form-hint">
              Қазір: {formatMoney(material.sellingPriceTiyn)}
              {priceChanged ? ` → ${formatMoney(priceTiyn)}` : " · өзгеріссіз"}
            </p>
          </div>
          <div className="form-group">
            <label>Себебі{delta !== 0 ? "" : " (міндетті емес)"}</label>
            <input
              className="form-input"
              value={reason}
              placeholder="Түгендеу, сынық, қате есеп…"
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <div className="modal-actions">
            <button type="button" className="btn btn-outline" onClick={onClose}>
              Болдырмау
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={submitting || (delta === 0 && !priceChanged)}
            >
              Сақтау
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function MaterialModal({
  material,
  onClose,
  showToast,
}: {
  material: Material | null;
  onClose: () => void;
  showToast: (msg: string) => void;
}) {
  const auth = useAuth();
  const [name, setName] = useState(material?.name ?? "");
  const [article, setArticle] = useState(material?.article ?? "");
  const [color, setColor] = useState(material?.color ?? "");
  const [manufacturer, setManufacturer] = useState(material?.manufacturer ?? "");
  const [thicknessMm, setThicknessMm] = useState(String(material?.thicknessMm ?? 16));
  // Drives the cutter's piece rate (ЛДСП / ХДФ / столешница are paid differently).
  const [category, setCategory] = useState<MaterialCategory>(material?.category ?? "ldsp");
  const [sheetLengthMm, setSheetLengthMm] = useState(String(material?.sheetLengthMm ?? 2800));
  const [sheetWidthMm, setSheetWidthMm] = useState(String(material?.sheetWidthMm ?? 2070));
  const [sellingPrice, setSellingPrice] = useState(
    material ? String(material.sellingPriceTiyn / 100) : "",
  );
  const [purchasePrice, setPurchasePrice] = useState("");
  const [initialQty, setInitialQty] = useState(String(material?.initialQty ?? 0));
  const [minStock, setMinStock] = useState(String(material?.minStock ?? 5));
  const [grainRequired, setGrainRequired] = useState(material?.grainDirectionRequired ?? false);
  // Undefined means tracked: everything the shop owns is counted unless it is explicitly not ours.
  const [stockTracked, setStockTracked] = useState(material?.stockTracked !== false);
  const [active, setActive] = useState(material?.active ?? true);
  const [note, setNote] = useState(material?.note ?? "");
  const [imageUrl, setImageUrl] = useState(material?.imageUrl ?? "");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!material) return;
    (async () => {
      const { getDoc, doc: docRef } = await import("firebase/firestore");
      const snap = await getDoc(docRef(db, "materialCosts", material.id));
      if (snap.exists()) {
        setPurchasePrice(String((snap.data() as MaterialCost).purchasePriceTiyn / 100));
      }
    })();
  }, [material]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !auth.user || !auth.userData) return;
    setSubmitting(true);
    try {
      const payload = {
        name: name.trim(),
        article: article.trim(),
        color: color.trim(),
        manufacturer: manufacturer.trim(),
        thicknessMm: parseFloat(thicknessMm) || 0,
        category,
        sheetLengthMm: parseInt(sheetLengthMm, 10) || 0,
        sheetWidthMm: parseInt(sheetWidthMm, 10) || 0,
        sellingPriceTiyn: parseMoneyInput(sellingPrice),
        minStock: parseInt(minStock, 10) || 0,
        grainDirectionRequired: grainRequired,
        stockTracked,
        active,
        archived: false,
        note: note.trim(),
        imageUrl: imageUrl.trim(),
      };

      let materialId: string;
      if (material) {
        materialId = material.id;
        await updateDoc(doc(db, "materials", materialId), payload);
      } else {
        const qty = parseInt(initialQty, 10) || 0;
        const ref = await addDoc(collection(db, "materials"), {
          ...payload,
          initialQty: qty,
          qtyOnHand: qty,
          reservedQty: 0,
          createdAt: serverTimestamp(),
        });
        materialId = ref.id;
        if (qty > 0) {
          await recordInventoryMovement(db, { user: auth.user, userData: auth.userData }, {
            materialId,
            type: "initial",
            qty,
            comment: "Бастапқы қалдық",
          });
        }
      }

      await setDoc(doc(db, "materialCosts", materialId), {
        purchasePriceTiyn: parseMoneyInput(purchasePrice),
      });

      await logAudit(db, { user: auth.user, userData: auth.userData }, {
        action: material ? "material.update" : "material.create",
        entityType: "material",
        entityId: materialId,
        after: payload,
      });

      showToast(material ? "✅ Материал жаңартылды" : "✅ Материал қосылды");
      onClose();
    } catch (err: unknown) {
      showToast("Қате: " + (err as Error).message);
    }
    setSubmitting(false);
  };

  return (
    <div className="modal-overlay active" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-handle" />
        <h2>{material ? "✎ Материалды өзгерту" : "➕ Жаңа материал"}</h2>
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>Атауы</label>
            <input className="form-input" value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div className="form-group">
            <label>Артикул</label>
            <input className="form-input" value={article} onChange={(e) => setArticle(e.target.value)} />
          </div>
          <div className="form-group">
            <label>Түсі</label>
            <input className="form-input" value={color} onChange={(e) => setColor(e.target.value)} />
          </div>
          <div className="form-group">
            <label>Өндіруші/Коллекция</label>
            <input className="form-input" value={manufacturer} onChange={(e) => setManufacturer(e.target.value)} />
          </div>
          <div className="form-group">
            {/* Drives the cutter's piece rate — ЛДСП, ХДФ and столешница are paid at different
                rates, and that cannot be inferred from the material name. */}
            <label>Түрі</label>
            <select
              className="form-input"
              value={category}
              onChange={(e) => setCategory(e.target.value as MaterialCategory)}
            >
              {(Object.keys(MATERIAL_CATEGORY_LABELS) as MaterialCategory[]).map((c) => (
                <option key={c} value={c}>
                  {MATERIAL_CATEGORY_LABELS[c]}
                </option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label>Қалыңдығы (мм)</label>
            <input type="number" className="form-input" value={thicknessMm} onChange={(e) => setThicknessMm(e.target.value)} />
          </div>
          <div className="form-group">
            <label>Лист өлшемі (ұзындығы × ені, мм)</label>
            <div style={{ display: "flex", gap: 8 }}>
              <input type="number" className="form-input" value={sheetLengthMm} onChange={(e) => setSheetLengthMm(e.target.value)} />
              <input type="number" className="form-input" value={sheetWidthMm} onChange={(e) => setSheetWidthMm(e.target.value)} />
            </div>
          </div>
          <div className="form-group">
            <label>Сату бағасы (лист үшін, ₸)</label>
            <input type="number" className="form-input" value={sellingPrice} onChange={(e) => setSellingPrice(e.target.value)} required />
          </div>
          <div className="form-group">
            <label>Сатып алу бағасы (₸, тек әкімші көреді)</label>
            <input type="number" className="form-input" value={purchasePrice} onChange={(e) => setPurchasePrice(e.target.value)} />
          </div>
          {!material && (
            <div className="form-group">
              <label>Бастапқы қалдық (лист)</label>
              <input type="number" className="form-input" value={initialQty} onChange={(e) => setInitialQty(e.target.value)} />
            </div>
          )}
          <div className="form-group">
            <label>Минималды қалдық (ескерту үшін)</label>
            <input type="number" className="form-input" value={minStock} onChange={(e) => setMinStock(e.target.value)} />
          </div>
          <div className="form-group">
            <label>Сурет URL (міндетті емес)</label>
            <input className="form-input" value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} />
          </div>
          <div className="form-group">
            <label>Ескертпе</label>
            <input className="form-input" value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          <label className="remember-me">
            <input type="checkbox" checked={grainRequired} onChange={(e) => setGrainRequired(e.target.checked)} />
            <span className="remember-check">{grainRequired ? "✓" : ""}</span>
            <span>Талшық бағыты міндетті</span>
          </label>
          {/* Turning this off makes the row a priced line that never moves a warehouse balance —
              a customer's own board, an offcut, anything bought per order. Without it a permanent
              zero would both raise a false "Таусылды" and block the order from reaching the saw. */}
          <label className="remember-me">
            <input type="checkbox" checked={stockTracked} onChange={(e) => setStockTracked(e.target.checked)} />
            <span className="remember-check">{stockTracked ? "✓" : ""}</span>
            <span>Қоймада есептеледі (кесуге жібергенде минус болады)</span>
          </label>
          <label className="remember-me">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
            <span className="remember-check">{active ? "✓" : ""}</span>
            <span>Белсенді (клиенттерге көрінеді)</span>
          </label>
          <div className="modal-actions">
            <button type="button" className="btn btn-outline" onClick={onClose}>
              Болдырмау
            </button>
            <button type="submit" className="btn btn-primary" disabled={submitting}>
              Сақтау
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function LedgerModal({ material, onClose }: { material: Material; onClose: () => void }) {
  const [movements, setMovements] = useState<InventoryMovement[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const q = query(
      collection(db, "inventoryMovements"),
      where("materialId", "==", material.id),
      orderBy("createdAt", "desc"),
    );
    const unsub = onSnapshot(q, (snap) => {
      const list: InventoryMovement[] = [];
      snap.forEach((d) => list.push({ id: d.id, ...(d.data() as Omit<InventoryMovement, "id">) }));
      setMovements(list);
      setLoading(false);
    });
    return unsub;
  }, [material.id]);

  return (
    <div className="modal-overlay active" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-handle" />
        <h2>📜 {material.name} — қозғалыс тарихы</h2>
        {loading ? (
          <Spinner />
        ) : movements.length === 0 ? (
          <p>Қозғалыс жоқ</p>
        ) : (
          <div className="data-list" style={{ maxHeight: "60vh", overflowY: "auto" }}>
            {movements.map((m) => (
              <div key={m.id} className="data-row">
                <div className="data-row-main">
                  <strong>{movementTypeLabel(m.type)}</strong>
                  <span>
                    {m.qty > 0 ? "+" : ""}
                    {m.qty} лист · қалдық {m.balanceBefore} → {m.balanceAfter}
                  </span>
                  {m.comment && <span>{m.comment}</span>}
                  <span>
                    {m.userName} · {m.createdAt ? formatDateTimeDMY(m.createdAt) : ""}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="modal-actions">
          <button type="button" className="btn btn-outline" onClick={onClose}>
            Жабу
          </button>
        </div>
      </div>
    </div>
  );
}

function movementTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    initial: "Бастапқы қалдық",
    receipt: "Қабылдау",
    reservation: "Брондау",
    reservation_release: "Бронь босату",
    cutting_consumption: "Кесу кезінде есептен шығару",
    return: "Қайтару",
    manual_correction: "Қолмен түзету",
    write_off: "Есептен шығару",
    reversal: "Кері қайтару",
  };
  return labels[type] || type;
}

function PvcTab({
  pvcTypes,
  loading,
  canEdit,
  onEdit,
  showToast,
}: {
  pvcTypes: PvcType[];
  loading: boolean;
  canEdit: boolean;
  onEdit: (p: PvcType | "new") => void;
  showToast: (msg: string) => void;
}) {
  /** Receiving a roll. Metres only — the rule forbids this path from touching colour or price. */
  const handlePvcReceipt = async (p: PvcType) => {
    const raw = prompt(`"${p.colorName} ${p.thicknessMm} мм" қабылдау мөлшері (метр):`);
    if (raw === null) return;
    const meters = parseFloat(raw.replace(",", "."));
    if (!Number.isFinite(meters) || meters <= 0) {
      showToast("Метрді дұрыс енгізіңіз");
      return;
    }
    try {
      const next = Math.round(((p.metersOnHand ?? 0) + meters) * 100) / 100;
      await updateDoc(doc(db, "pvcTypes", p.id), { metersOnHand: next });
      showToast(`✅ +${meters} м қабылданды — барлығы ${next} м`);
    } catch (err: unknown) {
      showToast("Қате: " + (err as Error).message);
    }
  };

  const handleToggleActive = async (p: PvcType) => {
    try {
      await updateDoc(doc(db, "pvcTypes", p.id), { active: !p.active });
    } catch (err: unknown) {
      showToast("Қате: " + (err as Error).message);
    }
  };

  return (
    <div className="panel-card">
      {loading ? (
        <Spinner />
      ) : pvcTypes.length === 0 ? (
        <div className="empty-state">
          <div className="icon">📭</div>
          <p>ПВХ түрлері жоқ</p>
        </div>
      ) : (
        <div className="data-table-wrap">
          <table className="data-table stack-mobile stack-compact">
            <thead>
              <tr>
                <th>Түсі / Қалыңдығы</th>
                <th>Қоймада</th>
                <th className="num">Мин. қор</th>
                <th className="num">Бағасы</th>
                <th>Күйі</th>
                <th>Әрекеттер</th>
              </tr>
            </thead>
            <tbody>
              {pvcTypes.map((p) => (
                <tr key={p.id} className={!p.active ? "blocked" : undefined}>
                  <td data-label="Түсі / Қалыңдығы">
                    {/* Edge banding is bought by colour, so show it. Resolves by colorName; the
                        colours with no photo fall back to the placeholder swatch. */}
                    <div className="wh-material">
                      <MaterialThumb material={p} />
                      <strong>
                        {p.colorName} · {p.thicknessMm} мм
                      </strong>
                    </div>
                  </td>
                  <td data-label="Қоймада">
                    <div className="wh-qty">
                      <strong>{pvcStockStatus(p).metersOnHand}</strong> <span className="wh-sub">м</span>
                    </div>
                    <div className="wh-bar">
                      <span className={`wh-bar-fill is-${pvcStockStatus(p).level}`}
                        style={{ width: `${pvcStockStatus(p).ratio * 100}%` }} />
                    </div>
                  </td>
                  <td className="num" data-label="Мин. қор">{p.minStockMeters ?? 0}</td>
                  <td className="num" data-label="Бағасы">
                    {formatMoney(p.pricePerMeterTiyn)} / метр
                  </td>
                  <td data-label="Күйі">
                    <span className={`wh-pill is-${pvcStockStatus(p).level}`}>{pvcStockStatus(p).label}</span>
                  </td>
                  <td data-label="Әрекеттер">
                    {canEdit ? (
                      <RowMenu
                        items={[
                          { label: "Өзгерту", onClick: () => onEdit(p) },
                          { label: p.active ? "Архивке" : "Белсендіру", onClick: () => handleToggleActive(p) },
                        ]}
                      >
                        <button className="btn btn-outline btn-sm" onClick={() => handlePvcReceipt(p)}>
                          + Қабылдау
                        </button>
                      </RowMenu>
                    ) : (
                      <span className="wh-sub">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function PvcModal({
  pvcType,
  onClose,
  showToast,
}: {
  pvcType: PvcType | null;
  onClose: () => void;
  showToast: (msg: string) => void;
}) {
  const [thicknessMm, setThicknessMm] = useState(String(pvcType?.thicknessMm ?? 2));
  const [colorName, setColorName] = useState(pvcType?.colorName ?? "");
  const [price, setPrice] = useState(pvcType ? String(pvcType.pricePerMeterTiyn / 100) : "");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const payload = {
        thicknessMm: parseFloat(thicknessMm) || 0,
        colorName: colorName.trim(),
        pricePerMeterTiyn: parseMoneyInput(price),
        active: pvcType?.active ?? true,
      };
      if (pvcType) {
        await updateDoc(doc(db, "pvcTypes", pvcType.id), payload);
      } else {
        await addDoc(collection(db, "pvcTypes"), payload);
      }
      showToast("✅ Сақталды");
      onClose();
    } catch (err: unknown) {
      showToast("Қате: " + (err as Error).message);
    }
    setSubmitting(false);
  };

  return (
    <div className="modal-overlay active" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-handle" />
        <h2>{pvcType ? "✎ ПВХ түрін өзгерту" : "➕ Жаңа ПВХ түрі"}</h2>
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>Қалыңдығы (мм)</label>
            <select className="form-input" value={thicknessMm} onChange={(e) => setThicknessMm(e.target.value)}>
              <option value="0.4">0.4 мм</option>
              <option value="1">1 мм</option>
              <option value="2">2 мм</option>
            </select>
          </div>
          <div className="form-group">
            <label>Түсі</label>
            <input className="form-input" value={colorName} onChange={(e) => setColorName(e.target.value)} required />
          </div>
          <div className="form-group">
            <label>Бағасы (метр үшін, ₸)</label>
            <input type="number" className="form-input" value={price} onChange={(e) => setPrice(e.target.value)} required />
          </div>
          <div className="modal-actions">
            <button type="button" className="btn btn-outline" onClick={onClose}>
              Болдырмау
            </button>
            <button type="submit" className="btn btn-primary" disabled={submitting}>
              Сақтау
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function LeftoversTab({ materials, showToast }: { materials: Material[]; showToast: (msg: string) => void }) {
  const auth = useAuth();
  const [leftovers, setLeftovers] = useState<LeftoverPiece[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [materialId, setMaterialId] = useState("");
  const [lengthMm, setLengthMm] = useState("");
  const [widthMm, setWidthMm] = useState("");
  const [qty, setQty] = useState("1");
  const [storageLocation, setStorageLocation] = useState("");

  useEffect(() => {
    const q = query(collection(db, "leftoverPieces"), orderBy("createdAt", "desc"));
    const unsub = onSnapshot(q, (snap) => {
      const list: LeftoverPiece[] = [];
      snap.forEach((d) => list.push({ id: d.id, ...(d.data() as Omit<LeftoverPiece, "id">) }));
      setLeftovers(list);
      setLoading(false);
    });
    return unsub;
  }, []);

  const handleAdd = async (e: FormEvent) => {
    e.preventDefault();
    if (!materialId || !auth.user) return;
    const material = materials.find((m) => m.id === materialId);
    try {
      await addDoc(collection(db, "leftoverPieces"), {
        materialId,
        lengthMm: parseInt(lengthMm, 10) || 0,
        widthMm: parseInt(widthMm, 10) || 0,
        thicknessMm: material?.thicknessMm ?? 0,
        qty: parseInt(qty, 10) || 1,
        storageLocation: storageLocation.trim(),
        usable: true,
        createdByUid: auth.user.uid,
        createdAt: serverTimestamp(),
      });
      showToast("✅ Қалдық қосылды");
      setShowForm(false);
      setLengthMm("");
      setWidthMm("");
      setQty("1");
      setStorageLocation("");
    } catch (err: unknown) {
      showToast("Қате: " + (err as Error).message);
    }
  };

  const toggleUsable = async (piece: LeftoverPiece) => {
    await updateDoc(doc(db, "leftoverPieces", piece.id), { usable: !piece.usable });
  };

  return (
    <div className="panel-card">
      <div className="panel-head">
        <h3>Қалдықтар</h3>
        <button className="btn btn-outline btn-sm" onClick={() => setShowForm((v) => !v)}>
          {showForm ? "Жабу" : "+ Қалдық тіркеу"}
        </button>
      </div>
      {showForm && (
        <form onSubmit={handleAdd} className="form-grid" style={{ marginBottom: 16 }}>
          <div className="form-group">
            <label>Материал</label>
            <select className="form-input" value={materialId} onChange={(e) => setMaterialId(e.target.value)} required>
              <option value="">Таңдаңыз</option>
              {materials.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} ({m.color})
                </option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label>Өлшемі (ұзындығы × ені, мм)</label>
            <div style={{ display: "flex", gap: 8 }}>
              <input type="number" className="form-input" value={lengthMm} onChange={(e) => setLengthMm(e.target.value)} required />
              <input type="number" className="form-input" value={widthMm} onChange={(e) => setWidthMm(e.target.value)} required />
            </div>
          </div>
          <div className="form-group">
            <label>Саны</label>
            <input type="number" className="form-input" value={qty} onChange={(e) => setQty(e.target.value)} min={1} />
          </div>
          <div className="form-group">
            <label>Сақтау орны</label>
            <input className="form-input" value={storageLocation} onChange={(e) => setStorageLocation(e.target.value)} />
          </div>
          <button type="submit" className="btn btn-primary btn-full span-2">
            Қосу
          </button>
        </form>
      )}
      {loading ? (
        <Spinner />
      ) : leftovers.length === 0 ? (
        <div className="empty-state">
          <div className="icon">📭</div>
          <p>Қалдық жоқ</p>
        </div>
      ) : (
        <div className="data-table-wrap">
          <table className="data-table stack-mobile stack-compact">
            <thead>
              <tr>
                <th>Материал</th>
                <th>Өлшемі</th>
                <th>Саны</th>
                <th>Орны</th>
                <th>Әрекеттер</th>
              </tr>
            </thead>
            <tbody>
              {leftovers.map((p) => {
                const material = materials.find((m) => m.id === p.materialId);
                return (
                  <tr key={p.id} className={!p.usable ? "blocked" : undefined}>
                    <td data-label="Материал"><strong>{material?.name ?? "?"}</strong></td>
                    <td data-label="Өлшемі">
                      {p.lengthMm}×{p.widthMm} мм · {p.thicknessMm} мм
                    </td>
                    <td data-label="Саны">{p.qty}</td>
                    <td data-label="Орны">{p.storageLocation ? `📍 ${p.storageLocation}` : "—"}</td>
                    <td data-label="Әрекеттер">
                      <button className="btn btn-outline btn-sm" onClick={() => toggleUsable(p)}>
                        {p.usable ? "Жарамсыз деп белгілеу" : "Жарамды деп белгілеу"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
