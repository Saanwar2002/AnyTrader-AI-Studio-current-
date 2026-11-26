/**
 * Shared AnyTrader Marketplace Data Contracts (Homeowner + Trader Unified)
 *
 * Single source of truth for job statuses, urgencies, quote scopes,
 * availability state, and Admin-controlled FlexiPay feature flags.
 */

export const PUBLIC_OPEN_JOB_STATUSES = [
  "open",
  "posted",
  "quoted",
  "quoting",
  "in_bidding",
] as const;

export type PublicOpenJobStatus = (typeof PUBLIC_OPEN_JOB_STATUSES)[number];

export const PUBLIC_OPEN_JOB_STATUS_SET = new Set<string>(PUBLIC_OPEN_JOB_STATUSES);

export function isOpenJobStatus(status?: string | null): boolean {
  if (!status) return false;
  return PUBLIC_OPEN_JOB_STATUS_SET.has(String(status).trim().toLowerCase());
}

export const CANONICAL_JOB_URGENCIES = [
  "emergency",
  "urgent",
  "standard",
  "flexible",
] as const;

export type CanonicalJobUrgency = (typeof CANONICAL_JOB_URGENCIES)[number];

/**
 * Normalizes UI and legacy urgency tokens to the canonical server enum.
 * Preserves emergency / urgent priority while preventing validation rejections.
 */
export function normalizeJobUrgency(raw?: unknown): CanonicalJobUrgency {
  const token = String(raw || "standard").trim().toLowerCase();
  if (token.includes("emergency") || token === "immediate") {
    return "emergency";
  }
  if (
    token === "urgent" ||
    token === "asap" ||
    token === "this_week" ||
    token === "within_48h" ||
    token.includes("48 hour") ||
    token.includes("24h")
  ) {
    return "urgent";
  }
  switch (token) {
    case "flexible":
    case "routine":
    case "no_rush":
    case "planning":
      return "flexible";
    case "standard":
    case "specific_date":
    case "this_month":
    case "scheduled":
    default:
      return "standard";
  }
}

export function formatJobUrgencyLabel(urgency?: string | null, urgencyLabel?: string | null, preferredDate?: string | null): string {
  const rawLabel = String(urgencyLabel || urgency || "").trim().toLowerCase();
  if (rawLabel === "specific_date" && preferredDate) {
    const parsed = new Date(preferredDate);
    if (!Number.isNaN(parsed.getTime())) {
      return `Date: ${parsed.toLocaleDateString("en-GB")}`;
    }
  }
  switch (rawLabel) {
    case "emergency":
      return "Emergency";
    case "asap":
      return "ASAP (1–2 Days)";
    case "urgent":
      return "Urgent";
    case "this_week":
      return "This Week";
    case "this_month":
      return "This Month";
    case "specific_date":
      return "Specific Date";
    case "flexible":
      return "Flexible";
    case "standard":
      return "Standard";
    default:
      return rawLabel ? rawLabel.replace(/_/g, " ") : "Flexible";
  }
}

export const CANONICAL_QUOTE_SCOPES = [
  "labor_only",
  "materials_included",
  "custom",
  "full_project",
] as const;

export type CanonicalQuoteScope = (typeof CANONICAL_QUOTE_SCOPES)[number];

/**
 * Normalizes UK/US spellings and UI scope aliases to canonical server values.
 */
export function normalizeQuoteScope(raw?: unknown): CanonicalQuoteScope {
  const token = String(raw || "full_project").trim().toLowerCase();
  switch (token) {
    case "labor_only":
    case "labour_only":
    case "labour only":
    case "labor only":
    case "labor":
    case "labour":
      return "labor_only";
    case "materials_included":
    case "materials_and_labour":
    case "materials_and_labor":
    case "materials included":
      return "materials_included";
    case "custom":
      return "custom";
    case "full_project":
    case "complete_package":
    case "full_package":
    case "all_inclusive":
    default:
      return "full_project";
  }
}

export function isLabourOnlyScope(raw?: string | null): boolean {
  return normalizeQuoteScope(raw) === "labor_only";
}

export function isCompletePackageScope(raw?: string | null): boolean {
  const norm = normalizeQuoteScope(raw);
  return norm === "full_project" || norm === "materials_included";
}

export function formatQuoteScopeLabel(raw?: string | null): string {
  const norm = normalizeQuoteScope(raw);
  switch (norm) {
    case "labor_only":
      return "Labour Only";
    case "materials_included":
      return "Materials Included";
    case "custom":
      return "Custom Scope";
    case "full_project":
    default:
      return "Complete Package (Materials & Labour)";
  }
}

/**
 * Canonical availability helper — respects both canonical `acceptingNewWork`
 * and legacy `isAcceptingRequests` during transition.
 */
export function isProfileAcceptingNewWork(profile?: Record<string, any> | null): boolean {
  if (!profile) return true;
  if (profile.acceptingNewWork === false || profile.isAcceptingRequests === false) return false;
  return true;
}

/**
 * Admin-controlled 3-state FlexiPay BNPL governance flag.
 * Defaults to "coming_soon" so fake pre-approval flows stay disabled at launch
 * while admins can switch FlexiPay completely "off" or turn it "live" post-launch.
 */
export type FlexiPayMode = "off" | "coming_soon" | "live";

export function resolveFlexiPayMode(platformConfig?: Record<string, any> | null): FlexiPayMode {
  const raw = String(platformConfig?.flexiPayMode || "").trim().toLowerCase();
  if (raw === "off" || raw === "disabled" || raw === "hidden") return "off";
  if (raw === "live" || raw === "enabled" || raw === "active") return "live";
  if (raw === "coming_soon") return "coming_soon";
  if (platformConfig?.flexiPayEnabled === false) return "off";
  return "coming_soon";
}
