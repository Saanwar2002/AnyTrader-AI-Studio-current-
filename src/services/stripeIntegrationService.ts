import { db, auth } from "@/src/firebase";
import { doc, updateDoc, getDoc } from "firebase/firestore";

/**
 * STRIPE INTEGRATION SERVICE
 * This service handles the business logic for the Dual-Rail Payment System.
 * Shared between AnyTrader Home and AnyTrader Rides.
 */

export const DEFAULT_ANYTRADER_COMMISSIONS: Record<NormalizedTraderTier, number> = {
  payg: 0.05,
  pro: 0.035,
  premium: 0.025,
  platinum: 0.015,
};

export const DEFAULT_ANYTRADER_COMMISSION_CAP_GBP = 250.00;

export const STRIPE_CONFIG = {
  CARD_FEE_PERCENT: 0.024, // 2.4% standard card fee
  CARD_FEE_FLAT: 0.20,     // 20p flat fee
  BANK_TRANSFER_FEE_MAX: 10.00, // Capped at £10 for large jobs
  BANK_TRANSFER_FEE_PERCENT: 0.005, // 0.5% for bank pay
  COMMISSION_CAP: DEFAULT_ANYTRADER_COMMISSION_CAP_GBP,   // Default max platform commission per job
  PAYMENT_RAIL_THRESHOLD: 400.00, // Jobs >= 400 use Bank Transfer
};

export interface PayoutBreakdown {
  grossAmount: number;
  stripeFee: number;
  platformCommission: number;
  netPayout: number;
  paymentRail: 'card' | 'bank_transfer';
  appliedCommissionRate: number;
  commissionCapGbp: number;
}

export type NormalizedTraderTier = 'payg' | 'pro' | 'premium' | 'platinum';

/**
 * Normalizes user tier strings from across the platform (e.g. "Silver Professional", "Pro", "Gold Elite")
 * into canonical keys ('payg' | 'pro' | 'premium' | 'platinum') for consistent fee calculation and feature entitlements.
 */
export function normalizeTraderTier(rawTier?: string): NormalizedTraderTier {
  if (!rawTier) return 'payg';
  const clean = rawTier.trim().toLowerCase();
  
  if (clean.includes('platinum') || clean.includes('enterprise powerhouse')) {
    return 'platinum';
  }
  if (clean.includes('gold') || clean.includes('elite') || clean.includes('premium') || clean.includes('business professional')) {
    return 'premium';
  }
  if (clean.includes('silver') || clean.includes('pro') || clean.includes('professional')) {
    return 'pro';
  }
  return 'payg';
}

/**
 * Resolves live Admin-configured commission rate (decimal 0..1) and commission cap (£, 0 = no cap)
 * from Firestore platform_config/global_tiers and platform_config/global, falling back to canonical defaults.
 */
export function resolveClientCommissionConfig(
  tier: string = 'payg',
  globalTiers?: any,
  platformConfig?: any
): { normalizedTier: NormalizedTraderTier; commissionRate: number; commissionCapGbp: number } {
  const normalizedTier = normalizeTraderTier(tier);
  let commissionRate = DEFAULT_ANYTRADER_COMMISSIONS[normalizedTier];

  const tierEntry = globalTiers?.providerModels?.one_off_trades?.tiers?.[normalizedTier];
  if (tierEntry && typeof tierEntry.commission === 'number' && Number.isFinite(tierEntry.commission) && tierEntry.commission >= 0) {
    commissionRate = tierEntry.commission > 1 ? tierEntry.commission / 100 : tierEntry.commission;
  } else if (Array.isArray(platformConfig?.feeTiers)) {
    const matched = platformConfig.feeTiers.find(
      (ft: any) => normalizeTraderTier(ft?.name) === normalizedTier
    );
    if (matched && typeof matched.commission === 'number' && Number.isFinite(matched.commission) && matched.commission >= 0) {
      // platform_config/global.feeTiers always stores percentage (e.g. 5, 3.5, 1, 0.5)
      commissionRate = Math.round((matched.commission / 100) * 1000000) / 1000000;
    }
  }

  const rawCap =
    globalTiers?.providerModels?.one_off_trades?.commissionCapGbp ??
    globalTiers?.commissionCapGbp ??
    platformConfig?.commissionCapGbp;
  const parsedCap = rawCap === undefined || rawCap === null || rawCap === '' ? NaN : Number(rawCap);
  const commissionCapGbp =
    Number.isFinite(parsedCap) && parsedCap >= 0
      ? parsedCap
      : DEFAULT_ANYTRADER_COMMISSION_CAP_GBP;

  return { normalizedTier, commissionRate, commissionCapGbp };
}

