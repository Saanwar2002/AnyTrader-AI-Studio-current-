/**
 * Server-Authoritative Account Lifecycle & Security Freeze Orchestrator
 *
 * Implements:
 * - AT-ADMIN-CTRL-01: Synchronizes user suspension & deletion across Firebase Auth
 *   (disable / delete / revokeRefreshTokens), Firestore profile state, public discovery,
 *   and audit logs.
 * - AT-ACCOUNT-01: Atomically retracts frozen/suspended traders from /public_profiles
 *   and pauses active sponsored placements (/advertisements & /flash_deals).
 * - AT-VER-09: Triggers an automated active-job safety scan upon trader account freeze,
 *   freezing job progression, flagging affected jobs for safe reassignment, creating
 *   escalation records, and notifying affected homeowners & administrators.
 */

import { BadRequestError, ForbiddenError, NotFoundError } from "./httpErrors.ts";
import { sanitizePublicProfilePayload } from "../lib/publicProfileProjection.ts";

export function buildSanitizedPublicProfileProjection(uid: string, userData: Record<string, any>): Record<string, any> | null {
  if (!uid || !userData) return null;
  const nowIso = new Date().toISOString();
  const isVerified = Boolean(
    userData.verifiedTrader ||
    userData.isVerified ||
    userData.verified ||
    ["verified", "vetted", "auditioned"].includes(String(userData.verificationStatus || "").toLowerCase())
  );

  const rawProjection = {
    uid,
    name: userData.businessName || userData.name || userData.displayName || "Verified Tradesperson",
    businessName: userData.businessName || undefined,
    role: userData.role || "tradesperson",
    avatarUrl: userData.avatarUrl || userData.photoURL || undefined,
    bio: userData.bio || undefined,
    trades: Array.isArray(userData.trades) ? userData.trades : [],
    subcategories: Array.isArray(userData.subcategories) ? userData.subcategories : [],
    services: Array.isArray(userData.services) ? userData.services : undefined,
    skills: Array.isArray(userData.skills) ? userData.skills : undefined,
    city: userData.city || "",
    postcodeArea: userData.postcodeArea || (typeof userData.postcode === "string" ? userData.postcode.split(" ")[0] : ""),
    postcode: userData.postcodeArea || (typeof userData.postcode === "string" ? userData.postcode.split(" ")[0] : ""),
    category: userData.businessCategory || userData.primaryTrade || (Array.isArray(userData.trades) ? userData.trades[0] : "General Trades"),
    rating: typeof userData.rating === "number" ? userData.rating : 0,
    trustScore: typeof userData.trustScore === "number" ? userData.trustScore : 0,
    totalReviews: typeof userData.totalReviews === "number" ? userData.totalReviews : 0,
    verifiedTrader: isVerified,
    isVerified,
    videoVerified: Boolean(userData.videoVerified || userData.isVideoVerified),
    verificationStatus: userData.verificationStatus || (isVerified ? "verified" : "unverified"),
    tierId: userData.tierId || "Free Explorer",
    acceptingNewWork: userData.acceptingNewWork !== false,
    isAvailableForEmergency: Boolean(userData.isAvailableForEmergency),
    updatedAt: nowIso,
  };

  return sanitizePublicProfilePayload(rawProjection, { allowPrivilegedServerFields: true });
}

export interface AccountLifecycleAuthClient {
  updateUser(uid: string, properties: { disabled: boolean }): Promise<any>;
  revokeRefreshTokens(uid: string): Promise<any>;
  deleteUser?(uid: string): Promise<any>;
  getUser?(uid: string): Promise<any>;
}

export interface SuspendAccountOptions {
  db: any;
  authClient?: AccountLifecycleAuthClient | null;
  adminUid: string;
  adminEmail?: string;
  targetUid: string;
  reason?: string;
  mode?: "suspend" | "delete";
}

export interface ReinstateAccountOptions {
  db: any;
  authClient?: AccountLifecycleAuthClient | null;
  adminUid: string;
  adminEmail?: string;
  targetUid: string;
  reason?: string;
}

