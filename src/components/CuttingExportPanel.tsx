import { useEffect, useMemo, useState } from "react";
import { useCsvTemplates } from "../hooks/useCsvTemplates";
import { useMaterials, usePvcTypes } from "../hooks/useMaterials";
import {
  buildCuttingCsvFilename,
  buildCuttingCsvRows,
  copyCuttingRowsToClipboard,
  exportCuttingCsv,
  exportXlsx,
  DEFAULT_CSV_EXPORT_SETTINGS,
} from "../lib/exportTable";
import type { CuttingPart, Order } from "../types/domain";

/**
 * "Кесу бағдарламасына экспорт" — the Manager's CSV/Excel/clipboard export for one order.
 *
 * A named template is picked before exporting (see AdminCsvSettings), so a shop with several saws
 * can produce whichever format each one expects. Falls back to the built-in default format when no
 * templates have been configured yet, so export never becomes unavailable.
 */
export function CuttingExportPanel({
  order,
  parts,
  onToast,
}: {
  order: Order;
  parts: CuttingPart[];
  onToast: (msg: string) => void;
}) {
  const { active, defaultTemplate, loading } = useCsvTemplates();
  const { materials } = useMaterials(false);
  const { pvcTypes } = usePvcTypes(false);
  const [templateId, setTemplateId] = useState<string>("");
  const [showPreview, setShowPreview] = useState(false);

  useEffect(() => {
    if (!templateId && defaultTemplate) setTemplateId(defaultTemplate.id);
  }, [defaultTemplate, templateId]);

  const settings = useMemo(
    () => active.find((t) => t.id === templateId) ?? defaultTemplate ?? DEFAULT_CSV_EXPORT_SETTINGS,
    [active, templateId, defaultTemplate],
  );

  const rows = useMemo(
    () => buildCuttingCsvRows(order, parts, materials, pvcTypes, settings),
    [order, parts, materials, pvcTypes, settings],
  );

  const dataRows = settings.includeHeaders ? rows.slice(1) : rows;

  const handleCsv = () => {
    if (parts.length === 0) {
      onToast("Заказда бөлшек жоқ");
      return;
    }
    exportCuttingCsv(buildCuttingCsvFilename(order), rows, settings);
    onToast("✅ CSV жүктелді");
  };

  const handleXlsx = () => {
    if (rows.length === 0) return;
    // exportXlsx takes objects, so rebuild them from the same grid the CSV uses — one source of
    // truth for which columns and values are exported.
    const header = settings.includeHeaders ? rows[0] : rows[0].map((_, i) => `col${i + 1}`);
    const objects = dataRows.map((r) => Object.fromEntries(r.map((cell, i) => [header[i], cell])));
    exportXlsx(buildCuttingCsvFilename(order).replace(/\.csv$/, ""), objects);
    onToast("✅ Excel жүктелді");
  };

  const handleCopy = async () => {
    try {
      await copyCuttingRowsToClipboard(rows);
      onToast("✅ Размерлер көшірілді");
    } catch {
      onToast("Көшіру мүмкін болмады");
    }
  };

  return (
    <section className="panel-card">
      <div className="panel-head">
        <h3>Кесу бағдарламасына экспорт</h3>
        <span className="jt-muted" style={{ fontSize: "0.76rem" }}>
          {parts.length} бөлшек
        </span>
      </div>

      <div className="form-group">
        <label>Шаблон</label>
        {loading ? (
          <p className="jt-muted" style={{ fontSize: "0.8rem", margin: 0 }}>Жүктелуде…</p>
        ) : active.length === 0 ? (
          <p className="jt-muted" style={{ fontSize: "0.8rem", margin: 0 }}>
            Шаблон бапталмаған — стандартты формат қолданылады.
          </p>
        ) : (
          <select className="form-input" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
            {active.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
                {t.isDefault ? " (әдепкі)" : ""}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="wizard-actions">
        <button className="btn btn-primary btn-sm" onClick={handleCsv}>
          ⭳ CSV жүктеу
        </button>
        <button className="btn btn-outline btn-sm" onClick={handleXlsx}>
          ⭳ Excel жүктеу
        </button>
        <button className="btn btn-outline btn-sm" onClick={handleCopy}>
          ⧉ Размерлерді көшіру
        </button>
        <button className="btn btn-outline btn-sm" onClick={() => setShowPreview((v) => !v)}>
          {showPreview ? "Жабу" : "👁 Алдын ала қарау"}
        </button>
      </div>

      {showPreview && (
        <div className="data-table-wrap" style={{ marginTop: 12 }}>
          <table className="data-table">
            {settings.includeHeaders && (
              <thead>
                <tr>
                  {rows[0]?.map((h, i) => (
                    <th key={i}>{h}</th>
                  ))}
                </tr>
              </thead>
            )}
            <tbody>
              {dataRows.slice(0, 20).map((r, i) => (
                <tr key={i}>
                  {r.map((cell, j) => (
                    <td key={j}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {dataRows.length > 20 && (
            <p className="jt-muted" style={{ fontSize: "0.76rem" }}>
              Алғашқы 20 жол көрсетілді (барлығы {dataRows.length})
            </p>
          )}
        </div>
      )}
    </section>
  );
}
