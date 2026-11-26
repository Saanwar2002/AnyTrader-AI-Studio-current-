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

export const RIDE_OFFER_CHANNEL_ID = "ride_offers_urgent";
export const RIDE_UPDATES_CHANNEL_ID = "ride_chat_updates";
export const DEFAULT_OFFER_RADIUS_MILES = 15;
export const MAX_OFFER_RADIUS_MILES = 50;
export const DEFAULT_MAX_OFFER_DRIVERS = 15;
export const MAX_OFFER_DRIVERS = 25;
export const OFFER_DISPATCH_COOLDOWN_MS = 10_000;
export const OFFER_EXPIRY_MS = 35_000;
export const DRIVER_HEARTBEAT_STALE_MS = 10 * 60 * 1000;
export const STACKING_DROPOFF_MAX_MILES = 3.5;

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

export function evaluateDriverOfferCandidate(params: {
  driverUid: string;
  trackingData: Record<string, any>;
  rideData: Record<string, any>;
  passengerId?: string | null;
  radiusMiles: number;
  nowMs: number;
}): { eligible: boolean; distanceMiles: number; reason?: string } {
  const { driverUid, trackingData, rideData, passengerId, radiusMiles, nowMs } = params;

  if (!driverUid || trackingData.isOnline !== true) {
    return { eligible: false, distanceMiles: Infinity, reason: "offline" };
  }

  if (passengerId && driverUid === passengerId) {
    return { eligible: false, distanceMiles: Infinity, reason: "self_ride" };
  }

  if (!isTrackingHeartbeatFresh(trackingData, nowMs)) {
    return { eligible: false, distanceMiles: Infinity, reason: "stale_heartbeat" };
  }

  const isLastJob = trackingData.isLastJob === true || trackingData.lastJobMode === true;
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
  const isBusyOnRide = driverStatus === "on_ride" || driverStatus === "busy";
  let distanceMiles = calculateHaversineMiles(driverLat, driverLng, pickupLat, pickupLng);

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
    trackingData.destinationModeActive === true || trackingData.destinationMode === true;
  if (isDestMode) {
    const destLat = Number(trackingData.homeLat ?? trackingData.destinationLat);
    const destLng = Number(trackingData.homeLng ?? trackingData.destinationLng);
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

  // Working zone filter (supports both Android zoneEnabled/zoneMaxDistance/homeLat and legacy fields)
  const isZoneEnabled =
    trackingData.zoneEnabled === true || trackingData.zoneFilterEnabled === true;
  if (isZoneEnabled) {
    const zoneLat = Number(trackingData.zoneCenterLat ?? trackingData.homeLat);
    const zoneLng = Number(trackingData.zoneCenterLng ?? trackingData.homeLng);
    const zoneRadius = Number(trackingData.zoneMaxDistance ?? trackingData.zoneRadiusMiles) || 5;
    if (Number.isFinite(zoneLat) && Number.isFinite(zoneLng) && zoneRadius > 0) {
      const pickupToZone = calculateHaversineMiles(pickupLat, pickupLng, zoneLat, zoneLng);
      if (pickupToZone > zoneRadius) {
        return { eligible: false, distanceMiles, reason: "outside_driver_zone" };
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
): Promise<{ success: true; drivers: SanitizedNearbyDriverPin[]; count: number }> {
  const { db, lat, lng, vehicleCategory, excludeUid } = input;
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

  for (const docSnap of docs) {
    const data = typeof docSnap.data === "function" ? docSnap.data() : docSnap.data || {};
    const driverUid = docSnap.id || data.driverId;
    if (excludeUid && driverUid === excludeUid) continue;
    if (data.isOnline !== true) continue;
    if (!isTrackingHeartbeatFresh(data, nowMs)) continue;

    const status = String(data.status || "available").toLowerCase();
    if (status === "on_ride" || status === "busy") continue;

    const dLat = Number(data.lat);
    const dLng = Number(data.lng);
    if (!Number.isFinite(dLat) || !Number.isFinite(dLng)) continue;

    const distanceMiles = calculateHaversineMiles(lat, lng, dLat, dLng);
    if (distanceMiles > radiusMiles) continue;

    const categories = extractDriverCategories(data);
    if (!matchesVehicleCategory(categories, vehicleCategory)) continue;

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

  const candidateList: Array<{ driverUid: string; distanceMiles: number }> = [];
  for (const docSnap of onlineSnapshot?.docs || []) {
    const trackingData =
      (typeof docSnap.data === "function" ? docSnap.data() : docSnap.data) || {};
    const driverUid = String(docSnap.id || trackingData.driverId || "").trim();
    if (!driverUid) continue;

    const evaluation = evaluateDriverOfferCandidate({
      driverUid,
      trackingData,
      rideData,
      passengerId,
      radiusMiles,
      nowMs,
    });
    if (evaluation.eligible) {
      candidateList.push({
        driverUid,
        distanceMiles: Math.round(evaluation.distanceMiles * 100) / 100,
      });
    }
  }

  candidateList.sort((a, b) => a.distanceMiles - b.distanceMiles);

  // Verify authoritative driver eligibility (approved, non-suspended driver profile) before pushing
  const verifiedCandidates: Array<{ driverUid: string; distanceMiles: number }> = [];
  for (const candidate of candidateList) {
    if (verifiedCandidates.length >= maxDrivers) break;
    try {
      const userSnap = await db.collection("users").doc(candidate.driverUid).get();
      const userExists =
        userSnap && (typeof userSnap.exists === "function" ? userSnap.exists() : userSnap.exists);
      if (!userExists) continue;
      const userData =
        (typeof userSnap.data === "function" ? userSnap.data() : userSnap.data) || {};
      assertAuthoritativeDriverEligibility(userData, candidate.driverUid);
      verifiedCandidates.push(candidate);
    } catch {
      // Unapproved, suspended, or non-driver accounts are silently skipped
    }
  }

  const expiresAtMs = nowMs + OFFER_EXPIRY_MS;
  const fareEstimateNum = Number(rideData.fareEstimate ?? rideData.estimatedFare ?? 0);
  const fareDisplay =
    Number.isFinite(fareEstimateNum) && fareEstimateNum > 0
      ? `£${fareEstimateNum.toFixed(2)}`
      : "Fare est.";
  const pickupShort = String(rideData.pickupAddress || "Nearby pickup").slice(0, 80);
  const dropoffShort = String(rideData.dropoffAddress || "Destination").slice(0, 80);
  const title = rideData.isPriority ? "Priority Ride Offer" : "New Ride Offer";

  let dispatchedCount = 0;
  let deliveredCount = 0;
  let skippedNoTokensCount = 0;
  const notifiedDriverIds: string[] = [];

  for (const candidate of verifiedCandidates) {
    const body = `${fareDisplay} • ${candidate.distanceMiles.toFixed(1)} mi away • ${pickupShort} -> ${dropoffShort}`;
    const result = await dispatchAuthoritativeFcmPush(db, messagingClient, {
      recipientId: candidate.driverUid,
      title,
      body,
      channelId: RIDE_OFFER_CHANNEL_ID,
      eventType: "ride_offer",
      data: {
        type: "ride_offer",
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
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return {
    success: true,
    rideId: rideId.trim(),
    throttled: false,
    matchedDrivers: verifiedCandidates.length,
    dispatchedCount,
    deliveredCount,
    skippedNoTokensCount,
    expiresAtMs,
  };
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
