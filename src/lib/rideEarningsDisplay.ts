/**
 * Canonical AnyRoller Ride Financial Summary Resolver (AT-RIDE-PAY-08)
 *
 * Ensures Driver Earnings, Trip History, Passenger Billing, CSV downloads, and
 * Google Sheets exports always prefer authoritative server-persisted fields
 * (`driverEarnings`, `platformFee`, `appliedCommissionRate`, `finalFare`, `tipAmount`, `totalFarePaid`)
 * without double-counting tips or hardcoding 0.88 / 12% multipliers.
 */

export interface FallbackFareConfig {
  commissionRate?: number;
  fixedTripFee?: number;
}

export interface RideFinancialSummary {
  baseFare: number;
  tipAmount: number;
  totalFarePaid: number;
  platformFee: number;
  driverEarnings: number;
  driverBaseShare: number;
  appliedCommissionRate: number;
  appliedCommissionPct: number;
  appliedFixedTripFee: number;
  isServerVerified: boolean;
  hasEstimatedFallback: boolean;
}

function toFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function roundTo2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function roundTo4(value: number): number {
  return Math.round((value + Number.EPSILON) * 10000) / 10000;
}

function roundTo1(value: number): number {
  return Math.round((value + Number.EPSILON) * 10) / 10;
}

export function resolveRideFinancialSummary(
  ride: Record<string, any> | null | undefined,
  fallbackFareConfig?: FallbackFareConfig
): RideFinancialSummary {
  const safeRide = ride || {};
  const tipRaw = toFiniteNumber(safeRide.tipAmount);
  const tipAmount = tipRaw !== null ? Math.max(0, roundTo2(tipRaw)) : 0;

  const rateFromRide = toFiniteNumber(safeRide.appliedCommissionRate);
  const rateFromFallback = toFiniteNumber(fallbackFareConfig?.commissionRate);
  const defaultRate =
    rateFromRide !== null
      ? Math.max(0, Math.min(1, rateFromRide))
      : rateFromFallback !== null
        ? Math.max(0, Math.min(1, rateFromFallback))
        : 0.12;

  const fixedFromRide = toFiniteNumber(safeRide.appliedFixedTripFee);
  const fixedFromFallback = toFiniteNumber(fallbackFareConfig?.fixedTripFee);
  const appliedFixedTripFee =
    fixedFromRide !== null
      ? Math.max(0, roundTo2(fixedFromRide))
      : fixedFromFallback !== null
        ? Math.max(0, roundTo2(fixedFromFallback))
        : 0;

  const serverDriverRaw =
    toFiniteNumber(safeRide.driverEarnings) ?? toFiniteNumber(safeRide.calculatedDriverEarnings);
  const serverFeeRaw =
    toFiniteNumber(safeRide.platformFee) ??
    toFiniteNumber(safeRide.calculatedPlatformFee) ??
    toFiniteNumber(safeRide.commissionAmount);

  const finalFareNum = toFiniteNumber(safeRide.finalFare);
  const totalFarePaidNum = toFiniteNumber(safeRide.totalFarePaid);
  const legacyTotalFareNum = toFiniteNumber(safeRide.totalFare);
  const estimateNum =
    toFiniteNumber(safeRide.price) ??
    toFiniteNumber(safeRide.quotedPrice) ??
    toFiniteNumber(safeRide.fareEstimate);

  let baseFare = 0;
  let totalFarePaid = 0;
  let hasEstimatedFallback = false;

  if (safeRide.fareContractVersion === "v2_excl_tip" && finalFareNum !== null) {
    baseFare = Math.max(0, roundTo2(finalFareNum));
    totalFarePaid =
      totalFarePaidNum !== null ? Math.max(0, roundTo2(totalFarePaidNum)) : roundTo2(baseFare + tipAmount);
  } else if (totalFarePaidNum !== null) {
    totalFarePaid = Math.max(0, roundTo2(totalFarePaidNum));
    baseFare =
      finalFareNum !== null
        ? Math.max(0, roundTo2(finalFareNum))
        : Math.max(0, roundTo2(totalFarePaid - tipAmount));
  } else if (finalFareNum !== null) {
    if (legacyTotalFareNum !== null) {
      baseFare = Math.max(0, roundTo2(finalFareNum));
      totalFarePaid = Math.max(0, roundTo2(legacyTotalFareNum));
    } else if (serverDriverRaw !== null && serverFeeRaw !== null) {
      totalFarePaid = Math.max(0, roundTo2(serverDriverRaw + serverFeeRaw));
      baseFare = Math.max(0, roundTo2(totalFarePaid - tipAmount));
    } else {
      // Legacy `finalFare` often included tip when no separate `totalFarePaid` existed
      totalFarePaid = Math.max(0, roundTo2(finalFareNum));
      baseFare = Math.max(0, roundTo2(totalFarePaid - tipAmount));
    }
  } else if (legacyTotalFareNum !== null) {
    baseFare = Math.max(0, roundTo2(legacyTotalFareNum));
    totalFarePaid = roundTo2(baseFare + tipAmount);
  } else {
    hasEstimatedFallback = true;
    let est = estimateNum !== null ? Math.max(0, roundTo2(estimateNum)) : 0;
    if (safeRide.status === "rider_abandoned" && est <= 0) {
      est = 5;
    }
    baseFare = est;
    totalFarePaid = roundTo2(baseFare + tipAmount);
  }

  let driverEarnings = 0;
  let platformFee = 0;
  let isServerVerified = false;

  if (serverDriverRaw !== null) {
    isServerVerified = true;
    driverEarnings = Math.max(0, roundTo2(serverDriverRaw));
    if (serverFeeRaw !== null) {
      platformFee = Math.max(0, roundTo2(serverFeeRaw));
    } else {
      platformFee = Math.max(0, roundTo2(totalFarePaid - driverEarnings));
    }
  } else if (serverFeeRaw !== null) {
    isServerVerified = true;
    platformFee = Math.max(0, roundTo2(serverFeeRaw));
    driverEarnings = Math.max(0, roundTo2(baseFare - platformFee + tipAmount));
  } else {
    const computedFee = Math.min(baseFare, roundTo2(baseFare * defaultRate + appliedFixedTripFee));
    platformFee = Math.max(0, computedFee);
    driverEarnings = Math.max(0, roundTo2(baseFare - platformFee + tipAmount));
  }

  let appliedCommissionRate = defaultRate;
  if (rateFromRide !== null) {
    appliedCommissionRate = Math.max(0, Math.min(1, rateFromRide));
  } else if (baseFare > 0 && isServerVerified) {
    const percentagePortion = Math.max(0, platformFee - appliedFixedTripFee);
    appliedCommissionRate = Math.max(0, Math.min(1, roundTo4(percentagePortion / baseFare)));
  }

  const appliedCommissionPct = roundTo1(appliedCommissionRate * 100);
  const driverBaseShare = Math.max(0, roundTo2(driverEarnings - tipAmount));

  return {
    baseFare,
    tipAmount,
    totalFarePaid,
    platformFee,
    driverEarnings,
    driverBaseShare,
    appliedCommissionRate,
    appliedCommissionPct,
    appliedFixedTripFee,
    isServerVerified,
    hasEstimatedFallback,
  };
}
