/**
 * SERVER-AUTHORITATIVE ADVERTISING ENGINE
 * Handles banner creation (pending_review + server badge derivation),
 * campaign top-ups (preserving explicit paused states),
 * pause/resume gating, and transactional CPC click/impression billing.
 *
 * Remediates: AT-ADS-01, AT-ADS-02, AT-ADS-03, AT-ADS-04
 */

import * as admin from "firebase-admin";
import { BadRequestError, ForbiddenError, NotFoundError } from "./httpErrors.ts";
import {
  BANNER_AD_DAILY_RATE_GBP,
  calculateBannerAdCostGbp,
  MAX_CPC_RATE_GBP,
  MIN_AD_WALLET_TOPUP_GBP,
  MAX_AD_WALLET_TOPUP_GBP,
  MIN_CPC_RATE_GBP,
  resolveCpcRateForTier,
  sanitizeBannerDurationDays,
} from "../lib/adPricing.ts";
import { isAdEligibleForPublicProjection, sanitizeAdToPublicAd } from "./projectionSync.ts";

const recentAdEventsCache = new Map<string, number>();
const AD_EVENT_DEDUP_WINDOW_MS = 10_000;

function syncPublicAdInTransaction(tx: any, db: any, adId: string, mergedAdData: Record<string, any>): void {
  const publicRef = db.collection("public_ads").doc(adId);
  if (isAdEligibleForPublicProjection(mergedAdData)) {
    tx.set(publicRef, sanitizeAdToPublicAd(adId, mergedAdData), { merge: true });
  } else if (typeof tx.delete === "function") {
    tx.delete(publicRef);
  }
}

export function clearAdEventDedupCacheForTests(): void {
  recentAdEventsCache.clear();
}

function serverTimestampOrNow(): any {
  try {
    return admin.firestore.FieldValue.serverTimestamp();
  } catch {
    return new Date().toISOString();
  }
}

function incrementOrDelta(delta: number): any {
  try {
    return admin.firestore.FieldValue.increment(delta);
  } catch {
    return delta;
  }
}

function isFirestoreIncrement(val: any): boolean {
  return val && typeof val === "object" && (val.constructor?.name === "NumericIncrementTransform" || typeof val.operand === "number");
}

function parseTimestampMs(raw: any): number | null {
  if (!raw) return null;
  if (typeof raw?.toMillis === "function") return raw.toMillis();
  if (typeof raw?.seconds === "number") return raw.seconds * 1000;
  const ms = Date.parse(String(raw));
  return Number.isFinite(ms) ? ms : null;
}

export function isAuthoritativelyVerifiedAdvertiser(userData: Record<string, any> = {}): boolean {
  const verificationStatus = String(userData.verificationStatus || "").toLowerCase();
  const blockedVerificationStatuses = ["rejected", "revoked", "suspended", "expired", "unverified", "pending"];
  if (blockedVerificationStatuses.includes(verificationStatus)) {
    return false;
  }
  if (userData.isSuspended === true || userData.isFrozen === true || userData.banned === true) {
    return false;
  }
  return userData.isVerified === true || verificationStatus === "verified";
}

export interface CreateBannerAdInput {
  db: any;
  authUid: string;
  headline?: unknown;
  durationDays?: unknown;
  targetCategories?: unknown;
  now?: Date;
}

export interface CreateBannerAdResult {
  success: true;
  adId: string;
  dailyRate: number;
  durationDays: number;
  totalCost: number;
  status: "pending_review";
  approvalStatus: "pending_review";
  isActive: false;
  isVerifiedBadgeApplied: boolean;
}

/**
 * AT-ADS-02 & AT-ADS-04:
 * Creates a banner promotion at canonical £2.00/day in pending_review moderation state,
 * deducting funds atomically and stripping self-asserted verification badges.
 */
export async function createBannerAdCommand({
  db,
  authUid,
  headline,
  durationDays,
  targetCategories,
  now = new Date(),
}: CreateBannerAdInput): Promise<CreateBannerAdResult> {
  if (!db) throw new BadRequestError("Database service unavailable");
  if (!authUid) throw new ForbiddenError("Authentication required");

  const days = sanitizeBannerDurationDays(durationDays);
  const dailyRate = BANNER_AD_DAILY_RATE_GBP;
  const totalCost = calculateBannerAdCostGbp(days);

  const userRef = db.collection("users").doc(authUid);
  const newAdRef = db.collection("advertisements").doc();
  const createdAdId = newAdRef.id;
  let isVerifiedBadgeApplied = false;

  await db.runTransaction(async (transaction: any) => {
    const userDoc = await transaction.get(userRef);
    if (!userDoc.exists) {
      throw new NotFoundError("User profile not found");
    }
    const userData = userDoc.data() || {};
    if (userData.isSuspended === true || userData.isFrozen === true || userData.banned === true) {
      throw new ForbiddenError("Suspended or frozen accounts cannot launch promotional campaigns.");
    }

    const currentWallet = Number(userData.adWalletBalance || 0);
    if (currentWallet < totalCost) {
      throw new BadRequestError(
        `Insufficient ad wallet balance (£${currentWallet.toFixed(2)}). Total cost is £${totalCost.toFixed(2)}. Please top up your wallet.`
      );
    }

    const nextWalletBalance = Number((currentWallet - totalCost).toFixed(2));
    const nextAdSpendTotal = Number((Number(userData.adSpendTotal || 0) + totalCost).toFixed(2));

    transaction.update(userRef, {
      adWalletBalance: nextWalletBalance,
      adSpendTotal: nextAdSpendTotal,
      updatedAt: serverTimestampOrNow(),
    });

    const endDate = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
    isVerifiedBadgeApplied = isAuthoritativelyVerifiedAdvertiser(userData);

    const businessTitle =
      String(userData.businessName || userData.name || "").trim() ||
      (isVerifiedBadgeApplied ? "Verified Trade Specialist" : "Local Trade Specialist");
    const cleanHeadline =
      typeof headline === "string" && headline.trim().length > 0
        ? headline.trim().slice(0, 100)
        : String(userData.trade || "Local Trade Services").slice(0, 100);

    const normalizedCategories = Array.isArray(targetCategories)
      ? targetCategories.filter((c): c is string => typeof c === "string" && c.trim().length > 0).slice(0, 10)
      : [String(userData.trade || "all"), "all"];

    const badgeLabel = isVerifiedBadgeApplied ? "FEATURED PRO" : "SPONSORED";
    const perkText = isVerifiedBadgeApplied
      ? userData.isAvailableForEmergency
        ? "⚡ 24/7 Response Guaranteed"
        : "⭐ Verified Pro"
      : `${userData.trade || "Trade"} Promotion`;

    transaction.set(newAdRef, {
      type: "trader_promo",
      title: businessTitle,
      description: cleanHeadline,
      bgColor: "bg-slate-900",
      iconName: "Star",
      url: `/profile/${authUid}`,
      targetRole: "homeowner",
      targetCategories: normalizedCategories.length > 0 ? normalizedCategories : ["all"],
      advertiserId: authUid,
      advertiserUid: authUid,
      advertiserName: businessTitle,
      imageUrl: String(userData.avatarUrl || ""),
      isTraderAd: true,
      isVerifiedAdvertiser: isVerifiedBadgeApplied,
      badgeLabel,
      perkText,
      dailyRate,
      durationDays: days,
      totalCost,
      totalBudget: totalCost,
      billingCycle: "fixed_banner",
      isActive: false,
      status: "pending_review",
      approvalStatus: "pending_review",
      clicks: 0,
      bannerClicks: 0,
      searchFeedClicks: 0,
      impressions: 0,
      dailyClicks: 0,
      dailyImpressions: 0,
      dailySpend: 0,
      totalSpend: 0,
      dailyResetDate: now.toISOString().slice(0, 10),
      startDate: now.toISOString(),
      endDate: endDate.toISOString(),
      createdAt: serverTimestampOrNow(),
      updatedAt: serverTimestampOrNow(),
    });
  });

  return {
    success: true,
    adId: createdAdId,
    dailyRate,
    durationDays: days,
    totalCost,
    status: "pending_review",
    approvalStatus: "pending_review",
    isActive: false,
    isVerifiedBadgeApplied,
  };
}

