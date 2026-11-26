/**
 * Shared role, business-layer, and capability helpers used across frontend
 * routing, navigation, profile/billing UI, and server-side payout guards.
 *
 * Pure module: no Firebase SDK, browser, or Node-only imports.
 */

export type BusinessLayer = "properties" | "field_services" | "trades" | "consultancy";

export interface AccountRoleLike {
  role?: string | null;
  accountType?: string | null;
  businessLayer?: string | null;
  subscriptionType?: string | null;
  capabilities?: unknown;
  isTradesperson?: boolean | null;
  isDriver?: boolean | null;
  stripeAccountId?: string | null;
}

function normalizeStr(val: unknown): string {
  return typeof val === "string" ? val.trim().toLowerCase() : "";
}

function getNormalizedCapabilities(profile?: AccountRoleLike | null): string[] {
  if (!profile || !Array.isArray(profile.capabilities)) return [];
  return profile.capabilities
    .map((cap) => normalizeStr(cap))
    .filter((cap) => cap.length > 0);
}

/**
 * Normalizes legacy `"trades"` layer to `"field_services"` while preserving
 * `"properties"` and `"consultancy"`. Returns `null` when absent or unknown.
 */
export function normalizeBusinessLayer(layer?: unknown): "properties" | "field_services" | "consultancy" | null {
  const normalized = normalizeStr(layer);
  if (normalized === "properties") return "properties";
  if (normalized === "field_services" || normalized === "trades") return "field_services";
  if (normalized === "consultancy") return "consultancy";
  return null;
}

export function isAdminAccount(profile?: AccountRoleLike | null): boolean {
  const role = normalizeStr(profile?.role);
  return role === "admin" || role === "super_admin";
}

export function isEcosystemManagerAccount(profile?: AccountRoleLike | null): boolean {
  return normalizeStr(profile?.role) === "ecosystem_manager";
}

/**
 * Returns true if the account is a driver (AnyRoller driver capability or role).
 */
export function isAnyRollerDriverAccount(profile?: AccountRoleLike | null): boolean {
  if (!profile) return false;
  const role = normalizeStr(profile.role);
  if (role === "fleet_driver" || role === "driver" || profile.isDriver === true) {
    return true;
  }
  const caps = getNormalizedCapabilities(profile);
  return caps.includes("fleet_driver") || caps.includes("driver");
}

/**
 * Returns true if the account is a Trade / Field Services provider (solo
 * tradesperson, contractor, or Business -> Trades & Field Services).
 *
 * Explicitly returns FALSE for Property & Asset Management businesses
 * (`businessLayer === "properties"`) unless they also hold an explicit
 * tradesperson/contractor capability.
 */
export function isTradeProviderAccount(profile?: AccountRoleLike | null): boolean {
  if (!profile) return false;
  const role = normalizeStr(profile.role);
  const caps = getNormalizedCapabilities(profile);

  if (role === "tradesperson" || role === "contractor" || profile.isTradesperson === true) {
    return true;
  }

  if (caps.includes("tradesperson") || caps.includes("contractor")) {
    return true;
  }

  if (role === "business") {
    const layer = normalizeBusinessLayer(profile.businessLayer);
    if (layer === "field_services") {
      return true;
    }
    return false;
  }

  return false;
}

/**
 * Returns true if the account is a Business -> Consultancy provider.
 */
export function isConsultancyAccount(profile?: AccountRoleLike | null): boolean {
  if (!profile) return false;
  const role = normalizeStr(profile.role);
  const layer = normalizeBusinessLayer(profile.businessLayer);
  const caps = getNormalizedCapabilities(profile);

  if (role === "business" && layer === "consultancy") {
    return true;
  }
  return caps.includes("consultant");
}

/**
 * Returns true if the account is a Business -> Property & Asset Management
 * account (landlord, letting/estate agency, block manager, housing association).
 */
export function isPropertyBusinessAccount(profile?: AccountRoleLike | null): boolean {
  if (!profile) return false;
  const role = normalizeStr(profile.role);
  const layer = normalizeBusinessLayer(profile.businessLayer);

  if (role === "business" && layer === "properties") {
    return true;
  }
  return false;
}

/**
 * Returns true if the account is a pure Property Business (i.e. manages
 * properties / hires trades rather than selling trade or consultancy services).
 */
export function isPropertyOnlyBusinessAccount(profile?: AccountRoleLike | null): boolean {
  return (
    isPropertyBusinessAccount(profile) &&
    !isTradeProviderAccount(profile) &&
    !isConsultancyAccount(profile)
  );
}

/**
 * Returns true if the account should publish a public service provider listing
 * in `public_profiles` and show provider profile cards (Trade or Consultancy).
 */
export function isServiceProviderProfile(profile?: AccountRoleLike | null): boolean {
  return isTradeProviderAccount(profile) || isConsultancyAccount(profile);
}

/**
 * Returns true if the account is eligible for Stripe Connect Express payout
 * onboarding / receiving marketplace payouts.
 *
 * Explicitly blocks `business` accounts with `businessLayer === "properties"`
 * unless they ALSO have an explicit trade, consultancy, or driver capability.
 */
