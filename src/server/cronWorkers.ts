/**
 * Server Cron Workers, SMS Delivery Gate, Consultancy Schedulers & Postcode Timeout Helper
 *
 * Covers:
 * - AT-ADMIN-OPS-03: Real Twilio/SMS config gate (failed_unconfigured / skipped_no_provider, never fake sent)
 * - AT-ADMIN-OPS-05: Real worker execution counts & error reporting for cron dispatcher
 * - AT-CONS-SCHED-01: Real consultancy recurring session & score recalculation workers with visible error propagation
 * - AT-POSTCODE-01: Single AbortController timeout covering fetch + response.json() body consumption
 */

import * as admin from "firebase-admin";

export interface CronWorkerRunSummary {
  worker: string;
  status: "executed" | "skipped" | "failed" | "partial";
  executedCount: number;
  skippedCount: number;
  failedCount: number;
  errors: string[];
  reason?: string;
  details?: Record<string, any>;
}

function serverTimestampOrIso(): any {
  return typeof admin?.firestore?.FieldValue?.serverTimestamp === "function"
    ? admin.firestore.FieldValue.serverTimestamp()
    : new Date().toISOString();
}

function isPlaceholderSecret(value?: string): boolean {
  if (!value || typeof value !== "string") return true;
  const trimmed = value.trim().toLowerCase();
  return (
    trimmed.length < 4 ||
    trimmed.includes("placeholder") ||
    trimmed.includes("changeme") ||
    trimmed.includes("your_") ||
    trimmed === "test"
  );
}

export function isTwilioSmsConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return (
    !isPlaceholderSecret(env.TWILIO_ACCOUNT_SID) &&
    !isPlaceholderSecret(env.TWILIO_AUTH_TOKEN) &&
    !isPlaceholderSecret(env.TWILIO_PHONE_NUMBER)
  );
}

export interface ProcessSmsQueueOptions {
  db: any;
  env?: Record<string, string | undefined>;
  twilioFactory?: (sid: string, token: string) => {
    messages: { create: (payload: { body: string; from: string; to: string }) => Promise<{ sid: string; status?: string }> };
  };
  maintenanceActive?: boolean;
}

/**
 * AT-ADMIN-OPS-03:
 * Processes pending `sms_queue` documents under a strict Twilio config gate.
 * When Twilio credentials are unconfigured, documents are marked honestly as
 * `status: "failed_unconfigured"` and `providerStatus: "skipped_no_provider"`
 * — NEVER marked as fake `sent`.
 */