export interface TopUpAdCampaignInput {
  db: any;
  authUid: string;
  adId: string;
  amount: unknown;
  resumeAfterTopup?: boolean;
}

export interface TopUpAdCampaignResult {
  success: true;
  adId: string;
  topupAmount: number;
  prepaidBalance: number;
  isActive: boolean;
  status: string;
}

/**
 * AT-ADS-03:
 * Credits ad campaign prepaidBalance from advertiser adWalletBalance atomically.
 * Never overrides explicitly paused or unapproved campaigns unless resumeAfterTopup === true
 * AND the campaign is approved and has positive balance.
 */
export async function topUpAdCampaignCommand({
  db,
  authUid,
  adId,
  amount,
  resumeAfterTopup = false,
}: TopUpAdCampaignInput): Promise<TopUpAdCampaignResult> {
  if (!db) throw new BadRequestError("Database service unavailable");
  if (!authUid) throw new ForbiddenError("Authentication required");
  if (!adId) throw new BadRequestError("Advertisement ID is required");

  const parsedAmount = Number(amount);
  const topupAmount = Math.max(
    MIN_AD_WALLET_TOPUP_GBP,
    Math.min(MAX_AD_WALLET_TOPUP_GBP, Number.isFinite(parsedAmount) && parsedAmount > 0 ? parsedAmount : 50)
  );

  const adRef = db.collection("advertisements").doc(adId);
  const userRef = db.collection("users").doc(authUid);

  let finalBalance = 0;
  let finalIsActive = false;
  let finalStatus = "paused";

  await db.runTransaction(async (transaction: any) => {
    const adDoc = await transaction.get(adRef);
    if (!adDoc.exists) {
      throw new NotFoundError("Advertisement not found");
    }
    const adData = adDoc.data() || {};
    if (adData.advertiserUid !== authUid && adData.advertiserId !== authUid) {
      throw new ForbiddenError("Unauthorized: You do not own this advertisement");
    }

    const userDoc = await transaction.get(userRef);
    if (!userDoc.exists) {
      throw new NotFoundError("User profile not found");
    }
    const userData = userDoc.data() || {};
    const currentWallet = Number(userData.adWalletBalance || 0);

    if (currentWallet < topupAmount) {
      throw new BadRequestError(
        `Insufficient wallet balance (£${currentWallet.toFixed(2)}). Please top up your ad wallet first.`
      );
    }

    const nextWalletBalance = Number((currentWallet - topupAmount).toFixed(2));
    finalBalance = Number((Number(adData.prepaidBalance || 0) + topupAmount).toFixed(2));
    const nextTotalBudget = Number((Number(adData.totalBudget || 0) + topupAmount).toFixed(2));

    const isApproved = adData.approvalStatus === "approved";
    const isExpired = (() => {
      const endMs = parseTimestampMs(adData.endDate);
      return endMs !== null && endMs <= Date.now();
    })();
    const wasExplicitlyPaused =
      adData.status === "paused" || adData.pausedByAdvertiser === true || adData.isActive === false;

    if (isApproved && !isExpired && resumeAfterTopup === true && finalBalance > 0) {
      finalIsActive = true;
      finalStatus = "active";
    } else if (isApproved && !isExpired && adData.isActive === true && !wasExplicitlyPaused) {
      finalIsActive = true;
      finalStatus = "active";
    } else {
      finalIsActive = false;
      finalStatus = !isApproved
        ? String(adData.status || adData.approvalStatus || "pending_review")
        : isExpired
        ? "expired"
        : "paused";
    }

    transaction.update(userRef, {
      adWalletBalance: nextWalletBalance,
      updatedAt: serverTimestampOrNow(),
    });

    const adUpdate: Record<string, any> = {
      prepaidBalance: finalBalance,
      totalBudget: nextTotalBudget,
      isActive: finalIsActive,
      status: finalStatus,
      updatedAt: serverTimestampOrNow(),
    };
    if (finalIsActive) {
      adUpdate.pausedByAdvertiser = false;
      adUpdate.pauseReason = null;
    }

    transaction.update(adRef, adUpdate);
    syncPublicAdInTransaction(transaction, db, adId, { ...adData, ...adUpdate });
  });

  return {
    success: true,
    adId,
    topupAmount,
    prepaidBalance: finalBalance,
    isActive: finalIsActive,
    status: finalStatus,
  };
}

