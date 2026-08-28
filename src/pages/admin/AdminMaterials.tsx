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
import { RowMenu } from "../../components/RowMenu";
import { formatMoney, parseMoneyInput } from "../../lib/money";
import { formatDateTimeDMY } from "../../lib/dates";
import { logAudit } from "../../lib/audit";
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
        tab !== "leftovers" ? (
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
        <button className={`tab-pill${tab === "leftovers" ? " active" : ""}`} onClick={() => setTab("leftovers")}>
          Қалдықтар
        </button>
      </div>

      {tab === "materials" && (
        <MaterialsTab
          materials={materials}
          loading={materialsLoading}
          onEdit={setEditingMaterial}
          onLedger={setLedgerFor}
          showToast={showToast}
        />
      )}
      {tab === "pvc" && (
        <PvcTab pvcTypes={pvcTypes} loading={pvcLoading} onEdit={setEditingPvc} showToast={showToast} />
      )}
      {tab === "leftovers" && <LeftoversTab materials={materials} showToast={showToast} />}

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
  onEdit,
  onLedger,
  showToast,
}: {
  materials: Material[];
  loading: boolean;
  onEdit: (m: Material | "new") => void;
  onLedger: (m: Material) => void;
  showToast: (msg: string) => void;
}) {
  const auth = useAuth();

  const handleCorrection = async (material: Material) => {
    const deltaStr = prompt(`"${material.name}" қалдығын түзету (± лист):`);
    if (deltaStr === null) return;
    const delta = parseInt(deltaStr, 10);
    if (!Number.isFinite(delta) || delta === 0) return;
    const reason = prompt("Түзету себебі (міндетті):");
    if (!reason || !reason.trim()) {
      showToast("Себепсіз түзету жасалмайды");
      return;
    }
    if (!auth.user || !auth.userData) return;
    try {
      await recordInventoryMovement(db, { user: auth.user, userData: auth.userData }, {
        materialId: material.id,
        type: "manual_correction",
        qty: delta,
        comment: reason.trim(),
        allowNegative: true,
      });
      await logAudit(db, { user: auth.user, userData: auth.userData }, {
        action: "warehouse.correction",
        entityType: "material",
        entityId: material.id,
        after: { delta, reason: reason.trim() },
      });
      showToast("✅ Қалдық түзетілді");
    } catch (err: unknown) {
      showToast("Қате: " + (err as Error).message);
    }
  };

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
                      <strong>{m.name}</strong>
                      <div className="wh-sub">
                        {m.article || MATERIAL_CATEGORY_LABELS[m.category ?? "ldsp"]}
                      </div>
                    </td>
                    <td data-label="Өлшемі" className="wh-sub">
                      {m.sheetLengthMm}×{m.sheetWidthMm} · {m.thicknessMm} мм
                    </td>
                    <td data-label="Қоймада">
                      <div className="wh-qty">
                        <strong>{stock.available}</strong> <span className="wh-sub">лист</span>
                      </div>
                      {/* Bar repeats the Күйі pill in a form you can scan down a column. */}
                      <div className="wh-bar">
                        <span className={`wh-bar-fill is-${stock.level}`} style={{ width: `${stock.ratio * 100}%` }} />
                      </div>
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
                      <RowMenu
                        items={[
                          { label: "Тарих", onClick: () => onLedger(m) },
                          { label: "Түзету", onClick: () => handleCorrection(m) },
                          { label: "Өзгерту", onClick: () => onEdit(m) },
                        ]}
                      >
                        <button className="btn btn-outline btn-sm" onClick={() => handleReceipt(m)}>
                          + Қабылдау
                        </button>
                      </RowMenu>
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
  onEdit,
  showToast,
}: {
  pvcTypes: PvcType[];
  loading: boolean;
  onEdit: (p: PvcType | "new") => void;
  showToast: (msg: string) => void;
}) {
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
                <th className="num">Бағасы</th>
                <th>Әрекеттер</th>
              </tr>
            </thead>
            <tbody>
              {pvcTypes.map((p) => (
                <tr key={p.id} className={!p.active ? "blocked" : undefined}>
                  <td data-label="Түсі / Қалыңдығы">
                    <strong>
                      {p.colorName} · {p.thicknessMm} мм
                    </strong>
                  </td>
                  <td className="num" data-label="Бағасы">
                    {formatMoney(p.pricePerMeterTiyn)} / метр
                  </td>
                  <td data-label="Әрекеттер">
                    <div className="data-row-actions">
                      <button className="btn btn-outline btn-sm" onClick={() => onEdit(p)}>
                        Өзгерту
                      </button>
                      <button className="btn btn-outline btn-sm" onClick={() => handleToggleActive(p)}>
                        {p.active ? "Архивке" : "Белсендіру"}
                      </button>
                    </div>
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
