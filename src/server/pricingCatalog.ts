/**
 * SERVER-AUTHORITATIVE PRICING CATALOG & PAYMENT RESOLVER
 * Ensures zero client-side price tampering for subscriptions, add-ons, and fees.
 * Enforces the core platform financial constraint:
 * "Platform does NOT hold any client money into platform accounts.
 *  Only payment coming to platform account is commission and fees for add-ons, paid features etc.
 *  All client money (escrow milestones, ride fares) is handled through Stripe Connect."
 */

import { BadRequestError, ForbiddenError, NotFoundError } from "./httpErrors.ts";
import { isJobEligibleForMediationStake } from "./slice2MoneyFlowHelpers.ts";
import {
  DEFAULT_ANYTRADER_COMMISSIONS,
  DEFAULT_ANYTRADER_COMMISSION_CAP_GBP,
  normalizeTraderTier,
  type NormalizedTraderTier,
} from "../services/stripeIntegrationService.ts";
import {
  BANNER_AD_DAILY_RATE_GBP,
  calculateBannerAdCostPence,
  sanitizeAdWalletTopupGbp,
  sanitizeBannerDurationDays,
} from "../lib/adPricing.ts";

export { DEFAULT_ANYTRADER_COMMISSIONS, DEFAULT_ANYTRADER_COMMISSION_CAP_GBP };

export interface CatalogItem {
  id: string;
  name: string;
  amountPence: number; // In minor units (pence)
  currency: string;
  mode: "subscription" | "payment";
  interval?: "month" | "year";
  description?: string;
}

export const SERVER_PRICING_CATALOG: Record<string, CatalogItem> = {
  // Free / PAYG
  price_payg: {
    id: "price_payg",
    name: "Free Explorer Plan",
    amountPence: 0,
    currency: "gbp",
    mode: "subscription",
  },
  // Tradesperson Subscription Tiers (canonical defaults matching Admin Control Panel)
  price_pro: {
    id: "price_pro",
    name: "Silver Pro Subscription",
    amountPence: 1999, // £19.99
    currency: "gbp",
    mode: "subscription",
    interval: "month",
    description: "Pro platform subscription with instant quote access and lower commissions",
  },
  price_premium: {
    id: "price_premium",
    name: "Gold Elite Subscription",
    amountPence: 4999, // £49.99
    currency: "gbp",
    mode: "subscription",
    interval: "month",
    description: "Premium tier with top placement, priority dispatch, and lowest fees",
  },
  price_platinum: {
    id: "price_platinum",
    name: "Platinum Enterprise Powerhouse",
    amountPence: 9999, // £99.99
    currency: "gbp",
    mode: "subscription",
    interval: "month",
    description: "Full enterprise trader suite with unlimited leads and team seats",
  },
  // Landlord Subscription
  price_landlord: {
    id: "price_landlord",
    name: "Landlord Pro Portfolio Membership",
    amountPence: 1900, // £19.00
    currency: "gbp",
    mode: "subscription",
    interval: "month",
    description: "Multi-property digital twins, compliance alerts & 1-tap dispatch",
  },
  // Driver Subscription (AnyRoller — preserved at £49.99/mo, 10% commission)
  price_driver_gold: {
    id: "price_driver_gold",
    name: "Gold Driver Subscription",
    amountPence: 4999, // £49.99
    currency: "gbp",
    mode: "subscription",
    interval: "month",
    description: "Reduced 10% commission rate and 4 destination filters",
  },

  // Add-ons (canonical defaults matching Admin Control Panel)
  price_exclusive_leads: {
    id: "price_exclusive_leads",
    name: "Exclusive Priority Lead Dispatch",
    amountPence: 2900, // £29.00
    currency: "gbp",
    mode: "subscription",
    interval: "month",
    description: "30-minute exclusive head start on incoming matching quote requests",
  },
  price_video_pro: {
    id: "price_video_pro",
    name: "Verified Video Pro Add-on",
    amountPence: 1500, // £15.00
    currency: "gbp",
    mode: "subscription",
    interval: "month",
    description: "+35 match score points and verified video selfie badge",
  },
  price_video_pro_annual: {
    id: "price_video_pro_annual",
    name: "Verified Video Pro (Annual)",
    amountPence: 14400, // £144.00/yr (£12/mo)
    currency: "gbp",
    mode: "subscription",
    interval: "year",
    description: "Annual verified video pro membership with 20% discount",
  },
  price_appointments: {
    id: "price_appointments",
    name: "Automated Appointments Add-on",
    amountPence: 999, // £9.99/mo
    currency: "gbp",
    mode: "subscription",
    interval: "month",
    description: "Real-time customer appointment booking & availability calendar sync",
  },

  // One-off Platform Fees
  price_emergency_boost: {
    id: "price_emergency_boost",
    name: "Emergency Dispatch Priority Boost",
    amountPence: 500, // £5.00
    currency: "gbp",
    mode: "payment",
    description: "4-hour priority emergency broadcast to nearby active tradespeople",
  },
  price_instant_match: {
    id: "price_instant_match",
    name: "Instant Match Dispatch Fee",
    amountPence: 299, // £2.99
    currency: "gbp",
    mode: "payment",
    description: "Automated instant trader matching and direct dispatch",
  },
  price_dispute_stake: {
    id: "price_dispute_stake",
    name: "Dispute Mediation Stake",
    amountPence: 2500, // £25.00
    currency: "gbp",
    mode: "payment",
    description: "Independent dispute arbitration and technical assessment deposit",
  },
};

