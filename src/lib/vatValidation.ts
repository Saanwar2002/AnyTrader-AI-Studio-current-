/**
 * Shared UK VAT Number & Registration Eligibility Validation (AT-CJ-INVOICE-06)
 * Prevents non-VAT-registered or unverified accounts from issuing VAT-itemized invoices.
 */

export const UK_VAT_REGEX = /^(GB|XI)([0-9]{9}|[0-9]{12}|GD[0-9]{3}|HA[0-9]{3})$/;

export function normalizeUkVatNumber(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/[\s-]+/g, "").toUpperCase();
}

export function isValidUkVatNumber(raw: unknown): boolean {
  const normalized = normalizeUkVatNumber(raw);
  if (!normalized) return false;
  return UK_VAT_REGEX.test(normalized);
}

export interface VatEligibilityResult {
  eligible: boolean;
  vatNumber: string;
  vatRate: number;
  reason?: string;
}

/**
 * Evaluates whether a tradesperson / business profile is legitimately registered
 * and verified to charge UK VAT (20%) on platform or manual invoices.
 */
export function evaluateVatEligibility(profile: Record<string, any> | null | undefined): VatEligibilityResult {
  if (!profile || typeof profile !== "object") {
    return {
      eligible: false,
      vatNumber: "",
      vatRate: 0,
      reason: "User profile not found; verified UK VAT registration is required.",
    };
  }

  const verificationStatus = String(profile.vatVerificationStatus || "").trim().toLowerCase();
  if (["rejected", "revoked", "suspended", "expired", "unverified"].includes(verificationStatus)) {
    return {
      eligible: false,
      vatNumber: "",
      vatRate: 0,
      reason: `VAT registration status '${verificationStatus}' is not eligible to charge VAT.`,
    };
  }

  const normalizedVat = normalizeUkVatNumber(profile.vatNumber || profile.vatRegistrationNumber);
  if (!normalizedVat || !isValidUkVatNumber(normalizedVat)) {
    return {
      eligible: false,
      vatNumber: "",
      vatRate: 0,
      reason: "A valid verified UK VAT number (e.g. GB123456789) is required to generate VAT-itemized invoices.",
    };
  }

  const hasAuthoritativeFlag =
    profile.vatRegistered === true ||
    verificationStatus === "verified";

  if (!hasAuthoritativeFlag) {
    return {
      eligible: false,
      vatNumber: "",
      vatRate: 0,
      reason: "VAT registration has not been verified on this account.",
    };
  }

  return {
    eligible: true,
    vatNumber: normalizedVat,
    vatRate: 20,
  };
}
