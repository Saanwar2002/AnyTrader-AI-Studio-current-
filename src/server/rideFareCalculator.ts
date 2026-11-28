/**
 * Canonical AnyRoller Ride Fare & Commission Calculator
 *
 * Canonical Fare Contract ("v2_excl_tip"):
 * - finalFare: Authoritative base fare EXCLUDING tip (GBP).
 *   Includes booking fareEstimate (or legacy fare/estimatedFare/totalFare/price),
 *   server-computed wait time charge, abandonment fee, and unpaid cancellation fee carried onto the ride.
 * - tipAmount: Passenger tip in GBP (>= 0, <= 50). Driver receives 100% of tip.
 * - totalFarePaid: finalFare + tipAmount.
 * - platformFee: Commission calculated ONLY on finalFare (+ fixedTripFee if configured). Never charged on tip!
 * - driverEarnings: (finalFare - platformFee) + tipAmount.
 */

export const MAX_PASSENGER_TIP_GBP = 50;

export const ALLOWED_VEHICLE_CATEGORIES = [
  "standard",
  "electric",
  "executive",
  "luxury",
  "6seater",
  "8seater",
  "wav",
] as const;

export const DEFAULT_VEHICLE_MULTIPLIERS: Record<string, number> = {
  standard: 1.0,
  electric: 1.15,
  executive: 1.5,
  luxury: 2.2,
  "6seater": 1.4,
  "8seater": 2.0,
  wav: 2.5,
};

export interface RidesFareConfig {
  baseFare: number;
  distanceRate: number;
  timeRate: number;
  waitRatePerMinute: number;
  minFare: number;
  priorityFee: number;
  petFee: number;
  commissionRate: number;
  fixedTripFee: number;
  freeWaitMinutes: number;
  driverWaitTimeLimitMins: number;
  abandonmentFeeGbp: number;
  maxDailyDriverHours: number;
  maxPendingPlatformFeesGbp: number;
  maxTipGbp: number;
  allowMidJourneyEdits: boolean;
  vehicleMultipliers: Record<string, number>;
}

export const DEFAULT_RIDES_FARE_CONFIG: RidesFareConfig = {
  baseFare: 3.5,
  distanceRate: 1.3,
  timeRate: 0.15,
  waitRatePerMinute: 0.25,
  minFare: 5.0,
  priorityFee: 3.0,
  petFee: 3.0,
  commissionRate: 0.12,
  fixedTripFee: 0,
  freeWaitMinutes: 3,
  driverWaitTimeLimitMins: 5,
  abandonmentFeeGbp: 5.0,
  maxDailyDriverHours: 24,
  maxPendingPlatformFeesGbp: 50.0,
  maxTipGbp: MAX_PASSENGER_TIP_GBP,
  allowMidJourneyEdits: true,
  vehicleMultipliers: { ...DEFAULT_VEHICLE_MULTIPLIERS },
};