export interface AccountLifecycleResult {
  success: boolean;
  action: "suspend" | "delete" | "reinstate";
  targetUid: string;
  authRevoked: boolean;
  authDisabled: boolean;
  authDeleted: boolean;
  publicProfileRetracted: boolean;
  publicProfileRestored: boolean;
  pausedAdsCount: number;
  pausedDealsCount: number;
  frozenJobsCount: number;
  frozenJobIds: string[];
  notifiedHomeownersCount: number;
  safetyFlaggedJobsNeedingReview?: number;
}

const TERMINAL_JOB_STATUSES = new Set([
  "completed",
  "cancelled",
  "closed",
  "expired",
  "archived",
]);

function isAuthUserMissingError(err: any): boolean {
  const code = String(err?.code || "");
  const msg = String(err?.message || "");
  return code === "auth/user-not-found" || msg.includes("no user record corresponding");
}

async function queryAssignedJobs(db: any, targetUid: string): Promise<Array<{ id: string; data: Record<string, any> }>> {
  const fieldNames = ["acceptedTradespersonId", "acceptedTraderId", "tradespersonId", "traderId"];
  const seen = new Map<string, Record<string, any>>();

  for (const field of fieldNames) {
    try {
      const snap = await db.collection("jobs").where(field, "==", targetUid).get();
      for (const doc of snap?.docs || []) {
        const data = (typeof doc.data === "function" ? doc.data() : doc.data) || {};
        if (!seen.has(doc.id)) {
          seen.set(doc.id, data);
        }
      }
    } catch {
      // Fallback if mock/adapter throws on unused field query
    }
  }

  return Array.from(seen.entries())
    .filter(([, data]) => !TERMINAL_JOB_STATUSES.has(String(data.status || "").toLowerCase()))
    .map(([id, data]) => ({ id, data }));
}

async function queryUserAdvertisements(db: any, targetUid: string): Promise<Array<{ id: string; data: Record<string, any> }>> {
  const seen = new Map<string, Record<string, any>>();
  for (const field of ["advertiserUid", "advertiserId"]) {
    try {
      const snap = await db.collection("advertisements").where(field, "==", targetUid).get();
      for (const doc of snap?.docs || []) {
        const data = (typeof doc.data === "function" ? doc.data() : doc.data) || {};
        if (!seen.has(doc.id)) {
          seen.set(doc.id, data);
        }
      }
    } catch {
      // Continue querying alternate field
    }
  }
  return Array.from(seen.entries()).map(([id, data]) => ({ id, data }));
}

async function queryUserFlashDeals(db: any, targetUid: string): Promise<Array<{ id: string; data: Record<string, any> }>> {
  const seen = new Map<string, Record<string, any>>();
  for (const field of ["tradespersonId", "traderId", "userId"]) {
    try {
      const snap = await db.collection("flash_deals").where(field, "==", targetUid).get();
      for (const doc of snap?.docs || []) {
        const data = (typeof doc.data === "function" ? doc.data() : doc.data) || {};
        if (!seen.has(doc.id)) {
          seen.set(doc.id, data);
        }
      }
    } catch {
      // Continue if collection or index absent in unit mock
    }
  }
  return Array.from(seen.entries()).map(([id, data]) => ({ id, data }));
}

async function docExistsAndData(ref: any): Promise<{ exists: boolean; data: Record<string, any> }> {
  const snap = await ref.get();
  const exists = typeof snap?.exists === "function" ? snap.exists() : Boolean(snap?.exists);
  const data = exists ? ((typeof snap.data === "function" ? snap.data() : snap.data) || {}) : {};
  return { exists, data };
}

