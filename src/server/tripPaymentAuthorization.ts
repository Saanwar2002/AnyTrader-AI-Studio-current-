/**
 * AnyTrader V8.3 Task 35-C & Batch 8 — Trip Payment Recipient Integrity & Authoritative Checkout Binding
 *
 * Enforces:
 * - Server-authoritative recipient determination and driver Stripe Connect routing
 * - Canonical live booking fare & tip contract ("v2_excl_tip": finalFare excludes tip)
 * - Authoritative `payment_intents` + `client_reference_id` + `intentId` binding for Stripe webhooks (AT-RIDE-PAY-01)
 * - Durable per-ride idempotency records + deterministic Stripe idempotency keys (AT-RIDE-PAY-02)
 */

import Stripe from "stripe";
import { createHash } from "node:crypto";
import admin from "firebase-admin";
import { UnauthorizedError, ForbiddenError, BadRequestError, ConflictError } from "./httpErrors.ts";
import {
  computeAuthoritativeRideFare,
  loadRidesFareConfig,
  penceToGbp,
  roundToPence,
} from "./rideFareCalculator.ts";

export interface AuthenticatedUser {
  uid: string;
  email?: string;
  isAdmin?: boolean;
  admin?: boolean;
  [key: string]: any;
}

export interface CreateTripPaymentInput {
  db: any;
  caller: AuthenticatedUser;
  body: {
    rideId?: string;
    id?: string;
    driverId?: string;
    recipientId?: string;
    payeeId?: string;
    driverUid?: string;
    stripeAccountId?: string;
    connectedAccountId?: string;
    destinationAccountId?: string;
    transferDestination?: string;
    accountId?: string;
    tipAmount?: number | string;
    paidWaitSeconds?: number | string;
    isAbandonment?: boolean;
    baseFare?: number | string;
    amount?: number | string;
    [key: string]: any;
  };
  stripeClient?: Stripe | null;
  appUrl?: string;
}

export interface AuthoritativeTripPaymentResult {
  success: boolean;
  url: string;
  rideId: string;
  driverId: string;
  recipientId: string;
  stripeAccountId: string;
  effectiveBaseFare: number;
  sanitizedTip: number;
  totalAmount: number;
  feeAmount: number;
  intentId?: string;
  reused?: boolean;
  session?: any;
}

function parseMillis(value: any): number {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value._seconds === "number") return value._seconds * 1000;
  if (typeof value.seconds === "number") return value.seconds * 1000;
  return 0;
}

const TRIP_CHECKOUT_REUSE_WINDOW_MS = 20 * 60 * 60 * 1000; // 20 hours (< Stripe's 24h expiry)

