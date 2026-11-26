/**
 * Server-Authoritative Lead Distribution Matcher & Wave Engine (AT-LEAD-01)
 *
 * Powered by the unified AnyTrader matching core (`src/lib/unifiedJobMatching.ts`):
 * - Strict trade category & regulated certification eligibility (never bypassed on emergencies)
 * - Geodesic Haversine + 121-area UK postcode centroid radius matching
 * - Ranked candidate selection (eliminates arbitrary Firestore doc-ID FIFO starvation)
 * - Priority Offers (`exclusiveUntil`) Wave 1 early-access enforcement
 * - Quiet Hours suppression for push/SMS + Emergency opt-in gating for SMS
 * - Dynamic Wave 2 radius expansion (+10 mi) for low-quote jobs
 */

import admin from "firebase-admin";
import {
  evaluateCategoryAlignment,
  evaluateCertificationEligibility,
  evaluateGeographicFit,
  hasExclusiveLeadAccess,
  isTraderInQuietHours,
  isWithinExclusiveWindow,
  parseTimestampToMs,
  scoreTraderForJob,
  extractJobPostcode,
  extractJobSubCategory,
  extractJobDate,
} from "../lib/unifiedJobMatching.ts";
import { isOpenJobStatus } from "../lib/marketplaceContracts.ts";

export interface LeadCandidateRecord {
  id: string;
  data: Record<string, any>;
}

export interface LeadJobCriteria {
  jobId: string;
  ownerId?: string;
  callerUid?: string;
  category: string;
  subCategory?: string;
  subcategory?: string;
  title?: string;
  description?: string;
  postcode: string;
  postcodeArea?: string;
  city?: string;
  area?: string;
  lat?: number | null;
  lng?: number | null;
  isEmergency?: boolean;
  urgency?: string;
  exclusiveUntil?: any;
  preferredDate?: string | null;
  jobDate?: string | null;
  requiredCertifications?: string[];
  extraRadiusMiles?: number;
  excludeTraderIds?: string[];
  nowMs?: number;
}

export interface LeadMatchEvaluation {
  eligible: boolean;
  reason?: string;
  distanceMiles?: number | null;
  score?: number;
  isExclusivePriority?: boolean;
  delayedVisibleAtMs?: number | null;
  inQuietHours?: boolean;
  allowImmediatePush?: boolean;
  allowEmergencySms?: boolean;
}

export interface RankedLeadRecipient<T extends LeadCandidateRecord = LeadCandidateRecord> {
  id: string;
  data: Record<string, any>;
  distanceMiles?: number | null;
  score: number;
  isExclusivePriority: boolean;
  delayedVisibleAtMs: number | null;
  inQuietHours: boolean;
  allowImmediatePush: boolean;
  allowEmergencySms: boolean;
  original?: T;
}

export function traderMatchesLeadCategory(
  trader: Record<string, any>,
  rawCategory: string,
  jobContext?: Partial<LeadJobCriteria>
): boolean {
  const jobCat = String(rawCategory || "").trim().toLowerCase();
  if (!jobCat) return false;
  if (jobCat === "all" || jobCat === "general") {
    const collected = [
      trader?.primaryTrade,
      trader?.trade,
      trader?.category,
      ...(Array.isArray(trader?.trades) ? trader.trades : []),
      ...(Array.isArray(trader?.categories) ? trader.categories : []),
      ...(Array.isArray(trader?.verifiedCategories) ? trader.verifiedCategories : []),
    ].filter((v) => typeof v === "string" && v.trim().length > 0);
    return collected.length > 0;
  }

  const alignment = evaluateCategoryAlignment(
    trader,
    {
      category: rawCategory,
      subCategory: jobContext?.subCategory || jobContext?.subcategory,
      title: jobContext?.title,
      description: jobContext?.description,
    },
    { mode: "strict" }
  );
  return alignment.matched;
}

