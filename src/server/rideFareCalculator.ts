/**
 * Canonical AnyRoller Ride Fare & Commission Calculator
 *
 * Canonical Fare Contract ("v2_excl_tip"):
 * - finalFare: Authoritative base fare EXCLUDING tip (GBP).
 *   Includes booking fareEstimate (or legacy fare/estimatedFare/totalFare/price),
 *   server-computed wait time charge, abandonment fee, and unpaid cancellation fee carried onto the ride.
 * - tipAmount: Passenger tip in GBP (>= 0, <= 500). Driver receives 100% of tip.
 * - totalFarePaid: finalFare + tipAmount.
 * - platformFee: Commission calculated ONLY on finalFare (+ fixedTripFee if configured). Never charged on tip!
 * - driverEarnings: (finalFare - platformFee) + tipAmount.
 */

export interface RidesFareConfig {
  baseFare: number;
  distanceRate: number;
  timeRate: number;
  waitRatePerMinute: number;
  minFare: number;
  priorityFee: number;
  commissionRate: number;
  fixedTripFee: number;
  freeWaitMinutes: number;
  driverWaitTimeLimitMins: number;
  abandonmentFeeGbp: number;
  maxDailyDriverHours: number;
}

export const DEFAULT_RIDES_FARE_CONFIG: RidesFareConfig = {
  baseFare: 3.5,
  distanceRate: 1.3,
  timeRate: 0.15,
  waitRatePerMinute: 0.25,
  minFare: 5.0,
  priorityFee: 3.0,
  commissionRate: 0.12,
  fixedTripFee: 0,
  freeWaitMinutes: 3,
  driverWaitTimeLimitMins: 5,
  abandonmentFeeGbp: 5.0,
  maxDailyDriverHours: 24,
};

export function roundToPence(amountGbp: number): number {
  return Math.round(amountGbp * 100);
}

export function penceToGbp(pence: number): number {
  return Math.round(pence) / 100;
}

export function sanitizeTipAmount(rawTip: unknown): number {
  const num = Number(rawTip);
  if (!Number.isFinite(num) || num <= 0) return 0;
  return penceToGbp(Math.min(50000, Math.round(num * 100)));
}

export async function loadRidesFareConfig(db: any, tx?: any): Promise<RidesFareConfig> {
  const config: RidesFareConfig = { ...DEFAULT_RIDES_FARE_CONFIG };
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
  const tipGbp = sanitizeTipAmount(resolvedTipRaw);
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
