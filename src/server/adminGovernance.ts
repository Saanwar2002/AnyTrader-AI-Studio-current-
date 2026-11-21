/**
 * Admin Governance, Dual-Control Approvals, Broadcast Fan-Out Queue,
 * Operational Health Aggregation & Versioned Feature Flags
 *
 * Covers:
 * - AT-ADMIN-AUTH-01: Explicit admin capability tiers & dual-control approvals
 * - AT-ADMIN-CTRL-04: Bounded server broadcast fan-out queue with honest receipts
 * - AT-ADMIN-CTRL-06: Unified Operational Health & Incident aggregator
 * - AT-ADMIN-CONFIG-02: Versioned platform_feature_flags control plane
 */

import * as admin from "firebase-admin";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
  UnauthorizedError,
} from "./httpErrors.ts";
import { PAYOUT_LEASE_DURATION_MS } from "./driverPayoutOrchestration.ts";

export type AdminCapabilityTier =
  | "support_readonly"
  | "financial_operator"
  | "super_admin";

const TIER_RANK: Record<AdminCapabilityTier, number> = {
  support_readonly: 1,
  financial_operator: 2,
  super_admin: 3,
};

export interface AdminActor {
  uid: string;
  email?: string;
  tier: AdminCapabilityTier;
}

export const DUAL_CONTROL_THRESHOLD_GBP = 500;
export const MAX_BROADCAST_RECIPIENTS_PER_BATCH = 500;
export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export type DualControlActionType =
  | "manual_driver_payout_batch"
  | "manual_trader_payout"
  | "high_value_escrow_override"
  | "pricing_config_publish"
  | "maintenance_mode_toggle";

const VALID_APPROVAL_ACTIONS = new Set<string>([
  "manual_driver_payout_batch",
  "manual_trader_payout",
  "high_value_escrow_override",
  "pricing_config_publish",
  "maintenance_mode_toggle",
]);

function serverTimestampOrIso(): any {
  return typeof admin?.firestore?.FieldValue?.serverTimestamp === "function"
    ? admin.firestore.FieldValue.serverTimestamp()
    : new Date().toISOString();
}

