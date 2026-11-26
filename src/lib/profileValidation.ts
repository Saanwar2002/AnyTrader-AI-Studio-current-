/**
 * Pure validation & normalization helpers for AnyTrader user profile settings.
 */

export interface PhoneValidationResult {
  valid: boolean;
  normalized: string;
  error?: string;
}

/**
 * Validates and normalizes a UK or international phone number entered in Profile settings.
 * Empty input is allowed so users who do not wish to store a phone number can clear it.
 */
export function validateAndNormalizeProfilePhone(rawInput: unknown): PhoneValidationResult {
  const raw = typeof rawInput === "string" ? rawInput.trim() : "";
  if (!raw) {
    return { valid: true, normalized: "" };
  }

  // Reject alphabetic characters or unexpected symbols
  if (/[a-zA-Z]/.test(raw) || /[^0-9+\-\s().]/.test(raw)) {
    return {
      valid: false,
      normalized: raw,
      error: "Please enter a valid phone number using digits only (e.g. 07700 900123 or +44 7700 900123).",
    };
  }

  const hasLeadingPlus = raw.startsWith("+");
  const digitsOnly = raw.replace(/\D/g, "");

  if (digitsOnly.length < 10 || digitsOnly.length > 15) {
    return {
      valid: false,
      normalized: raw,
      error: "Phone number must be between 10 and 15 digits (e.g. 07700 900123).",
    };
  }

  // UK national format: 07..., 01..., 02..., 03... (10 or 11 digits)
  if (!hasLeadingPlus && digitsOnly.startsWith("0")) {
    if (digitsOnly.length !== 10 && digitsOnly.length !== 11) {
      return {
        valid: false,
        normalized: raw,
        error: "UK phone numbers should be 10 or 11 digits starting with 0 (e.g. 07700 900123).",
      };
    }
    return {
      valid: true,
      normalized: `+44${digitsOnly.slice(1)}`,
    };
  }

  // UK international format starting with 44 or +44
  if (digitsOnly.startsWith("44")) {
    if (digitsOnly.length < 11 || digitsOnly.length > 12) {
      return {
        valid: false,
        normalized: raw,
        error: "UK international phone numbers should start with +44 followed by 9 or 10 digits.",
      };
    }
    return {
      valid: true,
      normalized: `+${digitsOnly}`,
    };
  }

  // Standard international E.164 number
  if (hasLeadingPlus) {
    return {
      valid: true,
      normalized: `+${digitsOnly}`,
    };
  }

  return {
    valid: false,
    normalized: raw,
    error: "Please enter a UK number starting with 0 (e.g. 07700 900123) or an international number starting with +.",
  };
}