export function isPayoutEligibleAccount(profile?: AccountRoleLike | null): boolean {
  if (!profile) return false;
  const role = normalizeStr(profile.role);
  if (role === "admin" || role === "super_admin") return true;

  if (isTradeProviderAccount(profile) || isConsultancyAccount(profile) || isAnyRollerDriverAccount(profile)) {
    return true;
  }

  return false;
}

/**
 * Returns the Business Hub domain tab(s) allowed for a `"business"` account.
 * Prevents cross-layer tab leakage (e.g., Property businesses do not see
 * Trades & Services or Consultancy tabs).
 */
export function getAllowedBusinessLayers(
  profile?: AccountRoleLike | null
): Array<"properties" | "field_services" | "consultancy"> {
  if (!profile) return ["properties"];
  if (isAdminAccount(profile)) {
    return ["properties", "field_services", "consultancy"];
  }

  const normalized = normalizeBusinessLayer(profile.businessLayer);
  const allowed: Array<"properties" | "field_services" | "consultancy"> = [];

  if (normalized) {
    allowed.push(normalized);
  }

  // Dual-capability support without opening unrelated tabs
  const caps = getNormalizedCapabilities(profile);
  if (
    (caps.includes("landlord") || caps.includes("property_manager") || caps.includes("estate_agent")) &&
    !allowed.includes("properties")
  ) {
    allowed.push("properties");
  }
  if (
    (caps.includes("tradesperson") || caps.includes("contractor")) &&
    !allowed.includes("field_services")
  ) {
    allowed.push("field_services");
  }
  if (caps.includes("consultant") && !allowed.includes("consultancy")) {
    allowed.push("consultancy");
  }

  if (allowed.length === 0) {
    // Legacy business account created before businessLayer existed
    return ["properties"];
  }

  return allowed;
}

/**
 * Default Business Hub tab for a `"business"` account.
 */
export function getDefaultBusinessTab(
  profile?: AccountRoleLike | null
): "properties" | "field_services" | "consultancy" {
  const normalized = normalizeBusinessLayer(profile?.businessLayer);
  if (normalized) return normalized;
  return getAllowedBusinessLayers(profile)[0] || "properties";
}

export interface ProfileRoleView {
  isServiceProvider: boolean;
  isPropertyOnlyBusiness: boolean;
  isDriver: boolean;
  isHomeownerOrPropertyBilling: boolean;
  isPayoutEligible: boolean;
  shouldLoadProviderReviews: boolean;
  shouldLoadMonthlyQuoteUsage: boolean;
  shouldSyncPublicProfile: boolean;
  shouldShowAnyRollerPassengerView: boolean;
  shouldShowRiderRatingBadge: boolean;
  tierCatalogBucket: "homeowners" | "on_demand_transport" | "one_off_trades";
  subscriptionRoleScope: "landlord" | "driver_gold" | "tier";
}

/**
 * Single source of truth for Profile & Identity Card role-dependent rendering
 * and Firestore listener gating. Fixes historical mismatches where `"business"`
 * trade providers missed reviews/usage and `"fleet_driver"` was treated as a
 * passenger or tradesperson.
 */
export function resolveProfileRoleView(
  profile?: (AccountRoleLike & { subscriptionType?: string | null }) | null,
  activePortal: string = "anytrader"
): ProfileRoleView {
  const role = normalizeStr(profile?.role);
  const isServiceProvider = isServiceProviderProfile(profile);
  const isPropertyOnlyBusiness = isPropertyOnlyBusinessAccount(profile);
  const isDriver = isAnyRollerDriverAccount(profile);
  const isHomeownerOrPropertyBilling =
    role === "homeowner" || role === "customer" || isPropertyOnlyBusiness;
  const isPayoutEligible = isPayoutEligibleAccount(profile) || Boolean(profile?.stripeAccountId);

  const tierCatalogBucket: ProfileRoleView["tierCatalogBucket"] = isHomeownerOrPropertyBilling
    ? "homeowners"
    : isDriver && !isServiceProvider
    ? "on_demand_transport"
    : "one_off_trades";

  const subscriptionRoleScope: ProfileRoleView["subscriptionRoleScope"] = isHomeownerOrPropertyBilling
    ? "landlord"
    : isDriver && (normalizeStr(profile?.subscriptionType) === "driver_gold" || !isServiceProvider)
    ? "driver_gold"
    : "tier";

  const isAnyRoller = activePortal === "anyroller";

  return {
    isServiceProvider,
    isPropertyOnlyBusiness,
    isDriver,
    isHomeownerOrPropertyBilling,
    isPayoutEligible,
    shouldLoadProviderReviews: isServiceProvider,
    shouldLoadMonthlyQuoteUsage: isServiceProvider,
    shouldSyncPublicProfile: isServiceProvider,
    shouldShowAnyRollerPassengerView: isAnyRoller && !isDriver,
    shouldShowRiderRatingBadge: isAnyRoller && !isDriver,
    tierCatalogBucket,
    subscriptionRoleScope,
  };
}

