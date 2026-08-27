import { useState, type ChangeEvent } from "react";
import { formatPhone, normalizePhone } from "../lib/phone";

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
  const valid = value.length === 0 || normalizePhone(value) !== null;

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    // Only reformat once there are enough digits to avoid fighting the caret while typing.
    const digits = raw.replace(/\D/g, "");
    onChange(digits.length >= 10 ? formatPhone(raw) : raw);
  };

  return (
    <div>
      <input
        type="tel"
        className={className}
        placeholder="+7 (777) 123-45-67"
        value={value}
        onChange={handleChange}
        onBlur={() => setTouched(true)}
        required={required}
        inputMode="tel"
      />
      {touched && !valid && (
        <small style={{ color: "var(--danger)" }}>Телефон нөмірін тексеріңіз</small>
      )}
    </div>
  );
}
