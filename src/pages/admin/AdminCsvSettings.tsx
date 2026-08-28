import { useEffect, useMemo, useState } from "react";
import { collection, limit, onSnapshot, orderBy, query } from "firebase/firestore";
import { db } from "../../firebase";
import { useAuth } from "../../AuthContext";
import { Spinner, Toast } from "../../components";
import { AppShell } from "../../components/layout/AppShell";
import { useToast } from "../../hooks";
import { useMaterials, usePvcTypes } from "../../hooks/useMaterials";
import { useCsvTemplates } from "../../hooks/useCsvTemplates";
import {
  archiveCsvTemplate,
  createCsvTemplate,
  deleteCsvTemplate,
  duplicateCsvTemplate,
  newTemplateDraft,
  setDefaultCsvTemplate,
  SUGGESTED_TEMPLATE_NAMES,
  updateCsvTemplate,
} from "../../lib/csvTemplates";
import {
  buildCuttingCsvRows,
  csvColumnLabel,
  CSV_COLUMN_LABELS,
  CSV_UNIT_LABELS,
  DEFAULT_CSV_COLUMNS,
  effectiveColumns,
} from "../../lib/exportTable";
import type {
  CsvColumnKey,
  CsvTemplate,
  CsvUnit,
  CuttingPart,
  Material,
  Order,
  PvcType,
} from "../../types/domain";

/** Stand-in data so the preview works on a brand-new install with no orders yet. Never written. */
const PLACEHOLDER_MATERIAL: Material = {
  id: "placeholder-material",
  name: "ЛДСП Egger",
  article: "H1180 ST10",
  color: "Ақ",
  manufacturer: "Egger",
  thicknessMm: 16,
  sheetLengthMm: 2800,
  sheetWidthMm: 2070,
  sellingPriceTiyn: 0,
  initialQty: 0,
  qtyOnHand: 0,
  reservedQty: 0,
  minStock: 0,
  active: true,
  archived: false,
  grainDirectionRequired: false,
};

const PLACEHOLDER_PVC: PvcType = {
  id: "placeholder-pvc",
  thicknessMm: 2,
  colorName: "Ақ",
  pricePerMeterTiyn: 0,
  active: true,
};

const PLACEHOLDER_ORDER = {
  id: "placeholder-order",
  orderNumber: "ORD-2026-000123",
  customerName: "Алмат",
  materialId: PLACEHOLDER_MATERIAL.id,
  materialSnapshot: { name: PLACEHOLDER_MATERIAL.name, thicknessMm: 16 },
} as unknown as Order;

const PLACEHOLDER_PARTS: CuttingPart[] = [
  {
    id: "pp1",
    name: "Есік панелі",
    lengthMm: 720,
    widthMm: 450,
    qty: 2,
    grainDirection: "vertical",
    rotationAllowed: false,
    edges: {
      A: { pvc: true, pvcTypeId: PLACEHOLDER_PVC.id },
      B: { pvc: false },
      C: { pvc: true, pvcTypeId: PLACEHOLDER_PVC.id },
      D: { pvc: false },
    },
  },
  {
    id: "pp2",
    name: "Бүйір қабырға",
    lengthMm: 1200,
    widthMm: 320,
    qty: 4,
    grainDirection: "any",
    rotationAllowed: true,
    note: "Сынық жоқ",
    edges: { A: { pvc: false }, B: { pvc: true, pvcTypeId: PLACEHOLDER_PVC.id }, C: { pvc: false }, D: { pvc: false } },
  },
];

/** Most recent real order + parts, so the preview reflects genuine data when it exists. */
function useSampleOrder() {
  const [order, setOrder] = useState<Order | null | undefined>(undefined);
  const [parts, setParts] = useState<CuttingPart[]>([]);

  useEffect(() => {
    const q = query(collection(db, "orders"), orderBy("createdAt", "desc"), limit(1));
    return onSnapshot(
      q,
      (snap) => {
        const d = snap.docs[0];
        const data = d?.data();
        const current = !!data && typeof data.orderNumber === "string" && typeof data.productionStatus === "string";
        setOrder(current && d ? ({ id: d.id, ...(data as Omit<Order, "id">) }) : null);
      },
      () => setOrder(null),
    );
  }, []);

  useEffect(() => {
    if (!order) return;
    return onSnapshot(collection(db, "orders", order.id, "parts"), (snap) => {
      setParts(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<CuttingPart, "id">) })));
    });
  }, [order]);

  return { order, parts };
}