export interface ToggleAdActiveInput {
  db: any;
  authUid: string;
  isAdminUser?: boolean;
  adId: string;
}

export interface ToggleAdActiveResult {
  success: true;
  adId: string;
  isActive: boolean;
  status: string;
}

/**
 * Toggle advertisement active/paused state with strict approval & balance verification.
 */
export async function toggleAdActiveCommand({
  db,
  authUid,
  isAdminUser = false,
  adId,
}: ToggleAdActiveInput): Promise<ToggleAdActiveResult> {
  if (!db) throw new BadRequestError("Database service unavailable");
  if (!authUid) throw new ForbiddenError("Authentication required");
  if (!adId) throw new BadRequestError("Advertisement ID is required");

  const adRef = db.collection("advertisements").doc(adId);
  let nextActive = false;
  let nextStatus = "paused";

  await db.runTransaction(async (tx: any) => {
    const adDoc = await tx.get(adRef);
    if (!adDoc.exists) {
      throw new NotFoundError("Advertisement not found");
    }

    const adData = adDoc.data() || {};
    const isOwner = adData.advertiserUid === authUid || adData.advertiserId === authUid;
    if (!isOwner && !isAdminUser) {
      throw new ForbiddenError("Unauthorized: You do not own this advertisement");
    }

    nextActive = !adData.isActive;
    if (nextActive && !isAdminUser) {
      if (adData.approvalStatus !== "approved") {
        throw new BadRequestError("Cannot activate an unapproved campaign");
      }
      const endMs = parseTimestampMs(adData.endDate);
      if (endMs !== null && endMs <= Date.now()) {
        throw new BadRequestError("Cannot activate an expired campaign");
      }
      if (adData.billingCycle === "prepaid" && Number(adData.prepaidBalance || 0) <= 0) {
        throw new BadRequestError("Cannot activate campaign with zero prepaid balance. Please top up first.");
      }
    }

    nextStatus = nextActive ? "active" : "paused";
    const toggleUpdate = {
      isActive: nextActive,
      status: nextStatus,
      pausedByAdvertiser: !nextActive,
      pauseReason: nextActive ? null : "paused_by_advertiser",
      updatedAt: serverTimestampOrNow(),
    };
    tx.update(adRef, toggleUpdate);
    syncPublicAdInTransaction(tx, db, adId, { ...adData, ...toggleUpdate });
  });

  return {
    success: true,
    adId,
    isActive: nextActive,
    status: nextStatus,
  };
}

export interface ModerateAdInput {
  db: any;
  adminUid: string;
  adId: string;
  decision: "approve" | "reject";
  reason?: string;
}

export async function moderateAdCommand({
  db,
  adminUid,
  adId,
  decision,
  reason,
}: ModerateAdInput): Promise<{ success: true; adId: string; approvalStatus: string; isActive: boolean }> {
  if (!db) throw new BadRequestError("Database service unavailable");
  if (!adminUid) throw new ForbiddenError("Admin authentication required");
  if (!adId) throw new BadRequestError("Advertisement ID is required");
  if (decision !== "approve" && decision !== "reject") {
    throw new BadRequestError("Decision must be 'approve' or 'reject'");
  }

  const adRef = db.collection("advertisements").doc(adId);
  let resultStatus = "approved";
  let resultActive = false;

  await db.runTransaction(async (tx: any) => {
    const adSnap = await tx.get(adRef);
    if (!adSnap.exists) {
      throw new NotFoundError("Advertisement not found");
    }
    const adData = adSnap.data() || {};
    const advertiserUid = adData.advertiserUid || adData.advertiserId;
    let isVerified = false;
    if (advertiserUid) {
      const userSnap = await tx.get(db.collection("users").doc(advertiserUid));
      if (userSnap.exists) {
        isVerified = isAuthoritativelyVerifiedAdvertiser(userSnap.data() || {});
      }
    }

    if (decision === "approve") {
      const isPrepaidZero = adData.billingCycle === "prepaid" && Number(adData.prepaidBalance || 0) <= 0;
      const shouldActivate = !isPrepaidZero && adData.pausedByAdvertiser !== true;
      resultStatus = "approved";
      resultActive = shouldActivate;

      const approveUpdate = {
        approvalStatus: "approved",
        status: shouldActivate ? "active" : "paused",
        isActive: shouldActivate,
        isVerifiedAdvertiser: isVerified,
        badgeLabel: isVerified ? "FEATURED PRO" : "SPONSORED",
        moderatedBy: adminUid,
        moderatedAt: serverTimestampOrNow(),
        updatedAt: serverTimestampOrNow(),
      };
      tx.update(adRef, approveUpdate);
      syncPublicAdInTransaction(tx, db, adId, { ...adData, ...approveUpdate });
    } else {
      resultStatus = "rejected";
      resultActive = false;
      const rejectUpdate = {
        approvalStatus: "rejected",
        status: "rejected",
        isActive: false,
        rejectionReason: String(reason || "Rejected during moderation review").slice(0, 300),
        moderatedBy: adminUid,
        moderatedAt: serverTimestampOrNow(),
        updatedAt: serverTimestampOrNow(),
      };
      tx.update(adRef, rejectUpdate);
      syncPublicAdInTransaction(tx, db, adId, { ...adData, ...rejectUpdate });
    }
  });

  return {
    success: true,
    adId,
    approvalStatus: resultStatus,
    isActive: resultActive,
  };
}

export interface TrackSponsoredAdEventInput {
  db: any;
  adId: string;
  eventType: "click" | "impression";
  placement?: "banner_ad" | "search_feed";
  viewerUid?: string | null;
  viewerFingerprint?: string | null;
  now?: Date;
}

