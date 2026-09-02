import { useCallback, useEffect, useId, useRef, useState, type RefObject } from "react";
import { formatPhone } from "../lib/phone";
import { isExactly, suggestCustomers, type CustomerSuggestion } from "../lib/customerSuggest";

/**
 * The customer-name cell, completing itself from the shop's own history.
 *
 * Most walk-ins are returning customers, and every visit their name was retyped from scratch —
 * which is how one person becomes "Нурик", "нурик" and "Нұрик" in the debt ledger, each owing a
 * different amount. Picking a suggestion fills in the name AND the phone exactly as they are
 * already recorded, so a returning customer stays one customer and their rows stay mergeable.
 *
 * Tab takes the highlighted suggestion. Tab is also how the ledger moves to the next column, so
 * the two share it in the order a typist expects: while there is something to complete, Tab
 * completes it; press it again and the list is gone, so it moves on as it always did.
 */
export function CustomerNameInput({
  value,
  directory,
  className = "form-input",
  placeholder,
  ariaLabel,
  inputRef,
  onChange,
  onPick,
}: {
  value: string;
  /** Every customer the ledger knows, built once per page (lib/customerSuggest.ts). */
  directory: readonly CustomerSuggestion[];
  className?: string;
  placeholder?: string;
  ariaLabel?: string;
  /** The new-order row focuses its own name cell when it opens. */
  inputRef?: RefObject<HTMLInputElement | null>;
  onChange: (name: string) => void;
  /** A whole customer was chosen — the caller writes both the name and the phone. */
  onPick: (customer: CustomerSuggestion) => void;
}) {
  const ownRef = useRef<HTMLInputElement>(null);
  const ref = inputRef ?? ownRef;
  // Stable across renders and unique per row, so the listbox and its options can be pointed at
  // by aria-controls/aria-activedescendant without two ledger rows claiming the same id.
  const listId = useId();

  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [box, setBox] = useState<{ top: number; left: number; width: number } | null>(null);

  const matches = open ? suggestCustomers(directory, value) : [];
  // Nothing left to complete: leaving one suggestion hovering under a finished name is just
  // something else to dismiss before moving on.
  const items = matches.length === 1 && isExactly(matches[0], value) ? [] : matches;
  const showing = items.length > 0;

  /**
   * The list is positioned in viewport coordinates because the cell it belongs to clips its own
   * overflow — the ledger relies on that for its ellipsis, and a dropdown inside it would be cut
   * off after four pixels.
   */
  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setBox({ top: r.bottom + 2, left: r.left, width: Math.max(r.width, 210) });
  }, [ref]);

  useEffect(() => {
    if (!showing) {
      setBox(null);
      return;
    }
    measure();
    // `true` catches the ledger's own scroll container, not just the window.
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [showing, value, measure]);

  const accept = (customer: CustomerSuggestion) => {
    onPick(customer);
    setOpen(false);
    setActive(0);
  };

  return (
    <>
      <input
        ref={ref}
        className={className}
        value={value}
        placeholder={placeholder}
        aria-label={ariaLabel}
        role="combobox"
        aria-expanded={showing}
        aria-controls={showing ? listId : undefined}
        aria-activedescendant={showing ? `${listId}-${active}` : undefined}
        aria-autocomplete="list"
        autoComplete="off"
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        // Not opened on focus: tabbing through the ledger would pop a list over the row below on
        // every single name cell. The list is for typing a name, so typing is what opens it.
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (!showing) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((i) => (i + 1) % items.length);
            return;
          }
          if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((i) => (i - 1 + items.length) % items.length);
            return;
          }
          if (e.key === "Escape") {
            e.preventDefault();
            setOpen(false);
            return;
          }
          if (e.key === "Tab" || e.key === "Enter") {
            // stopPropagation as well as preventDefault: Enter is the ledger's "move down a
            // column" and the new row's "save", and neither may fire on the keystroke that was
            // meant to choose a customer.
            e.preventDefault();
            e.stopPropagation();
            accept(items[Math.min(active, items.length - 1)]);
          }
        }}
      />

      {showing && box && (
        <ul className="cust-suggest" id={listId} role="listbox" aria-label="Бұрынғы клиенттер"
          style={{ top: box.top, left: box.left, width: box.width }}>
          {items.map((customer, index) => (
            <li key={`${customer.name}-${customer.phone}`}>
              <button
                type="button"
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === active}
                className={`cust-suggest-item${index === active ? " is-active" : ""}`}
                // Keeps focus in the input, so the click lands instead of being eaten by the blur.
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(index)}
                onClick={() => accept(customer)}
              >
                <span className="cust-suggest-name">{customer.name}</span>
                <span className="cust-suggest-meta">
                  {customer.phone ? formatPhone(customer.phone) : "телефонсыз"}
                  {" · "}
                  {customer.orderCount} заказ
                </span>
              </button>
            </li>
          ))}
          <li className="cust-suggest-hint" aria-hidden="true">
            <kbd>Tab</kbd> — қою, <kbd>↑</kbd><kbd>↓</kbd> — таңдау, <kbd>Esc</kbd> — жабу
          </li>
        </ul>
      )}
    </>
  );
}