export async function processSmsQueueCommand(
  options: ProcessSmsQueueOptions
): Promise<CronWorkerRunSummary> {
  const { db, env = process.env, twilioFactory, maintenanceActive = false } = options;

  if (!db) {
    return {
      worker: "sms_queue",
      status: "skipped",
      executedCount: 0,
      skippedCount: 1,
      failedCount: 0,
      errors: [],
      reason: "database_unavailable",
    };
  }

  if (maintenanceActive) {
    return {
      worker: "sms_queue",
      status: "skipped",
      executedCount: 0,
      skippedCount: 1,
      failedCount: 0,
      errors: [],
      reason: "maintenance_mode_active",
    };
  }

  const configured = isTwilioSmsConfigured(env);
  const twilioClient =
    configured && twilioFactory
      ? twilioFactory(env.TWILIO_ACCOUNT_SID!.trim(), env.TWILIO_AUTH_TOKEN!.trim())
      : null;

  let executedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  const errors: string[] = [];

  try {
    const queueSnap = await db.collection("sms_queue").where("status", "==", "pending").limit(50).get();
    const docs = queueSnap?.docs || [];
    if (docs.length === 0) {
      return {
        worker: "sms_queue",
        status: "executed",
        executedCount: 0,
        skippedCount: 0,
        failedCount: 0,
        errors: [],
        details: { twilioConfigured: configured },
      };
    }

    for (const docSnap of docs) {
      const data = (typeof docSnap.data === "function" ? docSnap.data() : docSnap.data) || {};
      if (!data.to || !data.body) {
        await docSnap.ref.update({
          status: "failed",
          error: "Missing to or body",
          processedAt: serverTimestampOrIso(),
        });
        failedCount++;
        errors.push(`sms:${docSnap.id}: missing to or body`);
        continue;
      }

      if (!configured || !twilioClient) {
        await docSnap.ref.update({
          status: "failed_unconfigured",
          providerStatus: "skipped_no_provider",
          error:
            "Twilio SMS provider is not configured (requires TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER).",
          processedAt: serverTimestampOrIso(),
        });
        skippedCount++;
        continue;
      }

      try {
        const msg = await twilioClient.messages.create({
          body: String(data.body),
          from: env.TWILIO_PHONE_NUMBER!.trim(),
          to: String(data.to).trim(),
        });
        await docSnap.ref.update({
          status: "sent",
          providerStatus: msg?.status || "queued",
          sentAt: serverTimestampOrIso(),
          twilioSid: msg?.sid || "",
        });
        executedCount++;
      } catch (err: any) {
        const errMsg = err?.message || String(err);
        await docSnap.ref.update({
          status: "failed",
          providerStatus: "provider_error",
          error: errMsg,
          failedAt: serverTimestampOrIso(),
        });
        failedCount++;
        errors.push(`sms:${docSnap.id}: ${errMsg}`);
      }
    }

    const status: CronWorkerRunSummary["status"] =
      failedCount > 0 && executedCount === 0
        ? "failed"
        : failedCount > 0
        ? "partial"
        : executedCount === 0 && skippedCount > 0
        ? "skipped"
        : "executed";

    return {
      worker: "sms_queue",
      status,
      executedCount,
      skippedCount,
      failedCount,
      errors,
      reason: !configured && skippedCount > 0 ? "skipped_no_provider" : undefined,
      details: { twilioConfigured: configured },
    };
  } catch (err: any) {
    const errMsg = err?.message || String(err);
    return {
      worker: "sms_queue",
      status: "failed",
      executedCount,
      skippedCount,
      failedCount: failedCount + 1,
      errors: [...errors, errMsg],
      reason: "sms_queue_worker_error",
    };
  }
}

/**
 * AT-CONS-SCHED-01:
 * Real Consultancy Recurring Session Creator worker.
 * Materializes upcoming recurring session occurrences idempotently and propagates errors visibly.
 */