export async function suspendOrDeleteAccount(options: SuspendAccountOptions): Promise<AccountLifecycleResult> {
  const {
    db,
    authClient,
    adminUid,
    adminEmail,
    targetUid,
    reason = "Administrative security action",
    mode = "suspend",
  } = options;

  if (!db) {
    throw new BadRequestError("Database service unavailable");
  }
  if (!targetUid || typeof targetUid !== "string") {
    throw new BadRequestError("Target user ID is required");
  }
  if (targetUid === adminUid) {
    throw new BadRequestError("Administrators cannot suspend or delete their own active account.");
  }

  const targetUserRef = db.collection("users").doc(targetUid);
  const targetUserSnap = await docExistsAndData(targetUserRef);

  if (mode === "delete" && targetUserSnap.exists) {
    const targetRole = String(targetUserSnap.data.role || "").toLowerCase();
    if (targetRole === "admin" || targetRole === "ecosystem_manager") {
      throw new ForbiddenError("Staff administrator accounts cannot be deleted directly.");
    }
  }

  if (mode === "suspend" && !targetUserSnap.exists) {
    throw new NotFoundError(`User account '${targetUid}' was not found.`);
  }

  const nowIso = new Date().toISOString();

  // 1. Revoke Firebase Auth sessions + disable/delete auth user BEFORE or ALONGSIDE Firestore lock
  let authRevoked = false;
  let authDisabled = false;
  let authDeleted = false;

  if (authClient) {
    try {
      await authClient.updateUser(targetUid, { disabled: true });
      authDisabled = true;
    } catch (err: any) {
      if (!isAuthUserMissingError(err)) {
        throw err;
      }
    }

    try {
      await authClient.revokeRefreshTokens(targetUid);
      authRevoked = true;
    } catch (err: any) {
      if (!isAuthUserMissingError(err)) {
        throw err;
      }
    }

    if (mode === "delete" && typeof authClient.deleteUser === "function") {
      try {
        await authClient.deleteUser(targetUid);
        authDeleted = true;
      } catch (err: any) {
        if (!isAuthUserMissingError(err)) {
          throw err;
        }
      }
    }
  }

  // 2. Gather linked ads, deals, and active assigned jobs for atomic safety freeze
  const [ads, deals, activeJobs] = await Promise.all([
    queryUserAdvertisements(db, targetUid),
    queryUserFlashDeals(db, targetUid),
    queryAssignedJobs(db, targetUid),
  ]);

  const activeAds = ads.filter(({ data }) => data.isActive === true || data.status === "active");
  const activeDeals = deals.filter(({ data }) => data.status === "active" || data.isActive === true);

  let publicProfileRetracted = false;
  const frozenJobIds: string[] = [];
  const homeownerNotifications: Array<{ homeownerId: string; jobId: string; jobTitle: string }> = [];

  // 3. Execute atomic Firestore transaction for user state, public profile retraction, ads pause, & job safety freeze
  await db.runTransaction(async (tx: any) => {
    const freshUserSnap = await tx.get(targetUserRef);
    const publicProfileRef = db.collection("public_profiles").doc(targetUid);
    const freshPublicSnap = await tx.get(publicProfileRef);

    const jobReads: Array<{ id: string; jobRef: any; cardRef: any; jobSnap: any; cardSnap: any; originalData: Record<string, any> }> = [];
    for (const job of activeJobs) {
      const jobRef = db.collection("jobs").doc(job.id);
      const cardRef = db.collection("public_job_cards").doc(job.id);
      const jobSnap = await tx.get(jobRef);
      const cardSnap = await tx.get(cardRef);
      jobReads.push({ id: job.id, jobRef, cardRef, jobSnap, cardSnap, originalData: job.data });
    }

    const freshUserExists = typeof freshUserSnap?.exists === "function" ? freshUserSnap.exists() : Boolean(freshUserSnap?.exists);
    if (freshUserExists) {
      if (mode === "delete") {
        // Tombstone audit archive + delete active user doc so login/profile access stops completely
        const prevData = (typeof freshUserSnap.data === "function" ? freshUserSnap.data() : freshUserSnap.data) || {};
        const tombstoneRef = db.collection("deleted_accounts_audit").doc(targetUid);
        tx.set(tombstoneRef, {
          uid: targetUid,
          previousRole: prevData.role || prevData.accountType || "unknown",
          deletedAt: nowIso,
          deletedBy: adminUid,
          deletedByEmail: adminEmail || null,
          reason,
          authRevoked,
          authDeleted,
          frozenJobsCount: jobReads.length,
          pausedAdsCount: activeAds.length,
        });
        tx.delete(targetUserRef);
      } else {
        tx.update(targetUserRef, {
          isDisabled: true,
          isSuspended: true,
          disabled: true,
          status: "suspended",
          acceptingNewWork: false,
          suspendedAt: nowIso,
          suspendedReason: reason,
          suspendedBy: adminUid,
          tokensRevokedAt: nowIso,
          updatedAt: nowIso,
        });
      }
    }

    const freshPublicExists = typeof freshPublicSnap?.exists === "function" ? freshPublicSnap.exists() : Boolean(freshPublicSnap?.exists);
    if (freshPublicExists) {
      tx.delete(publicProfileRef);
      publicProfileRetracted = true;
    }

    // Pause active sponsored placements atomically & retract their public_ads projections
    for (const ad of activeAds) {
      tx.update(db.collection("advertisements").doc(ad.id), {
        isActive: false,
        status: "paused_by_freeze",
        pausedReason: reason,
        pausedAt: nowIso,
        pausedByUid: adminUid,
        updatedAt: nowIso,
      });
      tx.delete(db.collection("public_ads").doc(ad.id));
    }

    // Pause active flash deals atomically
    for (const deal of activeDeals) {
      tx.update(db.collection("flash_deals").doc(deal.id), {
        status: "paused",
        isActive: false,
        revokedByAdmin: true,
        revokedReason: reason,
        updatedAt: nowIso,
      });
    }

    // Freeze active job progression & flag for reassignment
    for (const item of jobReads) {
      const exists = typeof item.jobSnap?.exists === "function" ? item.jobSnap.exists() : Boolean(item.jobSnap?.exists);
      if (!exists) continue;
      const latestData = (typeof item.jobSnap.data === "function" ? item.jobSnap.data() : item.jobSnap.data) || item.originalData;
      const statusLower = String(latestData.status || "").toLowerCase();
      if (TERMINAL_JOB_STATUSES.has(statusLower)) continue;

      tx.update(item.jobRef, {
        progressionFrozen: true,
        frozenAt: nowIso,
        frozenReason: reason,
        frozenByAdminUid: adminUid,
        assignedTraderSuspended: true,
        reassignmentRequired: true,
        safetyEscalationStatus: "pending_reassignment",
        updatedAt: nowIso,
      });

      const cardExists = typeof item.cardSnap?.exists === "function" ? item.cardSnap.exists() : Boolean(item.cardSnap?.exists);
      if (cardExists) {
        tx.update(item.cardRef, {
          progressionFrozen: true,
          reassignmentRequired: true,
          updatedAt: nowIso,
        });
      }

      const escalationRef = db.collection("admin_safety_escalations").doc(`${targetUid}_${item.id}`);
      tx.set(escalationRef, {
        jobId: item.id,
        jobTitle: latestData.title || "Trade Job",
        jobStatus: statusLower,
        traderUid: targetUid,
        homeownerId: latestData.homeownerId || latestData.userId || latestData.ownerId || null,
        reason,
        actionMode: mode,
        status: "open_reassignment_required",
        createdAt: nowIso,
        createdBy: adminUid,
      });

      frozenJobIds.push(item.id);

      const homeownerId = latestData.homeownerId || latestData.userId || latestData.ownerId;
      if (homeownerId && homeownerId !== targetUid) {
        homeownerNotifications.push({
          homeownerId,
          jobId: item.id,
          jobTitle: latestData.title || "Trade Job",
        });
      }
    }
  });

  // 4. Persist homeowner & admin notifications + audit log (non-blocking if notification fails after commit)
  let notifiedHomeownersCount = 0;
  for (const item of homeownerNotifications) {
    try {
      await db.collection("notifications").add({
        userId: item.homeownerId,
        title: "Assigned Tradesperson Account Suspended — Action Required",
        message: `Safety Hold: The assigned tradesperson for "${item.jobTitle}" is currently suspended. Job progression has been paused and flagged for safe reassignment.`,
        type: "trader_suspended_safety_alert",
        jobId: item.jobId,
        link: `/job/${item.jobId}`,
        read: false,
        createdAt: nowIso,
      });
      notifiedHomeownersCount++;
    } catch {
      // Do not fail completed freeze on notification failure
    }
  }

  try {
    await db.collection("admin_audit_logs").add({
      action: mode === "delete" ? "delete_user" : "suspend_user",
      targetId: targetUid,
      targetType: "user",
      details: `${mode === "delete" ? "Deleted" : "Suspended"} user ${targetUid}. Auth revoked=${authRevoked}, publicProfileRetracted=${publicProfileRetracted}, pausedAds=${activeAds.length}, frozenJobs=${frozenJobIds.length}. Reason: ${reason}`,
      adminId: adminUid,
      adminEmail: adminEmail || null,
      metadata: {
        mode,
        authRevoked,
        authDisabled,
        authDeleted,
        publicProfileRetracted,
        pausedAdsCount: activeAds.length,
        pausedDealsCount: activeDeals.length,
        frozenJobsCount: frozenJobIds.length,
        frozenJobIds,
        notifiedHomeownersCount,
      },
      timestamp: nowIso,
    });
  } catch {
    // Non-fatal
  }

  return {
    success: true,
    action: mode,
    targetUid,
    authRevoked,
    authDisabled,
    authDeleted,
    publicProfileRetracted,
    publicProfileRestored: false,
    pausedAdsCount: activeAds.length,
    pausedDealsCount: activeDeals.length,
    frozenJobsCount: frozenJobIds.length,
    frozenJobIds,
    notifiedHomeownersCount,
  };
}