export function traderMatchesLeadGeography(
  trader: Record<string, any>,
  job: LeadJobCriteria
): { matched: boolean; distanceMiles: number | null; reason?: string } {
  const geo = evaluateGeographicFit(trader, job, {
    extraRadiusMiles: job.extraRadiusMiles || 0,
  });

  if (geo.withinRadius) {
    return {
      matched: true,
      distanceMiles: geo.distanceMiles,
    };
  }

  return {
    matched: false,
    distanceMiles: geo.distanceMiles,
    reason:
      geo.matchType === "out_of_radius" && geo.distanceMiles !== null
        ? `distance_${Math.round(geo.distanceMiles)}mi_exceeds_${geo.radiusMiles}mi`
        : "missing_or_mismatched_location",
  };
}

export function isActiveProvisionalTrader(trader: Record<string, any>, nowMs: number = Date.now()): boolean {
  const verificationStatus = String(trader.verificationStatus || "").trim().toLowerCase();
  if (trader.requiresAdminVerification === true || trader.duplicatePhoneFingerprintDetected === true) {
    return false;
  }

  const docs = Array.isArray(trader.verificationDocs) ? trader.verificationDocs : [];
  const hasUploadedAnyDoc = docs.some(
    (d: any) => d && typeof d.fileUrl === "string" && d.fileUrl.trim().length > 0 && d.status !== "rejected"
  );

  // Non-regulated trader who has already uploaded verification docs awaiting admin review
  if (hasUploadedAnyDoc && (verificationStatus === "provisional" || verificationStatus === "pending")) {
    return true;
  }

  if (verificationStatus !== "provisional") return false;
  const maxQuotesRaw = Number(trader.provisionalMaxQuotes ?? 5);
  const maxQuotes = Number.isFinite(maxQuotesRaw) && maxQuotesRaw >= 0 ? Math.floor(maxQuotesRaw) : 5;
  const quotesUsed = Number(trader.provisionalQuotesUsed ?? 0);
  if (Number.isFinite(quotesUsed) && quotesUsed >= maxQuotes) return false;
  const expiresRaw = trader.documentGraceDeadlineAt ?? trader.documentGracePeriodExpiresAt;
  if (expiresRaw) {
    const parsed = parseTimestampToMs(expiresRaw);
    if (parsed !== null && parsed < nowMs) return false;
  }
  return true;
}

