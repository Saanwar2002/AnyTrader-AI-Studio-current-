import { describe, it, expect } from "vitest";
import {
  MAX_PASSENGER_TIP_GBP,
  sanitizeTipAmount,
  loadRidesFareConfig,
  computeAuthoritativeRideFare,
  computeRouteHaversineFloorMiles,
} from "../../src/server/rideFareCalculator.ts";
import {
  executeCreateRideBookingCommand,
  executeAddRideTipCommand,
  executePassengerUpdateRideCommand,
} from "../../src/server/rideOfferDispatch.ts";
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
  let autoIdSeq = 1;

  const makeSnap = (docId: string, data: any) => ({
    id: docId,
    exists: data !== undefined && data !== null,
    data: () => (data ? JSON.parse(JSON.stringify(data)) : undefined),
  });

  return {
    _store: store,
    collection(colName: string) {
      return {
        doc(docId?: string) {
          const resolvedId = docId || `auto_${colName}_${autoIdSeq++}`;
          const fullPath = `${colName}/${resolvedId}`;
          return {
            id: resolvedId,
            path: fullPath,
            async get() {
              return makeSnap(resolvedId, store[fullPath]);
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
          store[w.path] =
            w.merge && store[w.path] ? mergeDocPatch(store[w.path], w.data) : mergeDocPatch({}, w.data);
        }
      }
      return result;
    },
  };
}

describe("AnyRoller Pricing Parity, £50 Tip Cap & Live Passenger Sync", () => {
  describe("1. £50.00 Maximum Passenger Card Tip Cap", () => {
    it("enforces hard £50.00 ceiling in sanitizeTipAmount and computeAuthoritativeRideFare", () => {
      expect(MAX_PASSENGER_TIP_GBP).toBe(50);
      expect(sanitizeTipAmount(25)).toBe(25);
      expect(sanitizeTipAmount(50)).toBe(50);
      expect(sanitizeTipAmount(50.01)).toBe(50);
      expect(sanitizeTipAmount(250)).toBe(50);
      expect(sanitizeTipAmount(-10)).toBe(0);
      // Respects lower admin cap when configured
      expect(sanitizeTipAmount(40, 25)).toBe(25);
      // Never allows admin cap above £50
      expect(sanitizeTipAmount(75, 100)).toBe(50);

      const settlement = computeAuthoritativeRideFare({
        rideData: {
          fareEstimate: 20,
          distanceMiles: 5,
          durationMinutes: 12,
          carCategory: "standard",
          tipAmount: 99,
        },
      });
      expect(settlement.tipGbp).toBe(50);
      expect(settlement.totalCollectedGbp).toBe(70);
      // Platform commission is strictly 12% of £20 fare (£2.40), 0% on the £50 tip
      expect(settlement.platformFeeGbp).toBe(2.4);
      expect(settlement.driverEarningsGbp).toBe(67.6);
    });

    it("clamps platform_config/rides maxTipGbp to <= £50 and loads allowMidJourneyEdits", async () => {
      const db = createInMemoryFirestore({
        "platform_config/rides": {
          baseFare: 4.0,
          distanceRate: 1.5,
          timeRate: 0.2,
          petFee: 4.5,
          priorityFee: 3.5,
          maxTipGbp: 120, // tampered/too high -> must clamp to 50
          allowMidJourneyEdits: false,
        },
      });

      const cfg = await loadRidesFareConfig(db);
      expect(cfg.maxTipGbp).toBe(50);
      expect(cfg.petFee).toBe(4.5);
      expect(cfg.priorityFee).toBe(3.5);
      expect(cfg.allowMidJourneyEdits).toBe(false);
    });

    it("rejects tips over £50.00 (or lower admin cap) and rejects tips after checkout starts", async () => {
      const db = createInMemoryFirestore({
        "platform_config/rides": { maxTipGbp: 50 },
        "ride_requests/ride_1": {
          riderId: "passenger_1",
          passengerId: "passenger_1",
          driverId: "driver_1",
          assignedDriverId: "driver_1",
          status: "in_progress",
          fareEstimate: 18.5,
          tipAmount: 0,
        },
        "ride_requests/ride_checkout": {
          riderId: "passenger_1",
          passengerId: "passenger_1",
          driverId: "driver_1",
          status: "awaiting_payment",
          fareEstimate: 18.5,
        },
      });

      await expect(
        executeAddRideTipCommand({
          db,
          caller: { uid: "passenger_1" },
          rideId: "ride_1",
          tipAmount: 50.01,
        })
      ).rejects.toThrow(BadRequestError);

      await expect(
        executeAddRideTipCommand({
          db,
          caller: { uid: "passenger_other" },
          rideId: "ride_1",
          tipAmount: 5,
        })
      ).rejects.toThrow(ForbiddenError);

      await expect(
        executeAddRideTipCommand({
          db,
          caller: { uid: "passenger_1" },
          rideId: "ride_checkout",
          tipAmount: 5,
        })
      ).rejects.toThrow(ConflictError);

      const ok = await executeAddRideTipCommand({
        db,
        caller: { uid: "passenger_1" },
        rideId: "ride_1",
        tipAmount: 50,
      });
      expect(ok.success).toBe(true);
      expect(ok.tipAmount).toBe(50);
      expect(ok.maxTipGbp).toBe(50);
      expect(ok.assignedDriverId).toBe("driver_1");
      expect(db._store["ride_requests/ride_1"].tipAmount).toBe(50);
    });
  });

  describe("2. Server-Authoritative Ride Booking Creation", () => {
    it("computes fare with Electric multiplier + Pet & Priority flat add-ons and enforces Haversine road floor", async () => {
      const db = createInMemoryFirestore({
        "users/passenger_1": { firstName: "Sam", phone: "07700900123", pendingCharges: 0 },
        "platform_config/rides": {
          baseFare: 3.5,
          distanceRate: 1.3,
          timeRate: 0.15,
          minFare: 5.0,
          priorityFee: 3.0,
          petFee: 3.0,
          vehicleMultipliers: { standard: 1.0, electric: 1.15, executive: 1.5 },
        },
      });

      // Huddersfield (53.6458, -1.7850) -> Leeds (53.7997, -1.5492) ~14.4 straight-line miles
      // Attacker submits tampered tiny distanceMiles: 0.5
      const res = await executeCreateRideBookingCommand({
        db,
        caller: { uid: "passenger_1" },
        body: {
          pickup: "Huddersfield Station",
          pickupLat: 53.6458,
          pickupLng: -1.785,
          dropoff: "Leeds Station",
          dropoffLat: 53.7997,
          dropoffLng: -1.5492,
          distanceMiles: 0.5, // tampered!
          durationMinutes: 2,
          carCategory: "electric",
          isPriority: true,
          isPetFriendly: true,
          hasCardOnFile: true,
        },
      });

      const floorMiles = computeRouteHaversineFloorMiles(
        [
          { lat: 53.6458, lng: -1.785 },
          { lat: 53.7997, lng: -1.5492 },
        ],
        1.12
      );
      expect(res.success).toBe(true);
      expect(res.carCategory).toBe("electric");
      expect(res.distanceMiles).toBeGreaterThanOrEqual(floorMiles - 0.1);
      expect(res.fareEstimate).toBeGreaterThan(25);

      const saved = db._store[`ride_requests/${res.rideId}`];
      expect(saved.journeyRevision).toBe(0);
      expect(saved.priorityFee).toBe(3.0);
      expect(saved.petFee).toBe(3.0);
      expect(saved.isPetFriendly).toBe(true);
      expect(saved.isPriority).toBe(true);
      expect(saved.routePricingMode).toBe("point_to_point");
    });

    it("blocks booking creation when passenger has unpaid pendingCharges", async () => {
      const db = createInMemoryFirestore({
        "users/passenger_debt": { firstName: "Alex", pendingCharges: 12.5 },
      });

      await expect(
        executeCreateRideBookingCommand({
          db,
          caller: { uid: "passenger_debt" },
          body: {
            pickup: "A",
            pickupLat: 53.6458,
            pickupLng: -1.785,
            dropoff: "B",
            dropoffLat: 53.7,
            dropoffLng: -1.7,
          },
        })
      ).rejects.toThrow(ConflictError);
    });
  });

  describe("3. Real-Time Mid-Journey Edits & Actual-Driven + Remaining Distance Floor", () => {
    it("reads live driver GPS, preserves miles already driven, stamps journeyRevision & fareDeltaGbp", async () => {
      // Pickup at (53.6458, -1.7850). Driver has already driven ~14 miles to Leeds (53.7997, -1.5492).
      // Passenger edits dropoff mid-journey to near pickup (53.6500, -1.7800) with tiny client distance 1.0 mi.
      // Server MUST charge alreadyDriven (~16mi) + remaining (~16mi) instead of collapsing to 0.4mi!
      const db = createInMemoryFirestore({
        "platform_config/rides": {
          baseFare: 3.5,
          distanceRate: 1.3,
          timeRate: 0.15,
          minFare: 5.0,
          priorityFee: 3.0,
          petFee: 3.0,
          allowMidJourneyEdits: true,
        },
        "live_tracking/driver_1": {
          lat: 53.7997,
          lng: -1.5492,
          isOnline: true,
        },
        "ride_requests/ride_active": {
          riderId: "passenger_1",
          passengerId: "passenger_1",
          driverId: "driver_1",
          assignedDriverId: "driver_1",
          status: "in_progress",
          pickup: "Huddersfield Station",
          pickupLat: 53.6458,
          pickupLng: -1.785,
          dropoff: "Leeds Station",
          dropoffLat: 53.7997,
          dropoffLng: -1.5492,
          stops: [],
          distanceMiles: 16.0,
          durationMinutes: 30,
          fareEstimate: 28.8,
          carCategory: "standard",
          isPriority: false,
          isPetFriendly: true,
          journeyRevision: 0,
        },
      });

      const res = await executePassengerUpdateRideCommand({
        db,
        caller: { uid: "passenger_1" },
        rideId: "ride_active",
        body: {
          dropoff: "Back to Huddersfield Town Centre",
          dropoffLat: 53.65,
          dropoffLng: -1.78,
          stops: [{ address: "Wakefield Stop", coords: { lat: 53.6833, lng: -1.5059 } }],
          distanceMiles: 1.0, // naive or tampered point-to-point distance
          durationMinutes: 5,
        },
      });

      expect(res.success).toBe(true);
      expect(res.isActiveRideEdit).toBe(true);
      expect(res.assignedDriverId).toBe("driver_1");
      expect(res.journeyRevision).toBe(1);
      // Actual driven + remaining must be ~30+ miles, NEVER collapsed to 1 mile!
      expect(res.distanceMiles).toBeGreaterThan(25);
      expect(res.fareEstimate).toBeGreaterThan(res.previousFareEstimate);
      expect(res.fareDeltaGbp).toBeGreaterThan(0);
      expect(res.editSummary).toContain("Dropoff changed");
      expect(res.editSummary).toContain("Stop added");

      const updatedRide = db._store["ride_requests/ride_active"];
      expect(updatedRide.routePricingMode).toBe("mid_journey_actual_plus_remaining");
      expect(updatedRide.journeyRevision).toBe(1);
      expect(updatedRide.lastPassengerEditSummary).toBe(res.editSummary);
      expect(updatedRide.dropoffLat).toBe(53.65);

      // Driver live_tracking dropoff coords also kept in sync atomically
      expect(db._store["live_tracking/driver_1"].dropoffLat).toBe(53.65);
      expect(db._store["live_tracking/driver_1"].dropoffLng).toBe(-1.78);
    });

    it("blocks mid-journey edits when admin disables allowMidJourneyEdits", async () => {
      const db = createInMemoryFirestore({
        "platform_config/rides": {
          allowMidJourneyEdits: false,
        },
        "ride_requests/ride_locked": {
          riderId: "passenger_1",
          passengerId: "passenger_1",
          driverId: "driver_1",
          status: "in_progress",
          pickup: "A",
          pickupLat: 53.6458,
          pickupLng: -1.785,
          dropoff: "B",
          dropoffLat: 53.7997,
          dropoffLng: -1.5492,
          fareEstimate: 20,
        },
      });

      await expect(
        executePassengerUpdateRideCommand({
          db,
          caller: { uid: "passenger_1" },
          rideId: "ride_locked",
          body: {
            dropoff: "New Destination",
            dropoffLat: 53.8,
            dropoffLng: -1.6,
          },
        })
      ).rejects.toThrow(ForbiddenError);
    });
  });
});
