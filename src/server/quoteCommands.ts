/**
 * Server-Authoritative Canonical Quote Commands for AnyTrader V2 (Task 3)
 *
 * Implements strict input validation, mass-assignment defense, authoritative
 * identity binding, multi-role object-level authorization, server-computed
 * financial fields (amount, commission, net payout, milestones), formal state
 * machine lifecycle validation, persistent transactional idempotency, atomic
 * parent job quote count maintenance, and domain event dispatch across:
 * 1. CreateQuote
 * 2. UpdateQuote
 * 3. WithdrawQuote
 * 4. RejectQuote
 * 5. RequestRequote
 * 6. RespondToRequote
 */

import { z } from "zod";
import crypto from "crypto";
import type admin from "firebase-admin";
import { BadRequestError, ForbiddenError, NotFoundError, ConflictError } from "./httpErrors.ts";
import { CanonicalIdentity, hasCapability } from "./identity.ts";
import { SERVER_OWNED_PROTECTED_KEYS } from "./authorization.ts";
import { validateQuoteTransition, validateJobTransition, QuoteStatus, JobStatus } from "./stateMachine.ts";
import { domainEvents } from "./domainEvents.ts";
import { getDynamicFirestoreConfigs, resolveAnyTraderCommission } from "./pricingCatalog.ts";
import {
  DEFAULT_DOCUMENT_GRACE_PERIOD_DAYS,
  DEFAULT_PROVISIONAL_MAX_QUOTES,
  evaluateTraderDocumentCompliance,
} from "../lib/traderCompliance.ts";
import { normalizeQuoteScope } from "../lib/marketplaceContracts.ts";
import { dispatchAuthoritativeFcmPush } from "./notificationEngine.ts";
import { enqueueWhatsAppFallback } from "./whatsappNotificationEngine.ts";

const INHERITED_SERVER_OWNED_KEYS = new Set(SERVER_OWNED_PROTECTED_KEYS);
INHERITED_SERVER_OWNED_KEYS.delete("amount");

/**
 * Server-owned & privileged fields that clients are strictly forbidden from supplying
 * in any quote command payload. Attempts to supply any of these keys trigger an immediate
 * BadRequestError (OWASP API Mass Assignment Defense).
 */
export const QUOTE_MUTATION_PROTECTED_KEYS = new Set([
  ...INHERITED_SERVER_OWNED_KEYS,
  "id",
  "tradespersonId",
  "traderId",
  "proId",
  "homeownerId",
  "userId",
  "commission",
  "platformFee",
  "netPayout",
  "stripeFee",
  "appliedCommissionRate",
  "commissionCapGbp",
  "paymentRail",
  "status",
  "revisionCount",
  "createdAt",
  "updatedAt",
  "acceptedAt",
  "rejectedAt",
  "withdrawnAt",
  "payoutTransferred",
  "payoutStatus",
  "paymentStatus",
  "funded",
  "transferred",
  "quoteCount",
  "quotesCount",
  "role",
  "isAdmin",
  "isVerified",
  "verified",
  "verifiedBadges",
  "exclusiveSlotsUsedToday",
  "exclusiveCooldownUntil",
  "lastExclusiveQuoteDate",
]);

/**
 * Milestone schema for structured quotes.
 */
export const QUOTE_MILESTONE_SCHEMA = z.object({
  id: z.string().optional(),
  title: z.string().min(1, "Milestone title is required").max(200),
  amount: z.number().positive("Milestone amount must be positive"),
  description: z.string().max(2000).optional(),
  status: z.string().optional(),
});

/**
 * Proportionally reconciles existing milestone amounts whenever a quote total is
 * revised without an explicit new milestone breakdown so sum(milestones) === targetAmount.
 * Funded/released/locked milestones retain their settled values; editable milestones
 * are scaled in pence with any rounding remainder placed on the final editable milestone.
 */
export function reconcileMilestonesToAmount(existingMilestones: any[], targetAmount: number): any[] {
  const targetPence = Math.round(Number(targetAmount) * 100);
  if (!Array.isArray(existingMilestones) || existingMilestones.length === 0) {
    return existingMilestones;
  }

  const currentTotalPence = existingMilestones.reduce(
    (sum, m) => sum + Math.round(Number(m.amount || 0) * 100),
    0
  );
  if (Math.abs(currentTotalPence - targetPence) <= 1) {
    return existingMilestones;
  }

  const lockedStatuses = new Set(["funded", "in_progress", "submitted", "approved", "released", "funds_released"]);
  let lockedPence = 0;
  const editableIndices: number[] = [];

  existingMilestones.forEach((m, idx) => {
    const st = String(m.status || "pending");
    if (lockedStatuses.has(st)) {
      lockedPence += Math.round(Number(m.amount || 0) * 100);
    } else {
      editableIndices.push(idx);
    }
  });

  if (lockedPence > targetPence) {
    throw new BadRequestError(
      `Revised quote amount (£${(targetPence / 100).toFixed(2)}) cannot be less than already funded/locked milestones (£${(lockedPence / 100).toFixed(2)}).`
    );
  }

  const remainingTargetPence = targetPence - lockedPence;
  if (editableIndices.length === 0) {
    if (remainingTargetPence > 0) {
      throw new BadRequestError("Cannot revise quote amount when all milestones are already funded or released without adding a new milestone.");
    }
    return existingMilestones;
  }

  const editableCurrentPence = editableIndices.reduce(
    (sum, idx) => sum + Math.max(0, Math.round(Number(existingMilestones[idx].amount || 0) * 100)),
    0
  );

  let allocatedPence = 0;
  const updated = existingMilestones.map((m) => ({ ...m }));

  editableIndices.forEach((idx, pos) => {
    const isLast = pos === editableIndices.length - 1;
    let newPence: number;
    if (isLast) {
      newPence = Math.max(1, remainingTargetPence - allocatedPence);
    } else if (editableCurrentPence > 0) {
      const origPence = Math.max(0, Math.round(Number(existingMilestones[idx].amount || 0) * 100));
      newPence = Math.max(1, Math.round((origPence / editableCurrentPence) * remainingTargetPence));
      allocatedPence += newPence;
    } else {
      newPence = Math.max(1, Math.floor(remainingTargetPence / editableIndices.length));
      allocatedPence += newPence;
    }
    updated[idx] = {
      ...updated[idx],
      amount: Math.round(newPence) / 100,
    };
  });

  return updated;
}

const ACCEPTED_QUOTE_SCOPE_SCHEMA = z
  .enum([
    "labor_only",
    "labour_only",
    "materials_included",
    "custom",
    "full_project",
    "complete_package",
    "full_package",
  ])
  .transform((val) => normalizeQuoteScope(val));

/**
 * 1. CreateQuote Schema
 */
export const CREATE_QUOTE_SCHEMA = z.object({
  jobId: z.string().min(1, "Job ID is required"),
  amount: z.number().positive("Quote amount must be positive").max(1000000, "Quote amount exceeds maximum allowed"),
  coverNote: z.string().max(5000).optional(),
  message: z.string().max(5000).optional(),
  estimatedDuration: z.string().max(100).optional(),
  estimatedDays: z.number().int().positive().optional().nullable(),
  startDate: z.string().max(100).optional().nullable(),
  startDateType: z.enum(["immediate", "flexible", "specific"]).optional(),
  expiryDate: z.string().max(100).optional().nullable(),
  isImmediateStart: z.boolean().optional(),
  isEmergency: z.boolean().optional(),
  paymentPreference: z.enum(["fixed_price", "hourly", "daily", "milestone", "negotiable"]).default("fixed_price"),
  paymentTrack: z.enum(["quick", "project"]).default("project"),
  quoteScope: ACCEPTED_QUOTE_SCOPE_SCHEMA.default("full_project"),
  depositTerm: z.string().optional(),
  guaranteeTerm: z.string().optional(),
  partsWarranty: z.string().optional(),
  milestones: z.array(QUOTE_MILESTONE_SCHEMA).optional(),
  materialsIncluded: z.boolean().optional(),
  materialsBreakdown: z.array(z.record(z.any())).optional(),
  attachments: z.array(z.string()).optional(),
  metadata: z.record(z.any()).optional(),
}).strict();

/**
 * 2. UpdateQuote Schema
 */
export const UPDATE_QUOTE_SCHEMA = z.object({
  jobId: z.string().min(1, "Job ID is required"),
  quoteId: z.string().min(1, "Quote ID is required"),
  amount: z.number().positive("Quote amount must be positive").max(1000000).optional(),
  coverNote: z.string().max(5000).optional(),
  message: z.string().max(5000).optional(),
  estimatedDuration: z.string().max(100).optional(),
  estimatedDays: z.number().int().positive().optional().nullable(),
  startDate: z.string().max(100).optional().nullable(),
  startDateType: z.enum(["immediate", "flexible", "specific"]).optional(),
  expiryDate: z.string().max(100).optional().nullable(),
  paymentPreference: z.enum(["fixed_price", "hourly", "daily", "milestone", "negotiable"]).optional(),
  paymentTrack: z.enum(["quick", "project"]).optional(),
  quoteScope: ACCEPTED_QUOTE_SCOPE_SCHEMA.optional(),
  milestones: z.array(QUOTE_MILESTONE_SCHEMA).optional(),
  materialsIncluded: z.boolean().optional(),
  materialsBreakdown: z.array(z.record(z.any())).optional(),
  attachments: z.array(z.string()).optional(),
  metadata: z.record(z.any()).optional(),
}).strict();

