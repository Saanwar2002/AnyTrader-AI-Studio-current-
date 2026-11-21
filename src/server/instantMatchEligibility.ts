/**
 * Server-Authoritative Instant Match Trader Eligibility & Deterministic Scoring (AT-MATCH-08)
 * Replaces unverified / randomized scoring with strict active, verified, non-frozen,
 * available trader eligibility backed by user & public discovery projections.
 */

export interface InstantMatchJobContext {
  jobCategory?: string | null;
  jobText?: string;
  jobPostcode?: string;
  triedTraderIds?: string[];
}

export interface InstantMatchScoreResult {
  eligible: boolean;
  score: number;
  scheduleSignalApplied: boolean;
  rejectionReason?: string;
}

function isDateExpired(value: unknown, nowMs: number): boolean {
  if (!value) return false;
  const iso = typeof (value as any)?.toDate === "function" ? (value as any).toDate().toISOString() : value;
  const parsed = Date.parse(String(iso));
  return Number.isFinite(parsed) && parsed < nowMs;
}

function normalizePostcodeParts(raw: unknown): { full: string; outcode: string; area: string } {
  const cleaned = String(raw || "").trim().toUpperCase().replace(/\s+/g, " ");
  if (!cleaned) return { full: "", outcode: "", area: "" };
  const compact = cleaned.replace(/\s+/g, "");
  const outcode = cleaned.includes(" ")
    ? cleaned.split(" ")[0]
    : compact.length > 3
      ? compact.slice(0, compact.length - 3)
      : compact;
  const areaMatch = outcode.match(/^[A-Z]{1,2}/);
  return { full: cleaned, outcode, area: areaMatch ? areaMatch[0] : outcode.slice(0, 2) };
}

