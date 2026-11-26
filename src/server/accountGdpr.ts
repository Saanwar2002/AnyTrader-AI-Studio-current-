/**
 * Server-Authoritative UK GDPR Data Portability & Self-Service Account Deletion
 *
 * Implements:
 * - UK GDPR Art. 15 & Art. 20: Structured self-service personal data export strictly scoped to caller UID.
 * - UK GDPR Art. 17: Verified self-service account erasure with active escrow/job integrity protection,
 *   public_profiles retraction, ad/deal pausing, Firebase Auth token revocation, and statutory
 *   HMRC financial/anti-abuse retention notice (Art. 17(3)(b)/(e)).
 */

import { BadRequestError, ConflictError, NotFoundError } from "./httpErrors.ts";
import type { AccountLifecycleAuthClient } from "./accountLifecycle.ts";

export const BLOCKING_ACCOUNT_DELETION_JOB_STATUSES = [
  "accepted",
  "in_progress",
  "funded",
  "disputed",
  "pending_release",
  "work_completed",
] as const;

const INTERNAL_SECURITY_FIELDS = new Set([
  "passwordHash",
  "ipAddress",
  "lastIp",
  "registrationIp",
  "accountFlags",
  "fraudScore",
  "internalAdminNotes",
  "stripeAccountSecret",
  "fcmTokens",
  "deviceTokens",
]);

export function sanitizeUserRecordForGdprExport(data: Record<string, any>): Record<string, any> {
  const sanitized: Record<string, any> = {};
  for (const [key, value] of Object.entries(data || {})) {
    if (INTERNAL_SECURITY_FIELDS.has(key)) continue;
    sanitized[key] = value;
  }
  return sanitized;
}

async function safeQueryDocs(queryFn: () => Promise<any>): Promise<Array<Record<string, any>>> {
  try {
    const snap = await queryFn();
    if (!snap || !Array.isArray(snap.docs)) return [];
    return snap.docs.map((d: any) => ({ id: d.id, ...(typeof d.data === "function" ? d.data() : {}) }));
  } catch (err) {
    console.warn("[accountGdpr] Non-blocking sub-query skipped:", err instanceof Error ? err.message : String(err));
    return [];
  }
}

export interface ExportUserDataOptions {
  db: any;
  uid: string;
}

export interface ExportUserDataResult {
  exportedAt: string;
  subjectUid: string;
  legalBasis: string;
  profile: Record<string, any>;
  jobsPosted: Array<Record<string, any>>;
  jobsAssigned: Array<Record<string, any>>;
  quotesSubmitted: Array<Record<string, any>>;
  properties: Array<Record<string, any>>;
  notifications: Array<Record<string, any>>;
  reviewsAuthored: Array<Record<string, any>>;
}

export async function executeExportUserDataCommand(
  options: ExportUserDataOptions
): Promise<ExportUserDataResult> {
  const { db, uid } = options;
  if (!db) throw new BadRequestError("Database service unavailable.");
  if (!uid || typeof uid !== "string") throw new BadRequestError("Authenticated user ID is required.");

  const userRef = db.collection("users").doc(uid);
  const userSnap = await userRef.get();
  if (!userSnap.exists) {
    throw new NotFoundError("Account profile not found.");
  }

  const exportedAt = new Date().toISOString();
  const profile = sanitizeUserRecordForGdprExport(userSnap.data() || {});

  const [
    jobsPosted,
    jobsAssignedByAccepted,
    jobsAssignedByTrader,
    quotesSubmitted,
    properties,
    notifications,
    reviewsAuthored,
  ] = await Promise.all([
    safeQueryDocs(() => db.collection("jobs").where("homeownerId", "==", uid).get()),
    safeQueryDocs(() => db.collection("jobs").where("acceptedTradespersonId", "==", uid).get()),
    safeQueryDocs(() => db.collection("jobs").where("assignedTradespersonId", "==", uid).get()),
    safeQueryDocs(() =>
      typeof db.collectionGroup === "function"
        ? db.collectionGroup("quotes").where("tradespersonId", "==", uid).get()
        : Promise.resolve({ docs: [] })
    ),
    safeQueryDocs(() => db.collection("properties").where("ownerId", "==", uid).get()),
    safeQueryDocs(() => db.collection("notifications").where("userId", "==", uid).limit(200).get()),
    safeQueryDocs(() => db.collection("reviews").where("reviewerId", "==", uid).get()),
  ]);

  // Deduplicate assigned jobs by id
  const assignedMap = new Map<string, Record<string, any>>();
  for (const job of [...jobsAssignedByAccepted, ...jobsAssignedByTrader]) {
    assignedMap.set(job.id, job);
  }
  const jobsAssigned = Array.from(assignedMap.values());

  // Log GDPR Art. 15/20 export request for compliance audit trail
  try {
    await db.collection("gdpr_requests").add({
      uid,
      type: "data_export",
      legalBasis: "UK_GDPR_ART_15_20",
      status: "completed",
      requestedAt: exportedAt,
      completedAt: exportedAt,
      counts: {
        jobsPosted: jobsPosted.length,
        jobsAssigned: jobsAssigned.length,
        quotesSubmitted: quotesSubmitted.length,
        properties: properties.length,
        notifications: notifications.length,
        reviewsAuthored: reviewsAuthored.length,
      },
    });
  } catch (auditErr) {
    console.warn("[accountGdpr] Failed to log GDPR export audit record:", auditErr);
  }

  return {
    exportedAt,
    subjectUid: uid,
    legalBasis: "UK GDPR Art. 15 & Art. 20 (Right of Access & Data Portability)",
    profile,
    jobsPosted,
    jobsAssigned,
    quotesSubmitted,
    properties,
    notifications,
    reviewsAuthored,
  };
}

