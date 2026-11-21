import admin from 'firebase-admin';
import Stripe from 'stripe';
import { randomUUID } from 'crypto';
import { evaluateInstantMatchCandidate } from './src/server/instantMatchEligibility.ts';

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
  imRequireVerified: false,
  imRequireCategoryMatch: false,
  imRequireTagMatch: false
};

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
        // A non-terminal Stripe refund response remains processing; cool down before
        // retrying the same idempotency key rather than polling Stripe on every trigger.
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
export function startInstantMatchEngine(db: admin.firestore.Firestore) {
  if (!db) return;
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

  const processingMatches = new Set<string>();

  // Real-time listener for searching matches instead of polling
  let matchesUnsubscribe: (() => void) | null = null;
  matchesUnsubscribe = db.collection("instant_matches")
    .where("status", "==", "searching")
    .onSnapshot(async (matchesSnap) => {
      try {
        const now = new Date();
        for (const matchDoc of matchesSnap.docs) {
          if (processingMatches.has(matchDoc.id)) continue;
          processingMatches.add(matchDoc.id);

          try {
            const match = matchDoc.data();
            
            // Find latest attempt array
            const attemptsSnap = await db.collection("instant_match_attempts")
              .where("instantMatchId", "==", matchDoc.id)
              .orderBy("attemptNumber", "desc")
              .limit(1)
              .get();

            const latestAttempt = attemptsSnap.docs[0]?.data();
            const latestAttemptRef = attemptsSnap.docs[0]?.ref;

            if (!latestAttempt) {
              // No attempts yet, find top traders and create the first attempt
              await initiateNextAttempt(db, matchDoc.ref, match, 1);
            } else {
              // Check if attempt timed out
              const expiresAt = new Date(latestAttempt.expiresAt);
              if (['pending', 'notified'].includes(latestAttempt.status) && expiresAt < now) {
                // Expired!
                await latestAttemptRef.update({
                  status: "timeout",
                  respondedAt: now.toISOString()
                });

                // Initiate next attempt
                const nextAttemptNum = latestAttempt.attemptNumber + 1;
                const maxAttempts = globalConfig.imMaxAttempts ?? 10;
                if (nextAttemptNum > maxAttempts) {
                  // Expire the match entirely if we tried max times
                  await expireAndRefundInstantMatch(db, matchDoc.ref, getStripeClient(), "attempts_exhausted");
                } else {
                  await initiateNextAttempt(db, matchDoc.ref, match, nextAttemptNum);
                }
              }
            }
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

  // We still need a very lightweight interval to check for timeouts on existing active attempts,
  // since timeouts are based on time progressing, not firestore writes. 
  // We can query attempts that are pending/notified and where expiresAt < now.
  const timeoutCheckInterval = setInterval(async () => {
     try {
       const now = new Date().toISOString();
       const expiredAttemptsSnap = await db.collection("instant_match_attempts")
          .where("status", "in", ["pending", "notified"])
          .where("expiresAt", "<", now)
          .get();

       for (const attemptDoc of expiredAttemptsSnap.docs) {
          const attempt = attemptDoc.data();
          const matchDoc = await db.collection("instant_matches").doc(attempt.instantMatchId).get();
          if (!matchDoc.exists || matchDoc.data()?.status !== "searching") continue;

          await attemptDoc.ref.update({
             status: "timeout",
             respondedAt: new Date().toISOString()
          });

          const nextAttemptNum = attempt.attemptNumber + 1;
          const maxAttempts = globalConfig.imMaxAttempts ?? 10;
          if (nextAttemptNum > maxAttempts) {
             await expireAndRefundInstantMatch(db, matchDoc.ref, getStripeClient(), "attempts_exhausted");
          } else {
             await initiateNextAttempt(db, matchDoc.ref, matchDoc.data(), nextAttemptNum);
          }
       }
     } catch (err: any) {
        const msg = err?.message || String(err);
        if (!msg.includes("PERMISSION_DENIED") && !msg.includes("UNAUTHENTICATED")) {
          console.error("Error in Instant Match Engine timeout interval:", err);
        }
     }
  }, 10000); // Check timeouts every 10 seconds (efficient query)

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
  trader: { id: string; score?: number; scheduleSignalApplied?: boolean },
  intervalSeconds: number
): Promise<boolean> {
  const attemptRef = db.collection("instant_match_attempts").doc(matchRef.id + "_" + attemptNumber);
  const expiresAt = new Date(Date.now() + intervalSeconds * 1000);
  return db.runTransaction(async (tx: any) => {
    const [latestMatchSnap, existingAttemptSnap] = await Promise.all([tx.get(matchRef), tx.get(attemptRef)]);
    if (!latestMatchSnap.exists || existingAttemptSnap.exists) return false;
    const latestMatch = latestMatchSnap.data() || {};
    if (latestMatch.status !== "searching" || Number(latestMatch.currentAttempt || 0) !== attemptNumber - 1) return false;
    tx.create(attemptRef, {
      id: attemptRef.id, instantMatchId: matchRef.id, attemptNumber, traderId: trader.id,
      traderCompositeScore: Number.isFinite(Number(trader.score)) ? Number(trader.score) : 0,
      smartScheduleFitApplied: Boolean(trader.scheduleSignalApplied),
      status: "pending", createdAt: new Date().toISOString(), expiresAt: expiresAt.toISOString()
    });
    tx.update(matchRef, { currentAttempt: attemptNumber });
    return true;
  });
}

export async function selectNextInstantMatchCandidate(
  db: admin.firestore.Firestore | any,
  match: any,
  triedTraderIds: string[],
  config: Record<string, any> = globalConfig
): Promise<{ id: string; score: number; scheduleSignalApplied: boolean } | null> {
  let jobCategory: string | null = null;
  let jobText = "";
  let jobPostcode = "";
  if (match?.jobId) {
    const jobSnap = await db.collection("jobs").doc(match.jobId).get();
    if (jobSnap.exists) {
      const jobData = jobSnap.data();
      jobCategory = jobData?.category || null;
      jobPostcode = jobData?.postcode || "";
      jobText = `${jobData?.title || ""} ${jobData?.description || ""}`.toLowerCase();
    }
  }

  const [allTradersSnap, publicProfilesSnap] = await Promise.all([
    db.collection("users").where("role", "==", "tradesperson").get(),
    db.collection("public_profiles").get().catch(() => ({ docs: [] })),
  ]);

  const publicProfileById = new Map<string, Record<string, any>>();
  for (const pDoc of publicProfilesSnap?.docs || []) {
    const pData = typeof pDoc.data === "function" ? pDoc.data() : pDoc.data;
    if (pData) publicProfileById.set(pDoc.id, pData);
  }
  const hasPublicProfilesProjection = publicProfileById.size > 0;

  const jobContext = { jobCategory, jobText, jobPostcode, triedTraderIds };
  const rankedCandidates: Array<{ id: string; score: number; scheduleSignalApplied: boolean }> = [];

  for (const d of allTradersSnap.docs || []) {
    const userData = typeof d.data === "function" ? d.data() : d.data;
    const publicProfile = publicProfileById.get(d.id) || null;
    const evaluation = evaluateInstantMatchCandidate(
      d.id,
      userData,
      publicProfile,
      config,
      jobContext,
      { requirePublicProjection: hasPublicProfilesProjection }
    );
    if (evaluation.eligible) {
      rankedCandidates.push({
        id: d.id,
        score: evaluation.score,
        scheduleSignalApplied: evaluation.scheduleSignalApplied,
      });
    }
  }

  if (rankedCandidates.length === 0) return null;
  rankedCandidates.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return rankedCandidates[0];
}

async function initiateNextAttempt(db: admin.firestore.Firestore, matchRef: admin.firestore.DocumentReference, match: any, attemptNumber: number) {
  const previouslyTriedSnap = await db.collection("instant_match_attempts").where("instantMatchId", "==", matchRef.id).get();
  const triedTraderIds = previouslyTriedSnap.docs.map(d => d.data().traderId);

  const nextTrader = await selectNextInstantMatchCandidate(db, match, triedTraderIds, globalConfig);

  if (!nextTrader) {
    await expireAndRefundInstantMatch(db, matchRef, getStripeClient(), "no_eligible_traders");
    return;
  }

  await createInstantMatchAttempt(db, matchRef, attemptNumber, nextTrader, globalConfig.imAttemptIntervalSeconds ?? 60);
}