export async function runConsultancyRecurringSessionCreatorCommand(
  db: any,
  options: { maintenanceActive?: boolean; nowMs?: number } = {}
): Promise<CronWorkerRunSummary> {
  const { maintenanceActive = false, nowMs = Date.now() } = options;

  if (!db) {
    return {
      worker: "recurring_sessions",
      status: "skipped",
      executedCount: 0,
      skippedCount: 1,
      failedCount: 0,
      errors: [],
      reason: "database_unavailable",
    };
  }
  if (maintenanceActive) {
    return {
      worker: "recurring_sessions",
      status: "skipped",
      executedCount: 0,
      skippedCount: 1,
      failedCount: 0,
      errors: [],
      reason: "maintenance_mode_active",
    };
  }

  let executedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  const errors: string[] = [];

  try {
    const snap = await db
      .collection("calendarEvents")
      .where("isRecurring", "==", true)
      .limit(200)
      .get();

    const docs = snap?.docs || [];
    const horizonMs = nowMs + 7 * 24 * 60 * 60 * 1000;

    for (const docSnap of docs) {
      const ev = (typeof docSnap.data === "function" ? docSnap.data() : docSnap.data) || {};
      if (ev.status === "cancelled" || ev.recurrenceActive === false) {
        skippedCount++;
        continue;
      }

      const intervalDays =
        ev.recurrenceIntervalDays && Number(ev.recurrenceIntervalDays) > 0
          ? Number(ev.recurrenceIntervalDays)
          : ev.recurrenceFrequency === "monthly"
          ? 30
          : 7;

      const baseMs =
        Date.parse(ev.nextOccurrenceAt || ev.startTime || ev.date || "") || 0;
      if (!baseMs || baseMs > horizonMs) {
        skippedCount++;
        continue;
      }

      try {
        const occurrenceMs = baseMs < nowMs ? baseMs + intervalDays * 86_400_000 : baseMs;
        const occurrenceIso = new Date(occurrenceMs).toISOString();
        const dateKey = occurrenceIso.slice(0, 10);
        const childId = `rec_${docSnap.id}_${dateKey}`;
        const childRef = db.collection("calendarEvents").doc(childId);
        const existingChild = await childRef.get();

        if (existingChild?.exists) {
          skippedCount++;
          continue;
        }

        const nextFollowingIso = new Date(occurrenceMs + intervalDays * 86_400_000).toISOString();
        await childRef.set({
          parentEventId: docSnap.id,
          consultantId: ev.consultantId || ev.traderId || ev.userId || null,
          clientId: ev.clientId || null,
          title: ev.title || "Recurring Consultancy Session",
          startTime: occurrenceIso,
          durationMinutes: Number(ev.durationMinutes) || 60,
          isRecurring: false,
          generatedFromRecurrence: true,
          status: "scheduled",
          createdAt: serverTimestampOrIso(),
        });

        await docSnap.ref.set(
          {
            lastGeneratedAt: new Date(nowMs).toISOString(),
            nextOccurrenceAt: nextFollowingIso,
          },
          { merge: true }
        );

        executedCount++;
      } catch (itemErr: any) {
        failedCount++;
        errors.push(`recurring_event:${docSnap.id}: ${itemErr?.message || String(itemErr)}`);
      }
    }

    const status: CronWorkerRunSummary["status"] =
      failedCount > 0 && executedCount === 0
        ? "failed"
        : failedCount > 0
        ? "partial"
        : "executed";

    return {
      worker: "recurring_sessions",
      status,
      executedCount,
      skippedCount,
      failedCount,
      errors,
      details: { inspectedEvents: docs.length },
    };
  } catch (err: any) {
    return {
      worker: "recurring_sessions",
      status: "failed",
      executedCount,
      skippedCount,
      failedCount: failedCount + 1,
      errors: [...errors, err?.message || String(err)],
      reason: "recurring_sessions_worker_error",
    };
  }
}

/**
 * AT-CONS-SCHED-01:
 * Real Consultancy Match Score Recalculator worker.
 * Computes deterministic weighted scores from consultant ratings, reviews, and verification status,
 * persists updates to Firestore, and propagates any per-record or query errors visibly.
 */
export async function runConsultancyScoreRecalculatorCommand(
  db: any,
  options: { maintenanceActive?: boolean; nowMs?: number } = {}
): Promise<CronWorkerRunSummary> {
  const { maintenanceActive = false, nowMs = Date.now() } = options;

  if (!db) {
    return {
      worker: "match_scores",
      status: "skipped",
      executedCount: 0,
      skippedCount: 1,
      failedCount: 0,
      errors: [],
      reason: "database_unavailable",
    };
  }
  if (maintenanceActive) {
    return {
      worker: "match_scores",
      status: "skipped",
      executedCount: 0,
      skippedCount: 1,
      failedCount: 0,
      errors: [],
      reason: "maintenance_mode_active",
    };
  }

  let executedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  const errors: string[] = [];

  try {
    const snap = await db.collection("users").where("role", "==", "consultant").limit(200).get();
    const docs = snap?.docs || [];

    for (const docSnap of docs) {
      const u = (typeof docSnap.data === "function" ? docSnap.data() : docSnap.data) || {};
      if (u.suspended === true || u.status === "suspended") {
        skippedCount++;
        continue;
      }

      try {
        const rating = Math.max(0, Math.min(5, Number(u.rating) || 0));
        const reviewCount = Math.max(0, Number(u.reviewCount || u.completedSessions) || 0);
        const verifiedBonus = u.idVerified === true || u.verified === true ? 20 : 0;
        const responseRate = Math.max(0, Math.min(100, Number(u.responseRate) || 75));

        // Deterministic weighted score out of 100
        const computedScore = Math.min(
          100,
          Math.round(
            (rating / 5) * 45 +
              Math.min(20, reviewCount * 2) +
              verifiedBonus +
              (responseRate / 100) * 15
          )
        );

        await docSnap.ref.set(
          {
            consultancyMatchScore: computedScore,
            consultancyScoreUpdatedAt: new Date(nowMs).toISOString(),
          },
          { merge: true }
        );
        executedCount++;
      } catch (itemErr: any) {
        failedCount++;
        errors.push(`consultant:${docSnap.id}: ${itemErr?.message || String(itemErr)}`);
      }
    }

    const status: CronWorkerRunSummary["status"] =
      failedCount > 0 && executedCount === 0
        ? "failed"
        : failedCount > 0
        ? "partial"
        : "executed";

    return {
      worker: "match_scores",
      status,
      executedCount,
      skippedCount,
      failedCount,
      errors,
      details: { inspectedConsultants: docs.length },
    };
  } catch (err: any) {
    return {
      worker: "match_scores",
      status: "failed",
      executedCount,
      skippedCount,
      failedCount: failedCount + 1,
      errors: [...errors, err?.message || String(err)],
      reason: "match_scores_worker_error",
    };
  }
}