export interface TrackSponsoredAdEventResult {
  success: true;
  adId: string;
  eventType: "click" | "impression";
  tracked: boolean;
  billed: boolean;
  chargeAmount: number;
  remainingBalance: number | null;
  pausedByCap: boolean;
  lowBalanceAlertTriggered?: boolean;
  reason?: string;
}

/**
 * AT-ADS-01, AT-ADS-11, AT-ADS-13:
 * Transactional CPC click & impression billing engine enforcing:
 * - approval + active + non-expired campaign validation
 * - per-viewer/IP dedup throttle to prevent rapid repeat drain
 * - daily reset & strict dailyDisplayLimit cap
 * - campaign totalBudget & prepaidBalance checks (no negative balances)
 * - automatic pause + public_ads retraction + low-balance alerts + immutable ad_billing_events ledger logging
 */
export async function trackSponsoredAdEventCommand({
  db,
  adId,
  eventType,
  placement = "banner_ad",
  viewerUid = null,
  viewerFingerprint = null,
  now = new Date(),
}: TrackSponsoredAdEventInput): Promise<TrackSponsoredAdEventResult> {
  if (!db) throw new BadRequestError("Database service unavailable");
  if (!adId) throw new BadRequestError("Advertisement ID is required");
  if (eventType !== "click" && eventType !== "impression") {
    throw new BadRequestError("Invalid ad tracking event type");
  }

  const dedupActor = viewerUid || viewerFingerprint;
  if (dedupActor) {
    const dedupKey = `${adId}:${eventType}:${placement}:${dedupActor}`;
    const lastSeen = recentAdEventsCache.get(dedupKey);
    const nowMs = now.getTime();
    if (lastSeen && nowMs - lastSeen < AD_EVENT_DEDUP_WINDOW_MS) {
      return {
        success: true,
        adId,
        eventType,
        tracked: false,
        billed: false,
        chargeAmount: 0,
        remainingBalance: null,
        pausedByCap: false,
        reason: "duplicate_throttled",
      };
    }
    recentAdEventsCache.set(dedupKey, nowMs);
    if (recentAdEventsCache.size > 5000) {
      for (const [k, ts] of recentAdEventsCache.entries()) {
        if (nowMs - ts > AD_EVENT_DEDUP_WINDOW_MS * 2) recentAdEventsCache.delete(k);
      }
    }
  }

  const adRef = db.collection("advertisements").doc(adId);
  const todayUtc = now.toISOString().slice(0, 10);

  let result: TrackSponsoredAdEventResult = {
    success: true,
    adId,
    eventType,
    tracked: false,
    billed: false,
    chargeAmount: 0,
    remainingBalance: null,
    pausedByCap: false,
  };

  await db.runTransaction(async (tx: any) => {
    const adDoc = await tx.get(adRef);
    if (!adDoc.exists) {
      throw new NotFoundError("Advertisement not found");
    }

    const adData = adDoc.data() || {};
    if (adData.approvalStatus !== "approved" || adData.isActive !== true) {
      result = {
        ...result,
        tracked: false,
        reason: adData.approvalStatus !== "approved" ? "not_approved" : "campaign_inactive",
      };
      return;
    }

    const endMs = parseTimestampMs(adData.endDate);
    if (endMs !== null && endMs <= now.getTime()) {
      const expireUpdate = {
        isActive: false,
        status: "expired",
        updatedAt: serverTimestampOrNow(),
      };
      tx.update(adRef, expireUpdate);
      syncPublicAdInTransaction(tx, db, adId, { ...adData, ...expireUpdate });
      result = {
        ...result,
        tracked: false,
        pausedByCap: true,
        reason: "campaign_expired",
      };
      return;
    }

    // Daily roll-over check
    const isSameDay = adData.dailyResetDate === todayUtc;
    const currentDailyClicks = isSameDay ? Number(adData.dailyClicks || 0) : 0;
    const currentDailyImpressions = isSameDay ? Number(adData.dailyImpressions || 0) : 0;
    const currentDailySpend = isSameDay ? Number(adData.dailySpend || 0) : 0;
    const dailyDisplayLimit = Number(adData.dailyDisplayLimit || 0);

    // Enforce dailyDisplayLimit strictly
    if (dailyDisplayLimit > 0 && currentDailyClicks >= dailyDisplayLimit) {
      result = {
        ...result,
        tracked: false,
        reason: "daily_limit_reached",
      };
      return;
    }

    const isPrepaidCpc = adData.billingCycle === "prepaid";
    let currentBalance = typeof adData.prepaidBalance === "number" ? Number(adData.prepaidBalance) : 0;
    const totalSpend = Number(adData.totalSpend || 0);
    const totalBudget = Number(adData.totalBudget || 0);

    // If campaign is prepaid CPC and has depleted balance or exceeded budget, pause cleanly
    if (isPrepaidCpc && currentBalance <= 0) {
      const pauseUpdate = {
        isActive: false,
        status: "paused",
        pauseReason: "insufficient_balance",
        updatedAt: serverTimestampOrNow(),
      };
      tx.update(adRef, pauseUpdate);
      syncPublicAdInTransaction(tx, db, adId, { ...adData, ...pauseUpdate });
      result = {
        ...result,
        tracked: false,
        remainingBalance: 0,
        pausedByCap: true,
        reason: "insufficient_balance",
      };
      return;
    }

    if (eventType === "impression") {
      tx.update(adRef, {
        impressions: Number(adData.impressions || 0) + 1,
        dailyImpressions: currentDailyImpressions + 1,
        dailyClicks: currentDailyClicks,
        dailySpend: currentDailySpend,
        dailyResetDate: todayUtc,
        updatedAt: serverTimestampOrNow(),
      });
      result = {
        ...result,
        tracked: true,
        billed: false,
        chargeAmount: 0,
        remainingBalance: isPrepaidCpc ? currentBalance : null,
        pausedByCap: false,
      };
      return;
    }

    // Click event
    let chargeAmount = 0;
    let remainingBalance: number | null = isPrepaidCpc ? currentBalance : null;
    let pausedByCap = false;
    let lowBalanceAlertTriggered = false;

    if (isPrepaidCpc) {
      const advertiserUid = adData.advertiserUid || adData.advertiserId;
      let rawCpc = Number(adData.costPerDisplay);
      if (!Number.isFinite(rawCpc) || rawCpc < MIN_CPC_RATE_GBP) {
        if (advertiserUid) {
          const userSnap = await tx.get(db.collection("users").doc(advertiserUid));
          rawCpc = resolveCpcRateForTier(userSnap.exists ? userSnap.data()?.subscriptionType : undefined);
        } else {
          rawCpc = 1.00;
        }
      }
      const boundedCpc = Math.max(MIN_CPC_RATE_GBP, Math.min(MAX_CPC_RATE_GBP, Number(rawCpc.toFixed(2))));

      // Strict campaign budget & prepaid balance guards
      const exceedsCampaignBudget = totalBudget > 0 && Number((totalSpend + boundedCpc).toFixed(2)) > totalBudget;
      if (currentBalance < boundedCpc || exceedsCampaignBudget) {
        const capPauseUpdate = {
          isActive: false,
          status: "paused",
          pauseReason: exceedsCampaignBudget ? "campaign_budget_reached" : "insufficient_balance",
          updatedAt: serverTimestampOrNow(),
        };
        tx.update(adRef, capPauseUpdate);
        syncPublicAdInTransaction(tx, db, adId, { ...adData, ...capPauseUpdate });
        result = {
          ...result,
          tracked: false,
          billed: false,
          chargeAmount: 0,
          remainingBalance: currentBalance,
          pausedByCap: true,
          reason: exceedsCampaignBudget ? "campaign_budget_reached" : "insufficient_balance",
        };
        return;
      }

      chargeAmount = boundedCpc;
      remainingBalance = Number((currentBalance - chargeAmount).toFixed(2));
      // Auto-pause if remaining balance cannot fund one more click
      if (remainingBalance < boundedCpc || (totalBudget > 0 && Number((totalSpend + chargeAmount + boundedCpc).toFixed(2)) > totalBudget)) {
        pausedByCap = remainingBalance <= 0;
      }

      const lowThreshold = Number(adData.autoTopUpThreshold || 10);
      if (
        adData.lowBalanceAlertsEnabled !== false &&
        remainingBalance <= lowThreshold &&
        adData.lastLowBalanceAlertDate !== todayUtc
      ) {
        lowBalanceAlertTriggered = true;
      }
    }

    const nextClicks = Number(adData.clicks || 0) + 1;
    const nextDailyClicks = currentDailyClicks + 1;
    const adUpdate: Record<string, any> = {
      clicks: nextClicks,
      dailyClicks: nextDailyClicks,
      dailyImpressions: currentDailyImpressions,
      dailySpend: Number((currentDailySpend + chargeAmount).toFixed(2)),
      totalSpend: Number((totalSpend + chargeAmount).toFixed(2)),
      dailyResetDate: todayUtc,
      updatedAt: serverTimestampOrNow(),
    };

    if (placement === "search_feed") {
      adUpdate.searchFeedClicks = Number(adData.searchFeedClicks || 0) + 1;
    } else {
      adUpdate.bannerClicks = Number(adData.bannerClicks || 0) + 1;
    }

    if (isPrepaidCpc && remainingBalance !== null) {
      adUpdate.prepaidBalance = remainingBalance;
      if (lowBalanceAlertTriggered) {
        adUpdate.lastLowBalanceAlertDate = todayUtc;
      }
      if (pausedByCap) {
        adUpdate.isActive = false;
        adUpdate.status = "paused";
        adUpdate.pauseReason = "insufficient_balance";
      }
    }

    tx.update(adRef, adUpdate);
    if (pausedByCap) {
      syncPublicAdInTransaction(tx, db, adId, { ...adData, ...adUpdate });
    }

    if (lowBalanceAlertTriggered && (adData.advertiserUid || adData.advertiserId)) {
      const notifRef = db.collection("notifications").doc();
      tx.set(notifRef, {
        userId: adData.advertiserUid || adData.advertiserId,
        title: "⚠️ Ad Campaign Low Balance Alert",
        message: `Your promoted campaign "${adData.title || "Ad Campaign"}" has £${Number(remainingBalance || 0).toFixed(2)} remaining. Top up your balance or configure Smart Auto Top-Up to prevent downtime.`,
        type: "ad_low_balance",
        adId,
        link: "/ad-studio",
        read: false,
        createdAt: serverTimestampOrNow(),
      });
    }

    if (isPrepaidCpc && chargeAmount > 0) {
      const ledgerRef = db.collection("ad_billing_events").doc();
      tx.set(ledgerRef, {
        adId,
        advertiserUid: adData.advertiserUid || adData.advertiserId || null,
        viewerUid: viewerUid || null,
        eventType: "click",
        placement,
        amount: chargeAmount,
        currency: "gbp",
        balanceAfter: remainingBalance,
        dayUtc: todayUtc,
        createdAt: serverTimestampOrNow(),
      });
    }

    result = {
      success: true,
      adId,
      eventType: "click",
      tracked: true,
      billed: chargeAmount > 0,
      chargeAmount,
      remainingBalance,
      pausedByCap,
      lowBalanceAlertTriggered,
    };
  });

  return result;
}

