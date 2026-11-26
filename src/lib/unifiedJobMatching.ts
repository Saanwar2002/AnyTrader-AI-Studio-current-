/**
 * AnyTrader Unified Job-to-Trader Matching Engine (Single Source of Truth)
 *
 * Shared across Server Lead Distribution, Paid Instant Match, Client Job Feed,
 * Trader Notification Digest, TradesDashboard Recommendations, Quote Comparison,
 * and Pro Matchmaker so all eligibility gates, geographic distance math, category
 * matching, certification checks, quiet hours, Priority Offers (`exclusiveUntil`),
 * calendar availability, and scoring stay 100% consistent across AnyTrader.
 *
 * NOTE: Scoped strictly to AnyTrader. Does not alter AnyRoller or locked AI TradeBot logic.
 */

import {
  computeGeodesicDistanceMiles,
  extractExplicitGeoPoint,
  resolvePostcodeCentroid,
} from "./geoDistance.ts";
import { getOutwardPostcode } from "./utils.ts";
import { isProfileAcceptingNewWork, normalizeJobUrgency } from "./marketplaceContracts.ts";
import { getRequiredCertificationsForTrades, isCategoryRegulated } from "./traderCompliance.ts";

export interface UnifiedMatchFactor {
  name: string;
  score: number;
  weight: number;
  status: "excellent" | "good" | "fair" | "poor";
  details: string;
}

export interface UnifiedMatchResult {
  compositeScore: number; // 0 to 100
  matchTier: "Perfect Match" | "High Match" | "Good Match" | "Fair Match";
  distanceMiles: number | null;
  geoMatchType: GeoFitResult["matchType"];
  categoryMatchLevel: CategoryAlignmentResult["matchLevel"];
  isCalendarConflict: boolean;
  isExclusiveLocked: boolean;
  signalsEvaluated: number;
  breakdown: {
    skillRelevance: number;
    locationProximity: number;
    reputationTrust: number;
    complianceInsurance: number;
    availabilityVelocity: number;
  };
  factors: UnifiedMatchFactor[];
  keyHighlights: string[];
}

export interface GeoFitResult {
  withinRadius: boolean;
  distanceMiles: number | null;
  radiusMiles: number;
  matchType:
    | "exact_geo"
    | "outward_postcode"
    | "same_area_postcode"
    | "centroid_radius"
    | "service_area"
    | "no_job_location"
    | "out_of_radius"
    | "unlocatable";
}

export interface CategoryAlignmentResult {
  matched: boolean;
  matchLevel: "exact_category" | "synonym" | "subcategory_service" | "tag_skill" | "none";
  matchedCategory: string | null;
  matchedSubcategory: string | null;
  matchedTagsCount: number;
}

export interface CertificationEligibilityResult {
  eligible: boolean;
  isRegulated: boolean;
  missingCertifications: string[];
  reason: string | null;
}

export const DEFAULT_TRADER_RADIUS_MILES = 25;
export const MAX_TRADER_RADIUS_MILES = 150;

// ---------------------------------------------------------------------------
// 1. Canonical Field Normalizers (works across /jobs AND /public_job_cards)
// ---------------------------------------------------------------------------

export function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function normalizeTradeToken(value: unknown): string {
  return normalizeText(value)
    .replace(/\band\b/g, " ")
    .replace(/&/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizePostcodeRaw(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().toUpperCase().replace(/\s+/g, "");
}

export function extractOutwardCodeSafe(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "";
  const outward = getOutwardPostcode(value);
  if (!outward || outward === "Area Hidden") return "";
  return outward.toUpperCase();
}

export function extractPostcodeAreaPrefix(value: unknown): string {
  const outward = extractOutwardCodeSafe(value);
  const candidate = outward || normalizePostcodeRaw(value);
  const match = candidate.match(/^([A-Z]{1,2})/);
  return match ? match[1] : "";
}

/**
 * Resolves the best available postcode or outward postcode area from EITHER
 * a private `/jobs/{id}` document OR a sanitized `/public_job_cards/{id}` document.
 */
export function extractJobPostcode(job: Record<string, any> | null | undefined): string {
  if (!job || typeof job !== "object") return "";
  const candidates = [
    job.postcode,
    job.postcodeArea,
    job.address?.postcode,
    job.location?.postcode,
    job.jobPostcodeArea,
    job.area,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !candidate.trim()) continue;
    const outward = extractOutwardCodeSafe(candidate);
    if (outward) {
      // Preserve full postcode if candidate looks like a full postcode, otherwise return outward code
      const cleaned = candidate.trim().toUpperCase();
      if (/^[A-Z]{1,2}[0-9][A-Z0-9]?\s*[0-9][A-Z]{2}$/.test(cleaned)) {
        return cleaned;
      }
      return outward;
    }
  }
  return "";
}

/**
 * Resolves job sub-category consistently across camelCase (`subCategory`) and lowercase (`subcategory`).
 */
export function extractJobSubCategory(job: Record<string, any> | null | undefined): string {
  if (!job || typeof job !== "object") return "";
  const raw =
    job.subCategory ||
    job.subcategory ||
    (Array.isArray(job.subcategories) && job.subcategories.length > 0 ? job.subcategories[0] : "") ||
    "";
  return typeof raw === "string" ? raw.trim() : "";
}

/**
 * Resolves target job date consistently across `preferredDate`, `jobDate`, and `requiredDate`.
 */
export function extractJobDate(job: Record<string, any> | null | undefined): string | null {
  if (!job || typeof job !== "object") return null;
  const raw = job.preferredDate || job.jobDate || job.requiredDate || null;
  if (!raw) return null;
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  if (typeof raw === "object" && typeof raw.toDate === "function") {
    try {
      return raw.toDate().toISOString().slice(0, 10);
    } catch {
      return null;
    }
  }
  return null;
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean);
  }
  if (typeof value === "string" && value.trim()) {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

export function extractTraderCategories(trader: Record<string, any> | null | undefined): string[] {
  if (!trader || typeof trader !== "object") return [];
  const list = [
    ...toStringArray(trader.trades),
    ...toStringArray(trader.categories),
    ...toStringArray(trader.verifiedCategories),
    trader.primaryTrade,
    trader.trade,
    trader.category,
    trader.tradeCategory,
    trader.businessCategory,
    trader.selectedCategory,
  ]
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map((v) => v.trim());

  const seen = new Set<string>();
  const unique: string[] = [];
  for (const entry of list) {
    const key = entry.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(entry);
    }
  }
  return unique;
}