export async function executeCreateTripPaymentCommand(
  input: CreateTripPaymentInput
): Promise<AuthoritativeTripPaymentResult> {
  const { db, caller, body, stripeClient, appUrl } = input;

  // 1. Authenticate caller
  if (!caller || !caller.uid) {
    throw new UnauthorizedError("Authentication required to process trip payment.");
  }

  const callerUid = caller.uid;
  const isCallerAdmin = caller.isAdmin === true || caller.admin === true;

  if (!db) {
    throw new BadRequestError("Database backend unavailable");
  }

  // 2. Resolve rideId
  const rideId = body?.rideId || body?.id;
  if (!rideId || typeof rideId !== "string" || !rideId.trim()) {
    throw new BadRequestError("Missing or invalid rideId");
  }

  // 3. Load authoritative ride document from Firestore
  let rideData: any = null;
  let rideCollectionName: "ride_requests" | "rides" = "ride_requests";
  try {
    const rideSnap = await db.collection("ride_requests").doc(rideId).get();
    if (rideSnap && (typeof rideSnap.exists === "function" ? rideSnap.exists() : rideSnap.exists)) {
      rideData = typeof rideSnap.data === "function" ? rideSnap.data() : rideSnap.data;
    } else {
      const legacySnap = await db.collection("rides").doc(rideId).get();
      if (legacySnap && (typeof legacySnap.exists === "function" ? legacySnap.exists() : legacySnap.exists)) {
        rideData = typeof legacySnap.data === "function" ? legacySnap.data() : legacySnap.data;
        rideCollectionName = "rides";
      }
    }
  } catch (err: any) {
    console.warn("Could not query ride record from Firestore:", err?.message);
  }

  if (!rideData) {
    throw new BadRequestError("Ride record not found");
  }

  if (rideData.paymentStatus === "paid" || rideData.paid === true || rideData.isPaid === true) {
    throw new ConflictError("This ride has already been paid.");
  }

  // 4. Assert caller authorization against authoritative ride record
  const authoritativePassengerId = rideData.passengerId || rideData.userId || rideData.riderId;

  if (
    rideData.driverId &&
    rideData.assignedDriverId &&
    typeof rideData.driverId === "string" &&
    typeof rideData.assignedDriverId === "string" &&
    rideData.driverId !== rideData.assignedDriverId
  ) {
    throw new BadRequestError("Conflicting authoritative driver identities detected on ride record");
  }

  const authoritativeDriverId = rideData.driverId || rideData.assignedDriverId;
  const isPassenger = Boolean(authoritativePassengerId && callerUid === authoritativePassengerId);
  const isDriver = Boolean(authoritativeDriverId && callerUid === authoritativeDriverId);

  if (!isPassenger && !isDriver && !isCallerAdmin) {
    throw new ForbiddenError("Forbidden: You are not authorized to process payment for this trip.");
  }

  // 5. Authoritative Driver Verification
  if (!authoritativeDriverId || typeof authoritativeDriverId !== "string" || !authoritativeDriverId.trim()) {
    throw new BadRequestError("No assigned driver found for this ride");
  }

  const clientSuppliedRecipient = body.driverId || body.recipientId || body.payeeId || body.driverUid;
  if (
    clientSuppliedRecipient &&
    typeof clientSuppliedRecipient === "string" &&
    clientSuppliedRecipient !== authoritativeDriverId
  ) {
    throw new ForbiddenError("Cannot redirect trip payment to a different driver or recipient.");
  }

  // 6. Resolve driver's authoritative Stripe account from Firestore users collection
  const driverDoc = await db.collection("users").doc(authoritativeDriverId).get();
  const driverDocExists = driverDoc && (typeof driverDoc.exists === "function" ? driverDoc.exists() : driverDoc.exists);

  if (!driverDocExists) {
    throw new BadRequestError("Authoritative driver profile not found");
  }

  const driverData = typeof driverDoc.data === "function" ? driverDoc.data() : driverDoc.data;
  const authoritativeStripeAccountId = driverData?.stripeAccountId;

  if (!authoritativeStripeAccountId || typeof authoritativeStripeAccountId !== "string" || !authoritativeStripeAccountId.trim()) {
    throw new BadRequestError("Driver has not completed Stripe onboarding.");
  }

  // 7. Compute canonical live fare & tip contract (body.amount and body.baseFare are strictly ignored)
  const ridesConfig = await loadRidesFareConfig(db);
  const resolvedPaidWaitSeconds =
    body.paidWaitSeconds !== undefined && isDriver && Number.isFinite(Number(body.paidWaitSeconds))
      ? Math.max(Number(rideData.paidWaitSeconds || 0), Math.min(7200, Math.round(Number(body.paidWaitSeconds))))
      : Number(rideData.paidWaitSeconds || 0);

  const isAbandonmentMode =
    rideData.status === "rider_abandoned" ||
    (isDriver && body?.isAbandonment === true);

  const fareBreakdown = computeAuthoritativeRideFare({
    rideData,
    driverData,
    ridesConfig,
    paidWaitSecondsOverride: resolvedPaidWaitSeconds,
    tipAmountOverride: body.tipAmount !== undefined ? body.tipAmount : rideData.tipAmount,
    isAbandonment: isAbandonmentMode,
  });

  if (fareBreakdown.baseFarePence <= 0) {
    throw new BadRequestError("Authoritative trip fare could not be resolved from ride record.");
  }

  const effectiveBaseFare = fareBreakdown.baseFareGbp;
  const sanitizedTip = fareBreakdown.tipGbp;
  const totalAmount = fareBreakdown.totalCollectedGbp;
  const totalAmountPence = fareBreakdown.totalCollectedPence;
  const feeAmount = fareBreakdown.platformFeePence;

  if (totalAmountPence <= 0) {
    throw new BadRequestError("Trip amount must be greater than zero.");
  }

  const resolvedAppUrl = appUrl || process.env.APP_URL || "http://localhost:3000";
  let checkoutUrl = `${resolvedAppUrl}/payment-success?rideId=${rideId}&fare=${effectiveBaseFare}&tip=${sanitizedTip}`;
  let createdSession: any = null;

  const payerUserId = authoritativePassengerId || callerUid;
  const tripCheckoutHash = createHash("sha256")
    .update(
      `trip-checkout:${rideId}:${authoritativeDriverId}:${authoritativeStripeAccountId}:${fareBreakdown.baseFarePence}:${fareBreakdown.tipPence}:${isAbandonmentMode ? "abandoned" : "standard"}`
    )
    .digest("hex");
  const stripeIdempotencyKey = `trip_checkout_${tripCheckoutHash.slice(0, 40)}`;
  const intentId = `trip_chk_${tripCheckoutHash.slice(0, 24)}`;

  const tripCheckoutDocRef = db.collection("trip_checkout_sessions").doc(tripCheckoutHash);
  const intentDocRef = db.collection("payment_intents").doc(intentId);
  const canPersistCheckoutState =
    typeof tripCheckoutDocRef?.set === "function" &&
    typeof intentDocRef?.set === "function" &&
    typeof intentDocRef?.update === "function";

  // Check durable per-ride Checkout idempotency record
  if (canPersistCheckoutState && stripeClient) {
    try {
      const existingCheckoutSnap = await tripCheckoutDocRef.get();
      const existingExists =
        existingCheckoutSnap &&
        (typeof existingCheckoutSnap.exists === "function" ? existingCheckoutSnap.exists() : existingCheckoutSnap.exists);
      if (existingExists) {
        const existingData =
          typeof existingCheckoutSnap.data === "function" ? existingCheckoutSnap.data() : existingCheckoutSnap.data;
        const createdMs = parseMillis(existingData?.createdAt);
        const isFresh = createdMs === 0 || Date.now() - createdMs < TRIP_CHECKOUT_REUSE_WINDOW_MS;
        if (
          existingData?.status === "session_created" &&
          typeof existingData?.checkoutUrl === "string" &&
          existingData.checkoutUrl.length > 0 &&
          Number(existingData?.totalAmountPence) === totalAmountPence &&
          isFresh
        ) {
          return {
            success: true,
            url: existingData.checkoutUrl,
            rideId,
            driverId: authoritativeDriverId,
            recipientId: authoritativeDriverId,
            stripeAccountId: authoritativeStripeAccountId,
            effectiveBaseFare,
            sanitizedTip,
            totalAmount,
            feeAmount,
            intentId: existingData.intentId || intentId,
            reused: true,
            session: { id: existingData.sessionId, url: existingData.checkoutUrl },
          };
        }
      }
    } catch (lookupErr: any) {
      console.warn("Trip checkout idempotency lookup notice:", lookupErr?.message);
    }
  }

  const authoritativeMetadata = {
    intentId,
    rideId,
    driverId: authoritativeDriverId,
    recipientId: authoritativeDriverId,
    stripeAccountId: authoritativeStripeAccountId,
    passengerId: payerUserId,
    baseFare: effectiveBaseFare.toFixed(2),
    finalFarePence: String(fareBreakdown.baseFarePence),
    tipAmount: sanitizedTip.toFixed(2),
    tipPence: String(fareBreakdown.tipPence),
    totalAmountPence: String(totalAmountPence),
    driverEarningsPence: String(fareBreakdown.driverEarningsPence),
    platformFeePence: String(feeAmount),
    commissionRate: String(fareBreakdown.commissionRate),
    driverTier: fareBreakdown.driverTier,
    isDestinationCharge: "true",
    fareContractVersion: "v2_excl_tip",
    isAbandonment: isAbandonmentMode ? "true" : "false",
    type: "taxi_trip",
  };

  if (canPersistCheckoutState) {
    await intentDocRef.set({
      intentId,
      userId: payerUserId,
      mode: "payment",
      currency: "gbp",
      amount: totalAmountPence,
      status: "pending",
      metadata: {
        ...authoritativeMetadata,
        rideCollectionName,
      },
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  // 8. Create Stripe Checkout Session if client is available
  if (stripeClient) {
    try {
      const sessionPayload: Stripe.Checkout.SessionCreateParams = {
        mode: "payment",
        payment_method_types: ["card"],
        client_reference_id: payerUserId,
        line_items: [
          {
            price_data: {
              currency: "gbp",
              product_data: {
                name: `Trip Payment (Ride #${rideId.substring(0, 8)})`,
                description: `Direct transport payment (Base: £${effectiveBaseFare.toFixed(2)}, Tip: £${sanitizedTip.toFixed(2)})`,
              },
              unit_amount: totalAmountPence,
            },
            quantity: 1,
          },
        ],
        payment_intent_data: {
          application_fee_amount: feeAmount,
          transfer_data: {
            destination: authoritativeStripeAccountId,
          },
          metadata: authoritativeMetadata,
        },
        metadata: authoritativeMetadata,
        success_url: `${resolvedAppUrl}/payment-success?rideId=${rideId}&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${resolvedAppUrl}/payment-failed?rideId=${rideId}`,
      };

      createdSession = await stripeClient.checkout.sessions.create(sessionPayload, {
        idempotencyKey: stripeIdempotencyKey,
      });

      if (createdSession?.url) {
        checkoutUrl = createdSession.url;
      }

      if (canPersistCheckoutState && createdSession?.id) {
        const sessionPaymentIntentId =
          typeof createdSession.payment_intent === "string"
            ? createdSession.payment_intent
            : typeof (createdSession.payment_intent as any)?.id === "string"
              ? (createdSession.payment_intent as any).id
              : null;

        await intentDocRef.update({
          checkoutSessionId: createdSession.id,
          currency: String(createdSession.currency || "gbp").toLowerCase(),
          paymentIntentId: sessionPaymentIntentId,
          status: "session_created",
          sessionCreatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        await tripCheckoutDocRef.set({
          checkoutKey: tripCheckoutHash,
          stripeIdempotencyKey,
          intentId,
          rideId,
          driverId: authoritativeDriverId,
          passengerId: payerUserId,
          sessionId: createdSession.id,
          checkoutUrl,
          totalAmountPence,
          baseFarePence: fareBreakdown.baseFarePence,
          tipPence: fareBreakdown.tipPence,
          status: "session_created",
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
    } catch (stripeErr: any) {
      console.warn("Stripe trip payment session creation failed:", stripeErr?.message);
      if (canPersistCheckoutState) {
        await intentDocRef.update({
          status: "failed",
          failureReason: stripeErr?.message || "stripe_session_creation_failed",
          failedAt: admin.firestore.FieldValue.serverTimestamp(),
        }).catch(() => undefined);
      }
      if (process.env.NODE_ENV === "production") {
        throw new BadRequestError("Payment gateway error during session creation.");
      }
      throw new BadRequestError(stripeErr?.message || "Payment gateway error during session creation.");
    }
  }

  return {
    success: true,
    url: checkoutUrl,
    rideId,
    driverId: authoritativeDriverId,
    recipientId: authoritativeDriverId,
    stripeAccountId: authoritativeStripeAccountId,
    effectiveBaseFare,
    sanitizedTip,
    totalAmount,
    feeAmount,
    intentId,
    reused: false,
    session: createdSession,
  };
}
