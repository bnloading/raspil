import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EDGE_KEYS } from "../types/domain";
import type { CuttingPart, EdgeKey, PvcType } from "../types/domain";
import {
  BULK_EDGE_LABELS,
  applyEdgeModeToSelection,
  applyPvcFilter,
  applyPvcTypeToSelection,
  copyEdgesFromPreviousRow,
  deleteSelection,
  duplicateSelection,
  filterParts,
  markedPartCount,
  toggleEdge,
  type BulkEdgeMode,
  type PvcFilter,
} from "../lib/pvcBulk";
import { totalPvcMeters } from "../lib/pricing";
import { NumberField } from "./NumberField";

/**
 * Fixed row heights (px) the virtualizer assumes — these must match `.bulk-row`'s height in
 * index.css, including its `max-width: 767px` override.
 *
 * A phone cannot fit three number inputs and four edge buttons on one 56px line: the inputs get
 * squeezed by the flex layout until a 3–4 digit size is cut off mid-number. On narrow screens the
 * edge buttons wrap onto a second line and the row is correspondingly taller.
 */
const ROW_H_WIDE = 56;
const ROW_H_NARROW = 88;
const NARROW_QUERY = "(max-width: 767px)";
/** Rows rendered above/below the viewport so fast scrolling doesn't show blank space. */
const OVERSCAN = 6;
/** Below this many rows, windowing costs more than it saves — render them all. */
const VIRTUALIZE_ABOVE = 40;

const BULK_MODES: BulkEdgeMode[] = ["all", "long", "short", "none"];

interface BulkPartsEditorProps {
  parts: CuttingPart[];
  onChange: (next: CuttingPart[]) => void;
  pvcTypes: PvcType[];
  onAddPart: () => void;
  onOpenScanner?: () => void;
  onToast: (msg: string) => void;
  /** Shown under the header; lets the host surface sheet-fitting errors etc. */
  warning?: string;
}

/**
 * The dimensions + bulk-PVC editor ("Размерлер" / "ПВХ жаппай белгілеу").
 *
 * Built for 100–200 parts: rows are windowed, every mutation is a bulk operation over the current
 * selection, and nothing requires editing parts one at a time. Renders as compact app-like rows on
 * phones and the same rows (wider) on desktop — deliberately not a 12-column table squeezed onto a
 * phone. All edge logic lives in lib/pvcBulk.ts so it stays pure and testable.
 */
