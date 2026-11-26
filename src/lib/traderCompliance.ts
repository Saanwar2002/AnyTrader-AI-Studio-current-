import { TRADE_CATEGORIES } from "../constants.ts";

export const DEFAULT_DOCUMENT_GRACE_PERIOD_DAYS = 14;
export const DEFAULT_PROVISIONAL_MAX_QUOTES = 5;

export const TRADER_COMPLIANCE_DECLARATION_SUMMARY =
  "I agree to the AnyTrader Terms & Conditions and confirm that I hold all necessary legal paperwork for the services I offer, including valid Public Liability Insurance, Health & Safety compliance, and any applicable UK trade qualifications or licences.";

export interface TradeCertificationRequirementResult {
  requiredCertifications: string[];
  regulatedCategories: string[];
  hasRegulatedCategory: boolean;
}

export interface TraderDocumentComplianceResult {
  status:
    | "verified"
    | "docs_submitted_pending_review"
    | "provisional_grace_active"
    | "provisional_quote_cap_reached"
    | "grace_expired_restricted"
    | "regulated_pending_admin"
    | "blocked";
  canQuote: boolean;
  blockReason: string | null;
  hasRegulatedCategory: boolean;
  regulatedCategories: string[];
  requiredCertifications: string[];
  hasUploadedAnyDoc: boolean;
  daysActive: number;
  gracePeriodDays: number;
  daysRemaining: number;
  isGraceExpired: boolean;
  provisionalQuotesUsed: number;
  provisionalMaxQuotes: number;
  provisionalQuotesRemaining: number;
  isProvisionalQuoteCapReached: boolean;
  duplicatePhoneFingerprintDetected: boolean;
  needsDocumentReminder: boolean;
  graceDeadlineIso: string | null;
}

