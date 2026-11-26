/**
 * Slice 2 Money Flow Hardening Helpers (AnyTrader)
 * Pure, server-authoritative helpers for Stripe Checkout fulfillment,
 * Instant Match payment intent resolution, subscription re-subscription guards,
 * dispute mediation stake eligibility, and verified bank detail sanitization.
 */

export const TERMINAL_SUBSCRIPTION_STATUSES = new Set([
  "canceled",
  "cancelled",
  "unpaid",
  "incomplete_expired",
]);

export const DISPUTABLE_JOB_STATUSES = new Set([
  "accepted",
  "scheduled",
  "in_progress",
  "awaiting_confirmation",
  "pending_completion",
  "completed",
  "disputed",
]);

/**
 * Determines whether a job in the given status is eligible to initiate
 * or pay a Dispute Mediation Stake. Rejects unaccepted/draft/cancelled/closed jobs.
 */
export function isJobEligibleForMediationStake(status: unknown): boolean {
  const normalized = String(status || "").trim().toLowerCase();
  return DISPUTABLE_JOB_STATUSES.has(normalized);
}

/**
 * Resolves the authoritative Stripe PaymentIntent ID (`pi_...`) for an Instant Match
 * checkout completion. Always checks `session.payment_intent` first because
 * `payment_intents/{intentId}.paymentIntentId` is commonly null at session creation time
 * until Checkout completes.
 */
export function resolveInstantMatchPaymentIntentId(
  session: Record<string, any> | null | undefined,
  intent: Record<string, any> | null | undefined
): string | null {
  const sessionPi =
    typeof session?.payment_intent === "string"
      ? session.payment_intent.trim()
      : typeof session?.payment_intent?.id === "string"
        ? session.payment_intent.id.trim()
        : "";
  const intentPi =
    typeof intent?.paymentIntentId === "string" ? intent.paymentIntentId.trim() : "";

  const candidate = sessionPi || intentPi;
  return /^pi_[A-Za-z0-9_]+$/.test(candidate) ? candidate : null;
}

/**
 * Checks whether a new Stripe subscription ID may safely replace an existing linked
 * subscription ID on a user document during checkout fulfillment.
 * Allows replacement when no prior ID exists, when IDs match, or when the prior
 * subscription is in a terminal status or no longer active.
 */
export function canReplaceLinkedSubscription(params: {
  existingSubscriptionId?: unknown;
  incomingSubscriptionId: string;
  existingStatus?: unknown;
  isCurrentlyActive?: unknown;
}): boolean {
  const existingId =
    typeof params.existingSubscriptionId === "string"
      ? params.existingSubscriptionId.trim()
      : "";
  const incomingId = String(params.incomingSubscriptionId || "").trim();

  if (!existingId || existingId === incomingId) return true;

  const status = String(params.existingStatus || "").trim().toLowerCase();
  if (TERMINAL_SUBSCRIPTION_STATUSES.has(status)) return true;
  if (params.isCurrentlyActive === false) return true;

  return false;
}

/**
 * Non-fatally fetches a Stripe Subscription's `current_period_end` as an ISO timestamp
 * so checkout completion immediately hydrates renewal dates even if Stripe delivers
 * `customer.subscription.created` before `checkout.session.completed`.
 */
export async function resolveSubscriptionPeriodEndIso(
  stripeClient: any,
  subscriptionId: string
): Promise<string | undefined> {
  if (!stripeClient?.subscriptions?.retrieve || !subscriptionId) {
    return undefined;
  }
  try {
    const sub = await stripeClient.subscriptions.retrieve(subscriptionId);
    const periodEnd = Number(sub?.current_period_end || 0);
    if (Number.isFinite(periodEnd) && periodEnd > 0) {
      return new Date(periodEnd * 1000).toISOString();
    }
  } catch {
    // Non-fatal; subsequent subscription.updated / invoice.paid webhooks will sync period end.
  }
  return undefined;
}

export interface VerifiedBankDetails {
  bankName: string;
  sortCode: string;
  accountNumber: string;
}

/**
 * Extracts genuine, trader-configured bank transfer details for Pro invoices.
 * Never invents or falls back to placeholder bank details.
 */
export function sanitizeOfficialBankDetails(
  profile: Record<string, any> | null | undefined
): VerifiedBankDetails | undefined {
  if (!profile) return undefined;
  const bankName = String(profile.bankName || "").trim();
  const sortCode = String(profile.sortCode || "").trim();
  const accountNumber = String(profile.accountNumber || "").trim();
  if (!bankName || !sortCode || !accountNumber) {
    return undefined;
  }
  return { bankName, sortCode, accountNumber };
}