/**
 * 3. WithdrawQuote Schema
 */
export const WITHDRAW_QUOTE_SCHEMA = z.object({
  jobId: z.string().min(1, "Job ID is required"),
  quoteId: z.string().min(1, "Quote ID is required"),
  reason: z.string().max(1000).optional(),
}).strict();

/**
 * 3b. DeleteQuote Schema (Server-Authoritative Permanent Quote Deletion)
 */
export const DELETE_QUOTE_SCHEMA = z.object({
  jobId: z.string().min(1, "Job ID is required"),
  quoteId: z.string().min(1, "Quote ID is required"),
  reason: z.string().max(1000).optional(),
}).strict();

/**
 * 4. RejectQuote Schema
 */
export const REJECT_QUOTE_SCHEMA = z.object({
  jobId: z.string().min(1, "Job ID is required"),
  quoteId: z.string().min(1, "Quote ID is required"),
  reason: z.string().max(1000).optional(),
}).strict();

/**
 * 5. RequestRequote Schema
 */
export const REQUEST_REQUOTE_SCHEMA = z.object({
  jobId: z.string().min(1, "Job ID is required"),
  quoteId: z.string().min(1, "Quote ID is required"),
  message: z.string().min(1, "Requote message is required").max(2000),
  suggestedBudget: z.number().positive().max(1000000).optional().nullable(),
}).strict();

/**
 * 6. RespondToRequote Schema
 */
export const RESPOND_TO_REQUOTE_SCHEMA = z.object({
  jobId: z.string().min(1, "Job ID is required"),
  quoteId: z.string().min(1, "Quote ID is required"),
  amount: z.number().positive("Revised quote amount must be positive").max(1000000),
  coverNote: z.string().max(5000).optional(),
  message: z.string().max(5000).optional(),
  estimatedDuration: z.string().max(100).optional(),
  estimatedDays: z.number().int().positive().optional().nullable(),
  startDate: z.string().max(100).optional().nullable(),
  quoteScope: ACCEPTED_QUOTE_SCOPE_SCHEMA.optional(),
  milestones: z.array(QUOTE_MILESTONE_SCHEMA).optional(),
  materialsIncluded: z.boolean().optional(),
  materialsBreakdown: z.array(z.record(z.any())).optional(),
  attachments: z.array(z.string()).optional(),
  metadata: z.record(z.any()).optional(),
}).strict();

export type CreateQuoteInput = z.infer<typeof CREATE_QUOTE_SCHEMA>;
export type UpdateQuoteInput = z.infer<typeof UPDATE_QUOTE_SCHEMA>;
export type WithdrawQuoteInput = z.infer<typeof WITHDRAW_QUOTE_SCHEMA>;
export type DeleteQuoteInput = z.infer<typeof DELETE_QUOTE_SCHEMA>;
export type RejectQuoteInput = z.infer<typeof REJECT_QUOTE_SCHEMA>;
export type RequestRequoteInput = z.infer<typeof REQUEST_REQUOTE_SCHEMA>;
export type RespondToRequoteInput = z.infer<typeof RESPOND_TO_REQUOTE_SCHEMA>;

/**
 * 7. AcceptQuote Schema (Task 4)
 */
export const ACCEPT_QUOTE_SCHEMA = z.object({
  jobId: z.string().min(1, "Job ID is required"),
  quoteId: z.string().min(1, "Quote ID is required"),
}).strict();

export type AcceptQuoteInput = z.infer<typeof ACCEPT_QUOTE_SCHEMA>;

export type QuoteCommandType =
  | "CreateQuote"
  | "UpdateQuote"
  | "WithdrawQuote"
  | "DeleteQuote"
  | "RejectQuote"
  | "RequestRequote"
  | "RespondToRequote"
  | "AcceptQuote";

export type QuoteCommandPayload =
  | { type: "CreateQuote"; payload: CreateQuoteInput }
  | { type: "UpdateQuote"; payload: UpdateQuoteInput }
  | { type: "WithdrawQuote"; payload: WithdrawQuoteInput }
  | { type: "DeleteQuote"; payload: DeleteQuoteInput }
  | { type: "RejectQuote"; payload: RejectQuoteInput }
  | { type: "RequestRequote"; payload: RequestRequoteInput }
  | { type: "RespondToRequote"; payload: RespondToRequoteInput }
  | { type: "AcceptQuote"; payload: AcceptQuoteInput };

/**
 * Validates raw payload against command schemas and enforces OWASP mass-assignment rejection.
 */
export function validateQuoteCommandPayload(commandType: QuoteCommandType, rawPayload: unknown): any {
  if (!rawPayload || typeof rawPayload !== "object") {
    throw new BadRequestError(`${commandType} payload must be a non-empty object.`);
  }

  const raw = rawPayload as Record<string, any>;
  const suppliedProtectedKeys = Object.keys(raw).filter((key) => QUOTE_MUTATION_PROTECTED_KEYS.has(key));

  if (suppliedProtectedKeys.length > 0) {
    throw new BadRequestError(
      `Protected server-owned fields cannot be supplied in quote command: ${suppliedProtectedKeys.join(", ")}`
    );
  }

  let result: z.SafeParseReturnType<any, any>;
  switch (commandType) {
    case "CreateQuote":
      result = CREATE_QUOTE_SCHEMA.safeParse(raw);
      break;
    case "UpdateQuote":
      result = UPDATE_QUOTE_SCHEMA.safeParse(raw);
      break;
    case "WithdrawQuote":
      result = WITHDRAW_QUOTE_SCHEMA.safeParse(raw);
      break;
    case "DeleteQuote":
      result = DELETE_QUOTE_SCHEMA.safeParse(raw);
      break;
    case "RejectQuote":
      result = REJECT_QUOTE_SCHEMA.safeParse(raw);
      break;
    case "RequestRequote":
      result = REQUEST_REQUOTE_SCHEMA.safeParse(raw);
      break;
    case "RespondToRequote":
      result = RESPOND_TO_REQUOTE_SCHEMA.safeParse(raw);
      break;
    case "AcceptQuote":
      result = ACCEPT_QUOTE_SCHEMA.safeParse(raw);
      break;
    default:
      throw new BadRequestError(`Unsupported quote command type: ${commandType}`);
  }

  if (!result.success) {
    const errorDetails = result.error.errors.map((e) => `${e.path.join(".") || "field"}: ${e.message}`).join("; ");
    throw new BadRequestError(`Invalid ${commandType} input schema: ${errorDetails}`);
  }

  return result.data;
}

export interface ExecuteQuoteCommandOptions {
  db: any;
  identity: CanonicalIdentity;
  command: QuoteCommandPayload;
  idempotencyKey?: string;
  commissionRate?: number; // optional explicit override; otherwise resolved dynamically from trader tier + Admin config (default 5% PAYG)
  commissionCapGbp?: number; // optional explicit override; otherwise resolved dynamically from Admin config (default £250)
  messagingClient?: any;
}

export interface ExecuteQuoteCommandResult {
  success: boolean;
  commandType: QuoteCommandType;
  quoteId: string;
  jobId: string;
  status: QuoteStatus;
  quote?: Record<string, any>;
  acceptedTradespersonId?: string;
  scheduledDate?: string;
  verificationPin?: string;
  isConfirmedByTradesperson?: boolean;
  jobTitle?: string;
  rejectedCompetingQuotes?: Array<{ quoteId: string; traderId: string }>;
  wasReplayed: boolean;
}

/**
 * Server-Authoritative Quote Command Executor
 * Executes real atomic Firestore transactions for quote lifecycle transitions.
 */
