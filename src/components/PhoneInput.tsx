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
  const digits = nationalDigits(value);
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
