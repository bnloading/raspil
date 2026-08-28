import { useEffect, useState } from "react";

/**
 * A numeric input you can actually clear.
 *
 * A plain controlled `value={n}` with `onChange={Number(v) || fallback}` snaps back to the
 * fallback the instant the field is emptied, so the last digit can never be deleted — you press
 * Backspace on "1" and it immediately becomes "1" again. This keeps the raw text while the user
 * is typing and only commits a number when it parses, so the field may legitimately sit empty
 * mid-edit. On blur an empty field settles to `emptyValue`.
 */
export function NumberField({
  value,
  onChange,
  min,
  emptyValue = 0,
  className = "form-input",
  placeholder,
  ariaLabel,
  suffix,
}: {
  value: number;
  onChange: (next: number) => void;
  min?: number;
  /** What an empty field means once the user leaves it. */
  emptyValue?: number;
  className?: string;
  placeholder?: string;
  ariaLabel?: string;
  /** Rendered next to the input (e.g. "мм") rather than inside its text, so it can't be typed over. */
  suffix?: string;
}) {
  const [text, setText] = useState(value === 0 ? "" : String(value));

  // Follow external changes (bulk edits, a different part loaded into the row) unless the user is
  // mid-edit on the same underlying number.
  useEffect(() => {
    const parsed = text.trim() === "" ? emptyValue : Number(text);
    if (parsed !== value) setText(value === 0 ? "" : String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const commit = (raw: string) => {
    setText(raw);
    const trimmed = raw.trim();
    if (trimmed === "") return; // stay empty while typing; don't fire a spurious 0
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) onChange(parsed);
  };

  const input = (
    <input
      type="number"
      inputMode="decimal"
      className={className}
      min={min}
      placeholder={placeholder}
      aria-label={ariaLabel}
      value={text}
      onChange={(e) => commit(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={() => {
        if (text.trim() === "") {
          setText(emptyValue === 0 ? "" : String(emptyValue));
          onChange(emptyValue);
        }
      }}
    />
  );

  if (!suffix) return input;
  return (
    <span className="number-field-wrap">
      {input}
      <span className="number-field-suffix">{suffix}</span>
    </span>
  );
}