function toMillis(val: any): number {
  if (!val) return 0;
  if (typeof val === "number" && Number.isFinite(val)) return val;
  if (typeof val?.toMillis === "function") return val.toMillis();
  if (typeof val?._seconds === "number") return val._seconds * 1000;
  if (typeof val?.seconds === "number") return val.seconds * 1000;
  if (typeof val === "string") {
    const parsed = Date.parse(val);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/**
 * Resolves an authenticated admin's explicit capability tier from custom claims + user doc.
 * Supports:
 * - super_admin: full governance, config, and dual-control approval privileges
 * - financial_operator: payouts, refunds, financial reconciliation, and dual-control review
 * - support_readonly: read-only inspection of dashboards, audits, and user/job state (blocked from mutations)
 */
export function resolveAdminCapabilityTier(
  decodedToken?: Record<string, any> | null,
  userDocData?: Record<string, any> | null
): AdminCapabilityTier {
  const explicit =
    decodedToken?.adminTier ||
    decodedToken?.capabilityTier ||
    userDocData?.adminTier ||
    userDocData?.capabilityTier;

  if (
    explicit === "support_readonly" ||
    explicit === "financial_operator" ||
    explicit === "super_admin"
  ) {
    return explicit;
  }

  if (
    decodedToken?.isSuperAdmin === true ||
    userDocData?.isSuperAdmin === true ||
    userDocData?.role === "super_admin"
  ) {
    return "super_admin";
  }

  // Staff members explicitly marked read-only via permissions
  if (
    Array.isArray(userDocData?.permissions) &&
    userDocData.permissions.length > 0 &&
    !userDocData.permissions.includes("manage_team") &&
    !userDocData.permissions.includes("manage_payouts") &&
    !userDocData.permissions.includes("manage_users") &&
    !userDocData.permissions.includes("manage_jobs")
  ) {
    return "support_readonly";
  }

  if (
    Array.isArray(userDocData?.permissions) &&
    userDocData.permissions.includes("manage_payouts") &&
    !userDocData.permissions.includes("manage_team")
  ) {
    return "financial_operator";
  }

  // Verified full platform admins (e.g., bootstrap/primary admin claim) default to super_admin
  if (
    decodedToken?.admin === true ||
    decodedToken?.isAdmin === true ||
    userDocData?.role === "admin" ||
    userDocData?.isAdmin === true
  ) {
    return "super_admin";
  }

  return "support_readonly";
}

export function hasAdminCapability(
  actualTier: AdminCapabilityTier,
  requiredTier: AdminCapabilityTier
): boolean {
  return (TIER_RANK[actualTier] || 0) >= (TIER_RANK[requiredTier] || 99);
}

export function assertAdminCapability(
  actor: AdminActor | null | undefined,
  requiredTier: AdminCapabilityTier,
  actionLabel: string = "this administrative action"
): void {
  if (!actor || !actor.uid) {
    throw new UnauthorizedError("Admin authentication required.");
  }
  if (!hasAdminCapability(actor.tier, requiredTier)) {
    throw new ForbiddenError(
      `Insufficient admin capability tier '${actor.tier}' for ${actionLabel}. Minimum required tier: '${requiredTier}'.`
    );
  }
}

export interface CreateApprovalInput {
  actionType: DualControlActionType;
  reason: string;
  amountGbp?: number;
  targetResourceId?: string;
  payload?: Record<string, any>;
}

/**
 * Creates a dual-control (four-eyes) approval request for high-value or high-impact manual actions.
 */
export async function createDualControlApprovalRequest(
  db: any,
  requester: AdminActor,
  input: CreateApprovalInput
): Promise<{ requestId: string; status: "pending_second_approval"; expiresAt: string }> {
  if (!db) {
    throw new ServiceUnavailableError("Database unavailable for approval request creation.");
  }
  assertAdminCapability(requester, "financial_operator", "creating dual-control approval requests");

  if (!VALID_APPROVAL_ACTIONS.has(input.actionType)) {
    throw new BadRequestError(`Unsupported dual-control action type '${input.actionType}'.`);
  }

  const cleanReason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (cleanReason.length < 5) {
    throw new BadRequestError("A clear audit reason (minimum 5 characters) is required.");
  }

  const now = Date.now();
  const expiresAt = new Date(now + APPROVAL_TTL_MS).toISOString();
  const ref = db.collection("admin_approval_requests").doc();

  await ref.set({
    requestId: ref.id,
    actionType: input.actionType,
    status: "pending_second_approval",
    requestedByUid: requester.uid,
    requestedByEmail: requester.email || "",
    requestedByTier: requester.tier,
    reason: cleanReason,
    amountGbp: typeof input.amountGbp === "number" && Number.isFinite(input.amountGbp) ? input.amountGbp : null,
    targetResourceId: input.targetResourceId || null,
    payload: input.payload || {},
    createdAt: serverTimestampOrIso(),
    createdAtMs: now,
    expiresAt,
    expiresAtMs: now + APPROVAL_TTL_MS,
  });

  await db.collection("admin_audit_logs").add({
    action: "DUAL_CONTROL_REQUEST_CREATED",
    adminUid: requester.uid,
    adminEmail: requester.email || "",
    adminTier: requester.tier,
    targetId: ref.id,
    actionType: input.actionType,
    reason: cleanReason,
    amountGbp: input.amountGbp ?? null,
    timestamp: new Date(now).toISOString(),
  });

  return {
    requestId: ref.id,
    status: "pending_second_approval",
    expiresAt,
  };
}

/**
 * Reviews (approves or rejects) a pending dual-control request.
 * Enforces strict four-eyes separation: requester CANNOT approve their own request.
 */
export async function reviewDualControlApprovalRequest(
  db: any,
  reviewer: AdminActor,
  requestId: string,
  decision: "approved" | "rejected",
  reviewNote: string = ""
): Promise<{ requestId: string; status: "approved" | "rejected"; reviewedByUid: string }> {
  if (!db) {
    throw new ServiceUnavailableError("Database unavailable for approval review.");
  }
  assertAdminCapability(reviewer, "financial_operator", "reviewing dual-control approval requests");

  if (!requestId || typeof requestId !== "string") {
    throw new BadRequestError("Missing approval requestId.");
  }
  if (decision !== "approved" && decision !== "rejected") {
    throw new BadRequestError("Decision must be 'approved' or 'rejected'.");
  }

  const ref = db.collection("admin_approval_requests").doc(requestId.trim());
  const now = Date.now();

  await db.runTransaction(async (tx: any) => {
    const snap = await tx.get(ref);
    if (!snap || !snap.exists) {
      throw new NotFoundError(`Approval request '${requestId}' not found.`);
    }
    const data = snap.data() || {};

    if (data.status !== "pending_second_approval") {
      throw new ConflictError(`Approval request '${requestId}' is already in terminal state '${data.status}'.`);
    }

    if (data.expiresAtMs && now > Number(data.expiresAtMs)) {
      tx.set(ref, { status: "expired", expiredAt: new Date(now).toISOString() }, { merge: true });
      throw new ConflictError("Approval request has expired.");
    }

    // Strict Four-Eyes Enforcement
    if (decision === "approved" && data.requestedByUid === reviewer.uid) {
      throw new ForbiddenError(
        "Dual-control violation: the initiating admin cannot approve their own request. A second independent operator must review."
      );
    }

    tx.set(
      ref,
      {
        status: decision,
        reviewedByUid: reviewer.uid,
        reviewedByEmail: reviewer.email || "",
        reviewedByTier: reviewer.tier,
        reviewNote: String(reviewNote || "").trim().slice(0, 500),
        reviewedAt: serverTimestampOrIso(),
        reviewedAtMs: now,
      },
      { merge: true }
    );
  });

  await db.collection("admin_audit_logs").add({
    action: decision === "approved" ? "DUAL_CONTROL_APPROVED" : "DUAL_CONTROL_REJECTED",
    adminUid: reviewer.uid,
    adminEmail: reviewer.email || "",
    adminTier: reviewer.tier,
    targetId: requestId,
    reviewNote: String(reviewNote || "").trim().slice(0, 500),
    timestamp: new Date(now).toISOString(),
  });

  return { requestId, status: decision, reviewedByUid: reviewer.uid };
}

/**
 * Atomically verifies and consumes an approved dual-control request before high-value execution.
 */
export async function consumeDualControlApproval(
  db: any,
  approvalRequestId: string,
  expectedActionType: DualControlActionType,
  executor: AdminActor
): Promise<{
  approvalRequestId: string;
  requestedByUid: string;
  reviewedByUid: string;
  reason: string;
}> {
  if (!db) {
    throw new ServiceUnavailableError("Database unavailable for approval verification.");
  }
  assertAdminCapability(executor, "financial_operator", "executing a dual-control approved action");

  if (!approvalRequestId || typeof approvalRequestId !== "string" || !approvalRequestId.trim()) {
    throw new ForbiddenError(
      `Dual-control approvalRequestId is required for '${expectedActionType}'.`
    );
  }

  const ref = db.collection("admin_approval_requests").doc(approvalRequestId.trim());
  const now = Date.now();

  let approvedMeta: { requestedByUid: string; reviewedByUid: string; reason: string } | null = null;

  await db.runTransaction(async (tx: any) => {
    const snap = await tx.get(ref);
    if (!snap || !snap.exists) {
      throw new NotFoundError(`Dual-control approval '${approvalRequestId}' not found.`);
    }
    const data = snap.data() || {};

    if (data.actionType !== expectedActionType) {
      throw new ForbiddenError(
        `Approval '${approvalRequestId}' is for '${data.actionType}', not '${expectedActionType}'.`
      );
    }
    if (data.status !== "approved") {
      throw new ForbiddenError(
        `Approval '${approvalRequestId}' is not approved (current status: '${data.status}').`
      );
    }
    if (data.expiresAtMs && now > Number(data.expiresAtMs)) {
      throw new ForbiddenError("Dual-control approval has expired.");
    }
    if (!data.reviewedByUid || data.reviewedByUid === data.requestedByUid) {
      throw new ForbiddenError("Dual-control approval lacks independent second-operator sign-off.");
    }

    tx.set(
      ref,
      {
        status: "executed",
        executedByUid: executor.uid,
        executedByEmail: executor.email || "",
        executedAt: serverTimestampOrIso(),
        executedAtMs: now,
      },
      { merge: true }
    );

    approvedMeta = {
      requestedByUid: data.requestedByUid,
      reviewedByUid: data.reviewedByUid,
      reason: data.reason || "",
    };
  });

  return {
    approvalRequestId: approvalRequestId.trim(),
    ...(approvedMeta as any),
  };
}

// ============================================================================
// AT-ADMIN-CTRL-04: Bounded Server Admin Broadcast Fan-Out Queue
// ============================================================================

export interface BroadcastFanOutInput {
  title: string;
  content: string;
  type?: "announcement" | "offer" | "greeting" | "update";
  targetSegments: string[];
  targetTrades?: string[];
  channels?: {
    inApp?: boolean;
    email?: boolean;
    sms?: boolean;
  };
  maxRecipients?: number;
}

export interface BroadcastFanOutResult {
  broadcastId: string;
  status: "completed" | "partial_failure" | "queued_empty";
  totalMatched: number;
  queuedCount: number;
  sentCount: number;
  failedCount: number;
  truncated: boolean;
  channelStatuses: {
    inApp: "sent" | "partial_failure" | "skipped";
    email: "queued" | "skipped_no_provider" | "disabled";
    sms: "queued" | "skipped_no_provider" | "disabled";
  };
}

function normalizeSegmentRole(segment: string): string {
  const s = segment.trim().toLowerCase();
  if (s === "homeowners") return "homeowner";
  if (s === "tradespeople") return "tradesperson";
  if (s === "drivers") return "driver";
  if (s === "riders") return "rider";
  if (s === "landlords") return "landlord";
  return s;
}

export async function enqueueAdminBroadcastCommand(
  db: any,
  actor: AdminActor,
  input: BroadcastFanOutInput,
  env: Record<string, string | undefined> = process.env
): Promise<BroadcastFanOutResult> {
  if (!db) {
    throw new ServiceUnavailableError("Database unavailable for broadcast dispatch.");
  }
  assertAdminCapability(actor, "financial_operator", "sending platform broadcasts");

  const title = typeof input.title === "string" ? input.title.trim() : "";
  const content = typeof input.content === "string" ? input.content.trim() : "";
  const type = input.type || "announcement";
  const targetSegments = Array.isArray(input.targetSegments)
    ? input.targetSegments.map((s) => String(s).trim()).filter(Boolean)
    : [];
  const targetTrades = Array.isArray(input.targetTrades)
    ? input.targetTrades.map((t) => String(t).trim()).filter(Boolean)
    : [];

  if (!title || title.length > 200) {
    throw new BadRequestError("Broadcast title is required (max 200 characters).");
  }
  if (!content || content.length > 4000) {
    throw new BadRequestError("Broadcast content is required (max 4000 characters).");
  }
  if (targetSegments.length === 0) {
    throw new BadRequestError("At least one target audience segment is required.");
  }

  const normalizedRoles = new Set(targetSegments.map(normalizeSegmentRole));
  const cap = Math.min(
    MAX_BROADCAST_RECIPIENTS_PER_BATCH,
    Math.max(1, Number(input.maxRecipients) || MAX_BROADCAST_RECIPIENTS_PER_BATCH)
  );

  // Bounded query (cap + 1) to detect truncation without unbounded collection scans
  const usersSnap = await db.collection("users").limit(cap + 1).get();
  const allDocs = usersSnap.docs || [];
  const truncated = allDocs.length > cap;
  const boundedDocs = truncated ? allDocs.slice(0, cap) : allDocs;

  const matchedUsers = boundedDocs
    .map((d: any) => ({ id: d.id, ...(typeof d.data === "function" ? d.data() : d.data) }))
    .filter((u: any) => {
      const role = String(u.role || "").toLowerCase();
      if (!normalizedRoles.has(role) && !targetSegments.includes(u.role)) {
        return false;
      }
      if (role === "tradesperson" && targetTrades.length > 0) {
        return Array.isArray(u.trades) && u.trades.some((t: string) => targetTrades.includes(t));
      }
      return true;
    });

  const wantInApp = input.channels?.inApp !== false;
  const wantEmail = input.channels?.email === true;
  const wantSms = input.channels?.sms === true;

  const emailConfigured = Boolean(
    (env.RESEND_API_KEY && env.RESEND_API_KEY.trim().length >= 10) ||
      (env.SENDGRID_API_KEY && env.SENDGRID_API_KEY.trim().length >= 10)
  );
  const smsConfigured = Boolean(
    env.TWILIO_ACCOUNT_SID &&
      env.TWILIO_AUTH_TOKEN &&
      env.TWILIO_PHONE_NUMBER &&
      !env.TWILIO_ACCOUNT_SID.includes("placeholder")
  );

  const broadcastRef = db.collection("broadcasts").doc();
  const broadcastId = broadcastRef.id;
  const fanoutRef = db.collection("broadcast_fanout_jobs").doc(broadcastId);

  let sentCount = 0;
  let failedCount = 0;
  const queuedCount = matchedUsers.length;

  if (wantInApp && matchedUsers.length > 0) {
    for (const recipient of matchedUsers) {
      try {
        await db.collection("notifications").add({
          userId: recipient.id,
          title,
          message: content,
          type: "system",
          broadcastId,
          read: false,
          createdAt: serverTimestampOrIso(),
        });
        sentCount++;
      } catch {
        failedCount++;
      }
    }
  }

  // Queue SMS items ONLY when SMS channel requested & Twilio configured
  if (wantSms && smsConfigured) {
    for (const recipient of matchedUsers) {
      const phone = recipient.phone || recipient.phoneNumber;
      if (typeof phone === "string" && phone.trim().length >= 7) {
        await db.collection("sms_queue").add({
          to: phone.trim(),
          body: `${title}: ${content.slice(0, 300)}`,
          status: "pending",
          broadcastId,
          createdAt: serverTimestampOrIso(),
        });
      }
    }
  }

  const channelStatuses: BroadcastFanOutResult["channelStatuses"] = {
    inApp: !wantInApp
      ? "skipped"
      : failedCount > 0
      ? "partial_failure"
      : "sent",
    email: !wantEmail
      ? "disabled"
      : emailConfigured
      ? "queued"
      : "skipped_no_provider",
    sms: !wantSms
      ? "disabled"
      : smsConfigured
      ? "queued"
      : "skipped_no_provider",
  };

  const finalStatus: BroadcastFanOutResult["status"] =
    queuedCount === 0
      ? "queued_empty"
      : failedCount > 0
      ? "partial_failure"
      : "completed";

  const summaryRecord = {
    id: broadcastId,
    broadcastId,
    title,
    content,
    type,
    targetSegments,
    targetTrades,
    sentBy: actor.uid,
    initiatedByUid: actor.uid,
    initiatedByEmail: actor.email || "",
    recipientCount: sentCount,
    totalMatched: matchedUsers.length,
    queuedCount,
    sentCount,
    failedCount,
    truncated,
    maxBatchSize: cap,
    status: finalStatus,
    channelStatuses,
    createdAt: serverTimestampOrIso(),
  };

  await broadcastRef.set(summaryRecord);
  await fanoutRef.set(summaryRecord);

  await db.collection("admin_audit_logs").add({
    action: "ADMIN_BROADCAST_DISPATCHED",
    adminUid: actor.uid,
    adminEmail: actor.email || "",
    adminTier: actor.tier,
    targetId: broadcastId,
    totalMatched: matchedUsers.length,
    sentCount,
    failedCount,
    channelStatuses,
    timestamp: new Date().toISOString(),
  });

  return {
    broadcastId,
    status: finalStatus,
    totalMatched: matchedUsers.length,
    queuedCount,
    sentCount,
    failedCount,
    truncated,
    channelStatuses,
  };
}

// ============================================================================
// AT-ADMIN-CONFIG-02: Versioned Platform Feature Flags Control Plane
// ============================================================================

export interface FeatureFlagInput {
  enabled: boolean;
  description?: string;
  environments?: {
    development?: boolean;
    staging?: boolean;
    production?: boolean;
  };
  rolloutPercentage?: number;
  reason?: string;
}

export interface FeatureFlagRecord {
  flagKey: string;
  version: number;
  enabled: boolean;
  description: string;
  environments: {
    development: boolean;
    staging: boolean;
    production: boolean;
  };
  rolloutPercentage: number;
  updatedByUid: string;
  updatedByEmail: string;
  updatedAt: string;
  reason: string;
}

const FLAG_KEY_REGEX = /^[a-z0-9][a-z0-9_.-]{1,63}$/;

export async function upsertFeatureFlagCommand(
  db: any,
  actor: AdminActor,
  flagKey: string,
  input: FeatureFlagInput
): Promise<FeatureFlagRecord> {
  if (!db) {
    throw new ServiceUnavailableError("Database unavailable for feature flags.");
  }
  assertAdminCapability(actor, "super_admin", "updating platform feature flags");

  const normalizedKey = String(flagKey || "").trim().toLowerCase();
  if (!FLAG_KEY_REGEX.test(normalizedKey)) {
    throw new BadRequestError(
      "Invalid feature flag key. Use 2-64 lowercase letters, numbers, '.', '_' or '-'."
    );
  }
  if (typeof input.enabled !== "boolean") {
    throw new BadRequestError("'enabled' boolean field is required.");
  }

  const rolloutPercentage =
    input.rolloutPercentage === undefined
      ? input.enabled
        ? 100
        : 0
      : Math.max(0, Math.min(100, Math.round(Number(input.rolloutPercentage))));

  if (!Number.isFinite(rolloutPercentage)) {
    throw new BadRequestError("Invalid rolloutPercentage.");
  }

  const flagRef = db.collection("platform_feature_flags").doc(normalizedKey);
  const nowIso = new Date().toISOString();

  let savedRecord: FeatureFlagRecord | null = null;

  await db.runTransaction(async (tx: any) => {
    const snap = await tx.get(flagRef);
    const existing = snap && snap.exists ? snap.data() || {} : {};
    const nextVersion = (Number(existing.version) || 0) + 1;

    const environments = {
      development:
        input.environments?.development ??
        existing.environments?.development ??
        input.enabled,
      staging:
        input.environments?.staging ??
        existing.environments?.staging ??
        input.enabled,
      production:
        input.environments?.production ??
        existing.environments?.production ??
        input.enabled,
    };

    const record: FeatureFlagRecord = {
      flagKey: normalizedKey,
      version: nextVersion,
      enabled: input.enabled,
      description: String(input.description ?? existing.description ?? "").trim().slice(0, 400),
      environments,
      rolloutPercentage,
      updatedByUid: actor.uid,
      updatedByEmail: actor.email || "",
      updatedAt: nowIso,
      reason: String(input.reason || "Admin configuration update").trim().slice(0, 300),
    };

    tx.set(flagRef, record, { merge: true });

    const historyRef = db
      .collection("platform_feature_flags_history")
      .doc(`${normalizedKey}_v${nextVersion}`);
    tx.set(historyRef, {
      ...record,
      previousVersion: Number(existing.version) || 0,
      previousEnabled: typeof existing.enabled === "boolean" ? existing.enabled : null,
      recordedAt: serverTimestampOrIso(),
    });

    savedRecord = record;
  });

  await db.collection("admin_audit_logs").add({
    action: "FEATURE_FLAG_UPDATED",
    adminUid: actor.uid,
    adminEmail: actor.email || "",
    adminTier: actor.tier,
    targetId: normalizedKey,
    version: savedRecord!.version,
    enabled: savedRecord!.enabled,
    environments: savedRecord!.environments,
    reason: savedRecord!.reason,
    timestamp: nowIso,
  });

  return savedRecord!;
}

export async function listFeatureFlagsCommand(db: any): Promise<{
  flags: FeatureFlagRecord[];
  recentHistory: any[];
}> {
  if (!db) {
    throw new ServiceUnavailableError("Database unavailable for feature flags.");
  }

  const [flagsSnap, historySnap] = await Promise.all([
    db.collection("platform_feature_flags").limit(100).get(),
    db.collection("platform_feature_flags_history").limit(50).get(),
  ]);

  const flags = (flagsSnap.docs || []).map((d: any) => ({
    flagKey: d.id,
    ...(typeof d.data === "function" ? d.data() : d.data),
  }));

  const recentHistory = (historySnap.docs || [])
    .map((d: any) => ({
      id: d.id,
      ...(typeof d.data === "function" ? d.data() : d.data),
    }))
    .sort((a: any, b: any) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));

  return { flags, recentHistory };
}

// ============================================================================
// AT-ADMIN-CTRL-06: Unified Operational Health & Incident Aggregator
// ============================================================================

export interface OperationalIncident {
  id: string;
  severity: "warning" | "critical";
  category: "webhook" | "payout_lease" | "queue_backlog" | "kill_switch" | "cron_lock";
  title: string;
  detail: string;
}

export interface OperationalHealthSnapshot {
  generatedAt: string;
  overallSeverity: "healthy" | "degraded" | "critical";
  failedWebhooks: {
    count: number;
    items: Array<{ id: string; eventType?: string; error?: string; failedAt?: any }>;
  };
  stuckPayoutLeases: {
    count: number;
    items: Array<{ rideId: string; driverId?: string; lockedAtMs: number; ageMs: number }>;
  };
  queueBacklogs: {
    smsPending: number;
    smsUnconfigured: number;
    outreachQueued: number;
    outreachSkippedNoProvider: number;
    broadcastPartialFailures: number;
    intelligencePending: number;
    intelligenceFailed: number;
  };
  killSwitches: {
    maintenanceMode: boolean;
    paywallEnabled: boolean;
    autoDispatchEnabled: boolean;
    surgeEnabled: boolean;
  };
  activeCronLocks: Array<{
    jobName: string;
    status: string;
    instanceId?: string;
    leaseExpiresAtMs?: number;
    isStale: boolean;
  }>;
  pendingApprovalsCount: number;
  incidents: OperationalIncident[];
}

async function safeQueryDocs(queryOrCol: any): Promise<any[]> {
  try {
    const snap = await queryOrCol.get();
    return snap?.docs || [];
  } catch {
    return [];
  }
}

async function safeGetDocData(docRef: any): Promise<Record<string, any>> {
  try {
    const snap = await docRef.get();
    if (!snap || !snap.exists) return {};
    return (typeof snap.data === "function" ? snap.data() : snap.data) || {};
  } catch {
    return {};
  }
}

export async function getOperationalHealthSnapshot(
  db: any,
  nowMs: number = Date.now()
): Promise<OperationalHealthSnapshot> {
  if (!db) {
    throw new ServiceUnavailableError("Database unavailable for operational health snapshot.");
  }

  const [
    failedWebhookDocs,
    processingRideDocs,
    smsPendingDocs,
    smsUnconfiguredDocs,
    outreachQueuedDocs,
    outreachSkippedDocs,
    broadcastPartialDocs,
    intelPendingDocs,
    intelFailedDocs,
    cronLockDocs,
    pendingApprovalDocs,
    globalConfig,
    ridesConfig,
  ] = await Promise.all([
    safeQueryDocs(db.collection("stripe_webhook_events").where("status", "==", "failed").limit(50)),
    safeQueryDocs(db.collection("ride_requests").where("payoutStatus", "==", "processing").limit(50)),
    safeQueryDocs(db.collection("sms_queue").where("status", "==", "pending").limit(100)),
    safeQueryDocs(db.collection("sms_queue").where("status", "==", "failed_unconfigured").limit(100)),
    safeQueryDocs(db.collection("outreach_outbound_queue").where("status", "==", "queued").limit(100)),
    safeQueryDocs(db.collection("outreach_outbound_queue").where("status", "==", "skipped_no_provider").limit(100)),
    safeQueryDocs(db.collection("broadcast_fanout_jobs").where("status", "==", "partial_failure").limit(50)),
    safeQueryDocs(db.collection("intelligence_tasks").where("status", "==", "pending").limit(100)),
    safeQueryDocs(db.collection("intelligence_tasks").where("status", "==", "failed").limit(100)),
    safeQueryDocs(db.collection("cron_locks").limit(50)),
    safeQueryDocs(
      db.collection("admin_approval_requests").where("status", "==", "pending_second_approval").limit(50)
    ),
    safeGetDocData(db.collection("platform_config").doc("global")),
    safeGetDocData(db.collection("platform_config").doc("rides")),
  ]);

  const failedWebhooks = failedWebhookDocs.map((d: any) => {
    const data = (typeof d.data === "function" ? d.data() : d.data) || {};
    return {
      id: d.id,
      eventType: data.type || data.eventType,
      error: data.lastError || data.error,
      failedAt: data.failedAt || data.updatedAt,
    };
  });

  const stuckPayoutLeases = processingRideDocs
    .map((d: any) => {
      const data = (typeof d.data === "function" ? d.data() : d.data) || {};
      const lockedAtMs = toMillis(data.payoutLockedAt);
      const ageMs = lockedAtMs > 0 ? nowMs - lockedAtMs : PAYOUT_LEASE_DURATION_MS + 1;
      return {
        rideId: d.id,
        driverId: data.assignedDriverId || data.driverId,
        lockedAtMs,
        ageMs,
      };
    })
    .filter((item) => item.ageMs > PAYOUT_LEASE_DURATION_MS);

  const activeCronLocks = cronLockDocs.map((d: any) => {
    const data = (typeof d.data === "function" ? d.data() : d.data) || {};
    const exp = toMillis(data.leaseExpiresAtMs);
    const isStale = data.status === "active" && exp > 0 && nowMs > exp;
    return {
      jobName: data.jobName || d.id,
      status: data.status || "unknown",
      instanceId: data.instanceId,
      leaseExpiresAtMs: exp || undefined,
      isStale,
    };
  });

  const killSwitches = {
    maintenanceMode: globalConfig.maintenanceMode === true,
    paywallEnabled: globalConfig.paywallEnabled !== false,
    autoDispatchEnabled: ridesConfig.autoDispatchEnabled !== false,
    surgeEnabled: ridesConfig.surgeEnabled !== false,
  };

  const queueBacklogs = {
    smsPending: smsPendingDocs.length,
    smsUnconfigured: smsUnconfiguredDocs.length,
    outreachQueued: outreachQueuedDocs.length,
    outreachSkippedNoProvider: outreachSkippedDocs.length,
    broadcastPartialFailures: broadcastPartialDocs.length,
    intelligencePending: intelPendingDocs.length,
    intelligenceFailed: intelFailedDocs.length,
  };

  const incidents: OperationalIncident[] = [];

  if (killSwitches.maintenanceMode) {
    incidents.push({
      id: "kill_switch_maintenance",
      severity: "critical",
      category: "kill_switch",
      title: "Global Maintenance Kill-Switch Active",
      detail: "Background schedulers and mutating customer traffic are currently paused.",
    });
  }
  if (failedWebhooks.length > 0) {
    incidents.push({
      id: "failed_stripe_webhooks",
      severity: "critical",
      category: "webhook",
      title: `${failedWebhooks.length} Failed Stripe Webhook Event(s)`,
      detail: "Failed webhook events require replay or financial reconciliation review.",
    });
  }
  if (stuckPayoutLeases.length > 0) {
    incidents.push({
      id: "stuck_payout_leases",
      severity: "critical",
      category: "payout_lease",
      title: `${stuckPayoutLeases.length} Stuck Driver Payout Lease(s)`,
      detail: "Payout leases exceeded the 5-minute lease window and require reconciliation.",
    });
  }
  if (queueBacklogs.smsUnconfigured > 0) {
    incidents.push({
      id: "sms_provider_unconfigured",
      severity: "warning",
      category: "queue_backlog",
      title: `${queueBacklogs.smsUnconfigured} SMS Item(s) Blocked (Provider Unconfigured)`,
      detail: "Configure TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER to deliver SMS.",
    });
  }
  if (queueBacklogs.intelligenceFailed > 0 || queueBacklogs.broadcastPartialFailures > 0) {
    incidents.push({
      id: "queue_processing_failures",
      severity: "warning",
      category: "queue_backlog",
      title: "Background Queue Processing Failures Detected",
      detail: `Intelligence failed: ${queueBacklogs.intelligenceFailed}, Broadcast partial failures: ${queueBacklogs.broadcastPartialFailures}.`,
    });
  }
  const staleLocks = activeCronLocks.filter((l) => l.isStale);
  if (staleLocks.length > 0) {
    incidents.push({
      id: "stale_cron_locks",
      severity: "warning",
      category: "cron_lock",
      title: `${staleLocks.length} Expired Active Cron Lock(s)`,
      detail: `Jobs with stale locks: ${staleLocks.map((l) => l.jobName).join(", ")}.`,
    });
  }

  const hasCritical = incidents.some((i) => i.severity === "critical");
  const hasWarning = incidents.some((i) => i.severity === "warning");

  return {
    generatedAt: new Date(nowMs).toISOString(),
    overallSeverity: hasCritical ? "critical" : hasWarning ? "degraded" : "healthy",
    failedWebhooks: {
      count: failedWebhooks.length,
      items: failedWebhooks,
    },
    stuckPayoutLeases: {
      count: stuckPayoutLeases.length,
      items: stuckPayoutLeases,
    },
    queueBacklogs,
    killSwitches,
    activeCronLocks,
    pendingApprovalsCount: pendingApprovalDocs.length,
    incidents,
  };
}