export interface SelfServiceDeleteAccountOptions {
  db: any;
  authClient?: AccountLifecycleAuthClient | null;
  uid: string;
  email?: string;
  confirmationText?: string;
  reason?: string;
}

export interface SelfServiceDeleteAccountResult {
  success: boolean;
  uid: string;
  status: "deleted_by_user";
  deletedAt: string;
  publicProfileRetracted: boolean;
  authRevoked: boolean;
  authDisabled: boolean;
  pausedAdsCount: number;
  pausedDealsCount: number;
  statutoryRetentionNote: string;
}

export async function executeSelfServiceAccountDeletionCommand(
  options: SelfServiceDeleteAccountOptions
): Promise<SelfServiceDeleteAccountResult> {
  const { db, authClient, uid, email, confirmationText, reason } = options;

  if (!db) throw new BadRequestError("Database service unavailable.");
  if (!uid || typeof uid !== "string") throw new BadRequestError("Authenticated user ID is required.");

  if (String(confirmationText || "").trim().toUpperCase() !== "DELETE") {
    throw new BadRequestError('Please type "DELETE" to confirm permanent account deletion.');
  }

  const userRef = db.collection("users").doc(uid);
  const userSnap = await userRef.get();
  if (!userSnap.exists) {
    throw new NotFoundError("Account profile not found.");
  }

  const userData = userSnap.data() || {};
  const nowIso = new Date().toISOString();
  const statutoryRetentionNote =
    "Personal profile details have been erased and public discovery retracted. Statutory UK tax/invoice ledger records and non-PII anti-fraud fingerprints are retained strictly as permitted under UK GDPR Art. 17(3)(b)/(e).";

  if (userData.accountStatus === "deleted_by_user") {
    return {
      success: true,
      uid,
      status: "deleted_by_user",
      deletedAt: userData.deletedAt || nowIso,
      publicProfileRetracted: true,
      authRevoked: true,
      authDisabled: true,
      pausedAdsCount: 0,
      pausedDealsCount: 0,
      statutoryRetentionNote,
    };
  }

  // Guard: Prevent deletion while active, funded, or disputed jobs/escrow remain open
  const [homeownerJobs, acceptedTraderJobs, assignedTraderJobs] = await Promise.all([
    safeQueryDocs(() => db.collection("jobs").where("homeownerId", "==", uid).get()),
    safeQueryDocs(() => db.collection("jobs").where("acceptedTradespersonId", "==", uid).get()),
    safeQueryDocs(() => db.collection("jobs").where("assignedTradespersonId", "==", uid).get()),
  ]);

  const uniqueJobs = new Map<string, Record<string, any>>();
  for (const job of [...homeownerJobs, ...acceptedTraderJobs, ...assignedTraderJobs]) {
    uniqueJobs.set(job.id, job);
  }

  const blockingStatuses = new Set<string>(BLOCKING_ACCOUNT_DELETION_JOB_STATUSES);
  const activeBlockingJobs = Array.from(uniqueJobs.values()).filter((job) =>
    blockingStatuses.has(String(job.status || "").toLowerCase())
  );

  if (activeBlockingJobs.length > 0) {
    throw new ConflictError(
      `Your account cannot be deleted while you have ${activeBlockingJobs.length} active, funded, or disputed job${activeBlockingJobs.length === 1 ? "" : "s"} in progress. Please complete, cancel, or resolve them first.`
    );
  }

  const sanitizedReason = typeof reason === "string" ? reason.trim().slice(0, 500) : "User self-service GDPR erasure request";

  // 1. Anonymize PII on users/{uid} while preserving immutable document ID for statutory financial references
  await userRef.set(
    {
      name: "Deleted User",
      displayName: "Deleted User",
      businessName: "",
      email: "",
      phone: "",
      phoneNumber: "",
      bio: "",
      postcode: "",
      postcodeArea: "",
      city: "",
      county: "",
      avatarUrl: "",
      photoURL: "",
      emergencyContacts: [],
      accountStatus: "deleted_by_user",
      isDisabled: true,
      acceptingNewWork: false,
      isAvailableForEmergency: false,
      isAvailableForInstantMatch: false,
      deletedAt: nowIso,
      deletedBy: uid,
      deletionReason: sanitizedReason,
      gdprErasureCompletedAt: nowIso,
      updatedAt: nowIso,
    },
    { merge: true }
  );

  // 2. Retract public_profiles/{uid}
  let publicProfileRetracted = false;
  try {
    await db.collection("public_profiles").doc(uid).delete();
    publicProfileRetracted = true;
  } catch (err) {
    console.warn("[accountGdpr] Public profile delete skipped:", err);
  }

  // 3. Pause any active sponsored advertisements and flash deals owned by this user
  let pausedAdsCount = 0;
  let pausedDealsCount = 0;
  const userAds = await safeQueryDocs(() => db.collection("advertisements").where("traderId", "==", uid).get());
  for (const ad of userAds) {
    try {
      await db.collection("advertisements").doc(ad.id).set(
        { active: false, status: "paused_account_deleted", updatedAt: nowIso },
        { merge: true }
      );
      pausedAdsCount += 1;
    } catch {
      // non-blocking
    }
  }

  const userDeals = await safeQueryDocs(() => db.collection("flash_deals").where("traderId", "==", uid).get());
  for (const deal of userDeals) {
    try {
      await db.collection("flash_deals").doc(deal.id).set(
        { active: false, status: "paused_account_deleted", updatedAt: nowIso },
        { merge: true }
      );
      pausedDealsCount += 1;
    } catch {
      // non-blocking
    }
  }

  // 4. Revoke Firebase Auth sessions & disable/delete Auth account (best-effort)
  let authRevoked = false;
  let authDisabled = false;
  if (authClient) {
    try {
      await authClient.revokeRefreshTokens(uid);
      authRevoked = true;
    } catch (err) {
      console.warn("[accountGdpr] revokeRefreshTokens skipped:", err);
    }
    try {
      await authClient.updateUser(uid, { disabled: true });
      authDisabled = true;
    } catch (err) {
      console.warn("[accountGdpr] updateUser(disabled) skipped:", err);
    }
  }

  // 5. Write compliance audit records (no raw PII stored)
  try {
    await db.collection("gdpr_requests").add({
      uid,
      type: "account_erasure",
      legalBasis: "UK_GDPR_ART_17",
      status: "completed",
      reason: sanitizedReason,
      requestedAt: nowIso,
      completedAt: nowIso,
      publicProfileRetracted,
      authRevoked,
      authDisabled,
      pausedAdsCount,
      pausedDealsCount,
    });
  } catch (err) {
    console.warn("[accountGdpr] Failed to write gdpr_requests audit:", err);
  }

  try {
    await db.collection("admin_audit_logs").add({
      action: "USER_SELF_SERVICE_GDPR_DELETION",
      actorUid: uid,
      actorEmail: email ? "[redacted_on_erasure]" : "",
      targetUid: uid,
      reason: sanitizedReason,
      timestamp: nowIso,
    });
  } catch (err) {
    console.warn("[accountGdpr] Failed to write admin_audit_logs:", err);
  }

  return {
    success: true,
    uid,
    status: "deleted_by_user",
    deletedAt: nowIso,
    publicProfileRetracted,
    authRevoked,
    authDisabled,
    pausedAdsCount,
    pausedDealsCount,
    statutoryRetentionNote,
  };
}