/**
 * AT-ADMIN-OPS-05:
 * Formats a cron endpoint HTTP response honestly from lease + worker execution summaries.
 * Skipped or failed workers NEVER produce `{ success: true, executed: true }`.
 */
export function buildCronDispatchResponse(
  jobName: string,
  leaseOutcome: {
    acquired: boolean;
    fencedOut: boolean;
    reason?: string;
    result?: CronWorkerRunSummary | any;
  }
): { httpStatus: number; body: Record<string, any> } {
  const timestamp = new Date().toISOString();

  if (!leaseOutcome.acquired) {
    return {
      httpStatus: 200,
      body: {
        success: false,
        executed: false,
        job: jobName,
        status: "skipped",
        executedCount: 0,
        skippedCount: 1,
        failedCount: 0,
        errors: [],
        reason: leaseOutcome.reason || "lock_not_acquired",
        timestamp,
      },
    };
  }

  const workerResult = leaseOutcome.result;
  if (workerResult && typeof workerResult === "object" && "status" in workerResult && "executedCount" in workerResult) {
    const summary = workerResult as CronWorkerRunSummary;
    const isFailed = summary.status === "failed";
    const isSkipped = summary.status === "skipped";
    const isPartial = summary.status === "partial";

    return {
      httpStatus: isFailed ? 500 : isPartial ? 207 : 200,
      body: {
        success: !isFailed && !isSkipped,
        executed: !isFailed && !isSkipped,
        job: jobName,
        status: summary.status,
        fencedOut: leaseOutcome.fencedOut,
        executedCount: summary.executedCount,
        skippedCount: summary.skippedCount,
        failedCount: summary.failedCount,
        errors: summary.errors || [],
        reason: summary.reason,
        details: summary.details,
        timestamp,
      },
    };
  }

  // Handle legacy worker return shapes (e.g. payout orchestration returning { success, processedCount, skippedCount, failedCount, error })
  if (workerResult && typeof workerResult === "object" && "success" in workerResult) {
    const failed = workerResult.success === false;
    const paused = workerResult.pausedByMaintenance === true;
    const failedCount = Number(workerResult.failedCount) || (failed ? 1 : 0);
    const executedCount = Number(workerResult.processedCount ?? workerResult.processed ?? workerResult.reconciled ?? 0);
    const skippedCount = Number(workerResult.skippedCount ?? (paused ? 1 : 0));
    const errors = workerResult.error ? [String(workerResult.error)] : [];

    return {
      httpStatus: failed && !paused ? 500 : failedCount > 0 && executedCount > 0 ? 207 : 200,
      body: {
        success: !failed && !paused,
        executed: !failed && !paused,
        job: jobName,
        status: paused ? "skipped" : failed ? "failed" : failedCount > 0 ? "partial" : "executed",
        fencedOut: leaseOutcome.fencedOut,
        executedCount,
        skippedCount,
        failedCount,
        errors,
        details: workerResult,
        timestamp,
      },
    };
  }

  return {
    httpStatus: 200,
    body: {
      success: !leaseOutcome.fencedOut,
      executed: true,
      job: jobName,
      status: leaseOutcome.fencedOut ? "partial" : "executed",
      fencedOut: leaseOutcome.fencedOut,
      executedCount: 1,
      skippedCount: 0,
      failedCount: 0,
      errors: [],
      details: workerResult,
      timestamp,
    },
  };
}