export function computeServerBookingFareEstimate(params: {
  distanceMiles: number;
  durationMinutes: number;
  carCategory: string;
  ridesConfig: RidesFareConfig;
  isPriority?: boolean;
  isPetFriendly?: boolean;
  surgeModel?: "fixed" | "multiplier" | string;
  surgeMultiplier?: number;
  surgeFixedAmount?: number;
}): { baseCalc: number; fareEstimate: number } {
  const { ridesConfig } = params;
  const dist = Number.isFinite(params.distanceMiles) && params.distanceMiles > 0 ? params.distanceMiles : 0;
  const dur = Number.isFinite(params.durationMinutes) && params.durationMinutes > 0 ? params.durationMinutes : 0;
  const rawBase = ridesConfig.baseFare + dist * ridesConfig.distanceRate + dur * ridesConfig.timeRate;
  const baseCalc = penceToGbp(roundToPence(Math.max(ridesConfig.minFare, rawBase)));

  const normalizedCat = String(params.carCategory || "standard").trim().toLowerCase();
  const catMultiplier =
    Number(ridesConfig.vehicleMultipliers?.[normalizedCat]) > 0
      ? Number(ridesConfig.vehicleMultipliers[normalizedCat])
      : DEFAULT_VEHICLE_MULTIPLIERS[normalizedCat] || 1.0;

  let fare = Math.max(baseCalc * catMultiplier, ridesConfig.minFare * catMultiplier);

  const surgeModel = params.surgeModel === "multiplier" ? "multiplier" : "fixed";
  if (surgeModel === "fixed") {
    const fixedFee = Number(params.surgeFixedAmount);
    if (Number.isFinite(fixedFee) && fixedFee > 0) {
      fare += Math.min(50, fixedFee);
    }
  } else {
    const mult = Number(params.surgeMultiplier);
    if (Number.isFinite(mult) && mult > 1) {
      fare *= Math.min(5, mult);
    }
  }

  if (params.isPriority) fare += ridesConfig.priorityFee;
  if (params.isPetFriendly) fare += ridesConfig.petFee;

  return {
    baseCalc,
    fareEstimate: penceToGbp(roundToPence(Math.max(ridesConfig.minFare, fare))),
  };
}

export function roundToPence(amountGbp: number): number {
  return Math.round(amountGbp * 100);
}

export function penceToGbp(pence: number): number {
  return Math.round(pence) / 100;
}

export function sanitizeTipAmount(
  rawTip: unknown,
  maxTipGbp: number = MAX_PASSENGER_TIP_GBP
): number {
  const num = Number(rawTip);
  if (!Number.isFinite(num) || num <= 0) return 0;
  const effectiveCapGbp =
    Number.isFinite(maxTipGbp) && maxTipGbp >= 0
      ? Math.min(MAX_PASSENGER_TIP_GBP, maxTipGbp)
      : MAX_PASSENGER_TIP_GBP;
  const maxPence = Math.round(effectiveCapGbp * 100);
  return penceToGbp(Math.min(maxPence, Math.round(num * 100)));
}

export function haversineMilesBetween(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  if (
    !Number.isFinite(lat1) ||
    !Number.isFinite(lng1) ||
    !Number.isFinite(lat2) ||
    !Number.isFinite(lng2)
  ) {
    return 0;
  }
  const R = 3958.8;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
  return R * c;
}

/**
 * Computes a road-adjusted Haversine floor across an ordered list of waypoints
 * so client-supplied distances cannot under-report route distance or erase
 * miles already driven before a mid-journey edit.
 */
export function computeRouteHaversineFloorMiles(
  points: Array<{ lat: number; lng: number }>,
  roadFactor = 1.2
): number {
  if (!Array.isArray(points) || points.length < 2) return 0;
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (
      a &&
      b &&
      Number.isFinite(a.lat) &&
      Number.isFinite(a.lng) &&
      Number.isFinite(b.lat) &&
      Number.isFinite(b.lng)
    ) {
      total += haversineMilesBetween(a.lat, a.lng, b.lat, b.lng);
    }
  }
  return Math.round(total * roadFactor * 10) / 10;
}