export interface CreateCpcCampaignInput {
  db: any;
  authUid: string;
  title?: unknown;
  description?: unknown;
  placement?: unknown;
  promotionRadius?: unknown;
  targetRole?: unknown;
  targetCategories?: unknown;
  totalBudget?: unknown;
  autoTopUpEnabled?: unknown;
  autoTopUpThreshold?: unknown;
  autoTopUpAmount?: unknown;
  autoTopUpMaxMonthlyCapGbp?: unknown;
  lowBalanceAlertsEnabled?: unknown;
  now?: Date;
}

/**
 * Server-authoritative CPC campaign creation (replaces direct client writes in TraderAdStudio).
 * Derives CPC rate, verification badge, and saved payment method readiness server-side.
 */
export async function createCpcCampaignCommand({
  db,
  authUid,
  title,
  description,
  placement = "both",
  promotionRadius = "20",
  targetRole = "homeowner",
  targetCategories = [],
  totalBudget = 50,
  autoTopUpEnabled = false,
  autoTopUpThreshold = 10,
  autoTopUpAmount = 50,
  autoTopUpMaxMonthlyCapGbp = 250,
  lowBalanceAlertsEnabled = true,
  now = new Date(),
}: CreateCpcCampaignInput) {
  if (!db) throw new BadRequestError("Database service unavailable");
  if (!authUid) throw new ForbiddenError("Authentication required");

  const cleanTitle = typeof title === "string" ? title.trim().slice(0, 120) : "";
  const cleanDesc = typeof description === "string" ? description.trim().slice(0, 240) : "";
  if (!cleanTitle || !cleanDesc) {
    throw new BadRequestError("Campaign title and description are required.");
  }

  const parsedBudget = Math.max(10, Math.min(10_000, Number(totalBudget) || 50));
  const allowedPlacements = new Set(["search_feed", "banner_ad", "both"]);
  const safePlacement = allowedPlacements.has(String(placement)) ? String(placement) : "both";
  const safeRole = ["homeowner", "tradesperson", "all"].includes(String(targetRole)) ? String(targetRole) : "homeowner";
  const safeRadius =
    String(promotionRadius).toLowerCase() === "nationwide"
      ? "nationwide"
      : String(Math.max(5, Math.min(250, Number(promotionRadius) || 20)));

  const userRef = db.collection("users").doc(authUid);
  const adRef = db.collection("advertisements").doc();
  let createdSummary: any = null;

  await db.runTransaction(async (tx: any) => {
    const userSnap = await tx.get(userRef);
    if (!userSnap.exists) throw new NotFoundError("User profile not found");
    const userData = userSnap.data() || {};
    if (userData.isSuspended === true || userData.isFrozen === true || userData.banned === true) {
      throw new ForbiddenError("Suspended accounts cannot create advertising campaigns.");
    }

    const hasSavedPaymentMethod = Boolean(userData.stripeCustomerId && userData.defaultPaymentMethodId);
    const wantsAutoTopUp = autoTopUpEnabled === true;
    if (wantsAutoTopUp && !hasSavedPaymentMethod) {
      throw new BadRequestError(
        "Smart Auto Top-Up requires a saved off-session payment method on your account. Please add a card in Billing or disable Auto-Reload."
      );
    }

    const isVerified = isAuthoritativelyVerifiedAdvertiser(userData);
    const serverCpcRate = resolveCpcRateForTier(userData.subscriptionType);
    const normalizedCategories = Array.isArray(targetCategories)
      ? targetCategories.filter((c): c is string => typeof c === "string" && c.trim().length > 0).slice(0, 10)
      : [];

    const endDate = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const safeThreshold = Math.max(5, Math.min(500, Number(autoTopUpThreshold) || 10));
    const safeTopUpAmount = Math.max(MIN_AD_WALLET_TOPUP_GBP, Math.min(MAX_AD_WALLET_TOPUP_GBP, Number(autoTopUpAmount) || 50));
    const safeMonthlyCap = Math.max(safeTopUpAmount, Math.min(5000, Number(autoTopUpMaxMonthlyCapGbp) || 250));

    const docPayload = {
      type: "trader_promo",
      advertiserUid: authUid,
      advertiserId: authUid,
      advertiserName: String(userData.businessName || userData.name || "Trader").slice(0, 120),
      title: cleanTitle,
      description: cleanDesc,
      url: `/profile/${authUid}`,
      targetProfileId: authUid,
      bgColor: "bg-blue-600",
      iconName: "Zap",
      placement: safePlacement,
      promotionRadius: safeRadius,
      postcodeArea: typeof userData.postcode === "string" ? userData.postcode.trim().split(/\s+/)[0].toUpperCase() : undefined,
      lat: typeof userData.lat === "number" ? userData.lat : undefined,
      lng: typeof userData.lng === "number" ? userData.lng : undefined,
      isTraderAd: true,
      isVerifiedAdvertiser: isVerified,
      badgeLabel: isVerified ? "FEATURED PRO" : "SPONSORED",
      autoTopUpEnabled: wantsAutoTopUp,
      autoTopUpThreshold: safeThreshold,
      autoTopUpAmount: safeTopUpAmount,
      autoTopUpMaxMonthlyCapGbp: safeMonthlyCap,
      autoTopUpMonthlySpentGbp: 0,
      autoTopUpMonthKey: now.toISOString().slice(0, 7),
      lowBalanceAlertsEnabled: lowBalanceAlertsEnabled !== false,
      targetRole: safeRole,
      targetCategories: normalizedCategories,
      costPerDisplay: serverCpcRate,
      dailyDisplayLimit: 100,
      durationDays: 30,
      isActive: false,
      status: "pending_review",
      approvalStatus: "pending_review",
      billingCycle: "prepaid",
      totalBudget: parsedBudget,
      prepaidBalance: 0,
      clicks: 0,
      searchFeedClicks: 0,
      bannerClicks: 0,
      impressions: 0,
      dailyClicks: 0,
      dailyImpressions: 0,
      dailySpend: 0,
      totalSpend: 0,
      dailyResetDate: now.toISOString().slice(0, 10),
      startDate: now.toISOString(),
      endDate: endDate.toISOString(),
      createdAt: serverTimestampOrNow(),
      updatedAt: serverTimestampOrNow(),
    };

    for (const key of Object.keys(docPayload) as Array<keyof typeof docPayload>) {
      if (docPayload[key] === undefined) delete docPayload[key];
    }

    tx.set(adRef, docPayload);
    createdSummary = {
      success: true,
      adId: adRef.id,
      costPerDisplay: serverCpcRate,
      approvalStatus: "pending_review",
      autoTopUpEnabled: wantsAutoTopUp,
      hasSavedPaymentMethod,
    };
  });

  return createdSummary;
}

