/**
 * AnyTrader V8.3 Task 35-B — Driver Authorization & Ride Claiming Security Engine
 *
 * Enforces server-authoritative driver eligibility, identity binding, and non-suspended status.
 * Rejects client-supplied `isDriver`, `role`, or `driverId` overrides.
 * Preserves 100% atomic transaction concurrency for ride claims.
 */

import admin from "firebase-admin";
import { UnauthorizedError, ForbiddenError, BadRequestError, ConflictError } from "./httpErrors.ts";
import { domainEvents } from "./domainEvents.ts";

export interface AuthenticatedDriverUser {
  uid: string;
  email?: string;
  isAdmin?: boolean;
  admin?: boolean;
  [key: string]: any;
}

/**
 * Server-authoritative driver eligibility verification.
 * Strictly verifies database record for caller UID.
 * Ignores any client-supplied request body fields (`isDriver`, `role`, etc.).
 */
export function assertAuthoritativeDriverEligibility(
  userData: Record<string, any> | null | undefined,
  callerUid: string
): void {
  if (!userData) {
    throw new ForbiddenError("User record not found or not authorized as a driver.");
  }

  // 1. Verify Driver Operational Privileges
  const isDriverRole =
    userData.role === "driver" ||
    userData.role === "fleet_driver" ||
    userData.role === "taxi_driver" ||
    userData.isDriver === true ||
    userData.accountType === "driver";

  if (!isDriverRole) {
    throw new ForbiddenError("Caller is not authorized to operate as a driver.");
  }

  // 2. Verify Account Activity & Non-Suspended Status
  const isSuspendedOrDisabled =
    userData.disabled === true ||
    userData.isDisabled === true ||
    userData.isSuspended === true ||
    userData.suspended === true ||
    userData.isBanned === true ||
    userData.banned === true ||
    userData.isDeactivated === true ||
    userData.deactivated === true ||
    userData.status === "suspended" ||
    userData.status === "banned" ||
    userData.status === "disabled" ||
    userData.status === "deactivated" ||
    userData.status === "inactive" ||
    userData.driverStatus === "suspended" ||
    userData.driverStatus === "disabled" ||
    userData.driverStatus === "banned" ||
    userData.driverStatus === "inactive" ||
    userData.driverStatus === "deactivated" ||
    userData.driverApproved === false;

  if (isSuspendedOrDisabled) {
    throw new ForbiddenError("Driver account is suspended, disabled, or inactive.");
  }

  // 3. Fail-Closed Driver Approval Verification (PL-09)
  if (userData.driverApproved !== true) {
    throw new ForbiddenError("Driver account is awaiting verification and approval.");
  }
}

export interface AcceptRideCommandInput {
  db: any;
  caller: AuthenticatedDriverUser;
  body: {
    rideId?: string;
    driverId?: string;
    isDriver?: any;
    role?: any;
    [key: string]: any;
  };
}

export interface AcceptRideCommandResult {
  success: boolean;
  rideId: string;
  driverId: string;
  passengerId?: string;
  isStackedAccept?: boolean;
}

/**
 * Server-authoritative, transactional ride acceptance command.
 * Enforces pre-claim driver authorization, identity verification, atomic reservation,
 * authoritative driver profile stamping, stacked-ride tracking safety, and bidirectional
 * live_tracking visibility.
 */