export async function loadRidesFareConfig(db: any, tx?: any): Promise<RidesFareConfig> {
  const config: RidesFareConfig = {
    ...DEFAULT_RIDES_FARE_CONFIG,
    vehicleMultipliers: { ...DEFAULT_VEHICLE_MULTIPLIERS },
  };
  if (!db || typeof db.collection !== "function") return config;

  try {
    const ridesRef = db.collection("platform_config").doc("rides");
    const ridesSnap = tx && typeof tx.get === "function" ? await tx.get(ridesRef) : await ridesRef.get();
    const ridesExists = ridesSnap && (typeof ridesSnap.exists === "function" ? ridesSnap.exists() : ridesSnap.exists);
    if (ridesExists) {
      const data = typeof ridesSnap.data === "function" ? ridesSnap.data() : ridesSnap.data;
      if (data) {
        if (Number(data.baseFare) > 0) config.baseFare = Number(data.baseFare);
        if (Number(data.distanceRate) > 0) config.distanceRate = Number(data.distanceRate);
        if (Number(data.timeRate) >= 0) config.timeRate = Number(data.timeRate);
        if (Number(data.waitRatePerMinute) >= 0 && data.waitRatePerMinute !== undefined) {
          config.waitRatePerMinute = Number(data.waitRatePerMinute);
        }
        if (Number(data.minFare) > 0) config.minFare = Number(data.minFare);
        if (Number(data.priorityFee) >= 0 && data.priorityFee !== undefined) {
          config.priorityFee = Number(data.priorityFee);
        }
        if (Number(data.petFee) >= 0 && data.petFee !== undefined) {
          config.petFee = Number(data.petFee);
        }
        if (Number(data.commissionRate) >= 0 && data.commissionRate !== undefined) {
          config.commissionRate = Number(data.commissionRate);
        } else if (Number(data.commission) > 0) {
          config.commissionRate = Number(data.commission) / 100;
        }
        if (Number(data.fixedTripFee) >= 0 && data.fixedTripFee !== undefined) {
          config.fixedTripFee = Number(data.fixedTripFee);
        }
        if (Number(data.freeWaitMinutes) >= 0 && data.freeWaitMinutes !== undefined) {
          config.freeWaitMinutes = Number(data.freeWaitMinutes);
        }
        if (Number(data.driverWaitTimeLimitMins) > 0) {
          config.driverWaitTimeLimitMins = Number(data.driverWaitTimeLimitMins);
        }
        if (Number(data.abandonmentFee) >= 0 && data.abandonmentFee !== undefined) {
          config.abandonmentFeeGbp = Number(data.abandonmentFee);
        }
        if (Number(data.maxDailyDriverHours) > 0) {
          config.maxDailyDriverHours = Number(data.maxDailyDriverHours);
        }
        if (Number(data.maxPendingPlatformFeesGbp) > 0) {
          config.maxPendingPlatformFeesGbp = Number(data.maxPendingPlatformFeesGbp);
        }
        if (Number(data.maxTipGbp) >= 0 && data.maxTipGbp !== undefined) {
          config.maxTipGbp = Math.min(MAX_PASSENGER_TIP_GBP, Number(data.maxTipGbp));
        }
        if (typeof data.allowMidJourneyEdits === "boolean") {
          config.allowMidJourneyEdits = data.allowMidJourneyEdits;
        }
        if (data.vehicleMultipliers && typeof data.vehicleMultipliers === "object") {
          config.vehicleMultipliers = {
            ...DEFAULT_VEHICLE_MULTIPLIERS,
            ...data.vehicleMultipliers,
          };
        }
      }
    }
  } catch {
    // Fall back safely to defaults when platform_config/rides is absent in minimal mocks
  }

  try {
    const tiersRef = db.collection("platform_config").doc("global_tiers");
    const tiersSnap = tx && typeof tx.get === "function" ? await tx.get(tiersRef) : await tiersRef.get();
    const tiersExists = tiersSnap && (typeof tiersSnap.exists === "function" ? tiersSnap.exists() : tiersSnap.exists);
    if (tiersExists) {
      const tData = typeof tiersSnap.data === "function" ? tiersSnap.data() : tiersSnap.data;
      const stdTier = tData?.providerModels?.on_demand_transport?.tiers?.STANDARD;
      if (stdTier?.commission !== undefined && Number(stdTier.commission) >= 0) {
        config.commissionRate = Number(stdTier.commission);
      }
      if (stdTier?.fixedTripFee !== undefined && Number(stdTier.fixedTripFee) >= 0) {
        config.fixedTripFee = Number(stdTier.fixedTripFee);
      }
    }
  } catch {
    // Optional in unit mocks
  }

  return config;
}