export interface UpdateAdAutoTopUpSettingsInput {
  db: any;
  authUid: string;
  adId: string;
  autoTopUpEnabled: boolean;
  autoTopUpThreshold?: number;
  autoTopUpAmount?: number;
  autoTopUpMaxMonthlyCapGbp?: number;
  lowBalanceAlertsEnabled?: boolean;
}

/**
 * AT-ADS-05:
 * Gates Smart Auto Top-Up activation strictly behind a verified saved off-session payment method
 * (`stripeCustomerId` + `defaultPaymentMethodId`) and explicit monthly spend cap.
 */
export async function updateAdAutoTopUpSettingsCommand({
  db,
  authUid,
  adId,
  autoTopUpEnabled,
  autoTopUpThreshold,
  autoTopUpAmount,
  autoTopUpMaxMonthlyCapGbp,
  lowBalanceAlertsEnabled,
}: UpdateAdAutoTopUpSettingsInput) {
  if (!db) throw new BadRequestError("Database service unavailable");
  if (!authUid) throw new ForbiddenError("Authentication required");
  if (!adId) throw new BadRequestError("Advertisement ID is required");

  const adRef = db.collection("advertisements").doc(adId);
  const userRef = db.collection("users").doc(authUid);
  let output: any = null;

  await db.runTransaction(async (tx: any) => {
    const [adSnap, userSnap] = await Promise.all([tx.get(adRef), tx.get(userRef)]);
    if (!adSnap.exists) throw new NotFoundError("Advertisement not found");
    const adData = adSnap.data() || {};
    if (adData.advertiserUid !== authUid && adData.advertiserId !== authUid) {
      throw new ForbiddenError("Unauthorized: You do not own this advertisement");
    }

    const userData = userSnap.exists ? (userSnap.data() || {}) : {};
    const hasSavedPaymentMethod = Boolean(userData.stripeCustomerId && userData.defaultPaymentMethodId);

    if (autoTopUpEnabled && !hasSavedPaymentMethod) {
      throw new BadRequestError(
        "Smart Auto Top-Up requires a saved off-session payment method on file. Please save a billing card before enabling Auto-Reload."
      );
    }

    const threshold = Math.max(5, Math.min(500, Number(autoTopUpThreshold ?? adData.autoTopUpThreshold ?? 10)));
    const amount = Math.max(
      MIN_AD_WALLET_TOPUP_GBP,
      Math.min(MAX_AD_WALLET_TOPUP_GBP, Number(autoTopUpAmount ?? adData.autoTopUpAmount ?? 50))
    );
    const monthlyCap = Math.max(amount, Math.min(5000, Number(autoTopUpMaxMonthlyCapGbp ?? adData.autoTopUpMaxMonthlyCapGbp ?? 250)));

    tx.update(adRef, {
      autoTopUpEnabled: Boolean(autoTopUpEnabled),
      autoTopUpThreshold: threshold,
      autoTopUpAmount: amount,
      autoTopUpMaxMonthlyCapGbp: monthlyCap,
      lowBalanceAlertsEnabled: lowBalanceAlertsEnabled !== undefined ? Boolean(lowBalanceAlertsEnabled) : adData.lowBalanceAlertsEnabled !== false,
      updatedAt: serverTimestampOrNow(),
    });

    output = {
      success: true,
      adId,
      autoTopUpEnabled: Boolean(autoTopUpEnabled),
      autoTopUpThreshold: threshold,
      autoTopUpAmount: amount,
      autoTopUpMaxMonthlyCapGbp: monthlyCap,
      hasSavedPaymentMethod,
    };
  });

  return output;
}