export function BulkPartsEditor({
  parts,
  onChange,
  pvcTypes,
  onAddPart,
  onOpenScanner,
  onToast,
  warning,
}: BulkPartsEditorProps) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [search, setSearch] = useState("");
  const [pvcFilter, setPvcFilter] = useState<PvcFilter>("all");
  const [showFilters, setShowFilters] = useState(false);
  const [bulkTypeId, setBulkTypeId] = useState("");
  /** Part currently open in the editor sheet, or null. */
  const [editingId, setEditingId] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(480);

  const visible = useMemo(
    () => applyPvcFilter(filterParts(parts, search), pvcFilter),
    [parts, search, pvcFilter],
  );

  // Selection is keyed by id, so it survives filtering — but a part deleted elsewhere must not
  // linger in it and silently take part in the next bulk action.
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const alive = new Set(parts.map((p) => p.id));
      const next = new Set([...prev].filter((id) => alive.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [parts]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setViewportH(el.clientHeight || 480);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Row height follows the same breakpoint the stylesheet uses, and is re-read on resize/rotation
  // so the virtualizer never positions rows by a height the CSS is no longer applying.
  const [rowH, setRowH] = useState(() =>
    typeof matchMedia === "function" && matchMedia(NARROW_QUERY).matches ? ROW_H_NARROW : ROW_H_WIDE,
  );
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const mq = matchMedia(NARROW_QUERY);
    const sync = () => setRowH(mq.matches ? ROW_H_NARROW : ROW_H_WIDE);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  const virtualize = visible.length > VIRTUALIZE_ABOVE;
  const startIndex = virtualize ? Math.max(0, Math.floor(scrollTop / rowH) - OVERSCAN) : 0;
  const endIndex = virtualize
    ? Math.min(visible.length, Math.ceil((scrollTop + viewportH) / rowH) + OVERSCAN)
    : visible.length;
  const windowed = visible.slice(startIndex, endIndex);

  const marked = markedPartCount(parts);
  const metres = useMemo(() => totalPvcMeters(parts), [parts]);
  const allVisibleSelected = visible.length > 0 && visible.every((p) => selected.has(p.id));

  const toggleRow = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleSelectAll = () => {
    // "Барлығын таңдау" acts on what is currently visible, so it composes with search/filter
    // rather than silently reaching parts the user can't see.
    setSelected(allVisibleSelected ? new Set() : new Set(visible.map((p) => p.id)));
  };

  const requireSelection = (): boolean => {
    if (selected.size === 0) {
      onToast("Алдымен бөлшектерді таңдаңыз");
      return false;
    }
    return true;
  };

  const runBulkMode = (mode: BulkEdgeMode) => {
    if (!requireSelection()) return;
    onChange(applyEdgeModeToSelection(parts, selected, mode, bulkTypeId || undefined));
    onToast(`✅ ${selected.size} бөлшек: ${BULK_EDGE_LABELS[mode]}`);
  };

  const applyPvcType = () => {
    if (!requireSelection()) return;
    if (!bulkTypeId) {
      onToast("ПВХ түрін таңдаңыз");
      return;
    }
    onChange(applyPvcTypeToSelection(parts, selected, bulkTypeId));
    onToast(`✅ ${selected.size} бөлшекке ПВХ түрі қолданылды`);
  };

  const copyPrevious = () => {
    if (!requireSelection()) return;
    onChange(copyEdgesFromPreviousRow(parts, selected));
    onToast("✅ Алдыңғы қатардан көшірілді");
  };

  const duplicateRows = () => {
    if (!requireSelection()) return;
    onChange(duplicateSelection(parts, selected));
    onToast(`✅ ${selected.size} бөлшек қайталанды`);
  };

  const deleteRows = () => {
    if (!requireSelection()) return;
    if (!confirm(`${selected.size} бөлшекті өшіресіз бе?`)) return;
    onChange(deleteSelection(parts, selected));
    setSelected(new Set());
    onToast("✅ Өшірілді");
  };

  const patchPart = (id: string, patch: Partial<CuttingPart>) =>
    onChange(parts.map((p) => (p.id === id ? { ...p, ...patch } : p)));

  const pvcTypeLabel = (id: string | undefined) => {
    const t = pvcTypes.find((x) => x.id === id);
    return t ? `${t.colorName} ${t.thicknessMm} мм` : null;
  };

  const editingPart = editingId ? parts.find((p) => p.id === editingId) : undefined;

  return (
    <div className="bulk-editor">
      <div className="bulk-header">
        <div className="bulk-progress-row">
          <strong>{parts.length} бөлшек</strong>
          <span className="bulk-progress-label">
            ПВХ белгіленді: {marked} / {parts.length}
          </span>
        </div>
        <div className="bulk-progress-bar">
          <div
            className="bulk-progress-fill"
            style={{ width: parts.length ? `${(marked / parts.length) * 100}%` : "0%" }}
          />
        </div>
        <div className="bulk-metres">Жалпы ПВХ: {metres.toFixed(2)} м</div>
        {warning && <div className="bulk-warning">{warning}</div>}
      </div>

      <div className="bulk-search-row">
        <input
          className="bulk-search"
          placeholder="Іздеу (атауы немесе 720×450)"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button
          className={`bulk-filter-btn${pvcFilter !== "all" ? " is-on" : ""}`}
          onClick={() => setShowFilters((v) => !v)}
          aria-label="Сүзгі"
        >
          ⚙
        </button>
      </div>

      {showFilters && (
        <div className="bulk-filter-chips">
          {(["all", "marked", "unmarked"] as PvcFilter[]).map((f) => (
            <button
              key={f}
              className={`bulk-chip${pvcFilter === f ? " is-on" : ""}`}
              onClick={() => setPvcFilter(f)}
            >
              {f === "all" ? "Барлығы" : f === "marked" ? "ПВХ бар" : "ПВХ жоқ"}
            </button>
          ))}
        </div>
      )}

      <div className="bulk-select-bar">
        <label className="bulk-selectall">
          <input type="checkbox" checked={allVisibleSelected} onChange={toggleSelectAll} />
          <span>{selected.size > 0 ? `${selected.size} таңдалды` : "Барлығын таңдау"}</span>
        </label>
        <div className="bulk-select-actions">
          <button className="bulk-mini-btn" onClick={duplicateRows} title="Қайталау">⧉ Қайталау</button>
          <button className="bulk-mini-btn is-danger" onClick={deleteRows} title="Өшіру">🗑 Өшіру</button>
        </div>
      </div>

      <div
        className="bulk-rows"
        ref={scrollRef}
        onScroll={(e) => virtualize && setScrollTop(e.currentTarget.scrollTop)}
      >
        {visible.length === 0 ? (
          <div className="bulk-empty">Бөлшек табылмады</div>
        ) : (
          <div style={virtualize ? { height: visible.length * rowH, position: "relative" } : undefined}>
            <div
              style={
                virtualize
                  ? { position: "absolute", top: startIndex * rowH, left: 0, right: 0 }
                  : undefined
              }
            >
              {windowed.map((part, i) => {
                const absoluteIndex = startIndex + i;
                const isSelected = selected.has(part.id);
                return (
                  <div key={part.id} className={`bulk-row${isSelected ? " is-selected" : ""}`}>
                    <label className="bulk-row-check">
                      <input type="checkbox" checked={isSelected} onChange={() => toggleRow(part.id)} />
                    </label>
                    <span className="bulk-row-index">{absoluteIndex + 1}</span>

                    {/* Dimensions are typed straight into the row — no modal for a number. The
                        inputs are sized to keep the row exactly ROW_H tall, which the virtualizer
                        depends on; only the extra fields (name, grain, note) open the sheet. */}
                    <div className="bulk-row-dims">
                      <NumberField
                        className="bulk-num"
                        value={part.lengthMm}
                        onChange={(v) => patchPart(part.id, { lengthMm: v })}
                        min={0}
                        placeholder="ұзын"
                        ariaLabel="Ұзындығы, мм"
                      />
                      <span className="bulk-x">×</span>
                      <NumberField
                        className="bulk-num"
                        value={part.widthMm}
                        onChange={(v) => patchPart(part.id, { widthMm: v })}
                        min={0}
                        placeholder="ен"
                        ariaLabel="Ені, мм"
                      />
                      <NumberField
                        className="bulk-num bulk-num-qty"
                        value={part.qty}
                        onChange={(v) => patchPart(part.id, { qty: v })}
                        min={1}
                        emptyValue={1}
                        ariaLabel="Саны"
                      />
                    </div>

                    <div className="bulk-edges">
                      {EDGE_KEYS.map((edge: EdgeKey) => (
                        <button
                          key={edge}
                          className={`bulk-edge${part.edges[edge]?.pvc ? " is-on" : ""}`}
                          onClick={() => onChange(toggleEdge(parts, part.id, edge, bulkTypeId || undefined))}
                          title={`${edge} жиегі`}
                        >
                          {edge}
                        </button>
                      ))}
                    </div>

                    <button
                      className="bulk-row-more"
                      onClick={() => setEditingId(part.id)}
                      title="Атауы, талшық, ескертпе"
                      aria-label="Қосымша өрістер"
                    >
                      ⋯
                    </button>

                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <div className="bulk-add-row">
        <button className="btn btn-primary btn-full" onClick={onAddPart}>
          ＋ Размер қосу
        </button>
        {onOpenScanner && (
          <button className="btn btn-outline btn-full" onClick={onOpenScanner}>
            📷 Фото арқылы енгізу
          </button>
        )}
      </div>

      {/* Bulk panel — the "ПВХ жаппай белгілеу" sheet from the reference. */}
      <div className={`bulk-panel${selected.size > 0 ? " is-active" : ""}`}>
        <div className="bulk-panel-head">
          <strong>{selected.size > 0 ? `${selected.size} бөлшек таңдалды` : "Жаппай ПВХ белгілеу"}</strong>
          {selected.size > 0 && (
            <button className="link-button" onClick={() => setSelected(new Set())}>
              Таңдауды алу
            </button>
          )}
        </div>

        <div className="bulk-mode-grid">
          {BULK_MODES.map((mode) => (
            <button key={mode} className="bulk-mode-btn" onClick={() => runBulkMode(mode)}>
              {BULK_EDGE_LABELS[mode]}
            </button>
          ))}
        </div>

        <div className="bulk-panel-selects">
          <select className="form-input" value={bulkTypeId} onChange={(e) => setBulkTypeId(e.target.value)}>
            <option value="">ПВХ түрін таңдаңыз</option>
            {pvcTypes.map((t) => (
              <option key={t.id} value={t.id}>
                {t.colorName} · {t.thicknessMm} мм
              </option>
            ))}
          </select>
          <button className="btn btn-outline btn-sm" onClick={applyPvcType}>
            Түрді қолдану
          </button>
        </div>

        <button className="btn btn-primary btn-full" onClick={() => runBulkMode("all")}>
          {selected.size > 0 ? `${selected.size} бөлшекке қолдану` : "Таңдалған бөлшектерге қолдану"}
        </button>
        <button className="link-button bulk-copy-prev" onClick={copyPrevious}>
          ⧉ Алдыңғы қатардан көшіру
        </button>
      </div>

      {editingPart && (
        <PartEditorSheet
          part={editingPart}
          index={parts.findIndex((p) => p.id === editingPart.id)}
          pvcTypes={pvcTypes}
          pvcTypeLabel={pvcTypeLabel}
          onPatch={(patch) => patchPart(editingPart.id, patch)}
          onClose={() => setEditingId(null)}
        />
      )}
    </div>
  );
}

/**
 * Full-screen editor for one part, opened from a row. Kept out of the list itself so every row
 * stays exactly ROW_H tall — the virtualizer positions rows by index × ROW_H, so a row that grew
 * when expanded used to overlap the rows beneath it.
 */
function PartEditorSheet({
  part,
  index,
  pvcTypes,
  pvcTypeLabel,
  onPatch,
  onClose,
}: {
  part: CuttingPart;
  index: number;
  pvcTypes: PvcType[];
  pvcTypeLabel: (id: string | undefined) => string | null;
  onPatch: (patch: Partial<CuttingPart>) => void;
  onClose: () => void;
}) {
  const currentPvc = pvcTypeLabel(EDGE_KEYS.map((e) => part.edges[e]?.pvcTypeId).find(Boolean));

  return (
    <div className="part-sheet-backdrop" onClick={onClose}>
      <div className="part-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="part-sheet-head">
          <strong>Бөлшек {index + 1}</strong>
          <button className="part-sheet-close" onClick={onClose} aria-label="Жабу">
            ✕
          </button>
        </div>

        <div className="form-group">
          <label>Атауы</label>
          <input
            className="form-input"
            autoFocus
            placeholder={`Бөлшек ${index + 1}`}
            value={part.name}
            onChange={(e) => onPatch({ name: e.target.value })}
          />
        </div>

        <div className="part-sheet-grid">
          <div className="form-group">
            <label>Ұзындығы (мм)</label>
            <input
              type="number"
              inputMode="numeric"
              className="form-input"
              value={part.lengthMm || ""}
              onChange={(e) => onPatch({ lengthMm: Number(e.target.value) || 0 })}
            />
          </div>
          <div className="form-group">
            <label>Ені (мм)</label>
            <input
              type="number"
              inputMode="numeric"
              className="form-input"
              value={part.widthMm || ""}
              onChange={(e) => onPatch({ widthMm: Number(e.target.value) || 0 })}
            />
          </div>
          <div className="form-group">
            <label>Саны</label>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              className="form-input"
              value={part.qty || ""}
              onChange={(e) => onPatch({ qty: Number(e.target.value) || 1 })}
            />
          </div>
          <div className="form-group">
            <label>Талшық бағыты</label>
            <select
              className="form-input"
              value={part.grainDirection}
              onChange={(e) => onPatch({ grainDirection: e.target.value as CuttingPart["grainDirection"] })}
            >
              <option value="any">Маңызды емес</option>
              <option value="vertical">Тік</option>
              <option value="horizontal">Көлденең</option>
            </select>
          </div>
        </div>

        <label className="remember-me">
          <input
            type="checkbox"
            checked={part.rotationAllowed}
            onChange={(e) => onPatch({ rotationAllowed: e.target.checked })}
          />
          <span className="remember-check">{part.rotationAllowed ? "✓" : ""}</span>
          <span>Айналдыруға болады</span>
        </label>

        <div className="form-group">
          <label>Ескертпе</label>
          <input
            className="form-input"
            value={part.note ?? ""}
            onChange={(e) => onPatch({ note: e.target.value })}
          />
        </div>

        {pvcTypes.length > 0 && (
          <div className="part-sheet-pvc">
            <span className="worker-field-label">ПВХ жиектері</span>
            <div className="bulk-edges">
              {EDGE_KEYS.map((edge) => (
                <button
                  key={edge}
                  className={`bulk-edge${part.edges[edge]?.pvc ? " is-on" : ""}`}
                  onClick={() =>
                    onPatch({
                      edges: {
                        ...part.edges,
                        [edge]: part.edges[edge]?.pvc
                          ? { pvc: false, note: part.edges[edge]?.note }
                          : { pvc: true, pvcTypeId: part.edges[edge]?.pvcTypeId, note: part.edges[edge]?.note },
                      },
                    })
                  }
                >
                  {edge}
                </button>
              ))}
            </div>
            {currentPvc && <div className="bulk-row-pvctype">{currentPvc}</div>}
          </div>
        )}

        <button className="btn btn-primary btn-full" onClick={onClose}>
          Дайын
        </button>
      </div>
    </div>
  );
}