export function isActiveGoldDriver(driverData: Record<string, any> | null | undefined): boolean {
  return (
    driverData?.isGoldDriver === true &&
    typeof driverData?.driverSubscriptionId === "string" &&
    driverData.driverSubscriptionId.trim().length > 0 &&
    driverData.driverSubscriptionStatus === "active"
  );
}

export function resolveEffectiveCommissionRate(
  driverData: Record<string, any> | null | undefined,
  ridesConfig: RidesFareConfig
): { commissionRate: number; fixedTripFee: number; tier: "gold" | "standard" } {
  if (isActiveGoldDriver(driverData)) {
    return {
      commissionRate: 0.10,
      fixedTripFee: 0,
      tier: "gold",
    };
  }
  return {
    commissionRate: Number.isFinite(ridesConfig.commissionRate) ? ridesConfig.commissionRate : 0.12,
    fixedTripFee: Number.isFinite(ridesConfig.fixedTripFee) ? ridesConfig.fixedTripFee : 0,
    tier: "standard",
  };
}

export interface ComputedRideFareBreakdown {
  baseFareGbp: number; // Authoritative finalFare excl. tip
  baseFarePence: number;
  tipGbp: number;
  tipPence: number;
  totalCollectedGbp: number;
  totalCollectedPence: number;
  waitFareGbp: number;
  paidWaitSeconds: number;
  abandonmentFeeGbp: number;
  unpaidCancellationFeesOwedGbp: number;
  commissionRate: number;
  fixedTripFeeGbp: number;
  driverTier: "gold" | "standard";
  platformFeeGbp: number;
  platformFeePence: number;
  driverEarningsGbp: number;
  driverEarningsPence: number;
}

/**
 * Computes authoritative ride base fare (excluding tip) and split calculations.
 * Rejects unfinalized/zero fares cleanly.
 */