/**
 * AT-POSTCODE-01:
 * Fetches a UK postcode from postcodes.io under a SINGLE AbortController timeout
 * covering BOTH the network fetch AND `response.json()` body stream consumption.
 */
export async function fetchPostcodeWithTimeout(
  formattedPostcode: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = 5000
): Promise<{ status: number; ok: boolean; data: any }> {
  const encoded = encodeURIComponent(formattedPostcode);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(`https://api.postcodes.io/postcodes/${encoded}`, {
      signal: controller.signal,
    });

    // Race body consumption against abort signal so a stalled stream respects the single timeout
    const data = await new Promise<any>((resolve, reject) => {
      if (controller.signal.aborted) {
        const abortErr = new Error("The operation was aborted");
        abortErr.name = "AbortError";
        return reject(abortErr);
      }
      const onAbort = () => {
        const abortErr = new Error("The operation was aborted");
        abortErr.name = "AbortError";
        reject(abortErr);
      };
      controller.signal.addEventListener("abort", onAbort, { once: true });
      Promise.resolve(response.json())
        .then((parsed) => {
          controller.signal.removeEventListener("abort", onAbort);
          resolve(parsed);
        })
        .catch((err) => {
          controller.signal.removeEventListener("abort", onAbort);
          reject(err);
        });
    });

    return {
      status: response.status,
      ok: response.ok,
      data,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

function parseTimestampMs(raw: unknown): number {
  if (!raw) return 0;
  if (typeof (raw as any)?.toMillis === "function") return Number((raw as any).toMillis()) || 0;
  if (typeof (raw as any)?.toDate === "function") return (raw as any).toDate().getTime() || 0;
  if (typeof (raw as any)?.seconds === "number") return (raw as any).seconds * 1000;
  const parsed = Date.parse(String(raw));
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Slice 4: Publishes mature 14-day cooling-off reviews whose publishAt <= now,
 * recalculating both users/{revieweeId} and public_profiles/{revieweeId} aggregates atomically.
 */
export async function publishMatureCoolingOffReviewsCommand(
  db: any,
  options: { maintenanceActive?: boolean; nowMs?: number; limit?: number } = {}
): Promise<CronWorkerRunSummary> {
  const { maintenanceActive = false, nowMs = Date.now(), limit = 100 } = options;

  if (!db) {
    return {
      worker: "cooling_off_reviews",
      status: "skipped",
      executedCount: 0,
      skippedCount: 1,
      failedCount: 0,
      errors: [],
      reason: "database_unavailable",
    };
  }
  if (maintenanceActive) {
    return {
      worker: "cooling_off_reviews",
      status: "skipped",
      executedCount: 0,
      skippedCount: 1,
      failedCount: 0,
      errors: [],
      reason: "maintenance_mode_active",
    };
  }

  let executedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  const errors: string[] = [];
  const nowIso = new Date(nowMs).toISOString();

  try {
    const snap = await db
      .collection("reviews")
      .where("status", "==", "cooling_off")
      .limit(limit)
      .get();
    const docs = Array.isArray(snap?.docs) ? snap.docs : [];

    for (const reviewDoc of docs) {
      const review = (typeof reviewDoc.data === "function" ? reviewDoc.data() : reviewDoc.data) || {};
      const publishAtMs = parseTimestampMs(review.publishAt);
      if (review.isHidden === true || !publishAtMs || publishAtMs > nowMs) {
        skippedCount++;
        continue;
      }

      const revieweeId = String(review.revieweeId || review.targetId || review.tradespersonId || "").trim();
      const reviewType = review.type === "homeowner_review" ? "homeowner_review" : "tradesperson_review";
      const numRating = Number(review.rating);

      try {
        await db.runTransaction(async (tx: any) => {
          const rRef = db.collection("reviews").doc(reviewDoc.id);
          const uRef = revieweeId ? db.collection("users").doc(revieweeId) : null;
          const pRef = revieweeId ? db.collection("public_profiles").doc(revieweeId) : null;

          const [freshReviewSnap, userSnap, pubSnap] = await Promise.all([
            tx.get(rRef),
            uRef ? tx.get(uRef) : Promise.resolve(null),
            pRef ? tx.get(pRef) : Promise.resolve(null),
          ]);

          if (!freshReviewSnap?.exists) return;
          const freshReview =
            (typeof freshReviewSnap.data === "function" ? freshReviewSnap.data() : freshReviewSnap.data) || {};
          if (freshReview.status !== "cooling_off" || freshReview.isHidden === true) {
            return;
          }

          tx.update(rRef, {
            status: "published",
            publishedAt: nowIso,
            updatedAt: nowIso,
          });

          if (revieweeId && Number.isFinite(numRating) && numRating >= 1 && numRating <= 5) {
            const userExists = userSnap ? (typeof userSnap.exists === "function" ? userSnap.exists() : Boolean(userSnap.exists)) : false;
            const pubExists = pubSnap ? (typeof pubSnap.exists === "function" ? pubSnap.exists() : Boolean(pubSnap.exists)) : false;
            const userData = userExists
              ? (typeof userSnap.data === "function" ? userSnap.data() : userSnap.data) || {}
              : {};

            if (reviewType === "tradesperson_review") {
              const currRating = Number(userData.rating) || 0;
              const currTotal = Number(userData.totalReviews) || 0;
              const currRecs = Number(userData.totalRecommendations) || 0;
              const nextTotal = currTotal + 1;
              const nextRating = Number((((currRating * currTotal) + numRating) / nextTotal).toFixed(2));
              const nextRecs = freshReview.recommended === true ? currRecs + 1 : currRecs;
              const patch = {
                rating: nextRating,
                totalReviews: nextTotal,
                totalRecommendations: nextRecs,
                updatedAt: nowIso,
              };
              if (userExists && uRef) tx.update(uRef, patch);
              if (pubExists && pRef) tx.update(pRef, patch);
            } else {
              const currRating = Number(userData.homeownerRating) || 0;
              const currTotal = Number(userData.totalHomeownerReviews) || 0;
              const nextTotal = currTotal + 1;
              const nextRating = Number((((currRating * currTotal) + numRating) / nextTotal).toFixed(2));
              const patch = {
                homeownerRating: nextRating,
                totalHomeownerReviews: nextTotal,
                updatedAt: nowIso,
              };
              if (userExists && uRef) tx.update(uRef, patch);
              if (pubExists && pRef) tx.update(pRef, patch);
            }

            tx.set(
              db.collection("notifications").doc(`review_pub_${reviewDoc.id}_${revieweeId}`),
              {
                userId: revieweeId,
                title: "Review Published",
                message: `A ${numRating}-star review from a completed job has finished its 14-day review window and is now published.`,
                type: "system",
                read: false,
                jobId: freshReview.jobId || null,
                link: freshReview.jobId ? `/job/${freshReview.jobId}` : "/profile",
                createdAt: nowIso,
              },
              { merge: true }
            );
          }
        });
        executedCount++;
      } catch (itemErr: any) {
        failedCount++;
        errors.push(`review:${reviewDoc.id}: ${itemErr?.message || String(itemErr)}`);
      }
    }

    const status: CronWorkerRunSummary["status"] =
      failedCount > 0 && executedCount === 0
        ? "failed"
        : failedCount > 0
          ? "partial"
          : "executed";

    return {
      worker: "cooling_off_reviews",
      status,
      executedCount,
      skippedCount,
      failedCount,
      errors,
      details: { inspectedReviews: docs.length },
    };
  } catch (err: any) {
    return {
      worker: "cooling_off_reviews",
      status: "failed",
      executedCount,
      skippedCount,
      failedCount: failedCount + 1,
      errors: [...errors, err?.message || String(err)],
      reason: "cooling_off_reviews_worker_error",
    };
  }
}