export function evaluateLeadRecipient(
  candidateId: string,
  trader: Record<string, any>,
  job: LeadJobCriteria
): LeadMatchEvaluation {
  if (!trader || typeof trader !== "object") {
    return { eligible: false, reason: "missing_trader" };
  }

  if (Array.isArray(job.excludeTraderIds) && job.excludeTraderIds.includes(candidateId)) {
    return { eligible: false, reason: "already_notified" };
  }

  if (candidateId === job.callerUid || candidateId === job.ownerId || (trader.uid && trader.uid === job.ownerId)) {
    return { eligible: false, reason: "self_owner" };
  }

  // Exclude non-trade B2B property portfolio accounts from receiving trade leads
  const role = String(trader.role || "").trim().toLowerCase();
  if (role === "business" && String(trader.businessLayer || "").trim().toLowerCase() === "properties") {
    return { eligible: false, reason: "property_business_account" };
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
    trader.isAcceptingRequests === false ||
    ["suspended", "frozen", "banned", "deleted", "disabled"].includes(status)
  ) {
    return { eligible: false, reason: "inactive_or_suspended" };
  }

  const nowMs = job.nowMs ?? Date.now();
  const verificationStatus = String(trader.verificationStatus || "").trim().toLowerCase();
  const provisionalActive = isActiveProvisionalTrader(trader, nowMs);
  if (
    !provisionalActive &&
    (trader.isVerified === false ||
      [
        "provisional",
        "rejected",
        "revoked",
        "expired",
        "suspended",
        "unverified",
        "pending",
        "pending_review",
      ].includes(verificationStatus))
  ) {
    return {
      eligible: false,
      reason: verificationStatus === "provisional" ? "provisional_expired_or_capped" : "unverified",
    };
  }

  // Strict category enforcement (never bypassed by isEmergency)
  if (!traderMatchesLeadCategory(trader, job.category, job)) {
    return { eligible: false, reason: "category_mismatch" };
  }

  // Regulated certification hard gate (blocks provisional/unverified accounts on regulated trades)
  const certCheck = evaluateCertificationEligibility(trader, job);
  if (!certCheck.eligible) {
    return { eligible: false, reason: certCheck.reason || "certification_ineligible" };
  }

  // Strict geographic proximity enforcement (never bypassed by isEmergency; supports UK postcode centroids)
  const geo = traderMatchesLeadGeography(trader, job);
  if (!geo.matched) {
    return { eligible: false, reason: geo.reason || "geo_mismatch" };
  }

  // Priority Offers (`exclusiveUntil`) early-access window
  const inExclusiveWindow = isWithinExclusiveWindow(job, nowMs);
  const isExclusivePriority = hasExclusiveLeadAccess(trader);
  const exclusiveUntilMs = inExclusiveWindow ? parseTimestampToMs(job.exclusiveUntil) : null;
  const delayedVisibleAtMs = inExclusiveWindow && !isExclusivePriority ? exclusiveUntilMs : null;

  // Quiet Hours & Emergency opt-in gating
  const nowDate = new Date(nowMs);
  const inQuietHours = isTraderInQuietHours(trader, nowDate);
  const isEmergency = Boolean(job.isEmergency || String(job.urgency || "").toLowerCase() === "emergency");
  const traderEmergencyOptIn =
    trader.isAvailableForEmergency === true || trader.isAvailableForInstantMatch === true;
  const traderEmergencyExplicitOff = trader.isAvailableForEmergency === false;

  // Immediate push allowed unless delayed by exclusive window or muted by quiet hours (emergency opt-in bypasses quiet hours)
  const allowImmediatePush =
    delayedVisibleAtMs === null && (!inQuietHours || (isEmergency && traderEmergencyOptIn));

  // Emergency SMS only sent if job is emergency, trader has phone, did NOT opt out of emergency, and not delayed by exclusive window
  const allowEmergencySms =
    isEmergency &&
    delayedVisibleAtMs === null &&
    !traderEmergencyExplicitOff &&
    (!inQuietHours || traderEmergencyOptIn);

  // Unified rank score (proximity + category + reputation + compliance + behavioral velocity & fairness)
  const matchScore = scoreTraderForJob(trader, job, {
    extraRadiusMiles: job.extraRadiusMiles || 0,
    mode: "strict",
  });

  return {
    eligible: true,
    distanceMiles: geo.distanceMiles,
    score: matchScore.compositeScore,
    isExclusivePriority,
    delayedVisibleAtMs,
    inQuietHours,
    allowImmediatePush,
    allowEmergencySms,
  };
}

/**
 * Evaluates, scores, and ranks ALL eligible candidates before taking top `maxRecipients`.
 * Eliminates arbitrary Firestore doc-ID FIFO cutoff and gives Priority Offers subscribers first access.
 */
export function filterEligibleLeadRecipients<T extends LeadCandidateRecord>(
  candidates: T[],
  job: LeadJobCriteria,
  maxRecipients: number = 25
): Array<
  T & {
    distanceMiles?: number | null;
    score?: number;
    isExclusivePriority?: boolean;
    delayedVisibleAtMs?: number | null;
    inQuietHours?: boolean;
    allowImmediatePush?: boolean;
    allowEmergencySms?: boolean;
  }
> {
  const scored: Array<
    T & {
      distanceMiles?: number | null;
      score: number;
      isExclusivePriority: boolean;
      delayedVisibleAtMs: number | null;
      inQuietHours: boolean;
      allowImmediatePush: boolean;
      allowEmergencySms: boolean;
    }
  > = [];

  for (const candidate of candidates) {
    const check = evaluateLeadRecipient(candidate.id, candidate.data, job);
    if (!check.eligible) continue;
    scored.push({
      ...candidate,
      distanceMiles: check.distanceMiles ?? null,
      score: check.score ?? 50,
      isExclusivePriority: Boolean(check.isExclusivePriority),
      delayedVisibleAtMs: check.delayedVisibleAtMs ?? null,
      inQuietHours: Boolean(check.inQuietHours),
      allowImmediatePush: check.allowImmediatePush !== false,
      allowEmergencySms: Boolean(check.allowEmergencySms),
    });
  }

  // Deterministic ranking:
  // 1. Immediate Wave (non-delayed / Priority Exclusive) before delayed Wave 2
  // 2. Higher unified score first (includes proximity, rating, video, velocity & fairness rotation)
  // 3. Closer distance tiebreaker
  // 4. Deterministic UID tiebreaker
  scored.sort((a, b) => {
    const aDelayed = a.delayedVisibleAtMs !== null ? 1 : 0;
    const bDelayed = b.delayedVisibleAtMs !== null ? 1 : 0;
    if (aDelayed !== bDelayed) return aDelayed - bDelayed;
    if (a.isExclusivePriority !== b.isExclusivePriority) {
      return a.isExclusivePriority ? -1 : 1;
    }
    if (b.score !== a.score) return b.score - a.score;
    const distA = a.distanceMiles ?? 9999;
    const distB = b.distanceMiles ?? 9999;
    if (distA !== distB) return distA - distB;
    return a.id.localeCompare(b.id);
  });

  return scored.slice(0, Math.max(1, maxRecipients));
}