/**
 * Calculates the financial breakdown for a quote based on the user's tier.
 * Canonical platform rates (overridable via Admin controls):
 * - PAYG (Free Explorer): 5.0% platform commission
 * - Pro (Silver Professional): 3.5% platform commission
 * - Premium (Gold Elite): 2.5% platform commission
 * - Platinum (Platinum Enterprise): 1.5% platform commission
 */
export function calculatePayoutBreakdown(
  amount: number,
  tier: string = 'payg',
  customCommissionRate?: number,
  customCommissionCapGbp?: number
): PayoutBreakdown {
  const normalizedTier = normalizeTraderTier(tier);
  const isLargeJob = amount >= STRIPE_CONFIG.PAYMENT_RAIL_THRESHOLD;
  const paymentRail = isLargeJob ? 'bank_transfer' : 'card';

  // 1. Calculate Stripe Fee
  let stripeFee = 0;
  if (isLargeJob) {
    stripeFee = Math.min(amount * STRIPE_CONFIG.BANK_TRANSFER_FEE_PERCENT, STRIPE_CONFIG.BANK_TRANSFER_FEE_MAX);
  } else {
    stripeFee = (amount * STRIPE_CONFIG.CARD_FEE_PERCENT) + STRIPE_CONFIG.CARD_FEE_FLAT;
  }

  // 2. Calculate Platform Commission based on Tier or Custom Config
  let commissionRate = DEFAULT_ANYTRADER_COMMISSIONS[normalizedTier];
  if (typeof customCommissionRate === 'number' && Number.isFinite(customCommissionRate) && customCommissionRate >= 0) {
    commissionRate = customCommissionRate;
  }

  const commissionCapGbp =
    typeof customCommissionCapGbp === 'number' && Number.isFinite(customCommissionCapGbp) && customCommissionCapGbp >= 0
      ? customCommissionCapGbp
      : STRIPE_CONFIG.COMMISSION_CAP;

  const rawCommission = amount * commissionRate;
  const platformCommission =
    commissionCapGbp > 0
      ? Math.min(rawCommission, commissionCapGbp, amount)
      : Math.min(rawCommission, amount);

  // 3. Final Net
  const netPayout = amount - stripeFee - platformCommission;

  return {
    grossAmount: amount,
    stripeFee,
    platformCommission,
    netPayout,
    paymentRail,
    appliedCommissionRate: commissionRate,
    commissionCapGbp,
  };
}

export interface VerifiedVideoProPlan {
  monthlyPrice: number; // £15.00
  annualPrice: number; // £144.00 (saving £36/yr)
  billingCycle: "monthly" | "annual";
  matchScoreBonus: number; // +35 points
  hasPriorityQuotePositioning: boolean;
  hasVideoSelfieHosting: boolean;
  badgeLabel: string;
  features: string[];
}

/**
 * Verified Trader Credential & Video Badge Subscription (£15/mo)
 * - Grants traders +35 match score points
  * - Priority quote positioning on homeowner comparison screens
  * - HD Video Selfie & Credential hosting
 */
export function calculateVerifiedVideoProSubscription(
  billingCycle: "monthly" | "annual" = "monthly",
  customConfig?: { monthlyPrice?: number; annualPrice?: number; matchScoreBonus?: number }
): VerifiedVideoProPlan {
  const baseMonthly = customConfig?.monthlyPrice ?? 15.00;
  const annualPrice = customConfig?.annualPrice ?? (Math.round(baseMonthly * 12 * 0.8)); // 20% discount default
  const effectiveMonthlyRate = billingCycle === "annual" ? Math.round((annualPrice / 12) * 100) / 100 : baseMonthly;
  const matchBonus = customConfig?.matchScoreBonus ?? 35;
  
  return {
    monthlyPrice: effectiveMonthlyRate,
    annualPrice,
    billingCycle,
    matchScoreBonus: matchBonus,
    hasPriorityQuotePositioning: true,
    hasVideoSelfieHosting: true,
    badgeLabel: "Verified Video Pro",
    features: [
      `⚡ +${matchBonus} Match Score Points in 40+ Signal Intelligent Matching Engine`,
      "🚀 Priority Quote Positioning (Top Placement on Homeowner Feeds)",
      "📹 HD 15-60s Live Video Selfie & Credential Video Hosting",
      "🏅 Verified Video Pro Gold Trust Badge on Profile & Quotes",
      "📈 3x Higher Homeowner Quote Conversion Rate"
    ]
  };
}

