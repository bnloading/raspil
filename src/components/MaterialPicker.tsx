import { useEffect, useMemo, useRef, useState } from "react";
import { MATERIAL_CATEGORY_LABELS, type Material, type MaterialCategory } from "../types/domain";

/** Boards first, then the things sold alongside them — the order the counter actually works in. */
const GROUP_ORDER: MaterialCategory[] = ["ldsp", "countertop", "hdf", "mdf", "other"];

/**
 * Picks a board for a journal line.
 *
 * A single flat `<select>` of every material was the wrong control the moment the catalogue passed
 * a dozen rows: ЛДСП, столешница, ХДФ, МДФ and the offcuts all ran together in one scrolling list,
 * so finding "Сырттан келетін ХДФ" meant reading past fifteen boards that were not it. This opens
 * a full sheet instead, grouped by what the thing actually is, with a search box for the times you
 * already know the name and the remaining stock beside each row so a board that ran out is visible
 * before it is picked rather than after.
 */
export function MaterialPicker({
  materials,
  value,
  fallbackName,
  onPick,
  disabled = false,
  className = "",
  ariaLabel = "Лист түрі",
}: {
  materials: readonly Material[];
  value: string;
  /** Shown when the picked material is no longer in the catalogue — the line still names itself. */
  fallbackName?: string;
  onPick: (materialId: string) => void;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  const picked = materials.find((m) => m.id === value);
  const label = picked?.name || fallbackName || "Лист түрі";

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = materials.filter(
      (m) => !q || m.name.toLowerCase().includes(q) || (m.article ?? "").toLowerCase().includes(q),
    );
    return GROUP_ORDER.map((category) => ({
      category,
      items: matched
        .filter((m) => (m.category ?? "ldsp") === category)
        .sort((a, b) => a.name.localeCompare(b.name, "kk")),
    })).filter((g) => g.items.length > 0);
  }, [materials, query]);

  // Focus the search on open, and let Escape close — a picker you cannot dismiss from the keyboard
  // is a trap on a laptop, which is where the journal is mostly typed.
  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const choose = (id: string) => {
    onPick(id);
    setOpen(false);
    setQuery("");
  };

  return (
    <>
      <button
        type="button"
        className={`material-picker-btn${picked ? "" : " is-empty"} ${className}`}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        title={label}
      >
        <span className="material-picker-name">{label}</span>
        <span className="material-picker-caret" aria-hidden="true">▾</span>
      </button>

      {open && (
        <div
          className="modal-overlay active material-picker-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Лист түрін таңдау"
          onClick={() => setOpen(false)}
        >
          <div className="modal material-picker-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-handle" />
            <div className="material-picker-head">
              <h2>Лист түрі</h2>
              <button type="button" className="jt-icon-btn" onClick={() => setOpen(false)} aria-label="Жабу">✕</button>
            </div>

            <input
              ref={searchRef}
              className="form-input material-picker-search"
              placeholder="Іздеу…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />

            {groups.length === 0 ? (
              <p className="material-picker-empty">Ештеңе табылмады</p>
            ) : (
              groups.map((group) => (
                <section key={group.category} className="material-picker-group">
                  <h3>{MATERIAL_CATEGORY_LABELS[group.category]}</h3>
                  <div className="material-picker-list">
                    {group.items.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        className={`material-picker-item${m.id === value ? " is-active" : ""}`}
                        onClick={() => choose(m.id)}
                      >
                        <span className="material-picker-item-name">{m.name}</span>
                        {/* A customer's own board and the offcut rack carry no balance at all, so
                            printing "0" beside them would read as "none left" rather than "not
                            counted" — see Material.stockTracked. */}
                        <span className={`material-picker-qty${(m.qtyOnHand ?? 0) <= 0 && m.stockTracked !== false ? " is-out" : ""}`}>
                          {m.stockTracked === false ? "есепсіз" : `${m.qtyOnHand ?? 0} лист`}
                        </span>
                      </button>
                    ))}
                  </div>
                </section>
              ))
            )}
          </div>
        </div>
      )}
    </>
  );
}