/**
 * Fetches candidate traders & trade businesses using category-indexed queries first
 * (scales well past 500 tradespeople) with bounded legacy fallback for single-field profiles.
 */
export async function fetchIndexedLeadCandidates(
  db: any,
  category: string,
  maxScanPerQuery: number = 300
): Promise<LeadCandidateRecord[]> {
  const seen = new Set<string>();
  const results: LeadCandidateRecord[] = [];
  const trimmedCategory = String(category || "").trim();

  const collectSnap = (snap: any) => {
    for (const d of snap?.docs || []) {
      if (seen.has(d.id)) continue;
      const data = typeof d.data === "function" ? d.data() || {} : d.data || {};
      const role = String(data.role || "").trim().toLowerCase();
      if (role !== "tradesperson" && role !== "business") continue;
      if (role === "business" && String(data.businessLayer || "").trim().toLowerCase() === "properties") {
        continue;
      }
      seen.add(d.id);
      results.push({ id: d.id, data });
    }
  };

  const queries: Array<Promise<any>> = [];

  // 1. Category-indexed queries (scales beyond 500 total platform users)
  if (trimmedCategory && trimmedCategory.toLowerCase() !== "general" && trimmedCategory.toLowerCase() !== "all") {
    queries.push(
      db
        .collection("users")
        .where("trades", "array-contains", trimmedCategory)
        .limit(maxScanPerQuery)
        .get()
        .catch(() => ({ docs: [] }))
    );
    queries.push(
      db
        .collection("users")
        .where("primaryTrade", "==", trimmedCategory)
        .limit(maxScanPerQuery)
        .get()
        .catch(() => ({ docs: [] }))
    );
  }

  // 2. Bounded role fallback (covers legacy profiles using `category` / `services` / synonyms)
  queries.push(
    db
      .collection("users")
      .where("role", "==", "tradesperson")
      .limit(maxScanPerQuery)
      .get()
      .catch(() => ({ docs: [] }))
  );
  queries.push(
    db
      .collection("users")
      .where("role", "==", "business")
      .limit(maxScanPerQuery)
      .get()
      .catch(() => ({ docs: [] }))
  );

  const snaps = await Promise.all(queries);
  for (const snap of snaps) {
    collectSnap(snap);
  }

  return results;
}

export interface DistributeJobLeadsOptions {
  db: any;
  jobId: string;
  jobData?: Record<string, any> | null;
  callerUid?: string;
  maxRecipients?: number;
  wave?: 1 | 2;
  extraRadiusMiles?: number;
  forceRedistribute?: boolean;
  dispatchFcmPush?: (payload: {
    recipientId: string;
    title: string;
    body: string;
    channelId: string;
    eventType: string;
    data: Record<string, string>;
  }) => Promise<any>;
}

/**
 * Single canonical server-side job lead distributor.
 * Called automatically on job creation (`POST /api/jobs`), explicitly via
 * `POST /api/jobs/:id/distribute-leads` (idempotent), by legacy `trader_notifications`
 * bridge, and by Wave 2 expansion for low-quote jobs.
 */
