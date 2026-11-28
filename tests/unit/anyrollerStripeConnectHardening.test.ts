import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { computeStripeConnectFeeAllocation } from "../../src/server/rideFareCalculator.ts";
import {
  executeCreateTripPaymentCommand,
  executeAutoCardRideChargeCommand,
} from "../../src/server/tripPaymentAuthorization.ts";
import {
  executeCompleteRideCommand,
  fulfillTaxiTripCheckout,
  verifyAndSyncTripCheckoutPayment,
  createPassengerPendingChargesCheckout,
  fulfillPassengerPendingChargesWebhook,
  refundTaxiRidePaymentCommand,
} from "../../src/server/rideLifecycleCommands.ts";
import { evaluateDriverOfferCandidate } from "../../src/server/rideOfferDispatch.ts";
import { sanitizeRedirectUrl } from "../../src/server/paymentVerification.ts";
import { BadRequestError, ConflictError, ForbiddenError } from "../../src/server/httpErrors.ts";

function applyFieldTransform(current: any, val: any): any {
  if (val && typeof val === "object") {
    const sentinel = val as any;
    if (typeof sentinel.operand === "number") {
      return Number(current || 0) + sentinel.operand;
    }
    if (sentinel.constructor?.name === "NumericIncrementTransform") {
      return Number(current || 0) + Number(sentinel.operand || 0);
    }
    if (sentinel.constructor?.name === "DeleteTransform") {
      return undefined;
    }
    if (sentinel.constructor?.name === "ServerTimestampTransform") {
      return { seconds: Math.floor(Date.now() / 1000) };
    }
  }
  return val;
}

function mergeDocPatch(existing: Record<string, any>, patch: Record<string, any>): Record<string, any> {
  const next = { ...existing };
  for (const [k, v] of Object.entries(patch)) {
    const applied = applyFieldTransform(next[k], v);
    if (applied === undefined) {
      delete next[k];
    } else {
      next[k] = applied;
    }
  }
  return next;
}

function createInMemoryFirestore(initialStore: Record<string, Record<string, any>>) {
  const store: Record<string, Record<string, any>> = JSON.parse(JSON.stringify(initialStore));

  const makeSnap = (docId: string, data: any) => ({
    id: docId,
    exists: data !== undefined && data !== null,
    data: () => (data ? JSON.parse(JSON.stringify(data)) : undefined),
  });

  return {
    _store: store,
    collection(colName: string) {
      return {
        doc(docId: string) {
          const fullPath = `${colName}/${docId}`;
          return {
            id: docId,
            path: fullPath,
            async get() {
              return makeSnap(docId, store[fullPath]);
            },
            async set(data: Record<string, any>, opts?: { merge?: boolean }) {
              if (opts?.merge && store[fullPath]) {
                store[fullPath] = mergeDocPatch(store[fullPath], data);
              } else {
                store[fullPath] = mergeDocPatch({}, data);
              }
            },
            async update(data: Record<string, any>) {
              if (!store[fullPath]) throw new Error(`Document ${fullPath} does not exist`);
              store[fullPath] = mergeDocPatch(store[fullPath], data);
            },
          };
        },
      };
    },
    async runTransaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
      const stagedWrites: Array<{ path: string; op: "set" | "update" | "create"; data: any; merge?: boolean }> = [];
      let writeStarted = false;

      const tx = {
        async get(ref: any) {
          if (writeStarted) {
            throw new Error("Firestore transactions require all reads before all writes.");
          }
          return makeSnap(ref.id, store[ref.path]);
        },
        set(ref: any, data: any, opts?: { merge?: boolean }) {
          writeStarted = true;
          stagedWrites.push({ path: ref.path, op: "set", data, merge: opts?.merge });
        },
        update(ref: any, data: any) {
          writeStarted = true;
          stagedWrites.push({ path: ref.path, op: "update", data });
        },
        create(ref: any, data: any) {
          writeStarted = true;
          stagedWrites.push({ path: ref.path, op: "create", data });
        },
      };

      const result = await fn(tx);
      for (const w of stagedWrites) {
        if (w.op === "create") {
          if (store[w.path]) throw new Error(`Already exists: ${w.path}`);
          store[w.path] = mergeDocPatch({}, w.data);
        } else if (w.op === "update") {
          if (!store[w.path]) throw new Error(`Missing for update: ${w.path}`);
          store[w.path] = mergeDocPatch(store[w.path], w.data);
        } else if (w.op === "set") {
          if (w.merge && store[w.path]) {
            store[w.path] = mergeDocPatch(store[w.path], w.data);
          } else {
            store[w.path] = mergeDocPatch({}, w.data);
          }
        }
      }
      return result;
    },
  };
}