export function extractTraderServices(trader: Record<string, any> | null | undefined): string[] {
  if (!trader || typeof trader !== "object") return [];
  const list = [
    ...toStringArray(trader.services),
    ...toStringArray(trader.subcategories),
    ...toStringArray(trader.subCategories),
  ];
  return Array.from(new Set(list.map((s) => s.trim()).filter(Boolean)));
}

export function extractTraderTags(trader: Record<string, any> | null | undefined): string[] {
  if (!trader || typeof trader !== "object") return [];
  const list = [
    ...toStringArray(trader.tags),
    ...toStringArray(trader.skills),
    ...toStringArray(trader.specialties),
  ];
  return Array.from(new Set(list.map((t) => t.trim()).filter(Boolean)));
}

export function extractTraderReviewCount(trader: Record<string, any> | null | undefined): number {
  if (!trader || typeof trader !== "object") return 0;
  const raw = trader.totalReviews ?? trader.reviewCount ?? trader.reviewsCount ?? 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export function extractTraderRating(trader: Record<string, any> | null | undefined): number {
  if (!trader || typeof trader !== "object") return 0;
  const raw = trader.rating ?? trader.averageRating ?? 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(5, Math.max(0, n)) : 0;
}

export function extractTraderRadiusMiles(
  trader: Record<string, any> | null | undefined,
  fallback: number = DEFAULT_TRADER_RADIUS_MILES
): number {
  if (!trader || typeof trader !== "object") return fallback;
  const raw =
    trader.coverageRadiusMiles ??
    trader.serviceRadius ??
    trader.notificationSettings?.radiusMiles ??
    trader.matchNotificationSettings?.radiusMiles;
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.min(MAX_TRADER_RADIUS_MILES, Math.max(1, parsed));
  }
  return fallback;
}

export function isTraderVideoVerified(trader: Record<string, any> | null | undefined): boolean {
  if (!trader || typeof trader !== "object") return false;
  return trader.videoVerificationStatus === "verified" || trader.isVideoVerified === true;
}

export function isTraderFullyVerified(trader: Record<string, any> | null | undefined): boolean {
  if (!trader || typeof trader !== "object") return false;
  if (trader.isVerified === true) return true;
  return normalizeText(trader.verificationStatus) === "verified";
}

// ---------------------------------------------------------------------------
// 2. Geodesic & Postcode-Centroid Distance Engine
// ---------------------------------------------------------------------------

export function computeJobTraderDistance(
  trader: Record<string, any> | null | undefined,
  job: Record<string, any> | null | undefined,
  explicitTraderCoords?: { lat: number; lng: number } | null
): { distanceMiles: number | null; matchType: GeoFitResult["matchType"] } {
  if (!trader || !job) return { distanceMiles: null, matchType: "unlocatable" };

  const traderCoords = explicitTraderCoords || extractExplicitGeoPoint(trader);
  const jobCoords = extractExplicitGeoPoint(job);

  // 1. Exact coordinates on both ends
  if (traderCoords && jobCoords) {
    const miles = computeGeodesicDistanceMiles(
      { coords: traderCoords },
      { coords: jobCoords }
    );
    return {
      distanceMiles: miles !== null ? Math.round(miles * 10) / 10 : null,
      matchType: "exact_geo",
    };
  }

  const traderPostcode =
    (typeof trader.postcode === "string" && trader.postcode.trim()) ||
    (typeof trader.postcodeArea === "string" && trader.postcodeArea.trim()) ||
    "";
  const jobPostcode = extractJobPostcode(job);

  const traderOutward = extractOutwardCodeSafe(traderPostcode);
  const jobOutward = extractOutwardCodeSafe(jobPostcode);
  const traderArea = extractPostcodeAreaPrefix(traderPostcode);
  const jobArea = extractPostcodeAreaPrefix(jobPostcode);

  // 2. Same outward postcode (e.g. SW1A vs SW1A) when exact coords aren't available on both ends
  if (traderOutward && jobOutward && traderOutward === jobOutward) {
    return { distanceMiles: 1.5, matchType: "outward_postcode" };
  }

  // 3. Same UK postcode area prefix with different outward codes (e.g. SW1A vs SW11)
  if (!traderCoords && !jobCoords && traderArea && jobArea && traderArea === jobArea) {
    return { distanceMiles: 5.0, matchType: "same_area_postcode" };
  }

  // 4. Geodesic distance using explicit coords + UK postcode area centroid fallback
  // Solves cross-area proximity accurately (e.g. SW1 <-> SE1 = ~2.4 mi; SW1 <-> M1 = ~163 mi)
  const centroidMiles = computeGeodesicDistanceMiles(
    { coords: traderCoords, postcode: traderPostcode || null },
    { coords: jobCoords, postcode: jobPostcode || null }
  );

  if (centroidMiles !== null) {
    return {
      distanceMiles: Math.round(centroidMiles * 10) / 10,
      matchType: "centroid_radius",
    };
  }

  // 5. Fallback when traderPostcode / jobPostcode cannot map to centroid
  if (traderPostcode && jobPostcode && normalizePostcodeRaw(traderPostcode) === normalizePostcodeRaw(jobPostcode)) {
    return { distanceMiles: 1.0, matchType: "outward_postcode" };
  }

  return { distanceMiles: null, matchType: "unlocatable" };
}

/**
 * Evaluates whether a trader covers a job's geographic location.
 * Uses exact Haversine -> outward postcode -> UK postcode area centroid -> serviceAreas/city fallback.
 */
