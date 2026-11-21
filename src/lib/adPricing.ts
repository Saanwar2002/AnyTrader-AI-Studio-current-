/**
 * CANONICAL ADVERTISING PRICING & BOUNDS
 * Single source of truth shared between server billing endpoints and trader UI studios.
 * AT-ADS-04: Reconciled to canonical £2.00/day banner promotion rate.
 */

export const BANNER_AD_DAILY_RATE_GBP = 2.00;
export const BANNER_AD_DAILY_RATE_PENCE = 200;
export const MIN_BANNER_DURATION_DAYS = 1;
export const MAX_BANNER_DURATION_DAYS = 365;

export const MIN_AD_WALLET_TOPUP_GBP = 10;
export const MAX_AD_WALLET_TOPUP_GBP = 5000;

export const MIN_CPC_RATE_GBP = 0.25;
export const MAX_CPC_RATE_GBP = 10.00;
export const DEFAULT_CPC_RATE_GBP = 1.00;

export function sanitizeBannerDurationDays(rawDays: unknown): number {
  const numeric = Number(rawDays);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 7;
  }
  return Math.max(
    MIN_BANNER_DURATION_DAYS,
    Math.min(MAX_BANNER_DURATION_DAYS, Math.floor(numeric))
  );
}

export function calculateBannerAdCostGbp(durationDays: unknown): number {
  const safeDays = sanitizeBannerDurationDays(durationDays);
  return Number((safeDays * BANNER_AD_DAILY_RATE_GBP).toFixed(2));
}

export function calculateBannerAdCostPence(durationDays: unknown): number {
  const safeDays = sanitizeBannerDurationDays(durationDays);
  return safeDays * BANNER_AD_DAILY_RATE_PENCE;
}

export function sanitizeAdWalletTopupGbp(rawAmount: unknown): number {
  const numeric = Number(rawAmount);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 50;
  }
  return Math.max(
    MIN_AD_WALLET_TOPUP_GBP,
    Math.min(MAX_AD_WALLET_TOPUP_GBP, Math.round(numeric * 100) / 100)
  );
}

export function resolveCpcRateForTier(subscriptionType?: string): number {
  const normalized = String(subscriptionType || "").toLowerCase();
  if (normalized === "platinum" || normalized === "premium" || normalized === "elite") {
    return 0.50;
  }
  if (normalized === "pro" || normalized === "silver") {
    return 0.70;
  }
  return DEFAULT_CPC_RATE_GBP;
}