export interface FlexiPayMerchantFeeBreakdown {
  financedAmount: number;
  termMonths: number;
  merchantFeeRate: number; // e.g. 0.025 (2.5%), 0.020 (2.0%), 0.015 (1.5%)
  merchantFeeAmount: number; // e.g. £80.00
  provider: string; // e.g. "Klarna / TradeOS 0% Flexi" | "Novuna Personal Finance" | "Clearpay"
  platformRevenueShare: number; // 100% of origination fee goes to TradeOS platform
  traderGuaranteedPayout: number; // Full job payout to tradesperson without non-payment risk
}

export interface MaterialMerchantAffiliateBreakdown {
  materialTotal: number;
  merchantName: string;
  affiliateRate: number; // 3.0% to 5.0%
  affiliateCommissionAmount: number; // Fee earned by TradeOS
  traderDiscountRate: number; // 5% trade discount for trader
  traderDiscountAmount: number;
  traderDiscountCode: string;
  affiliateNetwork: string;
  itemCount: number;
}

/**
 * Calculates Materials Sourcing & Merchant Affiliate Referral Commission (3% - 5%)
 * collected by TradeOS when traders source materials from partner merchants.
 * - Travis Perkins & Jewson: 5.0% affiliate referral commission
 * - Toolstation & Selco: 4.5% affiliate referral commission
 * - Screwfix Trade: 4.0% affiliate referral commission
 * - B&Q TradePoint & Wickes: 3.5% affiliate referral commission
 */
export function calculateMaterialMerchantAffiliateCommission(
  materialTotal: number,
  merchantName: string = "Screwfix",
  itemCount: number = 1
): MaterialMerchantAffiliateBreakdown {
  let affiliateRate = 0.040; // Default 4.0%
  const lowerMerchant = merchantName.toLowerCase();

  if (lowerMerchant.includes("travis") || lowerMerchant.includes("jewson")) {
    affiliateRate = 0.050; // 5.0% top tier
  } else if (lowerMerchant.includes("toolstation") || lowerMerchant.includes("selco")) {
    affiliateRate = 0.045; // 4.5% tier
  } else if (lowerMerchant.includes("screwfix")) {
    affiliateRate = 0.040; // 4.0% standard trade tier
  } else if (lowerMerchant.includes("b&q") || lowerMerchant.includes("tradepoint") || lowerMerchant.includes("wickes")) {
    affiliateRate = 0.035; // 3.5% DIY trade tier
  } else {
    affiliateRate = 0.030; // 3.0% general merchant tier
  }

  const affiliateCommissionAmount = Math.round(materialTotal * affiliateRate * 100) / 100;
  const traderDiscountRate = 0.05; // 5% exclusive trade perk for trader
  const traderDiscountAmount = Math.round(materialTotal * traderDiscountRate * 100) / 100;

  const merchantClean = merchantName.replace(/[^a-zA-Z]/g, '').toUpperCase().slice(0, 8) || "TRADE";
  const traderDiscountCode = `TRADEOS-${merchantClean}-5OFF`;

  return {
    materialTotal,
    merchantName,
    affiliateRate,
    affiliateCommissionAmount,
    traderDiscountRate,
    traderDiscountAmount,
    traderDiscountCode,
    affiliateNetwork: "TradeOS Merchant Connect / Awin Network",
    itemCount
  };
}

/**
 * Calculates the FlexiPay BNPL Merchant Origination Fee (1.5% - 2.5%) charged to the financing partner.
 * - Short Term (3-6 Months 0% APR): 2.5% merchant origination fee
 * - Standard Term (12 Months): 2.0% merchant origination fee
 * - Heavy Repair Term (24-36 Months): 1.5% merchant origination fee
 */