function matchesCategoryStrict(userData: Record<string, any>, jobCategory: string | null | undefined): boolean {
  const target = String(jobCategory || "").trim().toLowerCase();
  if (!target || target === "general" || target === "all") return true;

  const collected: string[] = [];
  if (typeof userData.primaryTrade === "string") collected.push(userData.primaryTrade);
  if (typeof userData.trade === "string") collected.push(userData.trade);
  if (typeof userData.category === "string") collected.push(userData.category);
  if (Array.isArray(userData.trades)) collected.push(...userData.trades.map(String));
  if (Array.isArray(userData.categories)) collected.push(...userData.categories.map(String));
  if (Array.isArray(userData.verifiedCategories)) collected.push(...userData.verifiedCategories.map(String));

  const normalized = collected.map((c) => c.trim().toLowerCase()).filter(Boolean);
  if (normalized.length === 0) return false;
  return normalized.some((entry) => entry === target || entry.includes(target) || target.includes(entry));
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

  // Availability checks
  if (
    userData.acceptingNewWork === false ||
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

  if (config?.imRequireCategoryMatch && jobContext.jobCategory) {
    if (!matchesCategoryStrict(userData, jobContext.jobCategory)) {
      return { eligible: false, score: 0, scheduleSignalApplied: false, rejectionReason: "category_mismatch" };
    }
  }

  if (config?.imRequireTagMatch && jobContext.jobText) {
    const tags = Array.isArray(userData.tags) ? userData.tags : [];
    const lowerText = jobContext.jobText.toLowerCase();
    const hasMatch = tags.some((tag: any) => typeof tag === "string" && tag.trim() && lowerText.includes(tag.toLowerCase().trim()));
    if (!hasMatch && tags.length > 0) {
      return { eligible: false, score: 0, scheduleSignalApplied: false, rejectionReason: "tag_mismatch" };
    }
  }

  // Deterministic, authoritative scoring (zero Math.random)
  let score = 0;

  if (userData.isAvailableForEmergency) score += 50;
  if (userData.isVerified) score += 20;
  if (matchesCategoryStrict(userData, jobContext.jobCategory)) score += 30;

  if (jobContext.jobText && Array.isArray(userData.tags)) {
    const lowerText = jobContext.jobText.toLowerCase();
    const matchedTags = userData.tags.filter(
      (tag: any) => typeof tag === "string" && tag.trim() && lowerText.includes(tag.toLowerCase().trim())
    ).length;
    score += Math.min(25, matchedTags * 5);
  }

  if (userData.videoVerificationStatus === "verified" || (userData.hasVerifiedVideoProSubscription && userData.videoVerificationUrl)) {
    score += 25;
  }

  const jobLoc = normalizePostcodeParts(jobContext.jobPostcode);
  const traderLoc = normalizePostcodeParts(userData.postcode || publicProfileData?.postcode);
  if (jobLoc.full && traderLoc.full) {
    if (traderLoc.full === jobLoc.full) {
      score += 40;
    } else if (traderLoc.outcode && traderLoc.outcode === jobLoc.outcode) {
      score += 15;
    } else if (traderLoc.area && traderLoc.area === jobLoc.area) {
      score += 8;
    }
  }

  const rating = Number(userData.rating ?? publicProfileData?.rating ?? 0);
  if (Number.isFinite(rating) && rating > 0) {
    score += Math.min(15, Math.round(rating * 3));
  }

  const completedJobs = Number(userData.totalJobsDone ?? publicProfileData?.totalJobsDone ?? 0);
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

  const premiumTiers = ["Gold Elite", "Platinum Enterprise", "Silver Professional"];
  if (userData.tierId && premiumTiers.includes(userData.tierId)) {
    score += 15;
  }

  return {
    eligible: true,
    score,
    scheduleSignalApplied: scheduleActive,
  };
}

export async function respondToInstantMatchAttempt(options: {
  db: any;
  uid: string;
  attemptId: string;
  action: "accept" | "decline";
}): Promise<{ status: "accepted" | "declined"; jobId?: string; instantMatchId: string }> {
  const { db, uid, attemptId, action } = options;
  if (!db) throw new Error("Database not initialized");
  if (!uid || !attemptId) throw new Error("Missing trader identity or attemptId");

  const attemptRef = db.collection("instant_match_attempts").doc(attemptId);
  const userRef = db.collection("users").doc(uid);

  return db.runTransaction(async (tx: any) => {
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
    if (attempt.status !== "pending") {
      const err: any = new Error(`Instant match attempt is already '${attempt.status}'.`);
      err.statusCode = 409;
      throw err;
    }

    const nowIso = new Date().toISOString();
    if (action === "decline") {
      tx.update(attemptRef, { status: "declined", respondedAt: nowIso });
      return { status: "declined", instantMatchId: String(attempt.instantMatchId || "") };
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

    const matchRef = db.collection("instant_matches").doc(String(attempt.instantMatchId || ""));
    const matchSnap = await tx.get(matchRef);
    if (!matchSnap.exists) {
      const err: any = new Error("Instant match session no longer exists.");
      err.statusCode = 404;
      throw err;
    }
    const matchData = matchSnap.data() || {};
    if (matchData.status !== "searching") {
      const err: any = new Error(`Instant match is already '${matchData.status}'.`);
      err.statusCode = 409;
      throw err;
    }

    const jobId = String(matchData.jobId || "");
    if (!jobId) {
      const err: any = new Error("Instant match is missing a job reference.");
      err.statusCode = 400;
      throw err;
    }
    const jobRef = db.collection("jobs").doc(jobId);
    const jobSnap = await tx.get(jobRef);
    if (!jobSnap.exists) {
      const err: any = new Error("Associated job not found.");
      err.statusCode = 404;
      throw err;
    }
    const jobData = jobSnap.data() || {};
    if (jobData.acceptedTradespersonId && jobData.acceptedTradespersonId !== uid) {
      const err: any = new Error("Job has already been claimed by another tradesperson.");
      err.statusCode = 409;
      throw err;
    }

    const pin = Math.floor(1000 + Math.random() * 9000).toString();
    const homeownerId = jobData.homeownerId || jobData.userId || jobData.ownerId || jobData.customerId || "";
    const arrivalPinRef = db.collection("job_arrival_pins").doc(jobId);

    tx.update(attemptRef, { status: "accepted", respondedAt: nowIso });
    tx.update(matchRef, { status: "matched", matchedTraderId: uid, matchedAt: nowIso });
    tx.set(
      arrivalPinRef,
      {
        jobId,
        homeownerId,
        verificationPin: pin,
        createdAt: nowIso,
        updatedAt: nowIso,
      },
      { merge: true }
    );
    tx.update(jobRef, {
      status: "accepted",
      acceptedTradespersonId: uid,
      acceptedTraderId: uid,
      isInstantMatchAccepted: true,
      isConfirmedByTradesperson: true,
      scheduledDate: nowIso.split("T")[0],
      hasVerificationPin: true,
      updatedAt: nowIso,
    });

    return { status: "accepted", jobId, instantMatchId: String(attempt.instantMatchId || "") };
  });
}