/**
 * Calculates server-authoritative pricing for B2B Social Housing ("Gotham") SaaS subscriptions.
 */
export function calculateGothamSaaSPlanServer(
  doors: number,
  billingCycle: "monthly" | "annual" = "monthly"
): {
  doorsCount: number;
  ratePerDoor: number;
  monthlyTotalPence: number;
  annualTotalPence: number;
  chargeAmountPence: number;
  tierName: string;
} {
  const safeDoors = Math.max(1, Math.min(100000, Math.floor(Number(doors) || 100)));
  let ratePerDoor = 4.50; // Starter: 1-100 doors
  let tierName = "Starter Housing Authority";

  if (safeDoors > 1000) {
    ratePerDoor = 2.50; // Enterprise: 1,001+ doors
    tierName = "Enterprise Housing Authority";
  } else if (safeDoors > 100) {
    ratePerDoor = 3.50; // Growth: 101-1,000 doors
    tierName = "Growth Housing Authority";
  }

  const monthlyTotal = safeDoors * ratePerDoor;
  const annualTotal = Math.round(monthlyTotal * 12 * 0.85); // 15% discount for annual billing

  const monthlyTotalPence = Math.round(monthlyTotal * 100);
  const annualTotalPence = Math.round(annualTotal * 100);

  const chargeAmountPence = billingCycle === "annual" ? annualTotalPence : monthlyTotalPence;

  return {
    doorsCount: safeDoors,
    ratePerDoor,
    monthlyTotalPence,
    annualTotalPence,
    chargeAmountPence,
    tierName,
  };
}

export interface AuthoritativeLineItemResult {
  lineItem: any;
  mode: "subscription" | "payment";
  metadata: Record<string, string>;
  isClientMoney: boolean;
  paymentIntentData?: {
    application_fee_amount: number;
    transfer_data: {
      destination: string;
    };
    metadata?: Record<string, string>;
  };
  authoritativeAmountPence: number;
}

/**
 * Loads dynamic platform configuration saved by platform admins in Firestore.
 * Caches briefly in memory per DB instance to avoid Firestore read amplification while staying responsive to admin updates.
 */
const firestoreConfigCache = new WeakMap<object, {
  globalTiers?: any;
  globalConfig?: any;
  lastFetched?: number;
}>();

export async function getDynamicFirestoreConfigs(firestoreDb: any): Promise<{
  globalTiers: any;
  globalConfig: any;
}> {
  if (!firestoreDb || typeof firestoreDb !== "object") {
    return { globalTiers: null, globalConfig: null };
  }

  const now = Date.now();
  const cached = firestoreConfigCache.get(firestoreDb);
  if (cached?.lastFetched && now - cached.lastFetched < 5000) {
    return {
      globalTiers: cached.globalTiers,
      globalConfig: cached.globalConfig,
    };
  }

  try {
    const [tiersDoc, globalDoc] = await Promise.all([
      firestoreDb.collection("platform_config").doc("global_tiers").get().catch(() => null),
      firestoreDb.collection("platform_config").doc("global").get().catch(() => null),
    ]);

    const globalTiers = tiersDoc?.exists ? (typeof tiersDoc.data === "function" ? tiersDoc.data() : tiersDoc.data) : null;
    const globalConfig = globalDoc?.exists ? (typeof globalDoc.data === "function" ? globalDoc.data() : globalDoc.data) : null;

    firestoreConfigCache.set(firestoreDb, { globalTiers, globalConfig, lastFetched: now });
    return { globalTiers, globalConfig };
  } catch {
    return { globalTiers: null, globalConfig: null };
  }
}

export function invalidateDynamicConfigCache(firestoreDb: any): void {
  if (firestoreDb && typeof firestoreDb === "object") {
    firestoreConfigCache.delete(firestoreDb);
  }
}

/**
 * Resolves the Admin-configured AnyTrader commission cap in GBP (0 = no cap).
 * Defaults to £250 when not explicitly configured in Firestore.
 */
export function resolveCommissionCapGbp(globalTiers?: any, globalConfig?: any): number {
  const rawCap =
    globalTiers?.providerModels?.one_off_trades?.commissionCapGbp ??
    globalTiers?.commissionCapGbp ??
    globalConfig?.commissionCapGbp;
  if (rawCap === undefined || rawCap === null || rawCap === "") {
    return DEFAULT_ANYTRADER_COMMISSION_CAP_GBP;
  }
  const parsed = Number(rawCap);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_ANYTRADER_COMMISSION_CAP_GBP;
  }
  return parsed;
}

/**
 * Pure deterministic capped commission calculation in minor units (pence).
 * A capGbp of 0 disables the cap (uncapped).
 */
