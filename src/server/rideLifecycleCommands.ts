/**
 * AnyRoller Server-Authoritative Ride Lifecycle, Completion, Cancellation & Settlement Commands
 *
 * Covers Batch 8 (AT-RIDE-PAY-01, AT-RIDE-PAY-04, AT-RIDE-PAY-05, AT-RIDE-PAY-06, AT-RIDE-PAY-07):
 * - Eliminates cross-user & protected-field client Firestore writes during completion, cancellation, cash reporting, and abandonment.
 * - Enforces canonical `fareContractVersion: "v2_excl_tip"` (`finalFare` = base fare excl. tip, `tipAmount` separate, `totalFarePaid = finalFare + tipAmount`).
 * - Updates `driver_metrics/{driverId}` transactionally using net driver earnings (`(finalFare - platformFee) + tipAmount`) and resets daily counters safely on UTC day change.
 * - Provides transactional webhook fulfillment for Stripe Checkout `taxi_trip` and `fee_settlement`.
 */

import Stripe from "stripe";
import { createHash } from "node:crypto";
import admin from "firebase-admin";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from "./httpErrors.ts";
import { validateRideTransition, type RideStatus } from "./stateMachine.ts";
import {
  computeAuthoritativeRideFare,
  loadRidesFareConfig,
  penceToGbp,
  resolveEffectiveCommissionRate,
  roundToPence,
} from "./rideFareCalculator.ts";
import { sanitizeRedirectUrl } from "./paymentVerification.ts";
import { ownsStripeWebhookClaim } from "./stripeWebhookIdempotency.ts";

export interface CallerIdentity {
  uid: string;
  email?: string;
  isAdmin?: boolean;
  admin?: boolean;
}

export type CompleteRideAction =
  | "auto_card"
  | "qr_pending"
  | "qr_manual_close"
  | "cash_report"
  | "cash_finalize"
  | "abandonment"
  | "cash_confirm_passenger"
  | "force_complete_passenger";

export interface TransitionRideInput {
  db: any;
  caller: CallerIdentity;
  rideId: string;
  action: "arrived" | "in_progress" | "stop_progress" | "early_completion_reason" | "update_eta";
  paidWaitSeconds?: number;
  currentStopIndex?: number;
  earlyCompletionReason?: string;
  liveEtaSeconds?: number;
  stackedDriverDelay?: number;
}

