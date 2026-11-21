import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import admin from "firebase-admin";
import { computeAuthoritativeRideFare, DEFAULT_RIDES_FARE_CONFIG } from "../../src/server/rideFareCalculator.ts";
import { executeCreateTripPaymentCommand } from "../../src/server/tripPaymentAuthorization.ts";
import {
  executeTransitionRideCommand,
  executeCompleteRideCommand,
  executeCancelRideCommand,
  fulfillTaxiTripCheckout,
  createDriverFeeSettlementCheckout,
  fulfillDriverFeeSettlementWebhook,
} from "../../src/server/rideLifecycleCommands.ts";
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

  const db: any = {
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
            throw new Error("Firestore transactions require all reads to be executed before all writes.");
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

  return db;
}

describe("Batch 8 — AnyRoller Ride Payments, Cash Commission, Metrics & Withdrawal UI", () => {
  let db: any;
  let mockStripe: any;
  let stripeCreateCalls: Array<{ payload: any; options: any }>;

  beforeEach(() => {
    stripeCreateCalls = [];
    db = createInMemoryFirestore({
      "platform_config/rides": {
        baseFare: 3.5,
        distanceRate: 1.3,
        timeRate: 0.15,
        waitRatePerMinute: 0.25,
        minFare: 5.0,
        commissionRate: 0.12,
        fixedTripFee: 0,
        freeWaitMinutes: 3,
        driverWaitTimeLimitMins: 5,
        abandonmentFee: 5.0,
      },
      "users/driver_1": {
        uid: "driver_1",
        role: "driver",
        stripeAccountId: "acct_driver_1",
        pendingPlatformFees: 24.5,
        totalEarnings: 100,
        jobsCompleted: 5,
      },
      "users/gold_driver": {
        uid: "gold_driver",
        role: "driver",
        stripeAccountId: "acct_gold_driver",
        isGoldDriver: true,
        driverSubscriptionId: "sub_gold_1",
        driverSubscriptionStatus: "active",
      },
      "users/rider_1": {
        uid: "rider_1",
        role: "consumer",
        pendingCharges: 12.5,
        cancellationCount: 1,
      },
      "users/attacker": {
        uid: "attacker",
        role: "consumer",
      },
      "ride_requests/ride_live_1": {
        rideId: "ride_live_1",
        passengerId: "rider_1",
        riderId: "rider_1",
        driverId: "driver_1",
        assignedDriverId: "driver_1",
        status: "in_progress",
        fareEstimate: 40.0,
        tipAmount: 5.0,
        paidWaitSeconds: 240, // 4 mins * 0.25 = £1.00 wait charge
        distanceMiles: 14,
        distanceToPickupMiles: 2,
      },
      "ride_requests/ride_gold_1": {
        rideId: "ride_gold_1",
        passengerId: "rider_1",
        driverId: "gold_driver",
        assignedDriverId: "gold_driver",
        status: "in_progress",
        fareEstimate: 50.0,
        tipAmount: 10.0,
      },
      "ride_requests/ride_late_cancel": {
        rideId: "ride_late_cancel",
        passengerId: "rider_1",
        driverId: "driver_1",
        assignedDriverId: "driver_1",
        status: "accepted",
        acceptedAt: Date.now() - 5 * 60 * 1000, // 5 mins ago (> 2 mins cutoff)
        fareEstimate: 22.0,
      },
      "ride_requests/ride_cash_1": {
        rideId: "ride_cash_1",
        passengerId: "rider_1",
        riderId: "rider_1",
        driverId: "driver_1",
        assignedDriverId: "driver_1",
        status: "in_progress",
        fareEstimate: 30.0,
        tipAmount: 4.0,
      },
    });

    let seq = 0;
    mockStripe = {
      checkout: {
        sessions: {
          create: vi.fn(async (payload: any, options: any) => {
            seq += 1;
            stripeCreateCalls.push({ payload, options });
            return {
              id: `cs_test_${seq}`,
              url: `https://checkout.stripe.com/pay/cs_test_${seq}`,
              currency: "gbp",
              payment_intent: `pi_test_${seq}`,
            };
          }),
        },
      },
    };
  });

  it("AT-RIDE-PAY-03 & AT-RIDE-PAY-06: Calculates canonical v2_excl_tip fare excl. tip + tip 100% to driver", () => {
    const calc = computeAuthoritativeRideFare({
      rideData: {
        fareEstimate: 40,
        paidWaitSeconds: 240, // +£1.00
        tipAmount: 5,
      },
      driverData: { uid: "driver_1" },
      ridesConfig: DEFAULT_RIDES_FARE_CONFIG,
    });

    expect(calc.baseFareGbp).toBe(41); // 40 + 1 wait, excl tip
    expect(calc.tipGbp).toBe(5);
    expect(calc.totalCollectedGbp).toBe(46);
    expect(calc.platformFeeGbp).toBe(4.92); // 12% of £41 ONLY
    expect(calc.driverEarningsGbp).toBe(41.08); // (41 - 4.92) + 5

    // Gold driver receives 10% commission on base fare excl. tip
    const goldCalc = computeAuthoritativeRideFare({
      rideData: { fareEstimate: 50, tipAmount: 10 },
      driverData: db._store["users/gold_driver"],
      ridesConfig: DEFAULT_RIDES_FARE_CONFIG,
    });
    expect(goldCalc.platformFeeGbp).toBe(5); // 10% of 50
    expect(goldCalc.driverEarningsGbp).toBe(55); // (50 - 5) + 10

    // Legacy folded finalFare normalization
    const legacyNormalized = computeAuthoritativeRideFare({
      rideData: { finalFare: 45, totalFarePaid: 45, tipAmount: 5 },
      driverData: { uid: "driver_1" },
      ridesConfig: DEFAULT_RIDES_FARE_CONFIG,
    });
    expect(legacyNormalized.baseFareGbp).toBe(40);
    expect(legacyNormalized.totalCollectedGbp).toBe(45);
  });

  it("AT-RIDE-PAY-01 & AT-RIDE-PAY-02: Binds payment_intents + idempotency key and fulfills webhook transactionally", async () => {
    // First call creates checkout session & durable intent + checkout lock
    const first = await executeCreateTripPaymentCommand({
      db,
      caller: { uid: "driver_1" },
      body: { rideId: "ride_live_1", amount: 1.0, baseFare: 1.0 },
      stripeClient: mockStripe,
      appUrl: "https://anytrader.example",
    });

    expect(first.reused).toBe(false);
    expect(first.effectiveBaseFare).toBe(41); // live fareEstimate (40) + wait (1), ignores client amount=1
    expect(first.sanitizedTip).toBe(5);
    expect(first.totalAmount).toBe(46);
    expect(stripeCreateCalls).toHaveLength(1);
    expect(stripeCreateCalls[0].options?.idempotencyKey).toMatch(/^trip_checkout_[a-f0-9]{40}$/);
    expect(stripeCreateCalls[0].payload.client_reference_id).toBe("rider_1");
    expect(stripeCreateCalls[0].payload.metadata.type).toBe("taxi_trip");
    expect(stripeCreateCalls[0].payload.metadata.intentId).toBe(first.intentId);

    // Durable payment_intents document exists & is bound to session
    const intentDoc = db._store[`payment_intents/${first.intentId}`];
    expect(intentDoc).toBeDefined();
    expect(intentDoc.userId).toBe("rider_1");
    expect(intentDoc.amount).toBe(4600);
    expect(intentDoc.status).toBe("session_created");

    // Second call with identical parameters reuses stored Checkout URL without calling Stripe again
    const second = await executeCreateTripPaymentCommand({
      db,
      caller: { uid: "rider_1" },
      body: { rideId: "ride_live_1" },
      stripeClient: mockStripe,
      appUrl: "https://anytrader.example",
    });
    expect(second.reused).toBe(true);
    expect(second.url).toBe(first.url);
    expect(stripeCreateCalls).toHaveLength(1);

    // Webhook fulfillment updates ride atomically, marks direct destination transfer, clears pendingCharges, writes ledger & metrics
    const eventRef = db.collection("processed_stripe_webhooks").doc("evt_taxi_1");
    await eventRef.set({ status: "processing", claimToken: "claim_tok_1" });

    await fulfillTaxiTripCheckout({
      db,
      event: { id: "evt_taxi_1" },
      session: {
        id: "cs_test_1",
        currency: "gbp",
        amount_total: 4600,
        payment_intent: "pi_test_1",
        metadata: stripeCreateCalls[0].payload.metadata,
      },
      intent: intentDoc,
      eventRef,
      claimToken: "claim_tok_1",
    });

    const settledRide = db._store["ride_requests/ride_live_1"];
    expect(settledRide.status).toBe("completed");
    expect(settledRide.paymentStatus).toBe("paid");
    expect(settledRide.finalFare).toBe(41);
    expect(settledRide.tipAmount).toBe(5);
    expect(settledRide.totalFarePaid).toBe(46);
    expect(settledRide.fareContractVersion).toBe("v2_excl_tip");
    expect(settledRide.driverEarnings).toBe(41.08);
    expect(settledRide.platformFee).toBe(4.92);
    expect(settledRide.payoutTransferred).toBe(true);
    expect(settledRide.payoutStatus).toBe("direct_destination_charge");

    // Passenger pendingCharges cleared
    expect(db._store["users/rider_1"].pendingCharges).toBe(0);
    // Driver metrics credited strictly with NET earnings (41.08), not gross (46)
    expect(db._store["driver_metrics/driver_1"].dailyEarnings).toBe(41.08);
    expect(db._store["driver_metrics/driver_1"].jobsDoneToday).toBe(1);
    // Ledger created
    expect(db._store["payment_ledger/ride_pay_cs_test_1"].type).toBe("RIDE_PAYMENT");
    expect(db._store["payment_ledger/ride_pay_cs_test_1"].amount).toBe(4600);

    // Replaying fulfillTaxiTripCheckout does NOT double-credit metrics
    await fulfillTaxiTripCheckout({
      db,
      event: { id: "evt_taxi_1" },
      session: {
        id: "cs_test_1",
        currency: "gbp",
        amount_total: 4600,
        payment_intent: "pi_test_1",
        metadata: stripeCreateCalls[0].payload.metadata,
      },
      intent: intentDoc,
      eventRef,
      claimToken: "claim_tok_1",
    });
    expect(db._store["driver_metrics/driver_1"].dailyEarnings).toBe(41.08);

    // Already paid ride rejects new Checkout attempt
    await expect(
      executeCreateTripPaymentCommand({
        db,
        caller: { uid: "rider_1" },
        body: { rideId: "ride_live_1" },
        stripeClient: mockStripe,
      })
    ).rejects.toThrow(ConflictError);
  });

  it("AT-RIDE-PAY-04: Server transitions & completions handle cash underpayment -> passenger confirm & abandonment atomically", async () => {
    // Attacker cannot transition driver ride
    await expect(
      executeTransitionRideCommand({
        db,
        caller: { uid: "attacker" },
        rideId: "ride_live_1",
        action: "in_progress",
      })
    ).rejects.toThrow(ForbiddenError);

    // Cash underpayment report (£20 collected out of £34 total = £14 remainder)
    const cashReport = await executeCompleteRideCommand({
      db,
      caller: { uid: "driver_1" },
      rideId: "ride_cash_1",
      action: "cash_report",
      cashCollected: 20,
    });
    expect(cashReport.status).toBe("awaiting_cash_confirm");
    expect((cashReport as any).reportedCashDiscrepancy).toBe(14);
    expect(db._store["ride_requests/ride_cash_1"].status).toBe("awaiting_cash_confirm");

    // Non-passenger cannot confirm cash entry
    await expect(
      executeCompleteRideCommand({
        db,
        caller: { uid: "driver_1" },
        rideId: "ride_cash_1",
        action: "cash_confirm_passenger",
      })
    ).rejects.toThrow(ForbiddenError);

    // Passenger confirms cash discrepancy atomically
    const confirmed = await executeCompleteRideCommand({
      db,
      caller: { uid: "rider_1" },
      rideId: "ride_cash_1",
      action: "cash_confirm_passenger",
    });
    expect(confirmed.status).toBe("completed");
    expect(confirmed.finalFare).toBe(30);
    expect(confirmed.tipAmount).toBe(4);
    expect(confirmed.totalFarePaid).toBe(34);
    expect(confirmed.platformFee).toBe(3.6); // 12% of £30
    expect(confirmed.driverEarnings).toBe(30.4); // 26.40 + 4 tip

    // Rider pendingCharges incremented by £14 remainder (12.50 existing + 14 = 26.50)
    expect(db._store["users/rider_1"].pendingCharges).toBe(26.5);
    // Driver pendingPlatformFees incremented by £3.60 (24.50 + 3.60 = 28.10)
    expect(db._store["users/driver_1"].pendingPlatformFees).toBeCloseTo(28.1, 2);
    // Driver metrics credited once
    expect(db._store["driver_metrics/driver_1"].dailyEarnings).toBe(30.4);

    // Abandonment flow applies strike, partial fare + £5 abandonment fee, and rider pendingCharges atomically
    const abandon = await executeCompleteRideCommand({
      db,
      caller: { uid: "gold_driver" },
      rideId: "ride_gold_1",
      action: "abandonment",
      paidWaitSeconds: 120,
      paymentUrl: "https://checkout.stripe.com/pay/abandon_1",
    });
    expect(abandon.status).toBe("rider_abandoned");
    expect(abandon.finalFare).toBe(30.5); // (50 * 0.5) + 0.50 wait + 5.00 abandonment fee
    expect(db._store["users/rider_1"].abandonmentStrikes).toBe(1);
    expect(db._store["users/rider_1"].pendingCharges).toBe(26.5 + 40.5); // + (30.5 base + 10 tip)
  });

  it("AT-RIDE-PAY-05: Server cancellation applies cancellation fee atomically to passenger pendingCharges and driver_metrics", async () => {
    const res = await executeCancelRideCommand({
      db,
      caller: { uid: "rider_1" },
      rideId: "ride_late_cancel",
      cancelledBy: "passenger",
    });

    expect(res.status).toBe("cancelled");
    expect(res.cancellationFee).toBe(3.5);
    expect(db._store["ride_requests/ride_late_cancel"].status).toBe("cancelled");
    expect(db._store["users/rider_1"].pendingCharges).toBe(16.0); // 12.50 + 3.50
    expect(db._store["users/rider_1"].cancellationCount).toBe(2);
    expect(db._store["driver_metrics/driver_1"].dailyEarnings).toBe(3.5);

    // Replaying cancel is idempotent and does not double-charge
    const replay = await executeCancelRideCommand({
      db,
      caller: { uid: "rider_1" },
      rideId: "ride_late_cancel",
    });
    expect((replay as any).alreadyCancelled).toBe(true);
    expect(db._store["users/rider_1"].pendingCharges).toBe(16.0);
  });

  it("AT-RIDE-PAY-07: Fee settlement Checkout derives DB pendingPlatformFees & settles strictly inside webhook", async () => {
    const checkout = await createDriverFeeSettlementCheckout({
      db,
      driverId: "driver_1",
      stripeClient: mockStripe,
      appUrl: "https://anytrader.example",
    });

    expect(checkout.amountPence).toBe(2450); // Matches users/driver_1.pendingPlatformFees (£24.50)
    expect(stripeCreateCalls[0].payload.success_url).toContain("/platform-fee-success?session_id={CHECKOUT_SESSION_ID}");
    expect(stripeCreateCalls[0].payload.metadata.type).toBe("fee_settlement");

    const eventRef = db.collection("processed_stripe_webhooks").doc("evt_fee_1");
    await eventRef.set({ status: "processing", claimToken: "claim_fee_1" });

    await fulfillDriverFeeSettlementWebhook({
      db,
      event: { id: "evt_fee_1" },
      session: {
        id: checkout.sessionId,
        currency: "gbp",
        amount_total: 2450,
        payment_intent: "pi_fee_1",
        metadata: stripeCreateCalls[0].payload.metadata,
      },
      intent: db._store[`payment_intents/${checkout.intentId}`],
      eventRef,
      claimToken: "claim_fee_1",
    });

    expect(db._store["users/driver_1"].pendingPlatformFees).toBe(0);
    expect(db._store[`driver_fee_settlements/${checkout.sessionId}`].settledAmount).toBe(24.5);
    expect(db._store[`payment_ledger/fee_settle_${checkout.sessionId}`].type).toBe("DRIVER_FEE_SETTLEMENT");

    // Attempting new settlement with £0 balance fails cleanly
    await expect(
      createDriverFeeSettlementCheckout({
        db,
        driverId: "driver_1",
        stripeClient: mockStripe,
        appUrl: "https://anytrader.example",
      })
    ).rejects.toThrow(BadRequestError);
  });

  it("AT-RIDE-PAY-07 & AT-RIDE-PAY-10: UI client modules send Idempotency-Key & Bearer tokens and avoid bypass URL settlement", () => {
    const earningsSource = fs.readFileSync(
      path.resolve("src/components/driver/DriverEarnings.tsx"),
      "utf8"
    );
    expect(earningsSource).toContain("withdrawalAttemptKeyRef");
    expect(earningsSource).toContain('"Idempotency-Key": idempotencyKey');
    expect(earningsSource).toContain("Authorization: `Bearer ${token}`");
    expect(earningsSource).toContain("resolveRideNetEarnings");

    const feeSuccessSource = fs.readFileSync(
      path.resolve("src/components/driver/PlatformFeeSuccess.tsx"),
      "utf8"
    );
    expect(feeSuccessSource).not.toContain("/api/driver/confirm-fee-settlement");
    expect(feeSuccessSource).not.toContain('searchParams.get("amount")');
    expect(feeSuccessSource).toContain("/api/driver/fee-settlement-status");
  });
});