export function calculateCappedCommissionPence(
  amountPence: number,
  commissionRate: number,
  capGbp: number = DEFAULT_ANYTRADER_COMMISSION_CAP_GBP
): { platformFeePence: number; netPayoutPence: number; capApplied: boolean } {
  const safeAmount = Math.max(0, Math.round(Number(amountPence) || 0));
  const safeRate = Math.max(0, Math.min(1, Number(commissionRate) || 0));
  const rawFee = Math.round(safeAmount * safeRate);
  const safeCapGbp = Number.isFinite(capGbp) && capGbp >= 0 ? capGbp : DEFAULT_ANYTRADER_COMMISSION_CAP_GBP;
  const capPence = safeCapGbp > 0 ? Math.round(safeCapGbp * 100) : null;
  const uncappedClamped = Math.min(rawFee, safeAmount);
  const platformFeePence =
    capPence !== null ? Math.min(uncappedClamped, capPence) : uncappedClamped;
  const capApplied = capPence !== null && uncappedClamped > capPence;
  const netPayoutPence = safeAmount - platformFeePence;
  return { platformFeePence, netPayoutPence, capApplied };
}

export interface ResolveAnyTraderCommissionInput {
  amountPence: number;
  firestoreDb?: any;
  traderId?: string | null;
  traderData?: Record<string, any> | null;
  traderTier?: string | null;
  globalTiers?: any;
  globalConfig?: any;
  explicitCommissionRate?: number;
  explicitCapGbp?: number;
}

export interface ResolvedAnyTraderCommission {
  normalizedTier: NormalizedTraderTier;
  commissionRate: number;
  commissionCapGbp: number;
  platformFeePence: number;
  netPayoutPence: number;
  capApplied: boolean;
}

/**
 * Single Canonical AnyTrader Commission Resolver.
 * Used across Stripe Checkout (pricingCatalog), Escrow Funding & Release (paymentLedger),
 * and Quote Creation/Revision (quoteCommands) so Admin Control Panel changes take effect
 * everywhere with zero drift.
 */
export async function resolveAnyTraderCommission(
  input: ResolveAnyTraderCommissionInput
): Promise<ResolvedAnyTraderCommission> {
  let { globalTiers, globalConfig, traderData } = input;

  if (input.firestoreDb && (globalTiers === undefined || globalConfig === undefined)) {
    const loaded = await getDynamicFirestoreConfigs(input.firestoreDb);
    if (globalTiers === undefined) globalTiers = loaded.globalTiers;
    if (globalConfig === undefined) globalConfig = loaded.globalConfig;
  }

  if (!traderData && !input.traderTier && input.firestoreDb && input.traderId) {
    try {
      const snap = await input.firestoreDb.collection("users").doc(input.traderId).get();
      if (snap?.exists) {
        traderData = typeof snap.data === "function" ? snap.data() : snap.data;
      }
    } catch {
      // Fall back gracefully to canonical PAYG tier if user profile lookup is unavailable
    }
  }

  const rawTier = input.traderTier || traderData?.tier || traderData?.tierId || "payg";
  const subscriptionStatus = String(traderData?.subscriptionStatus || "").trim().toLowerCase();
  const isTerminalInactiveTier =
    !input.traderTier &&
    ["canceled", "cancelled", "unpaid", "incomplete_expired", "free"].includes(subscriptionStatus);
  const normalizedTier = isTerminalInactiveTier ? "payg" : normalizeTraderTier(String(rawTier));

  let commissionRate = DEFAULT_ANYTRADER_COMMISSIONS[normalizedTier];

  if (
    typeof input.explicitCommissionRate === "number" &&
    Number.isFinite(input.explicitCommissionRate) &&
    input.explicitCommissionRate >= 0
  ) {
    commissionRate =
      input.explicitCommissionRate > 1
        ? input.explicitCommissionRate / 100
        : input.explicitCommissionRate;
  } else {
    const dynamicTierCommission =
      globalTiers?.providerModels?.one_off_trades?.tiers?.[normalizedTier]?.commission;
    if (
      typeof dynamicTierCommission === "number" &&
      Number.isFinite(dynamicTierCommission) &&
      dynamicTierCommission >= 0
    ) {
      commissionRate =
        dynamicTierCommission > 1 ? dynamicTierCommission / 100 : dynamicTierCommission;
    } else if (Array.isArray(globalConfig?.feeTiers)) {
      const matched = globalConfig.feeTiers.find(
        (ft: any) => normalizeTraderTier(ft?.name) === normalizedTier
      );
      if (
        matched &&
        typeof matched.commission === "number" &&
        Number.isFinite(matched.commission) &&
        matched.commission >= 0
      ) {
        // platform_config/global.feeTiers always stores percentage values (0..100)
        commissionRate = Math.round((matched.commission / 100) * 1000000) / 1000000;
      }
    }
  }

  const commissionCapGbp =
    typeof input.explicitCapGbp === "number" &&
    Number.isFinite(input.explicitCapGbp) &&
    input.explicitCapGbp >= 0
      ? input.explicitCapGbp
      : resolveCommissionCapGbp(globalTiers, globalConfig);

  const { platformFeePence, netPayoutPence, capApplied } = calculateCappedCommissionPence(
    input.amountPence,
    commissionRate,
    commissionCapGbp
  );

  return {
    normalizedTier,
    commissionRate,
    commissionCapGbp,
    platformFeePence,
    netPayoutPence,
    capApplied,
  };
}

