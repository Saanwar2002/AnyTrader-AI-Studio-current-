/**
 * Server-Authoritative Instant Match Trader Eligibility & Deterministic Scoring (AT-MATCH-08)
 *
 * Interlinked with the unified AnyTrader matching core (`src/lib/unifiedJobMatching.ts`):
 * - Hard geographic radius cutoff (prevents out-of-area traders stealing local emergencies)
 * - Strict trade category & regulated certification eligibility
 * - Active, verified, non-frozen, available trader & public projection enforcement
 * - Deterministic proximity + video + rating + behavioral velocity scoring (zero Math.random)
 * - Transactional Accept (off-job arrival PIN) & Decline (updates parent `instant_matches` so worker advances immediately!)
 */

import {
  computeBehavioralAndFairnessScore,
  evaluateCategoryAlignment,
  evaluateCertificationEligibility,
  evaluateGeographicFit,
  extractTraderRating,
  isTraderVideoVerified,
  parseTimestampToMs,
} from "../lib/unifiedJobMatching.ts";

export interface InstantMatchJobContext {
  jobCategory?: string | null;
  category?: string | null;
  jobSubCategory?: string | null;
  subCategory?: string | null;
  jobText?: string;
  jobPostcode?: string;
  postcode?: string;
  jobLat?: number | null;
  jobLng?: number | null;
  lat?: number | null;
  lng?: number | null;
  requiredCertifications?: string[];
  triedTraderIds?: string[];
}

export interface InstantMatchScoreResult {
  eligible: boolean;
  score: number;
  scheduleSignalApplied: boolean;
  distanceMiles?: number | null;
  rejectionReason?: string;
}

function isDateExpired(value: unknown, nowMs: number): boolean {
  if (!value) return false;
  const parsed = parseTimestampToMs(value);
  return parsed !== null && parsed < nowMs;
}