export async function executeTransitionRideCommand(input: TransitionRideInput) {
  const { db, caller, rideId, action } = input;
  if (!caller?.uid) throw new UnauthorizedError("Authentication required.");
  if (!db) throw new BadRequestError("Database backend unavailable");
  if (!rideId || typeof rideId !== "string" || !rideId.trim()) {
    throw new BadRequestError("Missing or invalid rideId");
  }

  const isAdmin = caller.isAdmin === true || caller.admin === true;
  const rideRef = db.collection("ride_requests").doc(rideId);

  const result = await db.runTransaction(async (tx: any) => {
    const rideSnap = await tx.get(rideRef);
    const exists = typeof rideSnap.exists === "function" ? rideSnap.exists() : rideSnap.exists;
    if (!exists) throw new NotFoundError("Ride request not found");

    const ride = typeof rideSnap.data === "function" ? rideSnap.data() : rideSnap.data;
    const assignedDriverId = ride.assignedDriverId || ride.driverId;
    const passengerId = ride.passengerId || ride.riderId || ride.userId;
    if (!isAdmin && assignedDriverId !== caller.uid) {
      throw new ForbiddenError("Only the assigned driver can update ride progress.");
    }

    const currentStatus = (ride.status || "accepted") as RideStatus;
    const patch: Record<string, any> = {
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (action === "arrived") {
      validateRideTransition(currentStatus, "arrived");
      patch.status = "arrived";
      patch.arrivedAt = ride.arrivedAt || admin.firestore.FieldValue.serverTimestamp();
    } else if (action === "in_progress") {
      validateRideTransition(currentStatus, "in_progress");
      patch.status = "in_progress";
      patch.startedAt = ride.startedAt || admin.firestore.FieldValue.serverTimestamp();
      if (input.paidWaitSeconds !== undefined && Number.isFinite(Number(input.paidWaitSeconds))) {
        patch.paidWaitSeconds = Math.max(0, Math.min(7200, Math.round(Number(input.paidWaitSeconds))));
      }
    } else if (action === "stop_progress") {
      if (input.currentStopIndex === undefined || !Number.isInteger(Number(input.currentStopIndex)) || Number(input.currentStopIndex) < 0) {
        throw new BadRequestError("Invalid currentStopIndex");
      }
      patch.currentStopIndex = Number(input.currentStopIndex);
    } else if (action === "early_completion_reason") {
      const cleanReason = String(input.earlyCompletionReason || "").trim().slice(0, 200);
      if (!cleanReason) throw new BadRequestError("earlyCompletionReason is required");
      patch.earlyCompletionReason = cleanReason;
    } else if (action === "update_eta") {
      if (!["accepted", "arrived", "in_progress"].includes(currentStatus)) {
        throw new ConflictError("ETA can only be updated on active rides.");
      }
      let hasField = false;
      if (input.liveEtaSeconds !== undefined && Number.isFinite(Number(input.liveEtaSeconds))) {
        const clampedSec = Math.max(0, Math.min(14400, Math.round(Number(input.liveEtaSeconds))));
        patch.liveEtaSeconds = clampedSec;
        patch.durationMinutes = Math.max(1, Math.ceil(clampedSec / 60));
        hasField = true;
      }
      if (input.stackedDriverDelay !== undefined && Number.isFinite(Number(input.stackedDriverDelay))) {
        patch.stackedDriverDelay = Math.max(0, Math.min(60, Math.round(Number(input.stackedDriverDelay))));
        hasField = true;
      }
      if (!hasField) {
        throw new BadRequestError("liveEtaSeconds or stackedDriverDelay is required for update_eta.");
      }
    } else {
      throw new BadRequestError(`Unsupported ride transition action '${action}'`);
    }

    tx.update(rideRef, patch);
    return {
      success: true,
      rideId,
      action,
      status: patch.status || currentStatus,
      ...(passengerId ? { passengerId } : {}),
    };
  });

  return result;
}

/**
 * Helper to release/promote driver & passenger live_tracking docs atomically when a ride ends.
 * - If the ended ride was active and the driver has a stacked queuedRideId, promotes the queued
 *   ride to activeRideId and stamps driverId onto live_tracking/{queuedPassengerId}.
 * - If the ended ride was the queued ride itself, clears only queuedRideId/queuedPassengerId.
 * - Always clears driverId/activeRideId from live_tracking/{endedPassengerId} so former driver
 *   immediately loses read access to the passenger's live GPS.
 */
function releaseOrPromoteTrackingInTx(params: {
  tx: any;
  db: any;
  rideId: string;
  assignedDriverId?: string | null;
  passengerId?: string | null;
  driverTrackingData?: Record<string, any> | null;
  driverStatusRef?: any;
}) {
  const { tx, db, rideId, assignedDriverId, passengerId, driverTrackingData, driverStatusRef } = params;

  if (passengerId && typeof passengerId === "string" && passengerId.trim()) {
    tx.set(
      db.collection("live_tracking").doc(passengerId.trim()),
      {
        driverId: admin.firestore.FieldValue.delete(),
        activeRideId: admin.firestore.FieldValue.delete(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  }

  if (!assignedDriverId || typeof assignedDriverId !== "string" || !assignedDriverId.trim()) {
    return;
  }

  const driverUid = assignedDriverId.trim();
  const liveTrackingRef = db.collection("live_tracking").doc(driverUid);
  const tracking = driverTrackingData || {};
  const isCancellingQueuedOnly =
    typeof tracking.queuedRideId === "string" &&
    tracking.queuedRideId === rideId &&
    typeof tracking.activeRideId === "string" &&
    tracking.activeRideId.length > 0 &&
    tracking.activeRideId !== rideId;

  if (isCancellingQueuedOnly) {
    tx.set(
      liveTrackingRef,
      {
        queuedRideId: admin.firestore.FieldValue.delete(),
        queuedPassengerId: admin.firestore.FieldValue.delete(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    if (driverStatusRef) {
      tx.set(
        driverStatusRef,
        {
          queuedRideId: admin.firestore.FieldValue.delete(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }
    return;
  }

  const nextRideId =
    typeof tracking.queuedRideId === "string" &&
    tracking.queuedRideId.trim() &&
    tracking.queuedRideId !== rideId
      ? tracking.queuedRideId.trim()
      : null;
  const nextPassengerId =
    typeof tracking.queuedPassengerId === "string" && tracking.queuedPassengerId.trim()
      ? tracking.queuedPassengerId.trim()
      : null;

  if (nextRideId) {
    tx.set(
      liveTrackingRef,
      {
        driverId: driverUid,
        status: "on_ride",
        activeRideId: nextRideId,
        passengerId: nextPassengerId,
        riderId: nextPassengerId,
        queuedRideId: admin.firestore.FieldValue.delete(),
        queuedPassengerId: admin.firestore.FieldValue.delete(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    if (nextPassengerId) {
      tx.set(
        db.collection("live_tracking").doc(nextPassengerId),
        {
          passengerId: nextPassengerId,
          driverId: driverUid,
          activeRideId: nextRideId,
          isPassenger: true,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }
    if (driverStatusRef) {
      tx.set(
        driverStatusRef,
        {
          isBusy: true,
          status: "busy",
          currentRideId: nextRideId,
          queuedRideId: admin.firestore.FieldValue.delete(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }
  } else {
    tx.set(
      liveTrackingRef,
      {
        driverId: driverUid,
        status: "available",
        activeRideId: admin.firestore.FieldValue.delete(),
        passengerId: admin.firestore.FieldValue.delete(),
        riderId: admin.firestore.FieldValue.delete(),
        queuedRideId: admin.firestore.FieldValue.delete(),
        queuedPassengerId: admin.firestore.FieldValue.delete(),
        dropoffLat: null,
        dropoffLng: null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    if (driverStatusRef) {
      tx.set(
        driverStatusRef,
        {
          isBusy: false,
          currentRideId: admin.firestore.FieldValue.delete(),
          queuedRideId: admin.firestore.FieldValue.delete(),
          status: "online",
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }
  }
}

export interface CompleteRideInput {
  db: any;
  caller: CallerIdentity;
  rideId: string;
  action: CompleteRideAction;
  paidWaitSeconds?: number;
  cashCollected?: number | string | null;
  forceComplete?: boolean;
  forceCompleteReason?: string | null;
  earlyCompletionReason?: string | null;
  paymentUrl?: string | null;
  abandonmentFee?: number;
}

export async function executeCompleteRideCommand(input: CompleteRideInput) {
  const { db, caller, rideId, action } = input;
  if (!caller?.uid) throw new UnauthorizedError("Authentication required.");
  if (!db) throw new BadRequestError("Database backend unavailable");
  if (!rideId || typeof rideId !== "string" || !rideId.trim()) {
    throw new BadRequestError("Missing or invalid rideId");
  }

  const isAdmin = caller.isAdmin === true || caller.admin === true;
  const rideRef = db.collection("ride_requests").doc(rideId);
  const ridesConfig = await loadRidesFareConfig(db);

  return db.runTransaction(async (tx: any) => {
    const rideSnap = await tx.get(rideRef);
    const exists = typeof rideSnap.exists === "function" ? rideSnap.exists() : rideSnap.exists;
    if (!exists) throw new NotFoundError("Ride request not found");

    const ride = typeof rideSnap.data === "function" ? rideSnap.data() : rideSnap.data;
    const assignedDriverId = ride.assignedDriverId || ride.driverId;
    const passengerId = ride.passengerId || ride.riderId || ride.userId;

    if (ride.driverId && ride.assignedDriverId && ride.driverId !== ride.assignedDriverId) {
      throw new BadRequestError("Conflicting driver identities on ride record");
    }

    const isPassengerAction = action === "cash_confirm_passenger" || action === "force_complete_passenger";
    if (isPassengerAction) {
      if (!isAdmin && (!passengerId || passengerId !== caller.uid)) {
        throw new ForbiddenError("Only the ride passenger can confirm cash balance.");
      }
    } else {
      if (!isAdmin && (!assignedDriverId || assignedDriverId !== caller.uid)) {
        throw new ForbiddenError("Only the assigned driver can complete this ride.");
      }
    }

    if (ride.status === "cancelled") {
      throw new ConflictError("Cannot complete a cancelled ride.");
    }

    // All reads must occur before any writes in Firestore transactions
    const driverRef = assignedDriverId ? db.collection("users").doc(assignedDriverId) : null;
    const driverMetricsRef = assignedDriverId ? db.collection("driver_metrics").doc(assignedDriverId) : null;
    const driverStatusRef = assignedDriverId ? db.collection("driver_status").doc(assignedDriverId) : null;
    const driverTrackingRef = assignedDriverId ? db.collection("live_tracking").doc(assignedDriverId) : null;
    const passengerRef =
      passengerId && typeof passengerId === "string" && passengerId.trim()
        ? db.collection("users").doc(passengerId)
        : null;

    const [driverSnap, metricsSnap, passengerSnap, driverTrackingSnap] = await Promise.all([
      driverRef ? tx.get(driverRef) : Promise.resolve(null),
      driverMetricsRef ? tx.get(driverMetricsRef) : Promise.resolve(null),
      passengerRef ? tx.get(passengerRef) : Promise.resolve(null),
      driverTrackingRef ? tx.get(driverTrackingRef) : Promise.resolve(null),
    ]);

    const driverData =
      driverSnap && (typeof driverSnap.exists === "function" ? driverSnap.exists() : driverSnap.exists)
        ? (typeof driverSnap.data === "function" ? driverSnap.data() : driverSnap.data)
        : null;
    const metricsData =
      metricsSnap && (typeof metricsSnap.exists === "function" ? metricsSnap.exists() : metricsSnap.exists)
        ? (typeof metricsSnap.data === "function" ? metricsSnap.data() : metricsSnap.data)
        : null;
    const driverTrackingData =
      driverTrackingSnap && (typeof driverTrackingSnap.exists === "function" ? driverTrackingSnap.exists() : driverTrackingSnap.exists)
        ? (typeof driverTrackingSnap.data === "function" ? driverTrackingSnap.data() : driverTrackingSnap.data)
        : null;
    const passengerExists = Boolean(
      passengerSnap && (typeof passengerSnap.exists === "function" ? passengerSnap.exists() : passengerSnap.exists)
    );

    const effectivePaidWaitSeconds =
      input.paidWaitSeconds !== undefined && Number.isFinite(Number(input.paidWaitSeconds))
        ? Math.max(Number(ride.paidWaitSeconds || 0), Math.min(7200, Math.round(Number(input.paidWaitSeconds))))
        : Number(ride.paidWaitSeconds || 0);

    const isAbandonment = action === "abandonment" || ride.status === "rider_abandoned";
    const fareBreakdown = computeAuthoritativeRideFare({
      rideData: ride,
      driverData,
      ridesConfig,
      paidWaitSecondsOverride: effectivePaidWaitSeconds,
      isAbandonment,
    });

    if (fareBreakdown.baseFarePence <= 0) {
      throw new BadRequestError("Authoritative trip fare could not be determined for completion.");
    }

    const currentStatus = (ride.status || "in_progress") as RideStatus;

    // QR payment pending state (returns breakdown + awaits webhook completion)
    if (action === "qr_pending") {
      validateRideTransition(currentStatus, "awaiting_payment");
      const qrPatch: Record<string, any> = {
        status: "awaiting_payment",
        paymentMethod: "stripe_qr",
        finalFare: fareBreakdown.baseFareGbp,
        tipAmount: fareBreakdown.tipGbp,
        totalFarePaid: fareBreakdown.totalCollectedGbp,
        fareContractVersion: "v2_excl_tip",
        paidWaitSeconds: fareBreakdown.paidWaitSeconds,
        platformFee: fareBreakdown.platformFeeGbp,
        calculatedPlatformFee: fareBreakdown.platformFeeGbp,
        driverEarnings: fareBreakdown.driverEarningsGbp,
        calculatedDriverEarnings: fareBreakdown.driverEarningsGbp,
        appliedCommissionRate: fareBreakdown.commissionRate,
        appliedDriverTier: fareBreakdown.driverTier,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      if (input.paymentUrl && typeof input.paymentUrl === "string") {
        qrPatch.paymentUrl = input.paymentUrl;
      }
      if (input.earlyCompletionReason) {
        qrPatch.earlyCompletionReason = String(input.earlyCompletionReason).trim().slice(0, 200);
      }
      tx.update(rideRef, qrPatch);
      return {
        success: true,
        rideId,
        status: "awaiting_payment",
        finalFare: fareBreakdown.baseFareGbp,
        tipAmount: fareBreakdown.tipGbp,
        totalFarePaid: fareBreakdown.totalCollectedGbp,
        driverEarnings: fareBreakdown.driverEarningsGbp,
        platformFee: fareBreakdown.platformFeeGbp,
        ...(passengerId ? { passengerId } : {}),
      };
    }

    // Abandonment flow: transition ride to rider_abandoned, apply strike & pendingCharges on passenger, and wait for QR settlement or manual closure
    if (action === "abandonment") {
      if (ride.status === "completed") {
        return {
          success: true,
          rideId,
          status: "completed",
          finalFare: fareBreakdown.baseFareGbp,
          tipAmount: fareBreakdown.tipGbp,
          totalFarePaid: fareBreakdown.totalCollectedGbp,
          driverEarnings: fareBreakdown.driverEarningsGbp,
          platformFee: fareBreakdown.platformFeeGbp,
          idempotent: true,
        };
      }
      validateRideTransition(currentStatus, "rider_abandoned");
      const alreadyAppliedAbandonment = ride.abandonmentApplied === true;
      const abandonPatch: Record<string, any> = {
        status: "rider_abandoned",
        paymentMethod: "stripe_qr",
        finalFare: fareBreakdown.baseFareGbp,
        tipAmount: fareBreakdown.tipGbp,
        totalFarePaid: fareBreakdown.totalCollectedGbp,
        fareContractVersion: "v2_excl_tip",
        paidWaitSeconds: fareBreakdown.paidWaitSeconds,
        abandonmentFee: fareBreakdown.abandonmentFeeGbp || ridesConfig.abandonmentFeeGbp,
        platformFee: fareBreakdown.platformFeeGbp,
        calculatedPlatformFee: fareBreakdown.platformFeeGbp,
        driverEarnings: fareBreakdown.driverEarningsGbp,
        calculatedDriverEarnings: fareBreakdown.driverEarningsGbp,
        appliedCommissionRate: fareBreakdown.commissionRate,
        appliedDriverTier: fareBreakdown.driverTier,
        abandonmentApplied: true,
        completedAt: ride.completedAt || admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      if (input.paymentUrl && typeof input.paymentUrl === "string") {
        abandonPatch.paymentUrl = input.paymentUrl;
      }
      tx.update(rideRef, abandonPatch);

      if (!alreadyAppliedAbandonment && passengerRef && passengerExists) {
        tx.update(passengerRef, {
          pendingCharges: admin.firestore.FieldValue.increment(fareBreakdown.totalCollectedGbp),
          pendingChargesReason: "Ride abandonment fee and partial fare",
          abandonmentStrikes: admin.firestore.FieldValue.increment(1),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }

      releaseOrPromoteTrackingInTx({
        tx,
        db,
        rideId,
        assignedDriverId,
        passengerId,
        driverTrackingData,
        driverStatusRef,
      });

      return {
        success: true,
        rideId,
        status: "rider_abandoned",
        finalFare: fareBreakdown.baseFareGbp,
        tipAmount: fareBreakdown.tipGbp,
        totalFarePaid: fareBreakdown.totalCollectedGbp,
        driverEarnings: fareBreakdown.driverEarningsGbp,
        platformFee: fareBreakdown.platformFeeGbp,
        ...(passengerId ? { passengerId } : {}),
      };
    }

    // Cash underpayment report -> awaiting_cash_confirm
    if (action === "cash_report") {
      const parsedCash =
        ride.reportedCashCollected !== undefined && ride.reportedCashCollected !== null
          ? Number(ride.reportedCashCollected)
          : input.cashCollected !== undefined && input.cashCollected !== null && String(input.cashCollected).trim() !== ""
            ? Number(input.cashCollected)
            : fareBreakdown.totalCollectedGbp;

      if (!Number.isFinite(parsedCash) || parsedCash < 0) {
        throw new BadRequestError("Invalid cashCollected amount");
      }

      const cashCollectedRounded = penceToGbp(roundToPence(parsedCash));
      const discrepancy = penceToGbp(
        Math.max(0, fareBreakdown.totalCollectedPence - roundToPence(cashCollectedRounded))
      );

      if (discrepancy > 0 && !input.forceComplete) {
        validateRideTransition(currentStatus, "awaiting_cash_confirm");
        tx.update(rideRef, {
          status: "awaiting_cash_confirm",
          finalFare: fareBreakdown.baseFareGbp,
          tipAmount: fareBreakdown.tipGbp,
          totalFarePaid: fareBreakdown.totalCollectedGbp,
          fareContractVersion: "v2_excl_tip",
          paidWaitSeconds: fareBreakdown.paidWaitSeconds,
          reportedCashCollected: cashCollectedRounded,
          reportedCashDiscrepancy: discrepancy,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        return {
          success: true,
          rideId,
          status: "awaiting_cash_confirm",
          awaitingCashConfirm: true,
          reportedCashCollected: cashCollectedRounded,
          reportedCashDiscrepancy: discrepancy,
          finalFare: fareBreakdown.baseFareGbp,
          tipAmount: fareBreakdown.tipGbp,
          totalFarePaid: fareBreakdown.totalCollectedGbp,
          driverEarnings: fareBreakdown.driverEarningsGbp,
          platformFee: fareBreakdown.platformFeeGbp,
          ...(passengerId ? { passengerId } : {}),
        };
      }
    }

    // Finalizing completion (auto_card, qr_manual_close, cash_finalize/cash_report full cash, cash_confirm_passenger, force_complete_passenger)
    if (ride.status === "completed" && ride.metricsCredited === true && ride.pendingChargesApplied === true) {
      return {
        success: true,
        rideId,
        status: "completed",
        idempotent: true,
        finalFare: Number(ride.finalFare ?? fareBreakdown.baseFareGbp),
        tipAmount: Number(ride.tipAmount ?? fareBreakdown.tipGbp),
        totalFarePaid: Number(ride.totalFarePaid ?? fareBreakdown.totalCollectedGbp),
        driverEarnings: Number(ride.driverEarnings ?? fareBreakdown.driverEarningsGbp),
        platformFee: Number(ride.platformFee ?? fareBreakdown.platformFeeGbp),
      };
    }

    // Validate state machine before completing
    if (ride.status !== "completed") {
      validateRideTransition(currentStatus, "completed");
    }

    const isCashCompletion =
      action === "cash_finalize" ||
      action === "cash_report" ||
      action === "cash_confirm_passenger" ||
      action === "force_complete_passenger";

    const paymentMethod = isCashCompletion
      ? "cash"
      : action === "auto_card"
        ? "stripe_auto"
        : ride.paymentMethod || "stripe_qr";

    let cashCollectedRounded = fareBreakdown.totalCollectedGbp;
    let discrepancy = 0;

    if (isCashCompletion) {
      const candidateCash =
        ride.reportedCashCollected !== undefined && ride.reportedCashCollected !== null
          ? Number(ride.reportedCashCollected)
          : input.cashCollected !== undefined && input.cashCollected !== null && String(input.cashCollected).trim() !== ""
            ? Number(input.cashCollected)
            : fareBreakdown.totalCollectedGbp;

      if (!Number.isFinite(candidateCash) || candidateCash < 0) {
        throw new BadRequestError("Invalid cashCollected amount");
      }
      cashCollectedRounded = penceToGbp(roundToPence(candidateCash));
      discrepancy = penceToGbp(
        Math.max(0, fareBreakdown.totalCollectedPence - roundToPence(cashCollectedRounded))
      );
    }

    const today = new Date().toISOString().split("T")[0];
    const mileage =
      (Number(ride.distanceToPickupMiles) || 0) + (Number(ride.distanceMiles) || 0);

    const completionPatch: Record<string, any> = {
      status: "completed",
      paymentMethod,
      finalFare: fareBreakdown.baseFareGbp,
      tipAmount: fareBreakdown.tipGbp,
      totalFarePaid: fareBreakdown.totalCollectedGbp,
      fareContractVersion: "v2_excl_tip",
      paidWaitSeconds: fareBreakdown.paidWaitSeconds,
      platformFee: fareBreakdown.platformFeeGbp,
      calculatedPlatformFee: fareBreakdown.platformFeeGbp,
      driverEarnings: fareBreakdown.driverEarningsGbp,
      calculatedDriverEarnings: fareBreakdown.driverEarningsGbp,
      appliedCommissionRate: fareBreakdown.commissionRate,
      appliedDriverTier: fareBreakdown.driverTier,
      completedAt: ride.completedAt || admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (input.earlyCompletionReason) {
      completionPatch.earlyCompletionReason = String(input.earlyCompletionReason).trim().slice(0, 200);
    }
    if (isCashCompletion) {
      completionPatch.paymentStatus = "cash_settled";
      completionPatch.platformFeeOwed = fareBreakdown.platformFeeGbp;
      completionPatch.reportedCashCollected = cashCollectedRounded;
      completionPatch.reportedCashDiscrepancy = discrepancy;
      completionPatch.forceCompleteReason =
        input.forceCompleteReason ? String(input.forceCompleteReason).trim().slice(0, 200) : (ride.forceCompleteReason || null);
      completionPatch.payoutTransferred = true;
      completionPatch.payoutStatus = "cash_collected_direct";
    } else if (action === "auto_card") {
      // Only mark settled if already Stripe-verified; otherwise keep paymentStatus pending until Stripe capture/webhook
      if (!ride.paymentStatus) {
        completionPatch.paymentStatus = "pending";
      }
      if (ride.payoutTransferred === undefined) {
        completionPatch.payoutTransferred = false;
      }
    } else if (action === "qr_manual_close") {
      if (!ride.paymentStatus) {
        completionPatch.paymentStatus = "pending";
      }
      if (ride.payoutTransferred === undefined) {
        completionPatch.payoutTransferred = false;
      }
    }

    const shouldApplyPassengerCharges = ride.pendingChargesApplied !== true;
    const shouldCreditMetrics = ride.metricsCredited !== true;

    if (shouldApplyPassengerCharges) {
      completionPatch.pendingChargesApplied = true;
    }
    if (shouldCreditMetrics) {
      completionPatch.metricsCredited = true;
    }

    tx.update(rideRef, completionPatch);

    // Apply or clear passenger pendingCharges atomically
    if (shouldApplyPassengerCharges && passengerRef && passengerExists) {
      if (isCashCompletion && discrepancy > 0) {
        tx.update(passengerRef, {
          pendingCharges: admin.firestore.FieldValue.increment(discrepancy),
          pendingChargesReason:
            input.forceCompleteReason || "Unpaid cash trip balance",
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      } else {
        tx.update(passengerRef, {
          pendingCharges: 0,
          cancellationCount: 0,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
    }

    // Credit driver profile & driver_metrics atomically (using NET driverEarnings, never gross!)
    if (shouldCreditMetrics && assignedDriverId) {
      if (driverRef) {
        const driverProfilePatch: Record<string, any> = {
          totalEarnings: admin.firestore.FieldValue.increment(fareBreakdown.driverEarningsGbp),
          jobsCompleted: admin.firestore.FieldValue.increment(1),
          totalBusinessMileage: admin.firestore.FieldValue.increment(mileage),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        };
        if (isCashCompletion && fareBreakdown.platformFeeGbp > 0) {
          driverProfilePatch.pendingPlatformFees = admin.firestore.FieldValue.increment(
            fareBreakdown.platformFeeGbp
          );
        }
        tx.update(driverRef, driverProfilePatch);
      }

      if (driverMetricsRef) {
        const isSameDay = metricsData?.date === today;
        const baseDailyEarnings = isSameDay ? Number(metricsData?.dailyEarnings || 0) : 0;
        const baseJobsToday = isSameDay ? Number(metricsData?.jobsDoneToday ?? metricsData?.ridesToday ?? 0) : 0;
        tx.set(
          driverMetricsRef,
          {
            driverId: assignedDriverId,
            date: today,
            dailyEarnings: penceToGbp(roundToPence(baseDailyEarnings + fareBreakdown.driverEarningsGbp)),
            jobsDoneToday: baseJobsToday + 1,
            ridesToday: baseJobsToday + 1,
            ...(!isSameDay ? { onlineSecondsToday: 0, lastHeartbeatAtMs: null } : {}),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      }
    }

    releaseOrPromoteTrackingInTx({
      tx,
      db,
      rideId,
      assignedDriverId,
      passengerId,
      driverTrackingData,
      driverStatusRef,
    });

    return {
      success: true,
      rideId,
      status: "completed",
      paymentMethod,
      finalFare: fareBreakdown.baseFareGbp,
      tipAmount: fareBreakdown.tipGbp,
      totalFarePaid: fareBreakdown.totalCollectedGbp,
      driverEarnings: fareBreakdown.driverEarningsGbp,
      platformFee: fareBreakdown.platformFeeGbp,
      reportedCashCollected: isCashCompletion ? cashCollectedRounded : undefined,
      reportedCashDiscrepancy: isCashCompletion ? discrepancy : undefined,
      ...(passengerId ? { passengerId } : {}),
      ...(assignedDriverId ? { assignedDriverId } : {}),
    };
  });
}

export interface CancelRideInput {
  db: any;
  caller: CallerIdentity;
  rideId: string;
  cancelledBy?: "passenger" | "driver" | "admin";
}

export async function executeCancelRideCommand(input: CancelRideInput) {
  const { db, caller, rideId } = input;
  if (!caller?.uid) throw new UnauthorizedError("Authentication required.");
  if (!db) throw new BadRequestError("Database backend unavailable");
  if (!rideId || typeof rideId !== "string" || !rideId.trim()) {
    throw new BadRequestError("Missing or invalid rideId");
  }

  const isAdmin = caller.isAdmin === true || caller.admin === true;
  const rideRef = db.collection("ride_requests").doc(rideId);
  const ridesConfig = await loadRidesFareConfig(db);

  return db.runTransaction(async (tx: any) => {
    const rideSnap = await tx.get(rideRef);
    const exists = typeof rideSnap.exists === "function" ? rideSnap.exists() : rideSnap.exists;
    if (!exists) throw new NotFoundError("Ride request not found");

    const ride = typeof rideSnap.data === "function" ? rideSnap.data() : rideSnap.data;
    const passengerId = ride.passengerId || ride.riderId || ride.userId;
    const assignedDriverId = ride.assignedDriverId || ride.driverId;

    const isPassenger = Boolean(passengerId && passengerId === caller.uid);
    const isDriver = Boolean(assignedDriverId && assignedDriverId === caller.uid);
    if (!isPassenger && !isDriver && !isAdmin) {
      throw new ForbiddenError("Forbidden: You are not authorized to cancel this ride.");
    }

    if (ride.status === "cancelled") {
      return {
        success: true,
        rideId,
        status: "cancelled",
        cancellationFee: Number(ride.cancellationFee || 0),
        alreadyCancelled: true,
      };
    }

    if (ride.status === "completed") {
      throw new ConflictError("Cannot cancel a completed ride.");
    }

    validateRideTransition((ride.status || "pending") as RideStatus, "cancelled");

    const effectiveCancelledBy = input.cancelledBy || (isDriver ? "driver" : isAdmin ? "admin" : "passenger");

    const passengerRef = passengerId ? db.collection("users").doc(passengerId) : null;
    const driverMetricsRef = assignedDriverId ? db.collection("driver_metrics").doc(assignedDriverId) : null;
    const driverStatusRef = assignedDriverId ? db.collection("driver_status").doc(assignedDriverId) : null;
    const driverTrackingRef = assignedDriverId ? db.collection("live_tracking").doc(assignedDriverId) : null;

    const [passengerSnap, metricsSnap, driverTrackingSnap] = await Promise.all([
      passengerRef ? tx.get(passengerRef) : Promise.resolve(null),
      driverMetricsRef ? tx.get(driverMetricsRef) : Promise.resolve(null),
      driverTrackingRef ? tx.get(driverTrackingRef) : Promise.resolve(null),
    ]);

    const passengerExists = Boolean(
      passengerSnap && (typeof passengerSnap.exists === "function" ? passengerSnap.exists() : passengerSnap.exists)
    );
    const metricsData =
      metricsSnap && (typeof metricsSnap.exists === "function" ? metricsSnap.exists() : metricsSnap.exists)
        ? (typeof metricsSnap.data === "function" ? metricsSnap.data() : metricsSnap.data)
        : null;
    const driverTrackingData =
      driverTrackingSnap && (typeof driverTrackingSnap.exists === "function" ? driverTrackingSnap.exists() : driverTrackingSnap.exists)
        ? (typeof driverTrackingSnap.data === "function" ? driverTrackingSnap.data() : driverTrackingSnap.data)
        : null;

    // Server-authoritative cancellation fee calculation
    let cancellationFee = 0;
    const nowMs = Date.now();
    const parseTs = (ts: any): number => {
      if (!ts) return 0;
      if (typeof ts.toMillis === "function") return ts.toMillis();
      if (typeof ts._seconds === "number") return ts._seconds * 1000;
      if (typeof ts.seconds === "number") return ts.seconds * 1000;
      if (typeof ts === "number") return ts;
      return 0;
    };

    if (effectiveCancelledBy === "passenger" && assignedDriverId) {
      const limitMins = ridesConfig.driverWaitTimeLimitMins || 5;
      const maxWaitSeconds = limitMins * 60;
      const freeWaitSeconds = Math.max(60, maxWaitSeconds - 120);
      const arrivedMs = parseTs(ride.arrivedAt);
      const acceptedMs = parseTs(ride.acceptedAt) || parseTs(ride.assignedAt);

      if (ride.status === "arrived" && arrivedMs > 0) {
        const elapsedArrivedSec = Math.floor((nowMs - arrivedMs) / 1000);
        if (elapsedArrivedSec >= freeWaitSeconds) {
          cancellationFee = penceToGbp(roundToPence(ridesConfig.baseFare));
        }
      } else if (acceptedMs > 0 && nowMs - acceptedMs > 120000) {
        cancellationFee = penceToGbp(roundToPence(ridesConfig.baseFare));
      }
    }

    const cancelPatch: Record<string, any> = {
      status: "cancelled",
      cancelledBy: effectiveCancelledBy,
      cancellationFee,
      cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (cancellationFee > 0) {
      cancelPatch.cancellationFeeCredited = true;
    }

    tx.update(rideRef, cancelPatch);

    if (cancellationFee > 0 && passengerRef && passengerExists) {
      tx.update(passengerRef, {
        pendingCharges: admin.firestore.FieldValue.increment(cancellationFee),
        pendingChargesReason: "Late passenger cancellation fee",
        cancellationCount: admin.firestore.FieldValue.increment(1),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    if (cancellationFee > 0 && driverMetricsRef) {
      const today = new Date().toISOString().split("T")[0];
      const isSameDay = metricsData?.date === today;
      const baseDailyEarnings = isSameDay ? Number(metricsData?.dailyEarnings || 0) : 0;
      const baseJobsToday = isSameDay ? Number(metricsData?.jobsDoneToday || 0) : 0;
      tx.set(
        driverMetricsRef,
        {
          driverId: assignedDriverId,
          date: today,
          dailyEarnings: penceToGbp(roundToPence(baseDailyEarnings + cancellationFee)),
          jobsDoneToday: baseJobsToday,
          ...(!isSameDay ? { onlineSecondsToday: 0, lastHeartbeatAtMs: null } : {}),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }

    releaseOrPromoteTrackingInTx({
      tx,
      db,
      rideId,
      assignedDriverId,
      passengerId,
      driverTrackingData,
      driverStatusRef,
    });

    return {
      success: true,
      rideId,
      status: "cancelled",
      cancelledBy: effectiveCancelledBy,
      cancellationFee,
      ...(assignedDriverId ? { assignedDriverId } : {}),
      ...(passengerId ? { passengerId } : {}),
    };
  });
}

/**
 * Webhook fulfillment for Stripe Checkout Session (`meta.type === "taxi_trip"`).
 * Atomically marks the ride completed & paid, records RIDE_PAYMENT ledger,
 * clears passenger pendingCharges, and credits driver_metrics once.
 */
export async function fulfillTaxiTripCheckout(params: {
  db: any;
  event: { id: string };
  session: Stripe.Checkout.Session | any;
  intent: Record<string, any>;
  eventRef?: any;
  claimToken?: string | null;
}) {
  const { db, event, session, intent, eventRef, claimToken } = params;
  const meta = intent?.metadata || {};
  const rideId = String(meta.rideId || "").trim();
  if (!db || !rideId) {
    throw new BadRequestError("Taxi trip webhook fulfillment is missing rideId.");
  }

  const sessionCurrency = String(session.currency || "gbp").toLowerCase();
  if (sessionCurrency !== "gbp") {
    throw new BadRequestError(`Invalid taxi trip currency '${sessionCurrency}'`);
  }

  const collectionName = meta.rideCollectionName === "rides" ? "rides" : "ride_requests";
  const rideRef = db.collection(collectionName).doc(rideId);
  const fulfillmentRef = db.collection("stripe_fulfillments").doc(`taxi_trip_${session.id}`);
  const ledgerRef = db.collection("payment_ledger").doc(`ride_pay_${session.id}`);

  const paymentIntentId =
    typeof session.payment_intent === "string"
      ? session.payment_intent
      : typeof session.payment_intent?.id === "string"
        ? session.payment_intent.id
        : null;

  const ridesConfig = await loadRidesFareConfig(db);

  await db.runTransaction(async (tx: any) => {
    const readPromises: Promise<any>[] = [tx.get(rideRef), tx.get(fulfillmentRef)];
    if (eventRef) readPromises.push(tx.get(eventRef));
    const [rideSnap, fulfillmentSnap, claimSnap] = await Promise.all(readPromises);

    if (eventRef && claimToken) {
      const claimData = claimSnap?.data?.() || {};
      if (!ownsStripeWebhookClaim(claimData, claimToken)) {
        throw new Error("Webhook claim lost before taxi trip fulfillment mutation.");
      }
    }

    const fulfillmentExists =
      fulfillmentSnap &&
      (typeof fulfillmentSnap.exists === "function" ? fulfillmentSnap.exists() : fulfillmentSnap.exists);
    if (fulfillmentExists) return;

    const rideExists = rideSnap && (typeof rideSnap.exists === "function" ? rideSnap.exists() : rideSnap.exists);
    if (!rideExists) throw new NotFoundError(`Taxi trip ride ${rideId} does not exist.`);

    const ride = typeof rideSnap.data === "function" ? rideSnap.data() : rideSnap.data;
    const assignedDriverId = meta.driverId || ride.assignedDriverId || ride.driverId;
    const passengerId = meta.passengerId || ride.passengerId || ride.riderId || ride.userId;

    const driverRef = assignedDriverId ? db.collection("users").doc(assignedDriverId) : null;
    const passengerRef = passengerId ? db.collection("users").doc(passengerId) : null;
    const metricsRef = assignedDriverId ? db.collection("driver_metrics").doc(assignedDriverId) : null;
    const driverStatusRef = assignedDriverId ? db.collection("driver_status").doc(assignedDriverId) : null;
    const driverTrackingRef = assignedDriverId ? db.collection("live_tracking").doc(assignedDriverId) : null;

    const [driverSnap, passengerSnap, metricsSnap, driverTrackingSnap] = await Promise.all([
      driverRef ? tx.get(driverRef) : Promise.resolve(null),
      passengerRef ? tx.get(passengerRef) : Promise.resolve(null),
      metricsRef ? tx.get(metricsRef) : Promise.resolve(null),
      driverTrackingRef ? tx.get(driverTrackingRef) : Promise.resolve(null),
    ]);

    const driverData =
      driverSnap && (typeof driverSnap.exists === "function" ? driverSnap.exists() : driverSnap.exists)
        ? (typeof driverSnap.data === "function" ? driverSnap.data() : driverSnap.data)
        : null;
    const passengerExists = Boolean(
      passengerSnap && (typeof passengerSnap.exists === "function" ? passengerSnap.exists() : passengerSnap.exists)
    );
    const metricsData =
      metricsSnap && (typeof metricsSnap.exists === "function" ? metricsSnap.exists() : metricsSnap.exists)
        ? (typeof metricsSnap.data === "function" ? metricsSnap.data() : metricsSnap.data)
        : null;
    const driverTrackingData =
      driverTrackingSnap && (typeof driverTrackingSnap.exists === "function" ? driverTrackingSnap.exists() : driverTrackingSnap.exists)
        ? (typeof driverTrackingSnap.data === "function" ? driverTrackingSnap.data() : driverTrackingSnap.data)
        : null;

    const expectedTotalPence = Number(meta.totalAmountPence || intent.amount || 0);
    const paidAmountPence = Number(session.amount_total || 0);
    if (!Number.isFinite(paidAmountPence) || paidAmountPence <= 0 || paidAmountPence < expectedTotalPence) {
      throw new BadRequestError(
        `Taxi trip underpayment detected: received ${paidAmountPence}p, expected ${expectedTotalPence}p`
      );
    }

    const baseFarePence = Number(meta.finalFarePence) > 0
      ? Number(meta.finalFarePence)
      : roundToPence(Number(meta.baseFare || 0));
    const tipPence = Number(meta.tipPence) >= 0 && meta.tipPence !== undefined
      ? Number(meta.tipPence)
      : roundToPence(Number(meta.tipAmount || 0));

    const { commissionRate, fixedTripFee, tier } = resolveEffectiveCommissionRate(driverData, ridesConfig);
    const platformFeePence =
      Number(meta.platformFeePence) >= 0 && meta.platformFeePence !== undefined
        ? Number(meta.platformFeePence)
        : Math.min(baseFarePence, Math.round(baseFarePence * commissionRate) + roundToPence(fixedTripFee));
    const driverEarningsPence =
      Number(meta.driverEarningsPence) > 0
        ? Number(meta.driverEarningsPence)
        : (baseFarePence - platformFeePence) + tipPence;

    const baseFareGbp = penceToGbp(baseFarePence);
    const tipGbp = penceToGbp(tipPence);
    const totalPaidGbp = penceToGbp(paidAmountPence);
    const platformFeeGbp = penceToGbp(platformFeePence);
    const driverEarningsGbp = penceToGbp(driverEarningsPence);

    const isDestinationCharge =
      meta.isDestinationCharge === true ||
      meta.isDestinationCharge === "true" ||
      Boolean(meta.stripeAccountId);

    const shouldApplyPassengerClear = ride.pendingChargesApplied !== true;
    const shouldCreditMetrics = ride.metricsCredited !== true;
    const today = new Date().toISOString().split("T")[0];
    const mileage = (Number(ride.distanceToPickupMiles) || 0) + (Number(ride.distanceMiles) || 0);

    tx.update(rideRef, {
      status: "completed",
      paymentMethod: ride.paymentMethod || "stripe_qr",
      paymentStatus: "paid",
      paid: true,
      isPaid: true,
      paidAt: ride.paidAt || admin.firestore.FieldValue.serverTimestamp(),
      completedAt: ride.completedAt || admin.firestore.FieldValue.serverTimestamp(),
      finalFare: baseFareGbp,
      tipAmount: tipGbp,
      totalFarePaid: totalPaidGbp,
      fareContractVersion: "v2_excl_tip",
      platformFee: platformFeeGbp,
      calculatedPlatformFee: platformFeeGbp,
      driverEarnings: driverEarningsGbp,
      calculatedDriverEarnings: driverEarningsGbp,
      appliedCommissionRate: commissionRate,
      appliedDriverTier: tier,
      stripeSessionId: session.id,
      stripePaymentIntentId: paymentIntentId,
      paymentIntentId: paymentIntentId,
      payoutTransferred: isDestinationCharge,
      payoutStatus: isDestinationCharge ? "direct_destination_charge" : "pending",
      ...(isDestinationCharge ? { payoutTransferredAt: admin.firestore.FieldValue.serverTimestamp() } : {}),
      pendingChargesApplied: true,
      metricsCredited: true,
      paymentUrl: admin.firestore.FieldValue.delete(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    if (shouldApplyPassengerClear && passengerRef && passengerExists) {
      tx.update(passengerRef, {
        pendingCharges: 0,
        cancellationCount: 0,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    if (shouldCreditMetrics && assignedDriverId) {
      if (driverRef) {
        tx.update(driverRef, {
          totalEarnings: admin.firestore.FieldValue.increment(driverEarningsGbp),
          jobsCompleted: admin.firestore.FieldValue.increment(1),
          totalBusinessMileage: admin.firestore.FieldValue.increment(mileage),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
      if (metricsRef) {
        const isSameDay = metricsData?.date === today;
        const baseDailyEarnings = isSameDay ? Number(metricsData?.dailyEarnings || 0) : 0;
        const baseJobsToday = isSameDay ? Number(metricsData?.jobsDoneToday ?? metricsData?.ridesToday ?? 0) : 0;
        tx.set(
          metricsRef,
          {
            driverId: assignedDriverId,
            date: today,
            dailyEarnings: penceToGbp(roundToPence(baseDailyEarnings + driverEarningsGbp)),
            jobsDoneToday: baseJobsToday + 1,
            ridesToday: baseJobsToday + 1,
            ...(!isSameDay ? { onlineSecondsToday: 0, lastHeartbeatAtMs: null } : {}),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      }
    }

    releaseOrPromoteTrackingInTx({
      tx,
      db,
      rideId,
      assignedDriverId,
      passengerId,
      driverTrackingData,
      driverStatusRef,
    });

    tx.create(ledgerRef, {
      type: "RIDE_PAYMENT",
      transactionId: paymentIntentId || `ride_${rideId}`,
      rideId,
      driverId: assignedDriverId || null,
      passengerId: passengerId || null,
      amount: paidAmountPence,
      baseFarePence,
      tipPence,
      platformFeePence,
      driverEarningsPence,
      currency: "gbp",
      status: "completed",
      captured: true,
      stripeSessionId: session.id,
      stripeEventId: event.id,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    tx.create(fulfillmentRef, {
      eventId: event.id,
      sessionId: session.id,
      intentId: session.metadata?.intentId || intent.intentId || null,
      paymentIntentId,
      rideId,
      driverId: assignedDriverId || null,
      passengerId: passengerId || null,
      amountPence: paidAmountPence,
      currency: "gbp",
      type: "taxi_trip",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  });

  return { success: true, rideId, sessionId: session.id };
}

/**
 * Authoritative Cash Platform Fee Settlement Checkout Creation (AT-RIDE-PAY-07).
 * Derives amount strictly from `users/{driverId}.pendingPlatformFees` and creates a verified `payment_intents` record.
 */
export async function createDriverFeeSettlementCheckout(params: {
  db: any;
  driverId: string;
  stripeClient: Stripe;
  appUrl: string;
}) {
  const { db, driverId, stripeClient, appUrl } = params;
  if (!db) throw new BadRequestError("Database backend unavailable");
  if (!driverId) throw new UnauthorizedError("Authentication required.");

  const driverDoc = await db.collection("users").doc(driverId).get();
  const driverExists = typeof driverDoc.exists === "function" ? driverDoc.exists() : driverDoc.exists;
  if (!driverExists) {
    throw new NotFoundError("Driver profile not found.");
  }

  const driverData = typeof driverDoc.data === "function" ? driverDoc.data() : driverDoc.data;
  const pendingFeesGbp = Number(driverData?.pendingPlatformFees || 0);
  const amountPence = roundToPence(pendingFeesGbp);

  if (!Number.isFinite(pendingFeesGbp) || amountPence <= 0) {
    throw new BadRequestError("No fees to settle");
  }

  const hash = createHash("sha256")
    .update(`fee-settle:${driverId}:${amountPence}:${Math.floor(Date.now() / 60000)}`)
    .digest("hex")
    .slice(0, 24);
  const intentId = `fee_chk_${hash}`;

  const intentRef = db.collection("payment_intents").doc(intentId);
  await intentRef.set({
    intentId,
    userId: driverId,
    mode: "payment",
    currency: "gbp",
    amount: amountPence,
    status: "pending",
    metadata: {
      intentId,
      driverId,
      expectedAmountPence: String(amountPence),
      type: "fee_settlement",
    },
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  const finalSuccessUrl = sanitizeRedirectUrl(
    `/platform-fee-success?session_id={CHECKOUT_SESSION_ID}`,
    appUrl,
    `/platform-fee-success`
  );
  const finalCancelUrl = sanitizeRedirectUrl(`/driver-dashboard`, appUrl, `/driver-dashboard`);

  try {
    const session = await stripeClient.checkout.sessions.create(
      {
        mode: "payment",
        payment_method_types: ["card"],
        client_reference_id: driverId,
        line_items: [
          {
            price_data: {
              currency: "gbp",
              product_data: {
                name: "Platform Fees Settlement",
                description: "Settlement for accumulated cash trip commissions.",
              },
              unit_amount: amountPence,
            },
            quantity: 1,
          },
        ],
        metadata: {
          intentId,
          driverId,
          type: "fee_settlement",
        },
        payment_intent_data: {
          metadata: {
            intentId,
            driverId,
            type: "fee_settlement",
          },
        },
        success_url: finalSuccessUrl,
        cancel_url: finalCancelUrl,
      },
      {
        idempotencyKey: `fee_settlement_${driverId}_${amountPence}_${hash}`,
      }
    );

    const sessionPaymentIntentId =
      typeof session.payment_intent === "string"
        ? session.payment_intent
        : typeof (session.payment_intent as any)?.id === "string"
          ? (session.payment_intent as any).id
          : null;

    await intentRef.update({
      checkoutSessionId: session.id,
      currency: String(session.currency || "gbp").toLowerCase(),
      paymentIntentId: sessionPaymentIntentId,
      status: "session_created",
      sessionCreatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return {
      url: session.url,
      sessionId: session.id,
      intentId,
      amountPence,
    };
  } catch (err: any) {
    await intentRef
      .update({
        status: "failed",
        failureReason: err?.message || "stripe_fee_settlement_session_failed",
        failedAt: admin.firestore.FieldValue.serverTimestamp(),
      })
      .catch(() => undefined);
    throw err;
  }
}

/**
 * Signed Webhook Fulfillment for Driver Cash Platform Fee Settlement (`meta.type === "fee_settlement"`).
 */
export async function fulfillDriverFeeSettlementWebhook(params: {
  db: any;
  event: { id: string };
  session: Stripe.Checkout.Session | any;
  intent: Record<string, any>;
  eventRef?: any;
  claimToken?: string | null;
}) {
  const { db, event, session, intent, eventRef, claimToken } = params;
  const meta = intent?.metadata || {};
  const driverId = String(meta.driverId || intent.userId || "").trim();
  if (!db || !driverId) {
    throw new BadRequestError("Driver fee settlement webhook is missing driverId.");
  }

  const currency = String(session.currency || "gbp").toLowerCase();
  if (currency !== "gbp") {
    throw new BadRequestError(`Invalid fee settlement currency '${currency}'`);
  }

  const paidPence = Number(session.amount_total || 0);
  const expectedPence = Number(meta.expectedAmountPence || intent.amount || 0);
  if (!Number.isFinite(paidPence) || paidPence <= 0 || paidPence < expectedPence) {
    throw new BadRequestError(
      `Fee settlement underpayment detected: received ${paidPence}p, expected ${expectedPence}p`
    );
  }

  const driverRef = db.collection("users").doc(driverId);
  const fulfillmentRef = db.collection("stripe_fulfillments").doc(`fee_settlement_${session.id}`);
  const settlementRef = db.collection("driver_fee_settlements").doc(session.id);
  const ledgerRef = db.collection("payment_ledger").doc(`fee_settle_${session.id}`);
  const paymentIntentId =
    typeof session.payment_intent === "string"
      ? session.payment_intent
      : typeof session.payment_intent?.id === "string"
        ? session.payment_intent.id
        : null;

  await db.runTransaction(async (tx: any) => {
    const readPromises: Promise<any>[] = [tx.get(driverRef), tx.get(fulfillmentRef)];
    if (eventRef) readPromises.push(tx.get(eventRef));
    const [driverSnap, fulfillmentSnap, claimSnap] = await Promise.all(readPromises);

    if (eventRef && claimToken) {
      const claimData = claimSnap?.data?.() || {};
      if (!ownsStripeWebhookClaim(claimData, claimToken)) {
        throw new Error("Webhook claim lost before fee settlement mutation.");
      }
    }

    const fulfillmentExists =
      fulfillmentSnap &&
      (typeof fulfillmentSnap.exists === "function" ? fulfillmentSnap.exists() : fulfillmentSnap.exists);
    if (fulfillmentExists) return;

    const driverExists =
      driverSnap && (typeof driverSnap.exists === "function" ? driverSnap.exists() : driverSnap.exists);
    if (!driverExists) throw new NotFoundError(`Driver ${driverId} does not exist for fee settlement.`);

    const driverData = typeof driverSnap.data === "function" ? driverSnap.data() : driverSnap.data;
    const currentPendingPence = roundToPence(Number(driverData?.pendingPlatformFees || 0));
    const remainingPendingGbp = penceToGbp(Math.max(0, currentPendingPence - paidPence));
    const settledGbp = penceToGbp(paidPence);

    tx.update(driverRef, {
      pendingPlatformFees: remainingPendingGbp,
      lastFeeSettlementAt: admin.firestore.FieldValue.serverTimestamp(),
      lastFeeSettlementAmount: settledGbp,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    tx.create(settlementRef, {
      sessionId: session.id,
      paymentIntentId,
      intentId: session.metadata?.intentId || intent.intentId || null,
      driverId,
      settledAmount: settledGbp,
      amountPence: paidPence,
      currency: "gbp",
      status: "settled",
      stripeEventId: event.id,
      settledAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    tx.create(ledgerRef, {
      type: "DRIVER_FEE_SETTLEMENT",
      transactionId: paymentIntentId || session.id,
      driverId,
      amount: paidPence,
      currency: "gbp",
      status: "completed",
      captured: true,
      stripeSessionId: session.id,
      stripeEventId: event.id,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    tx.create(fulfillmentRef, {
      eventId: event.id,
      sessionId: session.id,
      intentId: session.metadata?.intentId || intent.intentId || null,
      paymentIntentId,
      driverId,
      settledAmount: settledGbp,
      amountPence: paidPence,
      currency: "gbp",
      type: "fee_settlement",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  });

  return {
    success: true,
    driverId,
    settledAmount: penceToGbp(paidPence),
    sessionId: session.id,
  };
}

/**
 * Server-Authoritative Driver Online Heartbeat & Telemetry (AT-RIDE-PAY-09).
 * Replaces direct client writes to `driver_metrics/{driverId}` with bounded,
 * UTC-day-aware, suspended-account-checked server transactions.
 */
export async function recordDriverOnlineHeartbeat(params: {
  db: any;
  caller: CallerIdentity;
  nowMs?: number;
}) {
  const { db, caller } = params;
  if (!caller?.uid) throw new UnauthorizedError("Authentication required.");
  if (!db) throw new BadRequestError("Database backend unavailable");

  const nowMs =
    typeof params.nowMs === "number" && Number.isFinite(params.nowMs) ? params.nowMs : Date.now();
  const today = new Date(nowMs).toISOString().split("T")[0];
  const ridesConfig = await loadRidesFareConfig(db);
  const maxDailyDriverHours = Math.max(1, Number(ridesConfig.maxDailyDriverHours || 24));
  const maxDailySeconds = maxDailyDriverHours * 3600;

  const userRef = db.collection("users").doc(caller.uid);
  const metricsRef = db.collection("driver_metrics").doc(caller.uid);

  return db.runTransaction(async (tx: any) => {
    const [userSnap, metricsSnap] = await Promise.all([tx.get(userRef), tx.get(metricsRef)]);
    const userExists =
      userSnap && (typeof userSnap.exists === "function" ? userSnap.exists() : userSnap.exists);
    if (!userExists) {
      throw new NotFoundError("Driver profile not found.");
    }

    const userData = typeof userSnap.data === "function" ? userSnap.data() : userSnap.data;
    if (
      userData?.accountStatus === "suspended" ||
      userData?.isSuspended === true ||
      userData?.disabled === true
    ) {
      throw new ForbiddenError("Suspended accounts cannot record driver activity.");
    }

    const metricsExists =
      metricsSnap &&
      (typeof metricsSnap.exists === "function" ? metricsSnap.exists() : metricsSnap.exists);
    const metricsData = metricsExists
      ? (typeof metricsSnap.data === "function" ? metricsSnap.data() : metricsSnap.data)
      : {};

    const isSameDay = metricsData?.date === today;
    const prevOnlineSeconds = isSameDay
      ? Math.max(0, Number(metricsData?.onlineSecondsToday || 0))
      : 0;
    const prevHeartbeatMs =
      isSameDay && Number.isFinite(Number(metricsData?.lastHeartbeatAtMs))
        ? Number(metricsData.lastHeartbeatAtMs)
        : null;

    let incrementSeconds = 60;
    if (prevHeartbeatMs !== null) {
      const elapsedSeconds = Math.floor((nowMs - prevHeartbeatMs) / 1000);
      if (elapsedSeconds < 45) {
        incrementSeconds = 0;
      } else {
        incrementSeconds = Math.min(60, Math.max(0, elapsedSeconds));
      }
    }

    const nextOnlineSeconds = Math.min(maxDailySeconds, prevOnlineSeconds + incrementSeconds);
    const limitReached = nextOnlineSeconds >= maxDailySeconds;

    const patch: Record<string, any> = {
      driverId: caller.uid,
      date: today,
      onlineSecondsToday: nextOnlineSeconds,
      dailyEarnings: isSameDay ? Number(metricsData?.dailyEarnings || 0) : 0,
      jobsDoneToday: isSameDay ? Number(metricsData?.jobsDoneToday || 0) : 0,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (incrementSeconds > 0 || prevHeartbeatMs === null || !isSameDay) {
      patch.lastHeartbeatAtMs = nowMs;
    }

    tx.set(metricsRef, patch, { merge: true });

    return {
      success: true,
      date: today,
      onlineSecondsToday: nextOnlineSeconds,
      dailyEarnings: patch.dailyEarnings,
      jobsDoneToday: patch.jobsDoneToday,
      maxDailyDriverHours,
      limitReached,
      incrementSeconds,
    };
  });
}
