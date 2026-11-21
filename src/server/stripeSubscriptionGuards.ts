import { BadRequestError, ConflictError, ForbiddenError } from "./httpErrors.ts";

export const SUPPORTED_SUBSCRIPTION_PRODUCTS = [
  "tier",
  "landlord",
  "exclusive_leads",
  "video_pro",
  "gotham_saas",
  "driver_gold",
] as const;

export type SupportedSubscriptionProduct = (typeof SUPPORTED_SUBSCRIPTION_PRODUCTS)[number];

export function isMockSubscriptionId(subscriptionId: unknown): boolean {
  return typeof subscriptionId === "string" && subscriptionId.startsWith("mock_");
}

export function isExplicitMockSubscriptionAllowed(
  subscriptionId: unknown,
  nodeEnv: string | undefined,
  allowMockPayments: string | undefined
): boolean {
  return isMockSubscriptionId(subscriptionId) &&
    nodeEnv !== "production" &&
    allowMockPayments === "true";
}

export function getSubscriptionIdForProduct(userData: Record<string, any>, subscriptionType: string): string | undefined {
  if (subscriptionType === "tier") {
    if (userData.subscriptionType === "landlord" || userData.subscriptionType === "gotham_saas" || userData.subscriptionType === "driver_gold") {
      return undefined;
    }
    return typeof userData.subscriptionId === "string" && userData.subscriptionId.trim()
      ? userData.subscriptionId.trim()
      : undefined;
  }
  if (subscriptionType === "landlord") {
    return userData.subscriptionType === "landlord" && typeof userData.subscriptionId === "string" && userData.subscriptionId.trim()
      ? userData.subscriptionId.trim()
      : undefined;
  }
  if (subscriptionType === "exclusive_leads") {
    return typeof userData.exclusiveSubscriptionId === "string" && userData.exclusiveSubscriptionId.trim()
      ? userData.exclusiveSubscriptionId.trim()
      : undefined;
  }
  if (subscriptionType === "video_pro") {
    return typeof userData.videoProSubscriptionId === "string" && userData.videoProSubscriptionId.trim()
      ? userData.videoProSubscriptionId.trim()
      : undefined;
  }
  if (subscriptionType === "gotham_saas") {
    if (typeof userData.gothamSubscriptionId === "string" && userData.gothamSubscriptionId.trim()) {
      return userData.gothamSubscriptionId.trim();
    }
    return userData.subscriptionType === "gotham_saas" && typeof userData.subscriptionId === "string" && userData.subscriptionId.trim()
      ? userData.subscriptionId.trim()
      : undefined;
  }
  if (subscriptionType === "driver_gold") {
    if (typeof userData.driverSubscriptionId === "string" && userData.driverSubscriptionId.trim()) {
      return userData.driverSubscriptionId.trim();
    }
    return userData.subscriptionType === "driver_gold" && typeof userData.subscriptionId === "string" && userData.subscriptionId.trim()
      ? userData.subscriptionId.trim()
      : undefined;
  }
  return undefined;
}

const TERMINAL_SUBSCRIPTION_STATUSES = new Set(["canceled", "cancelled", "unpaid", "incomplete_expired", "free"]);

export interface VerifiedSubscriptionTarget {
  subscriptionType: SupportedSubscriptionProduct;
  subscriptionId: string;
  currentStatus: string | null;
  cancelAtPeriodEnd: boolean;
}

export function resolveVerifiedSubscriptionTarget(input: {
  userData: Record<string, any>;
  requestedType?: unknown;
  requestedSubscriptionId?: unknown;
  action: "cancel" | "reactivate";
}): VerifiedSubscriptionTarget {
  const { userData, requestedType, requestedSubscriptionId, action } = input;
  const rawType = typeof requestedType === "string" && requestedType.trim() ? requestedType.trim() : "tier";

  if (!SUPPORTED_SUBSCRIPTION_PRODUCTS.includes(rawType as SupportedSubscriptionProduct)) {
    throw new BadRequestError("Unsupported subscription type.");
  }

  const subscriptionType = rawType as SupportedSubscriptionProduct;
  const subId = getSubscriptionIdForProduct(userData, subscriptionType);
  if (!subId) {
    throw new ConflictError("No Stripe subscription is linked to this account for the selected product.");
  }

  if (typeof requestedSubscriptionId === "string" && requestedSubscriptionId.trim() !== "") {
    if (requestedSubscriptionId.trim() !== subId) {
      throw new ForbiddenError("Supplied subscription ID does not match the caller's active subscription for this product.");
    }
  }

  let statusRaw: unknown;
  let cancelAtPeriodEnd = false;
  if (subscriptionType === "landlord") {
    statusRaw = userData.homeownerSubscriptionStatus ?? "active";
    cancelAtPeriodEnd = Boolean(userData.homeownerCancelAtPeriodEnd);
  } else if (subscriptionType === "exclusive_leads") {
    statusRaw = userData.exclusiveSubscriptionStatus ?? (userData.hasExclusiveAddon ? "active" : undefined);
    cancelAtPeriodEnd = Boolean(userData.exclusiveCancelAtPeriodEnd);
  } else if (subscriptionType === "video_pro") {
    statusRaw = userData.videoProSubscriptionStatus ?? (userData.hasVerifiedVideoProSubscription ? "active" : undefined);
    cancelAtPeriodEnd = Boolean(userData.videoProCancelAtPeriodEnd);
  } else if (subscriptionType === "gotham_saas") {
    statusRaw = userData.gothamSubscriptionStatus ?? (userData.isGothamSubscriber ? "active" : undefined);
    cancelAtPeriodEnd = Boolean(userData.gothamCancelAtPeriodEnd);
  } else if (subscriptionType === "driver_gold") {
    statusRaw = userData.driverSubscriptionStatus ?? (userData.isGoldDriver ? "active" : undefined);
    cancelAtPeriodEnd = Boolean(userData.driverCancelAtPeriodEnd);
  } else {
    statusRaw = userData.subscriptionStatus;
    cancelAtPeriodEnd = Boolean(userData.cancelAtPeriodEnd);
  }

  const normalizedStatus = typeof statusRaw === "string" ? statusRaw.trim().toLowerCase() : null;
  if (normalizedStatus && TERMINAL_SUBSCRIPTION_STATUSES.has(normalizedStatus)) {
    throw new ConflictError(`Cannot ${action} a subscription in terminal '${normalizedStatus}' state.`);
  }

  return {
    subscriptionType,
    subscriptionId: subId,
    currentStatus: normalizedStatus,
    cancelAtPeriodEnd,
  };
}

