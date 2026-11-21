/**
 * Server-Authoritative Lead Distribution Matcher (AT-LEAD-01)
 * Enforces strict geographic proximity AND primary trade-category matching
 * across ALL job urgencies (emergency jobs never bypass category or geo boundaries).
 */

export interface LeadCandidateRecord {
  id: string;
  data: Record<string, any>;
}

export interface LeadJobCriteria {
  jobId: string;
  ownerId?: string;
  callerUid?: string;
  category: string;
  postcode: string;
  lat?: number | null;
  lng?: number | null;
  isEmergency?: boolean;
}

export interface LeadMatchEvaluation {
  eligible: boolean;
  reason?: string;
  distanceMiles?: number | null;
}

function extractPostcodeParts(raw: unknown): { normalized: string; outcode: string; area: string } {
  const cleaned = String(raw || "").trim().toUpperCase().replace(/\s+/g, " ");
  if (!cleaned) return { normalized: "", outcode: "", area: "" };
  const compact = cleaned.replace(/\s+/g, "");
  const outcode = cleaned.includes(" ")
    ? cleaned.split(" ")[0]
    : compact.length > 3
      ? compact.slice(0, compact.length - 3)
      : compact;
  const areaMatch = outcode.match(/^[A-Z]{1,2}/);
  return {
    normalized: cleaned,
    outcode,
    area: areaMatch ? areaMatch[0] : outcode.slice(0, 2),
  };
}

function haversineMiles(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const R = 3958.8; // Earth radius in miles
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

export function traderMatchesLeadCategory(trader: Record<string, any>, rawCategory: string): boolean {
  const jobCat = String(rawCategory || "").trim().toLowerCase();
  if (!jobCat) return false;

  const collected: string[] = [];
  if (typeof trader.primaryTrade === "string") collected.push(trader.primaryTrade);
  if (typeof trader.trade === "string") collected.push(trader.trade);
  if (typeof trader.category === "string") collected.push(trader.category);
  if (Array.isArray(trader.trades)) collected.push(...trader.trades.map(String));
  if (Array.isArray(trader.categories)) collected.push(...trader.categories.map(String));
  if (Array.isArray(trader.verifiedCategories)) collected.push(...trader.verifiedCategories.map(String));

  const normalized = collected.map((c) => c.trim().toLowerCase()).filter(Boolean);
  if (normalized.length === 0) return false;

  if (jobCat === "all" || jobCat === "general") {
    return normalized.length > 0;
  }

  return normalized.some((entry) => entry === jobCat || entry.includes(jobCat) || jobCat.includes(entry));
}

export function traderMatchesLeadGeography(
  trader: Record<string, any>,
  job: LeadJobCriteria
): { matched: boolean; distanceMiles: number | null; reason?: string } {
  const radiusLimit = Math.max(1, Number(trader.coverageRadiusMiles ?? trader.serviceRadius ?? 25));

  const jobLat = typeof job.lat === "number" ? job.lat : Number(job.lat);
  const jobLng = typeof job.lng === "number" ? job.lng : Number(job.lng);
  const traderLat = typeof trader.lat === "number" ? trader.lat : Number(trader.latitude ?? trader.coordinates?.lat);
  const traderLng = typeof trader.lng === "number" ? trader.lng : Number(trader.longitude ?? trader.coordinates?.lng);

  if (
    Number.isFinite(jobLat) &&
    Number.isFinite(jobLng) &&
    Number.isFinite(traderLat) &&
    Number.isFinite(traderLng)
  ) {
    const distance = haversineMiles(jobLat, jobLng, traderLat, traderLng);
    return {
      matched: distance <= radiusLimit,
      distanceMiles: Math.round(distance * 10) / 10,
      reason: distance <= radiusLimit ? undefined : `distance_${Math.round(distance)}mi_exceeds_${radiusLimit}mi`,
    };
  }

  const jobLoc = extractPostcodeParts(job.postcode);
  const traderLoc = extractPostcodeParts(trader.postcode);

  // Check explicit covered postcode/area lists if configured on trader profile
  const serviceAreas = Array.isArray(trader.serviceAreas)
    ? trader.serviceAreas.map((a: any) => String(a).trim().toUpperCase()).filter(Boolean)
    : [];
  if (jobLoc.outcode && (serviceAreas.includes(jobLoc.outcode) || serviceAreas.includes(jobLoc.area))) {
    return { matched: true, distanceMiles: null };
  }

  if (!jobLoc.area || !traderLoc.area) {
    return { matched: false, distanceMiles: null, reason: "missing_location_postcode" };
  }

  const areaMatched =
    traderLoc.normalized === jobLoc.normalized ||
    (Boolean(traderLoc.outcode) && traderLoc.outcode === jobLoc.outcode) ||
    traderLoc.area === jobLoc.area;

  return {
    matched: areaMatched,
    distanceMiles: null,
    reason: areaMatched ? undefined : `postcode_area_mismatch_${traderLoc.area}_vs_${jobLoc.area}`,
  };
}

export function evaluateLeadRecipient(
  candidateId: string,
  trader: Record<string, any>,
  job: LeadJobCriteria
): LeadMatchEvaluation {
  if (!trader || typeof trader !== "object") {
    return { eligible: false, reason: "missing_trader" };
  }

  if (candidateId === job.callerUid || candidateId === job.ownerId || (trader.uid && trader.uid === job.ownerId)) {
    return { eligible: false, reason: "self_owner" };
  }

  const status = String(trader.status || "").trim().toLowerCase();
  if (
    trader.isDisabled === true ||
    trader.disabled === true ||
    trader.isSuspended === true ||
    trader.isBanned === true ||
    trader.banned === true ||
    trader.deleted === true ||
    trader.acceptingNewWork === false ||
    ["suspended", "frozen", "banned", "deleted", "disabled"].includes(status)
  ) {
    return { eligible: false, reason: "inactive_or_suspended" };
  }

  const verificationStatus = String(trader.verificationStatus || "").trim().toLowerCase();
  if (
    trader.isVerified === false ||
    ["rejected", "revoked", "expired", "suspended", "unverified"].includes(verificationStatus)
  ) {
    return { eligible: false, reason: "unverified" };
  }

  // Strict category enforcement (never bypassed by isEmergency)
  if (!traderMatchesLeadCategory(trader, job.category)) {
    return { eligible: false, reason: "category_mismatch" };
  }

  // Strict geographic proximity enforcement (never bypassed by isEmergency)
  const geo = traderMatchesLeadGeography(trader, job);
  if (!geo.matched) {
    return { eligible: false, reason: geo.reason || "geo_mismatch" };
  }

  return {
    eligible: true,
    distanceMiles: geo.distanceMiles,
  };
}

export function filterEligibleLeadRecipients<T extends LeadCandidateRecord>(
  candidates: T[],
  job: LeadJobCriteria,
  maxRecipients: number = 20
): Array<T & { distanceMiles?: number | null }> {
  const matched: Array<T & { distanceMiles?: number | null }> = [];
  for (const candidate of candidates) {
    const check = evaluateLeadRecipient(candidate.id, candidate.data, job);
    if (!check.eligible) continue;
    matched.push({ ...candidate, distanceMiles: check.distanceMiles });
    if (matched.length >= maxRecipients) break;
  }
  return matched;
}