export function evaluateGeographicFit(
  trader: Record<string, any> | null | undefined,
  job: Record<string, any> | null | undefined,
  options?: {
    overrideRadiusMiles?: number | null;
    extraRadiusMiles?: number;
    explicitTraderCoords?: { lat: number; lng: number } | null;
  }
): GeoFitResult {
  const baseRadius =
    options?.overrideRadiusMiles && options.overrideRadiusMiles > 0
      ? options.overrideRadiusMiles
      : extractTraderRadiusMiles(trader, DEFAULT_TRADER_RADIUS_MILES);
  const effectiveRadius = Math.min(
    MAX_TRADER_RADIUS_MILES,
    baseRadius + Math.max(0, options?.extraRadiusMiles || 0)
  );

  const jobCoords = extractExplicitGeoPoint(job);
  const jobPostcode = extractJobPostcode(job);
  const jobCity = normalizeText(job?.city || job?.address?.city);
  const jobAreaText = normalizeText(job?.area);

  // If the job genuinely carries no location information at all, do not falsely reject
  if (!jobCoords && !jobPostcode && !jobCity && !jobAreaText) {
    return {
      withinRadius: true,
      distanceMiles: null,
      radiusMiles: effectiveRadius,
      matchType: "no_job_location",
    };
  }

  const dist = computeJobTraderDistance(trader, job, options?.explicitTraderCoords);
  if (dist.distanceMiles !== null) {
    if (dist.distanceMiles <= effectiveRadius) {
      return {
        withinRadius: true,
        distanceMiles: dist.distanceMiles,
        radiusMiles: effectiveRadius,
        matchType: dist.matchType,
      };
    }
    return {
      withinRadius: false,
      distanceMiles: dist.distanceMiles,
      radiusMiles: effectiveRadius,
      matchType: "out_of_radius",
    };
  }

  // Check trader explicit serviceAreas / city against job city or postcode area
  const serviceAreas = [
    ...toStringArray(trader?.serviceAreas),
    ...(typeof trader?.city === "string" ? [trader.city] : []),
    ...(typeof trader?.location === "string" ? [trader.location] : []),
  ]
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length >= 2);

  const jobLocationTokens = [
    extractOutwardCodeSafe(jobPostcode).toLowerCase(),
    extractPostcodeAreaPrefix(jobPostcode).toLowerCase(),
    jobCity,
    jobAreaText,
  ].filter((s) => s.length >= 2);

  if (
    serviceAreas.length > 0 &&
    jobLocationTokens.some((tok) =>
      serviceAreas.some((area) => area === tok || (tok.length >= 3 && area.includes(tok)) || (area.length >= 3 && tok.includes(area)))
    )
  ) {
    return {
      withinRadius: true,
      distanceMiles: null,
      radiusMiles: effectiveRadius,
      matchType: "service_area",
    };
  }

  // If trader has UK postcode centroid and job has valid postcode, resolvePostcodeCentroid would have matched above.
  // Failing closed prevents cross-country mismatches when location is specified on the job.
  const hasJobCentroid = Boolean(jobCoords || resolvePostcodeCentroid(jobPostcode));
  if (hasJobCentroid) {
    return {
      withinRadius: false,
      distanceMiles: null,
      radiusMiles: effectiveRadius,
      matchType: "unlocatable",
    };
  }

  return {
    withinRadius: false,
    distanceMiles: null,
    radiusMiles: effectiveRadius,
    matchType: "unlocatable",
  };
}

// ---------------------------------------------------------------------------
// 3. Category & Regulated Certification Alignment
// ---------------------------------------------------------------------------

function safeTokenContains(haystack: string, needle: string): boolean {
  if (!haystack || !needle) return false;
  if (haystack === needle) return true;
  if (needle.length < 3) return false;
  // Require word-boundary start match so short fragments like "car" don't match "scaffolding"
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`(^|\\s)${escaped}`, "i");
  return regex.test(haystack);
}

/**
 * Evaluates whether a trader's registered trades, services, or tags align with a job.
 * Preserves strict intra-domain separation: out-of-domain trades never match.
 */
export function evaluateCategoryAlignment(
  trader: Record<string, any> | null | undefined,
  job: Record<string, any> | null | undefined,
  options?: {
    mode?: "strict" | "relaxed";
    categorySynonyms?: string[];
    categoryRelatedTerms?: string[];
  }
): CategoryAlignmentResult {
  const mode = options?.mode || "strict";
  const jobCatRaw = typeof job?.category === "string" ? job.category.trim() : "";
  const jobCat = normalizeText(jobCatRaw);
  const normJobCat = normalizeTradeToken(jobCatRaw);

  if (!jobCat || !trader) {
    return {
      matched: false,
      matchLevel: "none",
      matchedCategory: null,
      matchedSubcategory: null,
      matchedTagsCount: 0,
    };
  }

  const jobSubRaw = extractJobSubCategory(job);
  const jobSub = normalizeText(jobSubRaw);
  const normJobSub = normalizeTradeToken(jobSubRaw);
  const jobTitle = normalizeTradeToken(job?.title);
  const jobDesc = normalizeTradeToken(job?.description);
  const jobText = `${jobTitle} ${jobDesc}`.trim();

  const traderCategories = extractTraderCategories(trader);
  const traderServices = extractTraderServices(trader);
  const traderTags = extractTraderTags(trader);

  const synonyms = (options?.categorySynonyms || []).map((s) => normalizeTradeToken(s)).filter(Boolean);
  const relatedTerms = (options?.categoryRelatedTerms || []).map((s) => normalizeTradeToken(s)).filter(Boolean);

  // Count matched tags (for scoring granularity)
  const matchedTagsCount = traderTags.filter((tag) => {
    const normTag = normalizeTradeToken(tag);
    if (normTag.length < 3) return false;
    return (
      safeTokenContains(normJobCat, normTag) ||
      safeTokenContains(normJobSub, normTag) ||
      safeTokenContains(jobText, normTag)
    );
  }).length;

  // 1. Direct or normalized primary category match
  for (const cat of traderCategories) {
    const catLower = normalizeText(cat);
    const normCat = normalizeTradeToken(cat);
    if (
      catLower === jobCat ||
      normCat === normJobCat ||
      safeTokenContains(normJobCat, normCat) ||
      safeTokenContains(normCat, normJobCat)
    ) {
      return {
        matched: true,
        matchLevel: "exact_category",
        matchedCategory: cat,
        matchedSubcategory: jobSubRaw || null,
        matchedTagsCount,
      };
    }
  }

  // 2. Canonical synonym match against registered trader categories
  if (synonyms.length > 0) {
    for (const cat of traderCategories) {
      const normCat = normalizeTradeToken(cat);
      if (synonyms.some((syn) => syn === normCat || safeTokenContains(syn, normCat) || safeTokenContains(normCat, syn))) {
        return {
          matched: true,
          matchLevel: "synonym",
          matchedCategory: cat,
          matchedSubcategory: jobSubRaw || null,
          matchedTagsCount,
        };
      }
    }
  }

  // 3. Direct registered service / subcategory match
  for (const service of traderServices) {
    const normService = normalizeTradeToken(service);
    if (normService.length < 3) continue;
    if (
      (normJobSub && (normService === normJobSub || safeTokenContains(normJobSub, normService) || safeTokenContains(normService, normJobSub))) ||
      safeTokenContains(normJobCat, normService)
    ) {
      return {
        matched: true,
        matchLevel: "subcategory_service",
        matchedCategory: traderCategories[0] || null,
        matchedSubcategory: service,
        matchedTagsCount,
      };
    }
  }

  // 4. Relaxed mode only: allow related terms or verified tag/service overlap with title/category
  // while NEVER allowing completely unrelated random categories
  if (mode === "relaxed") {
    if (relatedTerms.length > 0) {
      for (const cat of traderCategories) {
        const normCat = normalizeTradeToken(cat);
        if (relatedTerms.some((term) => term === normCat || safeTokenContains(term, normCat) || safeTokenContains(normCat, term))) {
          return {
            matched: true,
            matchLevel: "synonym",
            matchedCategory: cat,
            matchedSubcategory: null,
            matchedTagsCount,
          };
        }
      }
    }

    for (const service of traderServices) {
      const normService = normalizeTradeToken(service);
      if (normService.length >= 4 && safeTokenContains(jobTitle, normService)) {
        return {
          matched: true,
          matchLevel: "subcategory_service",
          matchedCategory: traderCategories[0] || null,
          matchedSubcategory: service,
          matchedTagsCount,
        };
      }
    }

    if (matchedTagsCount > 0) {
      return {
        matched: true,
        matchLevel: "tag_skill",
        matchedCategory: traderCategories[0] || null,
        matchedSubcategory: null,
        matchedTagsCount,
      };
    }
  }

  return {
    matched: false,
    matchLevel: "none",
    matchedCategory: null,
    matchedSubcategory: null,
    matchedTagsCount,
  };
}