export async function executeQuoteCommand(
  options: ExecuteQuoteCommandOptions
): Promise<ExecuteQuoteCommandResult> {
  const { db, identity, command, commissionRate: explicitCommissionRate, commissionCapGbp: explicitCapGbp, messagingClient } = options;

  if (!db) {
    throw new BadRequestError("Database service is not initialized.");
  }

  if (!identity || !identity.uid) {
    throw new ForbiddenError("Authentication required: trusted canonical identity is missing.");
  }

  const { type: commandType } = command;
  const validatedInput = validateQuoteCommandPayload(commandType, command.payload);
  const jobId = validatedInput.jobId;

  // 1. Persistent Idempotency Key Normalization & Validation
  const rawIdempotencyKey = (options.idempotencyKey || "").trim();
  if (!rawIdempotencyKey || rawIdempotencyKey.length < 8 || rawIdempotencyKey.length > 200) {
    throw new BadRequestError("Idempotency key is required and must be between 8 and 200 characters.");
  }
  const idempotencyDocId = rawIdempotencyKey.replace(/\//g, "_");
  const idempotencyRef = db.collection("idempotency_keys").doc(idempotencyDocId);

  const jobRef = db.collection("jobs").doc(jobId);

  // Preload dynamic Admin pricing/commission configs before entering the Firestore transaction
  const { globalTiers, globalConfig } = ["CreateQuote", "UpdateQuote", "RespondToRequote"].includes(commandType)
    ? await getDynamicFirestoreConfigs(db)
    : { globalTiers: null, globalConfig: null };

  // 2. Execute Real Atomic Firestore Transaction
  const transactionResult = await db.runTransaction(async (transaction: any) => {
    // A. Check Idempotency Record
    const idempSnap = await transaction.get(idempotencyRef);
    if (idempSnap.exists) {
      const idempData = idempSnap.data();
      if (idempData.status === "completed" && idempData.response) {
        return {
          ...idempData.response,
          wasReplayed: true,
        };
      }
    }

    // B. Read Authoritative Job Document
    const jobSnap = await transaction.get(jobRef);
    if (!jobSnap.exists) {
      throw new NotFoundError(`Target job '${jobId}' does not exist.`);
    }
    const jobData = jobSnap.data() || {};
    const homeownerId = jobData.homeownerId || jobData.userId || jobData.ownerId;

    const isAdmin =
      identity.accountType === "admin" ||
      (identity as any).isAdmin === true ||
      (identity as any).role === "admin";

    if (commandType === "CreateQuote" && identity.uid === homeownerId) {
      throw new BadRequestError("Homeowners cannot submit quotes on their own jobs.");
    }

    const traderProfileSnap =
      !isAdmin && ["CreateQuote", "UpdateQuote", "RespondToRequote"].includes(commandType)
        ? await transaction.get(db.collection("users").doc(identity.uid))
        : null;

    if (!isAdmin && ["CreateQuote", "UpdateQuote", "RespondToRequote"].includes(commandType)) {
      const hasTraderCapability =
        hasCapability(identity, "tradesperson") ||
        identity.accountType === "service_provider" ||
        identity.accountType === "business";
      if (!hasTraderCapability || identity.accountType === "consumer") {
        throw new ForbiddenError("Only verified tradespeople can submit or revise quotes on jobs.");
      }

      const idVerifStatus = String(identity.verification?.status || "").trim().toLowerCase();
      if (["unverified", "rejected", "suspended", "revoked"].includes(idVerifStatus)) {
        throw new ForbiddenError(`Tradesperson account verification status '${idVerifStatus}' cannot submit quotes.`);
      }

      if (traderProfileSnap?.exists) {
        const traderData =
          (typeof traderProfileSnap.data === "function" ? traderProfileSnap.data() : traderProfileSnap.data) || {};
        const storedStatus = String(traderData.status || "").trim().toLowerCase();
        const storedVerifStatus = String(traderData.verificationStatus || "").trim().toLowerCase();
        const storedRole = String(traderData.role || "").trim().toLowerCase();
        const storedAccountType = String(traderData.accountType || "").trim().toLowerCase();

        if (
          traderData.isSuspended === true ||
          traderData.isDisabled === true ||
          traderData.disabled === true ||
          traderData.isBanned === true ||
          traderData.banned === true ||
          ["suspended", "frozen", "banned", "deleted", "disabled"].includes(storedStatus)
        ) {
          throw new ForbiddenError("Tradesperson account is suspended or disabled and cannot submit quotes.");
        }

        if (["rejected", "revoked", "suspended", "expired", "unverified"].includes(storedVerifStatus)) {
          throw new ForbiddenError("Tradesperson account must be verified before submitting quotes.");
        }

        const isProvisionalOrNonRegPending =
          storedVerifStatus === "provisional" ||
          (storedVerifStatus === "pending" && traderData.requiresAdminVerification !== true);

        if (isProvisionalOrNonRegPending) {
          let gracePeriodDays = DEFAULT_DOCUMENT_GRACE_PERIOD_DAYS;
          let enforceGracePeriod = true;
          let provisionalMaxQuotes = DEFAULT_PROVISIONAL_MAX_QUOTES;
          try {
            const dynCfg = await getDynamicFirestoreConfigs(db);
            const rawDays = Number(dynCfg?.globalConfig?.documentGracePeriodDays);
            if (Number.isFinite(rawDays) && rawDays >= 0) {
              gracePeriodDays = Math.floor(rawDays);
            }
            if (typeof dynCfg?.globalConfig?.enforceDocumentGracePeriod === "boolean") {
              enforceGracePeriod = dynCfg.globalConfig.enforceDocumentGracePeriod;
            }
            const rawMaxQuotes = Number(dynCfg?.globalConfig?.provisionalMaxQuotes);
            if (Number.isFinite(rawMaxQuotes) && rawMaxQuotes >= 0) {
              provisionalMaxQuotes = Math.floor(rawMaxQuotes);
            }
          } catch {
            // Fall back to canonical 14-day / 5-quote enforced grace policy
          }

          const compliance = evaluateTraderDocumentCompliance(traderData, {
            gracePeriodDays,
            enforceGracePeriod,
            provisionalMaxQuotes,
            targetJobCategory: jobData.category || jobData.trade || null,
          });
          if (!compliance.canQuote) {
            throw new ForbiddenError(
              compliance.blockReason || "Tradesperson account must be verified before submitting quotes."
            );
          }
        } else if (traderData.isVerified === false) {
          throw new ForbiddenError("Tradesperson account must be verified before submitting quotes.");
        }

        if (
          (["homeowner", "customer", "passenger", "driver"].includes(storedRole) &&
            !Array.isArray(traderData.capabilities)) ||
          storedAccountType === "consumer"
        ) {
          throw new ForbiddenError("Consumer accounts cannot submit tradesperson quotes.");
        }
      }
    }

    let targetQuoteRef: any = null;
    let existingQuoteData: Record<string, any> | null = null;

    if (commandType !== "CreateQuote") {
      const quoteId = (validatedInput as any).quoteId;
      targetQuoteRef = jobRef.collection("quotes").doc(quoteId);
      const quoteSnap = await transaction.get(targetQuoteRef);
      if (!quoteSnap.exists) {
        throw new NotFoundError(`Target quote '${quoteId}' was not found on job '${jobId}'.`);
      }
      existingQuoteData = quoteSnap.data() || {};
    }

    // Resolve quoting trader profile data before any writes so fee calculations reflect the trader's true tier
    let quotingTraderData: Record<string, any> = {};
    if (traderProfileSnap?.exists) {
      quotingTraderData =
        (typeof traderProfileSnap.data === "function" ? traderProfileSnap.data() : traderProfileSnap.data) || {};
    } else if (["CreateQuote", "UpdateQuote", "RespondToRequote"].includes(commandType)) {
      const targetTraderUid =
        commandType === "CreateQuote"
          ? identity.uid
          : existingQuoteData?.tradespersonId || existingQuoteData?.traderId || existingQuoteData?.proId;
      if (targetTraderUid) {
        const snap = await transaction.get(db.collection("users").doc(targetTraderUid));
        if (snap?.exists) {
          quotingTraderData = (typeof snap.data === "function" ? snap.data() : snap.data) || {};
        }
      }
    }

    const computeQuoteFeeBreakdown = async (amountGbp: number) => {
      const amountPence = Math.round(amountGbp * 100);
      const resolved = await resolveAnyTraderCommission({
        amountPence,
        traderData: quotingTraderData,
        globalTiers,
        globalConfig,
        explicitCommissionRate,
        explicitCapGbp,
      });
      return {
        platformFee: Math.round(resolved.platformFeePence) / 100,
        netPayout: Math.round(resolved.netPayoutPence) / 100,
        appliedCommissionRate: resolved.commissionRate,
        commissionCapGbp: resolved.commissionCapGbp,
      };
    };

    const nowIso = new Date().toISOString();
    let resultingQuoteId = "";
    let resultingStatus: QuoteStatus = "pending";
    let resultingQuoteDoc: Record<string, any> = {};
    let rejectedCompetingQuotes: Array<{ quoteId: string; traderId: string }> = [];

    switch (commandType) {
      case "CreateQuote": {
        // Validation: Trader cannot quote their own job
        if (identity.uid === homeownerId) {
          throw new BadRequestError("Homeowners cannot submit quotes on their own jobs.");
        }

        // Validation: Job must be open for quoting
        if (!["open", "quoted"].includes(jobData.status)) {
          throw new ForbiddenError(`Job is not currently accepting quotes (status: ${jobData.status}).`);
        }

        // Validation: Direct 1-to-1 Quote Request Targeting
        const targetedTrader =
          jobData.targetTradespersonId ||
          jobData.targetTraderId ||
          jobData.targetProId ||
          jobData.directTraderId;
        if (targetedTrader && identity.uid !== targetedTrader && !identity.accountType?.includes("admin")) {
          throw new ForbiddenError("This direct quote request was sent exclusively to another tradesperson.");
        }

        // Validation: Maximum 5 quotes per job limit (allow explicit 1-to-1 direct invitation to respond)
        const isExplicitlyInvitedTrader = Boolean(targetedTrader && identity.uid === targetedTrader);
        const currentQuoteCount = Number(jobData.quoteCount || jobData.quotesCount || 0);
        if (currentQuoteCount >= 5 && !isExplicitlyInvitedTrader) {
          throw new ForbiddenError("This job has reached the maximum limit of 5 quotes.");
        }

        // Validation: Priority Offers exclusive window (server-authoritative enforcement + counter update)
        const rawExclusiveUntil = jobData.exclusiveUntil;
        const exclusiveUntilDate = rawExclusiveUntil?.toDate
          ? rawExclusiveUntil.toDate()
          : rawExclusiveUntil
          ? new Date(rawExclusiveUntil)
          : null;
        const isWithinExclusiveWindow = Boolean(
          exclusiveUntilDate &&
            !Number.isNaN(exclusiveUntilDate.getTime()) &&
            exclusiveUntilDate.getTime() > Date.now() &&
            !isExplicitlyInvitedTrader &&
            !identity.accountType?.includes("admin") &&
            globalConfig?.paywallEnabled !== false
        );
        let exclusiveUsedToday = 0;
        if (isWithinExclusiveWindow) {
          if (!quotingTraderData?.hasExclusiveAddon) {
            throw new ForbiddenError("This job is currently exclusive to Priority Offers members. Please wait or upgrade.");
          }
          const lastExclRaw = quotingTraderData?.lastExclusiveQuoteDate;
          const lastExclDate = lastExclRaw?.toDate
            ? lastExclRaw.toDate()
            : lastExclRaw
            ? new Date(lastExclRaw)
            : new Date(0);
          const nowDate = new Date();
          const isSameDay =
            lastExclDate.getUTCFullYear() === nowDate.getUTCFullYear() &&
            lastExclDate.getUTCMonth() === nowDate.getUTCMonth() &&
            lastExclDate.getUTCDate() === nowDate.getUTCDate();
          exclusiveUsedToday = isSameDay ? Number(quotingTraderData?.exclusiveSlotsUsedToday || 0) : 0;
          if (exclusiveUsedToday >= 3) {
            throw new ForbiddenError("You have used your 3 daily exclusive quotes. You can quote once this job enters the public feed.");
          }
          const cooldownRaw = quotingTraderData?.exclusiveCooldownUntil;
          const cooldownDate = cooldownRaw?.toDate
            ? cooldownRaw.toDate()
            : cooldownRaw
            ? new Date(cooldownRaw)
            : new Date(0);
          if (cooldownDate.getTime() > Date.now()) {
            throw new ForbiddenError("Please wait 2 hours between exclusive priority quotes.");
          }
        }

        // Invariant: Single active quote per trader on the same job
        // 1. Transactional Trader Lock Document Check
        const traderLockDocId = `${jobId}_${identity.uid}`;
        const traderLockRef = db.collection("trader_quote_locks").doc(traderLockDocId);
        const traderLockSnap = await transaction.get(traderLockRef);
        const publicCardRef = db.collection("public_job_cards").doc(jobId);
        const publicCardSnap = await transaction.get(publicCardRef);
        if (traderLockSnap.exists) {
          const lockData = traderLockSnap.data();
          const lockStatus = lockData?.status;
          if (["pending", "requoted", "requote_requested"].includes(lockStatus)) {
            throw new ConflictError(
              `You already have an active quote (${lockData?.quoteId || "existing"}) on this job. Please update or withdraw your existing quote.`
            );
          }
        }

        // 2. Query quotes subcollection as secondary validation
        const existingQuotesQuery = await jobRef
          .collection("quotes")
          .where("tradespersonId", "==", identity.uid)
          .get();

        const activeQuote = existingQuotesQuery.docs.find((d: any) => {
          const st = d.data()?.status;
          return st === "pending" || st === "requoted" || st === "requote_requested";
        });

        if (activeQuote) {
          throw new ConflictError(
            `You already have an active quote (${activeQuote.id}) on this job. Please update or withdraw your existing quote.`
          );
        }

        targetQuoteRef = jobRef.collection("quotes").doc();
        resultingQuoteId = targetQuoteRef.id;
        resultingStatus = "pending";

        const numAmount = Math.round(Number(validatedInput.amount) * 100) / 100;
        const {
          platformFee,
          netPayout,
          appliedCommissionRate,
          commissionCapGbp,
        } = await computeQuoteFeeBreakdown(numAmount);

        let milestones = validatedInput.milestones;
        if (milestones && milestones.length > 0) {
          const milestoneSum = milestones.reduce((sum: number, m: any) => sum + Number(m.amount), 0);
          if (Math.abs(milestoneSum - numAmount) > 0.05) {
            throw new BadRequestError(
              `The sum of milestone amounts (£${milestoneSum.toFixed(2)}) must match the total quote amount (£${numAmount.toFixed(2)}).`
            );
          }
          milestones = milestones.map((m: any, idx: number) => ({
            id: m.id || `m_${idx + 1}_${Date.now()}`,
            title: m.title,
            amount: Math.round(Number(m.amount) * 100) / 100,
            description: m.description || "",
            status: "pending",
          }));
        } else {
          milestones = [
            {
              id: `m_1_${Date.now()}`,
              title: "Complete Job Deliverables",
              amount: numAmount,
              description: "Final completion of all agreed quote scope.",
              status: "pending",
            },
          ];
        }

        resultingQuoteDoc = {
          id: resultingQuoteId,
          jobId,
          jobNo: jobData.jobNo ?? null,
          tradespersonId: identity.uid,
          traderId: identity.uid,
          proId: identity.uid,
          homeownerId,
          amount: numAmount,
          totalAmount: numAmount,
          platformFee,
          commission: platformFee,
          netPayout,
          appliedCommissionRate,
          commissionCapGbp,
          currency: "gbp",
          coverNote: validatedInput.coverNote || validatedInput.message || "",
          message: validatedInput.coverNote || validatedInput.message || "",
          estimatedDuration: validatedInput.estimatedDuration || "",
          estimatedTimeline: (validatedInput.estimatedDuration || "").replace(/_/g, " "),
          estimatedDays: validatedInput.estimatedDays ?? null,
          startDate: validatedInput.startDate ?? null,
          startDateType: validatedInput.startDateType || "flexible",
          isImmediateStart: validatedInput.startDateType === "immediate" || !!validatedInput.isImmediateStart,
          expiryDate: validatedInput.expiryDate ?? null,
          isEmergency: !!validatedInput.isEmergency,
          paymentPreference: validatedInput.paymentPreference || "fixed_price",
          paymentTrack: validatedInput.paymentTrack || "project",
          quoteScope: validatedInput.quoteScope || "labor_only",
          depositTerm: validatedInput.depositTerm || "0_percent_completion",
          guaranteeTerm: validatedInput.guaranteeTerm || "1_year_workmanship",
          partsWarranty: validatedInput.partsWarranty || "standard_parts",
          milestones,
          materialsIncluded: !!validatedInput.materialsIncluded,
          materialsBreakdown: validatedInput.materialsBreakdown || [],
          attachments: validatedInput.attachments || [],
          metadata: validatedInput.metadata || {},
          status: resultingStatus,
          revisionCount: 1,
          createdAt: nowIso,
          updatedAt: nowIso,
          history: [
            {
              amount: numAmount,
              message: validatedInput.coverNote || validatedInput.message || "",
              timestamp: nowIso,
              reason: "Initial Quote Creation",
            },
          ],
        };

        transaction.set(targetQuoteRef, resultingQuoteDoc);

        // Transactional Trader Lock
        transaction.set(traderLockRef, {
          jobId,
          quoteId: resultingQuoteId,
          traderId: identity.uid,
          status: resultingStatus,
          updatedAt: nowIso,
        });

        // Atomic Trader User Updates (Provisional quote counter + Exclusive Lead counter + Real Behavioral Velocity)
        const traderUserUpdates: Record<string, any> = {};
        if (String(quotingTraderData?.verificationStatus || "").toLowerCase() === "provisional") {
          traderUserUpdates.provisionalQuotesUsed =
            Math.max(0, Math.floor(Number(quotingTraderData?.provisionalQuotesUsed || 0))) + 1;
        }
        if (isWithinExclusiveWindow) {
          traderUserUpdates.exclusiveSlotsUsedToday = exclusiveUsedToday + 1;
          traderUserUpdates.exclusiveCooldownUntil = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
          traderUserUpdates.lastExclusiveQuoteDate = nowIso;
        }
        // Record real behavioral response velocity (EMA of minutes between job post and quote)
        const prevQuotesSubmitted = Math.max(0, Math.floor(Number(quotingTraderData?.quotesSubmitted || 0)));
        traderUserUpdates.quotesSubmitted = prevQuotesSubmitted + 1;
        const jobPostedRaw = jobData.postedDate || jobData.createdAt;
        const jobPostedMs =
          typeof jobPostedRaw?.toMillis === "function"
            ? jobPostedRaw.toMillis()
            : typeof jobPostedRaw === "string"
            ? Date.parse(jobPostedRaw)
            : typeof jobPostedRaw === "number"
            ? jobPostedRaw
            : NaN;
        if (Number.isFinite(jobPostedMs) && jobPostedMs > 0) {
          const responseMinutes = Math.max(1, Math.min(10080, (Date.now() - jobPostedMs) / 60000));
          const prevAvg = Number(quotingTraderData?.avgResponseMinutes);
          const nextAvg =
            Number.isFinite(prevAvg) && prevAvg > 0
              ? Math.round((prevAvg * 0.7 + responseMinutes * 0.3) * 10) / 10
              : Math.round(responseMinutes * 10) / 10;
          traderUserUpdates.avgResponseMinutes = nextAvg;
          traderUserUpdates.lastQuotedAt = nowIso;
        }
        if (Object.keys(traderUserUpdates).length > 0) {
          traderUserUpdates.updatedAt = nowIso;
          transaction.set(db.collection("users").doc(identity.uid), traderUserUpdates, { merge: true });
        }

        // Atomic Job Quote Count Update
        const nextJobStatus = jobData.status === "open" ? "quoted" : jobData.status;
        transaction.update(jobRef, {
          quoteCount: currentQuoteCount + 1,
          quotesCount: currentQuoteCount + 1,
          hasQuotes: true,
          status: nextJobStatus,
          lastQuoteDate: nowIso,
          updatedAt: nowIso,
        });

        if (publicCardSnap?.exists) {
          transaction.update(publicCardRef, {
            quoteCount: currentQuoteCount + 1,
            status: nextJobStatus,
            updatedAt: nowIso,
          });
        }

        break;
      }

      case "UpdateQuote": {
        const quotingTrader =
          existingQuoteData?.tradespersonId ||
          existingQuoteData?.traderId ||
          existingQuoteData?.proId;

        if (identity.uid !== quotingTrader && !identity.accountType?.includes("admin")) {
          throw new ForbiddenError("You cannot modify another tradesperson's quote.");
        }

        if (!["pending", "requoted"].includes(existingQuoteData?.status)) {
          throw new ForbiddenError(
            `Quote cannot be updated while in status '${existingQuoteData?.status}'.`
          );
        }

        if (!["open", "quoted"].includes(jobData.status)) {
          throw new ForbiddenError(`Cannot update quote: parent job is '${jobData.status}'.`);
        }

        resultingQuoteId = (validatedInput as any).quoteId;
        resultingStatus = existingQuoteData?.status as QuoteStatus;

        const updatedAmount =
          validatedInput.amount !== undefined
            ? Math.round(Number(validatedInput.amount) * 100) / 100
            : existingQuoteData?.amount;
        const {
          platformFee,
          netPayout,
          appliedCommissionRate,
          commissionCapGbp,
        } = await computeQuoteFeeBreakdown(updatedAmount);

        let milestones = validatedInput.milestones || existingQuoteData?.milestones;
        if (validatedInput.milestones) {
          const milestoneSum = validatedInput.milestones.reduce((sum: number, m: any) => sum + Number(m.amount), 0);
          if (Math.abs(milestoneSum - updatedAmount) > 0.05) {
            throw new BadRequestError(
              `The sum of milestone amounts (£${milestoneSum.toFixed(2)}) must match updated quote amount (£${updatedAmount.toFixed(2)}).`
            );
          }
          milestones = validatedInput.milestones.map((m: any, idx: number) => ({
            id: m.id || `m_${idx + 1}_${Date.now()}`,
            title: m.title,
            amount: Math.round(Number(m.amount) * 100) / 100,
            description: m.description || "",
            status: "pending",
          }));
        } else if (Array.isArray(existingQuoteData?.milestones) && existingQuoteData.milestones.length > 0) {
          milestones = reconcileMilestonesToAmount(existingQuoteData.milestones, updatedAmount);
        }

        const existingHistory = Array.isArray(existingQuoteData?.history) ? existingQuoteData?.history : [];
        const newHistory = [
          ...existingHistory,
          {
            amount: updatedAmount,
            message: validatedInput.coverNote || validatedInput.message || existingQuoteData?.message || "",
            timestamp: nowIso,
            reason: "Quote Updated by Tradesperson",
          },
        ];

        resultingQuoteDoc = {
          ...existingQuoteData,
          amount: updatedAmount,
          totalAmount: updatedAmount,
          platformFee,
          commission: platformFee,
          netPayout,
          appliedCommissionRate,
          commissionCapGbp,
          coverNote: validatedInput.coverNote ?? existingQuoteData?.coverNote,
          message: validatedInput.coverNote ?? validatedInput.message ?? existingQuoteData?.message,
          estimatedDuration: validatedInput.estimatedDuration ?? existingQuoteData?.estimatedDuration,
          estimatedTimeline: validatedInput.estimatedDuration ? validatedInput.estimatedDuration.replace(/_/g, " ") : existingQuoteData?.estimatedTimeline,
          estimatedDays: validatedInput.estimatedDays !== undefined ? validatedInput.estimatedDays : existingQuoteData?.estimatedDays,
          startDate: validatedInput.startDate !== undefined ? validatedInput.startDate : existingQuoteData?.startDate,
          startDateType: validatedInput.startDateType ?? existingQuoteData?.startDateType,
          expiryDate: validatedInput.expiryDate !== undefined ? validatedInput.expiryDate : existingQuoteData?.expiryDate,
          paymentPreference: validatedInput.paymentPreference ?? existingQuoteData?.paymentPreference,
          paymentTrack: validatedInput.paymentTrack ?? existingQuoteData?.paymentTrack,
          quoteScope: validatedInput.quoteScope ?? existingQuoteData?.quoteScope,
          milestones,
          materialsIncluded: validatedInput.materialsIncluded !== undefined ? !!validatedInput.materialsIncluded : existingQuoteData?.materialsIncluded,
          materialsBreakdown: validatedInput.materialsBreakdown ?? existingQuoteData?.materialsBreakdown,
          attachments: validatedInput.attachments ?? existingQuoteData?.attachments,
          metadata: { ...(existingQuoteData?.metadata || {}), ...(validatedInput.metadata || {}) },
          history: newHistory,
          updatedAt: nowIso,
        };

        transaction.set(targetQuoteRef, resultingQuoteDoc, { merge: true });
        break;
      }

      case "WithdrawQuote": {
        const quotingTrader =
          existingQuoteData?.tradespersonId ||
          existingQuoteData?.traderId ||
          existingQuoteData?.proId;

        if (identity.uid !== quotingTrader && !identity.accountType?.includes("admin")) {
          throw new ForbiddenError("You cannot withdraw another tradesperson's quote.");
        }

        validateQuoteTransition(existingQuoteData?.status, "withdrawn");

        resultingQuoteId = (validatedInput as any).quoteId;
        resultingStatus = "withdrawn";

        const existingHistory = Array.isArray(existingQuoteData?.history) ? existingQuoteData?.history : [];
        const newHistory = [
          ...existingHistory,
          {
            amount: existingQuoteData?.amount,
            message: existingQuoteData?.message,
            timestamp: nowIso,
            reason: `Withdrawn: ${validatedInput.reason || "Withdrawn by tradesperson"}`,
          },
        ];

        resultingQuoteDoc = {
          ...existingQuoteData,
          status: resultingStatus,
          withdrawReason: validatedInput.reason || "Withdrawn by tradesperson",
          withdrawnAt: nowIso,
          history: newHistory,
          updatedAt: nowIso,
        };

        transaction.set(targetQuoteRef, resultingQuoteDoc, { merge: true });

        // Update Trader Lock on Withdraw
        const withdrawLockRef = db.collection("trader_quote_locks").doc(`${jobId}_${quotingTrader}`);
        transaction.set(
          withdrawLockRef,
          { jobId, quoteId: resultingQuoteId, traderId: quotingTrader, status: resultingStatus, updatedAt: nowIso },
          { merge: true }
        );

        // Decrement parent job quote count if previously active
        const currentQuoteCount = Number(jobData.quoteCount || jobData.quotesCount || 1);
        const decrementedCount = Math.max(0, currentQuoteCount - 1);
        transaction.update(jobRef, {
          quoteCount: decrementedCount,
          quotesCount: decrementedCount,
          hasQuotes: decrementedCount > 0,
          updatedAt: nowIso,
        });

        break;
      }

      case "DeleteQuote": {
        const quotingTrader =
          existingQuoteData?.tradespersonId ||
          existingQuoteData?.traderId ||
          existingQuoteData?.proId;

        if (identity.uid !== quotingTrader && !isAdmin) {
          throw new ForbiddenError("You can only delete your own quotes.");
        }

        const existingQuoteStatus = String(existingQuoteData?.status || "pending").toLowerCase();
        if (
          existingQuoteStatus === "accepted" ||
          jobData.acceptedQuoteId === (validatedInput as any).quoteId ||
          existingQuoteData?.funded === true ||
          existingQuoteData?.isPaid === true ||
          existingQuoteData?.payoutTransferred === true
        ) {
          throw new ConflictError("Accepted or funded quotes cannot be deleted for audit and escrow integrity.");
        }

        const quoteIdToDelete = (validatedInput as any).quoteId;
        resultingQuoteId = quoteIdToDelete;
        resultingStatus = "withdrawn";
        resultingQuoteDoc = {
          ...existingQuoteData,
          id: quoteIdToDelete,
          status: "withdrawn",
          deletedAt: nowIso,
          deleteReason: validatedInput.reason || "Deleted by tradesperson",
        };

        // Permanently delete the non-accepted quote document inside the authoritative server transaction
        transaction.delete(targetQuoteRef);

        // Release trader lock cleanly so audit trail records deletion
        if (quotingTrader) {
          const deleteLockRef = db.collection("trader_quote_locks").doc(`${jobId}_${quotingTrader}`);
          transaction.set(
            deleteLockRef,
            { jobId, quoteId: quoteIdToDelete, traderId: quotingTrader, status: "deleted", deletedAt: nowIso, updatedAt: nowIso },
            { merge: true }
          );
        }

        // Decrement parent job quote count only if this quote was still counted as active
        const wasActiveQuote = ["pending", "submitted", "requoted", "requote_requested"].includes(existingQuoteStatus);
        if (wasActiveQuote) {
          const currentQuoteCount = Number(jobData.quoteCount || jobData.quotesCount || 1);
          const decrementedCount = Math.max(0, currentQuoteCount - 1);
          transaction.update(jobRef, {
            quoteCount: decrementedCount,
            quotesCount: decrementedCount,
            hasQuotes: decrementedCount > 0,
            updatedAt: nowIso,
          });
        }

        break;
      }

      case "RejectQuote": {
        if (identity.uid !== homeownerId && !identity.accountType?.includes("admin")) {
          throw new ForbiddenError("Only the job creator can reject quotes.");
        }

        validateQuoteTransition(existingQuoteData?.status, "rejected");

        resultingQuoteId = (validatedInput as any).quoteId;
        resultingStatus = "rejected";

        const existingHistory = Array.isArray(existingQuoteData?.history) ? existingQuoteData?.history : [];
        const newHistory = [
          ...existingHistory,
          {
            amount: existingQuoteData?.amount,
            message: existingQuoteData?.message,
            timestamp: nowIso,
            reason: `Rejected: ${validatedInput.reason || "Declined by homeowner"}`,
          },
        ];

        resultingQuoteDoc = {
          ...existingQuoteData,
          status: resultingStatus,
          rejectReason: validatedInput.reason || "Declined by homeowner",
          rejectedAt: nowIso,
          history: newHistory,
          updatedAt: nowIso,
        };

        transaction.set(targetQuoteRef, resultingQuoteDoc, { merge: true });

        // Update Trader Lock on Reject
        const rejectedTraderId = existingQuoteData?.tradespersonId || existingQuoteData?.traderId || existingQuoteData?.proId;
        const rejectLockRef = db.collection("trader_quote_locks").doc(`${jobId}_${rejectedTraderId}`);
        transaction.set(
          rejectLockRef,
          { jobId, quoteId: resultingQuoteId, traderId: rejectedTraderId, status: resultingStatus, updatedAt: nowIso },
          { merge: true }
        );

        // Decrement active quote counter on parent job if rejecting an active quote (AT-QUOTE-05)
        const wasActiveQuote = ["pending", "requoted", "requote_requested", "submitted"].includes(
          String(existingQuoteData?.status || "")
        );
        if (wasActiveQuote) {
          const currentQuoteCount = Number(jobData.quoteCount ?? jobData.quotesCount ?? 1);
          const decrementedCount = Math.max(0, currentQuoteCount - 1);
          const jobUpdateOnReject: Record<string, any> = {
            quoteCount: decrementedCount,
            quotesCount: decrementedCount,
            hasQuotes: decrementedCount > 0,
            updatedAt: nowIso,
          };
          if (jobData.status === "quoted" && decrementedCount === 0) {
            jobUpdateOnReject.status = "open";
          }
          transaction.update(jobRef, jobUpdateOnReject);
        }
        break;
      }

      case "RequestRequote": {
        if (identity.uid !== homeownerId && !identity.accountType?.includes("admin")) {
          throw new ForbiddenError("Only the job creator can request quote revisions.");
        }

        validateQuoteTransition(existingQuoteData?.status, "requote_requested");

        const currentRevisions = Number(existingQuoteData?.revisionCount || 1);
        if (currentRevisions >= 5) {
          throw new ForbiddenError("Maximum revision limit (5) reached for this quote.");
        }

        resultingQuoteId = (validatedInput as any).quoteId;
        resultingStatus = "requote_requested";

        resultingQuoteDoc = {
          ...existingQuoteData,
          status: resultingStatus,
          requoteMessage: validatedInput.message,
          requoteRequest: {
            requestedByUid: identity.uid,
            message: validatedInput.message,
            suggestedBudget: validatedInput.suggestedBudget ?? null,
            requestedAt: nowIso,
          },
          updatedAt: nowIso,
        };

        transaction.set(targetQuoteRef, resultingQuoteDoc, { merge: true });

        // Update Trader Lock on Requote Request
        const requoteReqLockRef = db.collection("trader_quote_locks").doc(`${jobId}_${existingQuoteData?.tradespersonId || existingQuoteData?.traderId}`);
        transaction.set(
          requoteReqLockRef,
          { jobId, quoteId: resultingQuoteId, traderId: existingQuoteData?.tradespersonId || existingQuoteData?.traderId, status: resultingStatus, updatedAt: nowIso },
          { merge: true }
        );
        break;
      }

      case "RespondToRequote": {
        const quotingTrader =
          existingQuoteData?.tradespersonId ||
          existingQuoteData?.traderId ||
          existingQuoteData?.proId;

        if (identity.uid !== quotingTrader && !identity.accountType?.includes("admin")) {
          throw new ForbiddenError("You cannot respond to revisions on another tradesperson's quote.");
        }

        validateQuoteTransition(existingQuoteData?.status, "requoted");

        resultingQuoteId = (validatedInput as any).quoteId;
        resultingStatus = "requoted";

        const numAmount = Math.round(Number(validatedInput.amount) * 100) / 100;
        const {
          platformFee,
          netPayout,
          appliedCommissionRate,
          commissionCapGbp,
        } = await computeQuoteFeeBreakdown(numAmount);

        const currentRevisions = Number(existingQuoteData?.revisionCount || 1);
        const nextRevisionCount = currentRevisions + 1;

        let milestones = validatedInput.milestones || existingQuoteData?.milestones;
        if (validatedInput.milestones) {
          const milestoneSum = validatedInput.milestones.reduce((sum: number, m: any) => sum + Number(m.amount), 0);
          if (Math.abs(milestoneSum - numAmount) > 0.05) {
            throw new BadRequestError(
              `The sum of milestone amounts (£${milestoneSum.toFixed(2)}) must match the revised quote amount (£${numAmount.toFixed(2)}).`
            );
          }
          milestones = validatedInput.milestones.map((m: any, idx: number) => ({
            id: m.id || `m_${idx + 1}_${Date.now()}`,
            title: m.title,
            amount: Math.round(Number(m.amount) * 100) / 100,
            description: m.description || "",
            status: "pending",
          }));
        } else if (Array.isArray(existingQuoteData?.milestones) && existingQuoteData.milestones.length > 0) {
          milestones = reconcileMilestonesToAmount(existingQuoteData.milestones, numAmount);
        }

        const existingHistory = Array.isArray(existingQuoteData?.history) ? existingQuoteData?.history : [];
        const newHistory = [
          ...existingHistory,
          {
            amount: numAmount,
            message: validatedInput.coverNote || validatedInput.message || "",
            timestamp: nowIso,
            reason: `Requote Response (Revision #${nextRevisionCount})`,
          },
        ];

        resultingQuoteDoc = {
          ...existingQuoteData,
          amount: numAmount,
          totalAmount: numAmount,
          platformFee,
          commission: platformFee,
          netPayout,
          appliedCommissionRate,
          commissionCapGbp,
          coverNote: validatedInput.coverNote ?? existingQuoteData?.coverNote,
          message: validatedInput.coverNote ?? validatedInput.message ?? existingQuoteData?.message,
          estimatedDuration: validatedInput.estimatedDuration ?? existingQuoteData?.estimatedDuration,
          estimatedTimeline: validatedInput.estimatedDuration ? validatedInput.estimatedDuration.replace(/_/g, " ") : existingQuoteData?.estimatedTimeline,
          estimatedDays: validatedInput.estimatedDays !== undefined ? validatedInput.estimatedDays : existingQuoteData?.estimatedDays,
          startDate: validatedInput.startDate !== undefined ? validatedInput.startDate : existingQuoteData?.startDate,
          quoteScope: validatedInput.quoteScope ?? existingQuoteData?.quoteScope,
          milestones,
          materialsIncluded: validatedInput.materialsIncluded !== undefined ? !!validatedInput.materialsIncluded : existingQuoteData?.materialsIncluded,
          materialsBreakdown: validatedInput.materialsBreakdown ?? existingQuoteData?.materialsBreakdown,
          attachments: validatedInput.attachments ?? existingQuoteData?.attachments,
          metadata: { ...(existingQuoteData?.metadata || {}), ...(validatedInput.metadata || {}) },
          status: resultingStatus,
          revisionCount: nextRevisionCount,
          requoteMessage: null,
          history: newHistory,
          updatedAt: nowIso,
        };

        transaction.set(targetQuoteRef, resultingQuoteDoc, { merge: true });

        // Update Trader Lock on Requote Response
        const requoteRespLockRef = db.collection("trader_quote_locks").doc(`${jobId}_${quotingTrader}`);
        transaction.set(
          requoteRespLockRef,
          { jobId, quoteId: resultingQuoteId, traderId: quotingTrader, status: resultingStatus, updatedAt: nowIso },
          { merge: true }
        );
        break;
      }

      case "AcceptQuote": {
        const quoteId = (validatedInput as any).quoteId;
        const quotingTrader = existingQuoteData?.tradespersonId || existingQuoteData?.traderId || existingQuoteData?.proId;
        const isAdmin = identity.accountType === "admin" || (identity as any).isAdmin === true || (identity as any).role === "admin";

        // 1. Authorization: Only job owner or admin can accept quotes
        if (identity.uid !== homeownerId && !isAdmin) {
          throw new ForbiddenError("You are not authorized to accept quotes for this job.");
        }

        // 2. Anti-Self Quoting / Trader Authorization
        if (quotingTrader === identity.uid && !isAdmin) {
          throw new ForbiddenError("Tradespeople cannot accept their own quotes.");
        }

        // 3. Job State Validation
        const currentJobStatus = (jobData.status === "posted" ? "open" : (jobData.status || "open")) as JobStatus;
        validateJobTransition(currentJobStatus, "accepted");
        if (currentJobStatus === "accepted" || jobData.acceptedQuoteId) {
          throw new ConflictError(`Job '${jobId}' has already been accepted.`);
        }
        if (["cancelled", "completed", "disputed", "in_progress"].includes(currentJobStatus)) {
          throw new ConflictError(`Job '${jobId}' is in '${currentJobStatus}' status and cannot accept quotes.`);
        }

        // 4. Target Quote State Validation
        const currentQuoteStatus = (existingQuoteData?.status || "pending") as QuoteStatus;
        validateQuoteTransition(currentQuoteStatus, "accepted");
        if (currentQuoteStatus === "accepted") {
          throw new ConflictError(`Quote '${quoteId}' has already been accepted.`);
        }
        if (currentQuoteStatus === "withdrawn") {
          throw new ConflictError(`Cannot accept withdrawn quote '${quoteId}'.`);
        }
        if (currentQuoteStatus === "rejected") {
          throw new ConflictError(`Cannot accept rejected quote '${quoteId}'.`);
        }

        // 5. Trader Identity & Financial Validation
        if (!quotingTrader || typeof quotingTrader !== "string") {
          throw new BadRequestError(`Target quote '${quoteId}' does not have a valid tradesperson identity.`);
        }
        const numAmount = Number(existingQuoteData?.amount || existingQuoteData?.totalAmount || 0);
        if (numAmount <= 0) {
          throw new BadRequestError(`Target quote '${quoteId}' has an invalid amount (${numAmount}).`);
        }

        // 6. Server-Generated Acceptance Values
        const pin = Math.floor(1000 + Math.random() * 9000).toString();
        const scheduledDate = existingQuoteData?.startDate || nowIso.split("T")[0];
        const isConfirmedByTradesperson = false;

        // 7. Atomic Read of Competing Quotes and Public Card
        const allQuotesSnap = await transaction.get(jobRef.collection("quotes"));
        const publicCardRef = db.collection("public_job_cards").doc(jobId);
        const publicCardSnap = await transaction.get(publicCardRef);

        resultingQuoteId = quoteId;
        resultingStatus = "accepted";
        resultingQuoteDoc = {
          ...existingQuoteData,
          status: resultingStatus,
          acceptedAt: nowIso,
          updatedAt: nowIso,
        };

        // 8. Atomic Write: Accept Target Quote
        transaction.update(targetQuoteRef, {
          status: resultingStatus,
          acceptedAt: nowIso,
          updatedAt: nowIso,
        });

        // 9. Atomic Write: Reject Competing Pending/Requoted Quotes
        for (const otherDoc of allQuotesSnap.docs) {
          if (otherDoc.id !== quoteId) {
            const otherData = otherDoc.data() || {};
            if (["pending", "requoted", "requote_requested", "submitted"].includes(otherData.status || "pending")) {
              transaction.update(otherDoc.ref, {
                status: "rejected",
                rejectionReason: "Job awarded to another trader",
                rejectedAt: nowIso,
                updatedAt: nowIso,
              });
              const otherTrader = otherData.tradespersonId || otherData.traderId || otherData.proId;
              if (otherTrader) {
                rejectedCompetingQuotes.push({ quoteId: otherDoc.id, traderId: String(otherTrader) });
                const otherLockRef = db.collection("trader_quote_locks").doc(`${jobId}_${otherTrader}`);
                transaction.set(otherLockRef, { jobId, quoteId: otherDoc.id, traderId: otherTrader, status: "rejected", updatedAt: nowIso }, { merge: true });
              }
            }
          }
        }

        // 10. Atomic Write: Update Job Record (AT-CJ-SEC-START-01: keep plaintext PIN out of trader-readable job doc)
        transaction.update(jobRef, {
          status: "accepted",
          acceptedQuoteId: quoteId,
          acceptedTradespersonId: quotingTrader,
          acceptedTraderId: quotingTrader,
          tradespersonId: quotingTrader,
          scheduledDate,
          isConfirmedByTradesperson,
          hasVerificationPin: true,
          acceptedAt: nowIso,
          updatedAt: nowIso,
        });

        // 10b. Store arrival verification PIN strictly in homeowner/admin-only security record
        const arrivalPinRef = db.collection("job_arrival_pins").doc(jobId);
        transaction.set(arrivalPinRef, {
          jobId,
          homeownerId,
          verificationPin: pin,
          createdAt: nowIso,
          updatedAt: nowIso,
        });

        // 11. Atomic Write: Update Public Job Card (if exists)
        if (publicCardSnap.exists) {
          transaction.update(publicCardRef, { status: "accepted", updatedAt: nowIso });
        }

        // 12. Atomic Write: Update Accepted Trader Lock
        const acceptedLockRef = db.collection("trader_quote_locks").doc(`${jobId}_${quotingTrader}`);
        transaction.set(acceptedLockRef, { jobId, quoteId, traderId: quotingTrader, status: "accepted", updatedAt: nowIso }, { merge: true });

        // Augment local resultingQuoteDoc for commandResponse (returned only to homeowner/admin caller of AcceptQuote)
        resultingQuoteDoc.scheduledDate = scheduledDate;
        resultingQuoteDoc.verificationPin = pin;
        resultingQuoteDoc.isConfirmedByTradesperson = isConfirmedByTradesperson;
        break;
      }
    }

    const commandResponse = {
      success: true,
      commandType,
      quoteId: resultingQuoteId,
      jobId,
      status: resultingStatus,
      acceptedTradespersonId: resultingQuoteDoc?.tradespersonId || resultingQuoteDoc?.traderId || (resultingQuoteDoc as any)?.acceptedTradespersonId || jobData?.acceptedTradespersonId,
      scheduledDate: resultingQuoteDoc?.scheduledDate || jobData?.scheduledDate || resultingQuoteDoc?.startDate,
      ...(commandType === "AcceptQuote" ? { verificationPin: resultingQuoteDoc?.verificationPin } : {}),
      isConfirmedByTradesperson: resultingQuoteDoc?.isConfirmedByTradesperson ?? jobData?.isConfirmedByTradesperson ?? false,
      jobTitle: String(jobData?.title || "your job"),
      ...(commandType === "AcceptQuote" ? { rejectedCompetingQuotes } : {}),
      quote: resultingQuoteDoc,
      wasReplayed: false,
    };

    // Store Idempotency Record
    transaction.set(idempotencyRef, {
      idempotencyKey: rawIdempotencyKey,
      commandType,
      jobId,
      quoteId: resultingQuoteId,
      status: "completed",
      response: commandResponse,
      actorUid: identity.uid,
      createdAt: nowIso,
      updatedAt: nowIso,
    });

    return commandResponse;
  });

  // 3. Post-Transaction Domain Event Dispatch
  if (!transactionResult.wasReplayed) {
    const eventTypeMap: Record<QuoteCommandType, any> = {
      CreateQuote: "QUOTE_CREATED",
      UpdateQuote: "QUOTE_UPDATED",
      WithdrawQuote: "QUOTE_WITHDRAWN",
      DeleteQuote: "QUOTE_WITHDRAWN",
      RejectQuote: "QUOTE_REJECTED",
      RequestRequote: "REQUOTE_REQUESTED",
      RespondToRequote: "REQUOTE_RESPONDED",
      AcceptQuote: "QUOTE_ACCEPTED",
    };

    await domainEvents.dispatch(
      eventTypeMap[commandType],
      transactionResult.quoteId,
      identity.uid,
      {
        jobId,
        quoteId: transactionResult.quoteId,
        status: transactionResult.status,
        amount: transactionResult.quote?.amount,
        revisionCount: transactionResult.quote?.revisionCount,
        traderId: transactionResult.acceptedTradespersonId,
        acceptedTradespersonId: transactionResult.acceptedTradespersonId,
        scheduledDate: transactionResult.scheduledDate,
        verificationPin: transactionResult.verificationPin,
      },
      undefined,
      db
    );

    // Server-authoritative notification dispatch (In-App + FCM Push + Delayed WhatsApp Fallback)
    try {
      const targetHomeownerUid = transactionResult.quote?.homeownerId;
      const targetTraderUid =
        transactionResult.quote?.tradespersonId ||
        transactionResult.quote?.traderId ||
        transactionResult.acceptedTradespersonId;
      const quoteAmt = Number(transactionResult.quote?.amount || 0);
      const formattedAmt = Number.isFinite(quoteAmt) && quoteAmt > 0 ? ` (£${quoteAmt.toLocaleString("en-GB")})` : "";
      const jobTitleLabel = transactionResult.jobTitle ? ` for "${transactionResult.jobTitle}"` : " on your job";
      const notifNow = new Date().toISOString();

      const notificationsToSend: Array<{
        recipientUid: string;
        title: string;
        message: string;
        type: string;
        link: string;
        quoteId: string;
        enableWhatsApp: boolean;
      }> = [];

      if (commandType === "CreateQuote" && targetHomeownerUid && targetHomeownerUid !== identity.uid) {
        notificationsToSend.push({
          recipientUid: targetHomeownerUid,
          title: "New Quote Received",
          message: `A tradesperson submitted a quote${formattedAmt}${jobTitleLabel}.`,
          type: "quote",
          link: `/job/${jobId}`,
          quoteId: transactionResult.quoteId,
          enableWhatsApp: true,
        });
      } else if (commandType === "UpdateQuote" && targetHomeownerUid && targetHomeownerUid !== identity.uid) {
        notificationsToSend.push({
          recipientUid: targetHomeownerUid,
          title: "Quote Updated",
          message: `A tradesperson updated their quote${formattedAmt}${jobTitleLabel}.`,
          type: "quote",
          link: `/job/${jobId}`,
          quoteId: transactionResult.quoteId,
          enableWhatsApp: true,
        });
      } else if (commandType === "RespondToRequote" && targetHomeownerUid && targetHomeownerUid !== identity.uid) {
        notificationsToSend.push({
          recipientUid: targetHomeownerUid,
          title: "Revised Quote Submitted",
          message: `A tradesperson responded to your re-quote request${formattedAmt}${jobTitleLabel}.`,
          type: "quote",
          link: `/job/${jobId}`,
          quoteId: transactionResult.quoteId,
          enableWhatsApp: true,
        });
      } else if (commandType === "WithdrawQuote" && targetHomeownerUid && targetHomeownerUid !== identity.uid) {
        notificationsToSend.push({
          recipientUid: targetHomeownerUid,
          title: "Quote Withdrawn",
          message: `A tradesperson withdrew their quote${jobTitleLabel}.`,
          type: "quote",
          link: `/job/${jobId}`,
          quoteId: transactionResult.quoteId,
          enableWhatsApp: false,
        });
      } else if (commandType === "RequestRequote" && targetTraderUid && targetTraderUid !== identity.uid) {
        notificationsToSend.push({
          recipientUid: targetTraderUid,
          title: "Re-Quote Requested",
          message: `A homeowner requested a revised quote on your bid${jobTitleLabel}.`,
          type: "quote",
          link: `/job/${jobId}`,
          quoteId: transactionResult.quoteId,
          enableWhatsApp: true,
        });
      } else if (commandType === "RejectQuote" && targetTraderUid && targetTraderUid !== identity.uid) {
        notificationsToSend.push({
          recipientUid: targetTraderUid,
          title: "Quote Declined",
          message: `A homeowner declined your quote${jobTitleLabel}. Browse the Job Feed for more local jobs.`,
          type: "quote",
          link: "/my-quotes",
          quoteId: transactionResult.quoteId,
          enableWhatsApp: false,
        });
      } else if (commandType === "AcceptQuote") {
        if (targetTraderUid && targetTraderUid !== identity.uid) {
          notificationsToSend.push({
            recipientUid: targetTraderUid,
            title: "Quote Accepted! 🎉",
            message: `Your quote${formattedAmt}${jobTitleLabel} was accepted. Please confirm your start date${transactionResult.scheduledDate ? ` (${transactionResult.scheduledDate})` : ""}.`,
            type: "quote",
            link: `/job/${jobId}`,
            quoteId: transactionResult.quoteId,
            enableWhatsApp: true,
          });
        }
        const competing = Array.isArray(transactionResult.rejectedCompetingQuotes)
          ? transactionResult.rejectedCompetingQuotes
          : [];
        for (const comp of competing) {
          if (comp.traderId && comp.traderId !== identity.uid && comp.traderId !== targetTraderUid) {
            notificationsToSend.push({
              recipientUid: comp.traderId,
              title: "Job Awarded to Another Trader",
              message: `The homeowner has accepted another quote${jobTitleLabel}.`,
              type: "status",
              link: "/my-quotes",
              quoteId: comp.quoteId,
              enableWhatsApp: false,
            });
          }
        }
      }

      if (notificationsToSend.length > 0 && typeof db?.collection === "function") {
        const notifCol = db.collection("notifications");
        if (notifCol && typeof notifCol.doc === "function") {
          for (const item of notificationsToSend) {
            const notifRef = notifCol.doc();
            await notifRef.set({
              userId: item.recipientUid,
              senderId: identity.uid,
              title: item.title,
              message: item.message,
              type: item.type,
              link: item.link,
              actionPath: item.link,
              jobId,
              quoteId: item.quoteId,
              read: false,
              isRead: false,
              createdAt: notifNow,
            });

            if (messagingClient) {
              dispatchAuthoritativeFcmPush(db, messagingClient, {
                recipientId: item.recipientUid,
                title: item.title,
                body: item.message,
                channelId: "job_leads",
                notificationId: notifRef.id,
                eventType: item.type,
                data: {
                  link: item.link,
                  jobId,
                  type: item.type,
                },
              }).catch(() => {});
            }

            if (item.enableWhatsApp) {
              enqueueWhatsAppFallback(db, {
                recipientUid: item.recipientUid,
                senderUid: identity.uid,
                senderLabel: item.title,
                contextId: jobId,
                contextType: "anytrader_quote",
                contextSummary: item.message,
                deepLinkPath: item.link,
                notificationId: notifRef.id,
              }).catch(() => {});
            }
          }
        }
      }
    } catch (notifErr) {
      console.warn("[QuoteCommands] Non-blocking notification write skipped:", notifErr);
    }
  }

  return transactionResult;
}

export interface ExecuteAcceptQuoteOptions {
  db: any;
  identity: CanonicalIdentity;
  jobId: string;
  quoteId: string;
  rawPayload?: Record<string, any>;
  idempotencyKey?: string;
  messagingClient?: any;
}

/**
 * Single Authoritative Atomic AcceptQuote Command Executor (Task 4)
 * Executes atomic Firestore transaction guaranteeing single accepted quote,
 * competing quotes rejection, server-owned fields, and persistent idempotency.
 */
export async function executeAcceptQuoteCommand(
  options: ExecuteAcceptQuoteOptions
): Promise<ExecuteQuoteCommandResult> {
  const { db, identity, jobId, quoteId, rawPayload = {}, idempotencyKey, messagingClient } = options;

  return executeQuoteCommand({
    db,
    identity,
    command: {
      type: "AcceptQuote",
      payload: {
        jobId,
        quoteId,
        ...rawPayload,
      },
    },
    idempotencyKey: idempotencyKey || `accept_${jobId}_${quoteId}_${identity.uid}`,
    messagingClient,
  });
}