export function computeAuthoritativeRideFare(params: {
  rideData: Record<string, any>;
  driverData?: Record<string, any> | null;
  ridesConfig?: RidesFareConfig;
  paidWaitSecondsOverride?: number;
  tipAmountOverride?: unknown;
  isAbandonment?: boolean;
}): ComputedRideFareBreakdown {
  const ridesConfig = params.ridesConfig || DEFAULT_RIDES_FARE_CONFIG;
  const ride = params.rideData || {};

  const paidWaitSecondsRaw =
    params.paidWaitSecondsOverride !== undefined
      ? Number(params.paidWaitSecondsOverride)
      : Number(ride.paidWaitSeconds || 0);
  const paidWaitSeconds = Number.isFinite(paidWaitSecondsRaw) && paidWaitSecondsRaw > 0
    ? Math.min(7200, Math.round(paidWaitSecondsRaw))
    : 0;

  const waitFarePence = roundToPence((paidWaitSeconds / 60) * ridesConfig.waitRatePerMinute);
  const waitFareGbp = penceToGbp(waitFarePence);

  const rawExistingFinal = Number(ride.finalFare);
  const hasFinalFare = Number.isFinite(rawExistingFinal) && rawExistingFinal > 0;

  let baseFarePence = 0;
  let abandonmentFeeGbp = 0;
  let unpaidCancellationFeesOwedGbp = Number(ride.unpaidCancellationFeesOwed || 0);
  if (!Number.isFinite(unpaidCancellationFeesOwedGbp) || unpaidCancellationFeesOwedGbp < 0) {
    unpaidCancellationFeesOwedGbp = 0;
  }

  if (hasFinalFare && !params.isAbandonment) {
    // Handle both v2_excl_tip (canonical) and legacy tests setting raw finalFare excl. tip
    if (ride.fareContractVersion === "v2_excl_tip") {
      baseFarePence = roundToPence(rawExistingFinal);
    } else if (
      typeof ride.totalFarePaid === "number" &&
      Number.isFinite(ride.totalFarePaid) &&
      typeof ride.tipAmount === "number" &&
      Math.abs(ride.totalFarePaid - rawExistingFinal) < 0.02 &&
      rawExistingFinal > ride.tipAmount
    ) {
      // Legacy record accidentally folded tipAmount into finalFare — strip tip cleanly
      baseFarePence = roundToPence(rawExistingFinal - ride.tipAmount);
    } else {
      baseFarePence = roundToPence(rawExistingFinal);
    }
    abandonmentFeeGbp = Number(ride.abandonmentFee || 0) || 0;
  } else {
    // Live booking contract: resolve from booking estimate or server-computable distance/duration
    const rawEstimate =
      ride.fareEstimate ??
      ride.fare ??
      ride.estimatedFare ??
      ride.totalFare ??
      ride.price;

    let estimateGbp = rawEstimate !== undefined && rawEstimate !== null ? Number(rawEstimate) : NaN;
    if (!Number.isFinite(estimateGbp) || estimateGbp <= 0) {
      // If caller provided valid rawEstimate === 0 explicitly (e.g. ride_no_fare), keep 0 so caller validation fails closed
      if (rawEstimate === 0 || rawEstimate === "0") {
        estimateGbp = 0;
      } else if (typeof ride.distanceMiles === "number" && ride.distanceMiles > 0) {
        const dur = Number(ride.durationMinutes || 0);
        estimateGbp = Math.max(
          ridesConfig.minFare,
          ridesConfig.baseFare + ride.distanceMiles * ridesConfig.distanceRate + dur * ridesConfig.timeRate
        );
      } else {
        estimateGbp = 0;
      }
    }

    if (params.isAbandonment || ride.status === "rider_abandoned") {
      const partialBaseGbp = estimateGbp > 0 ? estimateGbp * 0.5 : 12.0;
      abandonmentFeeGbp =
        Number(ride.abandonmentFee) > 0 ? Number(ride.abandonmentFee) : ridesConfig.abandonmentFeeGbp;
      baseFarePence =
        roundToPence(partialBaseGbp) +
        waitFarePence +
        roundToPence(abandonmentFeeGbp) +
        roundToPence(unpaidCancellationFeesOwedGbp);
    } else {
      const existingWaitAlreadyRecorded =
        ride.fareContractVersion === "v2_excl_tip" && Number(ride.finalFare) > 0;
      baseFarePence =
        roundToPence(estimateGbp) +
        (existingWaitAlreadyRecorded ? 0 : waitFarePence) +
        roundToPence(unpaidCancellationFeesOwedGbp);
    }
  }

  const resolvedTipRaw =
    params.tipAmountOverride !== undefined ? params.tipAmountOverride : (ride.tipAmount ?? 0);
  const tipGbp = sanitizeTipAmount(resolvedTipRaw, ridesConfig.maxTipGbp);
  const tipPence = roundToPence(tipGbp);

  const totalCollectedPence = baseFarePence + tipPence;
  const totalCollectedGbp = penceToGbp(totalCollectedPence);
  const baseFareGbp = penceToGbp(baseFarePence);

  const { commissionRate, fixedTripFee, tier } = resolveEffectiveCommissionRate(params.driverData, ridesConfig);
  const fixedTripFeePence = roundToPence(fixedTripFee);
  const variableCommissionPence = Math.round(baseFarePence * commissionRate);
  const rawPlatformFeePence = variableCommissionPence + fixedTripFeePence;
  const platformFeePence = Math.min(baseFarePence, Math.max(0, rawPlatformFeePence));
  const driverBaseSharePence = baseFarePence - platformFeePence;
  const driverEarningsPence = driverBaseSharePence + tipPence;

  return {
    baseFareGbp,
    baseFarePence,
    tipGbp,
    tipPence,
    totalCollectedGbp,
    totalCollectedPence,
    waitFareGbp,
    paidWaitSeconds,
    abandonmentFeeGbp,
    unpaidCancellationFeesOwedGbp,
    commissionRate,
    fixedTripFeeGbp: fixedTripFee,
    driverTier: tier,
    platformFeeGbp: penceToGbp(platformFeePence),
    platformFeePence,
    driverEarningsGbp: penceToGbp(driverEarningsPence),
    driverEarningsPence,
  };
}