export async function reinstateSuspendedAccount(options: ReinstateAccountOptions): Promise<AccountLifecycleResult> {
  const { db, authClient, adminUid, adminEmail, targetUid, reason = "Administrative reinstatement" } = options;

  if (!db) {
    throw new BadRequestError("Database service unavailable");
  }
  if (!targetUid || typeof targetUid !== "string") {
    throw new BadRequestError("Target user ID is required");
  }

  const userRef = db.collection("users").doc(targetUid);
  const userSnap = await docExistsAndData(userRef);
  if (!userSnap.exists) {
    throw new NotFoundError(`User account '${targetUid}' was not found.`);
  }
  const userData = userSnap.data;
  if (String(userData.status || "").toLowerCase() === "deleted") {
    throw new ForbiddenError("Deleted user accounts cannot be reinstated.");
  }

  let authReenabled = false;
  if (authClient) {
    try {
      await authClient.updateUser(targetUid, { disabled: false });
      authReenabled = true;
    } catch (err: any) {
      if (!isAuthUserMissingError(err)) {
        throw err;
      }
    }
  }

  const nowIso = new Date().toISOString();
  let publicProfileRestored = false;

  await db.runTransaction(async (tx: any) => {
    const freshSnap = await tx.get(userRef);
    const freshExists = typeof freshSnap?.exists === "function" ? freshSnap.exists() : Boolean(freshSnap?.exists);
    if (!freshExists) {
      throw new NotFoundError(`User account '${targetUid}' was not found.`);
    }
    const freshData = (typeof freshSnap.data === "function" ? freshSnap.data() : freshSnap.data) || {};

    tx.update(userRef, {
      isDisabled: false,
      isSuspended: false,
      disabled: false,
      status: "active",
      reinstatedAt: nowIso,
      reinstatedBy: adminUid,
      reinstateReason: reason,
      updatedAt: nowIso,
    });

    const isTrader =
      freshData.role === "tradesperson" ||
      freshData.role === "trader" ||
      freshData.accountType === "service_provider";
    const isVerifiedTrader =
      freshData.isVerified === true ||
      freshData.verified === true ||
      freshData.verifiedTrader === true ||
      ["verified", "vetted", "auditioned"].includes(String(freshData.verificationStatus || "").toLowerCase());

    if (isTrader && isVerifiedTrader) {
      const projection = buildSanitizedPublicProfileProjection(targetUid, {
        ...freshData,
        isDisabled: false,
        isSuspended: false,
        status: "active",
      });
      if (projection) {
        tx.set(db.collection("public_profiles").doc(targetUid), projection, { merge: true });
        publicProfileRestored = true;
      }
    }
  });

  const activeJobs = await queryAssignedJobs(db, targetUid);
  const safetyFlaggedJobsNeedingReview = activeJobs.filter((j) => j.data.progressionFrozen === true).length;

  try {
    await db.collection("admin_audit_logs").add({
      action: "reinstate_user",
      targetId: targetUid,
      targetType: "user",
      details: `Reinstated user ${targetUid}. authReenabled=${authReenabled}, publicProfileRestored=${publicProfileRestored}, safetyFlaggedJobsNeedingReview=${safetyFlaggedJobsNeedingReview}. Reason: ${reason}`,
      adminId: adminUid,
      adminEmail: adminEmail || null,
      timestamp: nowIso,
    });
  } catch {
    // Non-fatal
  }

  return {
    success: true,
    action: "reinstate",
    targetUid,
    authRevoked: false,
    authDisabled: false,
    authDeleted: false,
    publicProfileRetracted: false,
    publicProfileRestored,
    pausedAdsCount: 0,
    pausedDealsCount: 0,
    frozenJobsCount: 0,
    frozenJobIds: [],
    notifiedHomeownersCount: 0,
    safetyFlaggedJobsNeedingReview,
  };
}