/**
 * Resolves the server-authoritative line item and Stripe Connect routing
 * based strictly on validated server state. DISCARDS client-provided prices.
 */
async function loadAuthorizedCheckoutJob(firestoreDb: any, jobId: string, authUid: string, purpose: "boost" | "mediation_stake"): Promise<Record<string, any>> {
  if (!jobId || typeof jobId !== "string") throw new BadRequestError("A valid jobId is required for checkout");
  if (!firestoreDb) throw new BadRequestError("Database unavailable for job checkout authorization");
  const jobSnap = await firestoreDb.collection("jobs").doc(jobId).get();
  if (!jobSnap.exists) throw new NotFoundError("Job not found");
  const jobData = jobSnap.data() || {};
  const ownerId = jobData.homeownerId || jobData.userId || jobData.ownerId || jobData.posterId || jobData.customerId;
  const assignedTraderId = jobData.acceptedTradespersonId || jobData.acceptedTraderId || jobData.assignedTraderId || jobData.tradespersonId || jobData.traderId;
  if (purpose === "mediation_stake") {
    if (authUid !== ownerId && authUid !== assignedTraderId) throw new ForbiddenError("Only a job participant can pay the mediation stake");
    if (!isJobEligibleForMediationStake(jobData.status)) {
      throw new BadRequestError("Mediation stake can only be paid for an accepted, in-progress, completed, or disputed job");
    }
    if (jobData.mediationStakePaid === true || jobData.dispute?.mediationStakePaid === true) throw new BadRequestError("The mediation stake has already been paid for this job");
  } else {
    if (authUid !== ownerId) throw new ForbiddenError("Only the job owner can purchase a job boost");
    if (!["open", "quoted", "posted", "quoting", "in_bidding"].includes(String(jobData.status || ""))) throw new BadRequestError("Only active jobs can be boosted");
  }
  return jobData;
}
export async function resolveAuthoritativeLineItem(
  body: any,
  authUid: string,
  firestoreDb: any
): Promise<AuthoritativeLineItemResult> {
  const metadata = body.metadata || {};
  const hasExplicitMembershipPriceId =
    ["price_payg", "price_pro", "price_premium", "price_platinum", "price_landlord", "price_driver_gold"].includes(String(body.priceId || ""));

  // Load dynamic admin-managed configs from Firestore (falls back gracefully to SERVER_PRICING_CATALOG if unset)
  const { globalTiers, globalConfig } = await getDynamicFirestoreConfigs(firestoreDb);

  // =========================================================================
  // 1. CLIENT MONEY: Tradesperson Milestone Escrow Funding
  // =========================================================================
  if (metadata.type === "milestone_funding" && !hasExplicitMembershipPriceId) {
    const { jobId, quoteId, milestoneId } = metadata;
    if (!jobId || !quoteId || !milestoneId) {
      throw new BadRequestError("Milestone funding requires jobId, quoteId, and milestoneId in metadata");
    }

    if (!firestoreDb) {
      throw new BadRequestError("Database unavailable for milestone verification");
    }

    const jobDoc = await firestoreDb.collection("jobs").doc(jobId).get();
    if (!jobDoc.exists) throw new NotFoundError(`Job '${jobId}' not found`);
    const jobData = jobDoc.data();

    // Verify caller is the job owner/homeowner
    const isOwner = jobData?.homeownerId === authUid || jobData?.userId === authUid;
    if (!isOwner) {
      throw new ForbiddenError("Only the job owner can fund milestone escrow payments");
    }

    const quoteRef = firestoreDb.collection("jobs").doc(jobId).collection("quotes").doc(quoteId);
    const quoteDoc = await quoteRef.get();
    if (!quoteDoc.exists) throw new NotFoundError(`Quote '${quoteId}' not found`);
    const quoteData = quoteDoc.data();

    const milestones = quoteData?.milestones || [];
    const targetMilestone = milestones.find((m: any) => m.id === milestoneId);
    if (!targetMilestone) {
      throw new NotFoundError(`Milestone '${milestoneId}' not found in quote`);
    }

    // State machine check: cannot fund an already funded, released, or cancelled milestone
    const currentStatus = targetMilestone.status || "pending";
    if (currentStatus !== "pending") {
      throw new BadRequestError(`Cannot fund milestone in status '${currentStatus}'. Must be 'pending'.`);
    }

    // Authoritative milestone price from DB (DISCARD client amount)
    const rawMilestoneAmount = Number(targetMilestone.amount || targetMilestone.verifiedAmount);
    if (isNaN(rawMilestoneAmount) || rawMilestoneAmount <= 0) {
      throw new BadRequestError("Milestone has invalid or non-positive amount in database");
    }
    const milestoneAmountPence = Math.round(rawMilestoneAmount * 100);

    // Fetch tradesperson's connected Stripe account
    const traderId = quoteData.tradespersonId;
    if (!traderId || typeof traderId !== "string" || !traderId.trim()) {
      throw new BadRequestError("Quote does not have an assigned tradesperson ID");
    }

    // Defense-in-depth self-payment rejection (payerUid !== payeeUid):
    // Prevents dual-role homeowner/tradesperson accounts from funding milestone escrow to themselves.
    const normalizedPayeeUid = traderId.trim();
    const normalizedPayerUid = String(authUid || "").trim();
    const jobOwnerUids = [jobData?.homeownerId, jobData?.userId, jobData?.customerId]
      .filter((value): value is string => typeof value === "string" && value.trim() !== "")
      .map((value) => value.trim());

    if (normalizedPayerUid === normalizedPayeeUid || jobOwnerUids.includes(normalizedPayeeUid)) {
      throw new ForbiddenError(
        "Self-payment is prohibited: you cannot fund a milestone payment to your own tradesperson account."
      );
    }

    const traderDoc = await firestoreDb.collection("users").doc(traderId).get();
    const traderData = traderDoc.data() || {};
    const traderStripeAccountId = traderData.stripeAccountId;

    // Platform constraint check: Client money MUST flow directly to the tradesperson's Stripe Connect account
    // Platform only receives the commission via application_fee_amount
    const isDevMock = process.env.NODE_ENV !== "production" && process.env.ALLOW_MOCK_PAYMENTS === "true";
    const destinationAccount = traderStripeAccountId || (isDevMock ? `acct_mock_${traderId}` : null);

    if (!destinationAccount && !isDevMock) {
      throw new BadRequestError(
        "Tradesperson has not connected their Stripe account to receive milestone escrow payments. Work with tradesperson to complete Stripe onboarding."
      );
    }

    // Platform commission calculation via canonical AnyTrader resolver
    // Honors Admin-configured rates in platform_config/global_tiers & platform_config/global
    // (Defaults: PAYG 5%, Pro 3.5%, Gold 2.5%, Platinum 1.5%, capped at £250 or Admin cap)
    const resolvedCommission = await resolveAnyTraderCommission({
      amountPence: milestoneAmountPence,
      traderData,
      globalTiers,
      globalConfig,
    });
    const {
      commissionRate,
      commissionCapGbp,
      platformFeePence,
      netPayoutPence,
    } = resolvedCommission;

    return {
      mode: "payment",
      isClientMoney: true,
      authoritativeAmountPence: milestoneAmountPence,
      lineItem: {
        price_data: {
          currency: "gbp",
          unit_amount: milestoneAmountPence,
          product_data: {
            name: `Milestone: ${targetMilestone.title || "Project Stage"}`,
            description: `Escrow stage payment for Job #${jobData.jobNo || jobId}. Net funds routed directly to tradesperson via Stripe Connect.`,
          },
        },
        quantity: 1,
      },
      paymentIntentData: destinationAccount
        ? {
            application_fee_amount: platformFeePence,
            transfer_data: {
              destination: destinationAccount,
            },
            metadata: {
              jobId,
              quoteId,
              milestoneId,
              traderId,
              type: "milestone_funding",
              platformFeePence: platformFeePence.toString(),
              netPayoutPence: netPayoutPence.toString(),
              appliedCommissionRate: commissionRate.toString(),
              commissionCapGbp: commissionCapGbp.toString(),
            },
          }
        : undefined,
      metadata: {
        type: "milestone_funding",
        jobId,
        quoteId,
        milestoneId,
        traderId,
        milestoneAmountPence: milestoneAmountPence.toString(),
        platformFeePence: platformFeePence.toString(),
        netPayoutPence: netPayoutPence.toString(),
        appliedCommissionRate: commissionRate.toString(),
        commissionCapGbp: commissionCapGbp.toString(),
        userId: authUid,
      },
    };
  }

  // =========================================================================
  // 2. B2B SaaS METERED BILLING ("Gotham" Housing Portal)
  // =========================================================================
  if (
    !hasExplicitMembershipPriceId &&
    (
      body.priceId === "price_gotham_saas" ||
      metadata.type === "gotham_saas" ||
      metadata.subscriptionType === "gotham_saas" ||
      (typeof body.tierName === "string" && body.tierName.toLowerCase().includes("gotham"))
    )
  ) {
    const doors = Number(metadata.gothamDoorsCount || body.doorsCount || 100);
    const cycle = (metadata.gothamBillingCycle || "monthly") as "monthly" | "annual";
    const gothamPlan = calculateGothamSaaSPlanServer(doors, cycle);

    return {
      mode: "subscription",
      isClientMoney: false,
      authoritativeAmountPence: gothamPlan.chargeAmountPence,
      lineItem: {
        price_data: {
          currency: "gbp",
          unit_amount: gothamPlan.chargeAmountPence,
          recurring: { interval: cycle === "annual" ? "year" : "month" },
          product_data: {
            name: `${gothamPlan.tierName} (${gothamPlan.doorsCount} Doors)`,
            description: `TradeOS Gotham B2B SaaS Layer (£${gothamPlan.ratePerDoor.toFixed(2)}/door/mo). 1-tap contractor dispatch, compliance automation & digital twin management.`,
          },
        },
        quantity: 1,
      },
      metadata: {
        type: "gotham_saas",
        subscriptionType: "gotham_saas",
        gothamDoorsCount: gothamPlan.doorsCount.toString(),
        gothamTierName: gothamPlan.tierName,
        gothamBillingCycle: cycle,
        ratePerDoor: gothamPlan.ratePerDoor.toString(),
        chargeAmountPence: gothamPlan.chargeAmountPence.toString(),
        userId: authUid,
      },
    };
  }

  // =========================================================================
  // 3. AD WALLET TOPUP & BANNER AD CHECKOUT (£2.00/day canonical rate)
  // =========================================================================
  if ((metadata.type === "banner_ad" || metadata.type === "banner_promo") && !hasExplicitMembershipPriceId) {
    const safeDays = sanitizeBannerDurationDays(metadata.durationDays || body.durationDays);
    const bannerCostPence = calculateBannerAdCostPence(safeDays);
    return {
      mode: "payment",
      isClientMoney: false,
      authoritativeAmountPence: bannerCostPence,
      lineItem: {
        price_data: {
          currency: "gbp",
          unit_amount: bannerCostPence,
          product_data: {
            name: `Banner Promotion (${safeDays} days)`,
            description: `Flat £${BANNER_AD_DAILY_RATE_GBP.toFixed(2)}/day homepage & dashboard banner promotion (subject to moderation approval).`,
          },
        },
        quantity: 1,
      },
      metadata: {
        type: "banner_ad",
        durationDays: String(safeDays),
        dailyRate: BANNER_AD_DAILY_RATE_GBP.toFixed(2),
        totalPence: String(bannerCostPence),
        userId: authUid,
      },
    };
  }

  if ((body.priceId === "price_ad_wallet_topup" || metadata.type === "ad_wallet_topup") && !hasExplicitMembershipPriceId) {
    const sanitizedPounds = Math.round(sanitizeAdWalletTopupGbp(metadata.topupAmount || 25));
    const topupPence = sanitizedPounds * 100;

    return {
      mode: "payment",
      isClientMoney: false,
      authoritativeAmountPence: topupPence,
      lineItem: {
        price_data: {
          currency: "gbp",
          unit_amount: topupPence,
          product_data: {
            name: "Trades Ad Studio Wallet Top-up",
            description: `Pre-paid advertising credit for TradeOS Search & Category Banners (£${sanitizedPounds}.00 balance credit).`,
          },
        },
        quantity: 1,
      },
      metadata: {
        type: "ad_wallet_topup",
        topupAmount: sanitizedPounds.toString(),
        topupPence: topupPence.toString(),
        userId: authUid,
      },
    };
  }

  // =========================================================================
  // 4. DISPUTE MEDIATION STAKE (£25.00)
  // =========================================================================
  if (body.priceId === "price_dispute_stake" || (metadata.type === "mediation_stake" && !hasExplicitMembershipPriceId)) {
    await loadAuthorizedCheckoutJob(firestoreDb, String(metadata.jobId || ""), authUid, "mediation_stake");
    const catalogItem = SERVER_PRICING_CATALOG.price_dispute_stake;
    const dynamicStake = Number(globalConfig?.paidAddons?.milestoneEscrow?.homeownerMediationStake);
    const resolvedAmountPence = (!isNaN(dynamicStake) && dynamicStake > 0)
      ? Math.round(dynamicStake * 100)
      : catalogItem.amountPence;

    return {
      mode: "payment",
      isClientMoney: false,
      authoritativeAmountPence: resolvedAmountPence,
      lineItem: {
        price_data: {
          currency: "gbp",
          unit_amount: resolvedAmountPence,
          product_data: {
            name: catalogItem.name,
            description: catalogItem.description,
          },
        },
        quantity: 1,
      },
      metadata: {
        type: "mediation_stake",
        jobId: metadata.jobId || "",
        disputeReason: metadata.disputeReason || "Unspecified",
        technicalFaultReport: metadata.technicalFaultReport || "Unspecified",
        userId: authUid,
      },
    };
  }

  // =========================================================================
  // 5. PRIORITY BOOSTS (Emergency £5.00, Instant Match £2.99)
  // =========================================================================
  if (
    ["price_emergency_boost", "price_instant_match", "price_mock_boost", "price_mock_instant_match"].includes(String(body.priceId || "")) ||
    (!hasExplicitMembershipPriceId && (metadata.type === "boost" || metadata.tier === "emergency_boost" || metadata.tier === "instant_match"))
  ) {
    await loadAuthorizedCheckoutJob(firestoreDb, String(metadata.jobId || ""), authUid, "boost");
    const isInstantMatch =
      metadata.tier === "instant_match" ||
      body.priceId === "price_instant_match" ||
      body.priceId === "price_mock_instant_match";
    const catalogItem = isInstantMatch
      ? SERVER_PRICING_CATALOG.price_instant_match
      : SERVER_PRICING_CATALOG.price_emergency_boost;

    const dynamicPrice = isInstantMatch
      ? Number(globalConfig?.paidAddons?.instantMatch?.price || globalConfig?.instantMatchFee)
      : Number(globalConfig?.paidAddons?.emergencyBoost?.price || globalConfig?.emergencyBoostFee);

    const resolvedAmountPence = (!isNaN(dynamicPrice) && dynamicPrice > 0)
      ? Math.round(dynamicPrice * 100)
      : catalogItem.amountPence;

    return {
      mode: "payment",
      isClientMoney: false,
      authoritativeAmountPence: resolvedAmountPence,
      lineItem: {
        price_data: {
          currency: "gbp",
          unit_amount: resolvedAmountPence,
          product_data: {
            name: catalogItem.name,
            description: catalogItem.description,
          },
        },
        quantity: 1,
      },
      metadata: {
        type: "boost",
        tier: isInstantMatch ? "instant_match" : "emergency_boost",
        jobId: metadata.jobId || "",
        userId: authUid,
      },
    };
  }

  // =========================================================================
  // 6. ADD-ONS: Exclusive Leads (£29/mo), Verified Video Pro (£15/mo or £144/yr), Appointments (£9.99/mo)
  // =========================================================================
  if (
    body.priceId === "price_exclusive_leads" ||
    body.priceId === "price_mock_exclusive_addon" ||
    (!hasExplicitMembershipPriceId && (metadata.isExclusiveAddon === "true" || metadata.type === "exclusive_leads"))
  ) {
    const catalogItem = SERVER_PRICING_CATALOG.price_exclusive_leads;
    const dynamicPrice = Number(globalConfig?.paidAddons?.exclusiveLeads?.price || globalConfig?.exclusiveLeadsFee);
    const resolvedAmountPence = (!isNaN(dynamicPrice) && dynamicPrice > 0)
      ? Math.round(dynamicPrice * 100)
      : catalogItem.amountPence;

    return {
      mode: "subscription",
      isClientMoney: false,
      authoritativeAmountPence: resolvedAmountPence,
      lineItem: {
        price_data: {
          currency: "gbp",
          unit_amount: resolvedAmountPence,
          recurring: { interval: "month" },
          product_data: {
            name: catalogItem.name,
            description: catalogItem.description,
          },
        },
        quantity: 1,
      },
      metadata: {
        isExclusiveAddon: "true",
        type: "exclusive_leads",
        userId: authUid,
      },
    };
  }

  if (
    body.priceId === "price_video_pro" ||
    body.priceId === "price_video_pro_annual" ||
    (!hasExplicitMembershipPriceId && (metadata.isVideoPro === "true" || metadata.type === "video_pro_subscription"))
  ) {
    const isAnnual = metadata.billingCycle === "annual" || body.priceId === "price_video_pro_annual";
    const catalogItem = isAnnual
      ? SERVER_PRICING_CATALOG.price_video_pro_annual
      : SERVER_PRICING_CATALOG.price_video_pro;

    const dynamicMonthly = Number(globalConfig?.paidAddons?.verifiedVideoPro?.monthlyPrice);
    const dynamicAnnual = Number(globalConfig?.paidAddons?.verifiedVideoPro?.annualPrice);
    const dynamicPrice = isAnnual ? dynamicAnnual : dynamicMonthly;
    const resolvedAmountPence = (!isNaN(dynamicPrice) && dynamicPrice > 0)
      ? Math.round(dynamicPrice * 100)
      : catalogItem.amountPence;

    return {
      mode: "subscription",
      isClientMoney: false,
      authoritativeAmountPence: resolvedAmountPence,
      lineItem: {
        price_data: {
          currency: "gbp",
          unit_amount: resolvedAmountPence,
          recurring: { interval: isAnnual ? "year" : "month" },
          product_data: {
            name: catalogItem.name,
            description: catalogItem.description,
          },
        },
        quantity: 1,
      },
      metadata: {
        isVideoPro: "true",
        type: "video_pro_subscription",
        billingCycle: isAnnual ? "annual" : "monthly",
        userId: authUid,
      },
    };
  }

  if (
    body.priceId === "price_appointments" ||
    (!hasExplicitMembershipPriceId && (metadata.type === "appointments" || metadata.subscriptionType === "appointments"))
  ) {
    const catalogItem = SERVER_PRICING_CATALOG.price_appointments;
    const dynamicPrice = Number(globalConfig?.paidAddons?.appointments?.price);
    const resolvedAmountPence = (!isNaN(dynamicPrice) && dynamicPrice > 0)
      ? Math.round(dynamicPrice * 100)
      : catalogItem.amountPence;

    return {
      mode: "subscription",
      isClientMoney: false,
      authoritativeAmountPence: resolvedAmountPence,
      lineItem: {
        price_data: {
          currency: "gbp",
          unit_amount: resolvedAmountPence,
          recurring: { interval: "month" },
          product_data: {
            name: catalogItem.name,
            description: catalogItem.description,
          },
        },
        quantity: 1,
      },
      metadata: {
        type: "appointments",
        subscriptionType: "appointments",
        userId: authUid,
      },
    };
  }

  // =========================================================================
  // 7. MEMBERSHIP TIERS (Landlord Pro, Driver Gold, Trader Pro/Premium/Platinum)
  // =========================================================================
  const rawTier = (body.priceId || body.tierName || metadata.tierName || metadata.tier || "").toString().trim();
  const lowerTier = rawTier.toLowerCase();

  let matchedCatalogKey = "";
  let canonicalTier = "";

  if (
    lowerTier.includes("landlord") || body.priceId === "price_landlord" || metadata.subscriptionType === "landlord" || metadata.tier === "landlord"
  ) {
    matchedCatalogKey = "price_landlord";
    canonicalTier = "landlord";
  } else if (
    lowerTier.includes("gold driver") || body.priceId === "price_driver_gold" || metadata.subscriptionType === "driver_gold" || metadata.type === "driver_gold"
  ) {
    matchedCatalogKey = "price_driver_gold";
    canonicalTier = "driver_gold";
  } else if (lowerTier.includes("platinum") || lowerTier.includes("enterprise powerhouse") || body.priceId === "price_platinum") {
    matchedCatalogKey = "price_platinum";
    canonicalTier = "platinum";
  } else if (lowerTier.includes("gold") || lowerTier.includes("elite") || lowerTier.includes("premium") || body.priceId === "price_premium") {
    matchedCatalogKey = "price_premium";
    canonicalTier = "premium";
  } else if (lowerTier.includes("silver") || lowerTier.includes("pro") || lowerTier.includes("professional") || lowerTier.includes("founding") || body.priceId === "price_pro") {
    matchedCatalogKey = "price_pro";
    canonicalTier = "pro";
  } else if (lowerTier.includes("payg") || lowerTier.includes("free") || body.priceId === "price_payg") {
    matchedCatalogKey = "price_payg";
    canonicalTier = "payg";
  }

  const catalogItem = matchedCatalogKey ? SERVER_PRICING_CATALOG[matchedCatalogKey] : undefined;
  if (!catalogItem) {
    throw new BadRequestError(`Unrecognized pricing tier or product identifier: '${rawTier || "empty"}'`);
  }

  if (canonicalTier === "payg") {
    throw new BadRequestError("Free Explorer does not require payment checkout. Please use /api/select-free-tier.");
  }

  // Check Firestore admin tier pricing overrides
  let dynamicTierPrice = NaN;
  if (canonicalTier === "landlord") {
    dynamicTierPrice = Number(globalTiers?.providerModels?.homeowners?.tiers?.landlord?.price);
  } else if (canonicalTier === "driver_gold") {
    dynamicTierPrice = Number(globalTiers?.providerModels?.on_demand_transport?.tiers?.gold?.price);
  } else if (canonicalTier === "pro" || canonicalTier === "premium" || canonicalTier === "platinum") {
    dynamicTierPrice = Number(
      globalTiers?.providerModels?.one_off_trades?.tiers?.[canonicalTier]?.price ??
      globalConfig?.feeTiers?.find((t: any) => normalizeTraderTier(t.name) === canonicalTier)?.price
    );
  }

  let resolvedAmountPence = (!isNaN(dynamicTierPrice) && dynamicTierPrice >= 0)
    ? Math.round(dynamicTierPrice * 100)
    : catalogItem.amountPence;

  // Authoritatively apply Founding PRO lifetime rate (£9.99/mo) for verified Founding Members
  let resolvedDisplayName = catalogItem.name;
  let isFoundingProApplied = false;
  if (canonicalTier === "pro" && firestoreDb && authUid) {
    try {
      const callerSnap = await firestoreDb.collection("users").doc(authUid).get();
      const callerData = callerSnap?.exists
        ? (typeof callerSnap.data === "function" ? callerSnap.data() : callerSnap.data)
        : null;
      if (callerData?.isFoundingMember === true) {
        const foundingProPence = 999; // £9.99/mo lifetime founding discount
        resolvedAmountPence = Math.min(resolvedAmountPence, foundingProPence);
        resolvedDisplayName = "Founding PRO";
        isFoundingProApplied = true;
      }
    } catch {
      // Non-fatal fallback to standard Silver Pro rate
    }
  }

  return {
    mode: "subscription",
    isClientMoney: false,
    authoritativeAmountPence: resolvedAmountPence,
    lineItem: {
      price_data: {
        currency: "gbp",
        unit_amount: resolvedAmountPence,
        recurring: { interval: "month" },
        product_data: {
          name: resolvedDisplayName,
          description: isFoundingProApplied
            ? "Exclusive Founding Member lifetime rate for Silver Pro membership"
            : (catalogItem.description || `Platform subscription tier: ${catalogItem.name}`),
        },
      },
      quantity: 1,
    },
    metadata: {
      tierName: resolvedDisplayName,
      tier: canonicalTier,
      subscriptionType: canonicalTier === "landlord" ? "landlord" : canonicalTier === "driver_gold" ? "driver_gold" : "tier",
      ...(isFoundingProApplied ? { isFoundingPro: "true" } : {}),
      userId: authUid,
    },
  };
}
