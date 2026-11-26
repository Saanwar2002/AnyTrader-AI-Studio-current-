/**
 * Server-Authoritative AnyTrader Stage 1B Foundation Commands
 *
 * Replaces legacy direct client Firestore mutations that were blocked by hardened
 * security rules with strict, authenticated, server-validated atomic commands:
 * 1. executeInviteTraderToJobCommand — Homeowner invites a trader from PublicProfile
 * 2. executeCreateBomOrderCommand — Participant places a BOM material order & links job
 * 3. executeGenerateRecurringJobCommand — Participant triggers due recurring job + accepted quote
 */

import admin from "firebase-admin";
import { z } from "zod";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "./httpErrors.ts";
import { CanonicalIdentity } from "./identity.ts";
import { getDynamicFirestoreConfigs, resolveAnyTraderCommission } from "./pricingCatalog.ts";
import { domainEvents } from "./domainEvents.ts";

const SAFE_ID_REGEX = /^[a-zA-Z0-9_-]{1,128}$/;

function isAdminIdentity(identity: CanonicalIdentity): boolean {
  return (
    identity.accountType === "admin" ||
    (identity as any).isAdmin === true ||
    (identity as any).role === "admin"
  );
}

// ============================================================================
// 1. Invite Trader to Existing Open Job (from PublicProfile)
// ============================================================================

const INVITE_TRADER_SCHEMA = z.object({
  jobId: z.string().regex(SAFE_ID_REGEX, "Invalid job ID"),
  traderId: z.string().regex(SAFE_ID_REGEX, "Invalid trader ID"),
});

export interface InviteTraderToJobResult {
  success: boolean;
  jobId: string;
  traderId: string;
  targetTradespersonId: string;
  targetTradespersonName: string;
  invitedTraderIds: string[];
}

export async function executeInviteTraderToJobCommand(options: {
  db: any;
  identity: CanonicalIdentity;
  jobId: string;
  traderId: string;
}): Promise<InviteTraderToJobResult> {
  const { db, identity } = options;
  if (!db) throw new BadRequestError("Database service is not initialized.");
  if (!identity?.uid) throw new ForbiddenError("Authentication required.");

  const parsed = INVITE_TRADER_SCHEMA.safeParse({
    jobId: options.jobId,
    traderId: options.traderId,
  });
  if (!parsed.success) {
    throw new BadRequestError(parsed.error.errors.map((e) => e.message).join("; "));
  }
  const { jobId, traderId } = parsed.data;

  if (traderId === identity.uid && !isAdminIdentity(identity)) {
    throw new BadRequestError("You cannot invite yourself to quote on your own job.");
  }

  const jobRef = db.collection("jobs").doc(jobId);
  const traderUserRef = db.collection("users").doc(traderId);
  const traderPublicRef = db.collection("public_profiles").doc(traderId);

  const result = await db.runTransaction(async (tx: any) => {
    const jobSnap = await tx.get(jobRef);
    if (!jobSnap.exists) {
      throw new NotFoundError(`Job '${jobId}' does not exist.`);
    }
    const jobData = jobSnap.data() || {};
    const jobOwnerUid = jobData.homeownerId || jobData.userId || jobData.ownerId;

    if (identity.uid !== jobOwnerUid && !isAdminIdentity(identity)) {
      throw new ForbiddenError("Only the job owner can invite a tradesperson to this job.");
    }

    const status = String(jobData.status || "open").toLowerCase();
    if (!["open", "posted", "quoted"].includes(status)) {
      throw new ConflictError(`Cannot invite a tradesperson when job status is '${status}'.`);
    }
    if (String(jobData.urgency || "").toLowerCase() === "emergency") {
      throw new BadRequestError("Emergency jobs cannot be directly requested to a single tradesperson.");
    }

    const traderSnap = await tx.get(traderUserRef);
    const traderPublicSnap = traderSnap.exists ? null : await tx.get(traderPublicRef);
    const traderData = traderSnap.exists
      ? traderSnap.data() || {}
      : traderPublicSnap?.exists
      ? traderPublicSnap.data() || {}
      : null;

    if (!traderData) {
      throw new NotFoundError(`Tradesperson '${traderId}' does not exist.`);
    }

    const authoritativeTraderName = String(
      traderData.businessName || traderData.companyName || traderData.name || "Tradesperson"
    ).slice(0, 120);

    const existingInvited: string[] = Array.isArray(jobData.invitedTraderIds)
      ? jobData.invitedTraderIds.filter((v: any) => typeof v === "string")
      : [];
    const nextInvited = existingInvited.includes(traderId)
      ? existingInvited
      : [...existingInvited, traderId].slice(0, 50);

    const nextTargetId = jobData.targetTradespersonId || traderId;
    const nextTargetName = jobData.targetTradespersonId
      ? String(jobData.targetTradespersonName || authoritativeTraderName)
      : authoritativeTraderName;

    const nowIso = new Date().toISOString();
    tx.update(jobRef, {
      invitedTraderIds: nextInvited,
      targetTradespersonId: nextTargetId,
      targetTradespersonName: nextTargetName,
      updatedAt: nowIso,
    });

    return {
      success: true,
      jobId,
      traderId,
      targetTradespersonId: nextTargetId,
      targetTradespersonName: nextTargetName,
      invitedTraderIds: nextInvited,
    };
  });

  return result;
}

