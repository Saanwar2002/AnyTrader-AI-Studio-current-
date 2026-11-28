import { describe, it, expect, vi } from "vitest";
import {
  computeDriverFairnessScore,
  evaluateDriverOfferCandidate,
  executeDeclineRideOfferCommand,
  isRideReadyForInstantDispatch,
  runFairnessDispatchCycle,
  runFairnessDispatchForRide,
  RIDE_OFFER_CHANNEL_ID,
} from "../../src/server/rideOfferDispatch.ts";
import { executeAcceptRideCommand } from "../../src/server/driverAuthorization.ts";

function createInMemoryFirestore(initialDocs: Record<string, Record<string, any>> = {}) {
  const store = new Map<string, Record<string, any>>();
  for (const [k, v] of Object.entries(initialDocs)) {
    store.set(k, { ...v });
  }

  const applyPatch = (existing: Record<string, any>, patch: Record<string, any>, merge = true) => {
    const next = merge ? { ...existing } : {};
    for (const [key, val] of Object.entries(patch)) {
      if (
        val &&
        typeof val === "object" &&
        (val._methodName === "FieldValue.delete" || val.constructor?.name === "DeleteTransform")
      ) {
        delete next[key];
      } else if (
        val &&
        typeof val === "object" &&
        (val._methodName === "FieldValue.arrayUnion" ||
          val.constructor?.name === "ArrayUnionTransform" ||
          Array.isArray(val.elements))
      ) {
        const existingArr = Array.isArray(next[key]) ? [...next[key]] : [];
        const toAdd = Array.isArray(val.elements)
          ? val.elements
          : Array.isArray(val._elements)
            ? val._elements
            : [];
        for (const item of toAdd) {
          if (!existingArr.includes(item)) existingArr.push(item);
        }
        next[key] = existingArr;
      } else if (
        val &&
        typeof val === "object" &&
        (val._methodName === "FieldValue.increment" || typeof val.operand === "number")
      ) {
        const delta = Number(val.operand ?? val._operand ?? 0);
        next[key] = Number(next[key] || 0) + delta;
      } else {
        next[key] = val;
      }
    }
    return next;
  };

  const makeDocRef = (colPath: string, docId: string) => {
    const fullPath = `${colPath}/${docId}`;
    return {
      id: docId,
      path: fullPath,
      async get() {
        const data = store.get(fullPath);
        return {
          id: docId,
          exists: data !== undefined,
          data: () => (data ? { ...data } : undefined),
          ref: makeDocRef(colPath, docId),
        };
      },
      async set(patch: Record<string, any>, opts?: { merge?: boolean }) {
        const current = store.get(fullPath) || {};
        store.set(fullPath, applyPatch(current, patch, opts?.merge !== false));
      },
      async update(patch: Record<string, any>) {
        const current = store.get(fullPath);
        if (!current) throw new Error(`Doc ${fullPath} does not exist`);
        store.set(fullPath, applyPatch(current, patch, true));
      },
      collection(subCol: string) {
        return makeCollection(`${fullPath}/${subCol}`);
      },
    };
  };

  const makeCollection = (
    colPath: string,
    filters: Array<{ field: string; op: string; value: any }> = []
  ) => ({
    doc(docId?: string) {
      return makeDocRef(colPath, docId || `auto_${Math.random().toString(36).slice(2, 10)}`);
    },
    where(field: string, op: string, value: any) {
      return makeCollection(colPath, [...filters, { field, op, value }]);
    },
    limit() {
      return makeCollection(colPath, filters);
    },
    async get() {
      const prefix = `${colPath}/`;
      const docs: any[] = [];
      for (const [fullPath, data] of store.entries()) {
        if (!fullPath.startsWith(prefix)) continue;
        const remainder = fullPath.slice(prefix.length);
        if (remainder.includes("/")) continue;
        const matches = filters.every((f) => {
          if (f.op === "==") return data[f.field] === f.value;
          return true;
        });
        if (matches) {
          docs.push({
            id: remainder,
            exists: true,
            data: () => ({ ...data }),
            ref: makeDocRef(colPath, remainder),
          });
        }
      }
      return { docs, empty: docs.length === 0, size: docs.length };
    },
  });

  const db = {
    _store: store,
    collection(colPath: string) {
      return makeCollection(colPath);
    },
    async getAll(...refs: any[]) {
      return Promise.all(refs.map((r) => r.get()));
    },
    async runTransaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
      const tx = {
        get: (ref: any) => ref.get(),
        set: (ref: any, patch: any, opts?: any) => ref.set(patch, opts),
        update: (ref: any, patch: any) => ref.update(patch),
      };
      return fn(tx);
    },
  };

  return db;
}