describe("AnyRoller Stripe Connect Zero-Money-Loss Hardening", () => {
  let db: any;
  let mockStripe: any;
  let piCreateSpy: any;
  let sessionCreateSpy: any;
  let sessionRetrieveSpy: any;
  let refundCreateSpy: any;

  beforeEach(() => {
    db = createInMemoryFirestore({
      "platform_config/rides": {
        baseFare: 3.5,
        distanceRate: 1.3,
        timeRate: 0.15,
        waitRatePerMinute: 0.25,
        minFare: 5.0,
        commissionRate: 0.12,
        fixedTripFee: 0,
        maxPendingPlatformFeesGbp: 50,
      },
      "users/drv_ready": {
        uid: "drv_ready",
        role: "driver",
        stripeAccountId: "acct_drv_ready",
        chargesEnabled: true,
        payoutsEnabled: true,
        pendingPlatformFees: 10.0,
        totalEarnings: 100,
        jobsCompleted: 5,
      },
      "users/drv_unverified": {
        uid: "drv_unverified",
        role: "driver",
        stripeAccountId: "acct_drv_unverified",
        chargesEnabled: false,
        payoutsEnabled: false,
      },
      "users/pax_card": {
        uid: "pax_card",
        role: "consumer",
        stripeCustomerId: "cus_pax_card",
        pendingCharges: 14.5,
        pendingChargesReason: "Late cancellation fee",
        cancellationCount: 2,
      },
      "users/pax_no_card": {
        uid: "pax_no_card",
        role: "consumer",
        stripeCustomerId: "cus_pax_empty",
      },
      "ride_requests/ride_auto_ok": {
        rideId: "ride_auto_ok",
        passengerId: "pax_card",
        driverId: "drv_ready",
        assignedDriverId: "drv_ready",
        status: "in_progress",
        fareEstimate: 30.0,
        tipAmount: 5.0,
        hasCardOnFile: true,
      },
      "ride_requests/ride_auto_decline": {
        rideId: "ride_auto_decline",
        passengerId: "pax_card",
        driverId: "drv_ready",
        assignedDriverId: "drv_ready",
        status: "in_progress",
        fareEstimate: 25.0,
        tipAmount: 0,
        hasCardOnFile: true,
      },
      "ride_requests/ride_qr_1": {
        rideId: "ride_qr_1",
        passengerId: "pax_no_card",
        driverId: "drv_ready",
        assignedDriverId: "drv_ready",
        status: "awaiting_payment",
        fareEstimate: 20.0,
        tipAmount: 2.0,
        latestCheckoutSessionId: "cs_live_qr_1",
      },
      "ride_requests/ride_unverified_drv": {
        rideId: "ride_unverified_drv",
        passengerId: "pax_card",
        driverId: "drv_unverified",
        assignedDriverId: "drv_unverified",
        status: "in_progress",
        fareEstimate: 20.0,
      },
      "ride_requests/ride_paid_refund": {
        rideId: "ride_paid_refund",
        passengerId: "pax_card",
        driverId: "drv_ready",
        assignedDriverId: "drv_ready",
        status: "completed",
        paymentStatus: "paid",
        payoutStatus: "direct_destination_charge",
        payoutTransferred: true,
        stripePaymentIntentId: "pi_settled_999",
        finalFare: 25.0,
        tipAmount: 5.0,
        totalFarePaid: 30.0,
      },
    });

    piCreateSpy = vi.fn(async (payload: any) => ({
      id: "pi_auto_123",
      status: "succeeded",
      amount: payload.amount,
      amount_received: payload.amount,
      currency: "gbp",
    }));

    sessionCreateSpy = vi.fn(async (payload: any) => ({
      id: "cs_generated_1",
      url: "https://checkout.stripe.com/pay/cs_generated_1",
      currency: "gbp",
      payment_intent: "pi_checkout_1",
      metadata: payload.metadata,
    }));

    sessionRetrieveSpy = vi.fn(async () => ({
      id: "cs_live_qr_1",
      payment_status: "unpaid",
      currency: "gbp",
      amount_total: 2200,
      payment_intent: "pi_qr_1",
      metadata: { rideId: "ride_qr_1", driverId: "drv_ready", passengerId: "pax_no_card" },
    }));

    refundCreateSpy = vi.fn(async (payload: any) => ({
      id: "re_test_1",
      status: "succeeded",
      amount: payload.amount,
    }));

    mockStripe = {
      customers: {
        retrieve: vi.fn(async (id: string) => ({
          id,
          invoice_settings: {
            default_payment_method: id === "cus_pax_card" ? "pm_card_visa_4242" : null,
          },
        })),
      },
      paymentMethods: {
        list: vi.fn(async ({ customer }: { customer: string }) => ({
          data:
            customer === "cus_pax_card"
              ? [{ id: "pm_card_visa_4242", card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2029 } }]
              : [],
        })),
      },
      paymentIntents: {
        create: piCreateSpy,
      },
      checkout: {
        sessions: {
          create: sessionCreateSpy,
          retrieve: sessionRetrieveSpy,
        },
      },
      refunds: {
        create: refundCreateSpy,
      },
    };
  });

  it("1. Protects platform against processing-fee loss on small fare + large tip while preserving zero top-up on normal fares", () => {
    // Normal ride: £41 fare + £5 tip -> 12% commission (£4.92) comfortably exceeds ~£1.59 Stripe fee
    const normal = computeStripeConnectFeeAllocation({
      baseFarePence: 4100,
      tipPence: 500,
      platformFeePence: 492,
      pendingPlatformFeesGbp: 0,
    });
    expect(normal.processingFeeFloorTopUpPence).toBe(0);
    expect(normal.stripeApplicationFeePence).toBe(492);

    // Edge case: £5 minimum fare + £30 tip -> 12% base commission is £0.60, but Stripe takes ~£1.27
    const highTip = computeStripeConnectFeeAllocation({
      baseFarePence: 500,
      tipPence: 3000,
      platformFeePence: 60,
      pendingPlatformFeesGbp: 0,
    });
    expect(highTip.processingFeeFloorTopUpPence).toBeGreaterThan(0);
    expect(highTip.stripeApplicationFeePence).toBeGreaterThanOrEqual(highTip.estimatedStripeProcessingFeePence);
    expect(highTip.driverNetPayoutPence + highTip.stripeApplicationFeePence).toBe(3500);
  });

  it("2. Automatically recovers owed cash commission (pendingPlatformFees) capped at 50% of driver base share without touching tips", () => {
    const alloc = computeStripeConnectFeeAllocation({
      baseFarePence: 3000, // £30 base -> £3.60 commission -> £26.40 driver base share -> 50% cap = £13.20
      tipPence: 1000, // £10 tip (untouched)
      platformFeePence: 360,
      pendingPlatformFeesGbp: 25.0,
    });
    expect(alloc.recoveredCashFeesPence).toBe(1320);
    expect(alloc.stripeApplicationFeePence).toBe(360 + 1320);
    // Driver gets remaining 50% of base share (£13.20) + 100% of tip (£10.00) = £23.20
    expect(alloc.driverNetPayoutPence).toBe(2320);
  });

  it("3. auto_card executes real off-session Stripe PaymentIntent Destination Charge, settles atomically, and recovers pendingPlatformFees", async () => {
    const res = await executeCompleteRideCommand({
      db,
      caller: { uid: "drv_ready" },
      rideId: "ride_auto_ok",
      action: "auto_card",
      stripeClient: mockStripe,
      appUrl: "https://anyroller.test",
    });

    expect(piCreateSpy).toHaveBeenCalledTimes(1);
    const piPayload = piCreateSpy.mock.calls[0][0];
    expect(piPayload.amount).toBe(3500); // £30 base + £5 tip
    expect(piPayload.off_session).toBe(true);
    expect(piPayload.confirm).toBe(true);
    expect(piPayload.customer).toBe("cus_pax_card");
    expect(piPayload.payment_method).toBe("pm_card_visa_4242");
    expect(piPayload.transfer_data.destination).toBe("acct_drv_ready");
    // Base commission (£3.60) + £10.00 full pendingPlatformFees recovery = 1360p
    expect(piPayload.application_fee_amount).toBe(1360);

    expect(res.status).toBe("completed");
    expect(res.paymentStatus).toBe("paid");
    expect(res.paymentMethod).toBe("stripe_auto");
    expect(res.cashFeesRecoveredGbp).toBe(10);

    const ride = db._store["ride_requests/ride_auto_ok"];
    expect(ride.status).toBe("completed");
    expect(ride.paymentStatus).toBe("paid");
    expect(ride.payoutTransferred).toBe(true);
    expect(ride.cashFeesRecoveredGbp).toBe(10);
    // Driver's owed cash commission decremented from £10.00 -> £0.00 atomically!
    expect(db._store["users/drv_ready"].pendingPlatformFees).toBe(0);
    // Passenger pendingCharges cleared
    expect(db._store["users/pax_card"].pendingCharges).toBe(0);
  });

  it("4. auto_card card decline / 3DS authentication_required seamlessly falls back to live QR Checkout instead of completing unpaid", async () => {
    piCreateSpy.mockRejectedValueOnce(
      Object.assign(new Error("Authentication required"), { code: "authentication_required" })
    );

    const res = await executeCompleteRideCommand({
      db,
      caller: { uid: "drv_ready" },
      rideId: "ride_auto_decline",
      action: "auto_card",
      stripeClient: mockStripe,
      appUrl: "https://anyroller.test",
    });

    expect(res.fallbackToQr).toBe(true);
    expect(res.fallbackReason).toBe("authentication_required");
    expect(res.status).toBe("awaiting_payment");
    expect(res.paymentUrl).toBe("https://checkout.stripe.com/pay/cs_generated_1");

    const ride = db._store["ride_requests/ride_auto_decline"];
    expect(ride.status).toBe("awaiting_payment");
    expect(ride.paymentStatus).not.toBe("paid");
    expect(ride.paymentUrl).toBe("https://checkout.stripe.com/pay/cs_generated_1");
    expect(ride.latestCheckoutSessionId).toBe("cs_generated_1");
  });

  it("5. qr_manual_close refuses to close unpaid QR rides (409) and reconciles paid sessions live when Stripe confirms paid", async () => {
    // First attempt: Stripe reports session is still unpaid -> blocked with ConflictError!
    await expect(
      executeCompleteRideCommand({
        db,
        caller: { uid: "drv_ready" },
        rideId: "ride_qr_1",
        action: "qr_manual_close",
        stripeClient: mockStripe,
      })
    ).rejects.toThrow(ConflictError);

    expect(db._store["ride_requests/ride_qr_1"].status).toBe("awaiting_payment");

    // Second attempt: Passenger finishes Stripe Checkout (payment_status === "paid") -> reconciles immediately!
    sessionRetrieveSpy.mockResolvedValueOnce({
      id: "cs_live_qr_1",
      payment_status: "paid",
      currency: "gbp",
      amount_total: 2200,
      payment_intent: "pi_qr_paid_1",
      metadata: {
        rideId: "ride_qr_1",
        driverId: "drv_ready",
        passengerId: "pax_no_card",
        stripeAccountId: "acct_drv_ready",
        finalFarePence: "2000",
        tipPence: "200",
        totalAmountPence: "2200",
        platformFeePence: "240",
        driverEarningsPence: "1960",
        recoveredCashFeesPence: "880",
        isDestinationCharge: "true",
      },
    });

    const settled = await executeCompleteRideCommand({
      db,
      caller: { uid: "drv_ready" },
      rideId: "ride_qr_1",
      action: "qr_manual_close",
      stripeClient: mockStripe,
    });

    expect(settled.status).toBe("completed");
    expect(settled.paymentStatus).toBe("paid");
    expect(settled.verifiedByStripe).toBe(true);
    expect(db._store["ride_requests/ride_qr_1"].status).toBe("completed");
    expect(db._store["ride_requests/ride_qr_1"].paymentStatus).toBe("paid");
    // Recovered £8.80 from £10.00 pendingPlatformFees -> £1.20 remaining
    expect(db._store["users/drv_ready"].pendingPlatformFees).toBe(1.2);
  });

  it("6. Rejects card checkout for drivers with incomplete Stripe verification (chargesEnabled === false)", async () => {
    await expect(
      executeCreateTripPaymentCommand({
        db,
        caller: { uid: "drv_unverified" },
        body: { rideId: "ride_unverified_drv" },
        stripeClient: mockStripe,
        appUrl: "https://anyroller.test",
      })
    ).rejects.toThrow(BadRequestError);
  });

  it("7. Enforces pendingPlatformFees debt cap & incomplete Stripe onboarding gate in ride offer dispatch", () => {
    const baseTracking = {
      isOnline: true,
      status: "available",
      lat: 51.5074,
      lng: -0.1278,
      vehicleCategories: ["standard"],
      lastHeartbeatAtMs: Date.now(),
    };
    const baseRide = { pickupLat: 51.508, pickupLng: -0.128, carCategory: "standard" };

    const overDebt = evaluateDriverOfferCandidate({
      driverUid: "drv_debt",
      trackingData: baseTracking,
      rideData: baseRide,
      radiusMiles: 10,
      nowMs: Date.now(),
      userData: { pendingPlatformFees: 55.0, chargesEnabled: true },
      maxPendingPlatformFeesGbp: 50,
    });
    expect(overDebt.eligible).toBe(false);
    expect(overDebt.reason).toBe("pending_fees_limit");

    const unverified = evaluateDriverOfferCandidate({
      driverUid: "drv_unverified",
      trackingData: baseTracking,
      rideData: baseRide,
      radiusMiles: 10,
      nowMs: Date.now(),
      userData: { pendingPlatformFees: 0, chargesEnabled: false },
    });
    expect(unverified.eligible).toBe(false);
    expect(unverified.reason).toBe("stripe_onboarding_incomplete");
  });

  it("8. Passenger pendingCharges Checkout creates authoritative session and webhook clears balance & strikes atomically", async () => {
    const checkout = await createPassengerPendingChargesCheckout({
      db,
      passengerId: "pax_card",
      stripeClient: mockStripe,
      appUrl: "https://anyroller.test",
    });

    expect(checkout.amountPence).toBe(1450);
    expect(sessionCreateSpy).toHaveBeenCalledTimes(1);
    const payload = sessionCreateSpy.mock.calls[0][0];
    expect(payload.success_url).toContain("/book-ride?balance_settled=1");
    expect(payload.metadata.type).toBe("passenger_pending_charges");

    const eventRef = db.collection("processed_stripe_webhooks").doc("evt_pax_bal_1");
    await eventRef.set({ status: "processing", claimToken: "tok_pax_1" });

    await fulfillPassengerPendingChargesWebhook({
      db,
      event: { id: "evt_pax_bal_1" },
      session: {
        id: checkout.sessionId,
        currency: "gbp",
        amount_total: 1450,
        payment_intent: "pi_bal_1",
        metadata: payload.metadata,
      },
      intent: db._store[`payment_intents/${checkout.intentId}`],
      eventRef,
      claimToken: "tok_pax_1",
    });

    expect(db._store["users/pax_card"].pendingCharges).toBe(0);
    expect(db._store["users/pax_card"].cancellationCount).toBe(0);
    expect(db._store[`payment_ledger/pass_bal_${checkout.sessionId}`].type).toBe("PASSENGER_BALANCE_SETTLEMENT");
  });

  it("9. Destination Charge ride refund enforces reverse_transfer: true and admin-only authorization", async () => {
    await expect(
      refundTaxiRidePaymentCommand({
        db,
        caller: { uid: "drv_ready", isAdmin: false },
        rideId: "ride_paid_refund",
        stripeClient: mockStripe,
      })
    ).rejects.toThrow(ForbiddenError);

    const res = await refundTaxiRidePaymentCommand({
      db,
      caller: { uid: "admin_1", isAdmin: true },
      rideId: "ride_paid_refund",
      stripeClient: mockStripe,
    });

    expect(res.success).toBe(true);
    expect(res.reverseTransfer).toBe(true);
    expect(refundCreateSpy).toHaveBeenCalledTimes(1);
    expect(refundCreateSpy.mock.calls[0][0].reverse_transfer).toBe(true);
    expect(refundCreateSpy.mock.calls[0][0].payment_intent).toBe("pi_settled_999");
    expect(db._store["ride_requests/ride_paid_refund"].paymentStatus).toBe("refunded");
    expect(db._store["payment_ledger/ride_refund_re_test_1"].type).toBe("RIDE_REFUND");
  });

  it("10. Redirect allowlist permits /book-ride and App.tsx mounts public /payment-success, /payment-failed, /driver-return, /driver-dashboard", () => {
    expect(
      sanitizeRedirectUrl("/book-ride?balance_settled=1", "https://anyroller.test", "/profile")
    ).toBe("https://anyroller.test/book-ride?balance_settled=1");

    const appSource = fs.readFileSync(path.resolve("src/App.tsx"), "utf8");
    expect(appSource).toContain('path="/payment-success"');
    expect(appSource).toContain('path="/payment-failed"');
    expect(appSource).toContain('path="driver-return"');
    expect(appSource).toContain('path="driver-dashboard"');
  });
});