// ============================================================================
// 2. Server-Authoritative BOM Material Order Placement
// ============================================================================

const BOM_ITEM_SCHEMA = z.object({
  id: z.string().min(1).max(120),
  name: z.string().min(1).max(250),
  sku: z.string().max(120).optional(),
  category: z.string().max(120).optional().default("Materials"),
  quantity: z.number().positive().max(10000),
  unit: z.string().min(1).max(60),
  unitCost: z.number().nonnegative().max(100000).optional(),
  estimatedUnitPrice: z.number().nonnegative().max(100000).optional(),
  retailCost: z.number().nonnegative().max(100000).optional(),
  totalCost: z.number().nonnegative().max(500000).optional(),
  suggestedSupplier: z.string().max(120).optional(),
  compatibilityNotes: z.string().max(500).optional(),
  stockStatus: z.string().max(60).optional(),
  isPassportComponent: z.boolean().optional(),
  merchantSku: z.string().max(120).optional(),
  inStock: z.boolean().optional(),
  notes: z.string().max(500).optional(),
});

const CREATE_BOM_ORDER_SCHEMA = z.object({
  jobId: z.string().regex(SAFE_ID_REGEX, "Invalid job ID").optional(),
  jobTitle: z.string().max(250).optional(),
  homeownerId: z.string().regex(SAFE_ID_REGEX).optional(),
  homeownerName: z.string().max(120).optional(),
  propertyId: z.string().regex(SAFE_ID_REGEX).optional(),
  items: z.array(BOM_ITEM_SCHEMA).min(1, "At least one material item is required").max(100),
  selectedMerchant: z.object({
    brand: z.string().min(1).max(80),
    merchantName: z.string().min(1).max(140),
    branchAddress: z.string().max(250).optional().default(""),
    basketTotal: z.number().positive().max(500000),
    tradeSavingsAmount: z.number().nonnegative().max(250000).optional().default(0),
    affiliateBreakdown: z
      .object({
        affiliateCommissionAmount: z.number().nonnegative().max(100000).optional().default(0),
      })
      .optional(),
  }),
  fulfillmentType: z.enum(["click_and_collect", "courier_dispatch"]),
  courierDetails: z
    .object({
      pickupAddress: z.string().max(300).optional(),
      deliveryAddress: z.string().max(300).optional(),
      deliveryWindow: z.string().max(60).optional(),
      vanTypeLabel: z.string().max(80).optional(),
      courierFee: z.number().nonnegative().max(5000).optional(),
      notes: z.string().max(500).optional(),
    })
    .optional(),
  paymentSource: z.enum(["homeowner_materials_escrow", "trader_trade_credit", "stripe_card"]),
});

