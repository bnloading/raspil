// Kazakhstan phone formatting/validation: +7 (7**) ***-**-**

const DIGITS_ONLY = /\D/g;

/** Normalizes any input into an 11-digit string starting with 7 (e.g. "77771234567"), or null if invalid. */
export function normalizePhone(raw: string): string | null {
  let digits = raw.replace(DIGITS_ONLY, "");
  if (digits.length === 10) digits = "7" + digits;
  if (digits.length === 11 && digits.startsWith("8")) digits = "7" + digits.slice(1);
  if (digits.length !== 11 || !digits.startsWith("7")) return null;
  return digits;
}

export function isValidPhone(raw: string): boolean {
  return normalizePhone(raw) !== null;
}

/** Formats normalized digits as +7 (7**) ***-**-** */
export function formatPhone(raw: string): string {
  const digits = normalizePhone(raw);
  if (!digits) return raw;
  const p1 = digits.slice(1, 4);
  const p2 = digits.slice(4, 7);
  const p3 = digits.slice(7, 9);
  const p4 = digits.slice(9, 11);
  let out = "+7";
  if (p1) out += ` (${p1}`;
  if (p1.length === 3) out += ")";
  if (p2) out += ` ${p2}`;
  if (p3) out += `-${p3}`;
  if (p4) out += `-${p4}`;
  return out;
}

/**
 * Firebase Auth's password provider needs an email-shaped identifier. Customers register with
 * phone + password (no phone-auth/SMS, which needs the Blaze billing plan), so we synthesize a
 * stable fake address from the normalized phone number. Never shown to the user.
 */
export function phoneToSyntheticEmail(phone: string): string {
  const digits = normalizePhone(phone);
  if (!digits) throw new Error("Invalid phone number");
  return `${digits}@customers.workshop.local`;
}