function normalizeName(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function parseTimestampMs(value: unknown): number | null {
  if (!value) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.getTime();
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  if (typeof value === "object") {
    const anyVal = value as any;
    if (typeof anyVal.toMillis === "function") {
      const ms = anyVal.toMillis();
      return Number.isFinite(ms) ? ms : null;
    }
    if (typeof anyVal.seconds === "number") {
      return anyVal.seconds * 1000;
    }
    if (typeof anyVal._seconds === "number") {
      return anyVal._seconds * 1000;
    }
  }
  return null;
}

/**
 * Resolves all mandatory UK certifications and regulated categories for a given
 * list of selected trade categories and optional subcategories.
 */
export function getRequiredCertificationsForTrades(
  trades: string[] = [],
  subcategories: string[] = [],
  catalog: ReadonlyArray<any> = TRADE_CATEGORIES
): TradeCertificationRequirementResult {
  const selectedTradesNorm = new Set((Array.isArray(trades) ? trades : []).map(normalizeName).filter(Boolean));
  const selectedSubsNorm = new Set((Array.isArray(subcategories) ? subcategories : []).map(normalizeName).filter(Boolean));

  const certSet = new Set<string>();
  const regulatedCatSet = new Set<string>();

  for (const cat of catalog) {
    if (!cat || !selectedTradesNorm.has(normalizeName(cat.name))) continue;

    let categoryRequiresCert = false;
    if (Array.isArray(cat.requiredCertifications) && cat.requiredCertifications.length > 0) {
      for (const cert of cat.requiredCertifications) {
        if (typeof cert === "string" && cert.trim().length > 0) {
          certSet.add(cert.trim());
          categoryRequiresCert = true;
        }
      }
    }

    if (cat.subcategoryCertifications && typeof cat.subcategoryCertifications === "object") {
      for (const [subName, certs] of Object.entries(cat.subcategoryCertifications)) {
        if (selectedSubsNorm.has(normalizeName(subName)) && Array.isArray(certs)) {
          for (const cert of certs) {
            if (typeof cert === "string" && cert.trim().length > 0) {
              certSet.add(cert.trim());
              categoryRequiresCert = true;
            }
          }
        }
      }
    }

    if (categoryRequiresCert) {
      regulatedCatSet.add(String(cat.name));
    }
  }

  const requiredCertifications = Array.from(certSet);
  const regulatedCategories = Array.from(regulatedCatSet);

  return {
    requiredCertifications,
    regulatedCategories,
    hasRegulatedCategory: requiredCertifications.length > 0,
  };
}

/**
 * Checks whether a single job category requires mandatory UK certification / admin approval.
 */
export function isCategoryRegulated(
  categoryName?: string | null,
  catalog: ReadonlyArray<any> = TRADE_CATEGORIES
): boolean {
  const norm = normalizeName(categoryName);
  if (!norm) return false;
  const match = catalog.find((c: any) => normalizeName(c?.name) === norm);
  if (!match) return false;
  return Array.isArray(match.requiredCertifications) && match.requiredCertifications.length > 0;
}

/**
 * Evaluates a tradesperson's compliance, regulated-category admin approval status,
 * provisional quote cap, and configurable document-upload grace period (default 14 days).
 *
 * Pure function: safe for both server quote enforcement and client UI reminders.
 */
export function evaluateTraderDocumentCompliance(
  traderData: Record<string, any> | null | undefined,
  options?: {
    gracePeriodDays?: number;
    enforceGracePeriod?: boolean;
    provisionalMaxQuotes?: number;
    targetJobCategory?: string | null;
    now?: Date;
    catalog?: ReadonlyArray<any>;
  }
): TraderDocumentComplianceResult {
  const catalog = options?.catalog ?? TRADE_CATEGORIES;
  const rawGraceDays = options?.gracePeriodDays;
  const gracePeriodDays =
    typeof rawGraceDays === "number" && Number.isFinite(rawGraceDays) && rawGraceDays >= 0
      ? Math.floor(rawGraceDays)
      : DEFAULT_DOCUMENT_GRACE_PERIOD_DAYS;
  const rawMaxQuotes = options?.provisionalMaxQuotes;
  const provisionalMaxQuotes =
    typeof rawMaxQuotes === "number" && Number.isFinite(rawMaxQuotes) && rawMaxQuotes >= 0
      ? Math.floor(rawMaxQuotes)
      : DEFAULT_PROVISIONAL_MAX_QUOTES;
  const enforceGracePeriod = options?.enforceGracePeriod !== false;
  const nowMs = (options?.now ?? new Date()).getTime();
  const provisionalQuotesUsed = Math.max(0, Math.floor(Number(traderData?.provisionalQuotesUsed || 0)));
  const provisionalQuotesRemaining =
    provisionalMaxQuotes > 0 ? Math.max(0, provisionalMaxQuotes - provisionalQuotesUsed) : Number.POSITIVE_INFINITY;
  const duplicatePhoneFingerprintDetected = Boolean(traderData?.duplicatePhoneFingerprintDetected);

  const trades = Array.isArray(traderData?.trades) ? traderData.trades : [];
  const subcategories = Array.isArray(traderData?.subcategories) ? traderData.subcategories : [];
  const certInfo = getRequiredCertificationsForTrades(trades, subcategories, catalog);

  const hasRegulatedCategory =
    certInfo.hasRegulatedCategory || traderData?.requiresAdminVerification === true;
  const regulatedCategories =
    certInfo.regulatedCategories.length > 0
      ? certInfo.regulatedCategories
      : Array.isArray(traderData?.regulatedCategories)
        ? traderData.regulatedCategories
        : [];
  const requiredCertifications =
    certInfo.requiredCertifications.length > 0
      ? certInfo.requiredCertifications
      : Array.isArray(traderData?.requiredCertifications)
        ? traderData.requiredCertifications
        : [];

  const docs = Array.isArray(traderData?.verificationDocs) ? traderData.verificationDocs : [];
  const hasUploadedAnyDoc = docs.some(
    (d: any) => d && typeof d.fileUrl === "string" && d.fileUrl.trim().length > 0 && d.status !== "rejected"
  );

  const storedVerifStatus = normalizeName(traderData?.verificationStatus);
  const isVerified =
    traderData?.isVerified === true ||
    ["verified", "vetted", "auditioned"].includes(storedVerifStatus);

  const activatedAtMs =
    parseTimestampMs(traderData?.traderActivatedAt) ??
    parseTimestampMs(traderData?.upgradedToTraderAt) ??
    parseTimestampMs(traderData?.createdAt) ??
    nowMs;

  const elapsedMs = Math.max(0, nowMs - activatedAtMs);
  const daysActive = Math.floor(elapsedMs / (1000 * 60 * 60 * 24));
  const daysRemaining = gracePeriodDays > 0 ? Math.max(0, gracePeriodDays - daysActive) : 0;
  const explicitDeadlineMs = parseTimestampMs(traderData?.documentGraceDeadlineAt);
  const computedDeadlineMs =
    gracePeriodDays > 0 ? activatedAtMs + gracePeriodDays * 24 * 60 * 60 * 1000 : null;
  const deadlineMs = explicitDeadlineMs ?? computedDeadlineMs;
  const graceDeadlineIso = deadlineMs ? new Date(deadlineMs).toISOString() : null;
  const isGraceExpired =
    !isVerified &&
    !hasUploadedAnyDoc &&
    enforceGracePeriod &&
    gracePeriodDays > 0 &&
    daysActive >= gracePeriodDays;

  const isProvisionalQuoteCapReached =
    !isVerified &&
    !hasUploadedAnyDoc &&
    storedVerifStatus === "provisional" &&
    provisionalMaxQuotes > 0 &&
    provisionalQuotesUsed >= provisionalMaxQuotes;

  const baseQuoteFields = {
    provisionalQuotesUsed,
    provisionalMaxQuotes,
    provisionalQuotesRemaining: Number.isFinite(provisionalQuotesRemaining) ? provisionalQuotesRemaining : 0,
    isProvisionalQuoteCapReached: false,
    duplicatePhoneFingerprintDetected,
  };

  if (isVerified) {
    return {
      ...baseQuoteFields,
      status: "verified",
      canQuote: true,
      blockReason: null,
      hasRegulatedCategory,
      regulatedCategories,
      requiredCertifications,
      hasUploadedAnyDoc: true,
      daysActive,
      gracePeriodDays,
      daysRemaining: 0,
      isGraceExpired: false,
      needsDocumentReminder: false,
      graceDeadlineIso,
    };
  }

  if (["rejected", "revoked", "suspended", "expired"].includes(storedVerifStatus)) {
    return {
      ...baseQuoteFields,
      status: "blocked",
      canQuote: false,
      blockReason: `Tradesperson verification status '${storedVerifStatus}' cannot submit quotes.`,
      hasRegulatedCategory,
      regulatedCategories,
      requiredCertifications,
      hasUploadedAnyDoc,
      daysActive,
      gracePeriodDays,
      daysRemaining,
      isGraceExpired,
      needsDocumentReminder: true,
      graceDeadlineIso,
    };
  }

  // Anti-cycling safeguard: phone number previously used on another trader profile requires Admin approval upfront
  if (duplicatePhoneFingerprintDetected) {
    return {
      ...baseQuoteFields,
      status: "regulated_pending_admin",
      canQuote: false,
      blockReason:
        "This phone number was previously linked to another trader profile. To prevent duplicate accounts, please upload Photo ID or Public Liability Insurance for Admin approval before quoting.",
      hasRegulatedCategory,
      regulatedCategories,
      requiredCertifications,
      hasUploadedAnyDoc,
      daysActive,
      gracePeriodDays,
      daysRemaining,
      isGraceExpired,
      needsDocumentReminder: true,
      graceDeadlineIso,
    };
  }

  // Regulated categories (or attempting to quote on a regulated job) strictly require admin approval
  const targetIsRegulated = isCategoryRegulated(options?.targetJobCategory, catalog);
  if (hasRegulatedCategory || targetIsRegulated) {
    const categoryLabel =
      regulatedCategories.length > 0
        ? regulatedCategories.join(", ")
        : options?.targetJobCategory || "regulated trade categories";
    return {
      ...baseQuoteFields,
      status: "regulated_pending_admin",
      canQuote: false,
      blockReason: `Admin document verification is required for ${categoryLabel} before submitting quotes. Please upload your required certificates in Profile -> Verification Center.`,
      hasRegulatedCategory: true,
      regulatedCategories:
        regulatedCategories.length > 0
          ? regulatedCategories
          : options?.targetJobCategory
            ? [String(options.targetJobCategory)]
            : [],
      requiredCertifications,
      hasUploadedAnyDoc,
      daysActive,
      gracePeriodDays,
      daysRemaining,
      isGraceExpired,
      needsDocumentReminder: true,
      graceDeadlineIso,
    };
  }

  // Non-regulated trader who has uploaded at least one document (awaiting optional admin verification)
  if (hasUploadedAnyDoc && (storedVerifStatus === "pending" || storedVerifStatus === "provisional")) {
    return {
      ...baseQuoteFields,
      status: "docs_submitted_pending_review",
      canQuote: true,
      blockReason: null,
      hasRegulatedCategory: false,
      regulatedCategories: [],
      requiredCertifications: [],
      hasUploadedAnyDoc: true,
      daysActive,
      gracePeriodDays,
      daysRemaining,
      isGraceExpired: false,
      needsDocumentReminder: false,
      graceDeadlineIso,
    };
  }

  // Non-regulated provisional trader (must have completed basic upgrade & compliance declaration)
  if (storedVerifStatus === "provisional") {
    if (isGraceExpired) {
      return {
        ...baseQuoteFields,
        status: "grace_expired_restricted",
        canQuote: false,
        blockReason: `Your ${gracePeriodDays}-day document upload grace period has ended. Please upload Photo ID or Public Liability Insurance in your Profile Verification Center to restore quoting access.`,
        hasRegulatedCategory: false,
        regulatedCategories: [],
        requiredCertifications: [],
        hasUploadedAnyDoc: false,
        daysActive,
        gracePeriodDays,
        daysRemaining: 0,
        isGraceExpired: true,
        needsDocumentReminder: true,
        graceDeadlineIso,
      };
    }

    if (isProvisionalQuoteCapReached) {
      return {
        ...baseQuoteFields,
        status: "provisional_quote_cap_reached",
        canQuote: false,
        blockReason: `You have reached your provisional limit of ${provisionalMaxQuotes} quotes without verification documents. Please upload Photo ID or Public Liability Insurance in your Profile Verification Center to unlock further quoting.`,
        hasRegulatedCategory: false,
        regulatedCategories: [],
        requiredCertifications: [],
        hasUploadedAnyDoc: false,
        daysActive,
        gracePeriodDays,
        daysRemaining,
        isGraceExpired: false,
        isProvisionalQuoteCapReached: true,
        provisionalQuotesRemaining: 0,
        needsDocumentReminder: true,
        graceDeadlineIso,
      };
    }

    return {
      ...baseQuoteFields,
      status: "provisional_grace_active",
      canQuote: true,
      blockReason: null,
      hasRegulatedCategory: false,
      regulatedCategories: [],
      requiredCertifications: [],
      hasUploadedAnyDoc: false,
      daysActive,
      gracePeriodDays,
      daysRemaining,
      isGraceExpired: false,
      needsDocumentReminder: true,
      graceDeadlineIso,
    };
  }

  // Unverified or missing status without provisional activation
  return {
    ...baseQuoteFields,
    status: "blocked",
    canQuote: false,
    blockReason: "Tradesperson account must be verified before submitting quotes.",
    hasRegulatedCategory,
    regulatedCategories,
    requiredCertifications,
    hasUploadedAnyDoc,
    daysActive,
    gracePeriodDays,
    daysRemaining,
    isGraceExpired,
    needsDocumentReminder: true,
    graceDeadlineIso,
  };
}