/**
 * Enforces regulated trade certification eligibility during matching & dispatch.
 * - Regulated job categories require a fully verified trader (never provisional/unverified).
 * - If the job explicitly lists `requiredCertifications` (e.g. ["Gas Safe", "NICEIC"]), checks
 *   whether the trader's profile carries those credentials or is verified for that regulated trade.
 */
export function evaluateCertificationEligibility(
  trader: Record<string, any> | null | undefined,
  job: Record<string, any> | null | undefined
): CertificationEligibilityResult {
  if (!trader || !job) {
    return { eligible: false, isRegulated: false, missingCertifications: [], reason: "missing_entity" };
  }

  const jobCategory = typeof job.category === "string" ? job.category.trim() : "";
  const jobIsRegulated = Boolean(jobCategory && isCategoryRegulated(jobCategory));
  const requiredCertsFromCategory = jobCategory
    ? getRequiredCertificationsForTrades([jobCategory]).requiredCertifications
    : [];
  const explicitJobCerts = toStringArray(job.requiredCertifications);
  const allRequired = Array.from(new Set([...explicitJobCerts, ...requiredCertsFromCategory]));

  const verStatus = normalizeText(trader.verificationStatus);
  const isExplicitlyNotVerified =
    trader.isVerified === false ||
    [
      "provisional",
      "unverified",
      "pending",
      "pending_review",
      "rejected",
      "revoked",
      "expired",
      "suspended",
    ].includes(verStatus);

  const fullyVerified = isTraderFullyVerified(trader);

  if (jobIsRegulated && isExplicitlyNotVerified) {
    return {
      eligible: false,
      isRegulated: true,
      missingCertifications: allRequired,
      reason: "regulated_trade_requires_verified_trader",
    };
  }

  if (explicitJobCerts.length > 0) {
    const traderCertBlob = [
      ...toStringArray(trader.certifications),
      ...toStringArray(trader.accreditations),
      ...toStringArray(trader.qualifications),
      ...toStringArray(trader.verifiedCategories),
      trader.gasSafeNumber || trader.isGasSafe ? "gas safe" : "",
      trader.niceicNumber || trader.isNiceic ? "niceic part p" : "",
      trader.cscsNumber || trader.hasCscsCard ? "cscs" : "",
      trader.fensaNumber || trader.isFensa ? "fensa" : "",
      trader.oftecNumber || trader.isOftec ? "oftec" : "",
    ]
      .join(" ")
      .toLowerCase();

    const missing = explicitJobCerts.filter((cert) => {
      const token = normalizeTradeToken(cert);
      if (!token) return false;
      // Match either full cert string or key prefix (e.g. "gas safe" inside "Gas Safe Registered")
      const keywords = token.split(" ").filter((w) => w.length >= 3);
      if (traderCertBlob.includes(token)) return true;
      if (keywords.length > 0 && keywords.every((kw) => traderCertBlob.includes(kw))) return true;
      return false;
    });

    // Only hard-block on explicit job cert list if trader is not verified for that specific category AND lacks the cert markers
    const verifiedInJobCat =
      fullyVerified &&
      toStringArray(trader.verifiedCategories).some(
        (c) => normalizeTradeToken(c) === normalizeTradeToken(jobCategory)
      );

    if (missing.length > 0 && !verifiedInJobCat) {
      return {
        eligible: false,
        isRegulated: jobIsRegulated || explicitJobCerts.length > 0,
        missingCertifications: missing,
        reason: "missing_required_certifications",
      };
    }
  }

  return {
    eligible: true,
    isRegulated: jobIsRegulated,
    missingCertifications: [],
    reason: null,
  };
}

// ---------------------------------------------------------------------------
// 4. Priority Offers (`exclusiveUntil`), Quiet Hours & Calendar Availability
// ---------------------------------------------------------------------------