export function calculateFlexiPayMerchantFee(
  financedAmount: number,
  termMonths: number,
  provider?: string
): FlexiPayMerchantFeeBreakdown {
  let rate = 0.020; // Default 2.0%
  if (termMonths <= 6) {
    rate = 0.025; // 2.5% on 0% APR promo terms
  } else if (termMonths === 12) {
    rate = 0.020; // 2.0% standard term
  } else if (termMonths >= 24) {
    rate = 0.015; // 1.5% long-term volume tier
  }

  const merchantFeeAmount = Math.round(financedAmount * rate * 100) / 100;
  const resolvedProvider = provider || (termMonths <= 6 ? "Klarna / TradeOS 0% Flexi" : "Novuna Personal Finance");

  return {
    financedAmount,
    termMonths,
    merchantFeeRate: rate,
    merchantFeeAmount,
    provider: resolvedProvider,
    platformRevenueShare: merchantFeeAmount,
    traderGuaranteedPayout: financedAmount
  };
}

/**
 * Generates the Stripe Onboarding Link for a trader or driver.
 * Calls real server endpoint /api/stripe/create-connect-account with user auth token.
 */
export async function getStripeOnboardingLink(
  _userId: string,
  returnTarget?: "billing" | "profile",
  businessType?: "individual" | "company" | "non_profit"
): Promise<string> {
  const token = await auth.currentUser?.getIdToken();
  const payload: Record<string, string> = {};
  if (returnTarget) payload.returnTarget = returnTarget;
  if (businessType) payload.businessType = businessType;

  const res = await fetch("/api/stripe/create-connect-account", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    ...(Object.keys(payload).length > 0 ? { body: JSON.stringify(payload) } : {})
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.url) {
    throw new Error(data?.error || `Failed to create Stripe Connect onboarding link (${res.status})`);
  }
  return data.url;
}

/**
 * Queries real-time Stripe Connect onboarding and capability status from the server.
 */
export async function getStripeAccountStatus(): Promise<{
  connected: boolean;
  stripeAccountId?: string;
  payoutsEnabled?: boolean;
  chargesEnabled?: boolean;
  detailsSubmitted?: boolean;
  error?: string;
}> {
  try {
    const token = await auth.currentUser?.getIdToken();
    const res = await fetch("/api/stripe/account-status", {
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      }
    });
    if (res.ok) {
      return await res.json();
    }
    const errData = await res.json().catch(() => ({}));
    return {
      connected: false,
      payoutsEnabled: false,
      chargesEnabled: false,
      detailsSubmitted: false,
      error: errData?.error || `Unable to check Stripe status (${res.status})`
    };
  } catch (err) {
    console.warn("Failed to fetch Stripe account status:", err);
  }
  return { connected: false, payoutsEnabled: false, chargesEnabled: false, detailsSubmitted: false };
}

/**
 * Generates a Stripe Express Dashboard login link for connected accounts.
 */
export async function getStripeLoginLink(): Promise<string | null> {
  try {
    const token = await auth.currentUser?.getIdToken();
    const res = await fetch("/api/stripe/create-login-link", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      }
    });
    if (res.ok) {
      const data = await res.json();
      return data.url || null;
    }
  } catch (err) {
    console.warn("Failed to get Stripe login link:", err);
  }
  return null;
}

/**
 * Retrieves the available and pending balance from the connected Stripe account.
 */
export async function getStripeConnectBalance(): Promise<{ available: number; pending: number; currency: string }> {
  try {
    const token = await auth.currentUser?.getIdToken();
    const res = await fetch("/api/stripe/balance", {
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      }
    });
    if (res.ok) {
      return await res.json();
    }
  } catch (err) {
    console.warn("Failed to fetch Stripe balance:", err);
  }
  return { available: 0, pending: 0, currency: "gbp" };
}

/**
 * Requests an instant payout from the connected Stripe account to provider's bank.
 */
export async function requestStripeConnectPayout(
  amount?: number,
  idempotencyKey?: string
): Promise<{ success: boolean; payout?: any; error?: string; idempotentReplay?: boolean }> {
  try {
    const token = await auth.currentUser?.getIdToken();
    const idemKey = idempotencyKey || (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `payout_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`);
    const res = await fetch("/api/stripe/request-payout", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idemKey,
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify({ amount })
    });
    const data = await res.json();
    if (!res.ok) {
      return { success: false, error: data.error || "Failed to initiate payout" };
    }
    return { success: true, payout: data.payout, idempotentReplay: data.idempotentReplay };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Deprecated client bypass disabled: Connect onboarding state is verified strictly via
 * signed Stripe Connect `account.updated` webhooks and server `/api/stripe/account-status`.
 */
export async function completeStripeOnboarding(_userId: string, _accountId: string): Promise<never> {
  throw new Error("Client-side Connect onboarding writes are disabled; status syncs exclusively via Stripe webhooks.");
}