function createMockMessaging() {
  const send = vi.fn().mockResolvedValue("projects/anytradercombined/messages/msg_1");
  return { send };
}

describe("AnyRoller Unified 3-Wave Hybrid Fairness & Matching Engine", () => {
  const NOW = 1_760_000_000_000;
  // Central London pickup & nearby dropoff
  const PICKUP = { lat: 51.5074, lng: -0.1278 };
  const DROPOFF = { lat: 51.5155, lng: -0.1419 };

  it("holds future pre-booked rides (>25m out) and releases imminent/instant rides", () => {
    expect(isRideReadyForInstantDispatch({}, NOW)).toBe(true);
    expect(
      isRideReadyForInstantDispatch({ scheduledTime: new Date(NOW + 10 * 60_000).toISOString() }, NOW)
    ).toBe(true);
    expect(
      isRideReadyForInstantDispatch({ scheduledTime: new Date(NOW + 45 * 60_000).toISOString() }, NOW)
    ).toBe(false);
    expect(
      isRideReadyForInstantDispatch({ scheduledFor: NOW + 60 * 60_000 }, NOW)
    ).toBe(false);
  });

  it("computes canonical 5-factor fairness score without 1970-epoch idle bug", () => {
    const idleUnassigned = computeDriverFairnessScore({
      distanceMiles: 1.0,
      metricsData: { dailyEarnings: 100 }, // no lastAssignmentAt
      userData: { driverRating: 4.9 },
      nowMs: NOW,
    });
    const idleTwoHours = computeDriverFairnessScore({
      distanceMiles: 1.0,
      metricsData: {
        dailyEarnings: 100,
        lastAssignmentAtMs: NOW - 120 * 60_000,
      },
      userData: { driverRating: 4.9 },
      nowMs: NOW,
    });
    const justAssigned = computeDriverFairnessScore({
      distanceMiles: 1.0,
      metricsData: {
        dailyEarnings: 100,
        lastAssignmentAtMs: NOW - 2 * 60_000,
      },
      userData: { driverRating: 4.9 },
      nowMs: NOW,
    });

    // Unassigned driver gets neutral 0.5 idleNorm (10 pts), NOT max 20 pts
    expect(idleUnassigned.breakdown.idleReward).toBe(10);
    expect(idleTwoHours.breakdown.idleReward).toBe(20);
    expect(justAssigned.breakdown.idleReward).toBeLessThan(1);
    expect(idleTwoHours.totalScore).toBeGreaterThan(idleUnassigned.totalScore);
    expect(idleUnassigned.totalScore).toBeGreaterThan(justAssigned.totalScore);

    // Lower daily earnings beats higher daily earnings at equal distance
    const lowEarner = computeDriverFairnessScore({
      distanceMiles: 2.0,
      metricsData: { dailyEarnings: 20, lastAssignmentAtMs: NOW - 30 * 60_000 },
      userData: { driverRating: 4.8 },
      nowMs: NOW,
    });
    const highEarner = computeDriverFairnessScore({
      distanceMiles: 2.0,
      metricsData: { dailyEarnings: 280, lastAssignmentAtMs: NOW - 30 * 60_000 },
      userData: { driverRating: 4.8 },
      nowMs: NOW,
    });
    expect(lowEarner.totalScore).toBeGreaterThan(highEarner.totalScore);

    // Destination mode heading toward home gets full 10-point route efficiency bonus
    const headingHome = computeDriverFairnessScore({
      distanceMiles: 1.5,
      trackingData: {
        destinationModeActive: true,
        homeLat: 51.525,
        homeLng: -0.155,
      },
      rideData: {
        pickupLat: PICKUP.lat,
        pickupLng: PICKUP.lng,
        dropoffLat: DROPOFF.lat,
        dropoffLng: DROPOFF.lng,
      },
      nowMs: NOW,
    });
    expect(headingHome.breakdown.routeEfficiency).toBe(10);
  });

  it("enforces maxDailyDriverHours, waitTolerance, working zone dropoff, electric category, and onBreak gates", () => {
    const baseTracking = {
      isOnline: true,
      status: "available",
      lat: 51.508,
      lng: -0.128,
      vehicleCategories: ["standard", "electric"],
      isPetFriendly: true,
      lastHeartbeatAtMs: NOW - 5_000,
    };
    const baseRide = {
      pickupLat: PICKUP.lat,
      pickupLng: PICKUP.lng,
      dropoffLat: DROPOFF.lat,
      dropoffLng: DROPOFF.lng,
      carCategory: "electric",
      isPetFriendly: true,
    };

    // Eligible electric + pet-friendly driver passes
    expect(
      evaluateDriverOfferCandidate({
        driverUid: "drv_1",
        trackingData: baseTracking,
        rideData: baseRide,
        radiusMiles: 15,
        nowMs: NOW,
      }).eligible
    ).toBe(true);

    // Max daily driving hours safety cap (12h)
    const fatigued = evaluateDriverOfferCandidate({
      driverUid: "drv_1",
      trackingData: baseTracking,
      rideData: baseRide,
      radiusMiles: 15,
      nowMs: NOW,
      metricsData: { onlineSecondsToday: 12 * 3600 + 60 },
      maxDailyDriverHours: 12,
    });
    expect(fatigued.eligible).toBe(false);
    expect(fatigued.reason).toBe("max_daily_hours");

    // Wait tolerance enforcement (5 min tolerance, driver ~5 miles away -> ~16.5 min ETA)
    const farDriver = { ...baseTracking, lat: 51.58, lng: -0.1278 };
    const tooSlow = evaluateDriverOfferCandidate({
      driverUid: "drv_1",
      trackingData: farDriver,
      rideData: { ...baseRide, waitTolerance: 5 },
      radiusMiles: 15,
      nowMs: NOW,
    });
    expect(tooSlow.eligible).toBe(false);
    expect(tooSlow.reason).toBe("exceeds_wait_tolerance");

    // Wait tolerance relaxed in Wave 2/3
    const relaxed = evaluateDriverOfferCandidate({
      driverUid: "drv_1",
      trackingData: farDriver,
      rideData: { ...baseRide, waitTolerance: 5 },
      radiusMiles: 15,
      nowMs: NOW,
      ignoreWaitTolerance: true,
    });
    expect(relaxed.eligible).toBe(true);

    // Working zone rejects when pickup is inside zone but dropoff is outside zone
    const outOfZoneDropoff = evaluateDriverOfferCandidate({
      driverUid: "drv_1",
      trackingData: {
        ...baseTracking,
        zoneEnabled: true,
        zoneCenterLat: PICKUP.lat,
        zoneCenterLng: PICKUP.lng,
        zoneMaxDistance: 3,
      },
      rideData: {
        ...baseRide,
        dropoffLat: 51.62, // ~7.8 mi north
        dropoffLng: -0.1278,
      },
      radiusMiles: 15,
      nowMs: NOW,
    });
    expect(outOfZoneDropoff.eligible).toBe(false);
    expect(outOfZoneDropoff.reason).toBe("outside_driver_zone");

    // Coffee Cup Break rejected
    const onBreakRes = evaluateDriverOfferCandidate({
      driverUid: "drv_1",
      trackingData: { ...baseTracking, onBreak: true, status: "busy" },
      rideData: baseRide,
      radiusMiles: 15,
      nowMs: NOW,
    });
    expect(onBreakRes.eligible).toBe(false);
    expect(onBreakRes.reason).toBe("on_break");
  });

  it("executes 3-Wave Hybrid Dispatch: Wave 1 Exclusive -> Decline -> Wave 2 Exclusive -> Wave 3 Broadcast Fallback", async () => {
    const db = createInMemoryFirestore({
      "ride_requests/ride_wave": {
        passengerId: "pass_1",
        status: "pending",
        pickupLat: PICKUP.lat,
        pickupLng: PICKUP.lng,
        dropoffLat: DROPOFF.lat,
        dropoffLng: DROPOFF.lng,
        pickupAddress: "10 Downing St",
        dropoffAddress: "Oxford Circus",
        carCategory: "electric",
        fareEstimate: 18.5,
        isPriority: true,
        isPetFriendly: true,
        stops: [{ address: "Piccadilly" }],
        passengerRating: 4.95,
        paymentMethod: "card",
        dispatchAttempts: 0,
      },
      // Driver 1: Approved, low earnings, long idle -> #1 Fairness Winner
      "users/drv_1": { role: "driver", driverApproved: true, driverRating: 4.95, fcmToken: "tok_1" },
      "live_tracking/drv_1": {
        isOnline: true,
        status: "available",
        lat: 51.509,
        lng: -0.128,
        vehicleCategories: ["standard", "electric"],
        isPetFriendly: true,
        lastHeartbeatAtMs: NOW - 5_000,
      },
      "driver_metrics/drv_1": { dailyEarnings: 15, lastAssignmentAtMs: NOW - 90 * 60_000 },

      // Driver 2: Approved, higher earnings -> #2 Fairness Winner
      "users/drv_2": { role: "driver", driverApproved: true, driverRating: 4.85, fcmToken: "tok_2" },
      "live_tracking/drv_2": {
        isOnline: true,
        status: "available",
        lat: 51.512,
        lng: -0.130,
        vehicleCategories: ["electric"],
        isPetFriendly: true,
        lastHeartbeatAtMs: NOW - 5_000,
      },
      "driver_metrics/drv_2": { dailyEarnings: 220, lastAssignmentAtMs: NOW - 15 * 60_000 },

      // Driver 3: Approved, further away & high earnings today (Wave 3 broadcast fallback)
      "users/drv_3": { role: "driver", driverApproved: true, driverRating: 4.9, fcmToken: "tok_3" },
      "live_tracking/drv_3": {
        isOnline: true,
        status: "available",
        lat: 51.535,
        lng: -0.140,
        vehicleCategories: ["electric"],
        isPetFriendly: true,
        lastHeartbeatAtMs: NOW - 5_000,
      },
      "driver_metrics/drv_3": { dailyEarnings: 350, lastAssignmentAtMs: NOW - 5 * 60_000 },

      // Driver 4: Unapproved (MUST be skipped)
      "users/drv_unapproved": { role: "driver", driverApproved: false, fcmToken: "tok_4" },
      "live_tracking/drv_unapproved": {
        isOnline: true,
        status: "available",
        lat: PICKUP.lat,
        lng: PICKUP.lng,
        vehicleCategories: ["electric"],
        isPetFriendly: true,
        lastHeartbeatAtMs: NOW - 2_000,
      },

      // Driver 5: Already holding a different exclusive offer (MUST be skipped in Wave 1/2)
      "users/drv_busy_offer": { role: "driver", driverApproved: true, fcmToken: "tok_5" },
      "live_tracking/drv_busy_offer": {
        isOnline: true,
        status: "available",
        lat: PICKUP.lat,
        lng: PICKUP.lng,
        vehicleCategories: ["electric"],
        isPetFriendly: true,
        lastHeartbeatAtMs: NOW - 2_000,
      },
      "driver_status/drv_busy_offer": { pendingRideId: "some_other_ride" },
    });

    const messaging = createMockMessaging();

    // WAVE 1: Exclusive fairness offer to drv_1
    const wave1 = await runFairnessDispatchForRide({
      db,
      rideId: "ride_wave",
      messagingClient: messaging,
      nowMs: NOW,
    });
    expect(wave1.mode).toBe("fairness_exclusive");
    expect(wave1.assignedDriverId).toBe("drv_1");
    expect(wave1.dispatchedCount).toBe(1);

    const rideAfterW1 = db._store.get("ride_requests/ride_wave")!;
    expect(rideAfterW1.status).toBe("offered");
    expect(rideAfterW1.assignedDriverId).toBe("drv_1");
    expect(rideAfterW1.dispatchWave).toBe(1);
    expect(rideAfterW1.dispatchAttempts).toBe(1);
    expect(db._store.get("driver_status/drv_1")?.pendingRideId).toBe("ride_wave");

    // Verify enriched FCM payload fields for Android Driver App
    const w1PushCall = messaging.send.mock.calls[0][0];
    expect(w1PushCall.android.notification.channelId).toBe(RIDE_OFFER_CHANNEL_ID);
    expect(w1PushCall.data.isPriority).toBe("true");
    expect(w1PushCall.data.isPetFriendly).toBe("true");
    expect(w1PushCall.data.stopCount).toBe("1");
    expect(w1PushCall.data.passengerRating).toBe("4.95");
    expect(w1PushCall.data.paymentMethod).toBe("card");
    expect(w1PushCall.data.vehicleCategory).toBe("electric");

    // Driver 1 declines -> ride returns to pending + declinedOffersCount incremented
    const decline1 = await executeDeclineRideOfferCommand({
      db,
      caller: { uid: "drv_1" },
      rideId: "ride_wave",
    });
    expect(decline1.status).toBe("pending");
    expect(db._store.get("driver_metrics/drv_1")?.declinedOffersCount).toBe(1);
    expect(db._store.get("driver_status/drv_1")?.pendingRideId).toBeUndefined();

    // WAVE 2: Exclusive fairness offer rolls over to drv_2 (skips drv_1)
    const wave2 = await runFairnessDispatchForRide({
      db,
      rideId: "ride_wave",
      messagingClient: messaging,
      nowMs: NOW + 3_000,
    });
    expect(wave2.mode).toBe("fairness_exclusive");
    expect(wave2.assignedDriverId).toBe("drv_2");
    expect(db._store.get("ride_requests/ride_wave")?.dispatchWave).toBe(2);
    expect(db._store.get("ride_requests/ride_wave")?.dispatchAttempts).toBe(2);

    // Driver 2 declines
    await executeDeclineRideOfferCommand({
      db,
      caller: { uid: "drv_2" },
      rideId: "ride_wave",
    });

    // WAVE 3 (dispatchAttempts === 2): Broadcast Fallback keeps status pending and alerts remaining eligible drivers
    const wave3 = await runFairnessDispatchForRide({
      db,
      rideId: "ride_wave",
      messagingClient: messaging,
      nowMs: NOW + 6_000,
      force: true,
    });
    expect(wave3.mode).toBe("broadcast_fallback");
    expect(wave3.matchedDrivers).toBe(2); // drv_3 + drv_busy_offer (broadcast doesn't block pendingRideId)
    expect(db._store.get("ride_requests/ride_wave")?.status).toBe("pending");
    expect(db._store.get("ride_requests/ride_wave")?.dispatchMode).toBe("broadcast_fallback");
  });

  it("runFairnessDispatchCycle reclaims expired offers, records telemetry, and dispatches Priority rides before older standard rides", async () => {
    const db = createInMemoryFirestore({
      // Expired offered ride from drv_1
      "ride_requests/ride_expired": {
        passengerId: "pass_exp",
        status: "offered",
        assignedDriverId: "drv_1",
        offerExpiresAtMs: NOW - 5_000,
        pickupLat: PICKUP.lat,
        pickupLng: PICKUP.lng,
        dropoffLat: DROPOFF.lat,
        dropoffLng: DROPOFF.lng,
        carCategory: "standard",
        dispatchAttempts: 1,
        createdAt: NOW - 60_000,
      },
      // Older standard pending ride
      "ride_requests/ride_standard": {
        passengerId: "pass_std",
        status: "pending",
        isPriority: false,
        pickupLat: PICKUP.lat,
        pickupLng: PICKUP.lng,
        dropoffLat: DROPOFF.lat,
        dropoffLng: DROPOFF.lng,
        carCategory: "standard",
        dispatchAttempts: 0,
        createdAt: NOW - 120_000,
      },
      // Newer Priority Boost pending ride (MUST claim the only free driver first!)
      "ride_requests/ride_priority": {
        passengerId: "pass_prio",
        status: "pending",
        isPriority: true,
        pickupLat: PICKUP.lat,
        pickupLng: PICKUP.lng,
        dropoffLat: DROPOFF.lat,
        dropoffLng: DROPOFF.lng,
        carCategory: "standard",
        dispatchAttempts: 0,
        createdAt: NOW - 10_000,
      },
      "users/drv_1": { role: "driver", driverApproved: true, fcmToken: "t1" },
      "live_tracking/drv_1": {
        isOnline: true,
        status: "available",
        lat: PICKUP.lat,
        lng: PICKUP.lng,
        vehicleCategories: ["standard"],
        lastHeartbeatAtMs: NOW - 2_000,
      },
      "driver_status/drv_1": { pendingRideId: "ride_expired" },
    });

    const messaging = createMockMessaging();
    const cycleRes = await runFairnessDispatchCycle({
      db,
      messagingClient: messaging,
      nowMs: NOW,
    });

    expect(cycleRes.expiredReclaimed).toBe(1);
    expect(cycleRes.processedPending).toBe(3);
    expect(cycleRes.dispatchedExclusive).toBe(1);

    // drv_1 timed out on ride_expired -> recorded in declinedBy & driver_metrics
    expect(db._store.get("ride_requests/ride_expired")?.declinedBy).toContain("drv_1");
    expect(db._store.get("driver_metrics/drv_1")?.declinedOffersCount).toBe(1);

    // Because drv_1 is the only available driver and ride_priority has isPriority: true,
    // ride_priority wins drv_1 ahead of older ride_standard!
    expect(db._store.get("ride_requests/ride_priority")?.status).toBe("offered");
    expect(db._store.get("ride_requests/ride_priority")?.assignedDriverId).toBe("drv_1");
    expect(db._store.get("ride_requests/ride_standard")?.status).toBe("pending");
  });

  it("executeAcceptRideCommand stamps real driver_metrics lastAssignmentAt & acceptedOffersCount for fairness idle scoring", async () => {
    const db = createInMemoryFirestore({
      "users/drv_accept": {
        role: "driver",
        driverApproved: true,
        name: "Alex Driver",
        vehiclePlate: "EV26 ANY",
        driverRating: 4.92,
      },
      "ride_requests/ride_acc": {
        passengerId: "pass_acc",
        status: "offered",
        assignedDriverId: "drv_accept",
        offerExpiresAtMs: NOW + 15_000,
        pickupLat: PICKUP.lat,
        pickupLng: PICKUP.lng,
        dropoffLat: DROPOFF.lat,
        dropoffLng: DROPOFF.lng,
      },
      "driver_metrics/drv_accept": {
        dailyEarnings: 40,
        acceptedOffersCount: 4,
      },
    });

    await executeAcceptRideCommand({
      db,
      caller: { uid: "drv_accept" },
      body: { rideId: "ride_acc" },
    });

    const metrics = db._store.get("driver_metrics/drv_accept");
    expect(metrics?.acceptedOffersCount).toBe(5);
    expect(typeof metrics?.lastAssignmentAt).toBe("string");
    expect(typeof metrics?.lastAssignmentAtMs).toBe("number");
    expect(metrics!.lastAssignmentAtMs).toBeGreaterThan(1_700_000_000_000);
  });
});