export async function executeCreateBomOrderCommand(options: {
  db: any;
  identity: CanonicalIdentity;
  payload: unknown;
}): Promise<Record<string, any>> {
  const { db, identity, payload } = options;
  if (!db) throw new BadRequestError("Database service is not initialized.");
  if (!identity?.uid) throw new ForbiddenError("Authentication required.");

  const parsed = CREATE_BOM_ORDER_SCHEMA.safeParse(payload);
  if (!parsed.success) {
    throw new BadRequestError(
      parsed.error.errors.map((e) => `${e.path.join(".") || "field"}: ${e.message}`).join("; ")
    );
  }
  const input = parsed.data;
  const isAdmin = isAdminIdentity(identity);

  let authoritativeHomeownerId = input.homeownerId || null;
  let authoritativeJobTitle = input.jobTitle || "TradeOS Materials Order";
  let jobRef: any = null;

  if (input.jobId) {
    jobRef = db.collection("jobs").doc(input.jobId);
    const jobSnap = await jobRef.get();
    if (!jobSnap.exists) {
      throw new NotFoundError(`Job '${input.jobId}' does not exist.`);
    }
    const jobData = jobSnap.data() || {};
    const jobHomeowner = jobData.homeownerId || jobData.userId || jobData.ownerId || null;
    const jobTrader =
      jobData.acceptedTradespersonId ||
      jobData.acceptedTraderId ||
      jobData.assignedTradespersonId ||
      jobData.tradespersonId ||
      jobData.traderId ||
      null;

    if (!isAdmin && identity.uid !== jobHomeowner && identity.uid !== jobTrader) {
      throw new ForbiddenError("Only the assigned tradesperson or job owner can place a materials order for this job.");
    }
    authoritativeHomeownerId = jobHomeowner || authoritativeHomeownerId;
    authoritativeJobTitle = jobData.title || authoritativeJobTitle;
  }

  // Authoritative profile lookup for caller name
  const callerSnap = await db.collection("users").doc(identity.uid).get();
  const callerData = callerSnap.exists ? callerSnap.data() || {} : {};
  const authoritativeTraderName = String(
    callerData.businessName || callerData.name || "Verified Tradesperson"
  ).slice(0, 120);

  // Server-computed financial figures (never trust client VAT/totals)
  const subtotalCost = Math.round(Number(input.selectedMerchant.basketTotal) * 100) / 100;
  const vatAmount = Math.round(subtotalCost * 0.2 * 100) / 100;
  const totalAmount = Math.round((subtotalCost + vatAmount) * 100) / 100;
  const tradeDiscountAmount = Math.round(Number(input.selectedMerchant.tradeSavingsAmount || 0) * 100) / 100;
  const affiliateCommissionEarned =
    Math.round(Number(input.selectedMerchant.affiliateBreakdown?.affiliateCommissionAmount || 0) * 100) / 100;

  const orderId = `bom_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const brandCode = input.selectedMerchant.brand.replace(/[^a-zA-Z0-9]/g, "").slice(0, 3).toUpperCase() || "TRD";
  const pickupReferenceCode = `AT-${brandCode}-${Math.floor(100000 + Math.random() * 900000)}`;
  const vatInvoiceNumber = `VAT-BOM-${new Date().getFullYear()}-${Math.floor(10000 + Math.random() * 90000)}`;
  const nowIso = new Date().toISOString();
  const status = input.fulfillmentType === "click_and_collect" ? "ready_for_pickup" : "ordered";

  const orderRecord: Record<string, any> = {
    id: orderId,
    jobId: input.jobId || null,
    jobTitle: authoritativeJobTitle,
    tradespersonId: identity.uid,
    tradespersonName: authoritativeTraderName,
    homeownerId: authoritativeHomeownerId,
    homeownerName: (input.homeownerName || "Homeowner").slice(0, 120),
    propertyId: input.propertyId || null,
    items: input.items,
    itemCount: input.items.length,
    selectedMerchant: input.selectedMerchant.merchantName,
    merchantBranch: input.selectedMerchant.branchAddress || "",
    subtotalCost,
    tradeDiscountAmount,
    vatAmount,
    totalAmount,
    affiliateCommissionEarned,
    fulfillmentType: input.fulfillmentType,
    pickupReferenceCode,
    pickupBarcode: `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(pickupReferenceCode)}`,
    courierDetails: input.courierDetails || null,
    vatInvoiceNumber,
    paymentSource: input.paymentSource,
    status,
    propertyPassportSynced: false,
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  await db.runTransaction(async (tx: any) => {
    const orderRef = db.collection("bom_orders").doc(orderId);
    tx.set(orderRef, {
      ...orderRecord,
      createdAtServer: admin.firestore.FieldValue.serverTimestamp(),
    });

    if (jobRef) {
      tx.update(jobRef, {
        materialsCost: subtotalCost,
        hasBOMOrder: true,
        bomOrderId: orderId,
        bomMerchant: input.selectedMerchant.merchantName,
        bomStatus: status,
        bomPickupRef: pickupReferenceCode,
        updatedAt: nowIso,
      });
    }
  });

  return orderRecord;
}

// ============================================================================
// 3. Server-Authoritative Recurring Job + Accepted Quote Generator
// ============================================================================

export interface GenerateRecurringJobResult {
  success: boolean;
  generated: boolean;
  wasReplayed: boolean;
  reason?: string;
  jobId?: string;
  quoteId?: string;
  nextJobDate?: string;
}

function toJsDate(raw: any): Date | null {
  if (!raw) return null;
  if (typeof raw?.toDate === "function") {
    const d = raw.toDate();
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function executeGenerateRecurringJobCommand(options: {
  db: any;
  identity: CanonicalIdentity;
  scheduleId: string;
}): Promise<GenerateRecurringJobResult> {
  const { db, identity, scheduleId } = options;
  if (!db) throw new BadRequestError("Database service is not initialized.");
  if (!identity?.uid) throw new ForbiddenError("Authentication required.");
  if (!SAFE_ID_REGEX.test(scheduleId)) {
    throw new BadRequestError("Invalid recurring schedule ID.");
  }

  const isAdmin = isAdminIdentity(identity);
  const scheduleRef = db.collection("recurring_schedules").doc(scheduleId);
  const { globalTiers, globalConfig } = await getDynamicFirestoreConfigs(db);

  const txResult = await db.runTransaction(async (tx: any) => {
    const scheduleSnap = await tx.get(scheduleRef);
    if (!scheduleSnap.exists) {
      throw new NotFoundError(`Recurring schedule '${scheduleId}' does not exist.`);
    }
    const schedule = scheduleSnap.data() || {};

    const homeownerId = schedule.homeownerId || schedule.userId || null;
    const tradespersonId = schedule.tradespersonId || schedule.traderId || null;
    const participants: string[] = Array.isArray(schedule.participants) ? schedule.participants : [];

    const isParticipant =
      identity.uid === homeownerId ||
      identity.uid === tradespersonId ||
      participants.includes(identity.uid);

    if (!isAdmin && !isParticipant) {
      throw new ForbiddenError("Only participants of this recurring schedule can generate recurring job instances.");
    }

    if (String(schedule.status || "").toLowerCase() !== "active") {
      return {
        success: true,
        generated: false,
        wasReplayed: false,
        reason: "schedule_not_active",
      };
    }

    if (!homeownerId || !tradespersonId) {
      throw new BadRequestError("Recurring schedule is missing homeownerId or tradespersonId.");
    }

    const now = new Date();
    const lastGenerated = toJsDate(schedule.lastJobGeneratedAt) || toJsDate(schedule.createdAt) || now;
    const frequencyDays =
      schedule.frequency === "weekly" ? 7 : schedule.frequency === "fortnightly" ? 14 : 30;
    const nextJobDate = new Date(lastGenerated.getTime() + frequencyDays * 24 * 60 * 60 * 1000);
    const threeDaysFromNow = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);

    if (nextJobDate > threeDaysFromNow) {
      return {
        success: true,
        generated: false,
        wasReplayed: false,
        reason: "not_due_yet",
        nextJobDate: nextJobDate.toISOString(),
      };
    }

    const dateStamp = nextJobDate.toISOString().slice(0, 10);
    const idempDocId = `recurring_${scheduleId}_${dateStamp}`.replace(/[^a-zA-Z0-9_-]/g, "_");
    const idempRef = db.collection("idempotency_keys").doc(idempDocId);
    const idempSnap = await tx.get(idempRef);
    if (idempSnap.exists) {
      const existing = idempSnap.data() || {};
      if (existing.status === "completed" && existing.response) {
        return {
          ...existing.response,
          wasReplayed: true,
        };
      }
    }

    const traderSnap = await tx.get(db.collection("users").doc(tradespersonId));
    const traderData = traderSnap.exists ? traderSnap.data() || {} : {};
    const quoteAmount = Math.max(1, Number(schedule.amount || 0));
    const feeResolved = await resolveAnyTraderCommission({
      amountPence: Math.round(quoteAmount * 100),
      traderData,
      globalTiers,
      globalConfig,
    });
    const platformFee = Math.round(feeResolved.platformFeePence) / 100;
    const netPayout = Math.round(feeResolved.netPayoutPence) / 100;

    const jobRef = db.collection("jobs").doc();
    const quoteRef = jobRef.collection("quotes").doc();
    const nowIso = now.toISOString();
    const pin = Math.floor(1000 + Math.random() * 9000).toString();

    tx.set(jobRef, {
      id: jobRef.id,
      title: `[Recurring] ${schedule.title || "Scheduled Service"}`,
      description: `Automatically generated recurring service (${schedule.frequency || "monthly"}).`,
      category: schedule.category || "General Maintenance",
      postcode: schedule.postcode || "SW1A 1AA",
      urgency: "standard",
      status: "accepted",
      homeownerId,
      userId: homeownerId,
      ownerId: homeownerId,
      acceptedTradespersonId: tradespersonId,
      acceptedTraderId: tradespersonId,
      assignedTradespersonId: tradespersonId,
      tradespersonId,
      acceptedQuoteId: quoteRef.id,
      amount: quoteAmount,
      platformFee,
      netPayout,
      quoteCount: 1,
      quotesCount: 1,
      hasQuotes: true,
      recurringScheduleId: scheduleId,
      isRecurringInstance: true,
      preferredDate: nextJobDate.toISOString(),
      scheduledDate: dateStamp,
      hasVerificationPin: true,
      isConfirmedByTradesperson: true,
      paymentPreference: schedule.paymentPreference || "negotiable",
      quoteScope: schedule.quoteScope || "labor_only",
      postedDate: nowIso,
      createdAt: nowIso,
      updatedAt: nowIso,
    });

    tx.set(db.collection("job_arrival_pins").doc(jobRef.id), {
      jobId: jobRef.id,
      homeownerId,
      pin,
      createdAt: nowIso,
      updatedAt: nowIso,
    });

    tx.set(quoteRef, {
      id: quoteRef.id,
      jobId: jobRef.id,
      tradespersonId,
      traderId: tradespersonId,
      homeownerId,
      amount: quoteAmount,
      totalAmount: quoteAmount,
      platformFee,
      commission: platformFee,
      netPayout,
      appliedCommissionRate: feeResolved.commissionRate,
      commissionCapGbp: feeResolved.commissionCapGbp,
      status: "accepted",
      message: "Automatically generated recurring quote.",
      isRecurringAutoQuote: true,
      recurringScheduleId: scheduleId,
      createdAt: nowIso,
      acceptedAt: nowIso,
      updatedAt: nowIso,
    });

    tx.update(scheduleRef, {
      lastJobGeneratedAt: admin.firestore.FieldValue.serverTimestamp(),
      lastGeneratedJobId: jobRef.id,
      updatedAt: nowIso,
    });

    // Server-authoritative notifications to both parties
    const homeownerNotifRef = db.collection("notifications").doc();
    tx.set(homeownerNotifRef, {
      userId: homeownerId,
      title: "Upcoming Recurring Job",
      message: `A new instance of "${schedule.title || "Scheduled Service"}" has been scheduled for ${nextJobDate.toLocaleDateString("en-GB")}.`,
      type: "status",
      link: `/job/${jobRef.id}`,
      read: false,
      createdAt: nowIso,
    });

    const traderNotifRef = db.collection("notifications").doc();
    tx.set(traderNotifRef, {
      userId: tradespersonId,
      title: "New Recurring Job Instance",
      message: `You have a recurring job for "${schedule.title || "Scheduled Service"}" scheduled for ${nextJobDate.toLocaleDateString("en-GB")}.`,
      type: "status",
      link: `/job/${jobRef.id}`,
      read: false,
      createdAt: nowIso,
    });

    const response: GenerateRecurringJobResult = {
      success: true,
      generated: true,
      wasReplayed: false,
      jobId: jobRef.id,
      quoteId: quoteRef.id,
      nextJobDate: nextJobDate.toISOString(),
    };

    tx.set(idempRef, {
      idempotencyKey: idempDocId,
      commandType: "GenerateRecurringJob",
      scheduleId,
      jobId: jobRef.id,
      quoteId: quoteRef.id,
      status: "completed",
      response,
      actorUid: identity.uid,
      createdAt: nowIso,
      updatedAt: nowIso,
    });

    return response;
  });

  if (txResult.generated && !txResult.wasReplayed && txResult.jobId) {
    try {
      await domainEvents.dispatch(
        "JOB_CREATED",
        txResult.jobId,
        identity.uid,
        {
          recurringScheduleId: scheduleId,
          quoteId: txResult.quoteId,
        },
        undefined,
        db
      );
    } catch {
      // Non-fatal post-commit audit event
    }
  }

  return txResult;
}