export interface StripeConnectFeeAllocation {
  basePlatformFeePence: number;
  estimatedStripeProcessingFeePence: number;
  processingFeeFloorTopUpPence: number;
  recoveredCashFeesPence: number;
  stripeApplicationFeePence: number;
  driverNetPayoutPence: number;
}

/**
 * Computes Stripe Connect Destination Charge `application_fee_amount` with two
 * zero-money-loss safeguards while preserving canonical trip commission & tip accounting:
 *
 * 1. Processing-Fee Floor Protection:
 *    Because Stripe deducts card processing fees from the platform's application fee
 *    on Destination Charges, small fares with large 0%-commission tips (or international cards)
 *    could otherwise create a negative platform margin. When base commission alone is below
 *    the estimated Stripe processing cost (2.9% + 25p), adds only the exact shortfall needed
 *    so the platform never takes a net loss on a transaction.
 *
 * 2. Automatic Cash-Commission Recovery:
 *    Automatically recovers owed `users/{driverId}.pendingPlatformFees` from card payouts,
 *    capped at 50% of the driver's remaining base fare share (never touching passenger tips
 *    and always ensuring positive payout on the trip).
 */
export function computeStripeConnectFeeAllocation(params: {
  baseFarePence: number;
  tipPence: number;
  platformFeePence: number;
  pendingPlatformFeesGbp?: number;
  maxRecoveryShareOfDriverBase?: number;
}): StripeConnectFeeAllocation {
  const baseFarePence = Math.max(0, Math.round(Number(params.baseFarePence) || 0));
  const tipPence = Math.max(0, Math.round(Number(params.tipPence) || 0));
  const totalCollectedPence = baseFarePence + tipPence;
  const basePlatformFeePence = Math.min(
    totalCollectedPence,
    Math.max(0, Math.round(Number(params.platformFeePence) || 0))
  );

  // Conservative upper-bound estimate of Stripe processing cost (2.9% + 25p) so UK & international cards never cause loss
  const estimatedStripeProcessingFeePence =
    totalCollectedPence > 0 ? Math.ceil(totalCollectedPence * 0.029) + 25 : 0;

  const rawFloorShortfall = Math.max(0, estimatedStripeProcessingFeePence - basePlatformFeePence);
  const maxFloorTopUp = Math.max(0, totalCollectedPence - basePlatformFeePence);
  const processingFeeFloorTopUpPence = Math.min(maxFloorTopUp, rawFloorShortfall);

  const driverBaseShareAfterFloorPence = Math.max(
    0,
    baseFarePence - basePlatformFeePence - processingFeeFloorTopUpPence
  );

  const recoveryCapRatio =
    typeof params.maxRecoveryShareOfDriverBase === "number" &&
    Number.isFinite(params.maxRecoveryShareOfDriverBase)
      ? Math.max(0, Math.min(0.8, params.maxRecoveryShareOfDriverBase))
      : 0.5;

  const pendingFeesPence = Math.max(0, roundToPence(Number(params.pendingPlatformFeesGbp || 0)));
  const maxRecoverableThisTripPence = Math.floor(driverBaseShareAfterFloorPence * recoveryCapRatio);
  const recoveredCashFeesPence = Math.min(pendingFeesPence, maxRecoverableThisTripPence);

  const stripeApplicationFeePence = Math.min(
    totalCollectedPence,
    basePlatformFeePence + processingFeeFloorTopUpPence + recoveredCashFeesPence
  );
  const driverNetPayoutPence = Math.max(0, totalCollectedPence - stripeApplicationFeePence);

  return {
    basePlatformFeePence,
    estimatedStripeProcessingFeePence,
    processingFeeFloorTopUpPence,
    recoveredCashFeesPence,
    stripeApplicationFeePence,
    driverNetPayoutPence,
  };
}