/** Named cutting-program export templates: create, edit, duplicate, set default, archive, delete. */
export default function AdminCsvSettings() {
  const { user, userData } = useAuth();
  const { message, visible, showToast } = useToast();
  const { templates, loading } = useCsvTemplates();
  const { materials } = useMaterials(false);
  const { pvcTypes } = usePvcTypes(false);
  const sample = useSampleOrder();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<CsvTemplate | null>(null);
  const [busy, setBusy] = useState(false);
  // The editor lists every column (included or not) in a stable order; the template itself stores
  // only the included ones. This cache keeps unchecked columns in position while reordering.
  const [columnOrderCache, setColumnOrderCache] = useState<CsvColumnKey[] | null>(null);

  // Select the default template once loaded, so the page always opens on something useful.
  useEffect(() => {
    if (selectedId || templates.length === 0) return;
    setSelectedId((templates.find((t) => t.isDefault) ?? templates[0]).id);
  }, [templates, selectedId]);

  const selected = templates.find((t) => t.id === selectedId);
  useEffect(() => {
    setDraft(selected ? { ...selected, columnLabels: { ...(selected.columnLabels ?? {}) } } : null);
  }, [selected]);

  const previewOrder = sample.order ?? PLACEHOLDER_ORDER;
  const previewParts = sample.order && sample.parts.length > 0 ? sample.parts : PLACEHOLDER_PARTS;
  const previewMaterials = useMemo(
    () => (materials.length > 0 ? materials : [PLACEHOLDER_MATERIAL]),
    [materials],
  );
  const previewPvc = useMemo(() => (pvcTypes.length > 0 ? pvcTypes : [PLACEHOLDER_PVC]), [pvcTypes]);

  const previewRows = useMemo(
    () => (draft ? buildCuttingCsvRows(previewOrder, previewParts, previewMaterials, previewPvc, draft) : []),
    [draft, previewOrder, previewParts, previewMaterials, previewPvc],
  );

  if (!user || !userData) return <Spinner />;
  const actor = { user, userData };

  const run = async (fn: () => Promise<unknown>, okMessage: string) => {
    setBusy(true);
    try {
      await fn();
      showToast(okMessage);
    } catch (err: unknown) {
      showToast("Қате: " + (err as Error).message);
    }
    setBusy(false);
  };

  const handleCreate = async () => {
    const suggestion = SUGGESTED_TEMPLATE_NAMES.find((n) => !templates.some((t) => t.name === n)) ?? "Жаңа шаблон";
    const name = prompt("Шаблон атауы:", suggestion);
    if (!name || !name.trim()) return;
    await run(async () => {
      const base = newTemplateDraft(name.trim());
      // The first template a shop creates becomes the default automatically — otherwise exports
      // would have no format to fall back on.
      const id = await createCsvTemplate(db, actor, { ...base, isDefault: templates.length === 0 });
      setSelectedId(id);
    }, "✅ Шаблон құрылды");
  };

  const patch = (p: Partial<CsvTemplate>) => draft && setDraft({ ...draft, ...p });

  const moveColumn = (index: number, dir: -1 | 1) => {
    if (!draft) return;
    const all = fullColumnOrder(draft.columns);
    const target = index + dir;
    if (target < 0 || target >= all.length) return;
    const next = [...all];
    [next[index], next[target]] = [next[target], next[index]];
    patch({ columns: next.filter((c) => draft.columns.includes(c)) });
    setColumnOrderCache(next);
  };

  const fullColumnOrder = (included: CsvColumnKey[]): CsvColumnKey[] => {
    const base = columnOrderCache ?? [...included, ...DEFAULT_CSV_COLUMNS.filter((c) => !included.includes(c))];
    return [...base.filter((c) => DEFAULT_CSV_COLUMNS.includes(c)), ...DEFAULT_CSV_COLUMNS.filter((c) => !base.includes(c))];
  };

  const toggleColumn = (col: CsvColumnKey) => {
    if (!draft) return;
    const order = fullColumnOrder(draft.columns);
    const included = new Set(draft.columns);
    if (included.has(col)) included.delete(col);
    else included.add(col);
    patch({ columns: order.filter((c) => included.has(c)) });
  };

  const handleSave = () => {
    if (!draft) return;
    if (draft.columns.length === 0) {
      showToast("Кемінде бір баған таңдалуы керек");
      return;
    }
    if (!draft.name.trim()) {
      showToast("Шаблон атауын енгізіңіз");
      return;
    }
    const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = draft;
    void _id;
    void _c;
    void _u;
    run(() => updateCsvTemplate(db, actor, draft.id, rest), "✅ Сақталды");
  };

  return (
    <AppShell title="CSV шаблондары" subtitle="Кесу бағдарламасына арналған экспорт форматтары">
      <div className="csv-layout">
        <aside className="panel-card csv-template-list">
          <div className="panel-head">
            <h3>Шаблондар</h3>
            <button className="btn btn-primary btn-sm" disabled={busy} onClick={handleCreate}>
              ＋ Жаңа
            </button>
          </div>

          {loading ? (
            <Spinner />
          ) : templates.length === 0 ? (
            <p className="jt-muted" style={{ fontSize: "0.82rem" }}>
              Әлі шаблон жоқ. «Жаңа» батырмасын басыңыз.
            </p>
          ) : (
            templates.map((t) => (
              <button
                key={t.id}
                className={`csv-template-row${t.id === selectedId ? " is-active" : ""}${t.archived ? " is-archived" : ""}`}
                onClick={() => setSelectedId(t.id)}
              >
                <span className="csv-template-name">{t.name}</span>
                <span className="csv-template-tags">
                  {t.isDefault && <span className="jt-pill jt-tone-green">Әдепкі</span>}
                  {t.archived && <span className="jt-pill jt-tone-muted">Мұрағат</span>}
                </span>
              </button>
            ))
          )}
        </aside>

        <div className="csv-editor">
          {!draft ? (
            <div className="empty-state">
              <div className="icon">📄</div>
              <p>Шаблон таңдаңыз немесе жаңасын құрыңыз</p>
            </div>
          ) : (
            <>
              <section className="panel-card">
                <div className="panel-head">
                  <h3>Шаблон параметрлері</h3>
                </div>

                <div className="form-group">
                  <label>Атауы</label>
                  <input className="form-input" value={draft.name} onChange={(e) => patch({ name: e.target.value })} />
                </div>

                <div className="form-grid">
                  <div className="form-group">
                    <label>Бөлгіш</label>
                    <select
                      className="form-input"
                      value={draft.delimiter}
                      onChange={(e) => patch({ delimiter: e.target.value as CsvTemplate["delimiter"] })}
                    >
                      <option value=",">Үтір ( , )</option>
                      <option value=";">Нүктелі үтір ( ; )</option>
                    </select>
                  </div>
                  <div className="form-group">
                    <label>Кодтау</label>
                    <select
                      className="form-input"
                      value={draft.encoding}
                      onChange={(e) => patch({ encoding: e.target.value as CsvTemplate["encoding"] })}
                    >
                      <option value="utf8-bom">UTF-8 (BOM) — әдепкі</option>
                      <option value="utf8">UTF-8 (BOM жоқ)</option>
                      <option value="windows-1251">Windows-1251</option>
                    </select>
                  </div>
                  <div className="form-group">
                    <label>Өлшем бірлігі</label>
                    <select
                      className="form-input"
                      value={draft.unit ?? "mm"}
                      onChange={(e) => patch({ unit: e.target.value as CsvUnit })}
                    >
                      {(["mm", "cm", "m"] as CsvUnit[]).map((u) => (
                        <option key={u} value={u}>
                          {CSV_UNIT_LABELS[u]}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="form-group">
                    <label>Ұзындық / ен реті</label>
                    <select
                      className="form-input"
                      value={draft.dimensionOrder ?? "length_first"}
                      onChange={(e) => patch({ dimensionOrder: e.target.value as CsvTemplate["dimensionOrder"] })}
                    >
                      <option value="length_first">Ұзындық → Ен</option>
                      <option value="width_first">Ен → Ұзындық</option>
                    </select>
                  </div>
                  <div className="form-group">
                    <label>ПВХ бағандары</label>
                    <select
                      className="form-input"
                      value={draft.pvcMapping ?? "per_edge"}
                      onChange={(e) => patch({ pvcMapping: e.target.value as CsvTemplate["pvcMapping"] })}
                    >
                      <option value="per_edge">Әр жиек бөлек (A/B/C/D)</option>
                      <option value="combined">Біріктірілген («A,B,D»)</option>
                    </select>
                  </div>
                  <label className="remember-me span-2">
                    <input
                      type="checkbox"
                      checked={draft.includeHeaders}
                      onChange={(e) => patch({ includeHeaders: e.target.checked })}
                    />
                    <span className="remember-check">{draft.includeHeaders ? "✓" : ""}</span>
                    <span>Тақырып жолын қосу</span>
                  </label>
                </div>

                <div className="wizard-actions">
                  <button className="btn btn-primary btn-sm" disabled={busy} onClick={handleSave}>
                    Сақтау
                  </button>
                  <button
                    className="btn btn-outline btn-sm"
                    disabled={busy || draft.isDefault}
                    onClick={() => run(() => setDefaultCsvTemplate(db, actor, draft.id), "✅ Әдепкі шаблон өзгерді")}
                  >
                    ★ Әдепкі ету
                  </button>
                  <button
                    className="btn btn-outline btn-sm"
                    disabled={busy}
                    onClick={() =>
                      run(async () => {
                        const id = await duplicateCsvTemplate(db, actor, draft);
                        setSelectedId(id);
                      }, "✅ Көшірме жасалды")
                    }
                  >
                    ⧉ Көшіру
                  </button>
                  <button
                    className="btn btn-outline btn-sm"
                    disabled={busy}
                    onClick={() =>
                      run(
                        () => archiveCsvTemplate(db, actor, draft),
                        draft.archived ? "✅ Мұрағаттан шығарылды" : "✅ Мұрағатталды",
                      )
                    }
                  >
                    {draft.archived ? "↩ Қайтару" : "🗃 Мұрағаттау"}
                  </button>
                  <button
                    className="btn btn-danger-outline btn-sm"
                    disabled={busy}
                    onClick={() => {
                      if (!confirm(`«${draft.name}» шаблонын өшіресіз бе?`)) return;
                      run(async () => {
                        await deleteCsvTemplate(db, actor, draft);
                        setSelectedId(null);
                      }, "✅ Өшірілді");
                    }}
                  >
                    🗑 Өшіру
                  </button>
                </div>
              </section>

              <section className="panel-card">
                <div className="panel-head">
                  <h3>Бағандар мен атаулары</h3>
                  <span className="jt-muted" style={{ fontSize: "0.76rem" }}>
                    {draft.columns.length} баған қосылған
                  </span>
                </div>
                <div className="data-list">
                  {fullColumnOrder(draft.columns).map((col, index) => {
                    const included = draft.columns.includes(col);
                    return (
                      <div key={col} className={`data-row csv-col-row${included ? "" : " is-off"}`}>
                        <label className="remember-me csv-col-check">
                          <input type="checkbox" checked={included} onChange={() => toggleColumn(col)} />
                          <span className="remember-check">{included ? "✓" : ""}</span>
                          <span>{CSV_COLUMN_LABELS[col]}</span>
                        </label>
                        <input
                          className="form-input csv-col-label"
                          placeholder={CSV_COLUMN_LABELS[col]}
                          value={draft.columnLabels?.[col] ?? ""}
                          onChange={(e) =>
                            patch({ columnLabels: { ...(draft.columnLabels ?? {}), [col]: e.target.value } })
                          }
                        />
                        <div className="data-row-actions">
                          <button className="btn btn-outline btn-sm" disabled={index === 0} onClick={() => moveColumn(index, -1)}>
                            ↑
                          </button>
                          <button
                            className="btn btn-outline btn-sm"
                            disabled={index === DEFAULT_CSV_COLUMNS.length - 1}
                            onClick={() => moveColumn(index, 1)}
                          >
                            ↓
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>

              <section className="panel-card">
                <div className="panel-head">
                  <h3>Алдын ала қарау</h3>
                  <span className="jt-muted" style={{ fontSize: "0.76rem" }}>
                    {sample.order ? `Заказ ${sample.order.orderNumber}` : "Мысал деректер"}
                  </span>
                </div>
                <div className="data-table-wrap">
                  <table className="data-table stack-mobile stack-compact">
                    {draft.includeHeaders && (
                      <thead>
                        <tr>
                          {effectiveColumns(draft).map((col, i) => (
                            <th key={`${col}-${i}`}>{previewRows[0]?.[i] ?? csvColumnLabel(col, draft)}</th>
                          ))}
                        </tr>
                      </thead>
                    )}
                    <tbody>
                      {(draft.includeHeaders ? previewRows.slice(1) : previewRows).map((row, i) => (
                        <tr key={i}>
                          {row.map((cell, j) => (
                            <td key={j}>{cell}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </>
          )}
        </div>
      </div>

      <Toast message={message} visible={visible} />
    </AppShell>
  );
}