export function parseTimestampToMs(value: unknown): number | null {
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

export function isWithinExclusiveWindow(
  job: Record<string, any> | null | undefined,
  nowMs: number = Date.now()
): boolean {
  if (!job?.exclusiveUntil) return false;
  const untilMs = parseTimestampToMs(job.exclusiveUntil);
  return untilMs !== null && untilMs > nowMs;
}

export function hasExclusiveLeadAccess(trader: Record<string, any> | null | undefined): boolean {
  if (!trader || typeof trader !== "object") return false;
  if (trader.hasExclusiveAddon === true && trader.isExclusiveActive !== false) return true;
  if (trader.priorityOffersEnabled === true) return true;
  const tier = normalizeText(trader.tier || trader.tierId || trader.subscriptionTier);
  return ["pro", "gold", "enterprise", "business_pro", "priority"].includes(tier) &&
    normalizeText(trader.subscriptionStatus || "active") === "active";
}

export function isTraderInQuietHours(
  trader: Record<string, any> | null | undefined,
  nowDate: Date = new Date()
): boolean {
  const settings = trader?.notificationSettings;
  if (!settings || settings.quietHoursEnabled !== true) return false;
  if (typeof settings.quietHoursStart !== "string" || typeof settings.quietHoursEnd !== "string") {
    return false;
  }

  const startParts = settings.quietHoursStart.split(":").map(Number);
  const endParts = settings.quietHoursEnd.split(":").map(Number);
  if (
    startParts.length < 2 ||
    endParts.length < 2 ||
    !Number.isFinite(startParts[0]) ||
    !Number.isFinite(startParts[1]) ||
    !Number.isFinite(endParts[0]) ||
    !Number.isFinite(endParts[1])
  ) {
    return false;
  }

  const currentMins = nowDate.getHours() * 60 + nowDate.getMinutes();
  const startMins = startParts[0] * 60 + startParts[1];
  const endMins = endParts[0] * 60 + endParts[1];

  if (startMins === endMins) return false;
  if (startMins > endMins) {
    // Overnight window (e.g. 22:00 -> 07:00)
    return currentMins >= startMins || currentMins <= endMins;
  }
  // Same-day window (e.g. 13:00 -> 15:00)
  return currentMins >= startMins && currentMins <= endMins;
}

const WEEKDAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/**
 * Checks whether a trader's calendar (`dateOverrides` and weekly `availability`)
 * is free for a given job date (`YYYY-MM-DD` or ISO timestamp).
 */
export function isTraderCalendarAvailableForDate(
  trader: Record<string, any> | null | undefined,
  jobDateStr: string | null | undefined
): boolean {
  if (!trader || !jobDateStr) return true;
  const dateKey = String(jobDateStr).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return true;

  // 1. Explicit date override takes precedence
  const overrides = trader.dateOverrides;
  if (overrides && typeof overrides === "object" && overrides[dateKey] !== undefined) {
    const raw = overrides[dateKey];
    const statusStr = normalizeText(typeof raw === "string" ? raw : raw?.status);
    if (["busy", "booked", "unavailable", "off", "holiday", "blocked"].includes(statusStr)) {
      return false;
    }
    if (raw === false || raw?.available === false) {
      return false;
    }
    if (["available", "open", "free"].includes(statusStr) || raw === true || raw?.available === true) {
      return true;
    }
  }

  // 2. Weekly schedule fallback (only blocks if explicitly configured as false/unavailable)
  const weekly = trader.availability;
  if (weekly && typeof weekly === "object") {
    const parsedDate = new Date(`${dateKey}T12:00:00Z`);
    if (!Number.isNaN(parsedDate.getTime())) {
      const dayName = WEEKDAY_NAMES[parsedDate.getUTCDay()];
      const dayEntry =
        weekly[dayName] ??
        weekly[dayName.slice(0, 3)] ??
        weekly[dayName.charAt(0).toUpperCase() + dayName.slice(1)];
      if (dayEntry === false) return false;
      if (dayEntry && typeof dayEntry === "object") {
        if (dayEntry.available === false || dayEntry.enabled === false || dayEntry.isAvailable === false) {
          return false;
        }
      }
    }
  }

  return true;
}

// ---------------------------------------------------------------------------
// 5. Real Behavioral & Fairness Signals (No Fake Constants)
// ---------------------------------------------------------------------------

export interface BehavioralFairnessResult {
  bonusPoints: number; // -20 to +24
  responseVelocityScore: number; // 0 to 100
  highlights: string[];
}

export function computeBehavioralAndFairnessScore(
  trader: Record<string, any> | null | undefined
): BehavioralFairnessResult {
  if (!trader || typeof trader !== "object") {
    return { bonusPoints: 0, responseVelocityScore: 50, highlights: [] };
  }

  let bonusPoints = 0;
  let responseVelocityScore = 55; // Honest neutral baseline when no history exists yet
  const highlights: string[] = [];

  // 1. Real response speed (median or exponential moving average in minutes)
  const respMinsRaw = trader.medianResponseMinutes ?? trader.avgResponseMinutes;
  const respMins = Number(respMinsRaw);
  if (Number.isFinite(respMins) && respMins > 0) {
    if (respMins <= 15) {
      bonusPoints += 12;
      responseVelocityScore = 98;
      highlights.push(`Fast Responder (~${Math.round(respMins)}m avg)`);
    } else if (respMins <= 45) {
      bonusPoints += 8;
      responseVelocityScore = 85;
      highlights.push(`Quick Responder (~${Math.round(respMins)}m avg)`);
    } else if (respMins <= 120) {
      bonusPoints += 4;
      responseVelocityScore = 70;
    } else if (respMins > 360) {
      bonusPoints -= 4;
      responseVelocityScore = 35;
    }
  }

  // 2. Quote-to-win conversion rate (only when meaningful sample >= 3 quotes)
  const explicitWinRate = Number(trader.quoteWinRate);
  const quotesSubmitted = Number(trader.quotesSubmitted ?? 0);
  const completedJobs = Number(trader.completedJobs ?? trader.jobsCompleted ?? 0);
  const winRate =
    Number.isFinite(explicitWinRate) && explicitWinRate > 0
      ? explicitWinRate
      : quotesSubmitted >= 3
      ? Math.min(1, completedJobs / quotesSubmitted)
      : null;

  if (winRate !== null) {
    if (winRate >= 0.4) {
      bonusPoints += 8;
      highlights.push("High Quote Conversion");
    } else if (winRate >= 0.2) {
      bonusPoints += 4;
    }
  }

  // 3. Active workload capacity dampening (prevents overloading maxed-out traders)
  const activeJobsCount = Number(trader.activeJobsCount ?? 0);
  if (Number.isFinite(activeJobsCount)) {
    if (activeJobsCount >= 10) {
      bonusPoints -= 12;
      responseVelocityScore = Math.max(20, responseVelocityScore - 25);
    } else if (activeJobsCount >= 6) {
      bonusPoints -= 6;
      responseVelocityScore = Math.max(30, responseVelocityScore - 10);
    }
  }

  // 4. Fairness rotation dampening + Newcomer discovery boost
  const recentLeads24h = Number(trader.recentLeadsReceived24h ?? 0);
  if (Number.isFinite(recentLeads24h) && recentLeads24h > 5) {
    const dampen = Math.min(12, (recentLeads24h - 5) * 2);
    bonusPoints -= dampen;
  }

  if (isTraderFullyVerified(trader) && completedJobs < 3) {
    bonusPoints += 6;
    highlights.push("Verified Newcomer Boost");
  }

  return {
    bonusPoints: Math.max(-20, Math.min(24, bonusPoints)),
    responseVelocityScore: Math.max(0, Math.min(100, responseVelocityScore)),
    highlights,
  };
}

// ---------------------------------------------------------------------------
// 6. Scoring Engine A: Trader-Facing "Job Fit Score" (JobFeed & Dashboard)
// ---------------------------------------------------------------------------

/**
 * Scores how well a specific job fits a specific tradesperson (0-100).
 * Every dimension varies per job (no constant trader-quality padding), so
 * Job Feed "Best Match" genuinely ranks the best opportunities at the top.
 */
export function scoreJobFitForTrader(
  trader: Record<string, any> | null | undefined,
  job: Record<string, any> | null | undefined,
  options?: {
    explicitTraderCoords?: { lat: number; lng: number } | null;
    categorySynonyms?: string[];
    categoryRelatedTerms?: string[];
    mode?: "strict" | "relaxed";
    nowMs?: number;
  }
): UnifiedMatchResult {
  const factors: UnifiedMatchFactor[] = [];
  const keyHighlights: string[] = [];

  const catAlign = evaluateCategoryAlignment(trader, job, {
    mode: options?.mode || "relaxed",
    categorySynonyms: options?.categorySynonyms,
    categoryRelatedTerms: options?.categoryRelatedTerms,
  });

  const certCheck = evaluateCertificationEligibility(trader, job);
  const geoFit = evaluateGeographicFit(trader, job, {
    explicitTraderCoords: options?.explicitTraderCoords,
  });

  const jobDate = extractJobDate(job);
  const isCalendarFree = isTraderCalendarAvailableForDate(trader, jobDate);
  const isExclusiveLocked =
    isWithinExclusiveWindow(job, options?.nowMs) && !hasExclusiveLeadAccess(trader);

  // 1. Skill & Trade Alignment (35% weight)
  let skillScore = 0;
  if (catAlign.matchLevel === "exact_category") {
    skillScore = 80;
    keyHighlights.push(`Direct ${job?.category || "Trade"} Match`);
    const jobSub = extractJobSubCategory(job);
    const traderServices = extractTraderServices(trader).map(normalizeTradeToken);
    if (jobSub && traderServices.some((s) => s === normalizeTradeToken(jobSub) || safeTokenContains(normalizeTradeToken(jobSub), s))) {
      skillScore += 15;
      keyHighlights.push(`Matches ${jobSub}`);
    }
    skillScore += Math.min(5, catAlign.matchedTagsCount * 2);
  } else if (catAlign.matchLevel === "subcategory_service") {
    skillScore = 78 + Math.min(12, catAlign.matchedTagsCount * 4);
    keyHighlights.push(`Service Match (${catAlign.matchedSubcategory || "Specialist"})`);
  } else if (catAlign.matchLevel === "synonym") {
    skillScore = 72 + Math.min(10, catAlign.matchedTagsCount * 3);
    keyHighlights.push("Related Trade Match");
  } else if (catAlign.matchLevel === "tag_skill") {
    skillScore = 58 + Math.min(12, catAlign.matchedTagsCount * 4);
  } else {
    skillScore = 0;
  }

  if (!certCheck.eligible) {
    skillScore = Math.min(skillScore, 15);
  }
  skillScore = Math.min(100, skillScore);

  factors.push({
    name: "Trade & Subcategory Alignment",
    score: skillScore,
    weight: 0.35,
    status: skillScore >= 80 ? "excellent" : skillScore >= 60 ? "good" : skillScore > 0 ? "fair" : "poor",
    details:
      catAlign.matched
        ? certCheck.eligible
          ? `Matched via ${catAlign.matchLevel.replace("_", " ")}`
          : `Requires full verification / ${certCheck.missingCertifications.join(", ") || "regulated approval"}`
        : "Outside your registered trade categories",
  });

  // 2. Location & Travel Radius Fit (30% weight)
  let locationScore = 45;
  if (geoFit.distanceMiles !== null) {
    const ratio = geoFit.distanceMiles / Math.max(1, geoFit.radiusMiles);
    if (geoFit.distanceMiles <= 3) {
      locationScore = 100;
      keyHighlights.push(`${geoFit.distanceMiles.toFixed(1)} mi away (Very Close)`);
    } else if (ratio <= 0.4) {
      locationScore = 90;
      keyHighlights.push(`${geoFit.distanceMiles.toFixed(1)} mi away`);
    } else if (ratio <= 0.75) {
      locationScore = 75;
    } else if (ratio <= 1.0) {
      locationScore = 60;
    } else if (ratio <= 1.4) {
      locationScore = 25;
    } else {
      locationScore = 5;
    }
  } else if (geoFit.matchType === "service_area") {
    locationScore = 80;
    keyHighlights.push("Inside Your Service Area");
  } else if (geoFit.matchType === "no_job_location") {
    locationScore = 50;
  } else {
    locationScore = 15;
  }

  factors.push({
    name: "Location & Travel Radius",
    score: locationScore,
    weight: 0.30,
    status: locationScore >= 85 ? "excellent" : locationScore >= 60 ? "good" : locationScore >= 35 ? "fair" : "poor",
    details:
      geoFit.distanceMiles !== null
        ? `~${geoFit.distanceMiles.toFixed(1)} miles away (your radius: ${geoFit.radiusMiles} mi)`
        : geoFit.matchType === "service_area"
        ? "Matches your configured service areas"
        : "Distance could not be verified for your area",
  });

  // 3. Schedule & Calendar Availability (15% weight)
  let scheduleScore = 75;
  if (!isProfileAcceptingNewWork(trader)) {
    scheduleScore = 10;
  } else if (!isCalendarFree) {
    scheduleScore = 15;
  } else if (jobDate) {
    scheduleScore = 100;
    keyHighlights.push("Fits Your Calendar");
  }

  factors.push({
    name: "Calendar & Availability Fit",
    score: scheduleScore,
    weight: 0.15,
    status: scheduleScore >= 85 ? "excellent" : scheduleScore >= 65 ? "good" : "poor",
    details: !isProfileAcceptingNewWork(trader)
      ? "Profile paused for new requests"
      : !isCalendarFree
      ? `Calendar marked busy/unavailable on ${jobDate}`
      : jobDate
      ? `Open on your calendar for ${jobDate}`
      : "Flexible schedule",
  });

  // 4. Urgency & Emergency Readiness (10% weight)
  const urgencyNorm = normalizeJobUrgency(job?.urgency);
  const isEmergencyJob = urgencyNorm === "emergency" || job?.isEmergency === true;
  const traderEmergencyReady =
    trader?.isAvailableForEmergency === true || trader?.isAvailableForInstantMatch === true;

  let urgencyScore = 70;
  if (isEmergencyJob) {
    if (traderEmergencyReady) {
      urgencyScore = 100;
      keyHighlights.push("Emergency Callout Match");
    } else {
      urgencyScore = 30;
    }
  } else if (urgencyNorm === "urgent") {
    urgencyScore = 85;
  }

  factors.push({
    name: "Urgency & Callout Alignment",
    score: urgencyScore,
    weight: 0.10,
    status: urgencyScore >= 85 ? "excellent" : urgencyScore >= 65 ? "good" : "fair",
    details: isEmergencyJob
      ? traderEmergencyReady
        ? "Urgent job matching your emergency availability"
        : "Emergency job (your emergency toggle is off)"
      : `Urgency: ${urgencyNorm}`,
  });

  // 5. Opportunity & Job Quality (10% weight) — low quote competition + completeness
  const quoteCount = Number(job?.quoteCount ?? 0);
  let opportunityScore = 50;
  if (quoteCount === 0) {
    opportunityScore += 30;
    keyHighlights.push("Be First to Quote");
  } else if (quoteCount <= 2) {
    opportunityScore += 20;
  } else if (quoteCount >= 5) {
    opportunityScore -= 15;
  }
  if (Number(job?.photosCount || 0) > 0 || Number(job?.videosCount || 0) > 0) {
    opportunityScore += 10;
  }
  if (Number(job?.estimateMax || 0) > 0 || Number(job?.estimateMin || 0) > 0) {
    opportunityScore += 10;
  }
  opportunityScore = Math.max(0, Math.min(100, opportunityScore));

  factors.push({
    name: "Quote Competition & Brief Quality",
    score: opportunityScore,
    weight: 0.10,
    status: opportunityScore >= 80 ? "excellent" : opportunityScore >= 60 ? "good" : "fair",
    details: quoteCount === 0 ? "0 quotes submitted so far" : `${quoteCount} quote(s) submitted`,
  });

  // Composite weighted score
  let compositeScore = Math.round(
    skillScore * 0.35 +
      locationScore * 0.30 +
      scheduleScore * 0.15 +
      urgencyScore * 0.10 +
      opportunityScore * 0.10
  );

  // Hard domain cap: out-of-domain jobs never exceed 10
  if (!catAlign.matched || !certCheck.eligible) {
    compositeScore = Math.min(10, compositeScore);
  }
  compositeScore = Math.max(0, Math.min(100, compositeScore));

  let matchTier: UnifiedMatchResult["matchTier"] = "Fair Match";
  if (compositeScore >= 85) matchTier = "Perfect Match";
  else if (compositeScore >= 72) matchTier = "High Match";
  else if (compositeScore >= 58) matchTier = "Good Match";

  return {
    compositeScore,
    matchTier,
    distanceMiles: geoFit.distanceMiles,
    geoMatchType: geoFit.matchType,
    categoryMatchLevel: catAlign.matchLevel,
    isCalendarConflict: !isCalendarFree,
    isExclusiveLocked,
    signalsEvaluated: factors.length + 7, // Category, Subcategory, Tags, Certs, Distance, Radius, Calendar, Urgency, QuoteCount, Media, Budget, Exclusive
    breakdown: {
      skillRelevance: Math.round(skillScore),
      locationProximity: Math.round(locationScore),
      reputationTrust: Math.round(opportunityScore),
      complianceInsurance: Math.round(certCheck.eligible ? 100 : 15),
      availabilityVelocity: Math.round((scheduleScore + urgencyScore) / 2),
    },
    factors,
    keyHighlights: keyHighlights.slice(0, 4),
  };
}

// ---------------------------------------------------------------------------
// 7. Scoring Engine B: Homeowner / Dispatch "Trader Rank Score"
// ---------------------------------------------------------------------------

/**
 * Scores a tradesperson candidate for a specific job (0-100).
 * Used for Homeowner Quote Comparison, Ranked Server Lead Distribution,
 * Instant Match candidate prioritization, and Pro Matchmaker pre-ranking.
 */
export function scoreTraderForJob(
  trader: Record<string, any> | null | undefined,
  job: Record<string, any> | null | undefined,
  options?: {
    explicitTraderCoords?: { lat: number; lng: number } | null;
    categorySynonyms?: string[];
    categoryRelatedTerms?: string[];
    extraRadiusMiles?: number;
    mode?: "strict" | "relaxed";
  }
): UnifiedMatchResult {
  const factors: UnifiedMatchFactor[] = [];
  const keyHighlights: string[] = [];

  const catAlign = evaluateCategoryAlignment(trader, job, {
    mode: options?.mode || "strict",
    categorySynonyms: options?.categorySynonyms,
    categoryRelatedTerms: options?.categoryRelatedTerms,
  });
  const certCheck = evaluateCertificationEligibility(trader, job);
  const geoFit = evaluateGeographicFit(trader, job, {
    explicitTraderCoords: options?.explicitTraderCoords,
    extraRadiusMiles: options?.extraRadiusMiles,
  });
  const jobDate = extractJobDate(job);
  const isCalendarFree = isTraderCalendarAvailableForDate(trader, jobDate);
  const behavioral = computeBehavioralAndFairnessScore(trader);

  // 1. Skill & Category Alignment (25%)
  let skillScore = 0;
  if (catAlign.matchLevel === "exact_category") {
    skillScore = 80;
    keyHighlights.push(`Primary ${job?.category || "Trade"} Specialist`);
    const jobSub = extractJobSubCategory(job);
    const traderServices = extractTraderServices(trader).map(normalizeTradeToken);
    if (jobSub && traderServices.some((s) => s === normalizeTradeToken(jobSub) || safeTokenContains(normalizeTradeToken(jobSub), s))) {
      skillScore += 15;
    }
    skillScore += Math.min(5, catAlign.matchedTagsCount * 2);
  } else if (catAlign.matchLevel === "subcategory_service") {
    skillScore = 75 + Math.min(15, catAlign.matchedTagsCount * 5);
  } else if (catAlign.matchLevel === "synonym") {
    skillScore = 70;
  } else if (catAlign.matchLevel === "tag_skill") {
    skillScore = 55;
  }
  skillScore = Math.min(100, skillScore);

  factors.push({
    name: "Trade & Skill Relevance",
    score: skillScore,
    weight: 0.25,
    status: skillScore >= 80 ? "excellent" : skillScore >= 60 ? "good" : "poor",
    details: catAlign.matched ? `Matched (${catAlign.matchLevel.replace("_", " ")})` : "Category mismatch",
  });

  // 2. Geodesic Proximity (25%)
  let locationScore = 40;
  if (geoFit.distanceMiles !== null) {
    const ratio = geoFit.distanceMiles / Math.max(1, geoFit.radiusMiles);
    if (geoFit.distanceMiles <= 3) {
      locationScore = 100;
      keyHighlights.push(`Local Pro (~${geoFit.distanceMiles.toFixed(1)} mi)`);
    } else if (ratio <= 0.4) {
      locationScore = 90;
      keyHighlights.push(`~${geoFit.distanceMiles.toFixed(1)} mi away`);
    } else if (ratio <= 0.75) {
      locationScore = 75;
    } else if (ratio <= 1.0) {
      locationScore = 60;
    } else {
      locationScore = 15;
    }
  } else if (geoFit.matchType === "service_area") {
    locationScore = 80;
  } else if (geoFit.matchType === "no_job_location") {
    locationScore = 50;
  } else {
    locationScore = 15;
  }

  factors.push({
    name: "Geographic Proximity",
    score: locationScore,
    weight: 0.25,
    status: locationScore >= 85 ? "excellent" : locationScore >= 60 ? "good" : "poor",
    details:
      geoFit.distanceMiles !== null
        ? `~${geoFit.distanceMiles.toFixed(1)} miles from job`
        : geoFit.matchType === "service_area"
        ? "Covers job service area"
        : "Outside coverage radius",
  });

  // 3. Reputation & Verified Credentials (25%) — zero inflated defaults for 0-review traders!
  const rating = extractTraderRating(trader);
  const reviewCount = extractTraderReviewCount(trader);
  const videoVerified = isTraderVideoVerified(trader);
  const fullyVerified = isTraderFullyVerified(trader);
  const completedJobs = Number(trader?.completedJobs ?? trader?.jobsCompleted ?? 0);

  let reputationScore = 0;
  if (reviewCount > 0 && rating > 0) {
    reputationScore += Math.min(45, (rating / 5) * 45);
    reputationScore += Math.min(20, Math.log10(reviewCount + 1) * 14);
    if (rating >= 4.7 && reviewCount >= 5) {
      keyHighlights.push(`Top Rated (${rating.toFixed(1)}★ · ${reviewCount} reviews)`);
    }
  } else if (fullyVerified) {
    reputationScore += 20; // Honest baseline for verified newcomer with 0 reviews
  }

  if (videoVerified) {
    reputationScore += 25;
    keyHighlights.push("Verified Video Profile");
  }
  if (completedJobs > 0) {
    reputationScore += Math.min(10, completedJobs * 2);
  }
  reputationScore = Math.min(100, Math.round(reputationScore));

  factors.push({
    name: "Reputation & Verified Video",
    score: reputationScore,
    weight: 0.25,
    status: reputationScore >= 75 ? "excellent" : reputationScore >= 45 ? "good" : "fair",
    details:
      reviewCount > 0
        ? `${rating.toFixed(1)}★ from ${reviewCount} review(s)${videoVerified ? " · Video Verified" : ""}`
        : videoVerified
        ? "New trader · Video Verified"
        : "No client reviews yet",
  });

  // 4. Compliance, Verification & Insurance (15%) — no hardcoded fake PLI constants!
  let complianceScore = 0;
  if (fullyVerified) {
    complianceScore += 55;
    keyHighlights.push("ID & Compliance Verified");
  } else if (normalizeText(trader?.verificationStatus) === "provisional") {
    complianceScore += 30;
  }
  const hasInsuranceDoc = Boolean(
    trader?.insuranceUrl ||
      trader?.publicLiabilityUrl ||
      trader?.insurancePolicyNumber ||
      trader?.hasPublicLiabilityInsurance ||
      trader?.insuranceVerified
  );
  if (hasInsuranceDoc) {
    complianceScore += 25;
  }
  if (certCheck.eligible) {
    complianceScore += 20;
  } else {
    complianceScore = Math.min(complianceScore, 15);
  }
  complianceScore = Math.min(100, complianceScore);

  factors.push({
    name: "Verification & Compliance",
    score: complianceScore,
    weight: 0.15,
    status: complianceScore >= 80 ? "excellent" : complianceScore >= 50 ? "good" : "poor",
    details: fullyVerified
      ? hasInsuranceDoc
        ? "Verified account & insurance on file"
        : "Verified account"
      : certCheck.eligible
      ? "Provisional verification active"
      : "Requires full regulated verification",
  });

  // 5. Availability, Response Velocity & Fairness (10%)
  let availabilityScore = isProfileAcceptingNewWork(trader) ? 55 : 0;
  if (isProfileAcceptingNewWork(trader)) {
    if (!isCalendarFree) {
      availabilityScore = 15;
    } else {
      const urgencyNorm = normalizeJobUrgency(job?.urgency);
      const isEmergency = urgencyNorm === "emergency" || job?.isEmergency === true;
      if (isEmergency && (trader?.isAvailableForEmergency === true || trader?.isAvailableForInstantMatch === true)) {
        availabilityScore += 25;
        keyHighlights.push("Emergency Available");
      } else {
        availabilityScore += 15;
      }
      // Blend real behavioral velocity & fairness modifier
      availabilityScore += behavioral.bonusPoints;
    }
  }
  availabilityScore = Math.max(0, Math.min(100, Math.round(availabilityScore)));

  for (const h of behavioral.highlights) {
    if (keyHighlights.length < 4) keyHighlights.push(h);
  }

  factors.push({
    name: "Availability & Response Velocity",
    score: availabilityScore,
    weight: 0.10,
    status: availabilityScore >= 75 ? "excellent" : availabilityScore >= 50 ? "good" : "poor",
    details: isProfileAcceptingNewWork(trader)
      ? isCalendarFree
        ? "Accepting work & schedule open"
        : "Calendar conflict on requested date"
      : "Currently not accepting new requests",
  });

  let compositeScore = Math.round(
    skillScore * 0.25 +
      locationScore * 0.25 +
      reputationScore * 0.25 +
      complianceScore * 0.15 +
      availabilityScore * 0.10
  );

  // Hard domain gate: out-of-domain or ineligible regulated trade is hard-capped at 10
  if (!catAlign.matched || !certCheck.eligible) {
    compositeScore = Math.min(10, compositeScore);
  }
  compositeScore = Math.max(0, Math.min(100, compositeScore));

  let matchTier: UnifiedMatchResult["matchTier"] = "Fair Match";
  if (compositeScore >= 85) matchTier = "Perfect Match";
  else if (compositeScore >= 70) matchTier = "High Match";
  else if (compositeScore >= 55) matchTier = "Good Match";

  return {
    compositeScore,
    matchTier,
    distanceMiles: geoFit.distanceMiles,
    geoMatchType: geoFit.matchType,
    categoryMatchLevel: catAlign.matchLevel,
    isCalendarConflict: !isCalendarFree,
    isExclusiveLocked: isWithinExclusiveWindow(job) && !hasExclusiveLeadAccess(trader),
    signalsEvaluated: factors.length + 9,
    breakdown: {
      skillRelevance: Math.round(skillScore),
      locationProximity: Math.round(locationScore),
      reputationTrust: Math.round(reputationScore),
      complianceInsurance: Math.round(complianceScore),
      availabilityVelocity: Math.round(availabilityScore),
    },
    factors,
    keyHighlights: keyHighlights.slice(0, 4),
  };
}