export async function executeAcceptRideCommand(
  input: AcceptRideCommandInput
): Promise<AcceptRideCommandResult> {
  const { db, caller, body } = input;

  if (!caller || !caller.uid) {
    throw new UnauthorizedError("Authentication token is missing or invalid.");
  }

  const callerUid = caller.uid;

  const rideId = body?.rideId;
  if (!rideId || typeof rideId !== "string" || !rideId.trim()) {
    throw new BadRequestError("Missing or invalid rideId");
  }

  // Impersonation Defense: Reject any attempt to claim on behalf of a different user ID
  if (body?.driverId && typeof body.driverId === "string" && body.driverId !== callerUid) {
    throw new ForbiddenError("Cannot accept ride on behalf of another driver.");
  }

  if (!db) {
    throw new BadRequestError("Database not initialized");
  }

  const effectiveDriverId = callerUid;
  let resolvedPassengerId: string | undefined;
  let resolvedStackedAccept = false;

  await db.runTransaction(async (transaction: any) => {
    // 1. Read userRef, rideRef, and existing driver live_tracking BEFORE any writes
    const userRef = db.collection("users").doc(callerUid);
    const rideRef = db.collection("ride_requests").doc(rideId);
    const driverRef = db.collection("driver_status").doc(effectiveDriverId);
    const liveTrackingRef = db.collection("live_tracking").doc(effectiveDriverId);

    const [userDoc, rideDoc, existingTrackingDoc] = await Promise.all([
      transaction.get(userRef),
      transaction.get(rideRef),
      transaction.get(liveTrackingRef),
    ]);

    const userExists =
      userDoc && (typeof userDoc.exists === "function" ? userDoc.exists() : userDoc.exists);
    const userData = userExists
      ? (typeof userDoc.data === "function" ? userDoc.data() : userDoc.data) || {}
      : null;

    // 2. Pre-claim Driver Authorization Check
    assertAuthoritativeDriverEligibility(userData, callerUid);

    const rideExists =
      rideDoc && (typeof rideDoc.exists === "function" ? rideDoc.exists() : rideDoc.exists);
    if (!rideExists) {
      throw new BadRequestError("Ride request not found");
    }

    const rideData =
      (typeof rideDoc.data === "function" ? rideDoc.data() : rideDoc.data) || {};

    if (
      rideData.status !== "pending" &&
      rideData.status !== "searching" &&
      rideData.status !== "offered"
    ) {
      throw new ConflictError("Ride is no longer available");
    }

    // P0-1: Allow the offered driver to accept their own "offered" ride.
    // Reject if already accepted (driverId set) or actively offered to a DIFFERENT driver.
    const existingDriverId =
      typeof rideData.driverId === "string" ? rideData.driverId.trim() : "";
    const existingAssignedDriverId =
      typeof rideData.assignedDriverId === "string" ? rideData.assignedDriverId.trim() : "";

    if (existingDriverId) {
      throw new ConflictError("Ride has already been accepted by another driver");
    }
    if (existingAssignedDriverId && existingAssignedDriverId !== effectiveDriverId) {
      const rawExpiry = rideData.offerExpiresAt;
      const expiryMs =
        typeof rawExpiry === "number"
          ? rawExpiry
          : typeof rawExpiry === "string"
            ? Date.parse(rawExpiry)
            : typeof rawExpiry?.toMillis === "function"
              ? rawExpiry.toMillis()
              : 0;
      if (!expiryMs || !Number.isFinite(expiryMs) || expiryMs > Date.now()) {
        throw new ConflictError("Ride has already been accepted by another driver");
      }
    }

    const passengerId = rideData.passengerId || rideData.userId || rideData.riderId;
    if (passengerId === callerUid) {
      throw new BadRequestError("Passengers cannot accept their own ride requests as a driver.");
    }
    resolvedPassengerId = passengerId || undefined;

    // P0-2: Derive authoritative driver identity metadata from users/{callerUid}
    const driverName =
      userData?.displayName ||
      userData?.name ||
      [userData?.firstName, userData?.lastName].filter(Boolean).join(" ").trim() ||
      "AnyRoller Driver";

    const vehicleInfo =
      userData?.vehicleInfo ||
      [userData?.vehicleColor, userData?.vehicleMake, userData?.vehicleModel]
        .filter(Boolean)
        .join(" ")
        .trim() ||
      userData?.vehicle ||
      userData?.carModel ||
      "Taxi";

    const vehiclePlate =
      userData?.vehiclePlate ||
      userData?.vehicleRegistration ||
      userData?.licensePlate ||
      userData?.registrationPlate ||
      userData?.plateNumber ||
      userData?.plate ||
      "";

    const driverPhone = userData?.phone || userData?.phoneNumber || "";
    const driverRating =
      typeof userData?.driverRating === "number"
        ? userData.driverRating
        : typeof userData?.rating === "number"
          ? userData.rating
          : 4.9;
    const driverRequirePasscode = userData?.requirePasscode === true;
    const driverPhotoUrl = userData?.photoURL || userData?.avatarUrl || null;

    // 4. Atomic Transaction Writes
    transaction.update(rideRef, {
      driverId: effectiveDriverId,
      assignedDriverId: effectiveDriverId,
      status: "accepted",
      driverName,
      driverPhone,
      vehicleInfo,
      vehiclePlate,
      driverRating,
      driverRequirePasscode,
      ...(driverPhotoUrl ? { driverPhotoUrl } : {}),
      acceptedAt: admin.firestore.FieldValue.serverTimestamp(),
      assignedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // P0-6: Stacked ride safety — preserve active ride passenger tracking if already on_ride
    const existingTrackingExists =
      existingTrackingDoc &&
      (typeof existingTrackingDoc.exists === "function"
        ? existingTrackingDoc.exists()
        : existingTrackingDoc.exists);
    const existingTracking = existingTrackingExists
      ? (typeof existingTrackingDoc.data === "function"
          ? existingTrackingDoc.data()
          : existingTrackingDoc.data) || {}
      : {};
    const isStackedAccept =
      existingTracking.status === "on_ride" &&
      typeof existingTracking.activeRideId === "string" &&
      existingTracking.activeRideId.length > 0 &&
      existingTracking.activeRideId !== rideId;
    resolvedStackedAccept = isStackedAccept;

    transaction.set(
      driverRef,
      {
        status: "busy",
        isBusy: true,
        pendingRideId: admin.firestore.FieldValue.delete(),
        ...(isStackedAccept ? { queuedRideId: rideId } : { currentRideId: rideId }),
        lastActiveAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    if (isStackedAccept) {
      transaction.set(
        liveTrackingRef,
        {
          driverId: effectiveDriverId,
          queuedRideId: rideId,
          queuedPassengerId: passengerId || null,
          isStackingEnabled: false,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    } else {
      // Sync live_tracking visibility so the assigned passenger satisfies firestore.rules immediately
      transaction.set(
        liveTrackingRef,
        {
          driverId: effectiveDriverId,
          activeRideId: rideId,
          passengerId: passengerId || null,
          riderId: passengerId || null,
          status: "on_ride",
          dropoffLat: rideData.dropoffLat ?? null,
          dropoffLng: rideData.dropoffLng ?? null,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }

    // P0-3: Stamp assigned driverId onto live_tracking/{passengerId} so the driver can read
    // the passenger's live blue GPS dot without hitting firestore.rules permission-denied.
    if (passengerId && !isStackedAccept) {
      const passengerTrackingRef = db.collection("live_tracking").doc(passengerId);
      transaction.set(
        passengerTrackingRef,
        {
          passengerId,
          driverId: effectiveDriverId,
          activeRideId: rideId,
          isPassenger: true,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }
  });

  if (domainEvents && typeof domainEvents.dispatch === "function") {
    await domainEvents.dispatch(
      "RIDE_ACCEPTED",
      rideId,
      effectiveDriverId,
      { driverId: effectiveDriverId, isStackedAccept: resolvedStackedAccept },
      undefined,
      db
    );
  }

  return {
    success: true,
    rideId,
    driverId: effectiveDriverId,
    ...(resolvedPassengerId ? { passengerId: resolvedPassengerId } : {}),
    ...(resolvedStackedAccept ? { isStackedAccept: true } : {}),
  };
}