export async function distributeJobLeadsAuthoritative(
  options: DistributeJobLeadsOptions
): Promise<{
  notifiedCount: number;
  skippedAlreadyDistributed: boolean;
  recipientIds: string[];
  wave: 1 | 2;
}> {
  const {
    db,
    jobId,
    callerUid,
    maxRecipients = 25,
    wave = 1,
    extraRadiusMiles = 0,
    forceRedistribute = false,
    dispatchFcmPush,
  } = options;

  if (!db || !jobId) {
    return { notifiedCount: 0, skippedAlreadyDistributed: false, recipientIds: [], wave };
  }

  const jobRef = db.collection("jobs").doc(jobId);
  let jobData = options.jobData || null;
  if (!jobData) {
    const jobSnap = await jobRef.get();
    if (!jobSnap.exists) {
      return { notifiedCount: 0, skippedAlreadyDistributed: false, recipientIds: [], wave };
    }
    jobData = jobSnap.data() || {};
  }

  // Idempotency guard for Wave 1 (prevents duplicate notifications when BOTH server auto-dispatch
  // and client `distributeJobNotifications` call within seconds of each other)
  if (wave === 1 && !forceRedistribute && jobData.leadsDistributedAt) {
    const distMs = parseTimestampToMs(jobData.leadsDistributedAt);
    if (distMs !== null && Date.now() - distMs < 15 * 60 * 1000) {
      return {
        notifiedCount: Number(jobData.leadsDistributedCount || 0),
        skippedAlreadyDistributed: true,
        recipientIds: Array.isArray(jobData.notifiedTraderIds) ? jobData.notifiedTraderIds : [],
        wave,
      };
    }
  }

  const ownerId = jobData.homeownerId || jobData.userId || jobData.ownerId || jobData.customerId || "";
  const effectiveCallerUid = callerUid || ownerId;
  const category = String(jobData.category || "General").trim();
  const postcode = extractJobPostcode(jobData) || String(jobData.postcode || "").trim();
  const urgency = String(jobData.urgency || "standard").toLowerCase();
  const isEmergency = urgency === "emergency" || jobData.isEmergency === true;
  const previouslyNotified: string[] = Array.isArray(jobData.notifiedTraderIds)
    ? jobData.notifiedTraderIds.map(String)
    : [];

  const targetDirectTraderId =
    jobData.isDirectJob === true || jobData.visibility === "private" || jobData.visibility === "direct"
      ? String(jobData.targetTradespersonId || jobData.targetTraderId || jobData.directTraderId || "").trim()
      : "";

  let eligibleRecipients: Array<{
    id: string;
    data: Record<string, any>;
    distanceMiles?: number | null;
    score?: number;
    isExclusivePriority?: boolean;
    delayedVisibleAtMs?: number | null;
    inQuietHours?: boolean;
    allowImmediatePush?: boolean;
    allowEmergencySms?: boolean;
  }> = [];

  if (targetDirectTraderId) {
    if (wave === 2 || previouslyNotified.includes(targetDirectTraderId)) {
      return { notifiedCount: 0, skippedAlreadyDistributed: true, recipientIds: [], wave };
    }
    const targetSnap = await db.collection("users").doc(targetDirectTraderId).get();
    if (targetSnap.exists && targetDirectTraderId !== ownerId) {
      const targetData = targetSnap.data() || {};
      const inQuietHours = isTraderInQuietHours(targetData);
      eligibleRecipients = [
        {
          id: targetSnap.id,
          data: targetData,
          distanceMiles: null,
          score: 100,
          isExclusivePriority: true,
          delayedVisibleAtMs: null,
          inQuietHours,
          allowImmediatePush: !inQuietHours || isEmergency,
          allowEmergencySms: isEmergency && targetData.isAvailableForEmergency !== false,
        },
      ];
    }
  } else {
    const candidateDocs = await fetchIndexedLeadCandidates(db, category, 300);
    const jobLat = Number(jobData.lat ?? jobData.latitude ?? jobData.coordinates?.lat ?? jobData.location?.lat);
    const jobLng = Number(jobData.lng ?? jobData.longitude ?? jobData.coordinates?.lng ?? jobData.location?.lng);

    eligibleRecipients = filterEligibleLeadRecipients(
      candidateDocs,
      {
        jobId,
        ownerId,
        callerUid: effectiveCallerUid,
        category,
        subCategory: extractJobSubCategory(jobData),
        title: jobData.title,
        description: jobData.description,
        postcode,
        postcodeArea: jobData.postcodeArea,
        city: jobData.city,
        area: jobData.area,
        lat: Number.isFinite(jobLat) ? jobLat : null,
        lng: Number.isFinite(jobLng) ? jobLng : null,
        isEmergency,
        urgency,
        exclusiveUntil: jobData.exclusiveUntil,
        preferredDate: extractJobDate(jobData),
        requiredCertifications: Array.isArray(jobData.requiredCertifications)
          ? jobData.requiredCertifications
          : undefined,
        extraRadiusMiles,
        excludeTraderIds: previouslyNotified,
      },
      maxRecipients
    );
  }

  let notifiedCount = 0;
  const recipientIds: string[] = [];
  const pushTargets: Array<{ id: string; isExclusive: boolean; distanceMiles?: number | null }> = [];
  const batch = db.batch();
  const nowIso = new Date().toISOString();

  for (const recipient of eligibleRecipients) {
    const trader = recipient.data;
    const notifRef = db.collection("notifications").doc();
    const visibleAtValue =
      recipient.delayedVisibleAtMs !== null && recipient.delayedVisibleAtMs !== undefined
        ? new Date(recipient.delayedVisibleAtMs).toISOString()
        : nowIso;
    const distanceLabel =
      typeof recipient.distanceMiles === "number" ? ` (~${recipient.distanceMiles.toFixed(1)} mi)` : "";

    batch.set(notifRef, {
      userId: recipient.id,
      senderId: effectiveCallerUid,
      type: targetDirectTraderId ? "direct_job_request" : wave === 2 ? "expanded_job_lead" : "new_job_lead",
      title: targetDirectTraderId
        ? `Direct Quote Request: ${category}`
        : isEmergency
        ? `Emergency ${category} Lead in ${postcode || "your area"}${distanceLabel}`
        : wave === 2
        ? `Local ${category} Opportunity in ${postcode || "your area"}${distanceLabel}`
        : `New ${category} Lead in ${postcode || "your area"}${distanceLabel}`,
      message: targetDirectTraderId
        ? `A customer sent you a direct 1-to-1 quote request for "${jobData.title || category}".`
        : isEmergency
        ? `URGENT: Emergency ${category} job needs a fast response.`
        : `Matched to your ${category} profile${recipient.score ? ` (${recipient.score}% match)` : ""}.`,
      jobId,
      matchScore: recipient.score ?? null,
      distanceMiles: recipient.distanceMiles ?? null,
      isExclusivePriority: Boolean(recipient.isExclusivePriority),
      leadWave: wave,
      link: `/job/${jobId}`,
      actionPath: `/job/${jobId}`,
      read: false,
      isRead: false,
      createdAt: admin.firestore.FieldValue?.serverTimestamp
        ? admin.firestore.FieldValue.serverTimestamp()
        : nowIso,
      visibleAt: visibleAtValue,
    });

    if (recipient.allowEmergencySms && trader.phone) {
      const smsRef = db.collection("sms_queue").doc();
      batch.set(smsRef, {
        to: trader.phone,
        toUserId: recipient.id,
        jobId,
        body: `EMERGENCY ALERT: New ${category} job near you in ${postcode || "your area"}${distanceLabel}. Open AnyTrader to quote.`,
        status: "pending",
        createdAt: admin.firestore.FieldValue?.serverTimestamp
          ? admin.firestore.FieldValue.serverTimestamp()
          : nowIso,
        requestedBy: effectiveCallerUid,
      });
    }

    if (recipient.allowImmediatePush) {
      pushTargets.push({
        id: recipient.id,
        isExclusive: Boolean(recipient.isExclusivePriority),
        distanceMiles: recipient.distanceMiles,
      });
    }

    recipientIds.push(recipient.id);
    notifiedCount++;
  }

  if (notifiedCount > 0) {
    await batch.commit();

    if (dispatchFcmPush && pushTargets.length > 0) {
      await Promise.allSettled(
        pushTargets.slice(0, maxRecipients).map((target) =>
          dispatchFcmPush({
            recipientId: target.id,
            title: isEmergency
              ? `Emergency ${category} Job Nearby`
              : target.isExclusive
              ? `Priority ${category} Job Match`
              : `New ${category} Job Match`,
            body: `A new ${category} job in ${postcode || "your area"}${
              typeof target.distanceMiles === "number" ? ` (~${target.distanceMiles.toFixed(1)} mi)` : ""
            } is ready for quotes.`,
            channelId: isEmergency ? "emergency_leads" : "job_leads",
            eventType: isEmergency ? "emergency_lead" : "job_lead",
            data: {
              jobId,
              category: String(category),
              type: isEmergency ? "emergency_lead" : "job_lead",
              wave: String(wave),
            },
          })
        )
      );
    }
  }

  const mergedNotifiedIds = Array.from(new Set([...previouslyNotified, ...recipientIds])).slice(0, 100);
  const updatePayload: Record<string, any> =
    wave === 2
      ? {
          leadWave2ExpandedAt: nowIso,
          leadWave2NotifiedCount: notifiedCount,
          notifiedTraderIds: mergedNotifiedIds,
        }
      : {
          leadsDistributedAt: nowIso,
          leadsDistributedCount: Number(jobData.leadsDistributedCount || 0) + notifiedCount,
          notifiedTraderIds: mergedNotifiedIds,
        };

  await jobRef.set(updatePayload, { merge: true }).catch(() => {});

  return {
    notifiedCount,
    skippedAlreadyDistributed: false,
    recipientIds,
    wave,
  };
}

