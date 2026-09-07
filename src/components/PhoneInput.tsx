import { useState, type ChangeEvent } from "react";
import { formatNational, nationalDigits, normalizePhone } from "../lib/phone";

/**
 * A Kazakh phone number, typed as the ten digits that actually differ.
 *
 * "+7" is printed beside the field rather than sitting in it: every number the shop deals with
 * starts that way, so it is the one part nobody should have to type — and, printed outside the
 * input, the one part nobody can delete by accident either. What the caller receives is still a
 * whole number that normalizePhone() accepts, so nothing downstream has to know about this.
 */
export function PhoneInput({
  value,
  onChange,
  required,
  className = "form-input",
}: {
  value: string;
  onChange: (formatted: string) => void;
  required?: boolean;
  className?: string;
}) {
  const [touched, setTouched] = useState(false);
  // `value` is either what this component itself last emitted ("+7" + up to 10 national digits —
  // strip that known literal prefix before re-parsing) or a stored number with no "+" at all
  // ("77011234567", straight from Firestore's `phone` field — nationalDigits' own country-code
  // heuristic handles that case). Calling nationalDigits directly on "+7<digits>" is what used to
  // go wrong: for any КZ number, the national part itself typically starts with "7" too (every
  // 7xx mobile prefix), so re-deriving digits from the prefixed value re-added a phantom leading
  // "7" on every keystroke — each one compounding into the next until real digits got pushed off
  // the ten-digit cap and appeared to "disappear" while typing.
  const digits = nationalDigits(value.startsWith("+7") ? value.slice(2) : value);
  const valid = digits.length === 0 || normalizePhone(value) !== null;

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    const next = nationalDigits(e.target.value);
    // Emitted whole, so the caller keeps holding something normalizePhone() understands.
    onChange(next ? `+7${next}` : "");
  };

  return (
    <div>
      <div className={`phone-field${touched && !valid ? " is-invalid" : ""}`}>
        <span className="phone-prefix" aria-hidden="true">+7</span>
        <input
          type="tel"
          className={className}
          placeholder="(777) 123-45-67"
          value={formatNational(digits)}
          onChange={handleChange}
          onBlur={() => setTouched(true)}
          required={required}
          inputMode="numeric"
          autoComplete="tel-national"
          aria-label="Телефон нөмірі"
        />
      </div>
      {touched && !valid && (
        <small style={{ color: "var(--danger)" }}>Телефон нөмірін тексеріңіз</small>
      )}
    </div>
  );
}
