import { useEffect, useRef, useState, type ReactNode } from "react";

export interface RowMenuItem {
  label: string;
  onClick: () => void;
  /** Renders in the danger colour — for destructive entries. */
  danger?: boolean;
}

/**
 * The "⋯" overflow menu on a table row.
 *
 * A row with four buttons spends more width on actions than on data, and at 28 rows that is most
 * of the screen. Keeping one primary action visible and folding the rest in here is what the
 * reference layout does, and it keeps the row one line tall.
 */
export function RowMenu({ items, children }: { items: RowMenuItem[]; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on an outside click or Escape — a menu that can only be dismissed by choosing something
  // is a trap, especially on touch where there is no hover to back out with.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="rowmenu" ref={ref}>
      {children}
      <button
        type="button"
        className="rowmenu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Қосымша әрекеттер"
        onClick={() => setOpen((v) => !v)}
      >
        ⋯
      </button>
      {open && (
        <div className="rowmenu-list" role="menu">
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className={`rowmenu-item${item.danger ? " is-danger" : ""}`}
              onClick={() => {
                setOpen(false);
                item.onClick();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