export function evaluateInstantMatchCandidate(
  traderId: string,
  userData: Record<string, any>,
  publicProfileData: Record<string, any> | null,
  config: Record<string, any>,
  jobContext: InstantMatchJobContext,
  options?: { requirePublicProjection?: boolean }
): InstantMatchScoreResult {
  const tried = jobContext.triedTraderIds || [];
  if (tried.includes(traderId)) {
    return { eligible: false, score: 0, scheduleSignalApplied: false, rejectionReason: "already_tried" };
  }

  if (!userData || typeof userData !== "object") {
    return { eligible: false, score: 0, scheduleSignalApplied: false, rejectionReason: "missing_user_record" };
  }

  const accountStatus = String(userData.status || "").trim().toLowerCase();
  if (
    userData.isDisabled === true ||
    userData.isSuspended === true ||
    userData.disabled === true ||
    userData.isBanned === true ||
    userData.banned === true ||
    userData.deleted === true ||
    ["suspended", "frozen", "banned", "deleted", "disabled"].includes(accountStatus)
  ) {
    return { eligible: false, score: 0, scheduleSignalApplied: false, rejectionReason: "account_inactive_or_suspended" };
  }

  // Must be verified and not expired/revoked
  const verificationStatus = String(userData.verificationStatus || "").trim().toLowerCase();
  if (["rejected", "revoked", "expired", "suspended", "unverified"].includes(verificationStatus)) {
    return { eligible: false, score: 0, scheduleSignalApplied: false, rejectionReason: "verification_ineligible" };
  }
  if (userData.isVerified === false || (config?.imRequireVerified && !userData.isVerified)) {
    return { eligible: false, score: 0, scheduleSignalApplied: false, rejectionReason: "not_verified" };
  }

  const nowMs = Date.now();
  if (
    isDateExpired(userData.verificationExpiresAt, nowMs) ||
    isDateExpired(userData.insuranceExpiry, nowMs) ||
    isDateExpired(userData.credentialsExpiresAt, nowMs)
  ) {
    return { eligible: false, score: 0, scheduleSignalApplied: false, rejectionReason: "expired_credentials" };
  }

  // Exclude non-trade property businesses
  if (
    String(userData.role || "").trim().toLowerCase() === "business" &&
    String(userData.businessLayer || "").trim().toLowerCase() === "properties"
  ) {
    return { eligible: false, score: 0, scheduleSignalApplied: false, rejectionReason: "property_business_account" };
  }

  // Availability checks
  if (
    userData.acceptingNewWork === false ||
    userData.isAcceptingRequests === false ||
    userData.isAvailableForInstantMatch === false ||
    String(userData.availabilityStatus || "").toLowerCase() === "unavailable"
  ) {
    return { eligible: false, score: 0, scheduleSignalApplied: false, rejectionReason: "trader_unavailable" };
  }

  if (publicProfileData) {
    if (
      publicProfileData.isSuspended === true ||
      publicProfileData.isDisabled === true ||
      publicProfileData.acceptingNewWork === false ||
      publicProfileData.isAcceptingRequests === false ||
      publicProfileData.isAvailableForInstantMatch === false
    ) {
      return { eligible: false, score: 0, scheduleSignalApplied: false, rejectionReason: "public_projection_ineligible" };
    }
  } else if (options?.requirePublicProjection) {
    return { eligible: false, score: 0, scheduleSignalApplied: false, rejectionReason: "public_projection_retracted" };
  }

  if (config?.imRequireEmergencyToggle && !userData.isAvailableForEmergency) {
    return { eligible: false, score: 0, scheduleSignalApplied: false, rejectionReason: "emergency_toggle_off" };
  }

  const resolvedJobCategory = jobContext.jobCategory ?? jobContext.category ?? null;
  const resolvedJobSubCategory = jobContext.jobSubCategory ?? jobContext.subCategory ?? null;
  const resolvedJobPostcode = jobContext.jobPostcode ?? jobContext.postcode ?? "";
  const resolvedJobLat = jobContext.jobLat ?? jobContext.lat ?? null;
  const resolvedJobLng = jobContext.jobLng ?? jobContext.lng ?? null;

  const syntheticJob = {
    category: resolvedJobCategory || "",
    subCategory: resolvedJobSubCategory || "",
    title: jobContext.jobText || "",
    description: "",
    postcode: resolvedJobPostcode,
    lat: resolvedJobLat,
    lng: resolvedJobLng,
    requiredCertifications: jobContext.requiredCertifications,
  };

  const mergedTrader = {
    ...(publicProfileData || {}),
    ...userData,
    postcode: userData.postcode || publicProfileData?.postcode || "",
  };

  // Strict category enforcement (default ON when job category is known, unless explicitly disabled)
  const categoryAlignment = evaluateCategoryAlignment(mergedTrader, syntheticJob, { mode: "strict" });
  const targetCatNorm = String(resolvedJobCategory || "").trim().toLowerCase();
  const isSpecificCategory = Boolean(targetCatNorm && targetCatNorm !== "general" && targetCatNorm !== "all");
  if (isSpecificCategory && config?.imRequireCategoryMatch !== false && !categoryAlignment.matched) {
    return { eligible: false, score: 0, scheduleSignalApplied: false, rejectionReason: "category_mismatch" };
  }

  // Regulated certification hard gate
  const certEligibility = evaluateCertificationEligibility(mergedTrader, syntheticJob);
  if (!certEligibility.eligible) {
    return {
      eligible: false,
      score: 0,
      scheduleSignalApplied: false,
      rejectionReason: certEligibility.reason || "certification_ineligible",
    };
  }

  if (config?.imRequireTagMatch && jobContext.jobText) {
    const tags = Array.isArray(userData.tags) ? userData.tags : [];
    const lowerText = jobContext.jobText.toLowerCase();
    const hasMatch = tags.some(
      (tag: any) => typeof tag === "string" && tag.trim() && lowerText.includes(tag.toLowerCase().trim())
    );
    if (!hasMatch && tags.length > 0) {
      return { eligible: false, score: 0, scheduleSignalApplied: false, rejectionReason: "tag_mismatch" };
    }
  }

  // HARD GEOGRAPHIC RADIUS CUTOFF (prevents out-of-area traders stealing local emergency Instant Matches)
  const geoFit = evaluateGeographicFit(mergedTrader, syntheticJob, {
    overrideRadiusMiles:
      typeof config?.imMaxRadiusMiles === "number" && config.imMaxRadiusMiles > 0
        ? config.imMaxRadiusMiles
        : null,
  });
  if (!geoFit.withinRadius) {
    return {
      eligible: false,
      score: 0,
      scheduleSignalApplied: false,
      distanceMiles: geoFit.distanceMiles,
      rejectionReason:
        geoFit.matchType === "out_of_radius" ? "out_of_radius" : "location_unlocatable",
    };
  }

  // Deterministic, authoritative scoring (zero Math.random)
  let score = 0;

  if (userData.isAvailableForEmergency) score += 50;
  if (userData.isVerified) score += 20;
  if (categoryAlignment.matched || !isSpecificCategory) score += 30;

  if (jobContext.jobText && Array.isArray(userData.tags)) {
    const lowerText = jobContext.jobText.toLowerCase();
    const matchedTags = userData.tags.filter(
      (tag: any) => typeof tag === "string" && tag.trim() && lowerText.includes(tag.toLowerCase().trim())
    ).length;
    score += Math.min(25, matchedTags * 5);
  }

  if (isTraderVideoVerified(mergedTrader)) {
    score += 25;
  }

  // Geodesic proximity tier bonus (rewards truly closest local pros)
  if (geoFit.distanceMiles !== null) {
    if (geoFit.distanceMiles <= 3) score += 45;
    else if (geoFit.distanceMiles <= 8) score += 30;
    else if (geoFit.distanceMiles <= 15) score += 18;
    else score += 8;
  } else if (geoFit.matchType === "service_area") {
    score += 20;
  }

  const rating = extractTraderRating(mergedTrader);
  if (rating > 0) {
    score += Math.min(15, Math.round(rating * 3));
  }

  const completedJobs = Number(
    userData.totalJobsDone ?? userData.completedJobs ?? publicProfileData?.totalJobsDone ?? publicProfileData?.completedJobs ?? 0
  );
  if (Number.isFinite(completedJobs) && completedJobs > 0) {
    score += Math.min(10, Math.floor(completedJobs / 5));
  }

  const scheduleActive = Boolean(
    userData.isAvailableForInstantMatch === true ||
      userData.isAvailableForEmergency === true ||
      userData.calendarSyncEnabled === true ||
      userData.availabilityStatus === "immediate"
  );
  if (scheduleActive) {
    score += 10;
  }

  const normalizedTier = String(
    userData.tier || userData.tierId || userData.subscriptionTier || ""
  )
    .trim()
    .toLowerCase();
  const premiumTiers = new Set([
    "pro",
    "gold",
    "platinum",
    "enterprise",
    "business_pro",
    "silver professional",
    "gold elite",
    "platinum enterprise",
  ]);
  if (normalizedTier && premiumTiers.has(normalizedTier)) {
    score += 15;
  }

  // Real behavioral velocity & capacity balance (bounded -12..+18)
  const behavioral = computeBehavioralAndFairnessScore(mergedTrader);
  score += Math.max(-12, Math.min(18, behavioral.bonusPoints));

  return {
    eligible: true,
    score: Math.max(0, Math.round(score)),
    scheduleSignalApplied: scheduleActive,
    distanceMiles: geoFit.distanceMiles,
  };
}