/**
 * Phase 4 — Dynamic Wave 2 Radius Expansion:
 * Scans recently posted open public jobs with < 2 quotes (after 15m for emergency or 2h for standard)
 * that haven't received Wave 2 yet, expands radius by +10 miles, and notifies the next top local pros.
 */
export async function expandLowQuoteJobsWave2(options: {
  db: any;
  nowMs?: number;
  extraRadiusMiles?: number;
  maxJobsPerRun?: number;
  dispatchFcmPush?: DistributeJobLeadsOptions["dispatchFcmPush"];
}): Promise<{ jobsScanned: number; jobsExpanded: number; totalTradersNotified: number }> {
  const { db, nowMs = Date.now(), extraRadiusMiles = 10, maxJobsPerRun = 20, dispatchFcmPush } = options;
  if (!db) return { jobsScanned: 0, jobsExpanded: 0, totalTradersNotified: 0 };

  let openSnap: any;
  try {
    openSnap = await db
      .collection("jobs")
      .where("status", "in", ["open", "posted", "quoting"])
      .limit(100)
      .get();
  } catch {
    return { jobsScanned: 0, jobsExpanded: 0, totalTradersNotified: 0 };
  }

  let jobsScanned = 0;
  let jobsExpanded = 0;
  let totalTradersNotified = 0;

  for (const docSnap of openSnap.docs || []) {
    if (jobsExpanded >= maxJobsPerRun) break;
    jobsScanned++;
    const job = docSnap.data() || {};

    if (!isOpenJobStatus(job.status)) continue;
    if (job.clientDeleted === true || job.isDirectJob === true || job.visibility === "private" || job.visibility === "direct") {
      continue;
    }
    if (job.leadWave2ExpandedAt) continue;
    if (Number(job.quoteCount || 0) >= 2) continue;

    // Wait until exclusive window ends before expanding to Wave 2
    if (isWithinExclusiveWindow(job, nowMs)) continue;

    const createdMs = parseTimestampToMs(job.createdAt || job.postedDate);
    if (createdMs === null) continue;

    const isEmergency = job.isEmergency === true || String(job.urgency || "").toLowerCase() === "emergency";
    const minAgeMs = isEmergency ? 15 * 60 * 1000 : 2 * 60 * 60 * 1000;
    const maxAgeMs = 48 * 60 * 60 * 1000;
    const ageMs = nowMs - createdMs;
    if (ageMs < minAgeMs || ageMs > maxAgeMs) continue;

    const res = await distributeJobLeadsAuthoritative({
      db,
      jobId: docSnap.id,
      jobData: job,
      wave: 2,
      extraRadiusMiles,
      maxRecipients: 15,
      dispatchFcmPush,
    });

    jobsExpanded++;
    totalTradersNotified += res.notifiedCount;
  }

  return { jobsScanned, jobsExpanded, totalTradersNotified };
}
