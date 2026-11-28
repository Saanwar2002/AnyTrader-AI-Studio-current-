/**
 * AnyRoller Driver App — Server-Side Ride Offer FCM Dispatch & Sanitized Nearby Drivers Engine
 *
 * Bridges web/mobile passengers with standalone native Android AnyRoller Drivers:
 * 1. `dispatchRideOffersCommand`: Authoritatively matches online, approved, eligible drivers
 *    from `live_tracking` + `users` and dispatches high-priority FCM pushes on Android channel
 *    `ride_offers_urgent` so backgrounded/locked Android Driver devices wake immediately.
 * 2. `getSanitizedNearbyDrivers`: Returns coarse, privacy-safe nearby driver pins for the
 *    passenger map without exposing `live_tracking` documents or driver UIDs/PII.
 * 3. `notifyRideCounterpartyPush`: Non-fatal post-commit FCM push helper for ride accept and
 *    cancellation notifications on Android channel `ride_chat_updates`.
 */

import admin from "firebase-admin";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from "./httpErrors.ts";
import { assertAuthoritativeDriverEligibility } from "./driverAuthorization.ts";
import { dispatchAuthoritativeFcmPush } from "./notificationEngine.ts";
import {
  ALLOWED_VEHICLE_CATEGORIES,
  MAX_PASSENGER_TIP_GBP,
  computeRouteHaversineFloorMiles,
  computeServerBookingFareEstimate,
  loadRidesFareConfig,
  penceToGbp,
  roundToPence,
} from "./rideFareCalculator.ts";

export const RIDE_OFFER_CHANNEL_ID = "ride_offers_urgent";
export const RIDE_UPDATES_CHANNEL_ID = "ride_chat_updates";
export const DEFAULT_OFFER_RADIUS_MILES = 15;
export const MAX_OFFER_RADIUS_MILES = 50;
export const DEFAULT_MAX_OFFER_DRIVERS = 15;
export const MAX_OFFER_DRIVERS = 25;
export const OFFER_DISPATCH_COOLDOWN_MS = 10_000;
export const OFFER_EXPIRY_MS = 35_000;
export const EXCLUSIVE_OFFER_TIMEOUT_MS = 15_000;
export const DRIVER_HEARTBEAT_STALE_MS = 10 * 60 * 1000;
export const STACKING_DROPOFF_MAX_MILES = 3.5;
export const SCHEDULED_DISPATCH_WINDOW_MS = 25 * 60 * 1000;
export const DEFAULT_MAX_DAILY_DRIVER_HOURS = 12;
export const BROADCAST_FALLBACK_MAX_DRIVERS = 5;
export const BROADCAST_EXPANDED_RADIUS_MILES = 20;

const OPEN_RIDE_STATUSES = new Set(["pending", "searching", "offered"]);

export interface CallerContext {
  uid: string;
  isAdmin?: boolean;
  admin?: boolean;
  [key: string]: any;
}

export interface SanitizedNearbyDriverPin {
  lat: number;
  lng: number;
  heading: number | null;
  vehicleCategory: string;
  vehicleCategories: string[];
  status: string;
  distanceMiles: number;
}

export interface GetNearbyDriversInput {
  db: any;
  lat: number;
  lng: number;
  radiusMiles?: number;
  vehicleCategory?: string;
  isPetFriendly?: boolean;
  excludeUid?: string;
  maxResults?: number;
  nowMs?: number;
}

export interface DispatchRideOffersInput {
  db: any;
  caller: CallerContext;
  rideId: string;
  messagingClient?: any;
  radiusMiles?: number;
  maxDrivers?: number;
  force?: boolean;
  nowMs?: number;
}

export interface DispatchRideOffersResult {
  success: boolean;
  rideId: string;
  throttled: boolean;
  retryAfterMs?: number;
  matchedDrivers: number;
  dispatchedCount: number;
  deliveredCount: number;
  skippedNoTokensCount: number;
  expiresAtMs?: number;
}

export function calculateHaversineMiles(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const earthRadiusMiles = 3958.7613;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadiusMiles * c;
}