export async function respondToInstantMatchAttempt(options: {
  db: any;
  uid: string;
  attemptId: string;
  action: "accept" | "decline";
}): Promise<{ status: "accepted" | "declined"; jobId?: string; instantMatchId: string; attemptNumber?: number }> {
  const { db, uid, attemptId, action } = options;
  if (!db) throw new Error("Database not initialized");
  if (!uid || !attemptId) throw new Error("Missing trader identity or attemptId");

  const attemptRef = db.collection("instant_match_attempts").doc(attemptId);
  const userRef = db.collection("users").doc(uid);

  const txResult = await db.runTransaction(async (tx: any) => {
    const [attemptSnap, userSnap] = await Promise.all([tx.get(attemptRef), tx.get(userRef)]);
    if (!attemptSnap.exists) {
      const err: any = new Error("Instant match attempt not found.");
      err.statusCode = 404;
      throw err;
    }
    const attempt = attemptSnap.data() || {};
    if (attempt.traderId !== uid) {
      const err: any = new Error("Forbidden: this instant match offer was assigned to another trader.");
      err.statusCode = 403;
      throw err;
    }
    if (attempt.status !== "pending" && attempt.status !== "notified") {
      const err: any = new Error(`Instant match attempt is already '${attempt.status}'.`);
      err.statusCode = 409;
      throw err;
    }

    const nowIso = new Date().toISOString();
    const matchId = String(attempt.instantMatchId || "");
    const matchRef = matchId ? db.collection("instant_matches").doc(matchId) : null;

    if (action === "decline") {
      const matchSnap = matchRef ? await tx.get(matchRef) : null;
      tx.update(attemptRef, { status: "declined", respondedAt: nowIso });
      // Wake up instant_matches listener immediately so Candidate #2 is offered without stalling!
      if (matchSnap && matchSnap.exists) {
        const matchData = matchSnap.data() || {};
        if (matchData.status === "searching") {
          tx.update(matchRef, {
            lastDeclinedAttemptNumber: Number(attempt.attemptNumber || matchData.currentAttempt || 1),
            lastDeclinedTraderId: uid,
            lastDeclinedAt: nowIso,
            updatedAt: nowIso,
          });
        }
      }
      return {
        status: "declined" as const,
        instantMatchId: matchId,
        attemptNumber: Number(attempt.attemptNumber || 1),
      };
    }

    if (attempt.expiresAt && Date.parse(String(attempt.expiresAt)) < Date.now()) {
      const err: any = new Error("Instant match attempt has expired.");
      err.statusCode = 409;
      throw err;
    }

    const userData = userSnap.exists ? userSnap.data() || {} : {};
    const status = String(userData.status || "").toLowerCase();
    if (
      userData.isDisabled === true ||
      userData.isSuspended === true ||
      userData.isBanned === true ||
      userData.deleted === true ||
      ["suspended", "frozen", "banned", "deleted", "disabled"].includes(status) ||
      userData.isVerified === false
    ) {
      const err: any = new Error("Your tradesperson account must be active and verified to accept Instant Match offers.");
      err.statusCode = 403;
      throw err;
    }

    if (!matchRef) {
      const err: any = new Error("Instant match session no longer exists.");
      err.statusCode = 404;
      throw err;
    }
    const matchSnap = await tx.get(matchRef);
    if (!matchSnap.exists) {
      const err: any = new Error("Instant match session no longer exists.");
      err.statusCode = 404;
      throw err;
    }
    const matchData = matchSnap.data() || {};
    if (matchData.status !== "searching") {
      const err: any = new Error(`Instant match session is already '${matchData.status}'.`);
      err.statusCode = 409;
      throw err;
    }

    const jobId = String(matchData.jobId || "");
    const jobRef = jobId ? db.collection("jobs").doc(jobId) : null;
    const jobSnap = jobRef ? await tx.get(jobRef) : null;
    const jobData = jobSnap && jobSnap.exists ? jobSnap.data() || {} : null;

    if (jobData && ["accepted", "in_progress", "completed", "cancelled", "disputed"].includes(String(jobData.status || ""))) {
      const err: any = new Error(`Job is already '${jobData.status}' and can no longer be accepted.`);
      err.statusCode = 409;
      throw err;
    }

    const traderName = userData.businessName || userData.fullName || userData.name || "Verified Tradesperson";

    tx.update(attemptRef, {
      status: "accepted",
      respondedAt: nowIso,
    });

    tx.update(matchRef, {
      status: "matched",
      matchedTraderId: uid,
      matchedAt: nowIso,
      updatedAt: nowIso,
    });

    let homeownerId: string | null = null;
    if (jobRef && jobData) {
      homeownerId = jobData.homeownerId || jobData.userId || jobData.ownerId || null;
      const pinRef = db.collection("job_arrival_pins").doc(jobId);
      const arrivalPin = String(Math.floor(1000 + Math.random() * 9000));

      tx.update(jobRef, {
        status: "accepted",
        acceptedTradespersonId: uid,
        acceptedTraderId: uid,
        acceptedTradespersonName: traderName,
        matchedViaInstantMatch: true,
        instantMatchId: matchRef.id,
        hasVerificationPin: true,
        updatedAt: nowIso,
      });

      tx.set(pinRef, {
        jobId,
        homeownerId: homeownerId || "",
        acceptedTradespersonId: uid,
        verificationPin: arrivalPin,
        createdAt: nowIso,
        verifiedAt: null,
        verifiedByUid: null,
      });

      const publicCardRef = db.collection("public_job_cards").doc(jobId);
      tx.delete(publicCardRef);
    }

    return {
      status: "accepted" as const,
      jobId: jobId || undefined,
      instantMatchId: matchRef.id,
      homeownerId,
      traderName,
      jobTitle: jobData?.title || "Emergency Job",
    };
  });

  if (txResult.status === "accepted" && txResult.homeownerId && txResult.jobId) {
    try {
      const notifRef = db.collection("notifications").doc();
      await notifRef.set({
        userId: txResult.homeownerId,
        type: "instant_match_accepted",
        title: "Instant Match Confirmed!",
        message: `${txResult.traderName} has accepted your Instant Match request for "${txResult.jobTitle}".`,
        jobId: txResult.jobId,
        link: `/job/${txResult.jobId}`,
        actionPath: `/job/${txResult.jobId}`,
        read: false,
        isRead: false,
        createdAt: new Date().toISOString(),
      });
    } catch {
      // Non-blocking notification failure
    }
  }

  return {
    status: txResult.status,
    jobId: txResult.jobId,
    instantMatchId: txResult.instantMatchId,
    attemptNumber: (txResult as any).attemptNumber,
  };
}