export interface ProcessAdAutoTopUpInput {
  db: any;
  adId: string;
  stripeClient?: {
    paymentIntents: {
      create: (params: Record<string, any>, options?: Record<string, any>) => Promise<{ id: string; status: string }>;
    };
  } | null;
  now?: Date;
}

export interface ProcessAdAutoTopUpResult {
  adId: string;
  charged: boolean;
  status:
    | "charged"
    | "skipped_not_enabled"
    | "skipped_above_threshold"
    | "skipped_no_saved_payment_method"
    | "skipped_monthly_cap_reached"
    | "skipped_stripe_unconfigured"
    | "failed_payment";
  chargedAmountGbp: number;
  newPrepaidBalance?: number;
  paymentIntentId?: string;
  reason?: string;
}

/**
 * AT-ADS-05:
 * Executes scheduled or threshold-triggered Smart Auto Top-Up off-session charging via Stripe
 * with explicit saved-payment-method gating, monthly cap enforcement, idempotency key, and
 * user low-balance/failure notifications. Never fakes a charge when Stripe or a saved method is absent.
 */
export async function processAdAutoTopUpCommand({
  db,
  adId,
  stripeClient,
  now = new Date(),
}: ProcessAdAutoTopUpInput): Promise<ProcessAdAutoTopUpResult> {
  if (!db) throw new BadRequestError("Database service unavailable");
  if (!adId) throw new BadRequestError("Advertisement ID is required");

  const adRef = db.collection("advertisements").doc(adId);
  const adSnap = await adRef.get();
  if (!adSnap.exists) throw new NotFoundError("Advertisement not found");
  const adData = adSnap.data() || {};

  if (adData.autoTopUpEnabled !== true) {
    return { adId, charged: false, status: "skipped_not_enabled", chargedAmountGbp: 0 };
  }

  const threshold = Number(adData.autoTopUpThreshold || 10);
  const currentBalance = Number(adData.prepaidBalance || 0);
  if (currentBalance > threshold) {
    return { adId, charged: false, status: "skipped_above_threshold", chargedAmountGbp: 0, newPrepaidBalance: currentBalance };
  }

  const advertiserUid = String(adData.advertiserUid || adData.advertiserId || "");
  if (!advertiserUid) {
    return { adId, charged: false, status: "skipped_no_saved_payment_method", chargedAmountGbp: 0, reason: "Missing advertiser owner" };
  }

  const userSnap = await db.collection("users").doc(advertiserUid).get();
  const userData = userSnap.exists ? (userSnap.data() || {}) : {};
  const stripeCustomerId = String(userData.stripeCustomerId || "");
  const defaultPaymentMethodId = String(userData.defaultPaymentMethodId || "");

  if (!stripeCustomerId || !defaultPaymentMethodId) {
    await db.collection("notifications").add({
      userId: advertiserUid,
      title: "Smart Auto Top-Up Requires a Saved Payment Method",
      message: `Campaign "${adData.title || adId}" reached £${currentBalance.toFixed(2)}, but no saved off-session card is configured. Please top up manually or save a billing card.`,
      type: "ad_auto_topup_unconfigured",
      adId,
      link: "/ad-studio",
      read: false,
      createdAt: serverTimestampOrNow(),
    });
    return {
      adId,
      charged: false,
      status: "skipped_no_saved_payment_method",
      chargedAmountGbp: 0,
      reason: "Advertiser has no saved off-session Stripe customer/payment method",
    };
  }

  const monthKey = now.toISOString().slice(0, 7);
  const monthlySpent = adData.autoTopUpMonthKey === monthKey ? Number(adData.autoTopUpMonthlySpentGbp || 0) : 0;
  const topUpAmount = Math.max(
    MIN_AD_WALLET_TOPUP_GBP,
    Math.min(MAX_AD_WALLET_TOPUP_GBP, Number(adData.autoTopUpAmount || 50))
  );
  const monthlyCap = Math.max(topUpAmount, Number(adData.autoTopUpMaxMonthlyCapGbp || 250));

  if (Number((monthlySpent + topUpAmount).toFixed(2)) > monthlyCap) {
    await db.collection("notifications").add({
      userId: advertiserUid,
      title: "Smart Auto Top-Up Monthly Cap Reached",
      message: `Campaign "${adData.title || adId}" reached its £${monthlyCap.toFixed(2)} monthly auto-reload cap. Increase your cap or top up manually to continue running.`,
      type: "ad_auto_topup_cap_reached",
      adId,
      link: "/ad-studio",
      read: false,
      createdAt: serverTimestampOrNow(),
    });
    return {
      adId,
      charged: false,
      status: "skipped_monthly_cap_reached",
      chargedAmountGbp: 0,
      reason: `Monthly auto-top-up cap (£${monthlyCap.toFixed(2)}) would be exceeded`,
    };
  }

  if (!stripeClient) {
    return {
      adId,
      charged: false,
      status: "skipped_stripe_unconfigured",
      chargedAmountGbp: 0,
      reason: "Stripe SDK client is not configured for off-session billing",
    };
  }

  const idempotencyKey = `ad_autotopup_${adId}_${monthKey}_${Math.round(monthlySpent * 100)}_${Math.round(currentBalance * 100)}`;

  let pi: { id: string; status: string };
  try {
    pi = await stripeClient.paymentIntents.create(
      {
        amount: Math.round(topUpAmount * 100),
        currency: "gbp",
        customer: stripeCustomerId,
        payment_method: defaultPaymentMethodId,
        off_session: true,
        confirm: true,
        metadata: {
          type: "ad_smart_auto_topup",
          adId,
          advertiserUid,
        },
      },
      { idempotencyKey }
    );
  } catch (stripeErr: any) {
    await db.collection("notifications").add({
      userId: advertiserUid,
      title: "Smart Auto Top-Up Payment Failed",
      message: `We could not charge £${topUpAmount.toFixed(2)} for "${adData.title || adId}". Please update your payment method or top up manually.`,
      type: "ad_auto_topup_failed",
      adId,
      link: "/ad-studio",
      read: false,
      createdAt: serverTimestampOrNow(),
    });
    return {
      adId,
      charged: false,
      status: "failed_payment",
      chargedAmountGbp: 0,
      reason: stripeErr?.message || "Off-session Stripe charge failed",
    };
  }

  if (pi.status !== "succeeded") {
    return {
      adId,
      charged: false,
      status: "failed_payment",
      chargedAmountGbp: 0,
      paymentIntentId: pi.id,
      reason: `PaymentIntent status is ${pi.status}`,
    };
  }

  let newPrepaidBalance = currentBalance;
  await db.runTransaction(async (tx: any) => {
    const freshSnap = await tx.get(adRef);
    const fresh = freshSnap.exists ? (freshSnap.data() || {}) : adData;
    const prevBal = Number(fresh.prepaidBalance || 0);
    const prevTotalBudget = Number(fresh.totalBudget || 0);
    const prevMonthly = fresh.autoTopUpMonthKey === monthKey ? Number(fresh.autoTopUpMonthlySpentGbp || 0) : 0;

    newPrepaidBalance = Number((prevBal + topUpAmount).toFixed(2));
    const nextMonthlySpent = Number((prevMonthly + topUpAmount).toFixed(2));
    const shouldReactivate = fresh.approvalStatus === "approved" && fresh.pausedByAdvertiser !== true && fresh.pauseReason === "insufficient_balance";

    const updatePayload: Record<string, any> = {
      prepaidBalance: newPrepaidBalance,
      totalBudget: Number((prevTotalBudget + topUpAmount).toFixed(2)),
      autoTopUpMonthKey: monthKey,
      autoTopUpMonthlySpentGbp: nextMonthlySpent,
      lastAutoTopUpAt: now.toISOString(),
      lastAutoTopUpPaymentIntentId: pi.id,
      updatedAt: serverTimestampOrNow(),
    };
    if (shouldReactivate) {
      updatePayload.isActive = true;
      updatePayload.status = "active";
      updatePayload.pauseReason = null;
    }

    tx.update(adRef, updatePayload);
    syncPublicAdInTransaction(tx, db, adId, { ...fresh, ...updatePayload });

    const ledgerRef = db.collection("ad_billing_events").doc();
    tx.set(ledgerRef, {
      adId,
      advertiserUid,
      eventType: "auto_topup",
      amount: topUpAmount,
      currency: "gbp",
      paymentIntentId: pi.id,
      balanceAfter: newPrepaidBalance,
      createdAt: serverTimestampOrNow(),
    });
  });

  return {
    adId,
    charged: true,
    status: "charged",
    chargedAmountGbp: topUpAmount,
    newPrepaidBalance,
    paymentIntentId: pi.id,
  };
}
