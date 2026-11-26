import admin from 'firebase-admin';
import Stripe from 'stripe';
import { randomUUID } from 'crypto';
import { evaluateInstantMatchCandidate } from './src/server/instantMatchEligibility.ts';
import { extractJobPostcode, extractJobSubCategory, isTraderInQuietHours } from './src/lib/unifiedJobMatching.ts';

let stripeClient: Stripe | null = null;
function getStripeClient(): Stripe | null {
  if (!stripeClient) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (key) {
      stripeClient = new Stripe(key);
    }
  }
  return stripeClient;
}

let globalConfig: any = {
  imMaxAttempts: 10,
  imAttemptIntervalSeconds: 60,
  imRequireEmergencyToggle: false,
  imRequireVerified: true,
  imRequireCategoryMatch: true,
  imRequireTagMatch: false,
};

export interface InstantMatchAlertDispatchHooks {
  dispatchFcmPush?: (payload: {
    recipientId: string;
    title: string;
    body: string;
    channelId: string;
    eventType: string;
    data: Record<string, string>;
  }) => Promise<any>;
}

let registeredAlertHooks: InstantMatchAlertDispatchHooks = {};
const processingMatches = new Set<string>();

export async function expireAndRefundInstantMatch(db: admin.firestore.Firestore, matchRef: admin.firestore.DocumentReference, stripe: Stripe | null, reason: string): Promise<void> {
  const refundRef = db.collection("instant_match_refunds").doc(matchRef.id);
  const nowMs = Date.now();
  const claimToken = randomUUID();
  const leaseMs = 5 * 60 * 1000;
  const safeRetryWindowMs = 23 * 60 * 60 * 1000;
  const operation = await db.runTransaction(async (tx: any) => {
    const [matchSnap, refundSnap] = await Promise.all([tx.get(matchRef), tx.get(refundRef)]);
    if (!matchSnap.exists) return { action: "stop" as const };
    const match = matchSnap.data() || {};
    const existing = refundSnap.exists ? refundSnap.data() || {} : null;
    const paymentIntentId = match.stripePaymentIntentId;
    const amount = Number(match.chargeAmountPence);
    const currency = String(match.currency || "").toLowerCase();
    const validEvidence = typeof paymentIntentId === "string" && /^pi_[A-Za-z0-9]+$/.test(paymentIntentId) &&
      Number.isSafeInteger(amount) && amount > 0 && /^[a-z]{3}$/.test(currency);

    if (existing) {
      if (existing.status !== "processing") return { action: "stop" as const };
      const existingCreatedAtMs = Number(existing.createdAtMs);
      if (!Number.isSafeInteger(existingCreatedAtMs) || existingCreatedAtMs <= 0 ||
          nowMs - existingCreatedAtMs >= safeRetryWindowMs) {
        tx.set(refundRef, { status: "reconciliation_required", error: "refund_idempotency_window_expired_or_unknown", updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        tx.set(matchRef, { refundStatus: "reconciliation_required" }, { merge: true });
        return { action: "stop" as const };
      }
      if (!validEvidence || existing.paymentIntentId !== paymentIntentId ||
          existing.amount !== amount || String(existing.currency || "").toLowerCase() !== currency ||
          typeof existing.idempotencyKey !== "string" || existing.idempotencyKey !== "instant-match-expiry:" + matchRef.id) {
        tx.set(refundRef, { status: "manual_review", error: "refund_operation_binding_mismatch", updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        tx.set(matchRef, { refundStatus: "manual_review", refundReviewReason: "refund_operation_binding_mismatch" }, { merge: true });
        return { action: "stop" as const };
      }
      if (Number(existing.leaseExpiresAtMs || 0) > nowMs) return { action: "stop" as const };
      tx.set(refundRef, {
        claimToken, claimedAtMs: nowMs, leaseExpiresAtMs: nowMs + leaseMs,
        attemptCount: Number(existing.attemptCount || 1) + 1,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      return {
        action: "refund" as const, paymentIntentId, idempotencyKey: existing.idempotencyKey,
        amount, currency, claimToken
      };
    }

    if (match.status !== "searching") return { action: "stop" as const };
    if (!validEvidence) {
      tx.set(matchRef, { status: "expired", expiredAt: match.expiredAt || new Date().toISOString(), refundStatus: "manual_review", refundReviewReason: "missing_or_invalid_payment_intent_or_amount" }, { merge: true });
      tx.set(refundRef, { instantMatchId: matchRef.id, status: "manual_review", reason: "missing_or_invalid_payment_intent_or_amount", updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      return { action: "stop" as const };
    }
    const idempotencyKey = "instant-match-expiry:" + matchRef.id;
    tx.set(matchRef, { status: "expired", expiredAt: match.expiredAt || new Date().toISOString(), refundStatus: "processing" }, { merge: true });
    tx.set(refundRef, {
      instantMatchId: matchRef.id, paymentIntentId, amount, currency, idempotencyKey, reason,
      status: "processing", claimToken, createdAtMs: nowMs, claimedAtMs: nowMs,
      leaseExpiresAtMs: nowMs + leaseMs, attemptCount: 1,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    return { action: "refund" as const, paymentIntentId, idempotencyKey, amount, currency, claimToken };
  });
  if (operation.action !== "refund") return;

  if (!stripe) {
    await db.runTransaction(async (tx: any) => {
      const [latestMatch, latestRefund] = await Promise.all([tx.get(matchRef), tx.get(refundRef)]);
      if (!latestMatch.exists || !latestRefund.exists) return;
      const current = latestRefund.data() || {};
      if (current.status !== "processing" || current.claimToken !== operation.claimToken) return;
      tx.set(refundRef, { status: "reconciliation_required", error: "stripe_client_unavailable", updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      tx.set(matchRef, { refundStatus: "reconciliation_required" }, { merge: true });
    });
    return;
  }

  try {
    const refund = await stripe.refunds.create({
      payment_intent: operation.paymentIntentId,
      amount: operation.amount,
      reason: "requested_by_customer",
      metadata: { instantMatchId: matchRef.id, operationType: "ANYTRADER_INSTANT_MATCH_EXPIRY" }
    }, { idempotencyKey: operation.idempotencyKey });
    const returnedPaymentIntentId = typeof refund.payment_intent === "string"
      ? refund.payment_intent
      : refund.payment_intent?.id;
    const responseMatchesOperation = typeof refund.id === "string" && refund.id.trim() !== "" &&
      returnedPaymentIntentId === operation.paymentIntentId &&
      refund.amount === operation.amount &&
      String(refund.currency || "").toLowerCase() === operation.currency;
    const status = !responseMatchesOperation
      ? "manual_review"
      : refund.status === "succeeded" ? "succeeded"
      : (refund.status === "failed" || refund.status === "canceled") ? "manual_review"
      : "processing";
    await db.runTransaction(async (tx: any) => {
      const [latestMatch, latestRefund] = await Promise.all([tx.get(matchRef), tx.get(refundRef)]);
      if (!latestMatch.exists || !latestRefund.exists) throw new Error("Instant Match refund operation disappeared.");
      const currentRefund = latestRefund.data() || {};
      if (currentRefund.status !== "processing" || currentRefund.claimToken !== operation.claimToken ||
          currentRefund.paymentIntentId !== operation.paymentIntentId ||
          currentRefund.idempotencyKey !== operation.idempotencyKey ||
          currentRefund.amount !== operation.amount ||
          String(currentRefund.currency || "").toLowerCase() !== operation.currency) return;
      tx.set(refundRef, {
        status,
        stripeRefundId: typeof refund.id === "string" ? refund.id : null,
        stripeRefundStatus: refund.status || null,
        claimToken: admin.firestore.FieldValue.delete(),
        leaseExpiresAtMs: status === "processing" ? Date.now() + leaseMs : 0,
        ...(!responseMatchesOperation ? { error: "stripe_refund_response_mismatch" } : {}),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      tx.set(matchRef, {
        refundStatus: status,
        ...(typeof refund.id === "string" ? { stripeRefundId: refund.id } : {})
      }, { merge: true });
    });
  } catch (err: any) {
    const message = err?.message || String(err);
    await db.runTransaction(async (tx: any) => {
      const [latestMatch, latestRefund] = await Promise.all([tx.get(matchRef), tx.get(refundRef)]);
      if (!latestMatch.exists || !latestRefund.exists) return;
      const currentRefund = latestRefund.data() || {};
      if (currentRefund.status !== "processing" || currentRefund.claimToken !== operation.claimToken ||
          currentRefund.paymentIntentId !== operation.paymentIntentId ||
          currentRefund.idempotencyKey !== operation.idempotencyKey) return;
      tx.set(refundRef, {
        status: "reconciliation_required", error: message.slice(0, 500),
        claimToken: admin.firestore.FieldValue.delete(), leaseExpiresAtMs: 0,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      tx.set(matchRef, { refundStatus: "reconciliation_required" }, { merge: true });
    });
    console.error("Instant Match refund outcome requires reconciliation:", err);
  }
}

/**
 * Evaluates a single searching Instant Match session and advances it cleanly:
 * - Creates Attempt #1 if none exist
 * - Advances immediately when latest attempt was DECLINED (fixes P0 stall bug!)
 * - Marks timed-out pending/notified attempts as `timeout` and advances
 * - Expires & triggers idempotent Stripe refund once `imMaxAttempts` is exhausted
 */
export async function processSearchingInstantMatch(
  db: admin.firestore.Firestore | any,
  matchRef: any,
  matchData: Record<string, any>,
  config: Record<string, any> = globalConfig
): Promise<{ action: "created_attempt" | "expired" | "waiting" | "skipped"; attemptNumber?: number }> {
  if (!matchData || matchData.status !== "searching") {
    return { action: "skipped" };
  }

  const attemptsSnap = await db.collection("instant_match_attempts")
    .where("instantMatchId", "==", matchRef.id)
    .get();

  const attemptDocs = [...(attemptsSnap.docs || [])].sort((a: any, b: any) => {
    const numA = Number(a.data()?.attemptNumber || 0);
    const numB = Number(b.data()?.attemptNumber || 0);
    return numB - numA;
  });

  const latestDoc = attemptDocs[0];
  const latestAttempt = latestDoc?.data();
  const latestAttemptRef = latestDoc?.ref;
  const now = new Date();
  const maxAttempts = config.imMaxAttempts ?? 10;

  if (!latestAttempt) {
    const created = await initiateNextAttempt(db, matchRef, matchData, 1, config);
    return created ? { action: "created_attempt", attemptNumber: 1 } : { action: "expired" };
  }

  // Case 1: Latest attempt was explicitly DECLINED -> advance immediately!
  if (latestAttempt.status === "declined" || latestAttempt.status === "timeout") {
    const nextAttemptNum = Number(latestAttempt.attemptNumber || 1) + 1;
    if (nextAttemptNum > maxAttempts) {
      await expireAndRefundInstantMatch(db, matchRef, getStripeClient(), "attempts_exhausted");
      return { action: "expired" };
    }
    const created = await initiateNextAttempt(db, matchRef, matchData, nextAttemptNum, config);
    return created ? { action: "created_attempt", attemptNumber: nextAttemptNum } : { action: "expired" };
  }

  // Case 2: Latest attempt is pending/notified and timed out -> mark timeout and advance
  if (['pending', 'notified'].includes(latestAttempt.status)) {
    const expiresAt = new Date(latestAttempt.expiresAt);
    if (!Number.isNaN(expiresAt.getTime()) && expiresAt < now) {
      await latestAttemptRef.update({
        status: "timeout",
        respondedAt: now.toISOString(),
      });

      const nextAttemptNum = Number(latestAttempt.attemptNumber || 1) + 1;
      if (nextAttemptNum > maxAttempts) {
        await expireAndRefundInstantMatch(db, matchRef, getStripeClient(), "attempts_exhausted");
        return { action: "expired" };
      }
      const created = await initiateNextAttempt(db, matchRef, matchData, nextAttemptNum, config);
      return created ? { action: "created_attempt", attemptNumber: nextAttemptNum } : { action: "expired" };
    }
  }

  return { action: "waiting" };
}

/**
 * Explicit server helper invoked by `POST /api/instant-match/respond` right after a trader
 * declines an attempt, guaranteeing immediate progression to Candidate #2 with zero polling delay.
 */
export async function advanceInstantMatchAfterDecline(
  db: admin.firestore.Firestore | any,
  instantMatchId: string,
  config: Record<string, any> = globalConfig
): Promise<{ action: "created_attempt" | "expired" | "waiting" | "skipped"; attemptNumber?: number }> {
  if (!db || !instantMatchId) return { action: "skipped" };
  if (processingMatches.has(instantMatchId)) return { action: "skipped" };
  processingMatches.add(instantMatchId);
  try {
    const matchRef = db.collection("instant_matches").doc(instantMatchId);
    const matchSnap = await matchRef.get();
    if (!matchSnap.exists) return { action: "skipped" };
    return await processSearchingInstantMatch(db, matchRef, matchSnap.data() || {}, config);
  } finally {
    processingMatches.delete(instantMatchId);
  }
}

export function startInstantMatchEngine(
  db: admin.firestore.Firestore,
  hooks?: InstantMatchAlertDispatchHooks
) {
  if (!db) return;
  if (hooks) {
    registeredAlertHooks = hooks;
  }
  console.log("Starting Instant Match Engine...");

  // Cache platform config
  let configUnsubscribe: (() => void) | null = null;
  configUnsubscribe = db.collection("platform_config").doc("global").onSnapshot(
    (doc) => {
      if (doc.exists) {
        const data = doc.data();
        if (data) {
          globalConfig = { ...globalConfig, ...data };
        }
      }
    },
    (err: any) => {
      const msg = err?.message || String(err);
      if (err?.code === 7 || msg.includes("7") || msg.includes("PERMISSION_DENIED") || msg.includes("Missing or insufficient permissions") || msg.includes("UNAUTHENTICATED") || msg.includes("Could not load the default credentials")) {
        if (configUnsubscribe) {
          try { configUnsubscribe(); } catch {}
        }
        return;
      }
      console.warn("Instant match config listener error:", err);
    }
  );

  // Real-time listener for searching matches (fires on new match AND on decline timestamp update!)
  let matchesUnsubscribe: (() => void) | null = null;
  matchesUnsubscribe = db.collection("instant_matches")
    .where("status", "==", "searching")
    .onSnapshot(async (matchesSnap) => {
      try {
        for (const matchDoc of matchesSnap.docs) {
          if (processingMatches.has(matchDoc.id)) continue;
          processingMatches.add(matchDoc.id);
          try {
            await processSearchingInstantMatch(db, matchDoc.ref, matchDoc.data() || {}, globalConfig);
          } finally {
            processingMatches.delete(matchDoc.id);
          }
        }
      } catch (err: any) {
        const msg = err?.message || String(err);
        if (!msg.includes("PERMISSION_DENIED") && !msg.includes("UNAUTHENTICATED")) {
          console.error("Error in Instant Match Engine onSnapshot handler:", err);
        }
      }
    }, (err: any) => {
      const msg = err?.message || String(err);
      if (err?.code === 7 || msg.includes("7") || msg.includes("PERMISSION_DENIED") || msg.includes("Missing or insufficient permissions") || msg.includes("UNAUTHENTICATED") || msg.includes("Could not load the default credentials")) {
        if (matchesUnsubscribe) {
          try { matchesUnsubscribe(); } catch {}
        }
        return;
      }
      console.warn("Instant match listener error:", err);
    });

  // Lightweight 10-second sweeper handling both timed-out attempts AND any declined searching matches
  const timeoutCheckInterval = setInterval(async () => {
    try {
      const now = new Date().toISOString();
      const [expiredAttemptsSnap, searchingMatchesSnap] = await Promise.all([
        db.collection("instant_match_attempts")
          .where("status", "in", ["pending", "notified"])
          .where("expiresAt", "<", now)
          .limit(50)
          .get(),
        db.collection("instant_matches")
          .where("status", "==", "searching")
          .limit(50)
          .get()
          .catch(() => ({ docs: [] })),
      ]);

      const matchIdsToCheck = new Set<string>();
      for (const attemptDoc of expiredAttemptsSnap.docs || []) {
        const matchId = attemptDoc.data()?.instantMatchId;
        if (matchId) matchIdsToCheck.add(String(matchId));
      }
      for (const mDoc of searchingMatchesSnap.docs || []) {
        matchIdsToCheck.add(mDoc.id);
      }

      for (const matchId of matchIdsToCheck) {
        if (processingMatches.has(matchId)) continue;
        processingMatches.add(matchId);
        try {
          const matchRef = db.collection("instant_matches").doc(matchId);
          const matchSnap = await matchRef.get();
          if (matchSnap.exists && matchSnap.data()?.status === "searching") {
            await processSearchingInstantMatch(db, matchRef, matchSnap.data() || {}, globalConfig);
          }
        } finally {
          processingMatches.delete(matchId);
        }
      }
    } catch (err: any) {
      const msg = err?.message || String(err);
      if (!msg.includes("PERMISSION_DENIED") && !msg.includes("UNAUTHENTICATED")) {
        console.error("Error in Instant Match Engine timeout interval:", err);
      }
    }
  }, 10000);

  return () => {
    configUnsubscribe();
    matchesUnsubscribe();
    clearInterval(timeoutCheckInterval);
  };
}

export async function createInstantMatchAttempt(
  db: any,
  matchRef: any,
  attemptNumber: number,
  trader: { id: string; score?: number; scheduleSignalApplied?: boolean; distanceMiles?: number | null; phone?: string | null; userData?: Record<string, any> },
  intervalSeconds: number,
  jobSummary?: {
    jobId?: string;
    jobTitle?: string;
    jobCategory?: string;
    jobPostcodeArea?: string;
    jobUrgency?: string;
    jobDescription?: string;
  }
): Promise<boolean> {
  const attemptRef = db.collection("instant_match_attempts").doc(matchRef.id + "_" + attemptNumber);
  const expiresAt = new Date(Date.now() + intervalSeconds * 1000);
  const created = await db.runTransaction(async (tx: any) => {
    const [latestMatchSnap, existingAttemptSnap] = await Promise.all([tx.get(matchRef), tx.get(attemptRef)]);
    if (!latestMatchSnap.exists || existingAttemptSnap.exists) return false;
    const latestMatch = latestMatchSnap.data() || {};
    if (latestMatch.status !== "searching" || Number(latestMatch.currentAttempt || 0) !== attemptNumber - 1) return false;
    tx.create(attemptRef, {
      id: attemptRef.id,
      instantMatchId: matchRef.id,
      attemptNumber,
      traderId: trader.id,
      jobId: jobSummary?.jobId || latestMatch.jobId || null,
      jobTitle: jobSummary?.jobTitle || null,
      jobCategory: jobSummary?.jobCategory || null,
      jobPostcodeArea: jobSummary?.jobPostcodeArea || null,
      jobUrgency: jobSummary?.jobUrgency || "emergency",
      jobDescription: jobSummary?.jobDescription || null,
      traderCompositeScore: Number.isFinite(Number(trader.score)) ? Number(trader.score) : 0,
      distanceMiles: typeof trader.distanceMiles === "number" ? trader.distanceMiles : null,
      smartScheduleFitApplied: Boolean(trader.scheduleSignalApplied),
      status: "pending",
      createdAt: new Date().toISOString(),
      expiresAt: expiresAt.toISOString()
    });
    tx.update(matchRef, { currentAttempt: attemptNumber });
    return true;
  });

  if (created) {
    const distLabel = typeof trader.distanceMiles === "number" ? ` (~${trader.distanceMiles.toFixed(1)} mi)` : "";
    const title = `Instant Match Offer: ${jobSummary?.jobCategory || "Urgent Job"}`;
    const body = `${jobSummary?.jobTitle || "An urgent customer job"} in ${jobSummary?.jobPostcodeArea || "your area"}${distLabel} needs an immediate response (${intervalSeconds}s window).`;

    try {
      const notifColl = db.collection("notifications");
      if (notifColl && typeof notifColl.doc === "function") {
        await notifColl.doc().set({
          userId: trader.id,
          type: "instant_match_offer",
          title: `⚡ ${title}`,
          message: body,
          jobId: jobSummary?.jobId || null,
          instantMatchAttemptId: attemptRef.id,
          distanceMiles: typeof trader.distanceMiles === "number" ? trader.distanceMiles : null,
          link: `/trades-dashboard?instantMatchAttempt=${attemptRef.id}`,
          actionPath: `/trades-dashboard?instantMatchAttempt=${attemptRef.id}`,
          read: false,
          isRead: false,
          createdAt: new Date().toISOString(),
        });
      }
    } catch {
      // Non-blocking notification failure
    }

    // Multi-channel push & emergency SMS so trader actually sees the 60s Instant Match offer!
    const traderInQuiet = trader.userData ? isTraderInQuietHours(trader.userData) : false;
    const emergencyOptIn = Boolean(
      trader.userData?.isAvailableForEmergency === true || trader.userData?.isAvailableForInstantMatch === true
    );

    if (registeredAlertHooks.dispatchFcmPush && (!traderInQuiet || emergencyOptIn)) {
      await registeredAlertHooks
        .dispatchFcmPush({
          recipientId: trader.id,
          title,
          body,
          channelId: "instant_match_offers",
          eventType: "instant_match_offer",
          data: {
            jobId: String(jobSummary?.jobId || ""),
            instantMatchAttemptId: attemptRef.id,
            type: "instant_match_offer",
          },
        })
        .catch(() => {});
    }

    const traderPhone = trader.phone || trader.userData?.phone || trader.userData?.phoneNumber;
    if (traderPhone && (!traderInQuiet || emergencyOptIn)) {
      try {
        const smsColl = db.collection("sms_queue");
        if (smsColl && typeof smsColl.doc === "function") {
          await smsColl.doc().set({
            to: traderPhone,
            toUserId: trader.id,
            jobId: jobSummary?.jobId || null,
            instantMatchAttemptId: attemptRef.id,
            body: `INSTANT MATCH (${intervalSeconds}s): ${jobSummary?.jobCategory || "Trade"} job in ${jobSummary?.jobPostcodeArea || "your area"}${distLabel}. Open AnyTrader now to accept!`,
            status: "pending",
            createdAt: new Date().toISOString(),
          });
        }
      } catch {
        // Non-blocking SMS enqueue failure
      }
    }
  }

  return created;
}

export async function selectNextInstantMatchCandidate(
  db: admin.firestore.Firestore | any,
  match: any,
  triedTraderIds: string[],
  config: Record<string, any> = globalConfig
): Promise<{
  id: string;
  score: number;
  scheduleSignalApplied: boolean;
  distanceMiles?: number | null;
  phone?: string | null;
  userData?: Record<string, any>;
} | null> {
  let jobCategory: string | null = null;
  let jobSubCategory: string | null = null;
  let jobText = "";
  let jobPostcode = "";
  let jobLat: number | null = null;
  let jobLng: number | null = null;
  let requiredCertifications: string[] | undefined;

  if (match?.jobId) {
    const jobSnap = await db.collection("jobs").doc(match.jobId).get();
    if (jobSnap.exists) {
      const jobData = jobSnap.data() || {};
      jobCategory = jobData.category || null;
      jobSubCategory = extractJobSubCategory(jobData) || null;
      jobPostcode = extractJobPostcode(jobData) || jobData.postcode || "";
      jobText = `${jobData.title || ""} ${jobData.description || ""}`.toLowerCase();
      const parsedLat = Number(jobData.lat ?? jobData.latitude ?? jobData.coordinates?.lat ?? jobData.location?.lat);
      const parsedLng = Number(jobData.lng ?? jobData.longitude ?? jobData.coordinates?.lng ?? jobData.location?.lng);
      if (Number.isFinite(parsedLat) && Number.isFinite(parsedLng)) {
        jobLat = parsedLat;
        jobLng = parsedLng;
      }
      if (Array.isArray(jobData.requiredCertifications)) {
        requiredCertifications = jobData.requiredCertifications;
      }
    }
  }

  // Category-indexed candidate fetch first + bounded role fallback (no unbounded full-table scans!)
  const candidateQueryPromises: Array<Promise<any>> = [];
  if (jobCategory && jobCategory.toLowerCase() !== "general" && jobCategory.toLowerCase() !== "all") {
    candidateQueryPromises.push(
      db.collection("users").where("trades", "array-contains", jobCategory).limit(250).get().catch(() => ({ docs: [] }))
    );
  }
  candidateQueryPromises.push(
    db.collection("users").where("role", "==", "tradesperson").limit(250).get().catch(() => ({ docs: [] })),
    db.collection("users").where("role", "==", "business").limit(250).get().catch(() => ({ docs: [] }))
  );

  const querySnaps = await Promise.all(candidateQueryPromises);
  const candidateMap = new Map<string, Record<string, any>>();
  for (const snap of querySnaps) {
    for (const d of snap?.docs || []) {
      if (candidateMap.has(d.id)) continue;
      const userData = typeof d.data === "function" ? d.data() : d.data;
      if (!userData) continue;
      const role = String(userData.role || "").trim().toLowerCase();
      if (role !== "tradesperson" && role !== "business") continue;
      if (role === "business" && String(userData.businessLayer || "").toLowerCase() === "properties") {
        continue;
      }
      candidateMap.set(d.id, userData);
    }
  }

  // Targeted public_profiles fetch (only for candidate IDs rather than scanning entire collection!)
  const publicProfileById = new Map<string, Record<string, any>>();
  const candidateIds = Array.from(candidateMap.keys());
  if (candidateIds.length > 0) {
    if (typeof db.getAll === "function") {
      // Batch getAll in chunks of 100 for real Firestore Admin SDK
      for (let i = 0; i < candidateIds.length; i += 100) {
        const refs = candidateIds.slice(i, i + 100).map((id) => db.collection("public_profiles").doc(id));
        const snaps = await db.getAll(...refs).catch(() => []);
        for (const pSnap of snaps) {
          if (pSnap?.exists) {
            const pData = typeof pSnap.data === "function" ? pSnap.data() : pSnap.data;
            if (pData) publicProfileById.set(pSnap.id, pData);
          }
        }
      }
    } else {
      // Fallback for mock in-memory DBs in unit tests
      const pSnaps = await Promise.all(
        candidateIds.map((id) => db.collection("public_profiles").doc(id).get().catch(() => ({ exists: false })))
      );
      for (let i = 0; i < candidateIds.length; i++) {
        const pSnap = pSnaps[i];
        if (pSnap?.exists) {
          const pData = typeof pSnap.data === "function" ? pSnap.data() : pSnap.data;
          if (pData) publicProfileById.set(candidateIds[i], pData);
        }
      }
    }
  }
  const hasPublicProfilesProjection = publicProfileById.size > 0;

  const jobContext = {
    jobCategory,
    jobSubCategory,
    jobText,
    jobPostcode,
    jobLat,
    jobLng,
    requiredCertifications,
    triedTraderIds,
  };

  const rankedCandidates: Array<{
    id: string;
    score: number;
    scheduleSignalApplied: boolean;
    distanceMiles?: number | null;
    phone?: string | null;
    userData: Record<string, any>;
  }> = [];

  for (const [id, userData] of candidateMap.entries()) {
    const publicProfile = publicProfileById.get(id) || null;
    const evaluation = evaluateInstantMatchCandidate(
      id,
      userData,
      publicProfile,
      config,
      jobContext,
      { requirePublicProjection: hasPublicProfilesProjection }
    );
    if (evaluation.eligible) {
      rankedCandidates.push({
        id,
        score: evaluation.score,
        scheduleSignalApplied: evaluation.scheduleSignalApplied,
        distanceMiles: evaluation.distanceMiles ?? null,
        phone: userData.phone || userData.phoneNumber || null,
        userData,
      });
    }
  }

  if (rankedCandidates.length === 0) return null;
  rankedCandidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const dA = a.distanceMiles ?? 9999;
    const dB = b.distanceMiles ?? 9999;
    if (dA !== dB) return dA - dB;
    return a.id.localeCompare(b.id);
  });
  return rankedCandidates[0];
}

async function initiateNextAttempt(
  db: admin.firestore.Firestore | any,
  matchRef: any,
  match: any,
  attemptNumber: number,
  config: Record<string, any> = globalConfig
): Promise<boolean> {
  const previouslyTriedSnap = await db.collection("instant_match_attempts").where("instantMatchId", "==", matchRef.id).get();
  const triedTraderIds = (previouslyTriedSnap.docs || []).map((d: any) => d.data().traderId);

  const nextTrader = await selectNextInstantMatchCandidate(db, match, triedTraderIds, config);

  if (!nextTrader) {
    await expireAndRefundInstantMatch(db, matchRef, getStripeClient(), "no_eligible_traders");
    return false;
  }

  let jobSummary: {
    jobId?: string;
    jobTitle?: string;
    jobCategory?: string;
    jobPostcodeArea?: string;
    jobUrgency?: string;
    jobDescription?: string;
  } = { jobId: match?.jobId };
  if (match?.jobId) {
    try {
      const jobSnap = await db.collection("jobs").doc(match.jobId).get();
      if (jobSnap.exists) {
        const jd = jobSnap.data() || {};
        const rawPc = String(jd.postcode || "").trim().toUpperCase();
        const outward = rawPc.includes(" ") ? rawPc.split(" ")[0] : rawPc.slice(0, 4);
        jobSummary = {
          jobId: match.jobId,
          jobTitle: String(jd.title || `Emergency ${jd.category || "Trade"} Job`).slice(0, 120),
          jobCategory: String(jd.category || "General"),
          jobPostcodeArea: outward || String(jd.city || jd.area || "Local area"),
          jobUrgency: String(jd.urgency || "emergency"),
          jobDescription: String(jd.description || "").slice(0, 280),
        };
      }
    } catch {
      // Fall back to minimal summary
    }
  }

  return await createInstantMatchAttempt(
    db,
    matchRef,
    attemptNumber,
    nextTrader,
    config.imAttemptIntervalSeconds ?? 60,
    jobSummary
  );
}