function parseTimestampMs(ts: any): number | null {
  if (ts === null || ts === undefined) return null;
  if (typeof ts === "number" && Number.isFinite(ts)) return ts;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  if (typeof ts._seconds === "number") return ts._seconds * 1000;
  if (typeof ts.seconds === "number") return ts.seconds * 1000;
  if (typeof ts === "string") {
    const parsed = Date.parse(ts);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeCategory(value: any): string {
  return String(value || "standard")
    .trim()
    .toLowerCase();
}

function extractDriverCategories(trackingData: Record<string, any>): string[] {
  const cats = new Set<string>();
  if (Array.isArray(trackingData.vehicleCategories)) {
    for (const c of trackingData.vehicleCategories) {
      const normalized = normalizeCategory(c);
      if (normalized) cats.add(normalized);
    }
  }
  if (trackingData.vehicleCategory) {
    cats.add(normalizeCategory(trackingData.vehicleCategory));
  }
  if (trackingData.carCategory) {
    cats.add(normalizeCategory(trackingData.carCategory));
  }
  if (cats.size === 0) {
    cats.add("standard");
  }
  return Array.from(cats);
}

function isTrackingHeartbeatFresh(
  trackingData: Record<string, any>,
  nowMs: number,
  maxStaleMs: number = DRIVER_HEARTBEAT_STALE_MS
): boolean {
  const tsMs =
    parseTimestampMs(trackingData.lastHeartbeatAtMs) ??
    parseTimestampMs(trackingData.updatedAt) ??
    parseTimestampMs(trackingData.lastUpdated);
  if (tsMs === null) {
    // Allow records without explicit timestamps in lightweight fixtures if explicitly online
    return true;
  }
  return nowMs - tsMs <= maxStaleMs;
}

function matchesVehicleCategory(
  driverCategories: string[],
  requestedCategory?: string
): boolean {
  if (!requestedCategory) return true;
  const req = normalizeCategory(requestedCategory);
  if (!req || req === "any" || req === "all") return true;
  if (driverCategories.includes(req)) return true;
  // Standard rides can be served by any standard-capable driver unless explicitly excluded
  if (req === "standard" && driverCategories.length === 0) return true;
  return false;
}

/**
 * Checks whether a ride is ready for immediate driver dispatch.
 * Pre-booked scheduled rides more than 25 minutes in the future stay in the
 * Scheduled Jobs board instead of waking nearby drivers prematurely.
 */
export function isRideReadyForInstantDispatch(
  rideData: Record<string, any>,
  nowMs: number = Date.now(),
  windowMs: number = SCHEDULED_DISPATCH_WINDOW_MS
): boolean {
  const rawSched = rideData?.scheduledTime ?? rideData?.scheduledFor ?? rideData?.scheduledAt;
  if (rawSched === null || rawSched === undefined || rawSched === "") return true;
  const schedMs = parseTimestampMs(rawSched);
  if (schedMs === null) return true;
  return schedMs - nowMs <= windowMs;
}

/**
 * Batched Firestore document loader using `db.getAll(...)` on Admin SDK
 * with graceful fallback to `Promise.all` for in-memory test doubles.
 */
async function batchGetDocs(
  db: any,
  collectionName: string,
  docIds: string[]
): Promise<Map<string, Record<string, any> | null>> {
  const uniqueIds = Array.from(new Set(docIds.filter((id) => typeof id === "string" && id.trim().length > 0)));
  const result = new Map<string, Record<string, any> | null>();
  if (uniqueIds.length === 0) return result;

  const col = db.collection(collectionName);
  const refs = uniqueIds.map((id) => col.doc(id));

  let snaps: any[] = [];
  if (typeof db.getAll === "function") {
    // Firestore Admin SDK supports up to ~100 refs cleanly per batch
    for (let i = 0; i < refs.length; i += 100) {
      const chunk = refs.slice(i, i + 100);
      const chunkSnaps = await db.getAll(...chunk);
      snaps.push(...chunkSnaps);
    }
  } else {
    snaps = await Promise.all(refs.map((r) => r.get()));
  }

  for (let i = 0; i < uniqueIds.length; i++) {
    const snap = snaps[i];
    const id = snap?.id || uniqueIds[i];
    const exists = snap && (typeof snap.exists === "function" ? snap.exists() : snap.exists);
    if (exists) {
      const data = typeof snap.data === "function" ? snap.data() : snap.data;
      result.set(id, data || {});
    } else {
      result.set(id, null);
    }
  }
  return result;
}

export interface FairnessScoreResult {
  totalScore: number;
  breakdown: {
    proximity: number;
    earningsFairness: number;
    idleReward: number;
    reliability: number;
    routeEfficiency: number;
  };
}

/**
 * Canonical 5-Factor Driver Fairness Scoring Engine (0..100 scale):
 * - Proximity (35%): True Haversine miles to pickup (or dropoff->pickup for stacked).
 * - Earnings Fairness (25%): Boosts drivers with lower daily earnings.
 * - Real Idle Time (20%): Rewards drivers waiting longest since `lastAssignmentAt` (neutral 0.5 if unassigned).
 * - Reliability & Rating (10%): Combines `driverRating` and real `acceptanceRate`.
 * - Route Efficiency Bonus (10%): Rewards Destination Mode heading toward home or tight stacking dropoff (<=1.5 mi).
 */
export function computeDriverFairnessScore(params: {
  distanceMiles: number;
  metricsData?: Record<string, any> | null;
  userData?: Record<string, any> | null;
  trackingData?: Record<string, any> | null;
  rideData?: Record<string, any> | null;
  isStacked?: boolean;
  nowMs?: number;
}): FairnessScoreResult {
  const {
    distanceMiles,
    metricsData,
    userData,
    trackingData,
    rideData,
    isStacked = false,
    nowMs = Date.now(),
  } = params;

  const safeDist = Number.isFinite(distanceMiles) && distanceMiles >= 0 ? distanceMiles : 15;
  // 1. Proximity (0..1): 0 mi -> 1.0, 1 mi -> 0.5, 3 mi -> 0.25, 9 mi -> 0.1
  const proximityNorm = 1 / (safeDist + 1);

  // 2. Earnings Fairness (0..1): £0 -> 1.0, £100 -> 0.5, £300 -> 0.25
  const dailyEarnings = Math.max(
    0,
    Number(metricsData?.dailyEarnings ?? metricsData?.earningsToday ?? 0) || 0
  );
  const earningsNorm = 1 / (dailyEarnings / 100 + 1);

  // 3. Real Idle Reward (0..1): caps at 120 mins idle. Neutral 0.5 if never assigned yet today.
  const lastAssignMs =
    parseTimestampMs(metricsData?.lastAssignmentAtMs) ??
    parseTimestampMs(metricsData?.lastAssignmentAt);
  let idleNorm = 0.5;
  if (lastAssignMs !== null && lastAssignMs > 86_400_000) {
    const idleMins = Math.max(0, (nowMs - lastAssignMs) / 60_000);
    idleNorm = Math.min(idleMins / 120, 1.0);
  }

  // 4. Reliability & Rating (0..1)
  const rawRating = Number(userData?.driverRating ?? userData?.rating ?? metricsData?.rating ?? 4.9);
  const ratingNorm = Math.max(0, Math.min(1, (rawRating - 3.5) / 1.5));

  const acceptedCount = Math.max(0, Number(metricsData?.acceptedOffersCount || 0));
  const declinedCount = Math.max(0, Number(metricsData?.declinedOffersCount || 0));
  let acceptRateNorm = 0.9;
  if (acceptedCount + declinedCount >= 3) {
    acceptRateNorm = acceptedCount / (acceptedCount + declinedCount);
  } else if (Number.isFinite(Number(metricsData?.acceptanceRate))) {
    const rawRate = Number(metricsData?.acceptanceRate);
    acceptRateNorm = Math.max(0, Math.min(1, rawRate > 1 ? rawRate / 100 : rawRate));
  }
  const reliabilityNorm = ratingNorm * 0.5 + acceptRateNorm * 0.5;

  // 5. Route Efficiency Bonus (0..1): Destination mode heading home OR tight stacked dropoff
  let efficiencyNorm = 0.2;
  const isDestMode =
    trackingData?.destinationModeActive === true ||
    trackingData?.destinationMode === true ||
    userData?.destinationModeActive === true;
  if (isDestMode) {
    const homeLat = Number(trackingData?.homeLat ?? userData?.homeLat);
    const homeLng = Number(trackingData?.homeLng ?? userData?.homeLng);
    const pLat = Number(rideData?.pickupLat);
    const pLng = Number(rideData?.pickupLng);
    const dLat = Number(rideData?.dropoffLat);
    const dLng = Number(rideData?.dropoffLng);
    if (
      Number.isFinite(homeLat) &&
      Number.isFinite(homeLng) &&
      Number.isFinite(pLat) &&
      Number.isFinite(pLng) &&
      Number.isFinite(dLat) &&
      Number.isFinite(dLng)
    ) {
      const before = calculateHaversineMiles(pLat, pLng, homeLat, homeLng);
      const after = calculateHaversineMiles(dLat, dLng, homeLat, homeLng);
      if (after < before) {
        efficiencyNorm = 1.0;
      }
    }
  } else if (isStacked && safeDist <= 1.5) {
    efficiencyNorm = 0.85;
  }

  const proximity = Math.round(proximityNorm * 35 * 100) / 100;
  const earningsFairness = Math.round(earningsNorm * 25 * 100) / 100;
  const idleReward = Math.round(idleNorm * 20 * 100) / 100;
  const reliability = Math.round(reliabilityNorm * 10 * 100) / 100;
  const routeEfficiency = Math.round(efficiencyNorm * 10 * 100) / 100;

  return {
    totalScore: Math.round((proximity + earningsFairness + idleReward + reliability + routeEfficiency) * 100) / 100,
    breakdown: {
      proximity,
      earningsFairness,
      idleReward,
      reliability,
      routeEfficiency,
    },
  };
}

export function evaluateDriverOfferCandidate(params: {
  driverUid: string;
  trackingData: Record<string, any>;
  rideData: Record<string, any>;
  passengerId?: string | null;
  radiusMiles: number;
  nowMs: number;
  metricsData?: Record<string, any> | null;
  userData?: Record<string, any> | null;
  maxDailyDriverHours?: number;
  maxPendingPlatformFeesGbp?: number;
  ignoreWaitTolerance?: boolean;
}): { eligible: boolean; distanceMiles: number; reason?: string } {
  const {
    driverUid,
    trackingData,
    rideData,
    passengerId,
    radiusMiles,
    nowMs,
    metricsData,
    userData,
    maxDailyDriverHours = DEFAULT_MAX_DAILY_DRIVER_HOURS,
    maxPendingPlatformFeesGbp = 50,
    ignoreWaitTolerance = false,
  } = params;

  if (!driverUid || trackingData.isOnline !== true) {
    return { eligible: false, distanceMiles: Infinity, reason: "offline" };
  }

  if (passengerId && driverUid === passengerId) {
    return { eligible: false, distanceMiles: Infinity, reason: "self_ride" };
  }

  if (!isTrackingHeartbeatFresh(trackingData, nowMs)) {
    return { eligible: false, distanceMiles: Infinity, reason: "stale_heartbeat" };
  }

  // Unpaid cash-commission debt cap: pause dispatch until driver settles pending fees
  const pendingFeesGbp = Number(userData?.pendingPlatformFees || 0);
  if (
    Number.isFinite(pendingFeesGbp) &&
    Number.isFinite(maxPendingPlatformFeesGbp) &&
    maxPendingPlatformFeesGbp > 0 &&
    pendingFeesGbp >= maxPendingPlatformFeesGbp
  ) {
    return { eligible: false, distanceMiles: Infinity, reason: "pending_fees_limit" };
  }

  // Explicitly incomplete Stripe Connect verification blocks card-capable ride dispatches
  if (userData && userData.chargesEnabled === false) {
    return { eligible: false, distanceMiles: Infinity, reason: "stripe_onboarding_incomplete" };
  }

  // Max daily driving hours safety cap
  const onlineSecondsToday = Number(metricsData?.onlineSecondsToday ?? metricsData?.onlineSeconds ?? 0);
  if (
    Number.isFinite(onlineSecondsToday) &&
    onlineSecondsToday > 0 &&
    Number.isFinite(maxDailyDriverHours) &&
    maxDailyDriverHours > 0 &&
    onlineSecondsToday / 3600 >= maxDailyDriverHours
  ) {
    return { eligible: false, distanceMiles: Infinity, reason: "max_daily_hours" };
  }

  const isLastJob =
    trackingData.isLastJob === true ||
    trackingData.lastJobMode === true ||
    userData?.isLastJob === true;
  if (isLastJob) {
    return { eligible: false, distanceMiles: Infinity, reason: "last_job_mode" };
  }

  const declinedBy = Array.isArray(rideData.declinedBy) ? rideData.declinedBy : [];
  const declinedDriverIds = Array.isArray(rideData.declinedDriverIds)
    ? rideData.declinedDriverIds
    : [];
  if (declinedBy.includes(driverUid) || declinedDriverIds.includes(driverUid)) {
    return { eligible: false, distanceMiles: Infinity, reason: "declined" };
  }

  const driverLat = Number(trackingData.lat);
  const driverLng = Number(trackingData.lng);
  const pickupLat = Number(rideData.pickupLat);
  const pickupLng = Number(rideData.pickupLng);

  if (
    !Number.isFinite(driverLat) ||
    !Number.isFinite(driverLng) ||
    !Number.isFinite(pickupLat) ||
    !Number.isFinite(pickupLng)
  ) {
    return { eligible: false, distanceMiles: Infinity, reason: "missing_coordinates" };
  }

  const driverStatus = String(trackingData.status || "available").toLowerCase();
  // Coffee Cup Break Mode: explicitly skip paused/busy drivers and NEVER stack onto them
  if (trackingData.onBreak === true || driverStatus === "busy") {
    return { eligible: false, distanceMiles: Infinity, reason: "on_break" };
  }

  const isBusyOnRide = driverStatus === "on_ride";
  let distanceMiles = calculateHaversineMiles(driverLat, driverLng, pickupLat, pickupLng);
  let remainingActiveLegMiles = 0;

  if (isBusyOnRide) {
    const canStack =
      trackingData.isStackingEnabled === true || trackingData.allowJobStacking === true;
    if (!canStack) {
      return { eligible: false, distanceMiles, reason: "busy_no_stacking" };
    }
    const activeDropoffLat = Number(trackingData.dropoffLat);
    const activeDropoffLng = Number(trackingData.dropoffLng);
    if (!Number.isFinite(activeDropoffLat) || !Number.isFinite(activeDropoffLng)) {
      return { eligible: false, distanceMiles, reason: "stacking_missing_dropoff" };
    }
    remainingActiveLegMiles = calculateHaversineMiles(
      driverLat,
      driverLng,
      activeDropoffLat,
      activeDropoffLng
    );
    const dropoffToNextPickup = calculateHaversineMiles(
      activeDropoffLat,
      activeDropoffLng,
      pickupLat,
      pickupLng
    );
    if (dropoffToNextPickup > STACKING_DROPOFF_MAX_MILES) {
      return { eligible: false, distanceMiles: dropoffToNextPickup, reason: "stacking_too_far" };
    }
    distanceMiles = dropoffToNextPickup;
  }

  if (distanceMiles > radiusMiles) {
    return { eligible: false, distanceMiles, reason: "out_of_radius" };
  }

  // Passenger Wait Tolerance gate (Wave 1/2 only; relaxed in Wave 3 fallback)
  if (!ignoreWaitTolerance && rideData.waitTolerance && rideData.waitTolerance !== "any") {
    const toleranceMins = Number(rideData.waitTolerance);
    if (Number.isFinite(toleranceMins) && toleranceMins > 0) {
      const estPickupMins =
        distanceMiles * 3.3 + (isBusyOnRide ? remainingActiveLegMiles * 3.3 + 2 : 0);
      if (estPickupMins > toleranceMins + 2) {
        return { eligible: false, distanceMiles, reason: "exceeds_wait_tolerance" };
      }
    }
  }

  const requestedCategory = rideData.carCategory || rideData.vehicleCategory || "standard";
  const driverCategories = extractDriverCategories(trackingData);
  if (!matchesVehicleCategory(driverCategories, requestedCategory)) {
    return { eligible: false, distanceMiles, reason: "category_mismatch" };
  }

  const driverPetFriendly = trackingData.isPetFriendly ?? trackingData.petFriendly;
  if (rideData.isPetFriendly === true && driverPetFriendly === false) {
    return { eligible: false, distanceMiles, reason: "not_pet_friendly" };
  }

  // Destination filter (driver heading home — supports both Android and legacy field names)
  const isDestMode =
    trackingData.destinationModeActive === true ||
    trackingData.destinationMode === true ||
    userData?.destinationModeActive === true;
  if (isDestMode) {
    const destLat = Number(trackingData.homeLat ?? trackingData.destinationLat ?? userData?.homeLat);
    const destLng = Number(trackingData.homeLng ?? trackingData.destinationLng ?? userData?.homeLng);
    const rideDropoffLat = Number(rideData.dropoffLat);
    const rideDropoffLng = Number(rideData.dropoffLng);
    if (
      Number.isFinite(destLat) &&
      Number.isFinite(destLng) &&
      Number.isFinite(rideDropoffLat) &&
      Number.isFinite(rideDropoffLng)
    ) {
      const destRadius = Number(trackingData.destinationRadiusMiles);
      if (Number.isFinite(destRadius) && destRadius > 0) {
        const dropoffToDest = calculateHaversineMiles(
          rideDropoffLat,
          rideDropoffLng,
          destLat,
          destLng
        );
        if (dropoffToDest > destRadius) {
          return { eligible: false, distanceMiles, reason: "destination_mismatch" };
        }
      } else {
        const pickupToHome = calculateHaversineMiles(pickupLat, pickupLng, destLat, destLng);
        const dropoffToHome = calculateHaversineMiles(
          rideDropoffLat,
          rideDropoffLng,
          destLat,
          destLng
        );
        if (dropoffToHome > pickupToHome) {
          return { eligible: false, distanceMiles, reason: "destination_mismatch" };
        }
      }
    }
  }

  // Working zone filter (checks pickup AND dropoff if coordinates are present)
  const isZoneEnabled =
    trackingData.zoneEnabled === true ||
    trackingData.zoneFilterEnabled === true ||
    userData?.zoneEnabled === true;
  if (isZoneEnabled) {
    const zoneLat = Number(trackingData.zoneCenterLat ?? trackingData.homeLat ?? userData?.homeLat);
    const zoneLng = Number(trackingData.zoneCenterLng ?? trackingData.homeLng ?? userData?.homeLng);
    const zoneRadius =
      Number(trackingData.zoneMaxDistance ?? trackingData.zoneRadiusMiles ?? userData?.zoneMaxDistance) ||
      5;
    if (Number.isFinite(zoneLat) && Number.isFinite(zoneLng) && zoneRadius > 0) {
      const pickupToZone = calculateHaversineMiles(pickupLat, pickupLng, zoneLat, zoneLng);
      if (pickupToZone > zoneRadius) {
        return { eligible: false, distanceMiles, reason: "outside_driver_zone" };
      }
      const rideDropoffLat = Number(rideData.dropoffLat);
      const rideDropoffLng = Number(rideData.dropoffLng);
      if (Number.isFinite(rideDropoffLat) && Number.isFinite(rideDropoffLng)) {
        const dropoffToZone = calculateHaversineMiles(rideDropoffLat, rideDropoffLng, zoneLat, zoneLng);
        if (dropoffToZone > zoneRadius) {
          return { eligible: false, distanceMiles, reason: "outside_driver_zone" };
        }
      }
    }
  }

  return { eligible: true, distanceMiles };
}

/**
 * Privacy-safe nearby online driver pins for the passenger map.
 * Strips all driver UIDs, names, phone numbers, plates, and active ride metadata.
 */
export async function getSanitizedNearbyDrivers(
  input: GetNearbyDriversInput
): Promise<{
  success: true;
  drivers: SanitizedNearbyDriverPin[];
  count: number;
  availableSoonCount: number;
  availableCategories: string[];
  estimatedWaitEta: number | null;
}> {
  const { db, lat, lng, vehicleCategory, isPetFriendly, excludeUid } = input;
  if (!db) throw new BadRequestError("Database backend unavailable.");
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw new BadRequestError("Valid latitude and longitude coordinates are required.");
  }

  const radiusMiles = Math.min(
    MAX_OFFER_RADIUS_MILES,
    Math.max(0.5, Number(input.radiusMiles) || 10)
  );
  const maxResults = Math.min(50, Math.max(1, Math.floor(Number(input.maxResults) || 25)));
  const nowMs = input.nowMs ?? Date.now();

  const snapshot = await db
    .collection("live_tracking")
    .where("isOnline", "==", true)
    .get();

  const docs = snapshot?.docs || [];
  const pins: SanitizedNearbyDriverPin[] = [];
  const categorySet = new Set<string>();
  let availableSoonCount = 0;
  let minEtaMins: number | null = null;

  for (const docSnap of docs) {
    const data = typeof docSnap.data === "function" ? docSnap.data() : docSnap.data || {};
    const driverUid = docSnap.id || data.driverId;
    if (excludeUid && driverUid === excludeUid) continue;
    if (data.isOnline !== true) continue;
    if (data.isLastJob === true || data.lastJobMode === true) continue;
    if (data.onBreak === true) continue;
    if (!isTrackingHeartbeatFresh(data, nowMs)) continue;

    if (isPetFriendly === true && data.isPetFriendly !== true && data.petFriendly !== true) {
      continue;
    }

    const status = String(data.status || "available").toLowerCase();
    if (status === "busy") continue;

    const categories = extractDriverCategories(data);

    if (status === "on_ride") {
      const canStack = data.isStackingEnabled === true || data.allowJobStacking === true;
      const dropLat = Number(data.dropoffLat);
      const dropLng = Number(data.dropoffLng);
      if (!canStack || !Number.isFinite(dropLat) || !Number.isFinite(dropLng)) continue;

      const dropToPickup = calculateHaversineMiles(lat, lng, dropLat, dropLng);
      if (dropToPickup > radiusMiles) continue;
      if (!matchesVehicleCategory(categories, vehicleCategory)) continue;

      categories.forEach((c) => categorySet.add(c));
      availableSoonCount += 1;
      const curLat = Number(data.lat);
      const curLng = Number(data.lng);
      const legRemaining =
        Number.isFinite(curLat) && Number.isFinite(curLng)
          ? calculateHaversineMiles(curLat, curLng, dropLat, dropLng)
          : 0;
      const eta = Math.max(1, Math.round(legRemaining * 4 + 3 + dropToPickup * 4));
      if (minEtaMins === null || eta < minEtaMins) minEtaMins = eta;
      continue;
    }

    const dLat = Number(data.lat);
    const dLng = Number(data.lng);
    if (!Number.isFinite(dLat) || !Number.isFinite(dLng)) continue;

    const distanceMiles = calculateHaversineMiles(lat, lng, dLat, dLng);
    if (distanceMiles > radiusMiles) continue;

    if (!matchesVehicleCategory(categories, vehicleCategory)) continue;

    categories.forEach((c) => categorySet.add(c));
    const eta = Math.max(1, Math.round(distanceMiles * 4));
    if (minEtaMins === null || eta < minEtaMins) minEtaMins = eta;

    pins.push({
      // Round to ~110m precision so idle drivers cannot be deanonymized to exact house addresses
      lat: Math.round(dLat * 1000) / 1000,
      lng: Math.round(dLng * 1000) / 1000,
      heading: Number.isFinite(Number(data.heading)) ? Math.round(Number(data.heading)) : null,
      vehicleCategory: categories[0] || "standard",
      vehicleCategories: categories,
      status: "available",
      distanceMiles: Math.round(distanceMiles * 100) / 100,
    });
  }

  pins.sort((a, b) => a.distanceMiles - b.distanceMiles);
  const limited = pins.slice(0, maxResults);

  return {
    success: true,
    drivers: limited,
    count: limited.length,
    availableSoonCount,
    availableCategories: Array.from(categorySet),
    estimatedWaitEta: minEtaMins,
  };
}

/**
 * Server-authoritative Ride Offer FCM Push Dispatch.
 * Matches eligible, approved online drivers and sends high-priority `ride_offers_urgent` FCM pushes.
 */
export async function dispatchRideOffersCommand(
  input: DispatchRideOffersInput
): Promise<DispatchRideOffersResult> {
  const { db, caller, rideId, messagingClient } = input;
  if (!caller?.uid) {
    throw new UnauthorizedError("Authentication required to dispatch ride offers.");
  }
  if (!db) {
    throw new BadRequestError("Database backend unavailable.");
  }
  if (!rideId || typeof rideId !== "string" || !rideId.trim()) {
    throw new BadRequestError("Valid rideId is required.");
  }

  const nowMs = input.nowMs ?? Date.now();
  const radiusMiles = Math.min(
    MAX_OFFER_RADIUS_MILES,
    Math.max(1, Number(input.radiusMiles) || DEFAULT_OFFER_RADIUS_MILES)
  );
  const maxDrivers = Math.min(
    MAX_OFFER_DRIVERS,
    Math.max(1, Math.floor(Number(input.maxDrivers) || DEFAULT_MAX_OFFER_DRIVERS))
  );

  const rideRef = db.collection("ride_requests").doc(rideId.trim());
  const rideSnap = await rideRef.get();
  const rideExists =
    rideSnap && (typeof rideSnap.exists === "function" ? rideSnap.exists() : rideSnap.exists);
  if (!rideExists) {
    throw new NotFoundError("Ride request not found.");
  }

  const rideData =
    (typeof rideSnap.data === "function" ? rideSnap.data() : rideSnap.data) || {};
  const passengerId = rideData.passengerId || rideData.riderId || rideData.userId || null;
  const isAdmin = caller.isAdmin === true || caller.admin === true;

  if (!isAdmin && (!passengerId || passengerId !== caller.uid)) {
    throw new ForbiddenError("You are not authorized to dispatch offers for this ride.");
  }

  const rideStatus = String(rideData.status || "pending").toLowerCase();
  if (!OPEN_RIDE_STATUSES.has(rideStatus) || rideData.driverId || rideData.assignedDriverId) {
    throw new ConflictError("Ride is no longer open for driver offers.");
  }

  // Hold future pre-booked rides until within the 25-minute dispatch window
  if (!isRideReadyForInstantDispatch(rideData, nowMs)) {
    return {
      success: true,
      rideId: rideId.trim(),
      throttled: true,
      matchedDrivers: 0,
      dispatchedCount: 0,
      deliveredCount: 0,
      skippedNoTokensCount: 0,
    };
  }

  const lastDispatchMs =
    parseTimestampMs(rideData.lastOfferDispatchAtMs) ??
    parseTimestampMs(rideData.lastOfferDispatchAt);
  if (
    !input.force &&
    lastDispatchMs !== null &&
    nowMs - lastDispatchMs < OFFER_DISPATCH_COOLDOWN_MS
  ) {
    return {
      success: true,
      rideId: rideId.trim(),
      throttled: true,
      retryAfterMs: OFFER_DISPATCH_COOLDOWN_MS - (nowMs - lastDispatchMs),
      matchedDrivers: 0,
      dispatchedCount: 0,
      deliveredCount: 0,
      skippedNoTokensCount: 0,
    };
  }

  const onlineSnapshot = await db
    .collection("live_tracking")
    .where("isOnline", "==", true)
    .get();

  const onlineEntries: Array<{ driverUid: string; trackingData: Record<string, any> }> = [];
  for (const docSnap of onlineSnapshot?.docs || []) {
    const trackingData =
      (typeof docSnap.data === "function" ? docSnap.data() : docSnap.data) || {};
    const driverUid = String(docSnap.id || trackingData.driverId || "").trim();
    if (!driverUid) continue;
    onlineEntries.push({ driverUid, trackingData });
  }

  // Pre-filter on live_tracking fields first before batch-loading users & metrics
  const preFiltered = onlineEntries.filter(({ driverUid, trackingData }) => {
    const evalRes = evaluateDriverOfferCandidate({
      driverUid,
      trackingData,
      rideData,
      passengerId,
      radiusMiles,
      nowMs,
      ignoreWaitTolerance: true,
    });
    return evalRes.eligible;
  });

  const candidateUids = preFiltered.map((e) => e.driverUid);
  const [usersMap, metricsMap] = await Promise.all([
    batchGetDocs(db, "users", candidateUids),
    batchGetDocs(db, "driver_metrics", candidateUids),
  ]);

  const verifiedCandidates: Array<{
    driverUid: string;
    distanceMiles: number;
    isStacked: boolean;
    fairnessScore: number;
  }> = [];

  for (const { driverUid, trackingData } of preFiltered) {
    const userData = usersMap.get(driverUid);
    if (!userData) continue;
    try {
      assertAuthoritativeDriverEligibility(userData, driverUid);
    } catch {
      continue;
    }
    const metricsData = metricsMap.get(driverUid);
    const fullEval = evaluateDriverOfferCandidate({
      driverUid,
      trackingData,
      rideData,
      passengerId,
      radiusMiles,
      nowMs,
      metricsData,
      userData,
      ignoreWaitTolerance: true,
    });
    if (!fullEval.eligible) continue;

    const isStacked = String(trackingData.status || "").toLowerCase() === "on_ride";
    const fairness = computeDriverFairnessScore({
      distanceMiles: fullEval.distanceMiles,
      metricsData,
      userData,
      trackingData,
      rideData,
      isStacked,
      nowMs,
    });
    verifiedCandidates.push({
      driverUid,
      distanceMiles: Math.round(fullEval.distanceMiles * 100) / 100,
      isStacked,
      fairnessScore: fairness.totalScore,
    });
  }

  verifiedCandidates.sort((a, b) => {
    if (b.fairnessScore !== a.fairnessScore) return b.fairnessScore - a.fairnessScore;
    return a.distanceMiles - b.distanceMiles;
  });
  const selectedCandidates = verifiedCandidates.slice(0, maxDrivers);

  const expiresAtMs = nowMs + OFFER_EXPIRY_MS;
  const fareEstimateNum = Number(rideData.fareEstimate ?? rideData.estimatedFare ?? rideData.fare ?? 0);
  const fareDisplay =
    Number.isFinite(fareEstimateNum) && fareEstimateNum > 0
      ? `£${fareEstimateNum.toFixed(2)}`
      : "Fare est.";
  const pickupShort = String(rideData.pickupAddress || rideData.pickup || "Nearby pickup").slice(0, 80);
  const dropoffShort = String(rideData.dropoffAddress || rideData.dropoff || "Destination").slice(0, 80);
  const title = rideData.isPriority ? "Priority Ride Offer" : "New Ride Offer";
  const stopCount = Array.isArray(rideData.stops) ? rideData.stops.length : 0;
  const passengerRating = Number(rideData.passengerRating ?? 4.9);
  const paymentMethod = String(rideData.paymentMethod || (rideData.hasCardOnFile ? "card" : "cash"));

  let dispatchedCount = 0;
  let deliveredCount = 0;
  let skippedNoTokensCount = 0;
  const notifiedDriverIds: string[] = [];

  for (const candidate of selectedCandidates) {
    const pushType = candidate.isStacked ? "stacked_ride_offer" : "ride_offer";
    const candidateTitle = candidate.isStacked ? "Stacked Next Ride Offer" : title;
    const body = `${fareDisplay} • ${candidate.distanceMiles.toFixed(1)} mi away • ${pickupShort} -> ${dropoffShort}`;
    const result = await dispatchAuthoritativeFcmPush(db, messagingClient, {
      recipientId: candidate.driverUid,
      title: candidateTitle,
      body,
      channelId: RIDE_OFFER_CHANNEL_ID,
      eventType: pushType,
      data: {
        type: pushType,
        rideId: rideId.trim(),
        pickupAddress: pickupShort,
        dropoffAddress: dropoffShort,
        pickupLat: String(rideData.pickupLat ?? ""),
        pickupLng: String(rideData.pickupLng ?? ""),
        dropoffLat: String(rideData.dropoffLat ?? ""),
        dropoffLng: String(rideData.dropoffLng ?? ""),
        fareEstimate: String(fareEstimateNum || ""),
        surgeMultiplier: String(rideData.surgeMultiplier ?? 1),
        vehicleCategory: normalizeCategory(rideData.carCategory || rideData.vehicleCategory),
        isPriority: String(Boolean(rideData.isPriority)),
        isPetFriendly: String(Boolean(rideData.isPetFriendly)),
        stopCount: String(stopCount),
        passengerRating: String(Number.isFinite(passengerRating) ? passengerRating : 4.9),
        paymentMethod,
        dispatchMode: "broadcast",
        distanceMiles: String(candidate.distanceMiles),
        offeredAtMs: String(nowMs),
        expiresAtMs: String(expiresAtMs),
      },
    });

    notifiedDriverIds.push(candidate.driverUid);
    if (result.status === "skipped_no_tokens") {
      skippedNoTokensCount += 1;
    } else {
      dispatchedCount += 1;
      deliveredCount += result.deliveredCount || 0;
    }
  }

  const existingOffered = Array.isArray(rideData.offeredDriverIds) ? rideData.offeredDriverIds : [];
  const mergedOffered = Array.from(new Set([...existingOffered, ...notifiedDriverIds])).slice(0, 100);

  await rideRef.update({
    lastOfferDispatchAt: admin.firestore.FieldValue.serverTimestamp(),
    lastOfferDispatchAtMs: nowMs,
    offeredDriverIds: mergedOffered,
    offerDispatchCount: admin.firestore.FieldValue.increment(1),
    dispatchMode: "broadcast_fallback",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return {
    success: true,
    rideId: rideId.trim(),
    throttled: false,
    matchedDrivers: selectedCandidates.length,
    dispatchedCount,
    deliveredCount,
    skippedNoTokensCount,
    expiresAtMs,
  };
}

export interface FairnessDispatchRideResult {
  success: boolean;
  rideId: string;
  mode: "fairness_exclusive" | "broadcast_fallback" | "skipped";
  reason?: string;
  assignedDriverId?: string;
  fairnessScore?: number;
  matchedDrivers: number;
  dispatchedCount: number;
  deliveredCount: number;
  expiresAtMs?: number;
}

/**
 * Unified 3-Wave Hybrid Fairness + Broadcast Dispatch Engine for a single ride:
 * - Waves 1 & 2 (`dispatchAttempts < 2`): Exclusive Fairness-scored offer (`status: "offered"`, 15s)
 *   to the #1 eligible, approved, non-break driver using true Haversine miles, vehicle category,
 *   pet-friendly, working zone, destination mode, stacking, wait tolerance, and daily hours caps.
 * - Wave 3 (`dispatchAttempts >= 2`): Controlled broadcast fallback (`status: "pending"`) to top 5
 *   fairness-ranked eligible drivers with expanded radius (20 mi) and relaxed wait tolerance so
 *   passengers are never stranded.
 */
export async function runFairnessDispatchForRide(params: {
  db: any;
  rideId: string;
  messagingClient?: any;
  maxDailyDriverHours?: number;
  exclusiveTimeoutMs?: number;
  radiusMiles?: number;
  nowMs?: number;
  force?: boolean;
}): Promise<FairnessDispatchRideResult> {
  const {
    db,
    rideId,
    messagingClient,
    maxDailyDriverHours = DEFAULT_MAX_DAILY_DRIVER_HOURS,
    exclusiveTimeoutMs = EXCLUSIVE_OFFER_TIMEOUT_MS,
    radiusMiles = DEFAULT_OFFER_RADIUS_MILES,
    nowMs = Date.now(),
    force = false,
  } = params;

  if (!db || !rideId || !rideId.trim()) {
    return { success: false, rideId: String(rideId || ""), mode: "skipped", reason: "invalid_args", matchedDrivers: 0, dispatchedCount: 0, deliveredCount: 0 };
  }

  const cleanRideId = rideId.trim();
  const rideRef = db.collection("ride_requests").doc(cleanRideId);
  const rideSnap = await rideRef.get();
  const rideExists =
    rideSnap && (typeof rideSnap.exists === "function" ? rideSnap.exists() : rideSnap.exists);
  if (!rideExists) {
    return { success: false, rideId: cleanRideId, mode: "skipped", reason: "not_found", matchedDrivers: 0, dispatchedCount: 0, deliveredCount: 0 };
  }

  const rideData = (typeof rideSnap.data === "function" ? rideSnap.data() : rideSnap.data) || {};
  const rideStatus = String(rideData.status || "").toLowerCase();
  if (rideStatus !== "pending" && rideStatus !== "searching") {
    return { success: true, rideId: cleanRideId, mode: "skipped", reason: `status_${rideStatus}`, matchedDrivers: 0, dispatchedCount: 0, deliveredCount: 0 };
  }
  if (rideData.driverId || rideData.assignedDriverId) {
    return { success: true, rideId: cleanRideId, mode: "skipped", reason: "already_assigned", matchedDrivers: 0, dispatchedCount: 0, deliveredCount: 0 };
  }
  if (!isRideReadyForInstantDispatch(rideData, nowMs)) {
    return { success: true, rideId: cleanRideId, mode: "skipped", reason: "scheduled_future", matchedDrivers: 0, dispatchedCount: 0, deliveredCount: 0 };
  }

  const passengerId = rideData.passengerId || rideData.riderId || rideData.userId || null;
  const attempts = Math.max(0, Math.floor(Number(rideData.dispatchAttempts || 0)));
  const isWave3Broadcast = attempts >= 2;

  if (isWave3Broadcast) {
    const lastDispatchMs =
      parseTimestampMs(rideData.lastOfferDispatchAtMs) ??
      parseTimestampMs(rideData.lastOfferDispatchAt);
    if (!force && lastDispatchMs !== null && nowMs - lastDispatchMs < OFFER_DISPATCH_COOLDOWN_MS) {
      return { success: true, rideId: cleanRideId, mode: "skipped", reason: "cooldown", matchedDrivers: 0, dispatchedCount: 0, deliveredCount: 0 };
    }
    const broadcastRes = await dispatchRideOffersCommand({
      db,
      caller: { uid: passengerId || "system_dispatcher", isAdmin: true },
      rideId: cleanRideId,
      messagingClient,
      radiusMiles: Math.max(radiusMiles, BROADCAST_EXPANDED_RADIUS_MILES),
      maxDrivers: BROADCAST_FALLBACK_MAX_DRIVERS,
      force: true,
      nowMs,
    });
    return {
      success: broadcastRes.success,
      rideId: cleanRideId,
      mode: "broadcast_fallback",
      matchedDrivers: broadcastRes.matchedDrivers,
      dispatchedCount: broadcastRes.dispatchedCount,
      deliveredCount: broadcastRes.deliveredCount,
      expiresAtMs: broadcastRes.expiresAtMs,
    };
  }

  // Waves 1 & 2: Exclusive Fairness-Scored Dispatch
  const onlineSnapshot = await db
    .collection("live_tracking")
    .where("isOnline", "==", true)
    .get();

  const onlineEntries: Array<{ driverUid: string; trackingData: Record<string, any> }> = [];
  for (const docSnap of onlineSnapshot?.docs || []) {
    const trackingData =
      (typeof docSnap.data === "function" ? docSnap.data() : docSnap.data) || {};
    const driverUid = String(docSnap.id || trackingData.driverId || "").trim();
    if (!driverUid) continue;
    onlineEntries.push({ driverUid, trackingData });
  }

  if (onlineEntries.length === 0) {
    return { success: true, rideId: cleanRideId, mode: "skipped", reason: "no_online_drivers", matchedDrivers: 0, dispatchedCount: 0, deliveredCount: 0 };
  }

  const candidateUids = onlineEntries.map((e) => e.driverUid);
  const [usersMap, metricsMap, statusMap] = await Promise.all([
    batchGetDocs(db, "users", candidateUids),
    batchGetDocs(db, "driver_metrics", candidateUids),
    batchGetDocs(db, "driver_status", candidateUids),
  ]);

  const scoredCandidates: Array<{
    driverUid: string;
    distanceMiles: number;
    isStacked: boolean;
    fairnessScore: number;
  }> = [];

  for (const { driverUid, trackingData } of onlineEntries) {
    const statusData = statusMap.get(driverUid);
    // Skip if driver is already considering a different exclusive offer or marked onBreak in driver_status
    if (statusData) {
      if (statusData.onBreak === true) continue;
      if (statusData.pendingRideId && statusData.pendingRideId !== cleanRideId) continue;
    }

    const userData = usersMap.get(driverUid);
    if (!userData) continue;
    try {
      assertAuthoritativeDriverEligibility(userData, driverUid);
    } catch {
      continue;
    }

    const metricsData = metricsMap.get(driverUid);
    const evaluation = evaluateDriverOfferCandidate({
      driverUid,
      trackingData,
      rideData,
      passengerId,
      radiusMiles,
      nowMs,
      metricsData,
      userData,
      maxDailyDriverHours,
      ignoreWaitTolerance: attempts >= 1, // Strict waitTolerance on Wave 1, relaxed on Wave 2
    });
    if (!evaluation.eligible) continue;

    const isStacked = String(trackingData.status || "").toLowerCase() === "on_ride";
    const fairness = computeDriverFairnessScore({
      distanceMiles: evaluation.distanceMiles,
      metricsData,
      userData,
      trackingData,
      rideData,
      isStacked,
      nowMs,
    });

    scoredCandidates.push({
      driverUid,
      distanceMiles: Math.round(evaluation.distanceMiles * 100) / 100,
      isStacked,
      fairnessScore: fairness.totalScore,
    });
  }

  if (scoredCandidates.length === 0) {
    return { success: true, rideId: cleanRideId, mode: "skipped", reason: "no_eligible_drivers", matchedDrivers: 0, dispatchedCount: 0, deliveredCount: 0 };
  }

  scoredCandidates.sort((a, b) => {
    if (b.fairnessScore !== a.fairnessScore) return b.fairnessScore - a.fairnessScore;
    return a.distanceMiles - b.distanceMiles;
  });

  const winner = scoredCandidates[0];
  const expiresAtMs = nowMs + Math.max(5_000, Math.min(60_000, exclusiveTimeoutMs));

  // Atomically transition ride from pending -> offered (prevents race with accept/cancel)
  const locked = await db.runTransaction(async (tx: any) => {
    const freshSnap = await tx.get(rideRef);
    const exists =
      freshSnap && (typeof freshSnap.exists === "function" ? freshSnap.exists() : freshSnap.exists);
    if (!exists) return false;
    const freshRide = (typeof freshSnap.data === "function" ? freshSnap.data() : freshSnap.data) || {};
    const st = String(freshRide.status || "").toLowerCase();
    if ((st !== "pending" && st !== "searching") || freshRide.driverId || freshRide.assignedDriverId) {
      return false;
    }

    const existingOffered = Array.isArray(freshRide.offeredDriverIds) ? freshRide.offeredDriverIds : [];
    const mergedOffered = Array.from(new Set([...existingOffered, winner.driverUid])).slice(0, 100);

    tx.update(rideRef, {
      status: "offered",
      assignedDriverId: winner.driverUid,
      offerExpiresAt: new Date(expiresAtMs).toISOString(),
      offerExpiresAtMs: expiresAtMs,
      dispatchWave: attempts + 1,
      dispatchMode: "fairness_exclusive",
      dispatchAttempts: admin.firestore.FieldValue.increment(1),
      offeredDriverIds: mergedOffered,
      lastOfferDispatchAt: admin.firestore.FieldValue.serverTimestamp(),
      lastOfferDispatchAtMs: nowMs,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    tx.set(
      db.collection("driver_status").doc(winner.driverUid),
      {
        pendingRideId: cleanRideId,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return true;
  });

  if (!locked) {
    return { success: true, rideId: cleanRideId, mode: "skipped", reason: "race_already_claimed", matchedDrivers: scoredCandidates.length, dispatchedCount: 0, deliveredCount: 0 };
  }

  const fareEstimateNum = Number(rideData.fareEstimate ?? rideData.estimatedFare ?? rideData.fare ?? 0);
  const fareStr =
    Number.isFinite(fareEstimateNum) && fareEstimateNum > 0
      ? fareEstimateNum.toFixed(2)
      : "";
  const pickupAddress = String(rideData.pickupAddress || rideData.pickup || "Nearby pickup").slice(0, 80);
  const dropoffAddress = String(rideData.dropoffAddress || rideData.dropoff || "Destination").slice(0, 80);
  const vehicleCategory = normalizeCategory(rideData.carCategory || rideData.vehicleCategory);
  const surgeMultiplier = Number(rideData.surgeMultiplier || 1);
  const stopCount = Array.isArray(rideData.stops) ? rideData.stops.length : 0;
  const passengerRating = Number(rideData.passengerRating ?? 4.9);
  const paymentMethod = String(rideData.paymentMethod || (rideData.hasCardOnFile ? "card" : "cash"));
  const pushType = winner.isStacked ? "stacked_ride_offer" : "ride_offer";
  const title = winner.isStacked
    ? fareStr ? `Stacked Next Ride — £${fareStr}` : "Stacked Next Ride Offer"
    : rideData.isPriority
      ? fareStr ? `Priority Ride Offer — £${fareStr}` : "Priority Ride Offer"
      : fareStr ? `New Ride Offer — £${fareStr}` : "New Ride Offer Nearby";

  const pushRes = await dispatchAuthoritativeFcmPush(db, messagingClient, {
    recipientId: winner.driverUid,
    title,
    body: `${winner.distanceMiles.toFixed(1)} mi away • ${pickupAddress} → ${dropoffAddress}`,
    channelId: RIDE_OFFER_CHANNEL_ID,
    eventType: pushType,
    data: {
      type: pushType,
      rideId: cleanRideId,
      pickupAddress,
      dropoffAddress,
      pickupLat: String(rideData.pickupLat ?? ""),
      pickupLng: String(rideData.pickupLng ?? ""),
      dropoffLat: String(rideData.dropoffLat ?? ""),
      dropoffLng: String(rideData.dropoffLng ?? ""),
      fareEstimate: fareStr,
      surgeMultiplier: String(surgeMultiplier),
      vehicleCategory,
      isPriority: String(Boolean(rideData.isPriority)),
      isPetFriendly: String(Boolean(rideData.isPetFriendly || rideData.petFriendly)),
      stopCount: String(stopCount),
      passengerRating: String(Number.isFinite(passengerRating) ? passengerRating : 4.9),
      paymentMethod,
      dispatchMode: "fairness_exclusive",
      distanceMiles: String(winner.distanceMiles),
      offeredAtMs: String(nowMs),
      expiresAtMs: String(expiresAtMs),
      route: `/driver-terminal?rideId=${encodeURIComponent(cleanRideId)}`,
    },
  });

  const dispatchedCount = pushRes.status === "skipped_no_tokens" ? 0 : 1;
  return {
    success: true,
    rideId: cleanRideId,
    mode: "fairness_exclusive",
    assignedDriverId: winner.driverUid,
    fairnessScore: winner.fairnessScore,
    matchedDrivers: scoredCandidates.length,
    dispatchedCount,
    deliveredCount: pushRes.deliveredCount || 0,
    expiresAtMs,
  };
}

/**
 * Full Background Fairness Dispatch & Expired-Offer Sweep Cycle (called every 10s by server.ts).
 * 1. Sweeps expired `offered` rides atomically (records missed/declined telemetry, returns to `pending`).
 * 2. Processes `pending` rides with `isPriority === true` FIRST, then oldest `createdAt` first,
 *    routing through the unified 3-wave `runFairnessDispatchForRide` engine.
 */
export async function runFairnessDispatchCycle(params: {
  db: any;
  messagingClient?: any;
  maxDailyDriverHours?: number;
  exclusiveTimeoutMs?: number;
  radiusMiles?: number;
  nowMs?: number;
  isFenced?: () => boolean;
}): Promise<{
  expiredReclaimed: number;
  processedPending: number;
  dispatchedExclusive: number;
  dispatchedBroadcast: number;
}> {
  const {
    db,
    messagingClient,
    maxDailyDriverHours = DEFAULT_MAX_DAILY_DRIVER_HOURS,
    exclusiveTimeoutMs = EXCLUSIVE_OFFER_TIMEOUT_MS,
    radiusMiles = DEFAULT_OFFER_RADIUS_MILES,
    nowMs = Date.now(),
    isFenced = () => false,
  } = params;

  let expiredReclaimed = 0;
  let processedPending = 0;
  let dispatchedExclusive = 0;
  let dispatchedBroadcast = 0;

  if (!db) {
    return { expiredReclaimed, processedPending, dispatchedExclusive, dispatchedBroadcast };
  }

  // Step 1: Reclaim expired exclusive offers FIRST so they re-dispatch in the same cycle!
  const offeredSnap = await db.collection("ride_requests").where("status", "==", "offered").get();
  for (const rideDoc of offeredSnap?.docs || []) {
    if (isFenced()) break;
    const ride = (typeof rideDoc.data === "function" ? rideDoc.data() : rideDoc.data) || {};
    const expMs =
      parseTimestampMs(ride.offerExpiresAtMs) ?? parseTimestampMs(ride.offerExpiresAt);
    if (expMs === null || expMs >= nowMs) continue;

    const timedOutDriverId = String(ride.assignedDriverId || "").trim();
    const reclaimed = await db.runTransaction(async (tx: any) => {
      const freshSnap = await tx.get(rideDoc.ref);
      const exists =
        freshSnap && (typeof freshSnap.exists === "function" ? freshSnap.exists() : freshSnap.exists);
      if (!exists) return false;
      const freshRide = (typeof freshSnap.data === "function" ? freshSnap.data() : freshSnap.data) || {};
      if (freshRide.status !== "offered" || freshRide.driverId) return false;

      const patch: Record<string, any> = {
        status: "pending",
        assignedDriverId: admin.firestore.FieldValue.delete(),
        offerExpiresAt: admin.firestore.FieldValue.delete(),
        offerExpiresAtMs: admin.firestore.FieldValue.delete(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      if (timedOutDriverId) {
        patch.declinedDriverIds = admin.firestore.FieldValue.arrayUnion(timedOutDriverId);
        patch.declinedBy = admin.firestore.FieldValue.arrayUnion(timedOutDriverId);
      }
      tx.update(rideDoc.ref, patch);

      if (timedOutDriverId) {
        tx.set(
          db.collection("driver_status").doc(timedOutDriverId),
          {
            pendingRideId: admin.firestore.FieldValue.delete(),
            consecutiveDeclines: admin.firestore.FieldValue.increment(1),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        tx.set(
          db.collection("driver_metrics").doc(timedOutDriverId),
          {
            declinedOffersCount: admin.firestore.FieldValue.increment(1),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      }
      return true;
    });

    if (reclaimed) {
      expiredReclaimed += 1;
    }
  }

  // Step 2: Process pending rides — Priority Boost first, then FIFO by createdAt
  const pendingSnap = await db.collection("ride_requests").where("status", "==", "pending").get();
  const pendingDocs = [...(pendingSnap?.docs || [])].sort((a, b) => {
    const ra = (typeof a.data === "function" ? a.data() : a.data) || {};
    const rb = (typeof b.data === "function" ? b.data() : b.data) || {};
    const prioDiff = (rb.isPriority === true ? 1 : 0) - (ra.isPriority === true ? 1 : 0);
    if (prioDiff !== 0) return prioDiff;
    const ca = parseTimestampMs(ra.createdAt) ?? 0;
    const cb = parseTimestampMs(rb.createdAt) ?? 0;
    return ca - cb;
  });

  for (const rideDoc of pendingDocs) {
    if (isFenced()) break;
    processedPending += 1;
    const res = await runFairnessDispatchForRide({
      db,
      rideId: rideDoc.id,
      messagingClient,
      maxDailyDriverHours,
      exclusiveTimeoutMs,
      radiusMiles,
      nowMs,
    });
    if (res.mode === "fairness_exclusive") dispatchedExclusive += 1;
    if (res.mode === "broadcast_fallback") dispatchedBroadcast += 1;
  }

  return { expiredReclaimed, processedPending, dispatchedExclusive, dispatchedBroadcast };
}

/**
 * P1-2: Server-authoritative Ride Offer Decline for instant re-dispatch.
 * Atomically releases an "offered" ride back to "pending" and records the declining driver
 * in both `declinedDriverIds` and `declinedBy` so fairness dispatch immediately pings the next driver.
 */
export async function executeDeclineRideOfferCommand(params: {
  db: any;
  caller: CallerContext;
  rideId: string;
}): Promise<{ success: true; rideId: string; status: string }> {
  const { db, caller, rideId } = params;
  if (!caller?.uid) throw new UnauthorizedError("Authentication required.");
  if (!db) throw new BadRequestError("Database backend unavailable.");
  if (!rideId || typeof rideId !== "string" || !rideId.trim()) {
    throw new BadRequestError("Valid rideId is required.");
  }

  const cleanRideId = rideId.trim();
  const callerUid = caller.uid;
  const rideRef = db.collection("ride_requests").doc(cleanRideId);
  const driverStatusRef = db.collection("driver_status").doc(callerUid);

  return db.runTransaction(async (tx: any) => {
    const rideSnap = await tx.get(rideRef);
    const exists =
      rideSnap && (typeof rideSnap.exists === "function" ? rideSnap.exists() : rideSnap.exists);
    if (!exists) throw new NotFoundError("Ride request not found.");

    const rideData =
      (typeof rideSnap.data === "function" ? rideSnap.data() : rideSnap.data) || {};

    if (rideData.driverId) {
      throw new ConflictError("Ride has already been accepted.");
    }

    const isOfferedToCaller =
      rideData.status === "offered" && rideData.assignedDriverId === callerUid;
    const isOpenBroadcast =
      rideData.status === "pending" || rideData.status === "searching";

    if (!isOfferedToCaller && !isOpenBroadcast) {
      throw new ForbiddenError("You cannot decline a ride that is not offered to you.");
    }

    const existingDeclined = Array.from(
      new Set([
        ...(Array.isArray(rideData.declinedDriverIds) ? rideData.declinedDriverIds : []),
        ...(Array.isArray(rideData.declinedBy) ? rideData.declinedBy : []),
        callerUid,
      ])
    ).slice(0, 100);

    const ridePatch: Record<string, any> = {
      declinedDriverIds: existingDeclined,
      declinedBy: existingDeclined,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (isOfferedToCaller) {
      ridePatch.status = "pending";
      ridePatch.assignedDriverId = admin.firestore.FieldValue.delete();
      ridePatch.offerExpiresAt = admin.firestore.FieldValue.delete();
      ridePatch.offerExpiresAtMs = admin.firestore.FieldValue.delete();
    }

    tx.update(rideRef, ridePatch);

    tx.set(
      driverStatusRef,
      {
        pendingRideId: admin.firestore.FieldValue.delete(),
        consecutiveDeclines: admin.firestore.FieldValue.increment(1),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    tx.set(
      db.collection("driver_metrics").doc(callerUid),
      {
        declinedOffersCount: admin.firestore.FieldValue.increment(1),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return {
      success: true as const,
      rideId: cleanRideId,
      status: isOfferedToCaller ? "pending" : String(rideData.status || "pending"),
    };
  });
}

/**
 * P1-4: Server-authoritative Driver -> Passenger Rating.
 * Persists review to `passenger_reviews/{rideId}` and updates rolling `passengerRating` on `users/{passengerId}`.
 */
export async function executeRatePassengerCommand(params: {
  db: any;
  caller: CallerContext;
  rideId: string;
  rating: number;
  tags?: string[];
  comment?: string;
}): Promise<{
  success: true;
  rideId: string;
  passengerId: string;
  rating: number;
  passengerAverageRating: number;
}> {
  const { db, caller, rideId, rating, tags, comment } = params;
  if (!caller?.uid) throw new UnauthorizedError("Authentication required.");
  if (!db) throw new BadRequestError("Database backend unavailable.");
  if (!rideId || typeof rideId !== "string" || !rideId.trim()) {
    throw new BadRequestError("Valid rideId is required.");
  }

  const numericRating = Number(rating);
  if (!Number.isFinite(numericRating) || numericRating < 1 || numericRating > 5) {
    throw new BadRequestError("Rating must be a number between 1 and 5.");
  }
  const roundedRating = Math.round(numericRating * 10) / 10;
  const cleanTags = Array.isArray(tags)
    ? tags
        .filter((t) => typeof t === "string" && t.trim().length > 0)
        .map((t) => t.trim().slice(0, 40))
        .slice(0, 8)
    : [];
  const cleanComment = typeof comment === "string" ? comment.trim().slice(0, 500) : "";

  const cleanRideId = rideId.trim();
  const isAdmin = caller.isAdmin === true || caller.admin === true;
  const rideRef = db.collection("ride_requests").doc(cleanRideId);
  const reviewRef = db.collection("passenger_reviews").doc(cleanRideId);

  return db.runTransaction(async (tx: any) => {
    const [rideSnap, existingReviewSnap] = await Promise.all([
      tx.get(rideRef),
      tx.get(reviewRef),
    ]);
    const rideExists =
      rideSnap && (typeof rideSnap.exists === "function" ? rideSnap.exists() : rideSnap.exists);
    if (!rideExists) throw new NotFoundError("Ride request not found.");

    const ride = (typeof rideSnap.data === "function" ? rideSnap.data() : rideSnap.data) || {};
    const assignedDriverId = ride.driverId || ride.assignedDriverId;
    const passengerId = ride.passengerId || ride.riderId || ride.userId;

    if (!isAdmin && (!assignedDriverId || assignedDriverId !== caller.uid)) {
      throw new ForbiddenError("Only the assigned driver can rate the passenger for this ride.");
    }
    if (!["completed", "rider_abandoned"].includes(String(ride.status || ""))) {
      throw new ConflictError("Passengers can only be rated after trip completion.");
    }
    if (!passengerId || typeof passengerId !== "string") {
      throw new BadRequestError("Ride has no associated passenger account to rate.");
    }

    const reviewExists =
      existingReviewSnap &&
      (typeof existingReviewSnap.exists === "function"
        ? existingReviewSnap.exists()
        : existingReviewSnap.exists);
    if (reviewExists) {
      throw new ConflictError("Passenger has already been rated for this trip.");
    }

    const passengerRef = db.collection("users").doc(passengerId);
    const passengerSnap = await tx.get(passengerRef);
    const passengerExists =
      passengerSnap &&
      (typeof passengerSnap.exists === "function" ? passengerSnap.exists() : passengerSnap.exists);
    const passengerData = passengerExists
      ? (typeof passengerSnap.data === "function" ? passengerSnap.data() : passengerSnap.data) || {}
      : {};

    const prevCount = Number(passengerData.passengerRatingCount || 0);
    const prevAvg = Number(passengerData.passengerRating || 5.0);
    const nextCount = prevCount + 1;
    const nextAvg = Math.round(((prevAvg * prevCount + roundedRating) / nextCount) * 100) / 100;

    tx.set(
      reviewRef,
      {
        rideId: cleanRideId,
        driverId: assignedDriverId || caller.uid,
        passengerId,
        rating: roundedRating,
        tags: cleanTags,
        comment: cleanComment,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: false }
    );

    if (passengerExists) {
      tx.update(passengerRef, {
        passengerRating: nextAvg,
        passengerRatingCount: nextCount,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    tx.update(rideRef, {
      driverRatedPassenger: true,
      passengerRatingGiven: roundedRating,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return {
      success: true as const,
      rideId: cleanRideId,
      passengerId,
      rating: roundedRating,
      passengerAverageRating: nextAvg,
    };
  });
}

/**
 * Non-fatal post-commit FCM push alert for ride lifecycle counterparties
 * (e.g., driver accepted ride -> push passenger; passenger cancelled ride -> push assigned driver).
 */
export async function notifyRideCounterpartyPush(params: {
  db: any;
  messagingClient: any;
  rideId: string;
  recipientId?: string | null;
  title: string;
  body: string;
  eventType: string;
  channelId?: string;
  extraData?: Record<string, string>;
}): Promise<{ dispatched: boolean; status?: string }> {
  const { db, messagingClient, rideId, recipientId, title, body, eventType, channelId, extraData } =
    params;
  if (!db || !recipientId || typeof recipientId !== "string" || !recipientId.trim()) {
    return { dispatched: false, status: "skipped_no_recipient" };
  }

  try {
    const result = await dispatchAuthoritativeFcmPush(db, messagingClient, {
      recipientId: recipientId.trim(),
      title,
      body,
      channelId: channelId || RIDE_UPDATES_CHANNEL_ID,
      eventType,
      data: {
        type: eventType,
        rideId: String(rideId || ""),
        ...(extraData || {}),
      },
    });
    return { dispatched: result.success, status: result.status };
  } catch (err: any) {
    console.warn(`[AnyRollerPush] Non-fatal ${eventType} push error:`, err?.message || err);
    return { dispatched: false, status: "error" };
  }
}

export interface PassengerUpdateRideInput {
  db: any;
  caller: CallerContext;
  rideId: string;
  body: Record<string, any>;
}

/**
 * Server-authoritative passenger ride edit command.
 * - Pre-accept (`draft`, `pending`, `searching`, `offered`): allows full booking edits and cleanly transitions back to `pending`.
 * - Active (`accepted`, `arrived`, `in_progress`): locks pickup once `in_progress`, locks vehicle tier & pet flag,
 *   protects already-completed stops (`index < currentStopIndex`), recomputes fare server-side, and returns
 *   `assignedDriverId` so the caller can push a real-time update alert to the driver.
 */
export async function executePassengerUpdateRideCommand(
  input: PassengerUpdateRideInput
): Promise<{
  success: true;
  rideId: string;
  status: string;
  fareEstimate: number;
  previousFareEstimate: number;
  fareDeltaGbp: number;
  baseCalc: number;
  distanceMiles: number;
  durationMinutes: number;
  journeyRevision: number;
  editSummary: string;
  dropoff: string;
  dropoffLat: number;
  dropoffLng: number;
  stops: Array<{ address: string; coords: { lat: number; lng: number } }>;
  isActiveRideEdit: boolean;
  assignedDriverId?: string;
  shouldRedispatch: boolean;
}> {
  const { db, caller, rideId, body } = input;
  if (!caller?.uid) throw new UnauthorizedError("Authentication required.");
  if (!db) throw new BadRequestError("Database backend unavailable.");
  if (!rideId || typeof rideId !== "string" || !rideId.trim()) {
    throw new BadRequestError("Valid rideId is required.");
  }

  const cleanRideId = rideId.trim();
  const isAdmin = caller.isAdmin === true || caller.admin === true;
  const rideRef = db.collection("ride_requests").doc(cleanRideId);
  const ridesConfig = await loadRidesFareConfig(db);

  return db.runTransaction(async (tx: any) => {
    const rideSnap = await tx.get(rideRef);
    const exists =
      rideSnap && (typeof rideSnap.exists === "function" ? rideSnap.exists() : rideSnap.exists);
    if (!exists) throw new NotFoundError("Ride request not found.");

    const ride = (typeof rideSnap.data === "function" ? rideSnap.data() : rideSnap.data) || {};
    const passengerId = ride.passengerId || ride.riderId || ride.userId;
    if (!isAdmin && (!passengerId || passengerId !== caller.uid)) {
      throw new ForbiddenError("You are not authorized to edit this ride.");
    }

    const currentStatus = String(ride.status || "pending").toLowerCase();
    const isPreAccept = ["draft", "pending", "searching", "offered"].includes(currentStatus);
    const isActive = ["accepted", "arrived", "in_progress"].includes(currentStatus);

    if (!isPreAccept && !isActive) {
      throw new ConflictError(`Ride cannot be edited while in status '${currentStatus}'.`);
    }

    if (currentStatus === "in_progress" && ridesConfig.allowMidJourneyEdits === false && !isAdmin) {
      throw new ForbiddenError("Mid-journey route edits are currently disabled by platform policy.");
    }

    const assignedDriverId = isActive ? String(ride.driverId || ride.assignedDriverId || "").trim() : "";
    let driverCurrentCoords: { lat: number; lng: number } | null = null;
    if (assignedDriverId && currentStatus === "in_progress") {
      try {
        const driverTrackingSnap = await tx.get(db.collection("live_tracking").doc(assignedDriverId));
        const trackingExists =
          driverTrackingSnap &&
          (typeof driverTrackingSnap.exists === "function"
            ? driverTrackingSnap.exists()
            : driverTrackingSnap.exists);
        if (trackingExists) {
          const td =
            typeof driverTrackingSnap.data === "function"
              ? driverTrackingSnap.data()
              : driverTrackingSnap.data;
          if (td && Number.isFinite(Number(td.lat)) && Number.isFinite(Number(td.lng))) {
            driverCurrentCoords = { lat: Number(td.lat), lng: Number(td.lng) };
          }
        }
      } catch {
        // Optional in unit mocks
      }
    }

    const sanitizeCoord = (val: any, maxAbs: number): number | null => {
      const n = Number(val);
      return Number.isFinite(n) && Math.abs(n) <= maxAbs ? n : null;
    };

    const sanitizeStops = (rawStops: any): Array<{ address: string; coords: { lat: number; lng: number } }> => {
      if (!Array.isArray(rawStops)) return [];
      const cleaned: Array<{ address: string; coords: { lat: number; lng: number } }> = [];
      for (const s of rawStops.slice(0, 3)) {
        const addr = typeof s?.address === "string" ? s.address.trim().slice(0, 220) : "";
        const lat = sanitizeCoord(s?.coords?.lat ?? s?.lat, 90);
        const lng = sanitizeCoord(s?.coords?.lng ?? s?.lng, 180);
        if (addr && lat !== null && lng !== null) {
          cleaned.push({ address: addr, coords: { lat, lng } });
        }
      }
      return cleaned;
    };

    const allowedCatSet = new Set<string>(ALLOWED_VEHICLE_CATEGORIES as readonly string[]);
    const requestedCat = normalizeCategory(body.carCategory ?? body.vehicleCategory ?? ride.carCategory ?? "standard");
    const effectiveCategory = isActive
      ? normalizeCategory(ride.carCategory || ride.vehicleCategory || "standard")
      : allowedCatSet.has(requestedCat)
        ? requestedCat
        : "standard";

    const effectivePetFriendly = isActive
      ? Boolean(ride.isPetFriendly)
      : body.isPetFriendly !== undefined
        ? Boolean(body.isPetFriendly)
        : Boolean(ride.isPetFriendly);

    const effectivePriority = isActive
      ? Boolean(ride.isPriority)
      : body.isPriority !== undefined
        ? Boolean(body.isPriority)
        : Boolean(ride.isPriority);

    const isPickupLocked = currentStatus === "in_progress";
    const nextPickup = isPickupLocked
      ? String(ride.pickup || ride.pickupAddress || "")
      : typeof body.pickup === "string" && body.pickup.trim()
        ? body.pickup.trim().slice(0, 220)
        : String(ride.pickup || ride.pickupAddress || "");
    const nextPickupLat = isPickupLocked
      ? Number(ride.pickupLat)
      : sanitizeCoord(body.pickupLat, 90) ?? Number(ride.pickupLat);
    const nextPickupLng = isPickupLocked
      ? Number(ride.pickupLng)
      : sanitizeCoord(body.pickupLng, 180) ?? Number(ride.pickupLng);

    const nextDropoff =
      typeof body.dropoff === "string" && body.dropoff.trim()
        ? body.dropoff.trim().slice(0, 220)
        : String(ride.dropoff || ride.dropoffAddress || "");
    const nextDropoffLat = sanitizeCoord(body.dropoffLat, 90) ?? Number(ride.dropoffLat);
    const nextDropoffLng = sanitizeCoord(body.dropoffLng, 180) ?? Number(ride.dropoffLng);

    if (!nextPickup || !nextDropoff) {
      throw new BadRequestError("Valid pickup and dropoff addresses are required.");
    }

    // Protect already-completed stops during an in-progress journey
    const existingStops = Array.isArray(ride.stops) ? ride.stops : [];
    const currentStopIndex = Math.max(0, Math.floor(Number(ride.currentStopIndex || 0)));
    let nextStops = body.stops !== undefined ? sanitizeStops(body.stops) : existingStops;
    if (isActive && currentStopIndex > 0) {
      const lockedPrefix = existingStops.slice(0, currentStopIndex);
      const editableTail = nextStops.slice(currentStopIndex);
      nextStops = [...lockedPrefix, ...editableTail].slice(0, 3);
    }

    const clientDistanceMiles =
      Number.isFinite(Number(body.distanceMiles)) && Number(body.distanceMiles) > 0
        ? Math.min(500, Math.round(Number(body.distanceMiles) * 10) / 10)
        : Number(ride.distanceMiles || 0);
    const clientDurationMinutes =
      Number.isFinite(Number(body.durationMinutes)) && Number(body.durationMinutes) > 0
        ? Math.min(1440, Math.round(Number(body.durationMinutes)))
        : Number(ride.durationMinutes || 0);

    // Server-authoritative distance sanity & mid-journey distance-already-driven floor:
    // During in_progress edits, factor distance already travelled (pickup -> completed stops -> driver GPS)
    // PLUS remaining route (driver GPS -> remaining stops -> new dropoff) so a mid-journey detour/return
    // can never wipe out miles the driver already drove.
    let serverFloorMiles = 0;
    let routePricingMode: "mid_journey_actual_plus_remaining" | "point_to_point" = "point_to_point";
    const pickupPoint =
      Number.isFinite(nextPickupLat) && Number.isFinite(nextPickupLng)
        ? { lat: nextPickupLat, lng: nextPickupLng }
        : null;
    const dropoffPoint =
      Number.isFinite(nextDropoffLat) && Number.isFinite(nextDropoffLng)
        ? { lat: nextDropoffLat, lng: nextDropoffLng }
        : null;

    if (currentStatus === "in_progress" && driverCurrentCoords && pickupPoint && dropoffPoint) {
      routePricingMode = "mid_journey_actual_plus_remaining";
      const completedStopPoints = nextStops
        .slice(0, currentStopIndex)
        .map((s) => s?.coords)
        .filter((c): c is { lat: number; lng: number } => Boolean(c && Number.isFinite(c.lat) && Number.isFinite(c.lng)));
      const remainingStopPoints = nextStops
        .slice(currentStopIndex)
        .map((s) => s?.coords)
        .filter((c): c is { lat: number; lng: number } => Boolean(c && Number.isFinite(c.lat) && Number.isFinite(c.lng)));

      const computedAlreadyDriven = computeRouteHaversineFloorMiles(
        [pickupPoint, ...completedStopPoints, driverCurrentCoords],
        1.15
      );
      const clientAlreadyDriven =
        Number.isFinite(Number(body.alreadyDrivenMiles)) && Number(body.alreadyDrivenMiles) > 0
          ? Math.min(500, Math.round(Number(body.alreadyDrivenMiles) * 10) / 10)
          : 0;
      const alreadyDrivenMiles = Math.max(computedAlreadyDriven, clientAlreadyDriven);
      const remainingFloorMiles = computeRouteHaversineFloorMiles(
        [driverCurrentCoords, ...remainingStopPoints, dropoffPoint],
        1.15
      );
      serverFloorMiles = Math.round((alreadyDrivenMiles + remainingFloorMiles) * 10) / 10;
    } else if (pickupPoint && dropoffPoint) {
      const stopPoints = nextStops
        .map((s) => s?.coords)
        .filter((c): c is { lat: number; lng: number } => Boolean(c && Number.isFinite(c.lat) && Number.isFinite(c.lng)));
      serverFloorMiles = computeRouteHaversineFloorMiles([pickupPoint, ...stopPoints, dropoffPoint], 1.12);
    }

    const nextDistanceMiles = Math.min(
      500,
      Math.round(Math.max(clientDistanceMiles, serverFloorMiles) * 10) / 10
    );
    const nextDurationMinutes = Math.min(
      1440,
      Math.max(clientDurationMinutes, Math.round(nextDistanceMiles * 2))
    );

    const surgeModel = ride.surgeModel || body.surgeModel || "fixed";
    const surgeMultiplier = Number(ride.surgeMultiplier ?? body.surgeMultiplier ?? 1.0);
    const surgeFixedAmount = Number(ride.surgeFixedAmount ?? body.surgeFixedAmount ?? 0);

    const { baseCalc, fareEstimate } = computeServerBookingFareEstimate({
      distanceMiles: nextDistanceMiles,
      durationMinutes: nextDurationMinutes,
      carCategory: effectiveCategory,
      ridesConfig,
      isPriority: effectivePriority,
      isPetFriendly: effectivePetFriendly,
      surgeModel,
      surgeMultiplier,
      surgeFixedAmount,
    });

    const previousFareEstimate = penceToGbp(roundToPence(Number(ride.fareEstimate || fareEstimate)));
    const fareDeltaGbp = penceToGbp(roundToPence(fareEstimate - previousFareEstimate));
    const journeyRevision = Math.max(0, Math.floor(Number(ride.journeyRevision || 0))) + 1;

    const changeParts: string[] = [];
    if (String(ride.pickup || ride.pickupAddress || "") !== nextPickup) {
      changeParts.push("Pickup updated");
    }
    if (String(ride.dropoff || ride.dropoffAddress || "") !== nextDropoff) {
      changeParts.push(`Dropoff changed to ${nextDropoff.slice(0, 60)}`);
    }
    if (nextStops.length > existingStops.length) {
      changeParts.push(`Stop added (${nextStops.length} total)`);
    } else if (nextStops.length < existingStops.length) {
      changeParts.push(`Stop removed (${nextStops.length} left)`);
    } else if (JSON.stringify(nextStops) !== JSON.stringify(existingStops)) {
      changeParts.push("Stop updated");
    }
    if (Math.abs(fareDeltaGbp) >= 0.01) {
      const sign = fareDeltaGbp > 0 ? "+" : "-";
      changeParts.push(`Fare ${sign}£${Math.abs(fareDeltaGbp).toFixed(2)} (now £${fareEstimate.toFixed(2)})`);
    }
    const editSummary =
      changeParts.length > 0 ? changeParts.join(" • ") : `Journey updated (£${fareEstimate.toFixed(2)})`;

    const nextRideContext =
      body.rideContext === "business" || body.rideContext === "personal"
        ? body.rideContext
        : ride.rideContext || "personal";

    const nextWaitTolerance = ["any", "5", "10", "15"].includes(String(body.waitTolerance))
      ? String(body.waitTolerance)
      : ride.waitTolerance || "any";

    const nextComments =
      typeof body.comments === "string"
        ? body.comments.trim().slice(0, 200)
        : String(ride.comments || "");

    const patch: Record<string, any> = {
      passengerId: passengerId || caller.uid,
      riderId: ride.riderId || caller.uid,
      pickup: nextPickup,
      pickupAddress: nextPickup,
      pickupLat: nextPickupLat,
      pickupLng: nextPickupLng,
      dropoff: nextDropoff,
      dropoffAddress: nextDropoff,
      dropoffLat: nextDropoffLat,
      dropoffLng: nextDropoffLng,
      stops: nextStops,
      distanceMiles: nextDistanceMiles,
      durationMinutes: nextDurationMinutes,
      baseCalc,
      fareEstimate,
      previousFareEstimate,
      fareDeltaGbp,
      priorityFee: ridesConfig.priorityFee,
      petFee: ridesConfig.petFee,
      routePricingMode,
      carCategory: effectiveCategory,
      vehicleCategory: effectiveCategory,
      isPetFriendly: effectivePetFriendly,
      isPriority: effectivePriority,
      waitTolerance: nextWaitTolerance,
      comments: nextComments,
      rideContext: nextRideContext,
      isModifiedByPassenger: true,
      journeyRevision,
      lastPassengerEditSummary: editSummary,
      lastPassengerEditAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    let nextStatus = currentStatus;
    let shouldRedispatch = false;
    if (isPreAccept) {
      if (body.pauseSearch === true) {
        nextStatus = "draft";
        patch.status = "draft";
        shouldRedispatch = false;
      } else {
        nextStatus = "pending";
        patch.status = "pending";
        shouldRedispatch = true;
      }
      if (currentStatus === "offered") {
        patch.assignedDriverId = admin.firestore.FieldValue.delete();
        patch.offerExpiresAt = admin.firestore.FieldValue.delete();
      }
    }

    tx.update(rideRef, patch);

    // Keep assigned driver's live_tracking dropoff coords synced if active ride dropoff changed
    if (assignedDriverId && Number.isFinite(nextDropoffLat) && Number.isFinite(nextDropoffLng)) {
      const driverTrackingRef = db.collection("live_tracking").doc(assignedDriverId);
      tx.set(
        driverTrackingRef,
        {
          dropoffLat: nextDropoffLat,
          dropoffLng: nextDropoffLng,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }

    return {
      success: true as const,
      rideId: cleanRideId,
      status: nextStatus,
      fareEstimate,
      previousFareEstimate,
      fareDeltaGbp,
      baseCalc,
      distanceMiles: nextDistanceMiles,
      durationMinutes: nextDurationMinutes,
      journeyRevision,
      editSummary,
      dropoff: nextDropoff,
      dropoffLat: nextDropoffLat,
      dropoffLng: nextDropoffLng,
      stops: nextStops,
      isActiveRideEdit: isActive,
      ...(assignedDriverId ? { assignedDriverId } : {}),
      shouldRedispatch,
    };
  });
}

/**
 * Server-authoritative initial ride booking creation.
 * Computes `baseCalc` and `fareEstimate` on the server using live `platform_config/rides`
 * plus a Haversine road-distance floor so client-side price tampering is impossible.
 */
export async function executeCreateRideBookingCommand(params: {
  db: any;
  caller: CallerContext;
  body: Record<string, any>;
}): Promise<{
  success: true;
  rideId: string;
  status: string;
  fareEstimate: number;
  baseCalc: number;
  distanceMiles: number;
  durationMinutes: number;
  carCategory: string;
}> {
  const { db, caller, body } = params;
  if (!caller?.uid) throw new UnauthorizedError("Authentication required.");
  if (!db) throw new BadRequestError("Database backend unavailable.");

  const sanitizeCoord = (val: any, maxAbs: number): number | null => {
    const n = Number(val);
    return Number.isFinite(n) && Math.abs(n) <= maxAbs ? n : null;
  };

  const pickup = typeof body.pickup === "string" ? body.pickup.trim().slice(0, 220) : "";
  const dropoff = typeof body.dropoff === "string" ? body.dropoff.trim().slice(0, 220) : "";
  const pickupLat = sanitizeCoord(body.pickupLat, 90);
  const pickupLng = sanitizeCoord(body.pickupLng, 180);
  const dropoffLat = sanitizeCoord(body.dropoffLat, 90);
  const dropoffLng = sanitizeCoord(body.dropoffLng, 180);

  if (!pickup || !dropoff) {
    throw new BadRequestError("Valid pickup and dropoff addresses are required.");
  }
  if (pickupLat === null || pickupLng === null || dropoffLat === null || dropoffLng === null) {
    throw new BadRequestError("Valid pickup and dropoff coordinates are required.");
  }

  const rawStops = Array.isArray(body.stops) ? body.stops : [];
  const stops: Array<{ address: string; coords: { lat: number; lng: number } }> = [];
  for (const s of rawStops.slice(0, 3)) {
    const addr = typeof s?.address === "string" ? s.address.trim().slice(0, 220) : "";
    const lat = sanitizeCoord(s?.coords?.lat ?? s?.lat, 90);
    const lng = sanitizeCoord(s?.coords?.lng ?? s?.lng, 180);
    if (addr && lat !== null && lng !== null) {
      stops.push({ address: addr, coords: { lat, lng } });
    }
  }

  const userRef = db.collection("users").doc(caller.uid);
  const userSnap = await userRef.get();
  const userExists = userSnap && (typeof userSnap.exists === "function" ? userSnap.exists() : userSnap.exists);
  const userData = userExists ? (typeof userSnap.data === "function" ? userSnap.data() : userSnap.data) || {} : {};

  const pendingCharges = Number(userData.pendingCharges || 0);
  if (Number.isFinite(pendingCharges) && pendingCharges > 0.009) {
    throw new ConflictError(
      `Please pay your outstanding balance of £${pendingCharges.toFixed(2)} before booking a new ride.`
    );
  }

  const ridesConfig = await loadRidesFareConfig(db);

  const allowedCatSet = new Set<string>(ALLOWED_VEHICLE_CATEGORIES as readonly string[]);
  const rawCat = normalizeCategory(body.carCategory ?? body.vehicleCategory ?? "standard");
  const carCategory = allowedCatSet.has(rawCat) ? rawCat : "standard";
  const isPetFriendly = Boolean(body.isPetFriendly);
  const isPriority = Boolean(body.isPriority);

  const routePoints = [
    { lat: pickupLat, lng: pickupLng },
    ...stops.map((s) => s.coords),
    { lat: dropoffLat, lng: dropoffLng },
  ];
  const haversineFloorMiles = computeRouteHaversineFloorMiles(routePoints, 1.12);
  const clientDistanceMiles =
    Number.isFinite(Number(body.distanceMiles)) && Number(body.distanceMiles) > 0
      ? Math.min(500, Math.round(Number(body.distanceMiles) * 10) / 10)
      : 0;
  const distanceMiles = Math.min(
    500,
    Math.round(Math.max(clientDistanceMiles, haversineFloorMiles) * 10) / 10
  );
  const clientDurationMinutes =
    Number.isFinite(Number(body.durationMinutes)) && Number(body.durationMinutes) > 0
      ? Math.min(1440, Math.round(Number(body.durationMinutes)))
      : 0;
  const durationMinutes = Math.min(
    1440,
    Math.max(clientDurationMinutes, Math.round(distanceMiles * 2))
  );

  const surgeModel = body.surgeModel === "multiplier" ? "multiplier" : "fixed";
  const surgeMultiplier =
    Number.isFinite(Number(body.surgeMultiplier)) && Number(body.surgeMultiplier) >= 1
      ? Math.min(5, Number(body.surgeMultiplier))
      : 1.0;
  const surgeFixedAmount =
    Number.isFinite(Number(body.surgeFixedAmount)) && Number(body.surgeFixedAmount) >= 0
      ? Math.min(50, Number(body.surgeFixedAmount))
      : 0;

  const { baseCalc, fareEstimate } = computeServerBookingFareEstimate({
    distanceMiles,
    durationMinutes,
    carCategory,
    ridesConfig,
    isPriority,
    isPetFriendly,
    surgeModel,
    surgeMultiplier,
    surgeFixedAmount,
  });

  const phoneDigits = String(userData.phone || userData.phoneNumber || body.passengerPhone || "").replace(/\D/g, "");
  const handshakeCode =
    phoneDigits.length >= 4
      ? phoneDigits.slice(-4)
      : Math.floor(1000 + Math.random() * 9000).toString();

  const rideRef = db.collection("ride_requests").doc();
  const rideDoc = {
    riderId: caller.uid,
    passengerId: caller.uid,
    passengerName: String(userData.firstName || userData.name || body.passengerName || "Passenger").slice(0, 80),
    passengerPhone: String(userData.phone || userData.phoneNumber || body.passengerPhone || "").slice(0, 32),
    pickup,
    pickupAddress: pickup,
    pickupLat,
    pickupLng,
    dropoff,
    dropoffAddress: dropoff,
    dropoffLat,
    dropoffLng,
    stops,
    distanceMiles,
    durationMinutes,
    fareEstimate,
    baseCalc,
    priorityFee: ridesConfig.priorityFee,
    petFee: ridesConfig.petFee,
    surgeMultiplier,
    surgeModel,
    surgeFixedAmount,
    carCategory,
    vehicleCategory: carCategory,
    isPetFriendly,
    isPriority,
    waitTolerance: ["any", "5", "10", "15"].includes(String(body.waitTolerance))
      ? String(body.waitTolerance)
      : "any",
    comments: typeof body.comments === "string" ? body.comments.trim().slice(0, 200) : "",
    rideContext: body.rideContext === "business" ? "business" : "personal",
    status: "pending",
    paymentStatus: "unpaid",
    paid: false,
    isPaid: false,
    payoutTransferred: false,
    payoutStatus: "unpaid",
    hasCardOnFile: Boolean(body.hasCardOnFile),
    currency: "GBP",
    handshakeCode,
    requirePasscode: userData.requirePasscode === true || body.requirePasscode === true,
    journeyRevision: 0,
    isModifiedByPassenger: false,
    routePricingMode: "point_to_point",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  await rideRef.set(rideDoc);

  return {
    success: true,
    rideId: rideRef.id,
    status: "pending",
    fareEstimate,
    baseCalc,
    distanceMiles,
    durationMinutes,
    carCategory,
  };
}

/**
 * Server-authoritative passenger tip command.
 * Enforces strict maximum tip cap (£50.00 hard ceiling, or lower admin `maxTipGbp`),
 * prevents tipping after payment checkout begins, and returns assignedDriverId for instant FCM push.
 */
export async function executeAddRideTipCommand(params: {
  db: any;
  caller: CallerContext;
  rideId: string;
  tipAmount: unknown;
}): Promise<{
  success: true;
  rideId: string;
  tipAmount: number;
  maxTipGbp: number;
  assignedDriverId?: string;
}> {
  const { db, caller, rideId, tipAmount } = params;
  if (!caller?.uid) throw new UnauthorizedError("Authentication required.");
  if (!db) throw new BadRequestError("Database backend unavailable.");
  if (!rideId || typeof rideId !== "string" || !rideId.trim()) {
    throw new BadRequestError("Valid rideId is required.");
  }

  const cleanRideId = rideId.trim();
  const isAdmin = caller.isAdmin === true || caller.admin === true;
  const ridesConfig = await loadRidesFareConfig(db);
  const effectiveMaxTip = Math.min(MAX_PASSENGER_TIP_GBP, Math.max(0, Number(ridesConfig.maxTipGbp ?? MAX_PASSENGER_TIP_GBP)));

  const parsed = Number(tipAmount);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new BadRequestError("Tip amount must be a valid non-negative number.");
  }
  if (parsed > effectiveMaxTip) {
    throw new BadRequestError(`Maximum allowed tip is £${effectiveMaxTip.toFixed(2)}.`);
  }

  const cleanTipGbp = penceToGbp(roundToPence(parsed));
  const rideRef = db.collection("ride_requests").doc(cleanRideId);

  return db.runTransaction(async (tx: any) => {
    const rideSnap = await tx.get(rideRef);
    const exists =
      rideSnap && (typeof rideSnap.exists === "function" ? rideSnap.exists() : rideSnap.exists);
    if (!exists) throw new NotFoundError("Ride request not found.");

    const ride = (typeof rideSnap.data === "function" ? rideSnap.data() : rideSnap.data) || {};
    const passengerId = ride.passengerId || ride.riderId || ride.userId;
    if (!isAdmin && (!passengerId || passengerId !== caller.uid)) {
      throw new ForbiddenError("You are not authorized to tip on this ride.");
    }

    const status = String(ride.status || "").toLowerCase();
    if (!["accepted", "arrived", "in_progress"].includes(status)) {
      throw new ConflictError(`Tips can only be updated while the ride is active (current status: '${status}').`);
    }

    tx.update(rideRef, {
      tipAmount: cleanTipGbp,
      tipAddedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const assignedDriverId = String(ride.driverId || ride.assignedDriverId || "").trim();
    return {
      success: true as const,
      rideId: cleanRideId,
      tipAmount: cleanTipGbp,
      maxTipGbp: effectiveMaxTip,
      ...(assignedDriverId ? { assignedDriverId } : {}),
    };
  });
}

/**
 * Server-authoritative reassignment when an accepted stacked driver is delayed
 * and the passenger taps "Find Another". Atomically releases driver tracking/status
 * and returns the ride to "pending" for immediate re-dispatch.
 */
export async function executeReassignDelayedRideCommand(params: {
  db: any;
  caller: CallerContext;
  rideId: string;
}): Promise<{
  success: true;
  rideId: string;
  status: "pending";
  previousDriverId?: string;
}> {
  const { db, caller, rideId } = params;
  if (!caller?.uid) throw new UnauthorizedError("Authentication required.");
  if (!db) throw new BadRequestError("Database backend unavailable.");
  if (!rideId || typeof rideId !== "string" || !rideId.trim()) {
    throw new BadRequestError("Valid rideId is required.");
  }

  const cleanRideId = rideId.trim();
  const isAdmin = caller.isAdmin === true || caller.admin === true;
  const rideRef = db.collection("ride_requests").doc(cleanRideId);

  return db.runTransaction(async (tx: any) => {
    const rideSnap = await tx.get(rideRef);
    const exists =
      rideSnap && (typeof rideSnap.exists === "function" ? rideSnap.exists() : rideSnap.exists);
    if (!exists) throw new NotFoundError("Ride request not found.");

    const ride = (typeof rideSnap.data === "function" ? rideSnap.data() : rideSnap.data) || {};
    const passengerId = ride.passengerId || ride.riderId || ride.userId;
    if (!isAdmin && (!passengerId || passengerId !== caller.uid)) {
      throw new ForbiddenError("You are not authorized to reassign this ride.");
    }

    const currentStatus = String(ride.status || "").toLowerCase();
    if (currentStatus !== "accepted") {
      throw new ConflictError("You can only search for another driver before your driver arrives.");
    }

    const previousDriverId = String(ride.driverId || ride.assignedDriverId || "").trim();
    const driverTrackingRef = previousDriverId
      ? db.collection("live_tracking").doc(previousDriverId)
      : null;
    const driverStatusRef = previousDriverId
      ? db.collection("driver_status").doc(previousDriverId)
      : null;
    const passengerTrackingRef = passengerId
      ? db.collection("live_tracking").doc(passengerId)
      : null;

    const driverTrackingSnap = driverTrackingRef ? await tx.get(driverTrackingRef) : null;
    const driverTrackingExists = Boolean(
      driverTrackingSnap &&
        (typeof driverTrackingSnap.exists === "function"
          ? driverTrackingSnap.exists()
          : driverTrackingSnap.exists)
    );
    const driverTrackingData = driverTrackingExists
      ? (typeof driverTrackingSnap.data === "function"
          ? driverTrackingSnap.data()
          : driverTrackingSnap.data) || {}
      : null;

    const existingDeclined = Array.from(
      new Set([
        ...(Array.isArray(ride.declinedDriverIds) ? ride.declinedDriverIds : []),
        ...(Array.isArray(ride.declinedBy) ? ride.declinedBy : []),
        ...(previousDriverId ? [previousDriverId] : []),
      ])
    ).slice(0, 100);

    tx.update(rideRef, {
      status: "pending",
      driverId: admin.firestore.FieldValue.delete(),
      assignedDriverId: admin.firestore.FieldValue.delete(),
      driverName: admin.firestore.FieldValue.delete(),
      driverPhone: admin.firestore.FieldValue.delete(),
      vehicleInfo: admin.firestore.FieldValue.delete(),
      vehiclePlate: admin.firestore.FieldValue.delete(),
      driverRating: admin.firestore.FieldValue.delete(),
      driverPhotoUrl: admin.firestore.FieldValue.delete(),
      acceptedAt: admin.firestore.FieldValue.delete(),
      assignedAt: admin.firestore.FieldValue.delete(),
      stackedDriverDelay: admin.firestore.FieldValue.delete(),
      isFinishingTrip: admin.firestore.FieldValue.delete(),
      declinedBy: existingDeclined,
      declinedDriverIds: existingDeclined,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    if (driverTrackingRef && driverTrackingData) {
      if (driverTrackingData.queuedRideId === cleanRideId) {
        tx.set(
          driverTrackingRef,
          {
            queuedRideId: admin.firestore.FieldValue.delete(),
            queuedPassengerId: admin.firestore.FieldValue.delete(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      } else if (driverTrackingData.activeRideId === cleanRideId) {
        tx.set(
          driverTrackingRef,
          {
            status: "available",
            activeRideId: admin.firestore.FieldValue.delete(),
            passengerId: admin.firestore.FieldValue.delete(),
            riderId: admin.firestore.FieldValue.delete(),
            dropoffLat: admin.firestore.FieldValue.delete(),
            dropoffLng: admin.firestore.FieldValue.delete(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      }
    }

    if (driverStatusRef) {
      const isQueued = driverTrackingData?.queuedRideId === cleanRideId;
      tx.set(
        driverStatusRef,
        isQueued
          ? {
              queuedRideId: admin.firestore.FieldValue.delete(),
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            }
          : {
              status: "available",
              isBusy: false,
              currentRideId: admin.firestore.FieldValue.delete(),
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
        { merge: true }
      );
    }

    if (passengerTrackingRef) {
      tx.set(
        passengerTrackingRef,
        {
          driverId: admin.firestore.FieldValue.delete(),
          activeRideId: admin.firestore.FieldValue.delete(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }

    return {
      success: true as const,
      rideId: cleanRideId,
      status: "pending" as const,
      ...(previousDriverId ? { previousDriverId } : {}),
    };
  });
}