export interface VerifyTraderAccountOptions {
  db: any;
  adminUid: string;
  adminEmail?: string;
  targetUid: string;
  verificationStatus: "verified" | "rejected" | "vetted" | "auditioned" | "revoked";
  reason?: string;
}

/**
 * AT-ACCOUNT-03:
 * Atomically updates trader verification status on /users/{uid} AND synchronizes /public_profiles/{uid}
 * (upgrading verified badges on approval, or revoking verified flags/retracting unverified badge on rejection/revocation)
 * together with an immutable admin audit log entry.
 */
export async function verifyTraderAccountWithProjection(options: VerifyTraderAccountOptions): Promise<{
  success: true;
  targetUid: string;
  verificationStatus: string;
  isVerified: boolean;
  publicProfileSynced: boolean;
  publicProfileRetracted: boolean;
}> {
  const { db, adminUid, adminEmail, targetUid, verificationStatus, reason } = options;
  if (!db) throw new BadRequestError("Database service unavailable");
  if (!adminUid) throw new ForbiddenError("Admin authentication required");
  if (!targetUid) throw new BadRequestError("Target user ID is required");

  const allowedStatuses = new Set(["verified", "rejected", "vetted", "auditioned", "revoked"]);
  if (!allowedStatuses.has(verificationStatus)) {
    throw new BadRequestError(`Unsupported verification status '${verificationStatus}'.`);
  }

  const userRef = db.collection("users").doc(targetUid);
  const publicRef = db.collection("public_profiles").doc(targetUid);
  const nowIso = new Date().toISOString();
  const isApproved = verificationStatus === "verified" || verificationStatus === "vetted" || verificationStatus === "auditioned";

  let publicProfileSynced = false;
  let publicProfileRetracted = false;

  await db.runTransaction(async (tx: any) => {
    const [userSnap, publicSnap] = await Promise.all([tx.get(userRef), tx.get(publicRef)]);
    const userExists = typeof userSnap?.exists === "function" ? userSnap.exists() : Boolean(userSnap?.exists);
    if (!userExists) {
      throw new NotFoundError(`User account '${targetUid}' was not found.`);
    }
    const userData = (typeof userSnap.data === "function" ? userSnap.data() : userSnap.data) || {};

    const userUpdate: Record<string, any> = {
      verificationStatus,
      isVerified: isApproved,
      verifiedTrader: isApproved,
      verified: isApproved,
      verifiedByAdminUid: adminUid,
      verifiedAt: isApproved ? nowIso : null,
      verificationRevokedAt: !isApproved ? nowIso : null,
      updatedAt: nowIso,
    };
    tx.update(userRef, userUpdate);

    const isDisabledAccount = userData.isSuspended === true || userData.isDisabled === true || userData.disabled === true;
    const publicExists = typeof publicSnap?.exists === "function" ? publicSnap.exists() : Boolean(publicSnap?.exists);

    if (isApproved && !isDisabledAccount) {
      const projection = buildSanitizedPublicProfileProjection(targetUid, {
        ...userData,
        ...userUpdate,
      });
      if (projection) {
        tx.set(publicRef, projection, { merge: true });
        publicProfileSynced = true;
      }
    } else if (publicExists) {
      if (verificationStatus === "revoked" || isDisabledAccount) {
        tx.delete(publicRef);
        publicProfileRetracted = true;
      } else {
        tx.set(
          publicRef,
          {
            verificationStatus,
            isVerified: false,
            verifiedTrader: false,
            verified: false,
            updatedAt: nowIso,
          },
          { merge: true }
        );
        publicProfileSynced = true;
      }
    }
  });

  try {
    await db.collection("admin_audit_logs").add({
      action: isApproved ? "verify_trader" : "revoke_trader_verification",
      targetId: targetUid,
      targetType: "user",
      details: `Updated verificationStatus to '${verificationStatus}' (isVerified=${isApproved}, publicProfileSynced=${publicProfileSynced}, publicProfileRetracted=${publicProfileRetracted}).${reason ? ` Reason: ${reason}` : ""}`,
      adminId: adminUid,
      adminEmail: adminEmail || null,
      timestamp: nowIso,
    });
  } catch {
    // Non-fatal
  }

  return {
    success: true,
    targetUid,
    verificationStatus,
    isVerified: isApproved,
    publicProfileSynced,
    publicProfileRetracted,
  };
}

export interface ReviewTraderVerificationDocumentOptions {
  db: any;
  adminUid: string;
  adminEmail?: string;
  targetUid: string;
  docType: string;
  decision: "approved" | "rejected";
  reason?: string;
}

/**
 * Atomically reviews a single verification document for a trader, updates account-level
 * verificationStatus / isVerified / verifiedTrader, synchronizes /public_profiles/{uid},
 * notifies the trader, and writes an immutable admin audit log.
 */
export async function reviewTraderVerificationDocument(options: ReviewTraderVerificationDocumentOptions): Promise<{
  success: true;
  targetUid: string;
  docType: string;
  decision: "approved" | "rejected";
  verificationStatus: string;
  isVerified: boolean;
  allApproved: boolean;
  publicProfileSynced: boolean;
  verificationDocs: Record<string, any>[];
}> {
  const { db, adminUid, adminEmail, targetUid, docType, decision, reason } = options;
  if (!db) throw new BadRequestError("Database service unavailable");
  if (!adminUid) throw new ForbiddenError("Admin authentication required");
  if (!targetUid) throw new BadRequestError("Target user ID is required");
  const cleanDocType = String(docType || "").trim();
  if (!cleanDocType) throw new BadRequestError("Document type is required");
  if (decision !== "approved" && decision !== "rejected") {
    throw new BadRequestError("Decision must be 'approved' or 'rejected'.");
  }
  const cleanReason = typeof reason === "string" ? reason.trim().slice(0, 300) : "";
  if (decision === "rejected" && !cleanReason) {
    throw new BadRequestError("A rejection reason is required when rejecting a document.");
  }

  const userRef = db.collection("users").doc(targetUid);
  const publicRef = db.collection("public_profiles").doc(targetUid);
  const nowIso = new Date().toISOString();

  let finalVerificationStatus = "pending";
  let finalIsVerified = false;
  let allApproved = false;
  let publicProfileSynced = false;
  let updatedDocs: Record<string, any>[] = [];
  let traderName = "Tradesperson";

  await db.runTransaction(async (tx: any) => {
    const [userSnap, publicSnap] = await Promise.all([tx.get(userRef), tx.get(publicRef)]);
    const userExists = typeof userSnap?.exists === "function" ? userSnap.exists() : Boolean(userSnap?.exists);
    if (!userExists) {
      throw new NotFoundError(`User account '${targetUid}' was not found.`);
    }
    const userData = (typeof userSnap.data === "function" ? userSnap.data() : userSnap.data) || {};
    traderName = String(userData.name || userData.displayName || "Tradesperson");
    const existingDocs: Record<string, any>[] = Array.isArray(userData.verificationDocs) ? userData.verificationDocs : [];
    const matched = existingDocs.some((d) => String(d?.type || "") === cleanDocType);
    if (!matched) {
      throw new NotFoundError(`Verification document '${cleanDocType}' not found for user '${targetUid}'.`);
    }

    updatedDocs = existingDocs.map((d) => {
      if (String(d?.type || "") !== cleanDocType) return d;
      const nextDoc: Record<string, any> = {
        ...d,
        status: decision,
        reviewedAt: nowIso,
        reviewedBy: adminUid,
      };
      if (decision === "rejected") {
        nextDoc.rejectionReason = cleanReason;
      } else {
        delete nextDoc.rejectionReason;
      }
      return nextDoc;
    });

    allApproved = updatedDocs.length > 0 && updatedDocs.every((d) => d.status === "approved");
    const hasRejected = updatedDocs.some((d) => d.status === "rejected");
    const prevStatus = String(userData.verificationStatus || "").toLowerCase();
    const wasHigherTierApproved = prevStatus === "vetted" || prevStatus === "auditioned";

    if (decision === "rejected" || hasRejected) {
      finalVerificationStatus = "rejected";
      finalIsVerified = false;
    } else if (allApproved) {
      finalVerificationStatus = wasHigherTierApproved ? prevStatus : "verified";
      finalIsVerified = true;
    } else {
      finalVerificationStatus = "pending";
      finalIsVerified = false;
    }

    const userUpdate: Record<string, any> = {
      verificationDocs: updatedDocs,
      verificationStatus: finalVerificationStatus,
      isVerified: finalIsVerified,
      verifiedTrader: finalIsVerified,
      verified: finalIsVerified,
      updatedAt: nowIso,
    };
    if (finalIsVerified) {
      userUpdate.verifiedByAdminUid = adminUid;
      userUpdate.verifiedAt = userData.verifiedAt || nowIso;
      userUpdate.verificationRevokedAt = null;
    } else if (decision === "rejected") {
      userUpdate.verificationRevokedAt = nowIso;
    }

    tx.update(userRef, userUpdate);

    const isDisabledAccount = userData.isSuspended === true || userData.isDisabled === true || userData.disabled === true;
    const publicExists = typeof publicSnap?.exists === "function" ? publicSnap.exists() : Boolean(publicSnap?.exists);

    if (finalIsVerified && !isDisabledAccount) {
      const projection = buildSanitizedPublicProfileProjection(targetUid, {
        ...userData,
        ...userUpdate,
      });
      if (projection) {
        tx.set(publicRef, projection, { merge: true });
        publicProfileSynced = true;
      }
    } else if (publicExists) {
      tx.set(
        publicRef,
        {
          verificationStatus: finalVerificationStatus,
          isVerified: false,
          verifiedTrader: false,
          verified: false,
          updatedAt: nowIso,
        },
        { merge: true }
      );
      publicProfileSynced = true;
    }
  });

  // Notify trader of document decision (non-blocking after atomic commit)
  try {
    const title =
      decision === "approved"
        ? allApproved
          ? "Account Verified!"
          : `Document Approved: ${cleanDocType}`
        : `Verification Document Rejected: ${cleanDocType}`;
    const message =
      decision === "approved"
        ? allApproved
          ? `Your ${cleanDocType} certificate has been approved and your tradesperson account is now fully verified on AnyTrader.`
          : `Your ${cleanDocType} certificate was approved. Your remaining submitted documents are still under review.`
        : `Your ${cleanDocType} certificate could not be approved (${cleanReason}). Please upload an updated document from your Profile.`;

    await db.collection("notifications").add({
      userId: targetUid,
      title,
      message,
      type: "verification_update",
      link: "/profile",
      read: false,
      createdAt: nowIso,
    });
  } catch {
    // Non-fatal
  }

  try {
    await db.collection("admin_audit_logs").add({
      action: decision === "approved" ? "approve_document" : "reject_document",
      targetId: targetUid,
      targetType: "user",
      details: `${decision === "approved" ? "Approved" : "Rejected"} ${cleanDocType} for ${traderName}. Account status=${finalVerificationStatus} (isVerified=${finalIsVerified}, publicProfileSynced=${publicProfileSynced}).${cleanReason ? ` Reason: ${cleanReason}` : ""}`,
      adminId: adminUid,
      adminEmail: adminEmail || null,
      timestamp: nowIso,
    });
  } catch {
    // Non-fatal
  }

  return {
    success: true,
    targetUid,
    docType: cleanDocType,
    decision,
    verificationStatus: finalVerificationStatus,
    isVerified: finalIsVerified,
    allApproved,
    publicProfileSynced,
    verificationDocs: updatedDocs,
  };
}

